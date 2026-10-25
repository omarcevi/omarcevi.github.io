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

  var MAX_TICK_MS = 50;         // a background tab coming back must not replay minutes at once
  var TOKLOG_KEEP_MS = 10000;   // the token log only feeds recent-throughput metrics
  var TOKRATE_WINDOW_MS = 3000; // throughput is the tokens made over the last 3 s
  var TTFT_WINDOW_MS = 30000;   // TTFT percentiles cover first tokens from the last 30 s,
  var TTFT_SAMPLES = 200;       // and at most the last 200 of them
  var FINISHED_KEEP = 500;      // sim.finished keeps only the latest requests, so memory stays bounded
  var BURST_SPREAD_MS = 450;    // a manual burst arrives over this long

  // Price of one H100 80GB for an hour, on demand, in USD. Lambda lists its 1x H100 SXM
  // at $4.29 per GPU-hour on https://lambda.ai/pricing (checked 2026-10-25).
  var GPU_HOUR_USD = 4.29;
  var GPU_HOUR_SOURCE = 'Lambda on-demand 1x H100 SXM 80GB, https://lambda.ai/pricing, checked 2026-10-25';

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

  // An instance can take a request if it's up, fits the model, has queue room and, when the
  // prompt is given, a max-model-len that holds the prompt plus max_tokens
  function canTake(sim, inst, prompt) {
    return inst.up && inst.fits && inst.queue.length < sim.cfg.queueCap &&
      (prompt === undefined || prompt + sim.cfg.maxTokens <= inst.maxModelLen);
  }

  // Least outstanding requests among the instances that can take it, lowest index on ties.
  // null when none can (the request gets a 503).
  function route(sim, prompt) {
    var best = null;
    for (var k = 0; k < sim.instances.length; k++) {
      var inst = sim.instances[k];
      if (canTake(sim, inst, prompt) && (!best || outstanding(inst) < outstanding(best))) best = inst;
    }
    return best;
  }

  // A request arrives now. It's routed at once, or rejected when no instance can take it.
  // inst is an index into sim.instances.
  function enqueue(sim, spec) {
    sim.stats.arrived += 1;
    var r = {
      id: sim.stats.arrived, t0: sim.t, prompt: spec.prompt, output: spec.output, inst: null, state: 'queued',
      prefillTarget: spec.prompt, prefillDone: 0, generated: 0, kvTokens: 0,
      tAdmit: null, tFirst: null, tDone: null, preemptions: 0
    };
    var inst = route(sim, spec.prompt);
    if (!inst) {
      r.state = 'rejected';
      sim.stats.rejected += 1;
      return r;
    }
    r.inst = sim.instances.indexOf(inst);
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

    while (admit && inst.queue.length && inst.running.length < cfg.maxNumSeqs && tokens > 0) {
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

  // Starts a step at sim.t if the instance has work. Returns whether it did.
  function startStep(sim, inst) {
    var plan = sim.batching === 'request' ? planRequest(sim, inst) : costOf(planContinuous(sim, inst, true));
    if (!plan.items.length) return false;
    inst.step = { start: sim.t, items: plan.items };
    inst.stepEnd = sim.t + stepTimeMs(inst.profile, inst.model, plan.prefill, plan.decode, plan.kvRead);
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
        sim.ttftLog.push([t, t - r.t0]);
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
    trimLog(sim.ttftLog, t, TTFT_WINDOW_MS, TTFT_SAMPLES);
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

  // Off stops steady arrivals and drops the arrival times still pending; on schedules the next
  // arrival and burst from now. Work already queued or running carries on.
  function setArrivals(sim, on) {
    if (on === sim.arrivalsOn) return;
    sim.arrivalsOn = on;
    if (on) {
      sim.nextArrival = sim.t + poissonGap(sim);
      sim.nextBurst = sim.t + burstGap(sim);
    } else {
      sim.pending = [];
    }
  }

  // n arrival times over the next BURST_SPREAD_MS, whether or not arrivals are on
  function sendBurst(sim, n) {
    for (var k = 0; k < n; k++) sim.pending.push(sim.t + sim.rng() * BURST_SPREAD_MS);
    sim.pending.sort(function (a, b) { return a - b; });
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

  // TTFT is tFirst - t0 over the recent first tokens (TTFT_WINDOW_MS, TTFT_SAMPLES). TPOT is the mean of
  // (tDone - tFirst) / (generated - 1) over finished requests whose first token is in that window.
  // Throughput is the tokens made over the last TOKRATE_WINDOW_MS, per second. Null means no data yet.
  function metrics(sim) {
    var ttfts = [], tokens = 0, tpotSum = 0, tpotN = 0, used = 0, budget = 0, k, r;
    for (k = 0; k < sim.ttftLog.length; k++) {
      if (sim.ttftLog[k][0] >= sim.t - TTFT_WINDOW_MS) ttfts.push(sim.ttftLog[k][1]);
    }
    ttfts.sort(function (a, b) { return a - b; });
    for (k = 0; k < sim.finished.length; k++) {
      r = sim.finished[k];
      if (r.tFirst >= sim.t - TTFT_WINDOW_MS && r.generated > 1) {
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
    var tokPerSec = tokens / (TOKRATE_WINDOW_MS / 1000);
    var gpuCount = 1;   // PR 1 simulates one GPU
    return {
      ttftP50: ttfts.length ? nearestRank(ttfts, 0.5) : null,
      ttftP99: ttfts.length ? nearestRank(ttfts, 0.99) : null,
      tpotMs: tpotN ? tpotSum / tpotN : null,
      tokPerSec: tokPerSec,
      kvFrac: budget > 0 ? used / budget : null,
      costPer1M: tokPerSec > 0 ? GPU_HOUR_USD * gpuCount / 3600 / tokPerSec * 1e6 : null,
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
      tokLog: [],      // [time, tokens made in a step]
      ttftLog: [],     // [time of a first token, its TTFT]
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
