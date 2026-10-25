// Inference simulator engine: a token-level model of an LLM serving engine on
// one H100, optionally split into MIG slices. It is a model, not a benchmark:
// step times come from a simple roofline (compute-bound vs memory-bound) and
// are meant to show the shape of the trade-offs, not predict real throughput.
// Pinned numbers: NVIDIA H100 SXM datasheet (989 TFLOPS dense BF16, 3.35 TB/s,
// 80 GB) and the Llama 3 8B config (8.03e9 params, 32 layers, 8 KV heads,
// head dim 128, so 131072 bytes of BF16 KV per token). GB means 1e9 bytes.
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

  // contextLen: the model's context window (Llama 3: 8192 tokens)
  var MODELS = {
    'llama-3-8b': { label: 'Llama 3 8B', params: 8.03e9, weightsGB: 16.06, kvBytesPerToken: 131072, contextLen: 8192 }
  };

  var GPU = { tflops: 989, tbps: 3.35, mfu: 0.5, mbu: 0.8, stepOverheadMs: 1.5 };

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

  var PRESETS = {
    batching: { instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 6, bursts: true } }
  };

  // Lognormal stand-ins for the Azure LLM conversation trace (Patel et al., Splitwise,
  // ISCA 2024: median prompt 1020 tokens, median output 129). PR 3 refits these from the real trace.
  var LENGTHS = {
    prompt: { median: 1020, sigma: 0.8, min: 16, max: 7000 },
    output: { median: 129, sigma: 0.93, min: 1, max: 1000 }
  };

  var MAX_TICK_MS = 50;      // a background tab coming back must not replay minutes at once
  var TOKLOG_KEEP_MS = 10000; // the token log only feeds recent-throughput metrics

  var nextId = 1;

  function pick(config, key) {
    return config && config[key] !== undefined ? config[key] : DEFAULTS[key];
  }

  function createInstance(profile, model, config) {
    var p = PROFILES[profile], m = MODELS[model];
    var usableGB = p.memGB * pick(config, 'gpuMemUtil') - m.weightsGB - pick(config, 'activationReserveGB');
    var kvBudget = Math.max(0, usableGB) * 1e9;
    return {
      id: nextId++,
      profile: profile,
      model: model,
      fits: kvBudget > 0,
      kvBudget: kvBudget,
      // Like vLLM's max-model-len: a request longer than this is refused, so any one
      // admitted sequence fits the KV pool on its own and preemption always terminates
      maxModelLen: Math.min(m.contextLen, Math.floor(kvBudget / m.kvBytesPerToken)),
      kvUsed: 0,
      queue: [],
      running: [],
      stepEnd: null,
      step: null,
      up: true
    };
  }

  // One engine step: the slower of the compute time and the memory time, plus fixed overhead
  function stepTimeMs(profile, model, prefillTokens, decodeSeqs, kvTokensRead) {
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

  // Poisson arrivals have exponential gaps; a rate of 0 means no steady arrivals
  function poissonGap(sim) {
    return sim.traffic.rate > 0 ? -Math.log(1 - sim.rng()) / sim.traffic.rate * 1000 : Infinity;
  }

  function burstGap(sim) {
    return 8000 + sim.rng() * 4000;
  }

  // A burst: 30-40 arrival times spread over the next second
  function addBurst(sim) {
    var n = 30 + Math.floor(sim.rng() * 11);
    for (var k = 0; k < n; k++) sim.pending.push(sim.t + sim.rng() * 1000);
    sim.pending.sort(function (a, b) { return a - b; });
  }

  function arrive(sim) {
    enqueue(sim, { prompt: sampleLength(sim.rng, LENGTHS.prompt), output: sampleLength(sim.rng, LENGTHS.output) });
  }

  // ---- Router ----

  function outstanding(inst) {
    return inst.queue.length + inst.running.length;
  }

  // Least outstanding requests among the instances that are up and fit the model, lowest index on ties
  function route(sim) {
    var best = null;
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if (inst.up && inst.fits && (!best || outstanding(inst) < outstanding(best))) best = inst;
    }
    return best;
  }

  // A request arrives now. It's routed at once, or rejected (a 503, or vLLM's refusal of a
  // request longer than max-model-len) when it has nowhere to go. inst is an index into sim.instances.
  function enqueue(sim, spec) {
    sim.stats.arrived += 1;
    var r = {
      id: sim.stats.arrived, t0: sim.t, prompt: spec.prompt, output: spec.output, inst: null, state: 'queued',
      prefillTarget: spec.prompt, prefillDone: 0, generated: 0, kvTokens: 0,
      tAdmit: null, tFirst: null, tDone: null, preemptions: 0
    };
    var inst = route(sim);
    if (!inst || inst.queue.length >= sim.cfg.queueCap || spec.prompt + sim.cfg.maxTokens > inst.maxModelLen) {
      r.state = 'rejected';
      sim.stats.rejected += 1;
      return r;
    }
    r.inst = sim.instances.indexOf(inst);
    inst.queue.push(r);
    return r;
  }

  // ---- KV accounting ----

  // The KV bytes an instance holds. inst.kvUsed is only ever set from this.
  function kvUsedBytes(inst) {
    var tokens = 0;
    for (var k = 0; k < inst.running.length; k++) tokens += inst.running[k].kvTokens;
    return tokens * MODELS[inst.model].kvBytesPerToken;
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
  function planContinuous(sim, inst) {
    var cfg = sim.cfg, kv = MODELS[inst.model].kvBytesPerToken;
    var items = [], tokens = cfg.maxNumBatchedTokens, grow = 0;
    function fits(add) { return inst.kvUsed + (grow + add) * kv <= inst.kvBudget; }
    function take(r, chunk, add) { items.push({ req: r, chunk: chunk }); tokens -= chunk || 1; grow += add; }

    for (var k = 0; k < inst.running.length; k++) {
      var r = inst.running[k], left = r.prefillTarget - r.prefillDone, chunk = 0, add = 1;
      if (left > 0) {
        chunk = Math.min(left, tokens);
        if (chunk <= 0) continue;              // the token budget is spent; it waits a step
        add = chunk + (chunk === left ? 1 : 0);
      }
      while (!fits(add) && inst.running.length > k) preemptNewest(sim, inst);
      if (inst.running.length > k) take(r, chunk, add);   // else r was the newest and is preempted
    }

    while (inst.queue.length && inst.running.length < cfg.maxNumSeqs && tokens > 0) {
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

  // Starts a step at sim.t if the instance has work. Returns whether it did.
  function startStep(sim, inst) {
    var items = planContinuous(sim, inst);
    if (!items.length) return false;
    var prefill = 0, decode = 0, kvRead = 0;
    for (var k = 0; k < items.length; k++) {
      if (items[k].chunk) prefill += items[k].chunk;
      else decode += 1;
      kvRead += items[k].req.kvTokens;
    }
    inst.step = { start: sim.t, items: items };
    inst.stepEnd = sim.t + stepTimeMs(inst.profile, inst.model, prefill, decode, kvRead);
    return true;
  }

  function finishStep(sim, inst) {
    var t = inst.stepEnd, items = inst.step.items, made = 0, k, r;
    for (k = 0; k < items.length; k++) {
      r = items[k].req;
      if (items[k].chunk) {
        r.prefillDone += items[k].chunk;
        r.kvTokens += items[k].chunk;
        if (r.prefillDone < r.prefillTarget) continue;   // more chunks to go
      }
      r.generated += 1;                                  // a decode token, or the first token after prefill
      r.kvTokens += 1;
      if (r.tFirst === null) r.tFirst = t;
      made += 1;
    }
    // A sequence ends at its own length (its stop token) or at max_tokens
    for (k = inst.running.length - 1; k >= 0; k--) {
      r = inst.running[k];
      if (r.generated < Math.min(r.output, sim.cfg.maxTokens)) continue;
      inst.running.splice(k, 1);
      r.state = 'done';
      r.tDone = t;
      r.kvTokens = 0;
      sim.finished.push(r);
      sim.stats.finished += 1;
    }
    if (made) {
      sim.tokLog.push([t, made]);
      while (sim.tokLog[0][0] < t - TOKLOG_KEEP_MS) sim.tokLog.shift();
    }
    inst.kvUsed = kvUsedBytes(inst);
    inst.step = null;
    inst.stepEnd = null;
  }

  // ---- Event loop ----

  // Wake-up times besides arrivals and step ends: Infinity, or a time after sim.t. Request-level
  // batching will add its max-queue-delay timeout here; continuous batching needs none.
  function wakeUpTime(sim) {
    return Infinity;
  }

  // The earliest event. Step completions win ties, so the router sees the slots they free.
  function nextEvent(sim) {
    var ev = { t: Infinity, kind: null, inst: null };
    function consider(t, kind) { if (t < ev.t) { ev.t = t; ev.kind = kind; } }
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if (inst.stepEnd !== null && inst.stepEnd < ev.t) { consider(inst.stepEnd, 'step'); ev.inst = inst; }
    }
    if (sim.pending.length) consider(sim.pending[0], 'pending');
    if (sim.arrivalsOn) {
      consider(sim.nextArrival, 'poisson');
      if (sim.traffic.bursts) consider(sim.nextBurst, 'burst');
    }
    consider(wakeUpTime(sim), 'wake');
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
      if (ev.kind === 'step') finishStep(sim, ev.inst);
      else if (ev.kind === 'pending') { sim.pending.shift(); arrive(sim); }
      else if (ev.kind === 'poisson') { arrive(sim); sim.nextArrival = sim.t + poissonGap(sim); }
      else if (ev.kind === 'burst') { addBurst(sim); sim.nextBurst = sim.t + burstGap(sim); }
      // a 'wake' needs nothing more: idle instances start on the next pass
    }
    sim.t = end;
  }

  // opts = { seed, instances: [{ profile, model }], batching, traffic: { rate (req/s), bursts }, config? }
  function createSim(opts) {
    var cfg = {};
    for (var key in DEFAULTS) cfg[key] = pick(opts.config, key);
    var sim = {
      t: 0,
      rng: mulberry32(opts.seed),
      cfg: cfg,
      batching: opts.batching || 'continuous',
      traffic: { rate: opts.traffic.rate, bursts: !!opts.traffic.bursts },
      instances: opts.instances.map(function (spec) { return createInstance(spec.profile, spec.model, cfg); }),
      arrivalsOn: true,
      pending: [],
      events: [],
      finished: [],
      stats: { arrived: 0, finished: 0, rejected: 0, preemptions: 0 },
      tokLog: [],
      nextArrival: Infinity,
      nextBurst: Infinity
    };
    sim.nextArrival = poissonGap(sim);
    sim.nextBurst = burstGap(sim);
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
    enqueue: enqueue
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SimEngine = api;
})(typeof window !== 'undefined' ? window : this);
