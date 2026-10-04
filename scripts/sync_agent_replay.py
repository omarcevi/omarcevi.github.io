"""Pull one recorded run of sdlc-agent-pipeline into assets/agent/replay.json.

The homepage replays it on the agent graph: every node visit, model call and
tool call, with the real timestamps, token counts and cost from the recording.
Source: github.com/omarcevi/sdlc-agent-pipeline (web/public/replays, recorded
by bench/replay.py). Only the fields the page draws are kept.

    python scripts/sync_agent_replay.py                 # featured run
    python scripts/sync_agent_replay.py --run md-001-multi-flash-r1-20261001T062611Z
"""
import argparse
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = "https://raw.githubusercontent.com/omarcevi/sdlc-agent-pipeline/main"
DEFAULT_RUN = "sr-002-multi-flash-r1-20261001T062611Z"
PUBLIC_REPLAYS = "https://omarcevi.dev/sdlc-agent-pipeline/"


def get(path):
    with urllib.request.urlopen(f"{RAW}/{path}") as r:
        return json.loads(r.read().decode("utf-8"))


def short(s, n=160):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def trim_step(s):
    k = s["kind"]
    out = {"t": s["t"], "k": k, "n": s["node"], "c": s["cost_usd"], "tc": s["tool_calls"]}
    if k == "node":
        if s.get("from"):
            out["from"] = s["from"]
        if s.get("via"):
            out["via"] = s["via"]
        if s.get("message"):
            out["msg"] = short(s["message"], 90)
    elif k == "model_call":
        out["a"] = s.get("agent")
        out["ti"], out["to"] = s.get("tokens_in"), s.get("tokens_out")
        out["calls"] = [c.get("label") or c.get("tool") for c in (s.get("calls") or [])]
    elif k == "tool_result":
        r = s.get("result") or {}
        out["tool"] = s.get("tool")
        if s.get("error"):
            out["err"] = short(s["error"], 90)
        elif isinstance(r, dict) and "exit_code" in r:
            out["exit"] = r["exit_code"]
            tail = (r.get("stdout") or "").strip().splitlines()
            if tail:
                out["out"] = short(tail[-1], 90)
    elif k == "plan":
        v = s.get("value") or {}
        out["actionable"] = v.get("actionable")
        out["summary"] = short(v.get("summary") or v.get("decline_reason") or "", 220)
    elif k == "claim":
        v = s.get("value") or {}
        out["summary"] = short(v.get("summary", ""), 220)
    elif k == "diff":
        v = s.get("value") or {}
        out["files"] = v.get("files", [])
        out["ins"], out["del"] = v.get("insertions"), v.get("deletions")
    elif k == "tests":
        v = s.get("value") or {}
        out["passed"] = v.get("passed")
        tail = (v.get("output_tail") or "").strip().splitlines()
        out["out"] = short(tail[-1], 90) if tail else ""
    elif k == "review":
        v = s.get("value") or {}
        out["verdict"] = v.get("verdict")
        out["must_fix"] = len(v.get("must_fix") or [])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=DEFAULT_RUN)
    ap.add_argument("--out", default=str(ROOT / "assets" / "agent" / "replay.json"))
    args = ap.parse_args()

    index = get("web/public/replays/index.json")
    entry = next(r for r in index["replays"] if r["run_id"] == args.run)
    rec = get(f"web/public/replays/{entry['file']}")
    graphs = get("web/src/graph/graphs.json")["graphs"]
    run = rec["run"]
    g = graphs[run["graph"]]

    out = {
        "source": f"github.com/omarcevi/sdlc-agent-pipeline · web/public/replays/{entry['file']}",
        "link": PUBLIC_REPLAYS,
        "run_id": run["run_id"],
        "caption": entry.get("caption"),
        "issue": run["issue"]["title"],
        "repo": run["repo"],
        "category": run.get("category"),
        "models": run.get("models"),
        "recorded_at": run.get("recorded_at"),
        "outcome": {k: rec["outcome"].get(k) for k in
                    ("outcome", "resolved", "cost_usd", "tool_calls", "tokens_in", "tokens_out", "duration_s")},
        "graph": {"nodes": g["nodes"], "edges": g["edges"]},
        "steps": [trim_step(s) for s in rec["steps"]],
    }
    p = Path(args.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{run['run_id']}: {len(out['steps'])} steps, {p.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
