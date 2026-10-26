# inference.sim v2, PR 3: tab 04, model routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tab 04. A gateway's System1 model scores each request, and the request then goes to a small model (Llama 3.2 1B) or a large model (Llama 3 8B on-prem, or an API model billed per token), so the visitor sees routing cut cost and an aggressive threshold misroute hard queries.

**Architecture:** The engine (`assets/sim-engine.js`) gains three things:
- a two-hop request: a scoring hop on the System1 instance, then a serving hop on the small or large instance;
- a hidden difficulty per request, a noisy score and a live threshold;
- an API instance kind, with fixed latency, per-token spend and no GPU.

PR 3 starts by putting the page's reads of engine internals behind engine helpers. The page (`assets/sim.js`, `index.html`) adds the tab, its two controls, footer items and the router and API boxes.

**Tech Stack:** Plain ES5-style JavaScript (no build step), canvas 2D, `node:test`, Python `unittest` (`tests/pagecheck.py`, `tests/render.py`).

**Spec:**
- `docs/superpowers/specs/2026-10-26-inference-sim-v2-routing-design.md` (this tab);
- `docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md` (the whole sim).

Branch: `sim-v2-routing`, stacked on `sim-v2-tabs-02-03` (PR #17, unmerged).

## Global Constraints

- **Stack and idiom:** no build step. Page idiom is `var`, `function`, IIFEs, `'use strict'`, `Object.assign` (no spread in browser code). The engine is DOM-free (`module.exports` in Node, `window.SimEngine` in the browser).
- **Visual language:** the dark panel, `--p-*` colours, Geist Mono labels, and only the existing palette plus alpha variants. New DOM text is 0.72rem or larger. Canvas labels keep the existing canvas sizes (9–10px).
- **Unchanged:** hardware, existing model numbers, `DEFAULTS`, `CTX_SWITCH_LOSS`, and the tab 01–03 presets and their tests. Tabs 01–03 must look and behave as before.
- **Clock:** real time.
- **On-prem layout:** one H100, MIG `3g.40gb` + `2g.20gb` + `1g.10gb`; one 1g slice stays free.
  - the large model `llama-3-8b` on 3g;
  - the small model `llama-3.2-1b` on 2g;
  - the System1 model on 1g.
- **API layout:** the same H100 with System1 on 1g and the small model on 2g. The large model is an API instance (no GPU).
- **System1 model:** a model entry `system1` labelled `System1 model`, short label `S1`, with Llama 3.2 1B's numbers (1.24e9 params, 2.47 GB, 32768 bytes of KV per token, context 131072). It prefills the prompt and outputs one token, the score.
- **Routing:** `score >= threshold` goes to the large model, otherwise the small model. The threshold runs 0 to 1, step 0.05. At 0 everything goes to the large model; at 1 everything goes to the small model.
- **Difficulty:**
  - Every request has a hidden `difficulty` in [0, 1]; "hard" means `difficulty >= hardCut`; about 20–30% are hard.
  - Score = clamp(difficulty + Gaussian noise, 0, 1), from the seeded RNG.
  - Schedulers never read difficulty.
  - **Misrouted** = a hard request served by the small model.
- **TTFT** is measured from arrival to the first token of the answer. It includes the System1 hop and never counts the router's own token. Router tokens aren't output tokens: they're excluded from throughput and cost.
- **Billing:** the H100 is billed in full in both modes (`gpuCount` counts physical GPUs; API instances aren't GPUs).
- **API price:** a cited mid-tier API model, such that at a 75/25 small/large split the API bill is at least about 70% of the blended cost. Latency constants come from a cited public benchmark. It's labelled generically as "API model".
- **Blended cost per 1M output tokens:** (GPU_HOUR_USD × gpuCount / 3600 + API $/s) / output tok/s × 1e6.
- **Tab 04 SLOs** (TTFT p99, coloured in the box headers as in tab 03): `llama-3-8b` 2000 ms, `api` 2000 ms, `llama-3.2-1b` 1000 ms.
- **Controls:**
  - The threshold changes live: no redeploy, it affects requests scored from then on.
  - The on-prem/API switch redeploys.
  - A tab switch resets both to their defaults: on-prem, the default threshold.
- **Commits:** no Claude co-author or attribution lines.
- **Both suites pass:** `python3 -m unittest discover -s tests` and `node --test tests/*.test.mjs`.

## Review Focus

1. **Moving the threshold mid-run under load:** requests already scored keep their target; nothing is lost or counted twice. → Task 2 test "threshold changes affect only requests scored afterwards; conservation holds".
2. **Pause and drain with requests between hops** (scored, not yet queued at their target): drain waits for them and finishes. → Task 2 test "drain waits for requests between hops".
3. **API mode with everything sent to the API:** no queue and no rejections at the API, and TTFT about the API's base latency plus the System1 hop. → Task 3 test "the API instance never queues or rejects".
4. **Switching on-prem ↔ API mid-run:** a clean redeploy, the API box drawn, and no dots or rows carried over. → Task 6 manual check (c).
5. **Tab 04 on a 390px phone:** three boxes, two controls and the extra footer items; legible, with no horizontal scroll. → Task 6 manual check (d).

---

### Task 1: Engine helpers for what the page draws

**Files:**
- Modify: `assets/sim-engine.js` (new exported helpers)
- Modify: `assets/sim.js`: `stepChunks`, `drawRow`, `header`, and any other read of `inst.step`, `inst.stepEnd`, `inst.batch` or `sim.cfg`.
- Test: `tests/sim.test.mjs`, `tests/test_page.py`

**Interfaces:**
- Produces, exported:
  - `prefillProgress(sim, inst, r) -> number in [0,1]`: the share of `r`'s prefill done by now, including the in-flight share of its chunk in the current step.
  - `slotSteps(inst) -> number`: decode steps the current request-level batch has run, 0 when none. Used for idle-slot bars.
  - `stretchNow(inst) -> number`: the current step's stretch, 1 when idle or not time-sliced.

- [ ] **Step 0:** Branch check. You're on `sim-v2-routing`. Don't create or switch branches.
- [ ] **Step 1: Write the failing tests.**
  - Node, with direct engine runs:
    - `prefillProgress` is 0 before admission, strictly between 0 and 1 mid-chunk, and 1 after prefill.
    - `slotSteps` matches the steps a request-level batch has run (use PR 2's two-request batch scenario).
    - `stretchNow` is 2 for a time-sliced instance with a busy neighbour, and 1 when alone.
  - Python: `assets/sim.js` contains none of `inst.step`, `.stepEnd`, `inst.batch` or `sim.cfg`.
- [ ] **Step 2: Run** both suites. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the three helpers in the engine, and switch `sim.js` to them. `E.canAdmit` already exists. There must be no visible change.
- [ ] **Step 4: Run** both suites (all pass). Spot-check tabs 01–03 in the browser: rows, idle slots, the ×3 marker and the free slot look as before.
- [ ] **Step 5: Commit**, with the spec amendments that are already in the working tree.

```bash
git add assets/sim-engine.js assets/sim.js tests/sim.test.mjs tests/test_page.py docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md docs/superpowers/specs/2026-10-26-inference-sim-v2-routing-design.md docs/superpowers/plans/2026-10-26-inference-sim-v2-pr3-routing.md
git commit -m "Sim v2: engine helpers for step progress, idle slots and stretch, so the page stops reading engine internals"
```

---

### Task 2: The System1 hop, difficulty, threshold and misroutes

**Files:**
- Modify: `assets/sim-engine.js`
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - **`MODELS.system1`:** per Global Constraints.
  - **The preset field** `routing: { small: 'llama-3.2-1b', large: 'llama-3-8b' | 'api', threshold: number, hardCut: number, noise: number }`.
  - **`sim.routing`:** `{ small, large, threshold, hardCut, noise }`, or null outside tab 04.
  - **New request fields:** `difficulty`, `score` (null until scored), `tScored` (when the System1 hop finished, null until then), `hop: 'score' | 'serve'`, `target: 'small' | 'large' | null`.
  - **`setThreshold(sim, x)`:** sets `sim.routing.threshold` and pushes `{ t, label: 'threshold 0.60' }` onto `sim.events`. It affects requests scored afterwards.
  - **New counters** in `sim.stats`: `routedSmall`, `routedLarge` and `misrouted`.
  - **`metrics(sim)` adds**, over the last 30 s:
    - `smallShare`: routed small / routed;
    - `misroutedShare`: misrouted / hard routed.

    Both are `null` outside tab 04 or with no data.
  - **`PRESETS['routing-onprem']`:**
    - instances in the order System1 (1g.10gb), small (2g.20gb), large (3g.40gb), all `gpu: 0`;
    - one stream `{ model: 'system1', rate, bursts, lengths: LENGTHS }`;
    - `slo` per Global Constraints;
    - `routing` with `large: 'llama-3-8b'`.

**The two-hop rule:**
- Arrivals route to the System1 instance (by model, as today), with `hop: 'score'`.
- When the System1 model produces its single token, the request isn't finished. Instead:
  - it gets `score`;
  - it's counted in `routedSmall` or `routedLarge` (and in `misrouted` if hard and sent small);
  - its prefill, decode and KV fields are reset;
  - it's set to `hop: 'serve'` and enqueued on the target instance (a 503 if that can't take it).
- No `ttftLog` entry and no `tokLog` tokens are written on the scoring hop.
- `stats.finished` counts only serving-hop completions.
- The serving hop is enqueued at the moment the System1 step completes, so a request is always in some queue or running list. `isDrained` needs no change, and the drain test checks that a drain finishes with requests spread across both hops.

- [ ] **Step 1: Write the failing tests.**
  - **TTFT includes the System1 hop:** with one request and rate 0, its `tFirst - t0` is greater than its serving-hop TTFT alone (compare against an 8B-only sim). `stats.finished` is 1.
  - **The router's token is not output:** the `tokLog` total equals the request's answer tokens.
  - **Routing by threshold:** at threshold 0, every request goes large; at threshold 1, every request goes small.
  - **Misrouted:** with noise 0 and the threshold at `hardCut`, misrouted is 0. With noise 0 and threshold 1, misrouted equals the hard count.
  - **Hard share:** over 2000 arrivals (seeded), the hard share is between 0.2 and 0.3.
  - **Determinism:** the same seed gives identical scores.
  - **Live threshold:** threshold changes affect only requests scored afterwards, and conservation holds. Change the threshold 5 times over 60 s at rate 8, then drain: `arrived === finished + rejected`, and each request's `target` matches the threshold in force when it was scored.
  - **Drain:** it waits for requests between hops and finishes.
- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement as above.** Difficulty and noise are seeded from `sim.rng`. The builder picks the difficulty distribution so that 20–30% is hard (a power of a uniform draw is enough). Choose starting values for `hardCut`, `noise`, `threshold` and `rate` that Task 4 will calibrate.
- [ ] **Step 4: Run** both suites. Expected: all pass, including every PR 1 and PR 2 test, unchanged.
- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: System1 scoring hop, hidden difficulty, live routing threshold and misroute counts"
```

---

### Task 3: The API model

**Files:**
- Modify: `assets/sim-engine.js`
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - **`MODELS.api`:** `{ label: 'API model', short: 'API' }`, plus a profile `'api'`.
  - **An API instance** (`profile: 'api'`, `model: 'api'`) has:
    - `api: true`, `fits: true`, no GPU (not counted in `gpuCount`);
    - unlimited concurrency, never queueing or rejecting;
    - no KV (excluded from `kvFrac`).
  - **API timing:** a request entering at `t` gets its first token at `t + API.baseMs + prompt * API.msPerInputToken`, then one token every `API.tpotMs`. Its first token logs TTFT as usual, and its tokens go into `tokLog` as they're made (per token, or batched at most 100 ms apart).
  - **API spend:** `sim.stats.apiUsd += prompt * API.inputPer1M / 1e6` when it enters, and `+= API.outputPer1M / 1e6` for each output token.
  - **Constants:** `API = { inputPer1M, outputPer1M, baseMs, msPerInputToken, tpotMs, source }`, with cited values. `API_SOURCE` is exported for the page's tooltip.
  - **`metrics(sim)` adds** `apiUsdPerHour` (over the last 30 s, null without an API instance). `costPer1M` becomes the blended formula from Global Constraints.
  - **`PRESETS['routing-api']`:** the same as `routing-onprem`, but the large instance is `{ profile: 'api', model: 'api' }` and `routing.large` is `'api'`.

- [ ] **Step 1: Write the failing tests.**
  - **Timing:** one request (prompt 1000, output 50) to an API-only route gives `tFirst - tScored == baseMs + 1000 * msPerInputToken` and `tDone - tFirst == 49 * tpotMs` (`near`).
  - **Spend:** `apiUsd` equals 1000 × in/1e6 + 50 × out/1e6.
  - **Never queues or rejects:** 500 requests at once at threshold 0 in `routing-api` give no rejections and no API queue.
  - **No GPU:** `gpuCount` is 1 for both routing presets, and `kvFrac` ignores the API instance.
  - **Blended cost:** `costPer1M` equals the formula, using `metrics`' own `tokPerSec` and `apiUsdPerHour`.
  - **The price rule:** at a 75/25 split (threshold set so that `smallShare` is about 0.75, seeds 1–5, 60 s), the API share of the blended $/s is at least 0.7.
- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Look up a current public list price for a mid-tier API model and a public latency benchmark, and cite both, with the date checked, in `API.source`. Keep the generic label on the page. If no cited price meets the 70% rule, report NEEDS_CONTEXT.
- [ ] **Step 4: Run** both suites. Expected: all pass.
- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: API model instance with fixed latency and per-token spend, blended cost"
```

---

### Task 4: Calibrate tab 04 against what a visitor sees

**Files:**
- Modify: `assets/sim-engine.js` (the routing presets' `rate`, bursts, `hardCut`, `noise` and default `threshold`, plus the difficulty distribution)
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: the calibrated presets and a short calibration comment that states only what the tests and measurements show.

**Visitor view** means an 8 s warm-up, then sampling every 300 ms for 30 s, with box p99 on the 30 s window, as the page does. All tests use seeds 1–10 unless stated.

- [ ] **Step 1: Write the failing tests.**
  - **On-prem, threshold 0:** the large box is red (p99 over 2000 ms) on at least 70% of samples (median over seeds), and `rejected` grows on at least 8 of 10 seeds within 2 min.
  - **On-prem, default threshold:** every box is green on at least 95% of samples (median), and `misroutedShare` is 0.05 or less (median).
  - **On-prem, threshold 1:** `misroutedShare` is 0.5 or more (median).
  - **On-prem cost:** `costPer1M` at the default threshold is below its value at threshold 0 (median over seeds, at 60 s), because more tokens are served on the same H100.
  - **API:** `apiUsdPerHour` falls from threshold 0 to the default to 0.9 (median over seeds), and every box is green at the default.
- [ ] **Step 2: Run** them. Expected: FAIL, or pass only with luck.
- [ ] **Step 3: Tune.**
  - Allowed knobs: `rate`, bursts, `hardCut`, `noise`, the difficulty distribution, the default threshold (keep it a multiple of 0.05) and the API constants within their cited sources.
  - Keep `LENGTHS`, the layout, the SLOs and all pinned numbers.
  - Record the final values in the commit message.
  - If no values within these knobs pass, report NEEDS_CONTEXT with per-seed numbers.
- [ ] **Step 4: Run** both suites. Expected: all pass. Report the test durations.
- [ ] **Step 5: Commit.**

```bash
git add assets/sim-engine.js tests/sim.test.mjs
git commit -m "Sim v2: calibrate tab 04 so routing shows its cost win and its misroute risk in the first 30 s"
```

---

### Task 5: The page: tab 04, its controls, its footer items

**Files:**
- Modify: `index.html` (the tab button and panel, footer items, CSS)
- Modify: `assets/sim.js` (`VIEWS`, `switchTab`, `deploy`, controls, `footer`)
- Test: `tests/test_page.py`

**Interfaces:**
- Consumes: `E.PRESETS['routing-onprem' | 'routing-api']`, `E.setThreshold`, `metrics().smallShare` / `misroutedShare` / `apiUsdPerHour`, `E.API_SOURCE`.
- Produces, as DOM contracts:
  - **Tab:** `button[role=tab][data-tab=routing]` (`<i>04</i> routing`), placed after `mig`.
  - **Panel:** `#sim-tab-routing`.
  - **Threshold:** a slider `#sim-route` (`min 0`, `max 1`, `step 0.05`, `value` = the default threshold) with `<output id="sim-route-v">`.
  - **Large-model switch:** radios `[role=radiogroup][aria-label="Large model"] button[role=radio][data-large=onprem|api]`, labelled `on-prem 8B` and `API model`.
  - **Footer:** `#m-small`, `#m-mis` and `#m-api`, in wraps (`#m-small-wrap`, `#m-mis-wrap`, `#m-api-wrap`) that are hidden outside tab 04. `#m-api-wrap` is also hidden in on-prem mode.

- [ ] **Step 1: Write the failing page tests.**
  - The tab order is `["batching", "kvcache", "mig", "routing"]`, with texts `["01 batching", "02 kv cache", "03 mig layout", "04 routing"]`.
  - The slider attributes, and the radios with their labels and order (`onprem` checked).
  - The three footer wraps exist and are hidden by default.
  - The lesson copy matches Step 3.
- [ ] **Step 2: Run** `python3 -m unittest discover -s tests`. Expected: the new tests FAIL.
- [ ] **Step 3: Add the markup.** The lesson draft (Omar approves the copy in the PR):

  `<b>Model routing.</b> A small System1 model scores every request, and only the hard ones go to the large model; the rest go to a 1B model that costs a fraction as much. Raise the threshold and cost falls, but push it too far and hard requests land on the small model and get worse answers. <span class="sim-note">Difficulty and answer quality are modelled, not measured.</span>`

  Labels: the slider is `send to the large model at score ≥`; the switch is labelled `Large model`.
- [ ] **Step 4: Implement the page logic in `assets/sim.js`.**
  - **`VIEWS['routing-onprem']`:**
    - note `· System1 model, Llama 3.2 1B and Llama 3 8B on one H100 · real time`
    - label `one H100 · MIG 3g+2g+1g`
    - narrow `H100 · MIG`
    - aria `Animated simulation: a System1 model scores each request and routes it to a small or a large model on one H100`
  - **`VIEWS['routing-api']`:**
    - note `· System1 model and Llama 3.2 1B on one H100, large model by API · real time`
    - label `H100 + API model`
    - narrow `H100 + API`
    - aria `Animated simulation: a System1 model routes each request to a small model on one H100 or to a large model behind an API`
  - **Tab switch:** `switchTab('routing')` resets the slider to the default threshold and the switch to on-prem, then calls `deploy('routing-onprem')`.
  - **Switch:** picking a mode → `deploy('routing-' + value)`, keeping the current threshold. `deploy` passes `routing: Object.assign({}, E.PRESETS[id].routing, { threshold: current })` in the `createSim` opts, so the warm-up already uses it and no event marker is pushed. `createSim` reads `opts.routing`, which Task 2 provides.
  - **Slider:** `input` updates the output (`toFixed(2)`); `change` calls `E.setThreshold(sim, +value)` (live, no redeploy).
  - **Footer:**
    - `#m-small` shows `fmt.pct(smallShare)` and `#m-mis` shows `fmt.pct(misroutedShare)`.
    - `#m-api` shows `$x.xx/h`, from `apiUsdPerHour`.
    - In API mode the cost span's tooltip adds the API price and `E.API_SOURCE`.
  - **Warm-up:** tab 04 uses tab 03's 40 s warm-up, since its boxes show a 30 s p99.
  - **Burst button:** in tab 04 it sends the burst to stream 0, so the bursts go through the router.
- [ ] **Step 5: Run** both suites. Expected: all pass.
- [ ] **Step 6: Commit.**

```bash
git add index.html assets/sim.js tests/test_page.py
git commit -m "Sim v2: tab 04 on the page, routing threshold, on-prem or API switch, routing footer items"
```

---

### Task 6: The canvas: router flow and API box

**Files:**
- Modify: `assets/sim.js` (`layout`, `sync`, `header`, `drawInstance`, key handling as needed)
- Modify: `index.html` (the `.sim-key` entry, if added)
- Test: `tests/test_page.py`

**Interfaces:**
- Consumes: the instance order [System1, small, large] (Task 2), `inst.api` (Task 3), and `E.prefillProgress` / `E.slotSteps` / `E.stretchNow` (Task 1).

- [ ] **Step 1: Write the failing page tests.**
  - `boxName` covers the routing roles: `System1`, `1B` and `8B`, or `API`.
  - The key gains no entry, or exactly one documented entry. Assert whichever you choose.
- [ ] **Step 2: Implement.**
  - **Box headers:**
    - The System1 box header reads `System1 · scoring` with its queue and running count. It has no p99, because its TTFT isn't user-facing.
    - The small and large box headers show `p99 x / target`, as in tab 03.
    - The API box header shows `API · $x.xx/h`, with its in-flight count instead of KV.
  - **Request flow:** a request's dot moves from the System1 box to its target's queue lane when scored. The existing per-id dots do this naturally; make sure nothing flashes or leaves a row behind on the hop.
  - **API box:**
    - Draw its requests as rows: a prefill block that fills over the API's first-token wait, then decode growing per token.
    - Show no KV bar, and no free-slot row.
  - **Sparkline:** threshold markers (`threshold 0.60`) show on it, like the mode markers.
- [ ] **Step 3: Run** both suites. Expected: all pass.
- [ ] **Step 4: Manual check** with Python Playwright (`channel="chrome"`, not the MCP browser). Screenshots go to `.playwright-mcp/pr3-*.png`.
  - **(a)** In tab 04 on-prem, the default threshold has every box green, and misrouted is at or near 0%.
  - **(b)** Drag the threshold to 0: the 8B goes red and requests get rejected. Drag it to 1: misrouted climbs and every box is green.
  - **(c)** Switch to API mid-run: a clean redeploy, the API box shows its spend, and API $/h falls as the threshold rises.
  - **(d)** At 390px: legible, no horizontal scroll.
  - **(e)** Tabs 01–03 are unchanged.
  - **(f)** No console errors.
- [ ] **Step 5: Commit.**

```bash
git add assets/sim.js index.html tests/test_page.py
git commit -m "Sim v2: draw the System1 hop and the API model box in tab 04"
```

---

### Task 7: Branch wrap-up

- [ ] **Step 1: Run** `python3 -m unittest discover -s tests && node --test tests/*.test.mjs`. Expected: everything passes with zero failures.
- [ ] **Step 2: Review** `git diff sim-v2-tabs-02-03 --stat`. Expected: only the files named in Tasks 1–6, the two specs and this plan.
- [ ] **Step 3: Ask Omar** whether to push and open the PR. It stacks on #17, so either merge #17 first or target `sim-v2-tabs-02-03`. The PR body has no Claude attribution.

## Decisions made in this plan (for Omar to check)

- **Two hops:** a request does two hops on real instances. The System1 model costs GPU time on its own 1g slice, and its time counts in the user's TTFT, so routing isn't free.
- **Small model's target:** 1000 ms (TTFT p99, System1 hop included). The large model and the API keep 2000 ms.
- **Misrouted** is shown as a share of hard requests over the last 30 s, rather than a running count, so it reacts when you move the slider.
- **Threshold timing:** the threshold applies when the slider is released (or on each key step), and is marked on the sparkline. The on-prem/API switch keeps the current threshold.
- **API tokens** are written into throughput as they're made, so API mode's tok/s and cost don't lag.
