# inference.sim v2, PR 4: tab 05 real traffic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab 05 replays an hour of Azure's real LLM traffic, sped up 12× and thinned to one H100's share, so a visitor watches the GPU fall behind at the hour's peak while random traffic at the same average stays green.

**Architecture:**
- A stdlib Python script turns the public Azure conversation trace into a small committed JSON file.
- The DOM-free engine gains trace streams (replay, loop, pause) and two tab 05 presets. A calibration sets where in the hour the tab opens.
- The page fetches the JSON when the simulator scrolls into view and adds tab 05 with a `random | Azure trace` switch, a trace clock and the dataset credit.

**Tech Stack:** Plain ES5 browser JS (no build), Node `node:test` for the engine, Python `unittest` for the page and the script.

**Spec:** `docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md` (tab 05 row, Data, Engine tests). The tab 05 row and the Data section were amended on 2026-10-26 with Omar's choice of the whole hour, sampled.

## Global Constraints

- **Stack and idiom:**
  - No build step.
  - Page idiom is `var`, `function`, IIFEs, `'use strict'`, `Object.assign`, with no spread in browser code.
  - The engine is DOM-free: `module.exports` in Node, `window.SimEngine` in the browser.
  - The page never reads `inst.step`, `.stepEnd`, `inst.batch` or `sim.cfg`; a guard test enforces this.
  - The script uses the Python standard library only.
- **Visual language:**
  - The dark panel, the `--p-*` colours, Geist Mono labels, and only the existing palette plus alpha variants.
  - New DOM text is 0.72rem or larger. Canvas labels keep the existing canvas sizes (9–10px).
- **Unchanged:**
  - Hardware, model numbers, `DEFAULTS`, `CTX_SWITCH_LOSS`, and `LENGTHS`. `LENGTHS` stays the paper-median stand-in that tabs 01 and 04 are calibrated on.
  - The tab 01–04 presets and their tests. Tabs 01–04 must look and behave as before.
- **Tab 05 setup:** one `llama-3-8b` instance on `7g.80gb`, continuous batching, with SLO TTFT p99 `2000` ms, the same as the 8B in tabs 03 and 04. With an slo, the page's 40 s warm-up applies.
- **Data:**
  - Source: `https://raw.githubusercontent.com/Azure/AzurePublicDataset/master/data/AzureLLMInferenceTrace_conv.csv` (19,366 requests over about 58 min).
  - Sampling: keep every 4th request in arrival order (index 0, 4, 8, …). Then leave out any whose prompt + 1024 (`DEFAULTS.maxTokens`) exceeds 8192 (Llama 3 8B's context).
  - Output: `assets/sim/azure-conv.json`, under 100 KB. The script doesn't run in CI.
- **Replay:** 12× faster. Each request still runs at real speed. The page labels the compression.
- **Credit (CC-BY 4.0 attribution):**
  - the dataset name and link, Microsoft, and the license name and link;
  - Patel et al., "Splitwise", ISCA 2024;
  - the changes: every 4th request, 12× faster.
- **Default control:** tab 05 opens on `Azure trace` once the data has loaded, otherwise on `random`.
- **Git:** commits are authored by Omar Elcircevi, with no Co-Authored-By or Claude trailer anywhere.

## Review Focus

1. **Pause, then play, mid-trace:** the replay resumes at the same point in the hour, with no flood of overdue arrivals. Test: Task 2 Step 1, `pause freezes the hour`.
2. **A hidden browser tab coming back** (one long tick): at most 50 ms of sim time passes, so at most 600 ms of the hour. Test: Task 2 Step 1, `a long tick`.
3. **The trace fails to load** (offline, 404): tab 05 opens on random, and the trace radio is disabled with a reason, with no console error. Test: Task 3 Step 1, a source check, plus manual check (d).
4. **The hour wraps around:** no gap, no double arrival, the clock restarts and the sparkline marks it. Test: Task 2 Step 1, `the replay loops`.
5. **`send burst` in trace mode:** works, with the trace's fitted lengths. Test: Task 2 Step 1, `a burst on the trace stream`.

---

### Task 1: The trace script and its data

**Files:**
- Create: `scripts/azure_trace.py`
- Create: `assets/sim/azure-conv.json` (the script writes it; commit it)
- Test: `tests/test_azure_trace.py`

**Interfaces:**
- Produces the JSON object that Tasks 2 and 3 read:
  ```
  { source, url, license, licenseUrl, citation, every: 4, speed: 12, contextLimit: 8192, maxTokens: 1024,
    requests, sampled, kept, startedAt, durationMs,
    gapMs: int[], prompt: int[], output: int[],
    fit: { prompt: { median, sigma, min, max }, output: { median, sigma, min, max } },
    rate, peakRatio }
  ```
- `gapMs[0]` is the first kept request's offset from the hour's first request. Each later entry is the gap to the previous kept one.
- `durationMs` spans all 19,366 requests, from the first to the last.
- `rate` is the replayed load in requests/s: `kept / (durationMs / speed / 1000)`, rounded to 2 decimals (about 16.6).
- `peakRatio` is the busiest 5 real minutes' kept count over the hour's average per 5 minutes, rounded to 2 decimals (about 1.4). The lesson copy uses it.
- `fit.*.sigma` is `sqrt(2 · ln(mean / median))`, rounded to 3 decimals. That makes the lognormal's mean equal the data's mean, so random mode carries the same token load.
- `fit.*.median` is the integer median.
- `fit.*.min` and `fit.*.max` are the kept data's min and max.

- [ ] **Step 1: Write the failing tests** in `tests/test_azure_trace.py`. Add `ROOT / 'scripts'` to `sys.path` and import `azure_trace`.
  - `test_transform_keeps_every_4th_and_drops_what_wont_fit`: a fixture of 10 rows `(t_seconds, prompt, output)`.
    - Times are 0, 1, …, 9 s, except row 8, whose prompt is 7200 (7200 + 1024 > 8192).
    - `transform(rows)` keeps rows 0 and 4: `sampled == 3`, `kept == 2`, `requests == 10`.
    - `gapMs == [0, 4000]`, `durationMs == 9000`.
    - `rate == round(2 / (9000 / 12 / 1000), 2)`.
  - `test_fit_matches_the_mean`: for the fixture's kept prompts and outputs:
    - `fit.prompt.sigma == round(sqrt(2 * log(mean / median)), 3)`;
    - `median` is the int median, and `min`/`max` are the kept data's.
  - `test_committed_trace`: loads `assets/sim/azure-conv.json` and checks:
    - the file is under 100,000 bytes;
    - `every == 4`, `speed == 12`, `maxTokens == 1024`, `contextLimit == 8192`;
    - `len(gapMs) == len(prompt) == len(output) == kept`, and `kept <= sampled == ceil(requests / 4)`;
    - `sum(gapMs) <= durationMs`;
    - every `prompt + 1024 <= 8192`;
    - `fit` recomputed from the arrays matches the stored values (sigma within 0.001);
    - `license` is `CC-BY 4.0` and `url` points at the AzurePublicDataset repository.
  - `test_not_in_ci`: no file under `.github/workflows/` mentions `azure_trace`.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_azure_trace -v`. Expected: FAIL, because `azure_trace` can't be found.
- [ ] **Step 3: Implement `scripts/azure_trace.py`:**
  - `parse(lines: Iterable[str]) -> list[tuple[float, int, int]]` reads the CSV header `TIMESTAMP,ContextTokens,GeneratedTokens` and returns rows sorted by time. Parse timestamps to 6 fractional digits, e.g. `2023-11-16 18:15:46.6805900`.
  - `transform(rows, every=4, speed=12, context=8192, max_tokens=1024) -> dict` builds the JSON above.
  - `main()` downloads `URL` with `urllib.request`, writes `OUT` with `json.dump(..., separators=(',', ':'))`, and prints `requests`, `kept`, `rate`, `peakRatio`, `fit` and the size in KB.
  - **Docstring:** what the file is for, the source, the license (verify it on the repository's LICENSE before writing it) and the citation.
    - Why the whole hour (from the spec's amended Data section): 5-minute windows are close to Poisson, and one H100 runs at about 30% at the real rate.
    - Why every 4th request at 12×: the trace aggregates a whole service, so it's sampled to one GPU's share.
    - How to run it: `python scripts/azure_trace.py`. It's not run in CI.
- [ ] **Step 4: Run the script, then the tests.** Run `python3 scripts/azure_trace.py`. Expected output: about 4,840 kept, rate about 16.6, peakRatio about 1.4, size about 60 KB.

  Then run `python3 -m unittest tests.test_azure_trace -v`. Expected: PASS.
- [ ] **Step 5: Commit** `scripts/azure_trace.py`, `assets/sim/azure-conv.json` and `tests/test_azure_trace.py`, with the message "Sim v2: script and data for tab 05: Azure's conversation trace, every 4th request of the hour".

### Task 2: Trace streams and the tab 05 presets

**Files:**
- Modify: `assets/sim-engine.js` (streams, the event loop, `setArrivals`, the presets, exports)
- Test: `tests/sim.test.mjs`

**Interfaces:**
- Consumes the JSON from Task 1: `gapMs`, `prompt`, `output`, `durationMs`, `speed`, `fit`. Tests load it with `require('../assets/sim/azure-conv.json')`.
- Produces:
  - **A stream spec** `{ model, trace: <the JSON>, startMs? }`. It's a trace stream:
    - `rate` 0, `bursts` false, and `lengths` set to `trace.fit`, so bursts draw fitted lengths;
    - it replays request `i` at hour time `loop · durationMs + T[i]`, where `T` is the running sum of `gapMs`, mapped to sim time at `1 / speed`;
    - after the last request it loops to the first and pushes `{ t, label: 'trace loops' }` onto `sim.events`.
  - **`E.traceClock(sim) -> { ms, totalMs } | null`:** where the replay is in the hour (`ms` in `[0, totalMs)`, and `totalMs = durationMs`). It's null when no stream replays a trace. It freezes while arrivals are off.
  - **`E.tracePreset(data) -> preset`:**
    ```
    { instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], batching: 'continuous', slo: { 'llama-3-8b': 2000 },
      streams: [{ model: 'llama-3-8b', trace: data, startMs: TRACE_START_MS }] }
    ```
  - **`E.PRESETS['traffic-random']`:** the same instance, batching and slo, with `streams: [{ model: 'llama-3-8b', rate: TRACE_RATE, bursts: false, lengths: TRACE_FIT }]`.
  - **`E.TRACE_FIT` and `E.TRACE_RATE`:** copied from the JSON's `fit` and `rate`, with a comment saying so.
  - **`TRACE_START_MS`:** the hour time where the sim starts, set by the calibration in Step 5.
- A trace stream draws nothing from `sim.rng`, so the seed has no effect on trace mode. The streams of tabs 01–04 keep their RNG order.

- [ ] **Step 1: Write the failing tests.** The engine tests use a tiny synthetic trace `TINY = { gapMs: [100, 200, 300], prompt: [10, 20, 30], output: [1, 2, 3], durationMs: 1000, speed: 2, fit: E.TRACE_FIT }` on `tracePreset`'s instance.
  - **`tab 05: a trace stream replays each request at its time, with its own lengths`:**
    - With `startMs: 0`, the requests arrive at sim times 50, 150 and 300 ms.
    - The prompts and outputs are 10/1, 20/2 and 30/3, read from the requests in the instance's running and finished lists.
  - **`tab 05: the replay loops, and the sparkline marks it`:**
    - The 4th arrival comes at sim time 550 ms (`(1000 + 100) / 2`), carrying prompt 10.
    - `sim.events` has exactly one `'trace loops'` entry by 600 ms.
  - **`tab 05: one loop of the real trace replays every sampled request`:**
    - `tracePreset(D)` with `startMs: 0`, run for `D.durationMs / D.speed` ms.
    - `sim.stats.arrived === D.kept`.
  - **`tab 05: traceClock reads the hour's position, and is null outside tab 05`:**
    - On the real preset at t = 0, `ms === TRACE_START_MS`.
    - After 1000 ms, `ms === TRACE_START_MS + 12000`, and `totalMs === D.durationMs`.
    - `traceClock` is null for `PRESETS.batching` and for `traffic-random`.
  - **`tab 05: pause freezes the hour and play resumes it, with no catch-up flood`:**
    - Run 5 s, then `setArrivals(false)`, then run 10 s.
    - The clock and `arrived` are both unchanged.
    - Then `setArrivals(true)` and run 1 s. The new arrivals equal the number of trace requests whose hour time lies in `(frozen, frozen + 12000]`.
  - **`tab 05: a long tick advances the hour by at most 50 ms of sim time`:** after `E.tick(sim, 60000)`, the clock has moved by at most `50 × 12` ms.
  - **`tab 05: a burst on the trace stream draws the trace's fitted lengths`:**
    - `sendBurst(sim, 20, 0)` doesn't throw.
    - After the burst arrives, there are 20 more requests, with prompt and output inside `TRACE_FIT`'s min and max.
  - **`tab 05: the random preset carries the trace's load`:** `E.TRACE_RATE` equals `D.rate`, and `E.TRACE_FIT` deep-equals `{ prompt: D.fit.prompt, output: D.fit.output }`.
  - **`tab 05: a trace stream rejects malformed data`:** `createSim` throws on mismatched array lengths, empty arrays, or `speed <= 0`.
- [ ] **Step 2: Run** `node --test tests/sim.test.mjs`. Expected: the new tests FAIL (`tracePreset is not a function`), and the rest pass.
- [ ] **Step 3: Implement the trace streams in `assets/sim-engine.js`:**
  - **`createStream`:** a `trace` spec builds the trace stream above. It precomputes `times` (the running sum of `gapMs`) and keeps `cursor`, `loop`, `pos` (absolute hour time) and `posT` (the sim time at `pos`). It starts at the first `times[i] >= startMs`, with `pos = startMs` and `posT = 0`.
  - **`schedule(sim)`:** for a trace stream, set `posT = sim.t` and `nextArrival = posT + (abs(cursor) − pos) / speed`, with no RNG draw.
  - **`nextEvent`:** a trace stream's `nextArrival` is kind `'trace'`.
  - **`tick`:** a `'trace'` event enqueues the request at `cursor` with its prompt, output, model and stream. It then sets `pos` to its absolute time and `posT = sim.t`, advances `cursor` (wrapping, with `loop += 1` and the `'trace loops'` event), and reschedules.
  - **`setArrivals(sim, false)`:** for a trace stream, first fold elapsed time into `pos` (`pos += (sim.t − posT) × speed`, `posT = sim.t`), then set `nextArrival` to Infinity. When arrivals are on again, `schedule` resumes from `pos`.
  - **`traceClock`:** `(pos + (arrivalsOn ? (sim.t − posT) × speed : 0)) mod durationMs`.
  - **Exports and comments:** export `tracePreset`, `traceClock`, `TRACE_FIT` and `TRACE_RATE`. Update the `LENGTHS` comment: it no longer says "PR 3 refits these". It now says tab 05's random mode uses `TRACE_FIT`, and `LENGTHS` stays for the tabs calibrated on it.
- [ ] **Step 4: Run** `node --test tests/sim.test.mjs`. Expected: all tests PASS.
- [ ] **Step 5: Calibrate `TRACE_START_MS`.** Write the visitor-view tests below, using the existing `visit()` helper with `PAGE.tab03WarmMs` and box p99 from `E.metrics(sim, 'llama-3-8b', PAGE.p99WindowMs)`.

  The trace is deterministic, so the trace test needs only one load. Start at 960000 (minute 16), and move by whole minutes until both tests pass. Record the measured figures in a comment above `TRACE_START_MS`.
  - **`tab 05 as a visitor sees it, on the trace: green at the open, red 10–25 s later, then back to green`:** over the 4 min after the open:
    - at the open, p99 ≤ 2000;
    - the first red refresh comes 10–25 s after the open;
    - it's red on ≥ 30% of the refreshes in the first 2 min, with at least one 503 in those 2 min;
    - every refresh from 2 min to 4 min is green.
  - **`tab 05 as a visitor sees it, random traffic at the same load stays green`:** on seeds 1–10, over 2 min after the open, green on ≥ 95% of refreshes on at least 9 of 10 loads, with zero 503s on at least 9.
- [ ] **Step 6: Run** `node --test tests/*.test.mjs`. Expected: all tests PASS, including the tab 01–04 tests, unchanged.
- [ ] **Step 7: Commit** `assets/sim-engine.js` and `tests/sim.test.mjs`, with the message "Sim v2: trace streams that replay, loop and pause, and tab 05's trace and random presets".

### Task 3: Tab 05 on the page

**Files:**
- Modify: `index.html` (tab button, panel and lesson)
- Modify: `assets/sim.js` (fetch, VIEWS, radios, deploy, trace clock)
- Test: `tests/test_page.py` (class `Simulator`)

**Interfaces:**
- Consumes from Task 2: `E.tracePreset(data)`, `E.PRESETS['traffic-random']`, `E.traceClock(sim)` and the `'trace loops'` event. Consumes from Task 1: `assets/sim/azure-conv.json`.
- **Markup:**
  - A tab `<button type="button" role="tab" id="sim-tabbtn-traffic" data-tab="traffic" aria-controls="sim-tab-traffic" aria-selected="false"><i>05</i> real traffic</button>`, after 04.
  - A panel `#sim-tab-traffic` (`role="tabpanel"`, `data-tab="traffic"`, `hidden`) containing:
    - the lesson `<p>`;
    - a `.seg` `role="radiogroup"` with `aria-label="Traffic"`, holding `data-traffic="random"` ("random") and `data-traffic="trace"` ("Azure trace", `aria-checked="true"`).
- **Lesson copy (Omar approves in the PR).** Put the measured `peakRatio` where it says 1.4:

  "**Real traffic.** An hour of Azure's production LLM traffic, replayed 12× faster with every 4th request so that one H100 gets its share; each request still runs at real speed. Its busiest five minutes carry about 1.4× the hour's average, and at the peak the GPU that served the average with room to spare falls behind: the queue grows, p99 goes red and requests get 503s. Random traffic at the same average rate stays green. Size for the peak, not the average."

  Then a `.sim-note` credit:

  "Traffic: [Azure LLM inference trace 2023](dataset link), conversations (Microsoft, [CC-BY 4.0](license link); Patel et al., Splitwise, ISCA 2024), every 4th request, 12× faster."
- **`VIEWS` in `sim.js`:**
  - `'traffic-trace'`: note `'· Llama 3 8B on one H100 · Azure trace, 1 h in 5 min'`, label `'H100 · Llama 3 8B'`, narrow `'H100'`, aria `'Animated simulation: an hour of Azure\'s production LLM traffic, sped up 12 times, served by Llama 3 8B on one H100'`.
  - `'traffic-random'`: note `'· Llama 3 8B on one H100 · random traffic · real time'`, the same label and narrow, aria `'Animated simulation: random traffic at the Azure hour\'s average rate, served by Llama 3 8B on one H100'`.
- **Fetch:**
  - `loadTrace()` runs once, the first time the IntersectionObserver reports the canvas visible. It fetches `'assets/sim/azure-conv.json'`: `r.ok` → `json()`, otherwise a rejection.
  - On success it sets `TRACE` and enables the trace radio.
  - On failure it leaves the radio `aria-disabled="true"`, titled `'the trace didn\'t load'`.
  - While loading, the radio is `aria-disabled="true"`, titled `'loading the trace…'`.
- **`switchTab('traffic')`:** deploys `TRACE ? 'traffic-trace' : 'traffic-random'`.
- **`deploy(id)`:** reads `id === 'traffic-trace' ? E.tracePreset(TRACE) : E.PRESETS[id]`.
- **`setTraffic(b)`:** ignores a radio with `aria-disabled="true"`, otherwise redeploys like `setLarge`. Wire it with `arrows()`, with checking in `syncRadios`.
- **Trace clock:**
  - In trace mode, the arrivals column's top label reads `trace mm:ss / mm:ss` from `E.traceClock(sim)`, with `mm:ss` alone at 560px and under, instead of `requests →`.
  - Random mode keeps `requests →`.

- [ ] **Step 1: Write the failing page tests** in `tests/test_page.py`'s `Simulator` class:
  - `test_tab05_exists`: the tab button and panel exist with the ARIA above, and the panel follows tab 04's panel.
  - `test_tab05_traffic_switch`: the radiogroup has exactly `random` and `trace`, with `trace` checked.
  - `test_tab05_credits_the_trace`: the panel links `github.com/Azure/AzurePublicDataset` and `creativecommons.org/licenses/by/4.0`, and its text contains `every 4th request` and `12×`.
  - `test_tab05_fetches_its_trace_and_survives_failure`: `sim.js` contains `'assets/sim/azure-conv.json'`, a `.catch(` on that fetch chain, and both `aria-disabled` titles.
  - `test_tab05_views`: `sim.js` has `VIEWS` keys `'traffic-trace'` and `'traffic-random'`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s tests`. Expected: the new tests FAIL, and the rest pass.
- [ ] **Step 3: Implement the markup, the fetch, the radios and the trace clock** as specified in the Interfaces block.
- [ ] **Step 4: Run both suites.** Run `python3 -m unittest discover -s tests && node --test tests/*.test.mjs`. Expected: all PASS.
- [ ] **Step 5: Manual check in Chrome** (Python Playwright, `channel="chrome"`, dev server `python3 -m http.server 8000`). Save screenshots to `.playwright-mcp/pr4-*.png`. No console errors in any run.
  - (a) Tab 05 opens on the trace, with the box green and the clock near minute 24 (`TRACE_START_MS` plus 8 min of warm-up). It goes red within about 25 s, shows 503s, and is green again by about 2 min.
  - (b) The clock moves 12 s per second. Pause freezes it and play resumes from the same time.
  - (c) `random` redeploys and stays green. Opening tab 05 again returns to the trace.
  - (d) With the JSON blocked (`page.route('**/azure-conv.json', lambda r: r.abort())`), tab 05 opens on random, and the trace radio is disabled with its title.
  - (e) At 390px, there's no horizontal scroll and the five tabs scroll in place.
  - (f) Tabs 01–04 are pixel-identical to `main` (frozen canvas, fixed seed, 1280 and 390).
- [ ] **Step 6: Commit** `index.html`, `assets/sim.js` and `tests/test_page.py`, with the message "Sim v2: tab 05 on the page: Azure trace or random traffic, trace clock, dataset credit".

### Task 4: Branch wrap-up

- [ ] **Step 1: Run** `python3 -m unittest discover -s tests && node --test tests/*.test.mjs`. Expected: zero failures.
- [ ] **Step 2: Review** `git diff main --stat`. Expected: only this plan's files, the amended spec and this plan.
- [ ] **Step 3: Ask Omar** whether to push and open the PR into `main`. The PR body has no Claude attribution.

## Decisions made in this plan (for Omar to check)

- **The whole hour, sampled** (Omar's call): every 4th request, 12× faster, so the hour loops in about 5 minutes at about 16.6 requests/s.
- **Over-long prompts are left out:** prompts that won't fit Llama 3 8B's 8k context, together with its 1,024 `max_tokens`, are dropped (4 of 19,366 in the full trace). The JSON records how many.
- **Random mode at the same load:** random mode runs at the trace's average rate, with lognormal lengths matched to the trace's medians and means. `LENGTHS` (tabs 01 and 04) is untouched.
- **Where the tab opens:** minute 16 of the hour, plus the 40 s warm-up, so the GPU turns red 10–25 s after the tab opens. Calibrated in Task 2.
- **When the trace loads:** the page fetches the trace when the simulator first scrolls into view, not on page load. If it fails, tab 05 still works on random.
- **Target:** tab 05 uses the 8B's 2 s TTFT p99 target, so the box turns red like in tabs 03 and 04.

## What changed during execution

- **Calibration:** `TRACE_START_MS` = minute 16 passed first. Tab 05 opens at minute 24 with p99 at 1.05 s. It's red from 17 s to 78 s after the open, with 55 503s, and green from then on. Random traffic stays green on 10 of 10 seeds.
- **The trace arriving late:** if tab 05 opens before the trace has loaded (the canvas below the fold, or a slow connection), it switches to the trace when it arrives, unless the visitor picked random. A failed load is tried again the next time tab 05 opens.
- **Credit links:** they take the panel's accent underline, so they show in the light theme too.
- **Loop marker:** 'trace loops' is pushed when the first request of each new loop arrives, which is the hour boundary on the real data.

## Follow-ups from PR 4's review

- Random mode's output fit is clipped at 1000 tokens, so its mean is 4.5% under the trace's (201.6 vs 211.2). The engine comment and the script docstring say the means are equal.
- `startMs` isn't wrapped into the hour or validated. Only code passes it.
- `loadTrace` has no guard for browsers without `fetch`, and doesn't check the payload's shape.
- The reason the trace radio is disabled lives only in its `title`, so touch and keyboard users don't see it.
- The "Checks the radio…" comment in `sim.js` sits above `arrivalsLabel`/`mmss` instead of `check()`.
- `scripts/azure_trace.py` guesses that "Azure served them on a longer-context model"; the dataset doesn't say that.
