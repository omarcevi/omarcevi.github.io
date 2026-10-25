// Inference simulator engine: a token-level model of LLM serving engines on
// one or more H100s, each optionally split into MIG slices. It is a model, not a benchmark:
// step times come from a simple roofline (compute-bound vs memory-bound) and
// are meant to show the shape of the trade-offs, not predict real throughput.
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
    'llama-3.2-1b': { label: 'Llama 3.2 1B', short: '1B', params: 1.24e9, weightsGB: 2.47, kvBytesPerToken: 32768, contextLen: 131072 }
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
  // ISCA 2024: median prompt 1020 tokens, median output 129). PR 3 refits these from the real trace.
  var LENGTHS = {
    prompt: { median: 1020, sigma: 0.8, min: 16, max: 7000 },
    output: { median: 129, sigma: 0.93, min: 1, max: 1000 }
  };

  // Synthetic lengths for tab 02: long prompts and long replies, so the KV pool fills.
  // Tuned on seeds 1-10 (tests/sim.test.mjs): a burst of 35-40 such requests needs roughly the
  // 0.9 pool (~19 GB, ~145k tokens), fits the 0.95 pool (~21 GB) with little preemption, and
  // overflows the 0.5 pool (~3 GB, ~22k tokens) many times over. Bursts dominate the load.
  var LONG = {
    prompt: { median: 1100, sigma: 0.5, min: 256, max: 6000 },
    output: { median: 450, sigma: 0.2, min: 64, max: 1000 }
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
  // The 3B and 1B rates and the 1B's prompt length are tuned so that, at 120 s on seeds 1-5
  // (tests/sim.test.mjs), GPU per model and MIG meet every SLO, and time-slicing's median p99 is above
  // MIG's for every model and above the 8B's SLO. The 8B's bursts (6-10 requests) are sized so MIG's
  // 8B box, coloured on a 30 s p99 as on the page, stays green with no manual burst: red 0% of the time
  // on seeds 1-60 (8 s warm-up, then 120 s). Bursts of 10-16 left it red 4.6% of the time, and bursts
  // of 6-12 on 2 of 60 seeds. A manual burst of 24 still turns it red for about 30 s, since a 3g slice
  // has less headroom than a whole GPU. Time-slicing loses because CTX_SWITCH_LOSS leaves each of three
  // busy processes 0.7 / 3 of the GPU, less than a 2g.20gb slice gets, and well under the 8B's 3g.40gb.
  function tab03(instances) {
    return {
      instances: instances,
      batching: 'continuous',
      slo: { 'llama-3-8b': 2000, 'llama-3.2-3b': 500, 'llama-3.2-1b': 300 },
      streams: [
        { model: 'llama-3-8b', rate: 1.5, bursts: { min: 6, max: 10 }, lengths: LENGTHS },
        { model: 'llama-3.2-3b', rate: 8, bursts: false, lengths: SHORT },
        { model: 'llama-3.2-1b', rate: 25, bursts: false, lengths: TINY }
      ]
    };
  }

  var PRESETS = {
    batching: { instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 6, bursts: true } },
    kvcache: { instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 0.5, bursts: { min: 35, max: 40 }, lengths: LONG } },
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
    ])
  };

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
    lookup(profile, model);
    var p = PROFILES[profile], m = MODELS[model];
    var usableGB = p.memGB * pick(config, 'gpuMemUtil') - m.weightsGB - pick(config, 'activationReserveGB');
    var kvBudget = Math.max(0, usableGB) * 1e9;
    return {
      id: nextId++,
      profile: profile,
      model: model,
      gpu: 0,              // the physical GPU it runs on; createSim sets it from the spec
      timeSliced: false,   // whether it time-slices a whole GPU with other processes; createSim sets it
      fits: kvBudget > 0,
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
      up: true
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

  function sampleLength(rng, d) {
    var z = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());   // Box-Muller
    return Math.min(d.max, Math.max(d.min, Math.round(d.median * Math.exp(d.sigma * z))));
  }

  // A traffic stream from its spec { model, rate (req/s), bursts, lengths? }. bursts is true (BURSTS),
  // { min, max } (the count range) or false; lengths defaults to LENGTHS.
  function createStream(spec) {
    checkModel(spec.model);
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
    var best = null;
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if ((!model || inst.model === model) && canTake(sim, inst, prompt) &&
          (!best || outstanding(inst) < outstanding(best))) best = inst;
    }
    return best;
  }

  // A request arrives now. It's routed at once, or rejected when no instance can take it.
  // spec = { prompt, output, model?, stream? }: without a model any instance may serve it, and it
  // takes that instance's model. inst is an index into sim.instances; stream is the index into
  // sim.streams it came from, null when enqueued directly.
  function enqueue(sim, spec) {
    if (spec.model) checkModel(spec.model);
    sim.stats.arrived += 1;
    var r = {
      id: sim.stats.arrived, t0: sim.t, prompt: spec.prompt, output: spec.output,
      model: spec.model || null, stream: spec.stream === undefined ? null : spec.stream, inst: null, state: 'queued',
      prefillTarget: spec.prompt, prefillDone: 0, generated: 0, kvTokens: 0,
      tAdmit: null, tFirst: null, tDone: null, preemptions: 0
    };
    var inst = route(sim, spec.prompt, spec.model);
    if (!inst) {
      r.state = 'rejected';
      sim.stats.rejected += 1;
      return r;
    }
    r.inst = sim.instances.indexOf(inst);
    r.model = inst.model;
    inst.queue.push(r);
    return r;
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
      inst.running.push(q);
      take(q, qChunk, qAdd);
    }
    return items;
  }

  // Whether a request arriving now would start at once: continuous mode, nothing queued ahead of it,
  // a free max-num-seqs slot and some KV left
  function canAdmit(sim, inst) {
    return sim.batching === 'continuous' && inst.queue.length === 0 &&
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

  // Keeps a log of [time, value] entries to its last keepMs and its last maxLen entries
  function trimLog(log, t, keepMs, maxLen) {
    while (log.length && (log.length > maxLen || log[0][0] < t - keepMs)) log.shift();
  }

  // A sequence that reaches its length is finished and counted right then, exactly once. In a
  // request-level batch it then stays as an idle slot, and the batch ends when every slot is idle.
  function finishStep(sim, inst) {
    var t = inst.stepEnd, items = inst.step.items, made = 0, idle = 0, k, r;
    for (k = 0; k < items.length; k++) {
      r = items[k].req;
      if (items[k].chunk) {
        r.prefillDone += items[k].chunk;
        r.kvTokens += items[k].chunk;
        if (r.prefillDone < r.prefillTarget) continue;   // more chunks to go
      }
      r.generated += 1;                                  // a decode token, or the first token after prefill
      r.kvTokens += 1;
      if (r.tFirst === null) {
        r.tFirst = t;
        sim.ttftLog.push([t, t - r.t0, r.model]);
      }
      made += 1;
    }
    if (inst.batch) inst.batch.steps += 1;
    // A sequence ends at its own length (its stop token) or at max_tokens
    for (k = inst.running.length - 1; k >= 0; k--) {
      r = inst.running[k];
      if (r.state === 'running' && r.generated >= Math.min(r.output, sim.cfg.maxTokens)) {
        r.tDone = t;
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
    trimLog(sim.tokLog, t, TOKLOG_KEEP_MS, Infinity);
    trimLog(sim.ttftLog, t, TTFT_KEEP_MS, Infinity);   // metrics takes its window and sample cap, per model
    inst.kvUsed = kvUsedBytes(inst);
    inst.step = null;
    inst.stepEnd = null;
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

  // The earliest event. Step completions win ties, so the router sees the slots they free. An
  // arrival or burst event carries the index of its stream.
  function nextEvent(sim) {
    var ev = { t: Infinity, kind: null, inst: null, stream: null }, k;
    function consider(t, kind, stream) { if (t < ev.t) { ev.t = t; ev.kind = kind; ev.stream = stream; } }
    for (k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if (inst.stepEnd !== null && inst.stepEnd < ev.t) { consider(inst.stepEnd, 'step', null); ev.inst = inst; }
    }
    if (sim.pending.length) consider(sim.pending[0].t, 'pending', sim.pending[0].stream);
    if (sim.arrivalsOn) {
      for (k = 0; k < sim.streams.length; k++) {
        consider(sim.streams[k].nextArrival, 'poisson', k);
        if (sim.streams[k].bursts) consider(sim.streams[k].nextBurst, 'burst', k);
      }
    }
    consider(wakeUpTime(sim), 'wake', null);
    return ev;
  }

  function startIdle(sim) {
    var started = false;
    for (var k = 0; k < sim.instances.length; k++) {
      if (sim.instances[k].stepEnd === null && startStep(sim, sim.instances[k])) started = true;
    }
    return started;
  }

  // Advances the sim by dtMs (clamped to 50 ms), handling events in time order. Once every event
  // at the current time is handled, idle instances start a step, so a finished step's instance
  // starts its next one at the same moment and no time is lost between steps.
  function tick(sim, dtMs) {
    var end = sim.t + (dtMs > MAX_TICK_MS ? MAX_TICK_MS : dtMs > 0 ? dtMs : 0);
    for (;;) {
      var ev = nextEvent(sim);
      if (ev.t > sim.t && startIdle(sim)) continue;
      if (ev.t > end) break;
      sim.t = Math.max(sim.t, ev.t);
      var s = ev.stream === null ? null : sim.streams[ev.stream];
      if (ev.kind === 'step') finishStep(sim, ev.inst);
      else if (ev.kind === 'pending') { sim.pending.shift(); arrive(sim, ev.stream); }
      else if (ev.kind === 'poisson') { arrive(sim, ev.stream); s.nextArrival = sim.t + poissonGap(sim, s); }
      else if (ev.kind === 'burst') { addBurst(sim, ev.stream); s.nextBurst = sim.t + burstGap(sim); }
      // a 'wake' needs nothing more: idle instances start on the next pass
    }
    sim.t = end;
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

  // Off stops steady arrivals and drops the arrival times still pending; on schedules every stream's
  // next arrival and burst from now. Work already queued or running carries on.
  function setArrivals(sim, on) {
    if (on === sim.arrivalsOn) return;
    sim.arrivalsOn = on;
    if (on) schedule(sim);
    else sim.pending = [];
  }

  // n arrival times on stream (default 0) over the next BURST_SPREAD_MS, whether or not arrivals are on
  function sendBurst(sim, n, stream) {
    if (stream === undefined) stream = 0;
    if (!sim.streams[stream]) throw new Error('unknown stream: ' + stream);
    for (var k = 0; k < n; k++) sim.pending.push({ t: sim.t + sim.rng() * BURST_SPREAD_MS, stream: stream });
    sortPending(sim);
  }

  // Nothing more will happen: arrivals off, nothing pending, every queue and running list empty
  // (an idle slot of a request-level batch still sits in running, so it counts as in flight)
  function isDrained(sim) {
    if (sim.arrivalsOn || sim.pending.length) return false;
    for (var k = 0; k < sim.instances.length; k++) {
      if (sim.instances[k].queue.length || sim.instances[k].running.length) return false;
    }
    return true;
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
  // Throughput is the output tokens made over the last TOKRATE_WINDOW_MS, per second, and cost is per
  // 1M of them at sim.gpuCount GPUs. Once drained it's 0 (the page stops the sim's clock, so the window
  // would never age out) and cost has no value; TTFT and TPOT keep their last values. Throughput, KV
  // and cost are always whole-sim. Null means no data yet.
  function metrics(sim, model, windowMs) {
    var win = given(windowMs) ? Math.min(windowMs, TTFT_KEEP_MS) : TTFT_WINDOW_MS;
    var cap = Math.round(TTFT_SAMPLES * win / TTFT_WINDOW_MS);
    var ttfts = [], tokens = 0, tpotSum = 0, tpotN = 0, used = 0, budget = 0, k, r, e;
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
      used += sim.instances[k].kvUsed;
      budget += sim.instances[k].kvBudget;
    }
    var tokPerSec = isDrained(sim) ? 0 : tokens / (TOKRATE_WINDOW_MS / 1000);
    return {
      ttftP50: ttfts.length ? nearestRank(ttfts, 0.5) : null,
      ttftP99: ttfts.length ? nearestRank(ttfts, 0.99) : null,
      tpotMs: tpotN ? tpotSum / tpotN : null,
      tokPerSec: tokPerSec,
      kvFrac: budget > 0 ? used / budget : null,
      costPer1M: tokPerSec > 0 ? GPU_HOUR_USD * sim.gpuCount / 3600 / tokPerSec * 1e6 : null,
      rejected: sim.stats.rejected
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
    usd: function (v) { return v === null ? '\u2013' : '$' + v.toFixed(2) + ' / 1M tok'; }
  };

  // An instance from its spec { profile, model, gpu?, gpuMemUtil? }: gpu is the physical GPU it runs
  // on (default 0), and its own gpuMemUtil, when given, takes the place of the sim's
  function specInstance(spec, cfg) {
    var config = cfg;
    if (given(spec.gpuMemUtil)) {
      config = {};
      for (var key in cfg) config[key] = cfg[key];
      config.gpuMemUtil = spec.gpuMemUtil;
    }
    var inst = createInstance(spec.profile, spec.model, config);
    inst.gpu = given(spec.gpu) ? spec.gpu : 0;
    return inst;
  }

  // opts = { seed, instances: [{ profile, model, gpu?, gpuMemUtil? }], batching, config?, slo?, and
  // streams: [{ model, rate (req/s), bursts, lengths? }] or PR 1's traffic: { rate, bursts, lengths? },
  // one stream for instances[0].model }. sim.gpuCount is the number of distinct physical GPUs.
  function createSim(opts) {
    var cfg = {}, gpus = {};
    for (var key in DEFAULTS) cfg[key] = pick(opts.config, key);
    var instances = opts.instances.map(function (spec) { return specInstance(spec, cfg); });
    var streams = opts.streams || (opts.traffic && [{ model: instances[0].model, rate: opts.traffic.rate,
                                                       bursts: opts.traffic.bursts, lengths: opts.traffic.lengths }]);
    if (!streams) throw new Error('createSim needs streams or traffic');
    instances.forEach(function (inst) {
      gpus[inst.gpu] = true;
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
      gpuCount: Object.keys(gpus).length,
      arrivalsOn: true,
      pending: [],     // { t, stream }, earliest first
      events: [],
      finished: [],
      stats: { arrived: 0, finished: 0, rejected: 0, preemptions: 0 },
      tokLog: [],      // [time, tokens made in a step]
      ttftLog: []      // [time of a first token, its TTFT, its model]
    };
    schedule(sim);
    return sim;
  }

  var api = {
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
    enqueue: enqueue,
    setBatching: setBatching,
    setArrivals: setArrivals,
    sendBurst: sendBurst,
    isDrained: isDrained,
    playState: playState,
    metrics: metrics,
    fmt: fmt,
    GPU_HOUR_USD: GPU_HOUR_USD,
    GPU_HOUR_SOURCE: GPU_HOUR_SOURCE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SimEngine = api;
})(typeof window !== 'undefined' ? window : this);
