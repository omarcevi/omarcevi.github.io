# inference.sim v2, PR 1: LLM engine, tab 01, drain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the homepage's generic queueing sim with a token-level LLM serving engine (Llama 3 8B on one H100) and ship tab 01 (request-level vs continuous batching), the new footer metrics and pause-as-drain.

**Architecture:** A pure, DOM-free engine in `assets/sim-engine.js` (UMD like `assets/speaking.js`: `module.exports` for `node:test`, `window.SimEngine` in the browser) runs an event-driven simulation in real time. `assets/sim.js` draws the canvas and wires the controls. `index.html` keeps the panel markup and CSS. The inline script section 2 is deleted.

**Tech Stack:** Plain ES5-style JavaScript (`var`, `function`, no build step), canvas 2D, `node:test`, Python `unittest` with the repo's `tests/pagecheck.py` parser and `tests/render.py` headless Chrome.

**Spec:** `docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md`. This plan covers the spec's Delivery step 1 only. Steps 2–5 get their own plans after this one merges (see "Next plans" at the end).

## Global Constraints

- **Stack:** no build step, bundler or framework. Match the page's idiom: `var`, `function`, IIFEs, `'use strict'`. Scripts are loaded with `defer`.
- **Engine purity:** the engine touches no DOM. It must `require()` cleanly in Node and run in the browser as `window.SimEngine`.
- **Visual language:** dark panel, `--p-*` colours, Geist Mono labels. Use only the existing palette: `#7aa2ff` accent, `#4ade80` ok, `#f5a524` warn, `#ef4444` bad, `#161920` slice fill, `#2a2f38` stroke, `#5c626d` and `#8b919c` labels.
- **Clock:** real time (1×). Header note: `· Llama 3 8B on one H100 · real time`.
- **Pinned numbers:**
  - H100 SXM: 989 TFLOPS dense BF16, 3.35 TB/s.
  - Llama 3 8B: 8.03e9 params, 16.06 GB of weights, 131072 bytes of KV per token.
  - `gpuMemUtil` 0.9, activation reserve 1 GB.
  - `maxNumSeqs` 256, `maxNumBatchedTokens` 8192, `maxTokens` 1024.
  - `maxBatch` 16, `maxQueueDelayMs` 25, `queueCap` 128.
  - GB means 1e9 bytes.
- **Output lengths stay hidden:** schedulers never read a request's true output length, only `maxTokens`.
- **Animation:** it runs only while the canvas is on screen and the browser tab is visible. With reduced motion it starts frozen.
- **ML digest:** don't touch the name, tagline or About text, which `scripts/ml_figures.py` reads (guarded by `test_ml_source_text_unchanged`).
- **Commits:** no Claude co-author or attribution lines (Omar's CLAUDE.md overrides the default).
- **Both suites pass:** `python3 -m unittest discover -s tests` and `node --test tests/*.test.mjs`.

## Review Focus

1. **Coming back to a background tab after minutes.** The sim should carry on where it stopped, with no flood of arrivals and no frozen frame. → Task 2: `tick` clamps `dt` to 50 ms.
2. **Toggling the batching mode several times mid-flight.** No request is lost or counted twice: arrived = finished + rejected + in flight. → Task 3 conservation test.
3. **Spamming `send burst`.** The queue cap holds, overflow is counted as 503s, the KV invariant holds, and memory stays bounded. → Task 2 rejection test and Task 4 pruning test.
4. **Reduced motion.** It opens frozen with `▶ play`, nothing moves until play, and after that pause drains normally. → Task 4 `playState` test and the Task 5 manual check.
5. **A 390px phone.** No horizontal page scroll, labels drop on narrow widths like today, and the controls wrap. → Task 5 manual check (`document.documentElement.scrollWidth <= 390`).

---

### Task 1: Engine skeleton, hardware and model tables, roofline step time

**Files:**
- Create: `assets/sim-engine.js`
- Create: `tests/sim.test.mjs`
- Add to git: `docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md`, `docs/superpowers/plans/2026-10-25-inference-sim-v2-pr1-engine.md`

**Interfaces:**
- Produces:
  - `PROFILES`: `{ '7g.80gb'|'4g.40gb'|'3g.40gb'|'2g.20gb'|'1g.20gb'|'1g.10gb': { compute, bw, memGB } }`. Compute shares are 7/7, 4/7, 3/7, 2/7, 1/7, 1/7. Bandwidth shares are 8/8, 4/8, 4/8, 2/8, 2/8, 1/8. Memory is 80, 40, 40, 20, 20, 10 GB.
  - `MODELS`: `{ 'llama-3-8b': { label: 'Llama 3 8B', params: 8.03e9, weightsGB: 16.06, kvBytesPerToken: 131072 } }`.
  - `GPU`: `{ tflops: 989, tbps: 3.35, mfu: 0.5, mbu: 0.8, stepOverheadMs: 1.5 }`.
  - `DEFAULTS`: the pinned config values from Global Constraints.
  - `createInstance(profile: string, model: string, config: object) -> Instance`, where `Instance = { id, profile, model, fits: boolean, kvBudget: bytes, maxModelLen: tokens, kvUsed: 0, queue: [], running: [], stepEnd: null, step: null, up: true }`. Task 2 fills in `maxModelLen`.
  - `stepTimeMs(profile: string, model: string, prefillTokens: number, decodeSeqs: number, kvTokensRead: number) -> ms`.

- [ ] **Step 0: Check the working tree.** Run `git status --short`. If `index.html` or `tests/` show uncommitted changes (the booking dialog work), stop and ask Omar to land or stash them first. Then `git checkout -b sim-v2-engine`.

- [ ] **Step 1: Write the failing tests** in `tests/sim.test.mjs`. Use the same header as `tests/speaking.test.mjs` (`createRequire`, `const E = require('../assets/sim-engine.js')`) and a helper `near(a, b, tol)` that asserts `Math.abs(a - b) <= tol`.

```js
test('KV budget: 8B on a full H100 at 0.9 leaves ~54.94 GB', () => {
  const i = E.createInstance('7g.80gb', 'llama-3-8b', { gpuMemUtil: 0.9 });
  assert.equal(i.fits, true);
  near(i.kvBudget, 54.94e9, 0.01e9);           // 80*0.9 - 16.06 - 1
});
test('8B does not fit on a 1g.10gb slice', () => {
  const i = E.createInstance('1g.10gb', 'llama-3-8b', { gpuMemUtil: 0.9 });
  assert.equal(i.fits, false);
  assert.equal(i.kvBudget, 0);
});
test('roofline: one decode token on a full H100 is memory-bound', () => {
  near(E.stepTimeMs('7g.80gb', 'llama-3-8b', 0, 1, 0), 7.49, 0.05);   // 16.06e9 / (3.35e12*0.8) + 1.5
});
test('roofline: 1000 prefill tokens on a full H100 are compute-bound', () => {
  near(E.stepTimeMs('7g.80gb', 'llama-3-8b', 1000, 0, 0), 34.0, 0.2);  // 2*8.03e9*1000 / (989e12*0.5) + 1.5
});
test('roofline: KV reads count as memory traffic', () => {
  near(E.stepTimeMs('7g.80gb', 'llama-3-8b', 0, 64, 64 * 1500) - E.stepTimeMs('7g.80gb', 'llama-3-8b', 0, 64, 0), 4.69, 0.05);
});
test('roofline: a 2g.20gb slice is ~4x slower than the full GPU on decode', () => {
  near(E.stepTimeMs('2g.20gb', 'llama-3-8b', 0, 1, 0), 25.47, 0.1);  // bandwidth share 2/8
});
```

- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: FAIL, "Cannot find module '../assets/sim-engine.js'".

- [ ] **Step 3: Implement** `assets/sim-engine.js`.
  - Use the UMD shell from `assets/speaking.js`. Export `api` through `module.exports` in Node, otherwise assign `root.SimEngine = api`. There is no init call; `sim.js` drives it.
  - `createInstance` computes `kvBudget = max(0, memGB*gpuMemUtil - weightsGB - activationReserveGB) * 1e9`, and `fits = kvBudget > 0`. Config falls back to `DEFAULTS`.
  - `stepTimeMs`:
    - `flops = 2 * params * (prefillTokens + decodeSeqs)`.
    - `bytes = weightsGB*1e9 + kvTokensRead*kvBytesPerToken`.
    - Return `max(flops / (tflops*1e12*mfu*compute), bytes / (tbps*1e12*mbu*bw)) * 1000 + stepOverheadMs`.
  - Header comment: one paragraph saying it's "a model, not a benchmark", citing the H100 datasheet and the Llama 3 8B config for the pinned numbers.

- [ ] **Step 4: Run** `node --test tests/sim.test.mjs`. Expected: 6 passing.

- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md docs/superpowers/plans/2026-10-25-inference-sim-v2-pr1-engine.md
git commit -m "Sim v2: engine skeleton with H100/MIG profiles and a roofline step time"
```

---

### Task 2: Traffic, router, event loop, continuous scheduler with KV accounting and preemption

**Files:**
- Modify: `assets/sim-engine.js`
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: `createInstance` and `stepTimeMs` (Task 1).
- Produces:
  - `createSim(opts) -> Sim`. `opts = { seed: number, instances: [{ profile, model }], batching: 'continuous'|'request', traffic: { rate: req/s, bursts: boolean }, config?: object }`.
  - `Sim = { t, rng, cfg, batching, instances, arrivalsOn: true, pending: [ms], events: [{ t, label }], finished: [Request], stats: { arrived, finished, rejected, preemptions }, tokLog: [[t, n]] }`.
  - `Request = { id, t0, prompt, output, inst, state: 'queued'|'running'|'idle'|'done'|'rejected', prefillTarget, prefillDone, generated, kvTokens, tAdmit, tFirst, tDone, preemptions }`.
  - `tick(sim, dtMs) -> void`, with `dtMs` clamped to 50.
  - `route(sim) -> Instance|null`.
  - `enqueue(sim, { prompt, output }) -> Request`. It routes immediately; for tests and the future sandbox.
  - `PRESETS.batching = { instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 6, bursts: true } }`.

- [ ] **Step 1: Write the failing tests.** Add a helper `run(sim, ms, each)` that calls `E.tick(sim, 16)` in a loop and calls `each(sim)` after each tick.

```js
test('tick clamps a huge dt (background tab) to 50 ms', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1 });
  E.tick(sim, 600000);
  assert.ok(sim.t <= 50);
});
test('KV use never exceeds the budget under overload', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 30, bursts: true } });
  run(sim, 120000, s => s.instances.forEach(i => assert.ok(i.kvUsed <= i.kvBudget, `${i.kvUsed} > ${i.kvBudget}`)));
});
test('preemption: the newest sequence goes back to the front of its queue and still finishes', () => {
  const sim = E.createSim({ seed: 2, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous',
                            config: { gpuMemUtil: 0.45 }, traffic: { rate: 4, bursts: false } });   // ~0.94 GB of KV
  run(sim, 60000);
  assert.ok(sim.stats.preemptions > 0);
  sim.arrivalsOn = false; sim.pending = [];
  run(sim, 180000);
  assert.equal(sim.stats.arrived, sim.stats.finished + sim.stats.rejected);
});
test('router picks the instance with the fewest outstanding requests, lowest index on ties', () => {
  const sim = E.createSim({ seed: 3, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }, { profile: '4g.40gb', model: 'llama-3-8b' }], traffic: { rate: 0, bursts: false } });
  assert.equal(E.route(sim), sim.instances[0]);
  sim.instances[0].queue.push({}, {}, {});
  sim.instances[1].queue.push({});
  assert.equal(E.route(sim), sim.instances[1]);
});
test('router rejects (503) when every queue is at the cap', () => {
  const sim = E.createSim({ seed: 3, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], config: { queueCap: 2, gpuMemUtil: 0.45 }, traffic: { rate: 0, bursts: false } });
  for (let k = 0; k < 40; k++) E.enqueue(sim, { prompt: 2000, output: 200 });
  assert.ok(sim.stats.rejected > 0);
  assert.ok(sim.instances[0].queue.length <= 2);
});
test('a prompt that cannot fit the KV pool is rejected up front instead of blocking the queue', () => {
  const sim = E.createSim({ seed: 3, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], config: { gpuMemUtil: 0.45 }, traffic: { rate: 0, bursts: false } });
  assert.equal(sim.instances[0].maxModelLen, 7171);            // floor(0.94e9 / 131072)
  assert.equal(E.enqueue(sim, { prompt: 7000, output: 10 }).state, 'rejected');   // 7000 + 1024 > 7171
  assert.equal(E.enqueue(sim, { prompt: 1000, output: 10 }).state, 'queued');
  assert.equal(E.createSim({ ...E.PRESETS.batching, seed: 3 }).instances[0].maxModelLen, 8192);   // Llama 3's context window
});
test('a first token is recorded when prefill completes, and TTFT >= queue wait', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 6, traffic: { rate: 0, bursts: false } });
  const r = E.enqueue(sim, { prompt: 1000, output: 5 });
  run(sim, 2000);
  assert.equal(r.state, 'done');
  assert.ok(r.tFirst >= r.tAdmit && r.tAdmit >= r.t0);
  assert.equal(r.generated, 5);
});
```

- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the new tests FAIL (`createSim is not a function`).

- [ ] **Step 3: Implement the RNG and traffic.**
  - RNG: seeded mulberry32 as `sim.rng()`.
  - Arrivals: Poisson at `traffic.rate`, where a rate of 0 means no Poisson arrivals. With `bursts`, add a burst every 8–12 s of 30–40 requests spread over 1 s, pushed into `sim.pending` as arrival times.
  - Lengths: lognormal approximations of the Azure conversation trace (Splitwise, ISCA 2024: median prompt 1020, median output 129). Prompt: median 1020, σ 0.8, clamped to [16, 7000]. Output: median 129, σ 0.93, clamped to [1, 1000]. Comment that PR 3 refits these from the real trace.

- [ ] **Step 4: Implement the router and `enqueue`.**
  - `route` picks an instance with `up && fits` that has the minimum `queue.length + running.length`, lowest index on ties.
  - `createInstance` also sets `maxModelLen = min(8192, floor(kvBudget / kvBytesPerToken))`. 8192 is Llama 3's context window. This mirrors how vLLM refuses requests that can't fit, and it guarantees that any single admitted sequence fits the KV pool alone, so preemption always terminates.
  - `enqueue` sets `state: 'rejected'` and bumps `stats.rejected` when there's no instance, when the chosen queue is at `queueCap`, or when `prompt + maxTokens > maxModelLen`. Otherwise it pushes onto that queue. It always bumps `stats.arrived`.

- [ ] **Step 5: Implement `tick` as an event loop up to `sim.t + min(dt, 50)`.**
  - Events, in time order: arrivals (Poisson and pending), step completions (`inst.stepEnd`), and in request mode the queue-delay wake-ups. On a tie, step completions go first.
  - An idle instance (`stepEnd === null`) gets scheduled at the current event time.
  - The next step starts at the previous `stepEnd`, so no time is lost between steps.

- [ ] **Step 6: Implement continuous scheduling (`batching === 'continuous'`).** The rule, per step:

```
decode  = running seqs with prefillDone >= prefillTarget        (1 token each)
while kvUsed + decode.length*kv > kvBudget: preempt the most recently admitted running seq
budget  = maxNumBatchedTokens - decode.length
prefill = for running seqs still prefilling (oldest first), then queue head while
          running.length < maxNumSeqs and kvUsed + chunk*kv <= kvBudget:
          chunk = min(prefillTarget - prefillDone, budget); budget -= chunk   (admit sets tAdmit)
kvRead  = sum over seqs in the step of their kvTokens
stepEnd = start + stepTimeMs(profile, model, sum(chunks), decode.length, kvRead)
```

  At step completion:
  - Prefill chunks add `prefillDone` and `kvTokens`.
  - A seq whose prefill just completed emits its first token: `generated += 1`, `tFirst ??= stepEnd`, `kvTokens += 1`.
  - Decode seqs do `generated += 1` and `kvTokens += 1`.
  - A seq with `generated >= output` becomes `done` at `tDone = stepEnd`. Free its `kvTokens`, push it to `sim.finished` and bump `stats.finished`.
  - Log the tokens made this step into `tokLog`.
  - Recompute `kvUsed` as `sum(kvTokens) * kv`.

  Preempting a seq:
  - Free its KV, set `prefillTarget = prompt + generated` and `prefillDone = 0`, bump `preemptions` and `stats.preemptions`, then `unshift` it onto its instance's queue.
  - `tFirst` stays (its streamed tokens were already sent).

- [ ] **Step 7: Run** `node --test tests/sim.test.mjs`. Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: router, event loop and vLLM-style continuous batching with KV preemption"
```

---

### Task 3: Request-level batching and live mode switch

**Files:**
- Modify: `assets/sim-engine.js`
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: `createSim`, `tick`, `enqueue`, `PRESETS` (Task 2).
- Produces: `setBatching(sim, mode: 'continuous'|'request') -> void`. It pushes `{ t, label: 'continuous on' | 'request-level on' }` onto `sim.events`.

- [ ] **Step 1: Write the failing tests.**

```js
test('request-level batch size is capped by the up-front KV reservation', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'request',
                            config: { gpuMemUtil: 0.45 }, traffic: { rate: 0, bursts: false } });
  for (let k = 0; k < 6; k++) E.enqueue(sim, { prompt: 2000, output: 50 });
  E.tick(sim, 30);                                  // past maxQueueDelayMs
  assert.equal(sim.instances[0].running.length, 2); // 0.94e9 / ((2000+1024)*131072) = 2.37
});
test('a request-level batch holds finished sequences as idle slots until its longest one ends', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1, batching: 'request', traffic: { rate: 0, bursts: false } });
  const short = E.enqueue(sim, { prompt: 100, output: 3 });
  const long = E.enqueue(sim, { prompt: 100, output: 300 });
  run(sim, 600);
  assert.equal(short.state, 'idle');
  assert.equal(sim.instances[0].running.length, 2);
  run(sim, 10000);
  assert.equal(long.state, 'done');
  assert.equal(sim.instances[0].running.length, 0);
});
test('continuous batching beats request-level (same seed, tab 01 preset)', () => {
  const a = E.createSim({ ...E.PRESETS.batching, seed: 7, batching: 'continuous' }); run(a, 60000);
  const b = E.createSim({ ...E.PRESETS.batching, seed: 7, batching: 'request' }); run(b, 60000);
  assert.ok(E.metrics(a).ttftP99 * 2 <= E.metrics(b).ttftP99);
  assert.ok(E.metrics(a).tokPerSec > E.metrics(b).tokPerSec);
});
test('toggling modes mid-flight loses and duplicates nothing', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 8 });
  for (let k = 0; k < 6; k++) { run(sim, 10000); E.setBatching(sim, k % 2 ? 'continuous' : 'request'); }
  sim.arrivalsOn = false; sim.pending = [];
  run(sim, 240000);
  assert.equal(sim.stats.arrived, sim.stats.finished + sim.stats.rejected);
  assert.equal(new Set(sim.finished.map(r => r.id)).size, sim.finished.length);
  assert.equal(sim.events.length, 6);
});
```

  The continuous-vs-request test calls `E.metrics`. Give it a minimal version now that computes `ttftP99` and `tokPerSec` as Task 4 defines them; Task 4 completes the rest.

- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement request-level scheduling (`batching === 'request'`).**
  - **Forming a batch:** only when `running` is empty, and only when the queue holds at least `maxBatch` requests or the oldest has waited `maxQueueDelayMs`. Take requests from the queue head while `count < maxBatch` and `(count+1) * (maxPromptInBatch + maxTokens) * kv <= kvBudget`. Set `kvUsed` to that reservation.
  - **First step:** a padded prefill: `prefillTokens = n * maxPromptInBatch`. At its end every seq gets its first token.
  - **Decode steps:** `decodeSeqs = n` (static batches keep computing idle slots) and `kvTokensRead = n * (maxPromptInBatch + stepsSoFar)`.
  - **When a seq reaches its output:** it becomes `idle`, gets `tDone`, and is pushed to `sim.finished` and counted in `stats.finished` right then (exactly once, so batch end and mode switches never count it again), but it stays in `running`.
  - **Batch end:** when every seq is idle, clear `running` and free the reservation.

- [ ] **Step 4: Implement `setBatching`.**
  - Set the mode and push the event.
  - Switching to `continuous`: drop idle seqs from `running` and recompute `kvUsed` from the actual `kvTokens`.
  - Switching to `request`: the seqs already running finish as a legacy batch, and no new batch forms until `running` is empty.
  - The preemption rule from Task 2 stays active in both modes as the safety net for the KV invariant.

- [ ] **Step 5: Run** `node --test tests/sim.test.mjs`. Expected: all pass. If the continuous-vs-request test misses the 2× gap, lower `PRESETS.batching.traffic.rate` (never `maxBatch`) and note the final value in the commit message.

- [ ] **Step 6: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: request-level batching with up-front KV reservation, live mode switch"
```

---

### Task 4: Drain, play state, metrics and formatting

**Files:**
- Modify: `assets/sim-engine.js`
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - `setArrivals(sim, on: boolean)`: off clears `pending` and stops Poisson arrivals; on reschedules the next arrival from `sim.t`.
  - `sendBurst(sim, n)`: adds n arrival times over the next 450 ms, even while arrivals are off.
  - `isDrained(sim) -> boolean`: arrivals off, nothing pending, and every queue and `running` empty.
  - `playState(sim, frozen: boolean) -> 'running'|'draining'|'stopped'`.
  - `metrics(sim) -> { ttftP50, ttftP99, tpotMs, tokPerSec, kvFrac, costPer1M, rejected }`. Values are `null` until there's data.
  - `fmt = { ms(v), tok(v), pct(v), usd(v) }`, each returning `'–'` for `null`.
  - `GPU_HOUR_USD` and `GPU_HOUR_SOURCE`.

- [ ] **Step 1: Write the failing tests.**

```js
test('pause drains: in-flight work finishes and nothing new arrives', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 4 });
  run(sim, 20000);
  const arrived = sim.stats.arrived;
  E.setArrivals(sim, false);
  assert.equal(E.playState(sim, false), 'draining');
  run(sim, 120000);
  assert.equal(sim.stats.arrived, arrived);
  assert.ok(E.isDrained(sim));
  assert.equal(E.playState(sim, false), 'stopped');
  assert.equal(sim.stats.arrived, sim.stats.finished + sim.stats.rejected);
});
test('a burst while paused is served without restarting the flow', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 4 });
  E.setArrivals(sim, false); run(sim, 120000);
  const before = sim.stats.arrived;
  E.sendBurst(sim, 10); run(sim, 60000);
  assert.equal(sim.stats.arrived, before + 10);
  assert.ok(E.isDrained(sim));
  assert.equal(sim.arrivalsOn, false);
});
test('play resumes arrivals', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 4 });
  E.setArrivals(sim, false); run(sim, 120000);
  const before = sim.stats.arrived;
  E.setArrivals(sim, true); run(sim, 5000);
  assert.ok(sim.stats.arrived > before);
  assert.equal(E.playState(sim, false), 'running');
});
test('frozen (reduced motion) reports stopped', () => {
  assert.equal(E.playState(E.createSim({ ...E.PRESETS.batching, seed: 4 }), true), 'stopped');
});
test('metrics are null before data and format as –', () => {
  const m = E.metrics(E.createSim({ ...E.PRESETS.batching, seed: 5 }));
  assert.equal(m.ttftP99, null);
  assert.equal(E.fmt.ms(m.ttftP99), '–');
  assert.equal(E.fmt.usd(m.costPer1M), '–');
});
test('formatting', () => {
  assert.equal(E.fmt.ms(95.4), '95ms');
  assert.equal(E.fmt.ms(1240), '1.24s');
  assert.equal(E.fmt.tok(6812.3), '6,812 tok/s');
  assert.equal(E.fmt.pct(0.614), '61%');
  assert.equal(E.fmt.usd(0.1234), '$0.12 / 1M tok');
});
test('finished requests are pruned so memory stays bounded under burst spam', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 9 });
  for (let k = 0; k < 20; k++) E.sendBurst(sim, 24);
  run(sim, 180000);
  assert.ok(sim.finished.length <= 500);
  sim.instances.forEach(i => assert.ok(i.queue.length <= sim.cfg.queueCap));
});
```

- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - `playState`: `'stopped'` if frozen, or if arrivals are off and the sim is drained. `'draining'` if arrivals are off and it isn't drained. Otherwise `'running'`.
  - `metrics`:
    - TTFT p50 and p99 (nearest rank) over `tFirst - t0` of requests whose first token came in the last 30 s, at most 200 of them.
    - `tpotMs`: the mean of `(tDone - tFirst) / (generated - 1)` over finished requests in the same window with `generated > 1`.
    - `tokPerSec`: tokens in `tokLog` over the last 3 s, divided by 3.
    - `kvFrac`: `sum(kvUsed) / sum(kvBudget)`.
    - `costPer1M`: `GPU_HOUR_USD * gpuCount / 3600 / tokPerSec * 1e6`, where `gpuCount` is 1 in PR 1. It's `null` while `tokPerSec` is 0 or `null`.
  - Pruning: keep the last 500 entries of `sim.finished`.
  - `GPU_HOUR_USD`: look up a current public on-demand price for one H100 80GB. Put the URL and the date you checked in `GPU_HOUR_SOURCE` and a comment.

- [ ] **Step 4: Run** `node --test tests/sim.test.mjs`. Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: pause as drain, play state, LLM metrics and formatting"
```

---

### Task 5: The page: panel markup, tab shell, canvas, controls

**Files:**
- Create: `assets/sim.js`
- Modify, `index.html`:
  - CSS: the `#simbox` and `#sim` rules (~line 330) and the 640px `#sim` rule (~line 602).
  - Panel markup: `<div class="panel js-only" id="simbox">` through the `.cap` line (~682–701).
  - Script: section 2 (~1215–1414), and the script tags at the end of `<body>`.
- Test: `tests/test_page.py` (new class `Simulator`), `tests/test_render.py` (new class `SimRender`).

**Interfaces:**
- Consumes: everything `SimEngine` exports (Tasks 1–4).
- Produces, as DOM contracts for PRs 2–5:
  - `#simbox`, `#sim` (canvas), `#sim-play`, `#sim-burst`.
  - Tabs: `.sim-tabs[role=tablist]` with `button[role=tab][data-tab][aria-controls]`, and `.sim-lesson[role=tabpanel][data-tab]`.
  - Batching control: `[role=radiogroup] button[role=radio][data-batching]`.
  - Footer: `#m-ttft50`, `#m-ttft99`, `#m-tpot`, `#m-thr`, `#m-kv`, `#m-cost`, `#m-503`, and `#m-503-wrap` (hidden until > 0).

- [ ] **Step 1: Write the failing page tests.** Add a `Simulator` class to `tests/test_page.py`:

```python
class Simulator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = parse()
        cls.box = find_all(cls.doc, id="simbox")[0]

    def test_scripts_in_order(self):
        srcs = [s.attrs.get("src") for s in find_all(self.doc, "script") if s.attrs.get("src")]
        self.assertLess(srcs.index("assets/sim-engine.js"), srcs.index("assets/sim.js"))
        for s in find_all(self.doc, "script"):
            if s.attrs.get("src", "").startswith("assets/sim"):
                self.assertIn("defer", s.attrs)

    def test_inline_sim_removed(self):
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("function sim()", page)
        self.assertNotIn("sim-batch", page)

    def test_footer_metrics(self):
        for i in ("m-ttft50", "m-ttft99", "m-tpot", "m-thr", "m-kv", "m-cost", "m-503"):
            self.assertEqual(len(find_all(self.box, id=i)), 1, i)
        self.assertIn("hidden", find_all(self.box, id="m-503-wrap")[0].attrs)

    def test_tab_shell(self):
        lists = find_all(self.box, role="tablist")
        self.assertEqual(len(lists), 1)
        tabs = find_all(lists[0], "button", role="tab")
        self.assertEqual([t.attrs.get("data-tab") for t in tabs], ["batching"])
        for t in tabs:
            panel = find_all(self.box, id=t.attrs.get("aria-controls"))[0]
            self.assertEqual(panel.attrs.get("role"), "tabpanel")
        radios = find_all(self.box, "button", role="radio")
        self.assertEqual([r.attrs.get("data-batching") for r in radios], ["request", "continuous"])
        self.assertEqual([r.attrs.get("aria-checked") for r in radios], ["false", "true"])

    def test_controls(self):
        for i in ("sim-play", "sim-burst"):
            self.assertEqual(len(find_all(self.box, "button", id=i)), 1, i)
```

  And a render test in `tests/test_render.py`:

```python
class SimRender(unittest.TestCase):
    def test_metrics_filled_after_warmup(self):
        doc = parse(dump_dom("?today=2026-10-23"))
        self.assertRegex(one(doc, id="m-ttft99").text(), r"\d")
        self.assertRegex(one(doc, id="m-thr").text(), r"tok/s")
        self.assertEqual(one(doc, id="sim-play").text().strip(), "❚❚")
```

- [ ] **Step 2: Run** `python3 -m unittest discover -s tests`. Expected: the 5 `Simulator` tests and `SimRender` FAIL, and everything else passes.

- [ ] **Step 3: Replace the panel markup.**
  - Header: live dot, `inference.sim`, and the note `· Llama 3 8B on one H100 · real time`. Controls: `#sim-play` (`❚❚`) and `#sim-burst` (`send burst`). The max batch slider and bursty checkbox are removed; they come back in the sandbox in PR 5.
  - `.sim-tabs[role=tablist][hidden]`: one `button[role=tab][data-tab=batching][aria-controls=sim-tab-batching][aria-selected=true]` labelled `01 batching`. It stays hidden while there's one tab, and PR 2 un-hides it.
  - `#sim-tab-batching.sim-lesson[role=tabpanel][data-tab=batching]`, with this lesson (draft copy, Omar reviews in the PR): `<b>Continuous batching.</b> A request-level server reserves memory for the longest possible reply and runs each batch until its slowest request finishes. vLLM-style continuous batching lets requests join and leave at every step. Flip it and watch p99 time to first token.` Plus the control `<div class="seg" role="radiogroup" aria-label="Batching">` holding `request-level` (`data-batching=request`) and `continuous` (`data-batching=continuous`, `aria-checked=true`) radio buttons.
  - The canvas `#sim`, with `aria-label="Animated simulation: requests are routed to an LLM server on one H100 and batched step by step"`.
  - The footer with the seven metric slots in Interfaces order. Labels: `TTFT p50`, `TTFT p99`, `TPOT`, `throughput`, `KV cache`, `cost`, `rejected`. Give the cost span `title="H100 at $X/h, " + source` (filled by JS).
  - Caption `.cap.js-only` (draft): `A model of LLM serving, not a benchmark: Llama 3 8B on one H100, step times from the H100's specs. Flip the batching mode, send a burst, then pause and watch it drain.`

- [ ] **Step 4: Add the CSS.**
  - Port the `.tabs`, `.lesson` and `.seg` rules from the approved mockup (`.superpowers/brainstorm/43741-1792954740/content/sim-layout.html`, local only), renamed to `.sim-tabs`, `.sim-lesson` and `.seg`.
  - Add `.seg button` styles matching `.p-ctrl button`.
  - `#sim`: keep 260px tall (230px at 640px), and set `cursor: default`. Click-to-burst is gone; click-to-follow arrives in PR 4.

- [ ] **Step 5: Delete inline section 2 and add the script tags.**
  - Replace the whole section-2 block (from its `/* ===` banner through the end of `(function sim() { … })();`) with a stub banner: `2. Inference simulator: lives in assets/sim-engine.js (model) and assets/sim.js (drawing and controls)`. This keeps the section numbering.
  - Add `<script src="assets/sim-engine.js" defer></script><script src="assets/sim.js" defer></script>` before `assets/speaking.js`.

- [ ] **Step 6: Implement `assets/sim.js`**, an IIFE using `window.SimEngine` as `E`. Move and adapt today's helpers from section 2 (`rr`, `mix`, `waitColor`, the dot grid, `resize` with DPR ≤ 2, ResizeObserver, IntersectionObserver plus `visibilitychange`, and the `frame` loop with dt ≤ 50).
  - **Startup and tabs.**
    - `switchTab(id)` builds the sim with `E.createSim({ ...E.PRESETS[id], seed: random })`, then warms it with 500 × `E.tick(sim, 16)` (8 s), updates the metrics and draws.
    - The page calls `switchTab('batching')` on load.
    - Tabs get roving `tabindex` with Left/Right arrows.
  - **Play button.**
    - `frozen` starts as `REDUCE`.
    - It renders `E.playState(sim, frozen)`: running → `❚❚` with `aria-label="Pause: stop new requests and let in-flight ones finish"`. Draining → `draining…`. Stopped → `▶ play`.
    - Toggle `#simbox.paused` (which turns the live dot gray) when stopped.
    - Click while running → `E.setArrivals(sim, false)`. Otherwise set `frozen = false` and call `E.setArrivals(sim, true)`.
  - **`#sim-burst`:** `E.sendBurst(sim, 24)`. If frozen, set `frozen = false` so it animates, but don't turn arrivals back on.
  - **Batching radios:** `E.setBatching(sim, value)`, then update `aria-checked`.
  - **Footer:** update every 300 ms from `E.metrics(sim)` through `E.fmt`. Show `#m-503-wrap` once `rejected > 0`.
  - **Canvas layout:** fractions of W as in the mockup: arrivals 0–0.19, router and queue lanes 0.19–0.44, GPU 0.49–0.84, stream 0.84–1, with a 26px sparkline strip at the bottom. Labels: `requests →`, `router · queue` (`queue` when W ≤ 560), `H100 · Llama 3 8B` (`H100` when W ≤ 560), `tokens →` (hidden when W ≤ 420).
  - **Queue dots:** coloured by wait, from base to warn at 500 ms and to bad at 2000 ms.
  - **Instance box:** `#161920` fill and `#2a2f38` stroke. Top-left: the profile name. Top-right: `running N · KV x%`, in warn colour above 80%.
  - **One row per running seq** (4px rows, 2.2px gap; draw `+N more` when they don't fit):
    - Prefill block: solid accent, `width = max(3, bw*0.25*min(1, prefillTarget/4000))`, filled in proportion while chunking.
    - Decode part: `rgba(122,162,255,0.4)` growing to `bw*min(1, generated/1000)`.
    - Idle slots (request mode): `rgba(139,145,156,0.35)`.
    - Finished rows flash green for 300 ms, then a green dot flies right.
    - A dashed free-slot row while continuous mode can admit and the queue is empty.
  - **KV bar:** 3px, along the box's bottom edge.
  - **Token particles:** green, flying right, capped at 30/s per instance and scaled to tok/s.
  - **Sparkline:** TTFT p99 sampled every 300 ms (110 samples), with green dashed markers labelled from `sim.events`.
  - **Frozen:** draw one static frame and don't run the loop.

- [ ] **Step 7: Run both suites.**
  - `python3 -m unittest discover -s tests`. Expected: all pass, including `Simulator`, `SimRender` and `test_local_links_resolve` (which checks the new `src` paths).
  - `node --test tests/*.test.mjs`. Expected: all pass.

- [ ] **Step 8: Check it manually in a real browser.** Serve with `python3 -m http.server 8765` and open `/index.html#about`. All of these must hold:
  - **(a)** At 1440 × 900, rows grow token by token. Switching to `request-level` shows idle gray slots, the queue growing and the TTFT p99 line climbing, with a `request-level on` marker. Switching back shows a `continuous on` marker and the line falling.
  - **(b)** Pause → `draining…` → `▶ play` once everything finishes, and the live dot turns gray. No new dots arrive meanwhile.
  - **(c)** `send burst` while stopped serves 24 requests and returns to `▶ play`.
  - **(d)** Play starts arrivals again.
  - **(e)** At 390 × 844, `document.documentElement.scrollWidth <= 390` and the labels shorten.
  - **(f)** With reduced motion emulated, the panel opens frozen on `▶ play`.
  - **(g)** Scroll away for 2 minutes, then back: no flood of arrivals.
  - **(h)** No console errors.

- [ ] **Step 9: Commit.**

```bash
git add assets/sim.js index.html tests/test_page.py tests/test_render.py
git commit -m "Sim v2: new panel with tab 01, LLM canvas, drain-aware play button and footer metrics"
```

---

### Task 6: Branch wrap-up

**Files:** none new.

- [ ] **Step 1: Run** `python3 -m unittest discover -s tests && node --test tests/*.test.mjs`. Expected: everything passes with zero failures.
- [ ] **Step 2: Review** `git diff main --stat`. Expected: only the files named in Tasks 1–5.
- [ ] **Step 3: Ask Omar** whether to push `sim-v2-engine` and open the PR. Don't push without his go-ahead. The PR body has no Claude attribution.

---

## Next plans (written after this one merges)

- **PR 2:** tab 02 (KV cache on one 3g.40gb instance, synthetic long prompts and replies, `gpuMemUtil` slider 0.5–0.95) and tab 03 (three models, `GPU per model | time-slicing | MIG`). Adds Llama 3.2 3B and 1B to `MODELS`, a time-slicing model and a GPU count above 1. Un-hides `.sim-tabs`. Carried over from PR 1's final review, fix these first:
  - Harden `pick()` in `assets/sim-engine.js` against `null`/`NaN` config values (the slider will feed it). Throw a clear error on unknown profile or model keys.
  - Add vLLM V1's rule that no waiting request is admitted in a step that preempted (tab 02 teaches preemption). Today a preempted sequence can be re-admitted in the same plan.
  - Scope the batching radios' roving-tabindex group per tabpanel in `assets/sim.js`. They're collected across all panels today.
  - Add an engine helper for the admission state the UI draws (`canAdmit`). The UI re-derives it today and reads engine internals (`inst.step`, `stepEnd`, `batch.steps`, `sim.cfg`, `r.prefillDone`).
  - A prompt too long for every instance counts as a 503; vLLM answers 400. It can happen on tab 02's 3g.40gb at low `gpuMemUtil`, so consider a separate count.
- **PR 3:** tab 04, a script in `scripts/` that cuts `assets/sim/azure-conv.json` from the Azure 2023 conversation trace, refitted length distributions, and the CC-BY credit.
- **PR 4:** tab 05 (two H100 replicas, `kill a GPU`, autoscaler with a labelled cold start), follow a request (canvas click and a `follow a request` button), and the config drawer (vLLM flags or Triton `config.pbtxt`).
- **PR 5:** sandbox (every knob, the MIG layout chips, round-robin routing), terminal prompt, SLO challenge, cost meter tooltip.
