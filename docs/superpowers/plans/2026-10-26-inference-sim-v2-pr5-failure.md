# inference.sim v2, PR 5: tab 06 failure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab 06 serves Llama 3 8B on two H100 replicas behind the router. A `kill a GPU` button fails one: its requests come back as client retries, redo prefill, p99 spikes and the survivor falls behind. An autoscaler switch brings a replacement H100 up after a cold start, and the queues drain.

**Architecture:**
- The DOM-free engine gains an instance lifecycle: up → down (killed) → starting → up. It adds `killGpu`, `setAutoscaler`, client retries of the dead instance's requests, a billed-GPU count that follows the lifecycle, and an `instanceStatus` helper for the page.
- A new preset, `failure`, is calibrated so the lesson shows in the first 30 s after a kill.
- The page adds tab 06 with the kill button, the autoscaler switch, failed and starting boxes, and a `retried` footer item.

**Tech Stack:** Plain ES5 browser JS (no build), Node `node:test` for the engine, Python `unittest` for the page.

**Spec:** `docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md` (tab 06 row, Behaviours, Left to the builder: "how the second GPU appears in tab 06 and how the cold start is shown"). Delivery was amended on 2026-10-26: follow-a-request and the config drawer move to their own PR (PR 6), and the sandbox becomes PR 7.

## Global Constraints

- **Stack and idiom:** no build step. Page idiom is `var`, `function`, IIFEs, `'use strict'`, `Object.assign`, with no spread in browser code. The engine is DOM-free. The page never reads `inst.step`, `.stepEnd`, `inst.batch` or `sim.cfg`; a guard test enforces this.
- **Visual language:**
  - The dark panel, the `--p-*` colours, Geist Mono labels, and only the existing palette plus alpha variants.
  - New DOM text is 0.72rem or larger. Canvas labels keep the existing sizes (9–10px).
- **Unchanged:** hardware, model numbers, `DEFAULTS`, `CTX_SWITCH_LOSS`, `LENGTHS`, and the tab 01–05 presets and their tests. Tabs 01–05 must look and behave as before.
- **Tab 06 setup:**
  - two `llama-3-8b` instances, each on its own `7g.80gb` H100 (`gpu: 0` and `gpu: 1`);
  - continuous batching, least-outstanding routing, and the autoscaler off (the spec's "my call");
  - SLO TTFT p99 `2000` ms, as for the 8B in tabs 03–05;
  - random traffic with `LENGTHS` and no bursts, at a rate set by Task 1's calibration (starting value 20 requests/s).
- **Kill:**
  - `kill a GPU` fails the highest-numbered GPU that's up. It's disabled while only one GPU is up.
  - A killed instance's running and queued requests go back to the router as client retries. Each keeps its id and its arrival time `t0`. Its KV, prefill progress and generated tokens are gone, so it redoes prefill and its reply starts over. `tFirst` is reset, and `retries` counts up.
  - A retry the router can't place is a 503.
- **Replacement:**
  - With the autoscaler on, each down instance becomes `starting` on a new GPU id (the next unused number) and comes up `COLD_START_MS` later in the same box position.
  - `COLD_START_MS = 30000`, labelled as an assumption: a warm spare node with the image cached, where vLLM loads 16 GB of weights and captures CUDA graphs. A fresh node takes minutes more.
  - Turning the autoscaler off cancels a pending start, and the instance goes back to down.
- **Billing:** `sim.gpuCount` counts the GPUs that are up or starting. A starting GPU is billed, a dead one isn't.
- **Git:** commits are authored by Omar Elcircevi, with no Co-Authored-By or Claude trailer anywhere.

## Review Focus

1. **Killing during a step:**
   - The step in flight is cancelled: no tokens are logged for the dead instance afterwards, and its KV shows 0.
   - The page doesn't crash drawing a down instance's empty rows.
   - Test: Task 1 Step 1, `a kill cancels the step in flight`.
2. **Pause, then kill:** while draining, the retries still drain, and `isDrained` turns true once they're done. Test: Task 1 Step 1, `retries drain while paused`.
3. **Autoscaler toggled off during a cold start:** the start is cancelled, the box goes back to failed, billing drops, and turning it on again restarts the full cold start. Test: Task 1 Step 1, `autoscaler off cancels a start`.
4. **A second kill after the replacement is up:** it works again, and GPU numbers keep counting up (H100 3, then H100 4). Test: Task 1 Step 1, `GPU ids count up`.
5. **Switching tabs mid-incident:** coming back to tab 06 resets it to two healthy GPUs with the autoscaler off. Test: Task 2 Step 1, a source check, plus manual check (d).

---

### Task 1: The instance lifecycle and the `failure` preset

**Files:**
- Modify: `assets/sim-engine.js`
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Produces:
  - **`E.PRESETS.failure`:**
    ```
    { instances: [{ profile: '7g.80gb', model: 'llama-3-8b', gpu: 0 }, { profile: '7g.80gb', model: 'llama-3-8b', gpu: 1 }],
      batching: 'continuous', slo: { 'llama-3-8b': 2000 }, autoscaler: false,
      traffic: { rate: FAILURE_RATE, bursts: false } }
    ```
  - **`E.killGpu(sim) -> number | null`:** fails the highest-numbered up GPU. It returns that GPU id, or null when only one is up.
    - It cancels that instance's step and empties its KV.
    - It retries the instance's running, then queued, requests through the router, in that order.
    - It pushes `{ t, label: 'H100 N killed' }`, where N is `gpu + 1`.
    - With the autoscaler on, it starts the replacement at once.
  - **`E.setAutoscaler(sim, on)`:** turning it on starts a replacement for every down instance and pushes `'autoscaler on'`. Turning it off cancels pending starts and pushes `'autoscaler off'`.
  - **`E.instanceStatus(sim, inst) -> { state: 'up' | 'down' | 'starting', gpu, readyInMs }`:** `readyInMs` is null unless the instance is starting.
  - **`sim.stats.retried`:** the number of retries made.
  - **`sim.autoscaler`:** a boolean.
  - **`sim.gpuCount`:** kept current through the lifecycle.
  - **Events:** a replacement pushes `'H100 N starting'` when it starts and `'H100 N up'` when it's ready.
  - **`E.COLD_START_MS`, `E.COLD_START_NOTE` and `E.FAILURE_RATE`.**
- **The instance lifecycle:**
  - Each instance gets `state`. The router's `canTake` checks `inst.up`, which is true exactly when `state === 'up'`.
  - The event loop gets a `'ready'` event at a starting instance's `readyAt`. At that point the instance is fresh: empty queue, running list and KV, with the same profile and model.
  - Replacing in place keeps the instance's index, so the page's per-box state stays valid.

- [ ] **Step 1: Write the failing tests** in `tests/sim.test.mjs`, using `failSim(seed, over = {})` = `E.createSim(Object.assign({}, E.PRESETS.failure, { seed }, over))`.
  - **`tab 06: killing a GPU retries its requests on the survivor`:**
    - Run 20 s, then `killGpu`.
    - It returns 1, and instance 1 is `down`.
    - Its queue and running list are empty.
    - Every request that was on it is now on instance 0 (or rejected). Each kept its `id` and `t0`, has `prefillDone === 0`, `generated === 0`, `tFirst === null` and `retries === 1`.
    - `sim.stats.retried` equals their count, and `sim.events` ends with `'H100 2 killed'`.
  - **`tab 06: a kill cancels the step in flight`:** kill while instance 1 has a step in flight (`stepTimeMs` > 0 and running non-empty). Then, at every tick for 5 s:
    - instance 1's `running` and `queue` stay empty and its `kvUsed` is 0;
    - no request's `inst` is 1;
    - `sim.stats.finished` only counts requests finished on instance 0.
  - **`tab 06: the kill button has nothing to kill with one GPU left`:** a second `killGpu` returns null, and nothing changes.
  - **`tab 06: billing follows the GPUs`:**
    - `gpuCount` is 2, then 1 after a kill.
    - It's 2 again while the replacement is starting, after `setAutoscaler(sim, true)`.
    - It stays 2 once the replacement is up.
  - **`tab 06: the autoscaler brings a replacement up after the cold start`:**
    - After `killGpu` and `setAutoscaler(sim, true)`, `instanceStatus` reads `starting` with `readyInMs` counting down from `COLD_START_MS` (±16).
    - It's `up` on `gpu` 2 after `COLD_START_MS`, and the router sends it requests within 1 s.
    - The events include `'H100 3 starting'` and `'H100 3 up'`.
  - **`tab 06: autoscaler off cancels a start`:**
    - Turn it off 10 s into the cold start. The instance is `down` and `gpuCount` is 1.
    - Turned on again, `readyInMs` is back to `COLD_START_MS`.
  - **`tab 06: GPU ids count up`:** kill, autoscale until up, then kill again. The killed GPU is 2 (shown as "H100 3"), and the next replacement gets gpu 3.
  - **`tab 06: retries drain while paused`:** `setArrivals(false)`, then `killGpu`. `isDrained` becomes true within 120 s, and every retried request finished or was rejected.
  - **`tab 06: tabs 01–05 never see the lifecycle`:** for every other preset, every instance's `instanceStatus` is `up`, and `sim.autoscaler` is false.
- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the new tests FAIL (`E.PRESETS.failure` undefined), and the rest pass.
- [ ] **Step 3: Implement the lifecycle** in `assets/sim-engine.js` as specified in the Interfaces block.
  - **A retry** resets the request the way `preemptNewest` does, plus `generated = 0`, `prefillTarget = prompt`, `tFirst = null` and `retries += 1`, then calls `place(sim, r)`.
  - **Comment the TTFT choice:** a retried request's TTFT is measured from its original `t0`, because that's the user's wait for the answer they finally get. A first token logged before the kill stays in the log, since the user did see it before the stream broke.
  - **`COLD_START_NOTE`:** `'assumed: a warm spare node with the image cached, where vLLM loads 16 GB of weights and captures CUDA graphs; a fresh node takes minutes more'`.
- [ ] **Step 4: Run** `node --test tests/sim.test.mjs`. Expected: all tests PASS.
- [ ] **Step 5: Calibrate `FAILURE_RATE`** with the visitor-view tests below. They use `visit()` with `PAGE.tab03WarmMs`, refresh every 300 ms, and take each box's p99 from `E.metrics(sim, 'llama-3-8b', PAGE.p99WindowMs)`.

  Tab 06 serves one model on two boxes, so the per-model p99 is the box colour. Start at 20 and move in steps of 1 until all three pass. Record the measured figures in a comment above `FAILURE_RATE`.
  - **`tab 06 as a visitor sees it: green before the kill`:** on seeds 1–10, green on ≥ 95% of refreshes over the 30 s after the open, on at least 9 of 10 loads.
  - **`tab 06 as a visitor sees it: a kill turns it red and, with the autoscaler off, the 503s keep coming`:**
    - On seeds 1–10, kill at the open.
    - It goes red within 15 s on ≥ 9 of 10 loads.
    - The 503 count 60 s after the kill exceeds the count 30 s after it on ≥ 9 of 10 loads.
  - **`tab 06 as a visitor sees it: with the autoscaler on, the replacement brings it back`:** on seeds 1–10, with the autoscaler on and a kill at the open:
    - green on every refresh from `COLD_START_MS + 20000` to `COLD_START_MS + 60000` after the kill, on ≥ 9 of 10 loads;
    - no new 503 in that span on ≥ 9 of 10 loads.
- [ ] **Step 6: Run** `node --test tests/*.test.mjs`. Expected: all tests PASS, including the tab 01–05 tests, unchanged.
- [ ] **Step 7: Commit** with the message "Sim v2: an instance lifecycle for tab 06: kill a GPU, client retries, an autoscaler with a cold start".

### Task 2: Tab 06 on the page

**Files:**
- Modify: `index.html` (tab button, panel, footer item)
- Modify: `assets/sim.js` (VIEWS, controls, box states, footer)
- Test: `tests/test_page.py` (class `Simulator`)

**Interfaces:**
- Consumes from Task 1: `E.PRESETS.failure`, `E.killGpu`, `E.setAutoscaler`, `E.instanceStatus`, `sim.stats.retried`, `sim.gpuCount`, `E.COLD_START_MS` and `E.COLD_START_NOTE`.
- **Markup:**
  - A tab `<button type="button" role="tab" id="sim-tabbtn-failure" data-tab="failure" aria-controls="sim-tab-failure" aria-selected="false"><i>06</i> failure</button>`, after 05.
  - A panel `#sim-tab-failure` (`role="tabpanel"`, `data-tab="failure"`, `hidden`) with the lesson `<p>`, then `.sim-ctls` holding:
    - `<button type="button" id="sim-kill">kill a GPU</button>`, styled like the `.seg` buttons, as one pill;
    - a `.seg` `role="radiogroup"` with `aria-label="Autoscaler"`, holding `data-autoscale="off"` ("autoscaler off", checked) and `data-autoscale="on"` ("autoscaler on").
- **Footer:** `<span id="m-retry-wrap" hidden>retried <b id="m-retry">0</b></span>` in `.p-foot`, shown only in tab 06.
- **Lesson copy (Omar approves in the PR):**

  "**Failure.** Two replicas of Llama 3 8B, each on its own H100, share the traffic. Kill one and its requests come back as client retries: their KV cache died with the GPU, so each redoes its prefill and starts its reply over, and p99 spikes. The survivor can't carry both GPUs' traffic alone, so its queue grows and requests get 503s. Turn the autoscaler on and a replacement H100 comes up after a cold start, and the queues drain."

  Then a `.sim-note`: "Cold start: 30 s, assumed (a warm spare node loading the weights); a fresh node takes minutes."
- **`VIEWS.failure`:** note `'· Llama 3 8B on two H100s · real time'`, label `'2 × H100 · Llama 3 8B'`, narrow `'2 × H100'`, aria `'Animated simulation: Llama 3 8B on two H100 replicas behind a router; one can be killed and replaced'`.
- **Behaviour:**
  - `switchTab('failure')` deploys `failure`, with the autoscaler off.
  - `#sim-kill` calls `E.killGpu(sim)` and redraws. It has `disabled` while `E.instanceStatus` shows only one `up` instance; check this every footer refresh.
  - The autoscaler radios call `E.setAutoscaler` (with `arrows()`, checked in `syncRadios`). There's no redeploy.
  - `retried` shows `sim.stats.retried`.
- **Box states:**
  - A `down` box draws its frame dashed in `COL.bad` at 0.5 alpha, with the header `H100 N · failed` and no rows.
  - A `starting` box draws its frame dashed in `COL.faint`, with the header `H100 N · starting 18s` (`readyInMs`, rounded up to whole seconds). Its KV bar shows the cold start's progress in `COL.faint`.
  - The canvas aria-label adds "H100 N failed" or "H100 N starting" after the per-box p99 words.

- [ ] **Step 1: Write the failing page tests:**
  - `test_tab06_exists`: the tab and panel exist with the ARIA above, after tab 05.
  - `test_tab06_controls`: `#sim-kill` is a `button` with the text `kill a GPU`. The autoscaler radiogroup has `off` and `on`, with `off` checked and `aria-label="Autoscaler"`.
  - `test_tab06_footer_item`: `m-retry` sits inside a hidden `m-retry-wrap` in `.p-foot`.
  - `test_tab06_lesson`: the lesson matches the copy above. The note says `30 s` and `assumed`.
  - `test_tab06_resets_on_open`: in `sim.js`, `switchTab` deploys `'failure'` for `'failure'`, and the `VIEWS` key `'failure'` exists.
  - **Update `test_tab_shell`** to expect six tabs, ending `"06 failure"`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s tests`. Expected: the new tests FAIL, and the rest pass.
- [ ] **Step 3: Implement the markup, the controls, the box states and the footer item.**
- [ ] **Step 4: Run** `python3 -m unittest discover -s tests && node --test tests/*.test.mjs`. Expected: all tests PASS.
- [ ] **Step 5: Manual check in Chrome** (Python Playwright, `channel="chrome"`). Save screenshots to `.playwright-mcp/pr5-*.png`. No page errors.
  - (a) Tab 06 opens with two green boxes.
  - (b) A kill turns box 2 into "H100 2 · failed". `retried` counts up, p99 goes red within about 15 s, and 503s keep coming with the autoscaler off. The kill button is disabled.
  - (c) Autoscaler on: box 2 reads "H100 3 · starting 30s" and counts down. Then it's up, and everything goes green within about 20 s.
  - (d) Switch to tab 05 and back: two healthy GPUs again, with the autoscaler off.
  - (e) At 390px, there's no horizontal scroll, and the six tabs scroll in place.
  - (f) Tabs 01–05 are pixel-identical to the PR 4 branch (frozen canvas, seeded `Math.random`, 1280 and 390).
- [ ] **Step 6: Commit** with the message "Sim v2: tab 06 on the page: kill a GPU, the autoscaler switch, failed and starting boxes".

### Task 3: Branch wrap-up

- [ ] **Step 1: Run** `python3 -m unittest discover -s tests && node --test tests/*.test.mjs`. Expected: zero failures.
- [ ] **Step 2: Review** `git diff sim-v2-real-traffic --stat`. Expected: only this plan's files, the spec amendment and this plan.
- [ ] **Step 3: Ask Omar** to push and open the PR. While #20 is open, it stacks on `sim-v2-real-traffic`. Once #20 merges, retarget it to `main` before merging.

## Decisions made in this plan (for Omar to check)

- **PR split:** follow-a-request and the config drawer move to their own PR (PR 6), so this PR stays one lesson.
- **What a kill does:** it fails the highest-numbered GPU that's up. The button is disabled with one GPU left, so there's no total outage.
- **Retries:** they keep their original arrival time, so the spike shows the user's real wait. A first token from before the kill stays counted.
- **Replacement:** it comes up in the same box, on a new GPU number. The autoscaler replaces dead GPUs (two replicas wanted); it doesn't scale on load.
- **Cold start:** 30 s, labelled as an assumption, so it isn't presented as compressed or measured.
- **Billing:** a starting GPU is billed, a dead one isn't.
