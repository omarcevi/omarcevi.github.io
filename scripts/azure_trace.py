"""Turn Azure's LLM inference trace into assets/sim/azure-conv.json for the simulator's tab 05.

Source: the Azure LLM inference trace 2023, conversation workload
(github.com/Azure/AzurePublicDataset, AzureLLMInferenceDataset2023.md): one row per request with its
arrival time, prompt tokens and output tokens, no text. It's a sample of several Azure LLM inference
services, recorded over about an hour. License: CC-BY 4.0. Cite Patel et al., "Splitwise: Efficient
generative LLM inference using phase splitting", ISCA 2024.

Why the whole hour, not a 5-minute window: within any 5 minutes the trace's arrivals are close to Poisson
(the gaps' coefficient of variation is about 1.0), and at its real rate, about 5 requests/s, one H100
serving Llama 3 8B runs at about 30%. A window replayed at real time looks just like random traffic.
The hour is where real traffic differs: its rate climbs from about 4 to 8 requests/s and back, and its
prompt mix shifts.

Why every 4th request at 12x: the trace aggregates whole services, so a one-GPU replay has to sample it.
Keeping every 4th request (in arrival order) and replaying it 12x faster plays the hour in about 5 minutes
at 3x the trace's per-second load, enough that the hour's peak overloads one H100 while its average
doesn't. Requests whose prompt plus max_tokens won't fit Llama 3 8B's 8192-token context are left out
(Azure served them on a longer-context model); the page's engine would turn them away.

    python scripts/azure_trace.py

The dataset doesn't change, so this runs by hand, not in CI. The page reads the JSON it writes.
"""
import csv
import json
import math
import statistics
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = "https://raw.githubusercontent.com/Azure/AzurePublicDataset/master/data/AzureLLMInferenceTrace_conv.csv"
DATASET = "https://github.com/Azure/AzurePublicDataset/blob/master/AzureLLMInferenceDataset2023.md"
OUT = ROOT / "assets" / "sim" / "azure-conv.json"
EVERY = 4           # keep every 4th request
SPEED = 12          # the page replays the hour 12x faster
CONTEXT = 8192      # Llama 3 8B's context (MODELS['llama-3-8b'].contextLen in assets/sim-engine.js)
MAX_TOKENS = 1024   # the engine's DEFAULTS.maxTokens
PEAK_WINDOW_S = 300


def parse(lines):
    """Rows of (arrival in s, prompt tokens, output tokens), earliest first. The trace's timestamps have no
    time zone; they're read as UTC so the offsets don't depend on where this runs."""
    rows = []
    for rec in csv.DictReader(lines):
        t = datetime.strptime(rec["TIMESTAMP"][:26], "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=timezone.utc)
        rows.append((t.timestamp(), int(rec["ContextTokens"]), int(rec["GeneratedTokens"])))
    rows.sort()
    return rows


def fit(values):
    """A lognormal with the data's median and mean: sigma = sqrt(2 ln(mean / median)), so the random mode
    carries the same token load as the trace. min and max clip draws to the data's range."""
    median = int(round(statistics.median(values)))
    sigma = math.sqrt(max(0.0, 2 * math.log(statistics.mean(values) / median)))
    return {"median": median, "sigma": round(sigma, 3), "min": min(values), "max": max(values)}


def peak_ratio(times, duration_s):
    """The busiest PEAK_WINDOW_S of arrivals over the average per PEAK_WINDOW_S"""
    best, lo = 0, 0
    for hi, t in enumerate(times):
        while t - times[lo] >= PEAK_WINDOW_S:
            lo += 1
        best = max(best, hi - lo + 1)
    return round(best / (len(times) / (duration_s / PEAK_WINDOW_S)), 2)


def transform(rows, every=EVERY, speed=SPEED, context=CONTEXT, max_tokens=MAX_TOKENS):
    t0 = rows[0][0]
    duration_ms = round((rows[-1][0] - t0) * 1000)
    sampled = rows[::every]
    kept = [r for r in sampled if r[1] + max_tokens <= context]
    offsets = [round((r[0] - t0) * 1000) for r in kept]
    prompt = [r[1] for r in kept]
    output = [r[2] for r in kept]
    return {
        "source": "Azure LLM inference trace 2023, conversation workload (Microsoft)",
        "url": DATASET,
        "license": "CC-BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "citation": 'Patel et al., "Splitwise: Efficient generative LLM inference using phase splitting", ISCA 2024',
        "every": every,
        "speed": speed,
        "contextLimit": context,
        "maxTokens": max_tokens,
        "requests": len(rows),
        "sampled": len(sampled),
        "kept": len(kept),
        "startedAt": datetime.fromtimestamp(t0, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "durationMs": duration_ms,
        "gapMs": [b - a for a, b in zip([0] + offsets, offsets)],
        "prompt": prompt,
        "output": output,
        "fit": {"prompt": fit(prompt), "output": fit(output)},
        "rate": round(len(kept) / (duration_ms / speed / 1000), 2),
        "peakRatio": peak_ratio([o / 1000 for o in offsets], duration_ms / 1000),
    }


def main():
    with urllib.request.urlopen(URL) as r:
        rows = parse(r.read().decode("utf-8").splitlines())
    d = transform(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(d, separators=(",", ":")) + "\n")
    print(f"{d['requests']} requests, {d['sampled']} sampled, {d['kept']} kept; "
          f"replayed at {d['rate']} requests/s, peak {d['peakRatio']}x the average")
    print(f"fit: {d['fit']}")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1000:.1f} KB)")


if __name__ == "__main__":
    main()
