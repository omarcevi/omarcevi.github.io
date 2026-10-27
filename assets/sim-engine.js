// Inference simulator engine: a token-level model of LLM serving engines on
// one or more H100s, each optionally split into MIG slices. It is a model, not a benchmark:
// step times come from a simple roofline (compute-bound vs memory-bound) and
// are meant to show the shape of the trade-offs, not predict real throughput.
// Tab 04's large model can also be an API model, with a fixed latency and a per-token price (API).
// Pinned numbers: NVIDIA H100 SXM datasheet (989 TFLOPS dense BF16, 3.35 TB/s,
// 80 GB) and the Llama 3 8B config (8.03e9 params, 32 layers, 8 KV heads,
// head dim 128, so 131072 bytes of BF16 KV per token); the Llama 3.2 3B and 1B
// numbers are cited at MODELS. GB means 1e9 bytes.
// No DOM access: it runs in Node for tests and as window.SimEngine in the page.
(function (root) {
  'use strict';

  // MIG profiles: share of compute (of 7 slices), of memory bandwidth (of 8), and memory in GB
  var PROFILES = {
    '7g.80gb': { compute: 7 / 7, bw: 8 / 8, memGB: 80 },
    '4g.40gb': { compute: 4 / 7, bw: 4 / 8, memGB: 40 },
    '3g.40gb': { compute: 3 / 7, bw: 4 / 8, memGB: 40 },
    '2g.20gb': { compute: 2 / 7, bw: 2 / 8, memGB: 20 },
    '1g.20gb': { compute: 1 / 7, bw: 2 / 8, memGB: 20 },
    '1g.10gb': { compute: 1 / 7, bw: 1 / 8, memGB: 10 }
  };

  // contextLen: the model's context window (Llama 3: 8192 tokens). short labels a small box.
  // KV per token is layers x KV heads x head dim x 2 (K and V) x 2 bytes (BF16). The Llama 3.2 numbers
  // come from the Hugging Face configs and BF16 safetensors, https://huggingface.co/meta-llama/Llama-3.2-3B
  // and https://huggingface.co/meta-llama/Llama-3.2-1B (config.json; checked 2026-10-26 on the ungated
  // unsloth/Llama-3.2-3B and unsloth/Llama-3.2-1B copies, since the meta-llama repos are gated):
  //   3B: 28 layers, 8 KV heads, head dim 128 -> 114688 bytes; 6,425,499,648 bytes of weights (3.21e9 params)
  //   1B: 16 layers, 8 KV heads, head dim 64 -> 32768 bytes; 2,471,645,608 bytes of weights (1.24e9 params)
  //   both: max_position_embeddings 131072, tied embeddings
  var MODELS = {
    'llama-3-8b': { label: 'Llama 3 8B', short: '8B', params: 8.03e9, weightsGB: 16.06, kvBytesPerToken: 131072, contextLen: 8192 },
    'llama-3.2-3b': { label: 'Llama 3.2 3B', short: '3B', params: 3.21e9, weightsGB: 6.43, kvBytesPerToken: 114688, contextLen: 131072 },
    'llama-3.2-1b': { label: 'Llama 3.2 1B', short: '1B', params: 1.24e9, weightsGB: 2.47, kvBytesPerToken: 32768, contextLen: 131072 },
    // Tab 04's router: a 1B-class classifier, modelled with Llama 3.2 1B's numbers. It prefills the prompt
    // and outputs one token, the score.
    system1: { label: 'System1 model', short: 'S1', params: 1.24e9, weightsGB: 2.47, kvBytesPerToken: 32768, contextLen: 131072 },
    // Tab 04's large model behind an API: nothing runs here, so it has no weights or KV, only API's latency and price
    api: { label: 'API model', short: 'API' }
  };

  var GPU = { tflops: 989, tbps: 3.35, mfu: 0.5, mbu: 0.8, stepOverheadMs: 1.5 };

  // Share of GPU time lost when time-sliced contexts alternate: the context switches themselves plus
  // the cache and TLB thrash after each one. An assumption chosen for the lesson, not a measurement.
  var CTX_SWITCH_LOSS = 0.3;

  var DEFAULTS = {
    gpuMemUtil: 0.9,
    activationReserveGB: 1,
    maxNumSeqs: 256,
    maxNumBatchedTokens: 8192,
    maxTokens: 1024,
    maxBatch: 16,
    maxQueueDelayMs: 25,
    queueCap: 128
  };

  // Lognormal stand-ins for the Azure LLM conversation trace (Patel et al., Splitwise,
  // ISCA 2024: median prompt 1020 tokens, median output 129). Tabs 01 and 04 are calibrated on these;
  // tab 05's random mode uses TRACE_FIT, fitted to the replayed trace itself.
  var LENGTHS = {
    prompt: { median: 1020, sigma: 0.8, min: 16, max: 7000 },
    output: { median: 129, sigma: 0.93, min: 1, max: 1000 }
  };

  // Synthetic lengths for tab 02: long prompts and long replies, so the KV pool fills. Each request holds
  // about 6k tokens of KV, so the 0.9 pool (~145k tokens) runs about 20-25 at once, few enough that the
  // desktop canvas (27 rows) draws them all and the preempted one flashes; the 0.5 pool (~22k) runs 3 or 4.
  var LONG = {
    prompt: { median: 5500, sigma: 0.1, min: 256, max: 6000 },
    output: { median: 400, sigma: 0.2, min: 64, max: 1000 }
  };

  // Synthetic lengths for tab 03's small models: short tasks for the 3B, tiny ones for the 1B
  var SHORT = {
    prompt: { median: 300, sigma: 0.6, min: 16, max: 2000 },
    output: { median: 60, sigma: 0.6, min: 4, max: 400 }
  };
  var TINY = {
    prompt: { median: 250, sigma: 0.5, min: 8, max: 1000 },
    output: { median: 16, sigma: 0.5, min: 1, max: 120 }
  };

  // Tab 03: three models with their own traffic and TTFT p99 SLOs, on one of three deployments.
  // The 8B is chat-like (steady, with small bursts); the 3B and 1B serve short tasks at a high rate.
  // Time-slicing loses because CTX_SWITCH_LOSS leaves each of three busy processes 0.7 / 3 of the GPU,
  // less than a 2g.20gb slice gets, and well under the 8B's 3g.40gb. The 8B's rate (2.5) is set where that
  // gap shows: tests/sim.test.mjs checks the boxes as a visitor sees them (the page's 40 s warm-up, then a
  // refresh every 300 ms on a 30 s p99). On seeds 1-20, time-slicing's 8B is red on a median 98% of the
  // refreshes in the 30 s after a switch, and no MIG or GPU-per-model box turns red in 2 min. On seeds
  // 1-200, no MIG box is red in the first 30 s, and MIG's 8B is red 0.83% of the time over 2 min, while
  // time-slicing's 8B is red on at least 70% of refreshes on 79% of loads. At rate 1.5 it was red on a
  // median 70%; at rate 3 its p99 runs away (median 9 s after 2 min). A manual burst of 24 still turns
  // MIG's 8B red for a while, since a 3g slice has less headroom than a whole GPU.
  // TTFT p99 targets per model: tab 03's, and the sandbox's
  var SLOS = { 'llama-3-8b': 2000, 'llama-3.2-3b': 500, 'llama-3.2-1b': 300 };

  function tab03(instances) {
    return {
      instances: instances,
      batching: 'continuous',
      slo: SLOS,
      streams: [
        { model: 'llama-3-8b', rate: 2.5, bursts: { min: 6, max: 10 }, lengths: LENGTHS },
        { model: 'llama-3.2-3b', rate: 8, bursts: false, lengths: SHORT },
        { model: 'llama-3.2-1b', rate: 25, bursts: false, lengths: TINY }
      ]
    };
  }

  // Tab 04: one H100 split 3g.40gb + 2g.20gb + 1g.10gb, one 1g slice left free. Every request goes first to the
  // System1 model on 1g, which scores it; a score at or above the threshold goes on to the large model (the 8B
  // on 3g, or the API model), the rest to the 1B on 2g. A difficulty of u^2 (DIFFICULTY_POWER) puts
  // 1 - sqrt(0.55), about 26%, at or above the 0.55 hard cut, and the 0.45 default threshold sits one noise sigma
  // (0.1) below it. 10 req/s, plus bursts of 4-6 every 8-12 s, is more than the 8B alone serves on its slice
  // (5.6-6.2 req/s, seeds 1-3).
  // The figures below are measured values on the seeds stated, as a visitor sees them (the page's 40 s warm-up,
  // then a refresh every 300 ms on a 30 s p99); tests/sim.test.mjs asserts looser bounds on seeds 1-10.
  // A load deployed at a threshold (opening the tab deploys at the default; a load at any other threshold only
  // comes from a mode switch with the slider already moved), seeds 1-10:
  // - at the default, 65-70% go small, every box is green on every refresh in both modes, and a median 1.3% of
  //   hard requests are misrouted (on seeds 1-400, 14 loads, 3.5%, show a red box, mostly the 1B's, when a burst
  //   of long prompts queues at the System1 model; 25 loads with 9 req/s and bursts of 6-10);
  // - at 0 on-prem, the 8B box is red on every refresh of the first 30 s, and 503s come within 2 min on every load;
  // - about 80% of hard requests are misrouted at 0.9, and all at 1;
  // - on-prem cost per 1M is $0.95 at 0 and $0.58 at the default (median at 60 s); in API mode, API $/h is about
  //   $177, $60 and $10 at 0, the default and 0.9.
  // The slider moved live from the default to 0 at the open, on-prem: the 8B box turns red 2.6-14 s later on
  // seeds 1-10, and within 20 s on 58 of seeds 1-60 (28 s at most). It's red on a median 80% of the next 30 s on
  // seeds 1-10 and 71% on seeds 1-60, with a low of 6%. The first 503 comes 25-52 s after the move on seeds 1-60
  // (within 30 s on only 5).
  function tab04(large) {
    return {
      instances: [
        { profile: '1g.10gb', model: 'system1', gpu: 0 },
        { profile: '2g.20gb', model: 'llama-3.2-1b', gpu: 0 },
        large
      ],
      batching: 'continuous',
      slo: { 'llama-3-8b': 2000, api: 2000, 'llama-3.2-1b': 1000 },
      streams: [{ model: 'system1', rate: 10, bursts: { min: 4, max: 6 }, lengths: LENGTHS }],
      routing: { small: 'llama-3.2-1b', large: large.model, threshold: 0.45, hardCut: 0.55, noise: 0.1 }
    };
  }

  // Tab 05 replays assets/sim/azure-conv.json (scripts/azure_trace.py): every 4th request of an hour of
  // Azure's conversation trace, 12x faster, about 16.6 requests/s on one H100. TRACE_RATE and TRACE_FIT
  // are copied from its rate and fit, so the random mode carries the same load: Poisson arrivals at the
  // replay's average rate, with lognormal lengths that have the trace's medians and means.
  var TRACE_RATE = 16.59;
  var TRACE_FIT = {
    prompt: { median: 1019, sigma: 0.484, min: 2, max: 7096 },
    output: { median: 130, sigma: 0.985, min: 11, max: 1000 }
  };
  // Where in the hour tab 05's replay starts (hour ms); the page's 40 s warm-up then plays 8 min of it, so
  // the tab opens at minute 24, as the rate climbs to the hour's peak. Measured as a visitor sees it (a
  // refresh every 300 ms on a 30 s p99; the trace plays the same on every load): p99 is 1.05 s at the open,
  // red from 17.3 s to 77.6 s after it (51% of the first 2 min) with 55 503s, then green through minute 4.
  // Starting at minute 13 the first red comes at 32 s; at minute 17, 12.5 s. Random traffic at the same
  // load stays green with no 503s (seeds 1-10). tests/sim.test.mjs checks both.
  var TRACE_START_MS = 960000;
  var TAB05 = { instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], batching: 'continuous', slo: { 'llama-3-8b': 2000 } };

  // Tab 05 on the trace: the preset needs the trace's data, which the page loads
  function tracePreset(data) {
    return Object.assign({}, TAB05, { streams: [{ model: 'llama-3-8b', trace: data, startMs: TRACE_START_MS }] });
  }

  // Tab 06: two replicas of the 8B, each on its own H100, behind the router. Killing one sends its requests back
  // through the router as client retries; with the autoscaler on, a replacement H100 starts in its place and
  // serves after COLD_START_MS. The cold start is an assumption, not a measurement (COLD_START_NOTE).
  var COLD_START_MS = 30000;
  var COLD_START_NOTE = 'assumed: a warm spare node with the image cached, where vLLM loads 16 GB of weights and captures ' +
                        'CUDA graphs; a fresh node takes minutes more';
  // The rate two replicas serve with room to spare but one alone can't (about 17-18 req/s with LENGTHS). Measured
  // as a visitor sees it (40 s warm-up, a refresh every 300 ms on a 30 s p99), seeds 1-10, killing at the open:
  // red 0.3-0.6 s after the kill (retries redo prefill, and their TTFT counts from their first arrival); with the
  // autoscaler off, 0-27 503s 30 s after the kill and 42-188 at 60 s; with it on, red for the last time 42-47 s
  // after the kill (the 30 s cold start, then the backlog). At 21 the 503s start too late on some loads (none by
  // 60 s on one); at 20, on most. tests/sim.test.mjs checks all three.
  var FAILURE_RATE = 22;

  // The sandbox: a deployment from the visitor's settings. Every GPU gets the same layout, and slot k of each
  // runs models[k] (a short list repeats its last). Time-sliced processes split 90% of the H100's memory by
  // their models' needs, as in tab 03 (at gpu-mem 0.9, tab 03's shares). Random traffic's rate is the total, split evenly across the models,
  // each with its own kind of request unless lengths says otherwise; bursts go to the first model's stream.
  var SANDBOX_LAYOUTS = {
    whole: ['7g.80gb'], '4g+3g': ['4g.40gb', '3g.40gb'], '3g+2g+2g': ['3g.40gb', '2g.20gb', '2g.20gb'],
    '2g+2g+2g+1g': ['2g.20gb', '2g.20gb', '2g.20gb', '1g.10gb'], 'time-sliced': ['7g.80gb', '7g.80gb', '7g.80gb']
  };
  var SANDBOX_DEFAULTS = {
    gpus: 1, layout: '3g+2g+2g', models: ['llama-3-8b', 'llama-3.2-3b', 'llama-3.2-1b'], batching: 'continuous', gpuMemUtil: 0.9,
    maxNumSeqs: 256, traffic: 'random', rate: 6, bursts: true, lengths: 'chat', router: 'least', autoscaler: false
  };
  var SLICE_WEIGHT = { 'llama-3-8b': 0.45, 'llama-3.2-3b': 0.25, 'llama-3.2-1b': 0.2 };   // tab 03's time-sliced shares
  var OWN_LENGTHS = { 'llama-3-8b': LENGTHS, 'llama-3.2-3b': SHORT, 'llama-3.2-1b': TINY };
  function sandboxPreset(settings, trace) {
    var s = Object.assign({}, SANDBOX_DEFAULTS, settings), slots = SANDBOX_LAYOUTS[s.layout], instances = [], models = [], slo = {};
    if (!slots) throw new Error('unknown sandbox layout: ' + s.layout);
    var pick = function (k) { return s.models[Math.min(k, s.models.length - 1)]; }, weight = 0, g, k;
    for (k = 0; k < slots.length; k++) weight += SLICE_WEIGHT[pick(k)];
    for (g = 0; g < s.gpus; g++) {
      for (k = 0; k < slots.length; k++) {
        var spec = { profile: slots[k], model: pick(k), gpu: g };
        if (s.layout === 'time-sliced') spec.gpuMemUtil = s.gpuMemUtil * SLICE_WEIGHT[spec.model] / weight;
        instances.push(spec);
        if (models.indexOf(spec.model) < 0) models.push(spec.model);
      }
    }
    models.forEach(function (m) { slo[m] = SLOS[m]; });
    var streams = s.traffic === 'trace' ?
      [{ model: models.indexOf('llama-3-8b') >= 0 ? 'llama-3-8b' : models[0], trace: trace, startMs: TRACE_START_MS }] :
      models.map(function (m, i) {
        return { model: m, rate: s.rate / models.length, bursts: !!s.bursts && i === 0,
                 lengths: s.lengths === 'long' ? LONG : s.lengths === 'short' ? SHORT : OWN_LENGTHS[m] };
      });
    return { instances: instances, batching: s.batching, slo: slo, streams: streams, router: s.router, autoscaler: !!s.autoscaler,
             config: { gpuMemUtil: s.gpuMemUtil, maxNumSeqs: s.maxNumSeqs } };
  }

  // The SLO challenge: the visitor's deployment serves the Azure hour's peak (minutes 20-35) once, at 12x, on its
  // Llama 3 8B servers. It passes if TTFT p99 stays within sloMs on every refresh (a windowMs p99) with no 503s.
  // par is a deployment that passes, and parUsdPer1M its cost per 1M output tokens. Measured with the page's
  // refresh (seed 1; the replay itself doesn't depend on the seed): the run takes about 79 s. One H100 fails at
  // 38 s (p99 7.3 s, 55 503s) at $0.43; two pass with p99 at most 0.37 s, at $0.765 (round-robin $0.766, MIG 4g+3g
  // on each $0.80, three H100s $1.14). tests/sim.test.mjs checks the par.
  var CHALLENGE = {
    startMs: 20 * 60000, endMs: 35 * 60000, sloMs: 2000, windowMs: 30000,
    par: { gpus: 2, layout: 'whole', models: ['llama-3-8b'], batching: 'continuous', router: 'least' }, parUsdPer1M: 0.765
  };
  function challengePreset(settings, trace) {
    var p = sandboxPreset(Object.assign({}, settings, { traffic: 'random' }));
    if (!p.instances.some(function (i) { return i.model === 'llama-3-8b'; })) {
      throw new Error('the challenge serves Llama 3 8B: deploy at least one 8B');
    }
    p.streams = [{ model: 'llama-3-8b', trace: trace, startMs: CHALLENGE.startMs, endMs: CHALLENGE.endMs }];
    return p;
  }

  var PRESETS = {
    batching: { instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 6, bursts: true } },
    // Tab 02: bursts of 8-12 over a steady 0.5 req/s, so the 0.9 pool fills within 30 s of opening (and the
    // 8 s warm-up sees no request on only 5 of 200 seeds). tests/sim.test.mjs checks what a visitor sees
    // (8 s warm-up, then 30 s): on seeds 1-20, KV passes 90% and a preemption comes on every load (seeds
    // 21-100: 80/80 and 76/80). Over 60 s on seeds 1-10, more memory runs more requests at once (median 3,
    // 20 and 22 at 0.5, 0.9 and 0.95), 0.95 finishes more than 0.5 (median 40 vs 22), and preemption starts
    // sooner at 0.5 (median 9.9 s vs 24.1 s at 0.9). The load is above what the slice serves: at 0.9 the
    // queue holds a median 51 requests after 2 min.
    kvcache: { instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 0.5, bursts: { min: 8, max: 12 }, lengths: LONG } },
    // GPU per model: Kubernetes gives each pod a whole H100
    'mig-gpu': tab03([
      { profile: '7g.80gb', model: 'llama-3-8b', gpu: 0 },
      { profile: '7g.80gb', model: 'llama-3.2-3b', gpu: 1 },
      { profile: '7g.80gb', model: 'llama-3.2-1b', gpu: 2 }
    ]),
    // Time-slicing: three processes share one H100 with no isolation, splitting its memory
    'mig-time': tab03([
      { profile: '7g.80gb', model: 'llama-3-8b', gpu: 0, gpuMemUtil: 0.45 },
      { profile: '7g.80gb', model: 'llama-3.2-3b', gpu: 0, gpuMemUtil: 0.25 },
      { profile: '7g.80gb', model: 'llama-3.2-1b', gpu: 0, gpuMemUtil: 0.2 }
    ]),
    // MIG: one H100 split 3g.40gb + 2g.20gb + 2g.20gb, one model per isolated slice
    'mig-mig': tab03([
      { profile: '3g.40gb', model: 'llama-3-8b', gpu: 0 },
      { profile: '2g.20gb', model: 'llama-3.2-3b', gpu: 0 },
      { profile: '2g.20gb', model: 'llama-3.2-1b', gpu: 0 }
    ]),
    // Tab 04, on-prem: the large model is the 8B on 3g
    'routing-onprem': tab04({ profile: '3g.40gb', model: 'llama-3-8b', gpu: 0 }),
    // Tab 04, API: the large model is the API model, with no GPU; the 3g slice sits idle, and the H100 is still
    // billed in full
    'routing-api': tab04({ profile: 'api', model: 'api' }),
    // Tab 05, random: the trace's average rate and fitted lengths, without its hour
    'traffic-random': Object.assign({}, TAB05, { streams: [{ model: 'llama-3-8b', rate: TRACE_RATE, bursts: false, lengths: TRACE_FIT }] }),
    failure: {
      instances: [{ profile: '7g.80gb', model: 'llama-3-8b', gpu: 0 }, { profile: '7g.80gb', model: 'llama-3-8b', gpu: 1 }],
      batching: 'continuous', slo: { 'llama-3-8b': 2000 }, autoscaler: false, traffic: { rate: FAILURE_RATE, bursts: false }
    }
  };

  // Tab 04's gateway. Its router is the System1 model; a request's hidden difficulty is a uniform draw raised
  // to DIFFICULTY_POWER, so most requests are easy. The small share and misrouted share in metrics cover the
  // routing decisions of the last ROUTE_WINDOW_MS.
  var SYSTEM1 = 'system1';
  var DIFFICULTY_POWER = 2;
  var ROUTE_WINDOW_MS = 30000;

  var MAX_TICK_MS = 50;         // a background tab coming back must not replay minutes at once
  var TOKLOG_KEEP_MS = 10000;   // the token log only feeds recent-throughput metrics
  var TOKRATE_WINDOW_MS = 3000; // throughput is the tokens made over the last 3 s
  var TTFT_WINDOW_MS = 30000;   // TTFT percentiles cover first tokens from the last 30 s by default,
  var TTFT_SAMPLES = 200;       // and at most the last 200 of them (of that model's, for one model)
  var TTFT_KEEP_MS = 120000;    // the TTFT log keeps 120 s, the longest window metrics takes
  var FINISHED_KEEP = 500;      // sim.finished keeps only the latest requests, so memory stays bounded
  var BURST_SPREAD_MS = 450;    // a manual burst arrives over this long
  var BURSTS = { min: 30, max: 40 };   // a stream with bursts: true gets 30-40 requests at a time,
  var BURST_MS = 1000;                 // spread over 1 s, every 8-12 s (burstGap)

  // Price of one H100 80GB for an hour, on demand, in USD. Lambda lists its 1x H100 SXM
  // at $4.29 per GPU-hour on https://lambda.ai/pricing (checked 2026-10-25).
  var GPU_HOUR_USD = 4.29;
  var GPU_HOUR_SOURCE = 'Lambda on-demand 1x H100 SXM 80GB, https://lambda.ai/pricing, checked 2026-10-25';

  // Tab 04's API model: a mid-tier model behind a per-token API, on someone else's GPUs. Here it has no KV, no
  // queue and no limit on how many requests run at once, only a fixed latency and a price. A request's first
  // token comes baseMs plus msPerInputToken per prompt token after it enters, then one token every tpotMs; its
  // prompt is billed at inputPer1M and each output token at outputPer1M (USD per 1M tokens).
  // Price: Claude Sonnet 5.5 (between Haiku and Opus in Anthropic's lineup) lists at $2 per 1M input tokens and
  // $10 per 1M output tokens on https://claude.com/pricing (checked 2026-10-26).
  // Latency: Artificial Analysis's 72-hour medians for it at low effort on Anthropic's API, with no reasoning
  // tokens on the benchmark, https://artificialanalysis.ai/models/claude-sonnet-5-5-low (checked 2026-10-26):
  // the first token after 0.773 s at 1k input tokens and 1.159 s at 10k, which is a 730 ms base plus 0.043 ms
  // per input token, and 88.0 tokens/s after it at 1k (11.4 ms per token), the workload nearest LENGTHS' prompts.
  var API = {
    inputPer1M: 2,
    outputPer1M: 10,
    baseMs: 730,
    msPerInputToken: 0.043,
    tpotMs: 11.4,
    source: 'Claude Sonnet 5.5 list price, $2 / $10 per 1M input / output tokens, https://claude.com/pricing; ' +
            'latency from Artificial Analysis, Claude Sonnet 5.5 (low effort) on Anthropic\'s API: first token ' +
            '0.77 s at 1k input tokens and 1.16 s at 10k, 88 tokens/s, ' +
            'https://artificialanalysis.ai/models/claude-sonnet-5-5-low; checked 2026-10-26'
  };
  var API_SOURCE = API.source;
  var API_MODEL = 'api';       // the API model's name, and the profile of the instance that serves it
  var API_FLUSH_MS = 50;       // an API instance logs its requests' tokens at least this often while they decode
  var API_WINDOW_MS = 30000;   // API $/h is the spend over the last 30 s

  var nextId = 1;

  // A value is given when it's set and, if a number, finite
  function given(v) {
    return v !== undefined && v !== null && !(typeof v === 'number' && !isFinite(v));
  }

  function pick(config, key) {
    var v = config ? config[key] : undefined;
    return given(v) ? v : DEFAULTS[key];
  }

  // Throws on a profile or model name that isn't in the tables
  function checkModel(model) {
    if (!MODELS.hasOwnProperty(model)) throw new Error('unknown model: ' + model);
  }

  function lookup(profile, model) {
    if (!PROFILES.hasOwnProperty(profile)) throw new Error('unknown MIG profile: ' + profile);
    checkModel(model);
  }

  function createInstance(profile, model, config) {
    if (profile === API_MODEL || model === API_MODEL) return createApiInstance(profile, model);
    lookup(profile, model);
    var p = PROFILES[profile], m = MODELS[model];
    var usableGB = p.memGB * pick(config, 'gpuMemUtil') - m.weightsGB - pick(config, 'activationReserveGB');
    var kvBudget = Math.max(0, usableGB) * 1e9;
    return {
      id: nextId++,
      profile: profile,
      model: model,
      api: false,          // an API instance (createApiInstance) when true
      gpu: 0,              // the physical GPU it runs on; createSim sets it from the spec
      timeSliced: false,   // whether it time-slices a whole GPU with other processes; createSim sets it
      fits: kvBudget > 0,
      gpuMemUtil: pick(config, 'gpuMemUtil'),   // its --gpu-memory-utilization, for the config drawer
      kvBudget: kvBudget,
      // Like vLLM's max-model-len: a request longer than this is refused, so any one
      // admitted sequence fits the KV pool on its own and preemption always terminates
      maxModelLen: Math.min(m.contextLen, Math.floor(kvBudget / m.kvBytesPerToken)),
      kvUsed: 0,
      kvReserved: 0,   // a request-level batch's up-front KV reservation, 0 when none is running
      batch: null,     // that batch: { padLen, steps }; null in continuous mode and for a legacy batch
      queue: [],
      running: [],
      stepEnd: null,
      step: null,
      up: true,
      readyAt: null,   // tab 06: when a replacement starting on this slot serves, null otherwise
      deadGpu: null    // tab 06: the GPU that died here, while its replacement starts
    };
  }

  // Tab 04's API model as an instance, { profile: 'api', model: 'api' }. It's no GPU (gpu null, so gpuCount leaves
  // it out) and holds no KV (a budget of 0, and kvFrac leaves it out). Its queue stays empty: place starts every
  // request it takes at once, and apiTokens logs their tokens on API's fixed schedule. It never steps, preempts
  // or batches.
  function createApiInstance(profile, model) {
    if (profile !== API_MODEL || model !== API_MODEL) {
      throw new Error('the API model runs only as an API instance, { profile: \'api\', model: \'api\' }');
    }
    return {
      id: nextId++,
      profile: API_MODEL,
      model: API_MODEL,
      api: true,
      gpu: null,
      timeSliced: false,
      fits: true,
      kvBudget: 0,
      maxModelLen: Infinity,
      kvUsed: 0,
      kvReserved: 0,
      batch: null,
      queue: [],
      running: [],
      stepEnd: null,
      step: null,
      up: true,
      loggedAt: 0      // when apiTokens last logged its requests' tokens
    };
  }

  // One engine step: the slower of the compute time and the memory time, plus fixed overhead
  function stepTimeMs(profile, model, prefillTokens, decodeSeqs, kvTokensRead) {
    lookup(profile, model);
    var p = PROFILES[profile], m = MODELS[model];
    var flops = 2 * m.params * (prefillTokens + decodeSeqs);
    var bytes = m.weightsGB * 1e9 + kvTokensRead * m.kvBytesPerToken;
    var computeS = flops / (GPU.tflops * 1e12 * GPU.mfu * p.compute);
    var memoryS = bytes / (GPU.tbps * 1e12 * GPU.mbu * p.bw);
    return Math.max(computeS, memoryS) * 1000 + GPU.stepOverheadMs;
  }

  // ---- Randomness and traffic ----

  // mulberry32: a small seeded PRNG, so a seed replays the same traffic
  function mulberry32(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A standard normal draw (Box-Muller)
  function gaussian(rng) {
    return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  }

  function sampleLength(rng, d) {
    var z = gaussian(rng);
    return Math.min(d.max, Math.max(d.min, Math.round(d.median * Math.exp(d.sigma * z))));
  }

  // A traffic stream from its spec { model, rate (req/s), bursts, lengths? }. bursts is true (BURSTS),
  // { min, max } (the count range) or false; lengths defaults to LENGTHS. A spec { model, trace, startMs? }
  // replays a trace instead (traceStream).
  function createStream(spec) {
    checkModel(spec.model);
    if (spec.trace) return traceStream(spec);
    var b = spec.bursts, l = spec.lengths || {};
    return {
      model: spec.model,
      rate: spec.rate,
      bursts: !b ? false : typeof b === 'object' ? { min: b.min, max: b.max } : { min: BURSTS.min, max: BURSTS.max },
      lengths: { prompt: l.prompt || LENGTHS.prompt, output: l.output || LENGTHS.output },
      nextArrival: Infinity,
      nextBurst: Infinity
    };
  }

  // A stream that replays a trace { gapMs, prompt, output, durationMs, speed, fit }: request i arrives at
  // hour time loop * durationMs + times[i] (times: the running sum of gapMs), played speed times faster, and
  // after the last request the hour starts over. pos is the hour time (counting loops) at sim time posT; while
  // arrivals are off the hour stands still. Bursts draw the trace's fitted lengths. It draws nothing from the
  // RNG, so a trace plays the same whatever the seed.
  function traceStream(spec) {
    var d = spec.trace, n = d.gapMs ? d.gapMs.length : 0, times = [], acc = 0, start = spec.startMs || 0, k;
    if (!n || !d.prompt || !d.output || d.prompt.length !== n || d.output.length !== n || !(d.speed > 0) || !(d.durationMs > 0)) {
      throw new Error('bad trace: needs gapMs, prompt and output of one non-zero length, a speed and a duration');
    }
    for (k = 0; k < n; k++) { acc += d.gapMs[k]; times.push(acc); }
    for (k = 0; k < n && times[k] < start; k++) { /* first request at or after start */ }
    var s = {
      model: spec.model, rate: 0, bursts: false, lengths: { prompt: d.fit.prompt, output: d.fit.output },
      trace: { times: times, prompt: d.prompt, output: d.output, durationMs: d.durationMs, speed: d.speed },
      cursor: k % n, loop: k === n ? 1 : 0, pos: start, posT: 0, nextArrival: Infinity, nextBurst: Infinity,
      endMs: spec.endMs || Infinity   // the SLO challenge replays a window once: nothing from this hour time on
    };
    return s;
  }
  // Whether every stream replays a window that's over (only the SLO challenge's does)
  function windowOver(sim) {
    return sim.streams.length > 0 && sim.streams.every(function (s) { return s.trace && s.endMs !== Infinity && traceNext(s) >= s.endMs; });
  }
  // The SLO challenge is done once its window is over and every request in it has been served or turned away
  function challengeDone(sim) {
    if (!windowOver(sim) || sim.pending.length) return false;
    return sim.instances.every(function (inst) { return !inst.queue.length && !inst.running.length; });
  }

  // The hour time of a trace stream's next request, and the sim time it's due (never, past its window's end)
  function traceNext(s) { return s.loop * s.trace.durationMs + s.trace.times[s.cursor]; }
  function traceDue(s, t) { return traceNext(s) >= s.endMs ? Infinity : t + (traceNext(s) - s.pos) / s.trace.speed; }

  // Poisson arrivals have exponential gaps; a rate of 0 means no steady arrivals
  function poissonGap(sim, stream) {
    return stream.rate > 0 ? -Math.log(1 - sim.rng()) / stream.rate * 1000 : Infinity;
  }

  function burstGap(sim) {
    return 8000 + sim.rng() * 4000;
  }

  // Schedules every stream's next arrival and burst from now. A stream without bursts still draws a
  // burst gap, so one stream gets the same traffic from a seed as the single stream before streams did.
  function schedule(sim) {
    for (var k = 0; k < sim.streams.length; k++) {
      var s = sim.streams[k];
      if (s.trace) { s.posT = sim.t; s.nextArrival = traceDue(s, sim.t); continue; }
      s.nextArrival = sim.t + poissonGap(sim, s);
      s.nextBurst = sim.t + burstGap(sim);
    }
  }

  // sim.pending holds { t, stream } arrival times, earliest first
  function sortPending(sim) {
    sim.pending.sort(function (a, b) { return a.t - b.t; });
  }

  // A burst on stream k: min to max arrival times spread over the next BURST_MS
  function addBurst(sim, k) {
    var b = sim.streams[k].bursts, n = b.min + Math.floor(sim.rng() * (b.max - b.min + 1));
    for (var j = 0; j < n; j++) sim.pending.push({ t: sim.t + sim.rng() * BURST_MS, stream: k });
    sortPending(sim);
  }

  // A trace stream's next request, with the trace's own lengths. The first request of each loop after the
  // first marks the sparkline.
  function arriveTrace(sim, k) {
    var s = sim.streams[k], tr = s.trace;
    if (s.cursor === 0 && s.loop > 0) sim.events.push({ t: sim.t, label: 'trace loops' });
    enqueue(sim, { prompt: tr.prompt[s.cursor], output: tr.output[s.cursor], model: s.model, stream: k });
    s.pos = traceNext(s);
    s.posT = sim.t;
    s.cursor += 1;
    if (s.cursor === tr.times.length) { s.cursor = 0; s.loop += 1; }
    s.nextArrival = traceDue(s, sim.t);
    if (s.nextArrival === Infinity) setArrivals(sim, false);   // a window replayed once is over: the sim drains, and stops
  }

  // A request on stream k, with that stream's lengths and model
  function arrive(sim, k) {
    var s = sim.streams[k];
    enqueue(sim, { prompt: sampleLength(sim.rng, s.lengths.prompt), output: sampleLength(sim.rng, s.lengths.output),
                   model: s.model, stream: k });
  }

  // ---- Router ----

  function outstanding(inst) {
    return inst.queue.length + inst.running.length;
  }

  // An instance can take a request if it's up, fits the model, has queue room and, when the
  // prompt is given, a max-model-len that holds the prompt plus max_tokens
  function canTake(sim, inst, prompt) {
    return inst.up && inst.fits && inst.queue.length < sim.cfg.queueCap &&
      (prompt === undefined || prompt + sim.cfg.maxTokens <= inst.maxModelLen);
  }

  // Least outstanding requests among the instances that can take it and, when a model is given,
  // serve that model; lowest index on ties. null when none can (the request gets a 503).
  function route(sim, prompt, model) {
    if (sim.router === 'round-robin') return roundRobin(sim, prompt, model);
    var best = null;
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if ((!model || inst.model === model) && canTake(sim, inst, prompt) &&
          (!best || outstanding(inst) < outstanding(best))) best = inst;
    }
    return best;
  }

  // The sandbox's other policy: each request goes to the next server for its model in turn, however busy it
  // is (skipping one that can't take it), so a slow slice gets as many as a fast one
  function roundRobin(sim, prompt, model) {
    var n = sim.instances.length, key = model || '*', start = sim.rrNext[key] || 0;
    for (var j = 0; j < n; j++) {
      var k = (start + j) % n, inst = sim.instances[k];
      if ((!model || inst.model === model) && canTake(sim, inst, prompt)) { sim.rrNext[key] = k + 1; return inst; }
    }
    return null;
  }

  // Puts r in the queue of an instance serving r.model (any instance when null), or rejects it (a 503). An API
  // instance has no queue: r starts there at once.
  function place(sim, r) {
    var inst = route(sim, r.prompt, r.model);
    if (!inst) {
      r.state = 'rejected';
      sim.stats.rejected += 1;
      phase(r, sim.t, null);
      r.marks.push({ t: sim.t, kind: 'rejected' });
      return;
    }
    r.inst = sim.instances.indexOf(inst);
    r.model = inst.model;
    phase(r, sim.t, 'queue');
    if (inst.api) {
      startApi(sim, inst, r);
      return;
    }
    r.state = 'queued';
    inst.queue.push(r);
  }

  // A request's timeline, for following it: closes its open span at t and, given a kind, opens the next on its
  // instance. A queue span opens when it's placed, prefill when it's admitted (an API request at once, so its
  // queue span is empty), decode when its prefill completes, and nothing once it's done or turned away.
  function phase(r, t, kind) {
    var s = r.spans[r.spans.length - 1];
    if (s && s.t1 === null) s.t1 = t;
    if (kind) r.spans.push({ kind: kind, t0: t, t1: null, inst: r.inst });
  }

  // An API request runs the moment it enters, however many already run. Its prompt is billed now, and its first
  // token is due API.baseMs plus API.msPerInputToken per prompt token from now.
  function startApi(sim, inst, r) {
    r.state = 'running';
    if (r.tAdmit === null) r.tAdmit = sim.t;
    phase(r, sim.t, 'prefill');   // the API model's own prefill and queueing, until its first token
    r.apiStart = sim.t;
    r.apiFirst = sim.t + API.baseMs + r.prompt * API.msPerInputToken;
    inst.running.push(r);
    spend(sim, r.prompt * API.inputPer1M / 1e6);
  }

  // API spend: the running total in sim.stats.apiUsd, and the log of [time, USD] that API $/h comes from
  function spend(sim, usd) {
    sim.stats.apiUsd += usd;
    sim.apiLog.push([sim.t, usd]);
    trimLog(sim.apiLog, sim.t, API_WINDOW_MS, Infinity);
  }

  // A request arrives now. It's routed at once, or rejected when no instance can take it.
  // spec = { prompt, output, model?, stream? }: without a model any instance may serve it (in tab 04, the
  // System1 model), and it takes that instance's model. inst is an index into sim.instances; stream is the
  // index into sim.streams it came from, null when enqueued directly.
  // In tab 04 (sim.routing set) a request also gets a hidden difficulty and the standard normal draw its
  // score's noise scales, both drawn now, so a seed replays the same traffic whatever the threshold. Only
  // the score and the misrouted count read them, never a scheduler. A request on the System1 model starts
  // on its scoring hop (hop 'score'); every other request is on its serving hop. Outside tab 04 nothing more
  // is drawn, so tabs 01-03 replay the same traffic as before, and difficulty stays null.
  function enqueue(sim, spec) {
    if (spec.model) checkModel(spec.model);
    sim.stats.arrived += 1;
    var r = {
      id: sim.stats.arrived, t0: sim.t, prompt: spec.prompt, output: spec.output,
      model: spec.model || (sim.routing ? SYSTEM1 : null), stream: spec.stream === undefined ? null : spec.stream,
      inst: null, state: 'queued',
      prefillTarget: spec.prompt, prefillDone: 0, generated: 0, kvTokens: 0,
      tAdmit: null, tFirst: null, tDone: null, preemptions: 0,
      difficulty: null, noiseZ: null, score: null, tScored: null, hop: 'serve', target: null,
      apiStart: null, apiFirst: null,  // on an API instance: when r entered it, and when its first token is due
      retries: 0,                      // tab 06: how often a dead GPU sent it back to the router
      spans: [],                       // its timeline for the follow strip: { kind: 'queue' | 'prefill' | 'decode', t0, t1, inst }
      marks: []                        // and what happened to it: { t, kind: 'preempted' | 'retried' | 'scored' | 'rejected', ... }
    };
    if (sim.routing) {
      r.difficulty = Math.pow(sim.rng(), DIFFICULTY_POWER);
      r.noiseZ = gaussian(sim.rng);
      if (r.model === SYSTEM1) r.hop = 'score';
    }
    place(sim, r);
    return r;
  }

  // The gateway's rule: score >= threshold goes to the large model, the rest to the small one. At threshold 1
  // nothing goes large, not even a score of 1 (noise can clamp a score there), so 1 is the all-small end.
  function routesLarge(routing, score) {
    return routing.threshold < 1 && score >= routing.threshold;
  }

  // The System1 model has made r's one token, its score: the gateway counts the decision and sends r on to
  // the small or the large model as its serving hop, which starts over (prefill, decode, KV) and is a 503 if
  // that model can't take it. r keeps t0, so its TTFT includes the System1 hop. It runs the moment the
  // System1 step completes, so r is never outside a queue or running list.
  function forward(sim, r, t) {
    var R = sim.routing, hard = r.difficulty >= R.hardCut;
    r.score = Math.min(1, Math.max(0, r.difficulty + R.noise * r.noiseZ));
    r.tScored = t;
    r.target = routesLarge(R, r.score) ? 'large' : 'small';
    if (r.target === 'large') sim.stats.routedLarge += 1;
    else sim.stats.routedSmall += 1;
    if (hard && r.target === 'small') sim.stats.misrouted += 1;
    sim.routeLog.push([t, r.target, hard]);
    trimLog(sim.routeLog, t, ROUTE_WINDOW_MS, Infinity);
    phase(r, t, null);
    r.marks.push({ t: t, kind: 'scored', score: r.score, target: r.target });
    r.hop = 'serve';
    r.model = r.target === 'large' ? R.large : R.small;
    r.inst = null;
    r.prefillTarget = r.prompt;
    r.prefillDone = 0;
    r.generated = 0;
    r.kvTokens = 0;
    place(sim, r);
  }

  // Moves tab 04's threshold live and logs it in sim.events. Requests already scored keep their target;
  // the ones the System1 model scores from now on use the new threshold.
  function setThreshold(sim, x) {
    if (!sim.routing) throw new Error('setThreshold needs a routing sim');
    if (x === sim.routing.threshold) return;
    sim.routing.threshold = x;
    sim.events.push({ t: sim.t, label: 'threshold ' + x.toFixed(2) });
  }

  // ---- KV accounting ----

  // The KV bytes an instance holds: what its sequences hold, or a request-level batch's
  // reservation, whichever is more. inst.kvUsed is only ever set from this.
  function kvUsedBytes(inst) {
    var tokens = 0;
    for (var k = 0; k < inst.running.length; k++) tokens += inst.running[k].kvTokens;
    return Math.max(inst.kvReserved, tokens * MODELS[inst.model].kvBytesPerToken);
  }

  // Preemption by recompute (vLLM's default): drop the newest sequence's KV and put it back at the
  // front of its queue. It later re-prefills its prompt plus the tokens it already made. tFirst
  // stays, since those tokens were already streamed.
  function preemptNewest(sim, inst) {
    var r = inst.running.pop();
    r.state = 'queued';
    r.kvTokens = 0;
    r.prefillTarget = r.prompt + r.generated;
    r.prefillDone = 0;
    r.preemptions += 1;
    sim.stats.preemptions += 1;
    phase(r, sim.t, 'queue');
    r.marks.push({ t: sim.t, kind: 'preempted' });
    inst.queue.unshift(r);
    inst.kvUsed = kvUsedBytes(inst);
  }

  // ---- Continuous batching (vLLM-style, with chunked prefill) ----

  // Plans one step and returns its items, { req, chunk }, where chunk 0 means one decode token.
  // Running sequences go oldest first: a decoding one makes a token, a prefilling one gets a
  // chunk of the token budget. Then the queue head is admitted while max-num-seqs, the token
  // budget and the KV pool allow. Every KV check is on what the step will hold when it completes:
  // its chunks, plus one token per decode and per prefill that completes (that's the first token).
  // A running sequence that doesn't fit preempts the newest one; a queued one waits.
  // With admit false, only the running sequences step (a legacy batch in request-level mode).
  function planContinuous(sim, inst, admit) {
    var cfg = sim.cfg, kv = MODELS[inst.model].kvBytesPerToken;
    var items = [], tokens = cfg.maxNumBatchedTokens, grow = 0, preempted = false;
    function fits(add) { return inst.kvUsed + (grow + add) * kv <= inst.kvBudget; }
    function take(r, chunk, add) { items.push({ req: r, chunk: chunk }); tokens -= chunk || 1; grow += add; }

    for (var k = 0; k < inst.running.length; k++) {
      var r = inst.running[k], left = r.prefillTarget - r.prefillDone, chunk = 0, add = 1;
      if (left > 0) {
        chunk = Math.min(left, tokens);
        if (chunk <= 0) continue;              // the token budget is spent; it waits a step
        add = chunk + (chunk === left ? 1 : 0);
      }
      while (!fits(add) && inst.running.length > k) { preemptNewest(sim, inst); preempted = true; }
      if (inst.running.length > k) take(r, chunk, add);   // else r was the newest and is preempted
    }

    // vLLM V1: a step that preempted admits nobody from the waiting queue
    while (admit && !preempted && inst.queue.length && inst.running.length < cfg.maxNumSeqs && tokens > 0) {
      var q = inst.queue[0], qLeft = q.prefillTarget - q.prefillDone, qChunk = Math.min(qLeft, tokens);
      var qAdd = qChunk + (qChunk === qLeft ? 1 : 0);
      if (!fits(qAdd)) break;
      inst.queue.shift();
      q.state = 'running';
      if (q.tAdmit === null) q.tAdmit = sim.t;  // first admission: queue wait is tAdmit - t0
      phase(q, sim.t, 'prefill');
      inst.running.push(q);
      take(q, qChunk, qAdd);
    }
    return items;
  }

  // Whether a request arriving now would start at once: continuous mode, nothing queued ahead of it,
  // a free max-num-seqs slot and some KV left. Never on an API instance, which has no slots or KV to draw.
  function canAdmit(sim, inst) {
    return !inst.api && sim.batching === 'continuous' && inst.queue.length === 0 &&
      inst.running.length < sim.cfg.maxNumSeqs && inst.kvUsed < inst.kvBudget;
  }

  // A continuous step's cost: its chunks, one token per decode, and the KV its sequences read
  function costOf(items) {
    var plan = { items: items, prefill: 0, decode: 0, kvRead: 0 };
    for (var k = 0; k < items.length; k++) {
      if (items[k].chunk) plan.prefill += items[k].chunk;
      else plan.decode += 1;
      plan.kvRead += items[k].req.kvTokens;
    }
    return plan;
  }

  // ---- Request-level batching (static batches: Hugging Face generate() behind Triton's dynamic batcher) ----

  function batchDeadline(sim, inst) {
    return inst.queue[0].t0 + sim.cfg.maxQueueDelayMs;
  }

  // A batch forms only on an empty instance, once the queue holds max-batch requests or its oldest has
  // waited max-queue-delay. A sequence already running (a legacy batch from continuous mode) blocks it.
  function batchReady(sim, inst) {
    return !inst.running.length && inst.queue.length > 0 &&
      (inst.queue.length >= sim.cfg.maxBatch || sim.t >= batchDeadline(sim, inst));
  }

  // Takes the queue head while the batch is under max-batch and every slot's KV fits: the scheduler can't
  // know output lengths, so each slot reserves the batch's longest prompt plus max_tokens. A batch of one
  // always fits, since the router only sends prompts within max-model-len.
  function formBatch(sim, inst) {
    var cfg = sim.cfg, kv = MODELS[inst.model].kvBytesPerToken, n = 0, maxPrompt = 0, padLen = 0;
    while (n < inst.queue.length && n < cfg.maxBatch) {
      var longest = Math.max(maxPrompt, inst.queue[n].prompt);
      if ((n + 1) * (longest + cfg.maxTokens) * kv > inst.kvBudget) break;
      maxPrompt = longest;
      n += 1;
    }
    var taken = inst.queue.splice(0, n);
    for (var k = 0; k < n; k++) {
      var r = taken[k];
      r.state = 'running';
      if (r.tAdmit === null) r.tAdmit = sim.t;
      phase(r, sim.t, 'prefill');
      padLen = Math.max(padLen, r.prefillTarget);   // a re-prefill after preemption also redoes the tokens it made
      inst.running.push(r);
    }
    inst.kvReserved = n * (maxPrompt + cfg.maxTokens) * kv;
    inst.batch = { padLen: padLen, steps: 0 };
    inst.kvUsed = kvUsedBytes(inst);
  }

  // A static batch computes every slot, padded: its first step prefills n * padLen tokens and gives every
  // sequence its first token, then each step decodes all n slots, idle ones included, over padded KV.
  function planRequest(sim, inst) {
    if (batchReady(sim, inst)) formBatch(sim, inst);
    var b = inst.batch;
    if (!b) return costOf(planContinuous(sim, inst, false));   // a legacy batch, or nothing to do
    var n = inst.running.length, items = [];
    for (var k = 0; k < n; k++) {
      var r = inst.running[k];
      if (r.state === 'running') items.push({ req: r, chunk: b.steps ? 0 : r.prefillTarget - r.prefillDone });
    }
    if (!b.steps) return { items: items, prefill: n * b.padLen, decode: 0, kvRead: 0 };
    return { items: items, prefill: 0, decode: n, kvRead: n * (b.padLen + b.steps) };
  }

  function endBatch(inst) {
    for (var k = 0; k < inst.running.length; k++) inst.running[k].state = 'done';
    inst.running = [];
    inst.batch = null;
    inst.kvReserved = 0;
  }

  // ---- Steps ----

  // Time-slicing: processes sharing a whole GPU split its time among those with work, so a step's
  // stretch is 1 plus the number of the GPU's other time-sliced processes with a step in flight. It's
  // fixed when the step starts.
  function stretchOf(sim, inst) {
    var stretch = 1;
    if (!inst.timeSliced) return stretch;
    for (var k = 0; k < sim.instances.length; k++) {
      var o = sim.instances[k];
      if (o !== inst && o.timeSliced && o.gpu === inst.gpu && o.stepEnd !== null) stretch += 1;
    }
    return stretch;
  }

  // How long a step takes at a given stretch. Alone (stretch 1) it runs at full speed. Shared, only
  // its GPU time (not the fixed host-side overhead) is stretched, and CTX_SWITCH_LOSS of the GPU's
  // time goes to switching between contexts.
  function slicedMs(baseMs, stretch) {
    if (stretch <= 1) return baseMs;
    return GPU.stepOverheadMs + stretch * (baseMs - GPU.stepOverheadMs) / (1 - CTX_SWITCH_LOSS);
  }

  // Starts a step at sim.t if the instance has work. Returns whether it did. inst.step keeps the
  // step's cost (prefill tokens, decodes, KV tokens read) and its time-slicing stretch.
  function startStep(sim, inst) {
    var plan = sim.batching === 'request' ? planRequest(sim, inst) : costOf(planContinuous(sim, inst, true));
    if (!plan.items.length) return false;
    var stretch = stretchOf(sim, inst);
    inst.step = { start: sim.t, items: plan.items, prefill: plan.prefill, decode: plan.decode, kvRead: plan.kvRead, stretch: stretch };
    inst.stepEnd = sim.t + slicedMs(stepTimeMs(inst.profile, inst.model, plan.prefill, plan.decode, plan.kvRead), stretch);
    return true;
  }

  // ---- What the page draws ----

  // The share of r's prefill done by sim.t: what's finished, plus the in-flight share of its chunk in
  // the instance's current step. On an API instance, the share of r's wait for its first token gone by.
  function prefillProgress(sim, inst, r) {
    if (inst.api) {
      if (r.generated > 0 || !(r.apiFirst > r.apiStart)) return 1;
      return Math.max(0, Math.min(1, (sim.t - r.apiStart) / (r.apiFirst - r.apiStart)));
    }
    if (!(r.prefillTarget > 0)) return 1;
    var done = r.prefillDone, st = inst.step;
    if (st && inst.stepEnd > st.start) {
      var f = Math.min(1, (sim.t - st.start) / (inst.stepEnd - st.start));
      for (var k = 0; k < st.items.length; k++) {
        if (st.items[k].req === r && st.items[k].chunk) { done += st.items[k].chunk * f; break; }
      }
    }
    return Math.min(1, done / r.prefillTarget);
  }

  // Decode steps the current request-level batch has run; 0 when there's none
  function slotSteps(inst) {
    return inst.batch ? inst.batch.steps : 0;
  }

  // The current step's time-slicing stretch; 1 when idle or not time-sliced
  function stretchNow(inst) {
    return inst.step && inst.stepEnd !== null ? inst.step.stretch : 1;
  }

  // Keeps a log of [time, value] entries to its last keepMs and its last maxLen entries
  function trimLog(log, t, keepMs, maxLen) {
    while (log.length && (log.length > maxLen || log[0][0] < t - keepMs)) log.shift();
  }

  // A sequence that reaches its length is finished and counted right then, exactly once. In a
  // request-level batch it then stays as an idle slot, and the batch ends when every slot is idle.
  // A scoring hop isn't finished by its one token: it leaves the System1 model for its serving hop, and
  // that token is neither a first token nor an output token.
  function finishStep(sim, inst) {
    var t = inst.stepEnd, items = inst.step.items, made = 0, idle = 0, scored = [], k, r;
    for (k = 0; k < items.length; k++) {
      r = items[k].req;
      if (items[k].chunk) {
        r.prefillDone += items[k].chunk;
        r.kvTokens += items[k].chunk;
        if (r.prefillDone < r.prefillTarget) continue;   // more chunks to go
        if (r.hop !== 'score') phase(r, t, 'decode');    // its prefill is done (a scoring hop's ends with its score)
      }
      r.generated += 1;                                  // a decode token, or the first token after prefill
      r.kvTokens += 1;
      if (r.hop === 'score') continue;                   // the score
      if (r.tFirst === null) {
        r.tFirst = t;
        sim.ttftLog.push([t, t - r.t0, r.model]);
      }
      made += 1;
    }
    if (inst.batch) inst.batch.steps += 1;
    // A sequence ends at its own length (its stop token) or at max_tokens; a scoring hop, at its score
    for (k = inst.running.length - 1; k >= 0; k--) {
      r = inst.running[k];
      if (r.state === 'running' && r.hop === 'score' && r.generated >= 1) {
        inst.running.splice(k, 1);
        scored.unshift(r);                               // in admission order
        continue;
      }
      if (r.state === 'running' && r.generated >= Math.min(r.output, sim.cfg.maxTokens)) {
        r.tDone = t;
        phase(r, t, null);
        r.kvTokens = 0;
        sim.finished.push(r);
        if (sim.finished.length > FINISHED_KEEP) sim.finished.shift();
        sim.stats.finished += 1;
        if (inst.batch) r.state = 'idle';
        else { r.state = 'done'; inst.running.splice(k, 1); }
      }
      if (r.state === 'idle') idle += 1;
    }
    if (inst.batch && idle === inst.running.length) endBatch(inst);
    if (made) sim.tokLog.push([t, made]);
    sim.stats.outputTokens += made;
    trimLog(sim.tokLog, t, TOKLOG_KEEP_MS, Infinity);
    trimLog(sim.ttftLog, t, TTFT_KEEP_MS, Infinity);   // metrics takes its window and sample cap, per model
    inst.kvUsed = kvUsedBytes(inst);
    inst.step = null;
    inst.stepEnd = null;
    for (k = 0; k < scored.length; k++) forward(sim, scored[k], t);
  }

  // ---- The API model ----

  // An API request's length: its own, capped at max_tokens, and at least the one token every request makes
  function apiLength(sim, r) {
    return Math.max(1, Math.min(r.output, sim.cfg.maxTokens));
  }

  // When an API request's last token is due
  function apiDone(sim, r) {
    return r.apiFirst + (apiLength(sim, r) - 1) * API.tpotMs;
  }

  // The tokens an API request has made by time t: the first at r.apiFirst, then one every API.tpotMs
  function apiMade(sim, r, t) {
    if (t < r.apiFirst) return 0;
    if (t >= apiDone(sim, r)) return apiLength(sim, r);
    return Math.min(apiLength(sim, r), 1 + Math.floor((t - r.apiFirst) / API.tpotMs));
  }

  // When an API instance next has tokens to log: the earliest first or last token due and, while any request
  // is between the two, API_FLUSH_MS after it last logged, so throughput and spend never lag by more.
  // Infinity with nothing in flight.
  function apiWake(sim, inst) {
    var t = Infinity, decoding = false;
    for (var k = 0; k < inst.running.length; k++) {
      var r = inst.running[k];
      if (r.generated === 0) t = Math.min(t, r.apiFirst);
      else { t = Math.min(t, apiDone(sim, r)); decoding = true; }
    }
    return decoding ? Math.min(t, inst.loggedAt + API_FLUSH_MS) : t;
  }

  // Logs what an API instance's requests have made by sim.t: each first token with its TTFT, the output tokens
  // (in tokLog, and billed), and the requests that are done, finished as on a GPU instance. apiWake runs this at
  // every first and last token, so those keep their exact times.
  function apiTokens(sim, inst) {
    var t = sim.t, made = 0, running = [];
    for (var k = 0; k < inst.running.length; k++) {
      var r = inst.running[k], n = apiMade(sim, r, t);
      if (n > 0 && r.generated === 0) {
        r.tFirst = r.apiFirst;
        phase(r, r.apiFirst, 'decode');
        r.prefillDone = r.prefillTarget;
        sim.ttftLog.push([r.tFirst, r.tFirst - r.t0, r.model]);
      }
      made += n - r.generated;
      sim.stats.outputTokens += n - r.generated;
      r.generated = n;
      if (n < apiLength(sim, r)) {
        running.push(r);
        continue;
      }
      r.tDone = apiDone(sim, r);
      phase(r, r.tDone, null);
      r.state = 'done';
      sim.finished.push(r);
      if (sim.finished.length > FINISHED_KEEP) sim.finished.shift();
      sim.stats.finished += 1;
    }
    inst.running = running;
    inst.loggedAt = t;
    if (made) {
      sim.tokLog.push([t, made]);
      spend(sim, made * API.outputPer1M / 1e6);
    }
    trimLog(sim.tokLog, t, TOKLOG_KEEP_MS, Infinity);
    trimLog(sim.ttftLog, t, TTFT_KEEP_MS, Infinity);
  }

  // ---- Event loop ----

  // Wake-up times besides arrivals and step ends: Infinity, or a time after sim.t. In request-level
  // mode an empty instance wakes when its oldest queued request reaches max-queue-delay (a deadline
  // already reached forms its batch on the next pass); continuous batching needs none.
  function wakeUpTime(sim) {
    var t = Infinity;
    if (sim.batching !== 'request') return t;
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if (inst.running.length || !inst.queue.length) continue;
      var deadline = batchDeadline(sim, inst);
      if (deadline > sim.t && deadline < t) t = deadline;
    }
    return t;
  }

  // The earliest event. Step completions (and an API instance's tokens) win ties, so the router sees the
  // slots they free. An arrival or burst event carries the index of its stream.
  function nextEvent(sim) {
    var ev = { t: Infinity, kind: null, inst: null, stream: null }, k;
    function consider(t, kind, stream) { if (t < ev.t) { ev.t = t; ev.kind = kind; ev.stream = stream; } }
    for (k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k], at = inst.api ? apiWake(sim, inst) : inst.stepEnd;
      if (at !== null && at < ev.t) { consider(at, inst.api ? 'api' : 'step', null); ev.inst = inst; }
      if (inst.readyAt !== null && inst.readyAt !== undefined && inst.readyAt < ev.t) { consider(inst.readyAt, 'ready', null); ev.inst = inst; }
    }
    if (sim.pending.length) consider(sim.pending[0].t, 'pending', sim.pending[0].stream);
    if (sim.arrivalsOn) {
      for (k = 0; k < sim.streams.length; k++) {
        consider(sim.streams[k].nextArrival, sim.streams[k].trace ? 'trace' : 'poisson', k);
        if (sim.streams[k].bursts) consider(sim.streams[k].nextBurst, 'burst', k);
      }
    }
    consider(wakeUpTime(sim), 'wake', null);
    return ev;
  }

  function startIdle(sim) {
    var started = false;
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if (!inst.api && inst.stepEnd === null && startStep(sim, inst)) started = true;
    }
    return started;
  }

  // Advances the sim by dtMs (clamped to 50 ms), handling events in time order. Once every event
  // at the current time is handled, idle instances start a step, so a finished step's instance
  // starts its next one at the same moment and no time is lost between steps.
  function tick(sim, dtMs) {
    var start = sim.t, end = sim.t + (dtMs > MAX_TICK_MS ? MAX_TICK_MS : dtMs > 0 ? dtMs : 0);
    for (;;) {
      var ev = nextEvent(sim);
      if (ev.t > sim.t && startIdle(sim)) continue;
      if (ev.t > end) break;
      sim.t = Math.max(sim.t, ev.t);
      var s = ev.stream === null ? null : sim.streams[ev.stream];
      if (ev.kind === 'step') finishStep(sim, ev.inst);
      else if (ev.kind === 'api') apiTokens(sim, ev.inst);
      else if (ev.kind === 'pending') { sim.pending.shift(); arrive(sim, ev.stream); }
      else if (ev.kind === 'poisson') { arrive(sim, ev.stream); s.nextArrival = sim.t + poissonGap(sim, s); }
      else if (ev.kind === 'trace') arriveTrace(sim, ev.stream);
      else if (ev.kind === 'ready') serveReplacement(sim, ev.inst);
      else if (ev.kind === 'burst') { addBurst(sim, ev.stream); s.nextBurst = sim.t + burstGap(sim); }
      // a 'wake' needs nothing more: idle instances start on the next pass
    }
    sim.t = end;
    sim.stats.gpuMs += sim.gpuCount * (end - start);
  }

  // Switches the batching mode live and logs it in sim.events. To continuous: idle slots (already
  // finished and counted) leave, and the reservation gives way to the KV the sequences hold. To
  // request-level: the sequences running finish as a legacy batch that nothing joins, guarded by
  // preemption like in continuous mode, and the first batch forms once they're done.
  function setBatching(sim, mode) {
    if (mode === sim.batching) return;
    sim.batching = mode;
    sim.events.push({ t: sim.t, label: mode === 'request' ? 'request-level on' : 'continuous on' });
    if (mode !== 'continuous') return;
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if (inst.api) continue;   // no batches or KV
      inst.running = inst.running.filter(function (r) {
        if (r.state !== 'idle') return true;
        r.state = 'done';
        return false;
      });
      inst.batch = null;
      inst.kvReserved = 0;
      inst.kvUsed = kvUsedBytes(inst);
    }
  }

  // ---- Play state ----

  // Off stops steady arrivals and drops the arrival times still pending, and a trace's hour stands still
  // where it is; on schedules every stream's next arrival and burst from now. Work already queued or
  // running carries on.
  function setArrivals(sim, on) {
    if (on === sim.arrivalsOn) return;
    if (on && windowOver(sim)) return;   // the challenge's window is replayed: nothing is left to arrive
    sim.arrivalsOn = on;
    if (on) { schedule(sim); return; }
    sim.pending = [];
    for (var k = 0; k < sim.streams.length; k++) {
      var s = sim.streams[k];
      if (!s.trace) continue;
      s.pos += (sim.t - s.posT) * s.trace.speed;
      s.posT = sim.t;
      s.nextArrival = Infinity;
    }
  }

  // The sandbox's router policy, live: requests routed from now on use it
  function setRouter(sim, policy) {
    if (policy !== 'least' && policy !== 'round-robin') throw new Error('unknown router policy: ' + policy);
    if (policy === sim.router) return;
    sim.router = policy;
    sim.rrNext = {};
    sim.events.push({ t: sim.t, label: policy === 'least' ? 'least outstanding' : 'round-robin' });
  }

  // The sandbox terminal: one command line against the current settings. Returns { ok, message, settings (a
  // copy, changed), action, value }: action 'deploy' rebuilds the sim; 'batching', 'router' and 'autoscaler'
  // change it live; the rest ('kill', 'burst', 'pause', 'play', 'challenge', 'status', 'reset', 'clear',
  // 'help') are the page's to carry out. At most SANDBOX_MAX_SERVERS servers, so every box stays readable.
  var SANDBOX_MAX_SERVERS = 6;
  var MODEL_WORDS = { '8b': 'llama-3-8b', '3b': 'llama-3.2-3b', '1b': 'llama-3.2-1b' };
  var SANDBOX_HELP = [
    'gpus 1-3 · layout ' + Object.keys(SANDBOX_LAYOUTS).join('|') + ' · models 8b 3b 1b (one per slice)',
    'batching continuous|request · set gpu-mem 0.5-0.95 · set max-num-seqs 1-512',
    'traffic random|trace · rate 1-40 (req/s) · bursts on|off · lengths chat|long|short',
    'router least|round-robin · kill · autoscaler on|off · burst [n] · pause · play',
    'challenge · status · reset · clear · help'
  ].join('\n');
  function sandboxCommand(settings, line) {
    var w = String(line).trim().toLowerCase().split(/\s+/), cmd = w[0], arg = w[1], s = Object.assign({}, settings);
    s.models = settings.models.slice();
    var done = function (action, message, value) { return { ok: true, message: message, settings: s, action: action, value: value }; };
    var bad = function (message) { return { ok: false, message: message, settings: settings, action: null }; };
    var num = function (x, lo, hi) { var v = +x; return x !== undefined && isFinite(v) && v >= lo && v <= hi ? v : null; };
    var fits = function () {
      var n = s.gpus * SANDBOX_LAYOUTS[s.layout].length;
      return n <= SANDBOX_MAX_SERVERS ? null : bad(n + ' servers won\'t fit: at most ' + SANDBOX_MAX_SERVERS + ' servers (GPUs × slices)');
    };
    if (!cmd) return { ok: true, message: '', settings: settings, action: null };
    if (cmd === 'gpus') {
      if (num(arg, 1, 3) === null || Math.round(+arg) !== +arg) return bad('gpus takes 1, 2 or 3');
      s.gpus = +arg;
      return fits() || done('deploy', s.gpus + ' × H100');
    }
    if (cmd === 'layout') {
      if (!SANDBOX_LAYOUTS[arg]) return bad('layout takes ' + Object.keys(SANDBOX_LAYOUTS).join(', '));
      s.layout = arg;
      return fits() || done('deploy', arg === 'whole' ? 'a whole H100 per server' : arg === 'time-sliced' ? 'three processes time-sharing each H100' :
        'each H100 split ' + SANDBOX_LAYOUTS[arg].join(' + '));
    }
    if (cmd === 'models') {
      var ms = w.slice(1).map(function (x) { return MODEL_WORDS[x]; });
      if (!ms.length || ms.some(function (m) { return !m; })) return bad('models takes 8b, 3b or 1b, one per slice');
      s.models = ms;
      return done('deploy', ms.map(function (m) { return MODELS[m].label; }).join(', '));
    }
    if (cmd === 'batching') {
      if (arg !== 'continuous' && arg !== 'request') return bad('batching takes continuous or request');
      s.batching = arg;
      return done('batching', arg === 'request' ? 'request-level batching (Triton\'s dynamic batcher)' : 'continuous batching (vLLM)');
    }
    if (cmd === 'set') {
      var v = w[2];
      if (arg === 'gpu-mem') {
        if (num(v, 0.5, 0.95) === null) return bad('set gpu-mem takes 0.5 to 0.95');
        s.gpuMemUtil = +v;
        return done('deploy', '--gpu-memory-utilization ' + s.gpuMemUtil.toFixed(2));
      }
      if (arg === 'max-num-seqs') {
        if (num(v, 1, 512) === null || Math.round(+v) !== +v) return bad('set max-num-seqs takes 1 to 512');
        s.maxNumSeqs = +v;
        return done('deploy', '--max-num-seqs ' + s.maxNumSeqs);
      }
      return bad('set takes gpu-mem or max-num-seqs');
    }
    if (cmd === 'traffic') {
      if (arg !== 'random' && arg !== 'trace') return bad('traffic takes random or trace');
      s.traffic = arg;
      return done('deploy', arg === 'trace' ? 'the Azure hour, 12× faster, to the 8B (or the first model)' : 'random traffic');
    }
    if (cmd === 'rate') {
      if (num(arg, 1, 40) === null) return bad('rate takes 1 to 40 requests/s');
      s.rate = +arg;
      return done('deploy', s.rate + ' requests/s in all, split across the models');
    }
    if (cmd === 'bursts') {
      if (arg !== 'on' && arg !== 'off') return bad('bursts takes on or off');
      s.bursts = arg === 'on';
      return done('deploy', 'bursts ' + arg);
    }
    if (cmd === 'lengths') {
      if (arg !== 'chat' && arg !== 'long' && arg !== 'short') return bad('lengths takes chat, long or short');
      s.lengths = arg;
      return done('deploy', arg === 'chat' ? 'each model\'s own kind of request' : arg + ' prompts and replies');
    }
    if (cmd === 'router') {
      var policy = arg === 'least' ? 'least' : arg === 'round-robin' ? 'round-robin' : null;
      if (!policy) return bad('router takes least or round-robin');
      s.router = policy;
      return done('router', policy === 'least' ? 'least outstanding requests' : 'round-robin: each server in turn, however busy');
    }
    if (cmd === 'autoscaler') {
      if (arg !== 'on' && arg !== 'off') return bad('autoscaler takes on or off');
      s.autoscaler = arg === 'on';
      return done('autoscaler', 'autoscaler ' + arg);
    }
    if (cmd === 'burst') {
      var n = arg === undefined ? 24 : num(arg, 1, 200);
      if (n === null) return bad('burst takes 1 to 200');
      return done('burst', n + ' requests at once', Math.round(n));
    }
    if (cmd === 'help') return done('help', SANDBOX_HELP);
    if (['kill', 'pause', 'play', 'challenge', 'status', 'reset', 'clear'].indexOf(cmd) >= 0) return done(cmd, '');
    return bad('unknown command: ' + cmd + ' (type help)');
  }

  // The sandbox's cost meter: what the GPUs billed so far cost, plus any API spend (USD)
  function spentUsd(sim) { return GPU_HOUR_USD * sim.stats.gpuMs / 3.6e6 + sim.stats.apiUsd; }

  // ---- Following a request, and the config drawer ----

  // What the follow strip shows for r: its spans (the open one running to now), the time it spent in each
  // phase, and its TTFT, TPOT and total time so far
  function requestSummary(sim, r) {
    var end = r.tDone !== null ? r.tDone : r.state === 'rejected' && r.marks.length ? r.marks[r.marks.length - 1].t : sim.t;
    var by = { queue: 0, prefill: 0, decode: 0 };
    var spans = r.spans.map(function (s) {
      var t1 = s.t1 === null ? sim.t : s.t1;
      by[s.kind] += t1 - s.t0;
      return { kind: s.kind, t0: s.t0, t1: t1, inst: s.inst };
    });
    return {
      id: r.id, model: r.model, inst: r.inst, prompt: r.prompt, output: Math.min(r.output, sim.cfg.maxTokens), generated: r.generated,
      state: r.state === 'idle' ? 'done' : r.state, t0: r.t0, end: end, spans: spans, marks: r.marks.slice(), byKind: by,
      ttftMs: r.tFirst !== null ? r.tFirst - r.t0 : null,
      tpotMs: r.tFirst !== null && r.generated > 1 ? ((r.tDone !== null ? r.tDone : sim.t) - r.tFirst) / (r.generated - 1) : null,
      totalMs: end - r.t0
    };
  }

  // Hugging Face ids for the config drawer. The System1 model is modelled, a 1B-class classifier with Llama 3.2
  // 1B's numbers, not a known checkpoint, so it's served from a local path.
  var HF_IDS = {
    'llama-3-8b': 'meta-llama/Meta-Llama-3-8B-Instruct', 'llama-3.2-3b': 'meta-llama/Llama-3.2-3B-Instruct',
    'llama-3.2-1b': 'meta-llama/Llama-3.2-1B-Instruct', system1: '/models/system1'
  };

  // The config of the system being simulated, one block per server, for the config drawer:
  // { kind: 'router' | 'vllm' | 'triton' | 'api', title, lines: [{ text, key, comment? }] }. key names the
  // knob a line shows ('gpu-memory-utilization', 'batching', 'threshold', 'autoscaler', ...), so the page can
  // highlight the one the visitor last changed. Continuous batching is vLLM's; request-level batching is
  // Triton's dynamic batcher in front of a Python backend, since vLLM has no request-level mode.
  function serverConfig(sim) {
    var cfg = sim.cfg, blocks = [], counts = {};
    function line(text, key, comment) { return { text: text, key: key || null, comment: !!comment }; }
    sim.instances.forEach(function (inst) { if (!inst.api) counts[inst.model] = (counts[inst.model] || 0) + 1; });
    var replicas = Object.keys(counts).filter(function (m) { return counts[m] > 1; })[0];
    var servers = sim.instances.filter(function (inst) { return !inst.api; }).length;
    if (sim.routing) {
      var x = sim.routing.threshold;
      blocks.push({ kind: 'router', title: 'gateway · routes on the System1 score', lines: [
        line('router:'),
        line('  scorer: system1   # one token: a difficulty score'),
        line('  small: ' + sim.routing.small),
        line('  large: ' + sim.routing.large, 'large'),
        line('  threshold: ' + x.toFixed(2) + (x >= 1 ? '   # none → large' : '   # score ≥ ' + x.toFixed(2) + ' → large'), 'threshold')
      ] });
    } else if (servers > 1) {
      var rl = [line('router:'), line('  policy: ' + (sim.router === 'round-robin' ? 'round-robin' : 'least outstanding requests'), 'router')];
      if (replicas) {
        rl.push(line('  replicas: ' + counts[replicas]), line('  autoscaler: ' + (sim.autoscaler ? 'on' : 'off'), 'autoscaler'),
                line('  cold start: ' + COLD_START_MS / 1000 + ' s   # assumed'));
      }
      rl.push(line('  max queued per server: ' + cfg.queueCap + '   # then 503'));
      blocks.push({ kind: 'router', title: replicas ? 'load balancer · ' + counts[replicas] + ' replicas' : 'router · ' + servers + ' servers', lines: rl });
    }
    sim.instances.forEach(function (inst) {
      if (inst.api) {
        blocks.push({ kind: 'api', title: 'API model', lines: [
          line('# billed per token, nothing to deploy', null, true),
          line('# input $' + API.inputPer1M + ' / output $' + API.outputPer1M + ' per 1M tokens', null, true)
        ] });
        return;
      }
      var label = MODELS[inst.model].label, st = instanceStatus(sim, inst);
      if (!inst.fits) {
        blocks.push({ kind: 'unfit', title: (inst.profile === '7g.80gb' ? 'H100' : 'MIG ' + inst.profile) + ' · ' + label + " · doesn't fit", lines: [
          line("# won't start: " + MODELS[inst.model].weightsGB + ' GB of weights leave no room for a KV cache in ' + PROFILES[inst.profile].memGB +
               ' GB at --gpu-memory-utilization ' + inst.gpuMemUtil.toFixed(2), null, true),
          line('# so the router has nowhere to send its requests: they get 503s', null, true)
        ] });
        return;
      }
      var where = inst.profile !== '7g.80gb' ? 'MIG ' + inst.profile : inst.timeSliced ? 'H100 ' + (inst.gpu + 1) + ', time-sliced' :
        sim.instances.length > 1 ? 'H100 ' + (inst.gpu + 1) : 'H100';
      var title = where + ' · ' + label + (st.state === 'down' ? ' · failed' : st.state === 'starting' ? ' · starting' : '');
      if (sim.batching === 'request') {
        blocks.push({ kind: 'triton', title: title + ' · Triton, Python backend', lines: [
          line('# models/' + inst.model + '/config.pbtxt', null, true),
          line('name: "' + inst.model + '"'),
          line('backend: "python"   # model.py runs generate(), max_new_tokens ' + cfg.maxTokens),
          line('max_batch_size: ' + cfg.maxBatch, 'max-batch'),
          line('dynamic_batching {', 'batching'),
          line('  max_queue_delay_microseconds: ' + cfg.maxQueueDelayMs * 1000, 'batching'),
          line('}', 'batching'),
          line('instance_group [{ kind: KIND_GPU, count: 1 }]')
        ] });
        return;
      }
      var lines = [];
      if (inst.model === SYSTEM1) {
        lines.push(line('# a 1B-class classifier, sized like Llama 3.2 1B here; no public checkpoint', null, true));
        lines.push(line('# the gateway asks it for one token, the score', null, true));
      }
      blocks.push({ kind: 'vllm', title: title, lines: lines.concat([
        line('vllm serve ' + HF_IDS[inst.model] + ' \\', 'batching'),   // continuous batching is vLLM's own
        line('  --gpu-memory-utilization ' + inst.gpuMemUtil.toFixed(2) + ' \\', 'gpu-memory-utilization'),
        line('  --max-num-seqs ' + cfg.maxNumSeqs + ' \\', 'max-num-seqs'),
        line('  --max-num-batched-tokens ' + cfg.maxNumBatchedTokens + ' \\', 'max-num-batched-tokens'),
        line('  --max-model-len ' + inst.maxModelLen, 'max-model-len')
      ]) });
    });
    return blocks;
  }

  // Where tab 05's replay is in its hour: { ms, totalMs }, or null when no stream replays a trace
  function traceClock(sim) {
    for (var k = 0; k < sim.streams.length; k++) {
      var s = sim.streams[k];
      if (!s.trace) continue;
      var pos = s.pos + (sim.arrivalsOn ? (sim.t - s.posT) * s.trace.speed : 0);
      return { ms: pos % s.trace.durationMs, totalMs: s.trace.durationMs };
    }
    return null;
  }

  // n arrival times on stream (default 0) over the next BURST_SPREAD_MS, whether or not arrivals are on
  function sendBurst(sim, n, stream) {
    if (stream === undefined) stream = 0;
    if (!sim.streams[stream]) throw new Error('unknown stream: ' + stream);
    for (var k = 0; k < n; k++) sim.pending.push({ t: sim.t + sim.rng() * BURST_SPREAD_MS, stream: stream });
    sortPending(sim);
  }

  // Nothing more will happen: arrivals off, nothing pending, every queue and running list empty
  // (an idle slot of a request-level batch still sits in running, so it counts as in flight, as does a
  // request on an API instance)
  function isDrained(sim) {
    if (sim.arrivalsOn || sim.pending.length) return false;
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if (inst.queue.length || inst.running.length || (inst.readyAt !== null && inst.readyAt !== undefined)) return false;
    }
    return true;
  }

  // ---- Tab 06: failure and replacement ----

  // The GPUs being paid for: those with an instance up or starting (a dead one isn't billed)
  function countGpus(sim) {
    var gpus = {};
    sim.instances.forEach(function (inst) {
      if (!inst.api && (inst.up || inst.readyAt !== null)) gpus[inst.gpu] = true;
    });
    sim.gpuCount = Object.keys(gpus).length;
  }

  // A request whose GPU died goes back to the router as a client retry. Its KV died with the GPU, so it redoes
  // its prefill and its reply starts over. It keeps its arrival time: its TTFT is the user's wait for the answer
  // they finally get. A first token logged before the kill stays in the log, since the user saw it before the
  // stream broke.
  function retry(sim, r) {
    r.state = 'queued';
    r.kvTokens = 0;
    r.prefillTarget = r.prompt;
    r.prefillDone = 0;
    r.generated = 0;
    r.tFirst = null;
    phase(r, sim.t, null);
    r.marks.push({ t: sim.t, kind: 'retried' });
    r.inst = null;
    r.retries += 1;
    sim.stats.retried += 1;
    place(sim, r);
  }

  // Starts one replacement H100 in a dead GPU's place, for all its servers (MIG slices or time-sliced processes
  // come back together on the one new GPU): it's billed from now and serves after COLD_START_MS
  function startReplacement(sim, dead) {
    var gpu = sim.nextGpu++;
    dead.forEach(function (inst) { inst.deadGpu = inst.gpu; inst.gpu = gpu; inst.readyAt = sim.t + COLD_START_MS; });
    sim.events.push({ t: sim.t, label: 'H100 ' + (gpu + 1) + ' starting' });
    countGpus(sim);
  }

  function serveReplacement(sim, inst) {
    inst.readyAt = null;
    inst.deadGpu = null;
    inst.up = true;
    var still = sim.instances.some(function (o) { return o.gpu === inst.gpu && o.readyAt !== null && o.readyAt !== undefined; });
    if (!still) sim.events.push({ t: sim.t, label: 'H100 ' + (inst.gpu + 1) + ' up' });   // once its last server is up
    countGpus(sim);
  }

  // Kills the highest-numbered GPU that's up, while another GPU is up: every server on it stops (its step, its
  // KV), and their running then queued requests are retried through the router. Returns that GPU, or null when
  // only one GPU is up.
  function killGpu(sim) {
    var up = sim.instances.filter(function (inst) { return !inst.api && inst.up; }), g = -1, gpus = {};
    up.forEach(function (inst) { gpus[inst.gpu] = true; if (inst.gpu > g) g = inst.gpu; });
    if (Object.keys(gpus).length < 2) return null;   // MIG slices or time-sliced processes of one H100 are one GPU
    var dead = up.filter(function (inst) { return inst.gpu === g; }), reqs = [];
    dead.forEach(function (inst) {
      inst.running.forEach(function (r) { if (r.state === 'idle') r.state = 'done'; else reqs.push(r); });
      reqs = reqs.concat(inst.queue);
      Object.assign(inst, { up: false, running: [], queue: [], step: null, stepEnd: null, batch: null, kvUsed: 0, kvReserved: 0 });
    });
    sim.events.push({ t: sim.t, label: 'H100 ' + (g + 1) + ' killed' });
    countGpus(sim);
    reqs.forEach(function (r) { retry(sim, r); });
    if (sim.autoscaler) startReplacement(sim, dead);
    return g;
  }

  // On, a replacement starts for every dead instance; off, the ones still starting are called off
  function setAutoscaler(sim, on) {
    if (on === sim.autoscaler) return;
    sim.autoscaler = on;
    sim.events.push({ t: sim.t, label: on ? 'autoscaler on' : 'autoscaler off' });
    var byGpu = {};
    sim.instances.forEach(function (inst) {
      if (inst.api || inst.up) return;
      if (on && inst.readyAt === null) (byGpu[inst.gpu] = byGpu[inst.gpu] || []).push(inst);
      else if (!on && inst.readyAt !== null) { inst.gpu = inst.deadGpu; inst.deadGpu = null; inst.readyAt = null; }
    });
    Object.keys(byGpu).forEach(function (g) { startReplacement(sim, byGpu[g]); });   // one new H100 per dead one
    countGpus(sim);
  }

  // What the page draws for an instance: up, down (killed) or starting (a replacement, readyInMs from serving)
  function instanceStatus(sim, inst) {
    var starting = !inst.up && inst.readyAt !== null && inst.readyAt !== undefined;
    return {
      state: inst.up ? 'up' : starting ? 'starting' : 'down',
      gpu: inst.gpu,
      readyInMs: starting ? Math.max(0, inst.readyAt - sim.t) : null
    };
  }

  function playState(sim, frozen) {
    if (frozen) return 'stopped';
    if (sim.arrivalsOn) return 'running';
    return isDrained(sim) ? 'stopped' : 'draining';
  }

  // ---- Metrics ----

  // Nearest-rank percentile (p in 0..1) of an ascending list
  function nearestRank(sorted, p) {
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  }

  // TTFT is tFirst - t0 over the first tokens in the window: windowMs when given (at most TTFT_KEEP_MS),
  // else TTFT_WINDOW_MS. It takes at most the last TTFT_SAMPLES of them per TTFT_WINDOW_MS of window, so a
  // 120 s window takes up to 800. TPOT is the mean of (tDone - tFirst) / (generated - 1) over finished
  // requests whose first token is in that window. With a model, both cover only that model's requests,
  // and the sample cap counts only its first tokens.
  // Throughput is the output tokens made over the last TOKRATE_WINDOW_MS, per second. apiUsdPerHour is the API
  // spend over the last API_WINDOW_MS, per hour, and null without an API instance. Cost is per 1M output tokens,
  // blended: sim.gpuCount GPUs at GPU_HOUR_USD plus the API spend, over the throughput. Once drained,
  // throughput and API $/h are 0 (the page stops the sim's clock, so the windows would never age out) and cost
  // has no value; TTFT and TPOT keep their last values. Throughput, KV, API $/h and cost are always whole-sim;
  // KV counts only the GPU instances. Null means no data yet.
  // In tab 04, over the routing decisions of the last ROUTE_WINDOW_MS: smallShare is the share routed to the
  // small model, and misroutedShare the share of hard requests routed there. Both are null outside tab 04.
  function metrics(sim, model, windowMs) {
    var win = given(windowMs) ? Math.min(windowMs, TTFT_KEEP_MS) : TTFT_WINDOW_MS;
    var cap = Math.round(TTFT_SAMPLES * win / TTFT_WINDOW_MS);
    var ttfts = [], tokens = 0, tpotSum = 0, tpotN = 0, used = 0, budget = 0, usd = 0, usdRecent = 0, hasApi = false, k, r, e;
    var routed = 0, small = 0, hard = 0, misrouted = 0;
    for (k = sim.routeLog.length - 1; k >= 0; k--) {   // newest first; the log is in time order
      e = sim.routeLog[k];
      if (e[0] < sim.t - ROUTE_WINDOW_MS) break;
      routed += 1;
      if (e[1] === 'small') small += 1;
      if (e[2]) { hard += 1; if (e[1] === 'small') misrouted += 1; }
    }
    for (k = sim.ttftLog.length - 1; k >= 0 && ttfts.length < cap; k--) {   // newest first
      e = sim.ttftLog[k];
      if (e[0] < sim.t - win) break;   // the log is in time order
      if (!model || e[2] === model) ttfts.push(e[1]);
    }
    ttfts.sort(function (a, b) { return a - b; });
    for (k = 0; k < sim.finished.length; k++) {
      r = sim.finished[k];
      if ((!model || r.model === model) && r.tFirst >= sim.t - win && r.generated > 1) {
        tpotSum += (r.tDone - r.tFirst) / (r.generated - 1);
        tpotN += 1;
      }
    }
    for (k = 0; k < sim.tokLog.length; k++) {
      if (sim.tokLog[k][0] >= sim.t - TOKRATE_WINDOW_MS) tokens += sim.tokLog[k][1];
    }
    for (k = 0; k < sim.instances.length; k++) {
      if (sim.instances[k].api) { hasApi = true; continue; }   // no GPU memory
      if (!sim.instances[k].up) continue;   // tab 06: a dead GPU's memory is gone, and a starting one holds nothing yet
      used += sim.instances[k].kvUsed;
      budget += sim.instances[k].kvBudget;
    }
    for (k = 0; k < sim.apiLog.length; k++) {
      if (sim.apiLog[k][0] >= sim.t - API_WINDOW_MS) usd += sim.apiLog[k][1];
      if (sim.apiLog[k][0] >= sim.t - TOKRATE_WINDOW_MS) usdRecent += sim.apiLog[k][1];
    }
    var drained = isDrained(sim), tokPerSec = drained ? 0 : tokens / (TOKRATE_WINDOW_MS / 1000);
    var apiUsdPerHour = !hasApi ? null : drained ? 0 : usd / (API_WINDOW_MS / 1000) * 3600;
    // cost divides spend by tokens over the same 3 s, so the API's 30 s spend can't outlive the tokens it paid for
    var apiUsdPerSec = usdRecent / (TOKRATE_WINDOW_MS / 1000);
    return {
      ttftP50: ttfts.length ? nearestRank(ttfts, 0.5) : null,
      ttftP99: ttfts.length ? nearestRank(ttfts, 0.99) : null,
      tpotMs: tpotN ? tpotSum / tpotN : null,
      tokPerSec: tokPerSec,
      kvFrac: budget > 0 ? used / budget : null,
      costPer1M: tokPerSec > 0 ? (GPU_HOUR_USD * sim.gpuCount / 3600 + apiUsdPerSec) / tokPerSec * 1e6 : null,
      apiUsdPerHour: apiUsdPerHour,
      rejected: sim.stats.rejected,
      smallShare: routed ? small / routed : null,
      misroutedShare: hard ? misrouted / hard : null
    };
  }

  // Display strings; null (no data yet) shows as a dash
  var fmt = {
    ms: function (v) {
      if (v === null) return '\u2013';
      return v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(2) + 's';
    },
    tok: function (v) {
      if (v === null) return '\u2013';
      return String(Math.round(v)).replace(/\B(?=(\d{3})+$)/g, ',') + ' tok/s';
    },
    pct: function (v) { return v === null ? '\u2013' : Math.round(v * 100) + '%'; },
    usd: function (v) { return v === null ? '\u2013' : '$' + v.toFixed(2) + ' / 1M tok'; },
    // A latency target, without trailing zeros: 2000 is '2s', 500 is '500ms'
    slo: function (v) { return v < 1000 ? Math.round(v) + 'ms' : +(v / 1000).toFixed(2) + 's'; },
    // A latency as a screen reader says it: '1.84 s', '85 ms'
    spoken: function (v) {
      if (v === null) return 'not measured yet';
      return v < 1000 ? Math.round(v) + ' ms' : +(v / 1000).toFixed(2) + ' s';
    }
  };

  // An instance from its spec { profile, model, gpu?, gpuMemUtil? }: gpu is the physical GPU it runs
  // on (default 0; none for an API instance), and its own gpuMemUtil, when given, takes the place of the sim's
  function specInstance(spec, cfg) {
    var config = cfg;
    if (given(spec.gpuMemUtil)) {
      config = {};
      for (var key in cfg) config[key] = cfg[key];
      config.gpuMemUtil = spec.gpuMemUtil;
    }
    var inst = createInstance(spec.profile, spec.model, config);
    if (!inst.api) inst.gpu = given(spec.gpu) ? spec.gpu : 0;
    return inst;
  }

  // Tab 04's routing settings, copied so setThreshold leaves the preset alone: { small, large (model names),
  // threshold, hardCut (the difficulty from which a request is hard), noise (the score's Gaussian sigma) }
  function routingOf(spec) {
    if (!spec) return null;
    checkModel(spec.small);
    checkModel(spec.large);
    return { small: spec.small, large: spec.large, threshold: spec.threshold, hardCut: spec.hardCut, noise: spec.noise };
  }

  // opts = { seed, instances: [{ profile, model, gpu?, gpuMemUtil? }], batching, config?, slo?, routing?, and
  // streams: [{ model, rate (req/s), bursts, lengths? }] or PR 1's traffic: { rate, bursts, lengths? },
  // one stream for instances[0].model }. sim.gpuCount is the number of distinct physical GPUs, which an API
  // instance isn't. sim.routing is null without routing settings, that is outside tab 04.
  function createSim(opts) {
    var cfg = {}, gpus = {};
    for (var key in DEFAULTS) cfg[key] = pick(opts.config, key);
    var instances = opts.instances.map(function (spec) { return specInstance(spec, cfg); });
    var streams = opts.streams || (opts.traffic && [{ model: instances[0].model, rate: opts.traffic.rate,
                                                       bursts: opts.traffic.bursts, lengths: opts.traffic.lengths }]);
    if (!streams) throw new Error('createSim needs streams or traffic');
    instances.forEach(function (inst) {
      if (!inst.api) gpus[inst.gpu] = true;
      // A whole GPU (no MIG) shared with another instance is time-sliced
      inst.timeSliced = inst.profile === '7g.80gb' && instances.some(function (o) { return o !== inst && o.gpu === inst.gpu; });
    });
    var sim = {
      t: 0,
      rng: mulberry32(opts.seed),
      cfg: cfg,
      batching: opts.batching || 'continuous',
      instances: instances,
      streams: streams.map(function (spec) { return createStream(spec); }),
      slo: opts.slo || null,
      routing: routingOf(opts.routing),
      gpuCount: Object.keys(gpus).length,
      nextGpu: Object.keys(gpus).reduce(function (n, g) { return Math.max(n, +g + 1); }, 0),   // tab 06: a replacement's GPU id
      autoscaler: !!opts.autoscaler,
      router: opts.router === 'round-robin' ? 'round-robin' : 'least',   // the sandbox's router policy
      rrNext: {},                                                          // round-robin: the next server, per model
      arrivalsOn: true,
      pending: [],     // { t, stream }, earliest first
      events: [],
      finished: [],
      // routedSmall and routedLarge count the gateway's decisions; misrouted, the hard requests sent small;
      // apiUsd, the API model's spend in USD
      // gpuMs: GPU-milliseconds billed (sim.gpuCount over time), outputTokens: every answer token made; the
      // sandbox's cost meter and the SLO challenge's cost per 1M tokens add them up
      stats: { arrived: 0, finished: 0, rejected: 0, preemptions: 0, routedSmall: 0, routedLarge: 0, misrouted: 0, apiUsd: 0, retried: 0, gpuMs: 0, outputTokens: 0 },
      tokLog: [],      // [time, tokens made in a step]
      ttftLog: [],     // [time of a first token, its TTFT, its model]
      routeLog: [],    // [time scored, target ('small' or 'large'), whether hard], over the last ROUTE_WINDOW_MS
      apiLog: []       // [time, API spend in USD], over the last API_WINDOW_MS
    };
    schedule(sim);
    return sim;
  }

  var engine = {
    PROFILES: PROFILES,
    MODELS: MODELS,
    GPU: GPU,
    DEFAULTS: DEFAULTS,
    PRESETS: PRESETS,
    createInstance: createInstance,
    stepTimeMs: stepTimeMs,
    createSim: createSim,
    tick: tick,
    route: route,
    canAdmit: canAdmit,
    prefillProgress: prefillProgress,
    slotSteps: slotSteps,
    stretchNow: stretchNow,
    enqueue: enqueue,
    setBatching: setBatching,
    setThreshold: setThreshold,
    setArrivals: setArrivals,
    sendBurst: sendBurst,
    traceClock: traceClock,
    killGpu: killGpu,
    challengeDone: challengeDone,
    requestSummary: requestSummary,
    sandboxPreset: sandboxPreset,
    sandboxCommand: sandboxCommand,
    setRouter: setRouter,
    SANDBOX_MAX_SERVERS: SANDBOX_MAX_SERVERS,
    challengePreset: challengePreset,
    spentUsd: spentUsd,
    SANDBOX_DEFAULTS: SANDBOX_DEFAULTS,
    SANDBOX_LAYOUTS: SANDBOX_LAYOUTS,
    CHALLENGE: CHALLENGE,
    serverConfig: serverConfig,
    setAutoscaler: setAutoscaler,
    instanceStatus: instanceStatus,
    COLD_START_MS: COLD_START_MS,
    COLD_START_NOTE: COLD_START_NOTE,
    FAILURE_RATE: FAILURE_RATE,
    tracePreset: tracePreset,
    TRACE_FIT: TRACE_FIT,
    TRACE_RATE: TRACE_RATE,
    TRACE_START_MS: TRACE_START_MS,
    isDrained: isDrained,
    playState: playState,
    metrics: metrics,
    fmt: fmt,
    GPU_HOUR_USD: GPU_HOUR_USD,
    GPU_HOUR_SOURCE: GPU_HOUR_SOURCE,
    API: API,
    API_SOURCE: API_SOURCE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
  else root.SimEngine = engine;
})(typeof window !== 'undefined' ? window : this);
