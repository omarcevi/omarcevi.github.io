# inference.sim v2, tab 04: model routing (System1 model → small or large model)

Date: 2026-10-26 · Status: approved by Omar for planning (2026-10-26)
Builds on: `docs/superpowers/specs/2026-10-25-inference-sim-v2-design.md`. That spec's goals, anti-goals, visual language, behaviours and engine still apply. This document adds one tab.

## Intent

Omar's experience at Trendyol: a small classifier model scored each query's complexity, and a small model handled most queries. Only the hard ones went to the large model. That cut GPU cost for on-prem models and API cost for API models.

**Why:** the same goal as the whole sim. A visitor should leave convinced that Omar knows how LLM serving is designed in practice. Routing by complexity is a real, cost-driven design decision, with a real catch: a misrouted hard query gets a worse answer.

## Goals

1. **A new tab, `04 routing`,** placed right after `03 mig layout` (Omar's call). Every request goes through a gateway.
   1. The **System1 model** (Omar's name for it) scores the request's complexity. It's a fast, cheap classifier, not a reasoning model.
   2. The gateway sends the request to the **small model** or the **large model**.
2. **The large model can be on-prem or an API model** billed per token (Omar's call). A switch flips between them.
3. **One routing control:** a threshold. All the way to one end, everything goes to the large model, which is the baseline to compare against.
4. **The lesson is cost against quality.** Routing more traffic to the small model cuts cost: GPU capacity on-prem, API spend in API mode. Routing too much sends hard queries to the small model, and a misrouted count shows that.

## Non-goals

- **No real text, no real classifier, no answer-quality grading.** Difficulty and quality are modelled, and the page says so.
- **One API.** There's a single generic "API model" with one price; no provider picker.
- **No cascades.** "Try small, then escalate if unsure" and learned or trained routers go under Later.
- **No rate limits.** The API model has no rate limits and no outages; failure is tab 06's job.

## Anti-goals (a failure even if it works)

- **Free routing.** The System1 model must cost real GPU time and add real latency to every request.
- **A frictionless API model.** The API model has to look like a real API: fixed latency per request (TTFT and per-token time), and money spent for every input and output token.
- **Modelled numbers presented as measured.** Quality is a modelled difficulty, not a measured answer score, and the page must say it's modelled.
- **A cluttered tab.** Just the threshold slider and the on-prem/API switch.

## What the visitor sees

- **Setup:**
  - **On-prem:** one H100 split with MIG into 3g + 2g + 1g, a valid H100 layout (one 1g slice stays free):
    - the large model, Llama 3 8B, on 3g.40gb;
    - the small model, **Llama 3.2 1B** (Omar's call), on 2g.20gb;
    - the System1 model on 1g.10gb.
  - **Why the 1B (from the builder check):** a 3B on a 2g slice serves about as much as the 8B on a 3g slice, because the 2g has half the bandwidth, so routing to it saves nothing. The 1B is about 6× cheaper per token, so sending easy traffic to it really frees capacity.
  - **API:** the large model's slice is replaced by an "API model" box.
- **Canvas:** requests arrive, queue at the System1 model's box, then split to the small and large boxes. Each box keeps PR 2's drawing (rows, KV bar, p99 against target in the header). The API box shows in-flight requests and its running spend instead of GPU rows.
- **Lesson line:** one or two sentences, plus the two controls:
  - a threshold slider, "send to the large model when the score is ≥ X";
  - a `on-prem | API` switch.
- **Footer additions:** `small %` (share of requests routed to the small model), `misrouted` (hard requests answered by the small model) and the blended `cost` per 1M output tokens. The existing metrics stay.

## Behaviour

- **The on-prem lesson.** The traffic is set above what the 8B alone can serve on its slice (Omar's call).
  - With everything on the large model, it falls behind: its queue fills, its p99 goes red and requests get rejected.
  - As the threshold routes easy traffic to the 1B, the same H100 serves all of it. Every box goes green, and cost per 1M *served* output tokens falls, because the H100's fixed cost now covers more tokens.
  - Push the threshold too far and misrouted climbs, even though latency looks great.
- **The API lesson.**
  - The H100 is still billed in full, because you'd still rent it for the System1 and small models (my call).
  - The API box shows its own running spend, which falls as the threshold routes more traffic small. That's the headline in API mode.
  - The blended cost includes the GPU too.
  - The API price comes from a cited mid-tier API model, chosen so the API bill clearly dominates the blended cost at a 75/25 small/large split, about 70% or more (my call, after the builder check). A very cheap API tier would hide the lesson.
  - The API model never queues. Its p99 sits at its fixed latency.
- **Quality:**
  - Every request carries a hidden true difficulty, and a request is "hard" above a cut-off.
  - The System1 model's score is the true difficulty plus noise, so some hard requests score low and get misrouted.
  - Misrouted counts hard requests answered by the small model.
  - Easy requests sent to the large model aren't a quality problem, only wasted cost.
- **Redeploys:** the switch redeploys like tab 03's deployment switch. The threshold applies live to new arrivals, since a router setting changes at runtime in real life.
- **Unchanged from the main spec:** pause and drain, reduced motion, phones, and the tab reset rule.

## Engine (decided)

- **Difficulty:**
  - Every request gets a hidden `difficulty` in [0, 1] from a fixed distribution. Most requests are easy, and about 20–30% are "hard" (difficulty ≥ the hard cut-off).
  - Schedulers never read it, like output length. Only the System1 model's score and the quality count use it.
- **System1 model:**
  - A 1B-class classifier, modelled with Llama 3.2 1B's architecture numbers and labelled "System1 model". It runs on its own 1g.10gb slice.
  - It runs every request first: a prefill of the prompt plus one output token, which is the score.
  - Score = clamp(difficulty + Gaussian noise, 0, 1), from the seeded RNG.
  - When it completes, the gateway routes the request on to the small or large instance, where it queues, prefills and decodes as usual.
- **Latency:** the user's TTFT includes the System1 model's queue and step time plus the target model's TTFT. The engine's TTFT is measured from arrival to the first token of the answer, never to the router's own one token.
- **Routing:** `score >= threshold` goes to the large model, otherwise to the small model. The threshold runs from 0 to 1. At 0 everything goes to the large model; at 1, everything to the small model.
- **API model:**
  - An external instance with no GPU and unlimited concurrency.
  - TTFT = a fixed base plus a per-input-token term. Time per output token is fixed.
  - Cost = input tokens × the input price + output tokens × the output price.
  - Prices and latency constants come from a cited public source (a mid-tier API model's list price, and a public latency benchmark), shown in a tooltip and labelled generically as "API model".
- **Blended cost:** (GPU $/s for the H100 + API $/s) / output tokens per second × 1e6. The H100 counts as one GPU in both modes, since its slices still serve the System1 and small models.
- **Traffic:** one chat-like stream with the main spec's `LENGTHS`, at a rate where "everything to the large model" overloads the 3g slice on-prem, while a sensible threshold keeps every box green.
- **Page and engine boundary (my call, from the builder check):** PR 3 starts by giving the page engine helpers for what it draws (step progress, admission state, per-instance labels). Today the UI reads engine internals: `inst.step`, `stepEnd`, `batch.steps`, `sim.cfg`, `r.prefillDone`. Tab 04 adds new box types (gateway, System1, API), so the boundary should be clean first. The other PR 2 follow-ups stay in that plan's list.

## Delivery

This becomes **PR 3**. The rest of the sim's plan shifts:
- real traffic becomes tab 05 and PR 4;
- failure becomes tab 06 and PR 5;
- the sandbox becomes PR 6.

## Left to the builder

- The difficulty distribution, the hard cut-off and the noise level. Calibrate them so the sweet spot has most traffic small and almost nothing misrouted, while the far end visibly misroutes.
- The default threshold.
- The API price and latency sources, which must be cited.
- The traffic rate.
- Canvas details: the gateway, the System1 box and the API box.
- Lesson copy, which Omar approves.
- Visitor-view tests in the style of PR 2: an 8 s warm-up, 300 ms sampling and 30 s windows, over several seeds. They must cover:
  - at threshold 0 on-prem, the large model's box is red and requests get rejected;
  - at the default threshold, every box is green with almost nothing misrouted;
  - at the far end, misrouted is clearly visible;
  - in API mode, API spend falls as the threshold rises.

## Later

- Cascades: the small model tries first and escalates to the large model when its confidence is low.
- Routing on cost or SLO instead of difficulty alone.
- Several API models with different prices.
