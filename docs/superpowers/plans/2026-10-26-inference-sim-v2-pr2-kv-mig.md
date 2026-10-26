# inference.sim v2, PR 2: tab 02 (KV cache) and tab 03 (MIG with several models) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tab 02 (the KV cache filling up and preempting, with a GPU memory slider) and tab 03 (three models served as GPU per model, time-slicing or MIG), plus the PR 1 follow-ups the final review asked for.

**Architecture:** The engine (`assets/sim-engine.js`, pure, tested in Node) gains models 3B and 1B, several traffic streams, one instance per model, physical GPU groups, a time-slicing model and per-model metrics. Each tab, and each choice inside a tab, is an engine preset. Changing it rebuilds and warms up the sim: a redeploy, the same way a tab switch already works. The page (`assets/sim.js`, `index.html`) un-hides the tab row, adds the two panels and their controls, and draws several instances.

**Tech Stack:** Plain ES5-style JavaScript (`var`, `function`, no build step), canvas 2D, `node:test`, Python `unittest` with `tests/pagecheck.py` and `tests/render.py`.

**Spec:** `docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md`. This plan covers its Delivery step 2, plus the five PR 2 follow-ups listed under "Next plans" in `docs/superpowers/plans/2026-10-25-inference-sim-v2-pr1-engine.md`.

## Global Constraints

- **Stack:** no build step, bundler or framework. Match the page's idiom: `var`, `function`, IIFEs, `'use strict'`. Scripts load with `defer`. The engine touches no DOM and must work in Node (`module.exports`) and in the browser (`window.SimEngine`).
- **Visual language:** dark panel, `--p-*` colours, Geist Mono labels. Use only the existing palette: `#7aa2ff` accent, `#4ade80` ok, `#f5a524` warn, `#ef4444` bad, `#161920` slice fill, `#2a2f38` stroke, `#5c626d` and `#8b919c` labels, plus alpha variants. No new text below 11px (0.72rem).
- **Clock:** real time (1×).
- **Unchanged from PR 1:**
  - H100 SXM: 989 TFLOPS, 3.35 TB/s.
  - Llama 3 8B: 8.03e9 params, 16.06 GB of weights, 131072 bytes of KV per token, context 8192.
  - `DEFAULTS`: `gpuMemUtil` 0.9, activation reserve 1 GB, `maxNumSeqs` 256, `maxNumBatchedTokens` 8192, `maxTokens` 1024, `maxBatch` 16, `maxQueueDelayMs` 25, `queueCap` 128.
  - GB means 1e9 bytes.
- **New pinned numbers** (bf16, from each model's Hugging Face config; verify and cite them in a code comment):
  - Llama 3.2 3B: 3.21e9 params, 6.43 GB of weights, 114688 bytes of KV per token (28 layers × 8 KV heads × 128 × K,V × 2), context 131072, short label `3B`.
  - Llama 3.2 1B: 1.24e9 params, 2.47 GB of weights, 32768 bytes of KV per token (16 × 8 × 64 × 2 × 2), context 131072, short label `1B`.
  - Llama 3 8B gets the short label `8B`.
- **Tab 03 SLOs** (TTFT p99): 8B 2000 ms, 3B 500 ms, 1B 300 ms. Calibration may never change these.
- **Tab 02 slider:** `--gpu-memory-utilization` from 0.5 to 0.95, step 0.05, default 0.9.
- **Tab 03 deployments:** `GPU per model | time-slicing | MIG`, default MIG.
  - GPU per model: 8B, 3B and 1B, each on its own 7g.80gb.
  - Time-slicing: all three on one H100 with no MIG, at `gpuMemUtil` 0.45, 0.25 and 0.2.
  - MIG: one H100 split into 8B on 3g.40gb, 3B on 2g.20gb, 1B on 2g.20gb, each at 0.9.
- **Redeploys:** a tab switch, a slider `change` and a deployment pick each rebuild the sim and warm it up. Switching tabs resets that tab's controls to their defaults (spec: "Switching tabs resets the sim to that tab's setup").
- **Output lengths stay hidden** from schedulers, as in PR 1.
- **ML digest:** don't touch the name, tagline or About text, which `scripts/ml_figures.py` reads.
- **Commits:** no Claude co-author or attribution lines (Omar's CLAUDE.md overrides).
- **Both suites pass:** `python3 -m unittest discover -s tests` and `node --test tests/*.test.mjs`.

## Review Focus

1. **Moving the tab 02 slider with the arrow keys or by dragging.** The `<output>` updates as it moves. Each `change` causes exactly one redeploy, with no jank, and the slider keeps focus. → Task 5 manual check (b).
2. **Switching tabs while paused, draining or frozen (reduced motion).** The new tab opens running unless frozen, and the play button and live dot match its state. → Task 5 manual check (c).
3. **Tab 03 on a 390px phone.** Three short boxes with legible headers (short model labels), "+N more" still clear of the rows, and no horizontal scroll. → Task 6 manual check (d).
4. **Time-slicing with only one model busy.** That process runs at full GPU speed, a stretch of 1, which is honest: time-slicing only hurts under contention. → Task 4 test "alone a time-sliced process runs at full speed".
5. **A redeploy in the middle of a burst.** No dots, rows, particles or markers from the old sim carry over, and only one animation loop runs. → Task 6 manual check (e).

---

### Task 1: PR 1 follow-ups in the engine

**Files:**
- Modify: `assets/sim-engine.js` (`pick`, `createInstance`, `planContinuous`, and the `api` export)
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Produces:
  - `createInstance` throws `Error('unknown MIG profile: ' + profile)` or `Error('unknown model: ' + model)`.
  - `pick` falls back to `DEFAULTS` for `undefined`, `null` and non-finite numbers.
  - `canAdmit(sim, inst) -> boolean` is exported: continuous mode, an empty queue, `running.length < maxNumSeqs`, and `kvUsed < kvBudget`.

- [ ] **Step 0: Branch from the merged main.** `git checkout main && git pull --ff-only && git checkout -b sim-v2-tabs-02-03`.

- [ ] **Step 1: Write the failing tests** in `tests/sim.test.mjs`, reusing its `near` and `run` helpers.

```js
test('unknown profile or model throws a clear error', () => {
  assert.throws(() => E.createInstance('9g.90gb', 'llama-3-8b', {}), /unknown MIG profile: 9g\.90gb/);
  assert.throws(() => E.createInstance('7g.80gb', 'gpt-x', {}), /unknown model: gpt-x/);
});
test('null or NaN config values fall back to the defaults', () => {
  near(E.createInstance('7g.80gb', 'llama-3-8b', { gpuMemUtil: NaN }).kvBudget, 54.94e9, 0.01e9);
  near(E.createInstance('7g.80gb', 'llama-3-8b', { gpuMemUtil: null }).kvBudget, 54.94e9, 0.01e9);
  assert.equal(E.createSim({ ...E.PRESETS.batching, seed: 1, config: { queueCap: NaN } }).cfg.queueCap, 128);
});
test('no waiting request is admitted in a step that preempted (vLLM V1)', () => {
  const sim = E.createSim({ seed: 2, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous',
                            config: { gpuMemUtil: 0.45 }, traffic: { rate: 4, bursts: false } });
  let checked = 0;
  for (let t = 0; t < 60000; t += 1) {   // 1 ms ticks: at most one plan per instance per tick (a step is >= 1.5 ms)
    const before = sim.stats.preemptions, wasRunning = new Set(sim.instances[0].running.map(r => r.id));
    E.tick(sim, 1);
    if (sim.stats.preemptions > before) {
      checked += 1;
      for (const r of sim.instances[0].running) assert.ok(wasRunning.has(r.id), `request ${r.id} admitted in a preempting step`);
    }
  }
  assert.ok(checked > 0);
});
test('canAdmit: continuous mode, empty queue, room under max-num-seqs and in the KV pool', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1, traffic: { rate: 0, bursts: false } });
  const inst = sim.instances[0];
  assert.equal(E.canAdmit(sim, inst), true);
  E.enqueue(sim, { prompt: 100, output: 5 });
  assert.equal(E.canAdmit(sim, inst), false);   // the queue head goes first
  run(sim, 2000);
  assert.equal(E.canAdmit(sim, inst), true);
  E.setBatching(sim, 'request');
  assert.equal(E.canAdmit(sim, inst), false);
});
```

- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the 4 new tests FAIL.

- [ ] **Step 3: Implement.**
  - `pick`: use the config value only if it isn't `undefined` or `null`, and isn't a number that fails `isFinite`.
  - `createInstance` and `stepTimeMs`: throw the two errors from Interfaces before reading the tables.
  - `planContinuous`: once the running-sequence loop has preempted anything, skip the queue-admission loop for this step.
  - `canAdmit`: implement as in Interfaces and export it.

- [ ] **Step 4: Run** `node --test tests/*.test.mjs`. Expected: all pass, the 38 from PR 1 plus 4 new.

- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs docs/superpowers/plans/2026-10-26-inference-sim-v2-pr2-kv-mig.md
git commit -m "Sim v2: harden config and keys, vLLM V1 admission rule after preemption, canAdmit helper"
```

---

### Task 2: Several models and traffic streams, GPU groups, per-model metrics

**Files:**
- Modify: `assets/sim-engine.js`
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - **`MODELS`:** `'llama-3.2-3b'` and `'llama-3.2-1b'` with the Global Constraints numbers, and a `short` field on all three.
  - **Instance specs:** `{ profile, model, gpu?: number (default 0), gpuMemUtil?: number }`. The instance gets `gpu`, and `timeSliced: false` (Task 4 sets it). Its KV budget uses the spec's `gpuMemUtil` over `sim.cfg`'s.
  - **`createSim` traffic:** `opts.streams: [{ model, rate, bursts: boolean | { min, max }, lengths?: { prompt, output } }]`, or PR 1's `opts.traffic: { rate, bursts, lengths? }`, meaning one stream for `instances[0].model`. `bursts: true` means 30–40 requests over 1 s, every 8–12 s; `{ min, max }` sets the count range. `lengths` defaults to `LENGTHS`.
  - **Sim fields:**
    - `sim.streams[i]` holds `{ model, rate, bursts, lengths, nextArrival, nextBurst }`, and `sim.traffic` is removed.
    - `sim.slo = opts.slo || null`.
    - `sim.gpuCount` is the number of distinct `gpu` values.
  - **Requests** get `model` and `stream`. `sim.pending` entries become `{ t, stream }`, sorted by `t`.
  - **`route(sim, prompt?, model?)`** only picks instances with `inst.model === model` when a model is given.
  - **`enqueue(sim, { prompt, output, model? })`.**
  - **`sendBurst(sim, n, stream = 0)`.**
  - **`metrics(sim, model?)`:** with a model, TTFT p50/p99 and TPOT cover only that model's requests (`ttftLog` entries become `[t, ttft, model]`). Throughput, KV and cost stay whole-sim, and cost uses `sim.gpuCount`.

- [ ] **Step 1: Write the failing tests.**

```js
const two = (extra = {}) => E.createSim(Object.assign({ seed: 1,
  instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }, { profile: '2g.20gb', model: 'llama-3.2-1b' }],
  streams: [{ model: 'llama-3-8b', rate: 0 }, { model: 'llama-3.2-1b', rate: 0 }] }, extra));
test('Llama 3.2 3B and 1B: KV per token and KV budget on a 2g.20gb slice', () => {
  assert.equal(E.MODELS['llama-3.2-3b'].kvBytesPerToken, 114688);
  assert.equal(E.MODELS['llama-3.2-1b'].kvBytesPerToken, 32768);
  near(E.createInstance('2g.20gb', 'llama-3.2-3b', { gpuMemUtil: 0.9 }).kvBudget, 10.57e9, 0.01e9);   // 18 - 6.43 - 1
  near(E.createInstance('2g.20gb', 'llama-3.2-1b', { gpuMemUtil: 0.9 }).kvBudget, 14.53e9, 0.01e9);   // 18 - 2.47 - 1
  assert.deepEqual(['llama-3-8b', 'llama-3.2-3b', 'llama-3.2-1b'].map(m => E.MODELS[m].short), ['8B', '3B', '1B']);
});
test('an instance spec can set its own gpuMemUtil', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '7g.80gb', model: 'llama-3-8b', gpuMemUtil: 0.45 }], traffic: { rate: 0 } });
  near(sim.instances[0].kvBudget, 18.94e9, 0.01e9);   // 36 - 16.06 - 1
});
test('requests only go to instances serving their model', () => {
  const sim = two();
  assert.equal(E.route(sim, 100, 'llama-3.2-1b'), sim.instances[1]);
  assert.equal(E.enqueue(sim, { prompt: 100, output: 5, model: 'llama-3-8b' }).inst, 0);
  const r = E.enqueue(sim, { prompt: 100, output: 5, model: 'llama-3.2-1b' });
  assert.deepEqual([r.inst, r.model], [1, 'llama-3.2-1b']);
});
test('each stream arrives at its own rate, with its own model', () => {
  const sim = two({ streams: [{ model: 'llama-3-8b', rate: 1 }, { model: 'llama-3.2-1b', rate: 4,
    lengths: { prompt: { median: 120, sigma: 0.5, min: 8, max: 1000 }, output: { median: 16, sigma: 0.5, min: 1, max: 120 } } }] });
  run(sim, 60000); E.setArrivals(sim, false); run(sim, 120000);
  const n = m => sim.finished.filter(r => r.model === m).length;
  assert.ok(n('llama-3-8b') >= 45 && n('llama-3-8b') <= 75, String(n('llama-3-8b')));
  assert.ok(n('llama-3.2-1b') >= 200 && n('llama-3.2-1b') <= 280, String(n('llama-3.2-1b')));
});
test('a burst goes to the stream it names', () => {
  const sim = two();
  E.setArrivals(sim, false); E.sendBurst(sim, 10, 1); run(sim, 30000);   // arrivals off first: turning them off drops pending ones
  assert.equal(sim.finished.length, 10);
  assert.ok(sim.finished.every(r => r.model === 'llama-3.2-1b'));
});
test('per-model metrics filter TTFT and TPOT by model', () => {
  const sim = two();
  for (let k = 0; k < 20; k++) { E.enqueue(sim, { prompt: 3000, output: 20, model: 'llama-3-8b' }); E.enqueue(sim, { prompt: 50, output: 20, model: 'llama-3.2-1b' }); }
  run(sim, 20000);
  assert.ok(E.metrics(sim, 'llama-3.2-1b').ttftP99 < E.metrics(sim, 'llama-3-8b').ttftP99);
  assert.equal(E.metrics(sim, 'llama-3.2-3b').ttftP99, null);
});
test('GPU count is the number of distinct physical GPUs, and cost scales with it', () => {
  const three = E.createSim({ seed: 1, traffic: { rate: 6, bursts: false },
    instances: [0, 1, 2].map(g => ({ profile: '7g.80gb', model: 'llama-3-8b', gpu: g })) });
  assert.equal(three.gpuCount, 3);
  assert.equal(two().gpuCount, 1);
  run(three, 20000);
  const m = E.metrics(three);
  near(m.costPer1M, E.GPU_HOUR_USD * 3 / 3600 / m.tokPerSec * 1e6, 1e-9);
});
```

- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the new tests FAIL. The PR 1 tests still pass, since they use `traffic`.

- [ ] **Step 3: Implement as in Interfaces.**
  - Arrivals: `nextEvent` considers each stream's `nextArrival`, and `nextBurst` if `bursts` is set. Its event carries the stream index.
  - `arrive(sim, k)` samples from stream `k`'s lengths and enqueues with its model.
  - `setArrivals` reschedules every stream.

- [ ] **Step 4: Run** `node --test tests/*.test.mjs`. Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: Llama 3.2 3B and 1B, traffic streams per model, GPU groups and per-model metrics"
```

---

### Task 3: Tab 02 preset — the KV cache

**Files:**
- Modify: `assets/sim-engine.js` (`PRESETS`)
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: Task 2 (`traffic.lengths`).
- Produces: `PRESETS.kvcache = { instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 3.5, bursts: true, lengths: LONG } }`, where `LONG = { prompt: { median: 1500, sigma: 0.5, min: 256, max: 6000 }, output: { median: 800, sigma: 0.4, min: 64, max: 1000 } }`. These are starting values. Comment that they're synthetic: long prompts and long replies, so the KV pool fills.

- [ ] **Step 1: Write the failing tests.**

```js
function kvRun(util, seed) {
  const sim = E.createSim(Object.assign({}, E.PRESETS.kvcache, { seed, config: { gpuMemUtil: util } }));
  let peak = 0;
  run(sim, 120000, s => { const i = s.instances[0]; peak = Math.max(peak, i.kvUsed / i.kvBudget); });
  return { sim, peak };
}
test('tab 02: every slider position from 0.5 to 0.95 starts the server and fits the longest prompt', () => {
  for (let u = 0.5; u <= 0.9501; u += 0.05) {
    const inst = E.createSim(Object.assign({}, E.PRESETS.kvcache, { seed: 1, config: { gpuMemUtil: u } })).instances[0];
    assert.ok(inst.fits, String(u));
    assert.ok(inst.maxModelLen >= E.PRESETS.kvcache.traffic.lengths.prompt.max + 1024, String(u));
  }
});
test('tab 02: at the default 0.9 the KV pool fills and the scheduler preempts', () => {
  const r = kvRun(0.9, 3);
  assert.ok(r.peak >= 0.9, String(r.peak));
  assert.ok(r.sim.stats.preemptions > 0);
});
test('tab 02: less KV memory means more preemption and fewer requests served', () => {
  const lo = kvRun(0.5, 3), hi = kvRun(0.95, 3);
  assert.ok(lo.sim.stats.preemptions >= 3 * Math.max(1, hi.sim.stats.preemptions), `${lo.sim.stats.preemptions} vs ${hi.sim.stats.preemptions}`);
  assert.ok(hi.sim.stats.finished > lo.sim.stats.finished);
});
```

- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: FAIL (`PRESETS.kvcache` is undefined).

- [ ] **Step 3: Implement the preset.** If a lesson test misses, tune only `rate` and the `LONG` medians and sigmas, keeping `prompt.max` at 6000 or less. Don't change the hardware, model numbers, `DEFAULTS` or the slider range. Put the final values in the commit message.

- [ ] **Step 4: Run** `node --test tests/*.test.mjs`. Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: tab 02 preset, a 3g.40gb slice whose KV cache fills with long synthetic requests"
```

---

### Task 4: Time-slicing and the tab 03 presets

**Files:**
- Modify: `assets/sim-engine.js` (`createSim`, `startStep`, `PRESETS`)
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - **`inst.timeSliced`:** true when its profile is `'7g.80gb'` and another instance has the same `gpu`.
  - **`inst.step`** is `{ start, items, prefill, decode, kvRead, stretch }`.
  - **Time-slicing model:** at step start, `stretch = 1 +` the number of other time-sliced instances on the same `gpu` with a step in flight (`stepEnd !== null`), and `stepEnd = start + stretch * stepTimeMs(profile, model, prefill, decode, kvRead)`. Non-time-sliced instances have `stretch` 1.
  - **`PRESETS['mig-gpu']`, `['mig-time']` and `['mig-mig']`:** instances as in Global Constraints (GPU per model uses `gpu` 0/1/2; the other two use `gpu` 0 for all three).
    - Shared by all three: `batching: 'continuous'` and `slo: { 'llama-3-8b': 2000, 'llama-3.2-3b': 500, 'llama-3.2-1b': 300 }`.
    - Streams, in this order (starting values):
      - 8B, `rate` 1.5, `bursts: { min: 10, max: 16 }`, `LENGTHS`.
      - 3B, `rate` 6, no bursts, `SHORT = { prompt: { median: 300, sigma: 0.6, min: 16, max: 2000 }, output: { median: 60, sigma: 0.6, min: 4, max: 400 } }`.
      - 1B, `rate` 10, no bursts, `TINY = { prompt: { median: 120, sigma: 0.5, min: 8, max: 1000 }, output: { median: 16, sigma: 0.5, min: 1, max: 120 } }`.

- [ ] **Step 1: Write the failing tests.**

```js
const preset = (id, seed, quiet) => {
  const p = E.PRESETS[id];
  const streams = quiet ? p.streams.map(s => Object.assign({}, s, { bursts: false })) : p.streams;
  return E.createSim(Object.assign({}, p, { seed, streams }));
};
test('instances sharing a whole GPU are time-sliced; MIG slices and separate GPUs are not', () => {
  assert.deepEqual(preset('mig-time', 1).instances.map(i => i.timeSliced), [true, true, true]);
  assert.deepEqual(preset('mig-mig', 1).instances.map(i => i.timeSliced), [false, false, false]);
  assert.deepEqual(preset('mig-gpu', 1).instances.map(i => i.timeSliced), [false, false, false]);
});
test('alone a time-sliced process runs at full speed; with a busy neighbour its step stretches', () => {
  const sim = E.createSim({ seed: 1, streams: [{ model: 'llama-3-8b', rate: 0 }, { model: 'llama-3.2-1b', rate: 0 }],
    instances: [{ profile: '7g.80gb', model: 'llama-3-8b', gpu: 0, gpuMemUtil: 0.45 }, { profile: '7g.80gb', model: 'llama-3.2-1b', gpu: 0, gpuMemUtil: 0.2 }] });
  const i1 = sim.instances[1], cost = s => E.stepTimeMs('7g.80gb', 'llama-3.2-1b', s.prefill, s.decode, s.kvRead);
  E.enqueue(sim, { prompt: 100, output: 400, model: 'llama-3.2-1b' });
  E.tick(sim, 1);
  assert.equal(i1.step.stretch, 1);
  near(i1.stepEnd - i1.step.start, cost(i1.step), 1e-9);
  E.enqueue(sim, { prompt: 6000, output: 50, model: 'llama-3-8b' });
  let seen = false;
  for (let t = 0; t < 2000 && !seen; t += 1) {
    E.tick(sim, 1);
    if (i1.step && i1.step.stretch === 2) { seen = true; near(i1.stepEnd - i1.step.start, 2 * cost(i1.step), 1e-9); }
  }
  assert.ok(seen);
});
test('tab 03: GPU per model and MIG both meet every SLO, and MIG uses one GPU instead of three', () => {
  for (const id of ['mig-gpu', 'mig-mig']) {
    const sim = preset(id, 5);
    run(sim, 120000);
    for (const [model, slo] of Object.entries(sim.slo)) {
      const p99 = E.metrics(sim, model).ttftP99;
      assert.ok(p99 !== null && p99 <= slo, `${id} ${model}: ${p99} > ${slo}`);
    }
  }
  assert.deepEqual(['mig-gpu', 'mig-time', 'mig-mig'].map(id => preset(id, 5).gpuCount), [3, 1, 1]);
});
test('tab 03: a burst on the 8B model raises the 1B model\'s p99 under time-slicing, not under MIG', () => {
  function effect(id) {
    const sim = preset(id, 7, true);
    run(sim, 40000);
    const before = E.metrics(sim, 'llama-3.2-1b').ttftP99;
    for (let k = 0; k < 4; k++) { E.sendBurst(sim, 40, 0); run(sim, 5000); }
    return E.metrics(sim, 'llama-3.2-1b').ttftP99 / before;
  }
  const time = effect('mig-time'), mig = effect('mig-mig');
  assert.ok(time >= 2, `time-slicing ×${time}`);
  assert.ok(mig <= 1.3, `MIG ×${mig}`);
});
```

- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement as in Interfaces.** If a calibration test misses, tune only the three streams' `rate`, `bursts` counts and `SHORT`/`TINY` medians and sigmas. Don't change the SLOs, hardware, model numbers or deployments. Put the final values in the commit message. If the SLO test can't pass without changing a pinned number, stop and report NEEDS_CONTEXT.

- [ ] **Step 4: Run** `node --test tests/*.test.mjs`. Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: time-slicing model and tab 03 presets (GPU per model, time-slicing, MIG)"
```

---

### Task 5: The page — tabs 02 and 03, their controls, the footer

**Files:**
- Modify: `index.html`:
  - CSS around the `.sim-tabs` / `.sim-lesson` / `.seg` / `.sim-key` rules (~331–375).
  - The `#simbox` markup (~726–760).
- Modify: `assets/sim.js` (tabs and controls, footer, `switchTab`)
- Test: `tests/test_page.py` (`Simulator` class)

**Interfaces:**
- Consumes: `E.PRESETS.kvcache`, `E.PRESETS['mig-gpu' | 'mig-time' | 'mig-mig']`, `sim.gpuCount`, `sim.stats.preemptions`, and `E.sendBurst(sim, n, 0)`.
- Produces, as DOM contracts for PRs 3–5:
  - **Tabs:** `button[role=tab][data-tab]` for `batching`, `kvcache` and `mig`. Panels `#sim-tab-batching`, `#sim-tab-kvcache` and `#sim-tab-mig`.
  - **Tab 02 slider:** `#sim-kvmem` (`input[type=range]`), with `#sim-kvmem-v` (its `<output>`).
  - **Tab 03 switch:** `[role=radiogroup][aria-label=Deployment] button[role=radio][data-deploy=gpu|time|mig]`.
  - **Footer:** `#m-gpus`, `#m-pre`, and `#m-pre-wrap`, which stays hidden until preemptions are above 0.

- [ ] **Step 1: Update and write the failing page tests.** Replace `test_tab_shell` and extend `test_footer_metrics`:

```python
    def test_tab_shell(self):
        lists = find_all(self.box, role="tablist")
        self.assertEqual(len(lists), 1)
        self.assertNotIn("hidden", lists[0].attrs)
        tabs = find_all(lists[0], "button", role="tab")
        self.assertEqual([t.attrs.get("data-tab") for t in tabs], ["batching", "kvcache", "mig"])
        self.assertEqual([" ".join(t.text().split()) for t in tabs], ["01 batching", "02 kv cache", "03 mig layout"])
        for t in tabs:
            panel = find_all(self.box, id=t.attrs.get("aria-controls"))[0]
            self.assertEqual(panel.attrs.get("role"), "tabpanel")
            self.assertEqual(panel.attrs.get("data-tab"), t.attrs.get("data-tab"))

    def radios(self, panel_id):
        return find_all(find_all(self.box, id=panel_id)[0], "button", role="radio")

    def test_batching_switch(self):
        r = self.radios("sim-tab-batching")
        self.assertEqual([b.attrs.get("data-batching") for b in r], ["request", "continuous"])
        self.assertEqual([b.attrs.get("aria-checked") for b in r], ["false", "true"])

    def test_kvcache_slider(self):
        panel = find_all(self.box, id="sim-tab-kvcache")[0]
        s = find_all(panel, "input", id="sim-kvmem")[0]
        self.assertEqual([s.attrs.get(k) for k in ("type", "min", "max", "step", "value")], ["range", "0.5", "0.95", "0.05", "0.9"])
        self.assertEqual(find_all(panel, "output", id="sim-kvmem-v")[0].text().strip(), "0.90")
        self.assertIn("Synthetic traffic", panel.text())

    def test_mig_switch(self):
        r = self.radios("sim-tab-mig")
        self.assertEqual([b.attrs.get("data-deploy") for b in r], ["gpu", "time", "mig"])
        self.assertEqual([" ".join(b.text().split()) for b in r], ["GPU per model", "time-slicing", "MIG"])
        self.assertEqual([b.attrs.get("aria-checked") for b in r], ["false", "false", "true"])
```

  In `test_footer_metrics`, add `"m-gpus"` and `"m-pre"` to the id list, and assert `hidden` on `#m-pre-wrap`.

- [ ] **Step 2: Run** `python3 -m unittest discover -s tests`. Expected: the new and changed `Simulator` tests FAIL.

- [ ] **Step 3: Update the markup in `index.html`.**
  - **Tab row:** remove `hidden` from `.sim-tabs`. Add the `kvcache` and `mig` tab buttons (`<i>02</i> kv cache`, `<i>03</i> mig layout`), with `aria-selected="false"` and ids `sim-tabbtn-kvcache` and `sim-tabbtn-mig`.
  - **Tab 02 panel:** `.sim-lesson[hidden]` with this lesson draft (Omar reviews the copy in the PR):

    `<b>KV cache.</b> Every token a request holds keeps its keys and values in GPU memory. When that pool is full, the scheduler stops admitting and preempts the newest request: its KV is dropped and it redoes its prefill later. Give the server less memory and watch preemptions climb: memory, not compute, limits how many requests run at once. <span class="sim-note">Synthetic traffic: long prompts and long replies.</span>`

    Add the control `<label class="sim-range"><span>--gpu-memory-utilization</span> <input type="range" id="sim-kvmem" min="0.5" max="0.95" step="0.05" value="0.9"> <output id="sim-kvmem-v" for="sim-kvmem">0.90</output></label>`.
  - **Tab 03 panel:** `.sim-lesson[hidden]` with this lesson draft (Omar approves the Trendyol sentence):

    `<b>MIG.</b> Three models, each with its own traffic. Kubernetes hands each pod a whole GPU, so they take three H100s that sit mostly idle. Time-slicing shares one H100 with no isolation, so a burst on the 8B model slows the other two. MIG splits one H100 into isolated slices and meets the same latency targets with a third of the GPUs. At Trendyol this gave about 1.75× more serving capacity.`

    Add a `.seg[role=radiogroup][aria-label=Deployment]` with the three radio buttons from the test, MIG checked.
  - **Footer:** add `<span>GPUs <b id="m-gpus">1</b></span>` before `cost`. Add `<span id="m-pre-wrap" hidden>preempted <b id="m-pre">0</b></span>` before `rejected`.
  - **CSS:**
    - `.sim-range`: inline-flex, mono, 0.72rem, `--p-muted` label, `accent-color: var(--p-accent)`, range about 120px wide, `<output>` in `--p-text`.
    - `.sim-note`: `--p-faint`, 0.72rem or larger.
    - Both wrap without horizontal scroll at 390px.

- [ ] **Step 4: Implement the page logic in `assets/sim.js`.**
  - **`VIEWS`,** keyed by preset id, each holding `{ note, label, narrow, aria }`. Use these exact strings:

    | id | note | label | narrow | aria |
    |---|---|---|---|---|
    | `batching` | `· Llama 3 8B on one H100 · real time` | `H100 · Llama 3 8B` | `H100` | the current canvas aria-label |
    | `kvcache` | `· Llama 3 8B on one 3g.40gb MIG slice · real time` | `MIG 3g.40gb · Llama 3 8B` | `3g.40gb` | `Animated simulation: Llama 3 8B on one MIG slice; its KV cache fills up and the scheduler preempts requests` |
    | `mig-gpu` | `· three models on three H100s · real time` | `3 × H100, one model each` | `3 × H100` | `Animated simulation: three models, each on its own H100` |
    | `mig-time` | `· three models time-sharing one H100 · real time` | `one H100, time-sliced` | `H100` | `Animated simulation: three models sharing one H100 by time-slicing, with no isolation` |
    | `mig-mig` | `· three models on one H100 split 3g+2g+2g · real time` | `one H100 · MIG 3g+2g+2g` | `H100 · MIG` | `Animated simulation: three models on isolated MIG slices of one H100` |
  - **`deploy(presetId, config)`:** takes over `switchTab`'s rebuild-and-warm body, using `E.createSim(Object.assign({}, E.PRESETS[presetId], { seed, config: config }))`. It sets `.p-title .note` and the canvas `aria-label` from `VIEWS`, and keeps `frozen` as it is.
  - **`switchTab(tabId)`:**
    - Selects the tab and panel.
    - Resets the tab's controls to their defaults: batching radios to continuous, the slider to 0.9 with output `0.90`, and the deployment to MIG.
    - Calls `deploy`: `batching` → `'batching'`; `kvcache` → `'kvcache'` with `{ gpuMemUtil: 0.9 }`; `mig` → `'mig-mig'`.
  - **Slider:** `input` sets the `<output>` to `value.toFixed(2)`, and `change` calls `deploy('kvcache', { gpuMemUtil: +value })`.
  - **Deployment radios:** pick → `deploy('mig-' + value)`.
  - **Radio groups:** each tabpanel's radiogroup gets its own roving tabindex and arrow-key group (scope the query per panel). The batching radios keep calling `setBatching`.
  - **Footer:**
    - `#m-gpus` shows `sim.gpuCount`.
    - `#m-pre` shows `sim.stats.preemptions` (`toLocaleString('en-US')`), and `#m-pre-wrap` is shown once it's above 0.
  - **Burst button:** calls `E.sendBurst(sim, BURST, 0)`.

- [ ] **Step 5: Run** `python3 -m unittest discover -s tests` and `node --test tests/*.test.mjs`. Expected: all pass.

- [ ] **Step 6: Check it manually** with Python Playwright (`channel="chrome"`). The Playwright MCP browser may be locked. A dev server may already be serving this checkout at http://127.0.0.1:8000/; otherwise start `python3 -m http.server`. Screenshots go to `.playwright-mcp/pr2-*.png`.
  - **(a)** All three tabs open running, with the right header note, and arrow keys move between tabs.
  - **(b)** In tab 02, ArrowLeft on the slider updates the output to 0.85, causes one redeploy, and keeps focus there. Dragging updates the output live.
  - **(c)** Pause in tab 01, switch to tab 02, and it opens running (`❚❚`). With reduced motion emulated, every tab opens frozen (`▶ play`).
  - **(d)** In tab 03, each deployment pick redeploys, the GPUs footer reads 3, 1, 1, and the cost changes accordingly.
  - **(e)** No console errors.

- [ ] **Step 7: Commit.**

```bash
git add index.html assets/sim.js tests/test_page.py
git commit -m "Sim v2: tabs 02 and 03 on the page, KV memory slider, deployment switch, GPUs and preempted in the footer"
```

---

### Task 6: The canvas — several instances, preemption, SLOs, time-slicing

**Files:**
- Modify: `assets/sim.js` (`drawInstance`, `sync`, `draw`, and the `canAdmit` removal)
- Modify: `index.html` (`.sim-key` markup and CSS)
- Test: `tests/test_page.py` (`test_colour_key`, `test_key_colours_match_canvas`)

**Interfaces:**
- Consumes: `VIEWS` (Task 5); `E.canAdmit`; `inst.step.stretch`, `inst.timeSliced` and `inst.gpu` (Task 4); `sim.slo`, `sim.gpuCount` and `E.metrics(sim, model)` (Task 2); `E.MODELS[m].short`.

- [ ] **Step 1: Update the page tests.**
  - The key gains a sixth entry, `preempted`, with swatch class `k-pre`, after `idle slot (request-level only)`.
  - `test_key_colours_match_canvas` also maps `k-pre` to the canvas colour `warn`.
  - Add a test that `.sim-key`'s font-size is `0.72rem`. That fixes PR 1's 10.88px residual and matches the footer.
- [ ] **Step 2: Run** `python3 -m unittest discover -s tests`. Expected: the key tests FAIL.
- [ ] **Step 3: Implement.**
  - **Top label:** `VIEWS[preset].label` (`narrow` when W ≤ 560) replaces `'H100 · ' + model`.
  - **Admission:** `E.canAdmit(sim, inst)` replaces the local `canAdmit`.
  - **Box header, left side:**
    - For a `7g.80gb` instance: `H100` when `sim.gpuCount === 1` and it isn't time-sliced; `H100 <gpu+1>` when `gpuCount > 1`; `shared H100` when time-sliced.
    - For other profiles: the profile name.
    - When the sim has more than one model, append ` · ` + `MODELS[model].short`.
  - **Box header, right side:**
    - Without `sim.slo`, unchanged (`running N · KV x%`).
    - With `sim.slo`: `p99 <fmt.ms(p99 of that model)>`, in `ok` colour when it's at or under that model's SLO and `bad` when over, then ` · KV x%`.
    - The p99s are cached per model at each 300 ms footer refresh.
    - When `inst.step && inst.step.stretch > 1`, prefix `×<stretch>` in `warn`.
    - Drop pieces from the right when the header doesn't fit: first ` · KV x%`, then `p99 `.
  - **Preemption:** when a drawn row's request has been preempted since the row was created, the row flashes `warn` for `FLASH_MS` instead of vanishing (track `row.pre = r.preemptions` at creation). Then it's removed, and its dot eases back to the front of the queue lane.
  - **Several boxes:** check that `layout()` gives each instance a readable box. If a box has fewer than 3 row lines, the canvas grows to 320px when there are three instances (300px at 640px and narrower), set from `switchTab`/`deploy`. It stays 260px/230px for one instance.
  - **Key:** add the `preempted` entry (`--c: #f5a524`), and set `.sim-key` font-size to `0.72rem`.
- [ ] **Step 4: Run** both suites. Expected: all pass.
- [ ] **Step 5: Check it manually** (Python Playwright as in Task 5). Screenshots go to `.playwright-mcp/pr2-canvas-*.png`.
  - **(a)** In tab 02 at 0.5, rows flash amber when preempted, the preempted count rises, and the KV bar sits near full.
  - **(b)** In tab 03 under time-slicing, `×2`/`×3` appears on the 3B and 1B boxes during an 8B burst (send burst), and their p99 turns red.
  - **(c)** Under MIG, the same burst leaves the 3B and 1B p99 green.
  - **(d)** At 390px in tab 03, the box headers are legible and don't overlap, "+N more" is clear of the rows, and `scrollWidth <= 390`.
  - **(e)** Switching deployment in the middle of a burst carries over no dots, rows or markers from the old sim, and frames don't speed up (one rAF loop).
  - **(f)** No console errors.
- [ ] **Step 6: Commit.**

```bash
git add assets/sim.js index.html tests/test_page.py
git commit -m "Sim v2: draw several instances, preemption flashes, per-model p99 vs SLO and time-slicing stretch"
```

---

### Task 7: Branch wrap-up

- [ ] **Step 1: Run** `python3 -m unittest discover -s tests && node --test tests/*.test.mjs`. Expected: everything passes with zero failures.
- [ ] **Step 2: Review** `git diff main --stat`. Expected: only `assets/sim-engine.js`, `assets/sim.js`, `index.html`, the tests and this plan.
- [ ] **Step 3: Ask Omar** whether to push `sim-v2-tabs-02-03` and open the PR. The PR body has no Claude attribution.

---

## Decisions made in this plan (for Omar to check)

- **Redeploys:** the tab 02 slider and the tab 03 switch redeploy (rebuild and warm up) rather than changing a running server. `--gpu-memory-utilization` is a startup flag, and switching between GPU per model, time-slicing and MIG is a redeploy in real life too.
- **Time-slicing model:** a process's step is stretched by the number of processes on that GPU with a step in flight. Alone it gets the full GPU, which is honest, since time-slicing only hurts under contention.
- **Tab 03 targets:** SLOs of 2 s for 8B, 500 ms for 3B and 300 ms for 1B, shown green or red in each box. The 8B stream has small bursts (10–16 requests), so time-slicing's noisy neighbour shows without clicking.
- **New footer counts:** a `GPUs` count, and a `preempted` count that appears after the first preemption.
- **Too-long prompts:** the PR 1 note about counting them separately from 503s is dropped, because no PR 2 preset can trigger it. Tab 02's longest prompt plus max_tokens is 7024 tokens, within `maxModelLen` 8192 at every slider position.

## Next plans

PR 3 (tab 04 and the Azure trace), PR 4 (tab 05, follow-a-request, config drawer) and PR 5 (the sandbox) are unchanged from the PR 1 plan's "Next plans" section.

### What changed during execution (supersedes the decisions above where they differ)

- **Time-slicing overhead.** Omar's call: under contention, a time-sliced step loses 30% of its GPU time to context switching (`CTX_SWITCH_LOSS`, labelled an assumption on the page). Stretch and loss apply to the GPU part of a step only.
- **Calibration** is tested over several seeds, and tabs 02 and 03 have visitor-view tests (8 s warm-up, 300 ms sampling, 30 s windows; tab 03 warms up 40 s).
- **Final values:**
  - Tab 02 runs at rate 0.5 with bursts of 8–12, prompts around 5500 tokens and replies around 400.
  - Tab 03's 8B runs at rate 2.5 with bursts of 6–10; the 3B at rate 8 and the 1B at rate 25.
- **Box p99** is coloured on the footer's 30 s window and shows its target as text (`p99 x / target`). The canvas aria-label carries each model's status.
- **The burst-triggered noisy-neighbour jump** isn't visible on the page, because the tab 03 traffic is steady. A quiet-8B engine test keeps the effect covered.

### Follow-ups from PR 2's final review

- **Tab 02 overload:** tab 02 runs about 50% over capacity at every slider position (TTFT p99 about 33 s after 2 min, 503s from about 5 min). Consider a clause in the synthetic-traffic note, or a gentler load that still shows preemption in 30 s.
- **Tab 03 switch:** about 1 in 8 switches to time-slicing opens green for the first 5 s.
- **Noisy-neighbour test:** it reads the peak p99 during the bursts, which inflates both ratios by about 1.2×. Note this in its comment, or compare against a matched baseline.
- **Phones:** the preempted row is the newest, so it usually sits under "+N more" and the amber flash is desktop-only. Consider drawing preempted rows first.
- **MIG headroom:** MIG's 8B headroom is thinner at rate 2.5 (max 1.9 s over 2 min), and a manual burst turns it red for about 33 s.
- **Uniform rows:** tab 02's prompt sigma of 0.1 makes the rows look uniform.
- **Warm-up cost:** the tab 03 warm-up costs 8–14 ms per click on desktop.
- **Engine vs UI:** the UI still reads engine internals (`inst.step`, `stepEnd`, `batch.steps`, `sim.cfg`, `r.prefillDone`).
- **Engine validation:** the engine doesn't validate physical MIG layouts per GPU, which the sandbox will need.
