# inference.sim v2: an LLM serving simulator, one concept per tab

Date: 2026-10-25 · Status: approved by Omar for planning (2026-10-25)

## Intent

The homepage has a live inference simulator (`index.html`, script section 2, "Inference simulator"). Today it's a queueing model of a generic request server. Requests arrive at random (Poisson, about 5.5/s) with synthetic bursts every 6–10 s. A dynamic batcher closes a batch at max batch size or after a 260 ms timeout, and batches run on three MIG slices of one H100 (3g.40gb, 2g.20gb, 2g.20gb). The footer shows p50, p99, throughput, GPU utilization and queue length. Controls: pause, send burst, max batch slider, bursty checkbox. Clicking the canvas sends a burst.

Two problems:

- **It doesn't speak LLM.** There are no tokens, no prefill or decode, no KV cache and no continuous batching, and those are what LLM serving is about.
- **It's the only figure on the page built from invented data.** The hero replays GPT-2's real predictions, the About section shows real attention, and the agent section replays a real run.

**Why (Omar's words):** a visitor who plays with it for 30 seconds should walk away thinking Omar knows how LLM serving actually works and how inference systems are designed.

**Audience (inferred, not stated by Omar):** engineers and hiring managers, some of whom know vLLM and Triton well. Their trust is the point, so correct behaviour matters more than flash.

## Goals

1. A **token-level LLM serving engine**: prefill and decode, the KV cache, dynamic vs continuous batching, and MIG slices with realistic memory, bandwidth and compute shares.
2. The **guided layout** Omar picked (option A of the mockup): five tabs that each teach one concept, plus a sandbox.
3. **Real traffic**: a replay of Microsoft's public Azure LLM inference trace, credited as its CC-BY license requires.
4. **Interactions** on every tab: follow a request, a config drawer, and pause meaning "drain" (see Behaviours).
5. **Sandbox extras**: every knob, a terminal prompt, an SLO challenge and a cost meter.
6. **LLM metrics** in the footer: TTFT p50 and p99, TPOT, throughput in tokens/s, KV cache use, and cost per 1M tokens.

## Non-goals

- It isn't a benchmark and doesn't claim to predict real numbers precisely. A footnote says it's a model, not a benchmark.
- No server, build step or framework. The site stays plain static files on GitHub Pages.
- No model picker. Tabs 01, 02, 05 and 06 serve one model (Llama 3 8B). Tab 03 serves a fixed set of three models, and tab 04 a fixed System1 model, Llama 3.2 1B and Llama 3 8B (or an API model).
- No cluster view beyond what tabs 03 and 06 need (a few GPUs side by side).
- No sound and no saved scores across visits.
- The other demos (hero, attention, agent replay, reading trace) are untouched.

## Anti-goals (a failure even if it works)

- **An expert spots behaviour that's wrong.** Examples: throughput that keeps rising with batch size forever, KV memory that never runs out, or a 16 GB model "fitting" on a 10 GB slice. The shape of every curve must be right even where the numbers are approximate.
- **A cluttered dashboard.** Each tab shows only the controls its lesson needs, and everything else waits in the sandbox.
- **A marketing look.** Keep the page's visual language (see the anti-goals in `2026-10-23-homepage-revamp-design.md`): the dark panel, Geist Mono labels, thin lines, `--p-*` colours, accent used sparingly.
- **Losing what works today.** The animation stops when the panel is off screen or the browser tab is hidden. With reduced motion it starts frozen. It works on phones, and without JS the panel stays hidden (it's `.js-only`).

## What the visitor sees (layout A)

The panel stays where it is now (full container width, below the hero). From top to bottom:

1. **Header row.** Live dot, `inference.sim`, and a note such as "· Llama 3 8B on one H100 · real time" that follows the current setup. Controls: play/pause, `send burst`, `config ▾`.
2. **Tab row.** `01 batching` · `02 kv cache` · `03 mig layout` · `04 routing` · `05 real traffic` · `06 failure` · `sandbox ›`, with sandbox set apart on the right.
3. **Lesson line.** One or two sentences of real HTML with a bold lead-in, and the tab's single control on the right (for example a `dynamic | continuous` segmented switch).
4. **Canvas.**
   - **Flow:** requests come in from the left and a router sends each one to a server instance. Every instance (one per MIG slice, or one for the whole GPU) has its own small queue lane next to its slice. Requests run on the slices, and tokens stream out to the right. This replaces the single shared queue drawn in the mockup, because that isn't how MIG serving works (see Engine).
   - **Inside each slice:** its name, the number of running sequences and KV cache % (amber above 80%). Each running sequence is one horizontal bar: a solid accent block for prefill, then a lighter part that grows one token per decode step. Finished sequences flash green and leave, a dashed free slot shows when there's room, and a thin KV cache bar runs along the slice's bottom edge.
   - **Bottom strip:** a rolling TTFT p99 sparkline with event markers ("continuous on", "slice killed", …).
5. **Follow strip** (only while a request is being followed).
   - **Header:** the request id, prompt tokens → output tokens, and the slice it ran on.
   - **Spans:** queue, prefill and decode, plus preempted or requeued spans if those happened.
   - **Numbers:** that request's TTFT, TPOT and total time.
   - **Style:** drawn like the reading trace at the bottom of the page.
6. **Footer metrics.** TTFT p50, TTFT p99, TPOT, throughput (tok/s), KV cache %, cost per 1M tokens.
7. **Config drawer**, closed by default (see Behaviours).

## Tabs

Each tab is a preset: it sets up the engine and traffic, shows its lesson and exposes one control.

| Tab | Setup | The one control | What the visitor should notice |
|-----|-------|-----------------|--------------------------------|
| 01 batching | random traffic, one 8B instance on the full GPU (7g.80gb), continuous | `request-level \| continuous` | Request-level batching is how servers ran LLMs before vLLM (for example Hugging Face `generate()` behind Triton's dynamic batcher). It reserves KV up front for the longest prompt plus `max_tokens`, and a batch runs until its longest reply finishes, so batches stay small, finished sequences leave idle slots and the queue waits. Continuous batching with paged KV (vLLM) admits and releases sequences at every step, so p99 TTFT drops and throughput rises. The lesson names both changes honestly. |
| 02 kv cache | one 3g.40gb instance, synthetic long prompts **and** long replies, labelled as synthetic | GPU memory for the KV cache (`--gpu-memory-utilization`, about 0.5–0.95) | KV fills up. Once it's full the scheduler stops admitting new requests and preempts one: its KV is dropped, it goes back to the front of its instance's queue and redoes prefill. Memory, not compute, limits how many requests run at once. (My call: a 3g.40gb slice serves across the whole slider range, while 2g.20gb slices wouldn't even start below about 0.85. The real code trace has tiny outputs, a median of about 13 tokens, so preemption would rarely show.) |
| 03 mig layout | **Several models, like Omar's Trendyol setup (his call).** Three models, each with its own traffic stream: Llama 3 8B (chat-like), Llama 3.2 3B and Llama 3.2 1B (short, high-rate tasks). | `GPU per model \| time-slicing \| MIG` (my call: this replaces the layout chips, which move to the sandbox) | **GPU per model:** Kubernetes hands each pod a whole GPU, so three models take three H100s, each mostly idle. **Time-slicing:** all three share one H100 with no isolation, so a burst on one model stretches the others' step times and their p99 jumps (noisy neighbours). **MIG:** one H100 split 3g+2g+2g, one model per slice, with hardware isolation. It meets the same latency with a third of the GPUs, and the footer's GPU count and cost per 1M tokens show it. The lesson can point to Omar's own result (about 1.75× capacity); Omar approves the copy. The numbers on screen come from the engine and are never hard-coded to 1.75×. |
| 04 routing | see `2026-10-26-inference-sim-v2-routing-design.md` (amended 2026-10-26) | threshold slider and `on-prem \| API` | Routing easy queries to a small model cuts GPU or API cost; route too much and hard queries get misrouted. |
| 05 real traffic | one 8B instance on the full GPU, continuous | `random \| Azure trace`, opening on the trace | An hour of Azure's real traffic, sped up 12× and thinned to one GPU's share (amended 2026-10-26, Omar's call; see Data). Its rate climbs to the hour's peak and back. The H100 that serves the hour's average with room to spare falls behind at the peak (red, 503s), then recovers. Random traffic at the same average rate, with lengths fitted to the trace, stays green: size for the peak, not the average. Prompt and reply lengths keep the trace's long tail. The caption credits the dataset and says how it was changed. |
| 06 failure | two 8B replicas, each on a full H100, behind the router, continuous, autoscaler off (my call) | `kill a GPU` button and `autoscaler on/off` | Killing a GPU fails its instance. Its running and queued requests go back to the router, as client retries, and are re-routed to the surviving instances. Their KV is gone, so they redo prefill, and p99 spikes. With the autoscaler on, another H100 comes up after a cold start (model load) and the queues drain. |
| sandbox | whatever the visitor sets | every knob, the terminal prompt, the SLO challenge, the cost meter | free play |

## Behaviours (on every tab)

- **Pause and play (Omar's rule).**
  - Pause stops new arrivals and bursts, but work already in flight keeps processing: the queue is still batched and served, and tokens stream out until everything is done.
  - Play starts arrivals again.
  - The button reads `❚❚` while running, `draining…` while the last requests finish, and `▶ play` once empty. The live dot turns gray when drained.
  - In dynamic mode the last partial batch goes out through the timeout, so nothing stays stuck.
  - `send burst` while paused sends just that burst without restarting the steady flow (my call).
- **Switching tabs** resets the sim to that tab's setup, pre-warmed like today's 300 warm-up steps, so a tab never opens empty (my call). The sandbox keeps its settings while the visitor stays on the page.
- **Following a request.**
  - Clicking a dot follows that request, replacing today's click-to-burst. Clicking empty canvas or the strip's `×` stops following.
  - A `follow a request` button picks the next arrival, for keyboard and screen-reader users (my call).
- **Config drawer.** It shows the config of the system being simulated, one block per instance (my call):
  - Continuous mode: `vllm serve` flags.
  - Request-level mode: Triton's `config.pbtxt` for a Python backend with a `dynamic_batching` block.
  - There's no `vllm | triton` switch. vLLM has no request-level mode, and Triton's continuous options (TensorRT-LLM in-flight batching, or the vLLM backend's `model.json`) are different systems.
  - Values mirror the current knobs, and the last changed value is highlighted.
- **Clock: real time** (my call, replacing today's "slowed 10×"). LLM requests last seconds, so real time is already watchable. At 10× slower, a median reply would stay on screen for about 26 s, a request-level batch for about a minute, and a 30-second visit would show only 3 s of the trace. Arrivals run at real rates. Any time compression (for example the cold start) is labelled on screen.
- **Reduced motion** starts frozen, as today: nothing moves until play. After that, the normal behaviour applies.
- **Off screen or hidden tab:** the animation loop stops, as today.
- **Phones (390px):** tabs scroll sideways, the lesson wraps, the follow strip and config drawer stack, and the canvas is about 230px tall as today.

## Engine (decided)

- **Models** (bf16; the builder verifies these against each model's config):
  - Llama 3 8B Instruct: weights ≈ 16 GB, KV ≈ 128 KiB per token (32 layers × 8 KV heads × 128 head dim × K and V × 2 bytes).
  - Llama 3.2 3B: weights ≈ 6.4 GB, KV ≈ 112 KiB per token (28 × 8 × 128 × 2 × 2).
  - Llama 3.2 1B: weights ≈ 2.5 GB, KV ≈ 32 KiB per token (16 × 8 × 64 × 2 × 2).
  - Only tab 03 and the sandbox use the 3B; tabs 03 and 04 and the sandbox use the 1B.
- **Time-slicing (tab 03):** several processes share one GPU with no isolation. GPU time is split among the processes that have work, so each model's step time grows with its neighbours' load. The builder picks a simple model with that shape.
- **Slices:** each MIG profile gives its slice a memory size, a share of compute and a share of memory bandwidth. Profiles used: 7g.80gb, 4g.40gb, 3g.40gb, 2g.20gb, 1g.20gb (plus 1g.10gb, mentioned only as "doesn't fit").
- **Topology** (my call, matching real MIG serving):
  - **Instances:** each slice runs its own server instance with its own queue, KV pool and `max-num-seqs`. A preempted request stays in its own instance's queue.
  - **Router:** sends each new request to an instance. The default policy is least outstanding requests. Round-robin is a sandbox option, and it shows the 2g slices drowning while the 3g sits partly idle.
  - **Saturation:** when the router has nowhere to send a request (every queue past a cap), it rejects with a 503 and counts it in the footer, so nothing grows without limit.
- **Output lengths stay hidden from the scheduler.** Each request ends at its own length (from the trace or a distribution), but schedulers only ever see `max_tokens`, as in real life.
- **Step time:** in continuous mode, each scheduler step on a slice runs the admitted prefill tokens (chunked, up to a token budget) plus one decode token per running sequence. Step time comes from a simple roofline: `max(FLOPs / slice FLOP/s, bytes moved / slice bandwidth) + fixed per-step overhead`.
  - Bytes moved = weights + the KV cache read for running sequences.
  - Prefill FLOPs ≈ 2 × parameters × tokens.
- **Request-level ("dynamic") batching:** a batch closes at max batch or max queue delay (today's rule). KV is reserved up front for the batch's longest prompt plus `max_tokens` per sequence, which caps the batch size on small slices. The batch runs prefill, then decodes until all its sequences finish. Nothing joins mid-batch.
- **Continuous batching:** admit from the queue every step while the KV budget and `max-num-seqs` allow.
- **KV accounting:**
  - Per-sequence KV = (prompt + generated tokens) × 128 KiB.
  - KV budget = slice memory × `gpu-memory-utilization` − weights − an activation reserve.
  - When the next step would exceed the budget, preempt the newest sequence by recompute: drop its KV and put it back at the front of the queue. The builder confirms this matches current vLLM.
- **Traffic.**
  - Random: Poisson arrivals with optional bursts (today's shape), with prompt and output lengths drawn from distributions fitted to the Azure trace.
  - Trace: a replay of the Azure trace.
- **Starting constants.** These are estimates to verify, with sources cited in a code comment.
  - H100 SXM: ≈ 989 TFLOPS dense BF16 and 3.35 TB/s HBM3.
  - Expected: TPOT of about 10–25 ms on 2g and 3g slices, and prefill of about 30 ms per 1k tokens on a full GPU.
  - Sanity check: a full H100 (7g) at high concurrency should land in the several-thousand tokens/s range for an 8B model.

## Data

- **Source:** Azure LLM inference trace 2023 (github.com/Azure/AzurePublicDataset, `AzureLLMInferenceDataset2023.md`). It has one row per request: `TIMESTAMP`, `ContextTokens`, `GeneratedTokens`, with no prompt text. There are two workloads, `AzureLLMInferenceTrace_conv.csv` (conversation) and `AzureLLMInferenceTrace_code.csv` (code). License: CC-BY. Citation: Patel et al., "Splitwise: Efficient generative LLM inference using phase splitting", ISCA 2024.
- **Script:** a new script in `scripts/` downloads the conversation trace and writes `assets/sim/azure-conv.json`, aiming for under 100 KB. It keeps every 4th request of the whole hour (about 4,840 of 19,366) and leaves out the few whose prompt plus `max_tokens` won't fit Llama 3 8B's 8,192-token context. It writes the gaps between arrivals in ms, prompt tokens and output tokens, plus lognormal fits of both lengths for the random mode. The page replays it 12× faster, so the hour takes about 5 minutes at 3× the trace's per-second load, about 16.6 requests/s.
- **Why the whole hour, not a 5-minute window (measured 2026-10-26, Omar's call):** within any 5 minutes the trace's arrivals are close to Poisson (gaps' coefficient of variation ≈ 1.0). At its real rate, about 5 requests/s, one H100 runs at about 30%, so a window at real time looks just like random traffic. The drama is over the hour: the rate climbs from about 4 to 8 requests/s and back, and the prompt mix shifts. The trace also aggregates a whole Azure service, so any one-GPU replay has to sample it.
  - The output is committed.
  - It doesn't run in CI (the dataset doesn't change), so it stays out of `.github/workflows/ml-figures.yml`.
- **Credit:** the tab 05 caption credits the trace, links the dataset and its license, and says what changed, for example "Traffic: Azure LLM inference trace 2023, conversations (Microsoft, CC-BY 4.0), every 4th request, 12× faster".

## Code layout

- **New files:** the sim moves out of `index.html` into two files, following `assets/speaking.js`. `assets/sim-engine.js` holds the pure engine, exported through `module.exports` for `node:test` and as `window.SimEngine` in the browser. `assets/sim.js` draws and wires the controls. `index.html` keeps the markup and CSS, and the inline section 2 goes away (my call, for size and testability).
- **Engine tests (node):**
  - KV use never exceeds the budget.
  - With the same seed, continuous batching gives a lower p99 TTFT than dynamic.
  - Drain empties the system with no new arrivals.
  - One loop of the trace replay reproduces the sampled hour's arrival count.
  - A 1g.10gb slice refuses the bf16 8B weights.
  - In tab 03's setup, MIG meets the same latency target as GPU-per-model with one GPU instead of three, and time-slicing's p99 for a quiet model rises when a neighbour bursts.
- **Page tests (Python):** the structure exists (tabs, controls, ARIA roles), and the existing tests still pass.
- **Accessibility:**
  - Tabs use `role="tablist"`, `tab` and `tabpanel`, with arrow-key navigation.
  - The lesson text and metrics are real HTML.
  - The canvas `aria-label` updates per tab.

## Why MIG only appears in the multi-model tabs, 03 and 04 (decided)

With one 8B model, an honest engine makes a full GPU beat 3g+2g+2g by a wide margin:

- Three copies of the weights take 48 of the 80 GB, leaving about 20 GB for KV instead of about 54 GB.
- Every slice re-reads its 16 GB of weights at each decode step, so a 2g step takes about 19 ms against about 5 ms on the full GPU.

MIG wins when several models share a card, which is how Omar got about 1.75× capacity at Trendyol. So the one-model tabs run on full GPUs, and tab 03 tells the multi-model story (Omar's call, 2026-10-25). Tab 04's routing also runs on MIG, since it serves three models on one H100 (amended 2026-10-26).

## Delivery

Six PRs, each shippable on its own. The page never looks half-built because a tab that isn't built yet just doesn't appear. Amended 2026-10-26: a model-routing tab joins as tab 04 (see `2026-10-26-inference-sim-v2-routing-design.md`), so the real-traffic and failure tabs become 05 and 06.

1. Engine, move to `assets/sim.js`, tabs shell, tab 01, new footer metrics, pause/drain.
2. Tabs 02 and 03.
3. Tab 04, model routing: the System1 model routes each request to a small or large model, which can be on-prem or an API model.
4. Tab 05 (real traffic), the trace script and its data.
5. Tab 06 (failure), follow a request, the config drawer.
6. Sandbox: every knob, terminal prompt, SLO challenge, cost meter.

## Left to the builder

- **Model details:** exact constants and their sources, the activation reserve, and the random-traffic length distributions.
- **Drawing:** canvas details beyond what's described here and in the mockup. This includes how the second GPU appears in tab 06 and how the cold start is shown (labelled if compressed).
- **Terminal:** command names and grammar. Keep it small, with `help` listing the commands.
- **SLO challenge:** targets, and how a pass is shown.
- **Cost meter:** the H100 price per hour. Cite a public on-demand price and show it in a tooltip.
- **Lesson copy:** written by the builder, reviewed by Omar in each PR.

## Later

- An FP8 or quantized weights toggle (it would let 1g.10gb slices serve).
- Prefix caching, speculative decoding, more models.
- A disaggregated prefill/decode tab. The Azure trace comes from the Splitwise paper, which proposes exactly that.
