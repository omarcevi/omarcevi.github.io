"""Diagrams for workshops/devfest-samsun-agent (Google Cloud architecture style, same look as the
cloud-agents-workshop diagrams; shared drawing code in scripts/gcp_diagram.py).

    python3 scripts/devfest_samsun_diagrams.py     # writes workshops/devfest-samsun-agent/diagrams/*.svg
"""

from __future__ import annotations

from pathlib import Path

from gcp_diagram import AMBER, BLUE, GREEN, INK, MUTED, Diagram

OUT = Path(__file__).resolve().parents[1] / "workshops" / "devfest-samsun-agent" / "diagrams"


def architecture() -> Diagram:
    d = Diagram(1280, 820, "DevFest Samsun Assistant lab: system architecture")
    d.zone(20, 44, 230, 756, "You", "user")
    d.card("you", 35, 90, "Participant", "laptop browser", glyph="person", w=200)

    d.zone(270, 44, 440, 756, "Cloud Shell · in your browser", "cloud", icon="cloud_shell")
    d.card("repo", 290, 84, "Repo clone", "devfest-samsun-assistant", glyph="doc", w=400, h=64,
           sub2="./lab/setup.sh: APIs, uv packages, .env")
    d.card("web", 290, 170, "adk web --port 8080", "dev UI, opened with Web Preview", glyph="terminal", w=400)
    d.zone(290, 250, 400, 330, "Local run · step 3", "region")
    d.card("agent", 305, 290, "samsun_assistant", "ADK agent · gemini-3.6-flash", icon="agents", w=370, h=64,
           accent=BLUE, sub2="sessions and memory kept in memory")
    d.card("tools", 305, 385, "Python tools", "search_sessions · get_session", w=370, h=64,
           sub2="submit_feedback · get_current_time")
    d.card("agenda", 305, 485, "data/agenda.json", "17 sessions · Kat 1 and Kat 2", glyph="doc", w=370, h=50)
    d.card("cli", 290, 610, "agents-cli deploy", "--agent-identity -i", glyph="terminal", w=400, accent=BLUE)
    d.text(290, 712, "Cloud Shell is a free Linux VM with gcloud, git and uv:", 12, MUTED)
    d.text(290, 730, "nothing to install on your laptop.", 12, MUTED)

    d.zone(740, 44, 520, 756, "Your Google Cloud project", "cloud")
    d.card("console", 770, 84, "Agent Platform console", "Agents › Deployments › devfest-samsun-assistant",
           icon="agents", w=470, h=64, sub2="Playground · Sessions · Memories")
    d.card("gemini", 770, 180, "Gemini on Agent Platform", "gemini-3.6-flash · location global", icon="vertexai_core",
           w=470)
    d.zone(770, 270, 470, 300, "Agent Runtime · us-central1", "runtime", icon="vertexai")
    d.card("deployed", 790, 310, "devfest-samsun-assistant", "your deployed agent · scales to zero", icon="agents",
           w=430, h=64, accent=BLUE, sub2="the same code as the local run")
    d.card("sess", 790, 395, "Sessions", "every conversation", icon="vertexai", w=205)
    d.card("mem", 1015, 395, "Memory Bank", "facts per user", icon="vertexai", w=205)
    d.card("aid", 790, 475, "Agent Identity", "principal://agents.global.proj-…", icon="workload_identity_pool",
           w=430, h=64, sub2="its own IAM principal, not a shared service account")
    d.card("trace", 770, 600, "Cloud Trace", "Trace explorer: invoke_agent,", icon="trace", w=470, h=64,
           sub2="generate_content and execute_tool spans")
    d.text(770, 712, "Step 6: ./lab/cleanup.sh deletes the agent and the", 12, MUTED, italic=True)
    d.text(770, 730, "IAM roles of its identity.", 12, MUTED, italic=True)

    d.edge((235, 119), (290, 119), num=1)
    d.edge((235, 135), "web", "r", "l", num=2, via=[(258, 135), (258, 199)])
    d.edge("agent", "tools", "b", "t", label="function calls")
    d.edge("tools", "agenda", "b", "t", label="reads")
    d.edge("agent", "gemini", "r", "l", num=3, via=[(725, 322), (725, 209)])
    d.edge("cli", "deployed", "r", "l", num=4, via=[(755, 639), (755, 342)])
    d.edge((135, 90), "console", "t", "t", num=5, via=[(135, 24), (1005, 24)])
    d.edge("console", "deployed", "r", "r", via=[(1252, 116), (1252, 342)])
    d.edge("deployed", "gemini", "t", "b", label="model calls")
    d.edge((1005, 570), "trace", "b", "t", num=6, label="spans")

    d.legend(35, 200, [
        "Open Cloud Shell, set up",
        "Web Preview: adk web",
        "Agent calls Gemini, tools",
        "Deploy with agents-cli",
        "Open it in the console",
        "Spans go to Cloud Trace",
    ], 200, title="Flow, in lab order")
    d.text(35, 392, "Steps 2–3 run in Cloud Shell,", 12, MUTED)
    d.text(35, 410, "steps 4–5 on Google Cloud.", 12, MUTED)
    d.text(35, 438, "Blue outline: your agent", 12, BLUE)
    return d


def local() -> Diagram:
    d = Diagram(1180, 470, "Step 3: the agent loop in the ADK dev UI")
    d.zone(20, 20, 420, 430, "ADK dev UI · Web Preview, port 8080", "user")
    d.card("q", 40, 70, "You ask", "“Which talks are about AI agents?”", glyph="person", w=380)
    d.card("call", 40, 165, "⚡ search_sessions", "chip: the tool call and its arguments", w=380, h=52, accent=AMBER)
    d.card("res", 40, 240, "✓ search_sessions", "chip: what the tool returned", w=380, h=52, accent=GREEN)
    d.card("ans", 40, 330, "The answer", "The Google Cloud Stack for Production AI Agents", w=380, h=72,
           accent=BLUE, sub2="Omar Elcircevi · Saturday · 10:30 · Kat 1")

    d.zone(480, 20, 420, 430, "samsun_assistant · ADK agent in Cloud Shell", "runtime", icon="agents")
    d.card("model", 500, 70, "gemini-3.6-flash", "reads the question and the tool list,", icon="vertexai_core",
           w=380, h=64, accent=BLUE, sub2="then picks a tool or answers")
    d.card("tool", 500, 230, "search_sessions(topic, day)", "a Python function that ADK runs", glyph="terminal",
           w=380, h=64)
    d.text(500, 345, "The instruction: call get_current_time first, only", 12, MUTED)
    d.text(500, 363, "recommend sessions the tools return, at most 3,", 12, MUTED)
    d.text(500, 381, "each with speaker, day, time and floor.", 12, MUTED)
    d.text(500, 415, "Each tool call shows up as one ⚡ / ✓ pair of chips.", 12, MUTED, italic=True)

    d.zone(940, 20, 220, 430, "Repo files", "region")
    d.card("agenda", 955, 236, "agenda.json", "17 sessions", glyph="doc", w=190, h=52)

    d.edge((420, 99), (500, 99), num=1)
    d.edge("model", "tool", "b", "t", num=2, oa=0.3, ob=0.3, label="tool call")
    d.edge("tool", "model", "t", "b", num=3, oa=0.7, ob=0.7, label="result")
    d.edge("tool", "agenda", "r", "l", label="reads", ob=0.5, via=[(918, 262)])
    d.edge("model", "ans", "l", "r", num=4, oa=0.8, via=[(460, 121), (460, 366)])
    d.badge(398, 191, 2)   # the chips carry the number of the step they show
    d.badge(398, 266, 3)

    d.legend(955, 330, ["Your question", "Tool call (⚡ chip)", "Tool result (✓ chip)", "Answer"], 190)
    return d


def deploy() -> Diagram:
    d = Diagram(1180, 470, "Step 4: what agents-cli deploy --agent-identity -i does")
    d.zone(20, 20, 230, 430, "Cloud Shell", "user", icon="cloud_shell")
    d.card("src", 35, 60, "Project folder", "app/, Dockerfile, .env", glyph="doc", w=200)
    d.card("cli", 35, 145, "agents-cli deploy", "--agent-identity -i", glyph="terminal", w=200, accent=BLUE,
           sub2="-i: Proceed? [Y/n]")
    d.legend(35, 240, ["Upload the code", "Build the container", "Create the instance", "Identity gets roles",
                       "Deployment successful!"], 200)
    d.card("ok", 30, 380, "Deployment successful!", "agent ID + Agent Identity", glyph="check", w=212, h=52,
           accent=GREEN)

    d.zone(280, 20, 880, 430, "Google Cloud", "cloud")
    d.card("build", 300, 75, "Container build", "Google-managed project", icon="cloud_build", w=200)
    d.zone(540, 50, 600, 250, "Agent Runtime · devfest-samsun-assistant · us-central1", "runtime", icon="vertexai")
    d.card("ctr", 560, 90, "Container (ADK + FastAPI)", "scales to zero when idle", icon="agents", w=290, h=64,
           accent=BLUE, sub2="query / streamQuery API")
    d.card("sm", 870, 90, "Sessions · Memory Bank", "managed by Agent Runtime", icon="vertexai", w=250, h=64)
    d.card("id", 560, 185, "Agent Identity", "principal://agents.global.proj-PROJECT_NUMBER.system.id.goog/…",
           icon="workload_identity_pool", w=560, h=64, sub2="one IAM principal for this agent only")
    d.card("iam", 560, 345, "IAM roles on your project", "Agent Platform user · Logging writer",
           icon="identity_and_access_management", w=560, h=64, sub2="Monitoring writer · …")
    d.text(300, 190, "About 5 minutes", 13, INK, 500)
    d.text(300, 208, "from upload to success.", 12, MUTED)
    d.text(300, 236, "Watch the talk while it runs;", 12, MUTED)
    d.text(300, 252, "it keeps going if Cloud Shell", 12, MUTED)
    d.text(300, 268, "disconnects.", 12, MUTED)

    d.edge("cli", "src", "t", "b", label="packages")
    d.edge("cli", "build", "r", "l", num=1, via=[(265, 174), (265, 104)])
    d.edge("build", "ctr", "r", "l", num=2, via=[(520, 104), (520, 122)], badge_at=0.4)
    d.badge(1120, 72, 3)
    d.edge("id", "iam", "b", "t", num=4, label="roles granted")
    d.edge((560, 406), "ok", "l", "r", num=5)
    return d


def console() -> Diagram:
    d = Diagram(1180, 600, "Step 5: memory across sessions, and the trace of one turn")
    d.zone(20, 20, 330, 200, "Playground · session 1", "runtime", icon="vertexai")
    d.text(36, 68, "You: “Hi! I'm into ML and Flutter.", 12.5, INK)
    d.text(36, 86, "What should I see tomorrow?”", 12.5, INK)
    d.text(36, 116, "Agent: 3 picks for tomorrow", 12.5, INK)
    d.text(36, 160, "After the answer, after_agent_callback", 11.5, MUTED, italic=True)
    d.text(36, 176, "runs save_to_memory.", 11.5, MUTED, italic=True)

    d.zone(425, 20, 330, 200, "Memory Bank · facts per user", "cloud", icon="vertexai")
    d.card("fact", 445, 70, "Fact", "“The user is into ML and Flutter.”", icon="vertexai", w=290)
    d.text(445, 160, "Memory Bank extracts it in the", 11.5, MUTED, italic=True)
    d.text(445, 176, "background, in about 30 seconds.", 11.5, MUTED, italic=True)

    d.zone(830, 20, 330, 200, "Playground · New Session", "region", icon="vertexai")
    d.text(846, 68, "You: “What should I see tomorrow?”", 12.5, INK)
    d.text(846, 98, "PreloadMemoryTool adds the fact", 12.5, BLUE)
    d.text(846, 116, "before the model call.", 12.5, BLUE)
    d.text(846, 146, "Agent: ML and Flutter picks,", 12.5, INK)
    d.text(846, 164, "without asking again.", 12.5, INK)

    d.edge((350, 110), (425, 110), num=1, label="save")
    d.edge((755, 110), (830, 110), num=2, label="recall", color=BLUE)

    d.zone(20, 250, 1140, 330, "Trace explorer · one turn (“What should I see tomorrow?”)", "cloud", icon="trace")
    rows = [
        ("invoke_agent samsun_assistant", 0.0, 7.4, 0, BLUE),
        ("retrieve_memories", 0.05, 0.3, 1, AMBER),
        ("generate_content gemini-3.6-flash", 0.4, 1.2, 1, "#7baaf7"),
        ("execute_tool get_current_time", 1.65, 0.05, 1, GREEN),
        ("generate_content gemini-3.6-flash", 1.75, 1.25, 1, "#7baaf7"),
        ("execute_tool search_sessions", 3.05, 0.1, 1, GREEN),
        ("generate_content gemini-3.6-flash", 3.2, 3.7, 1, "#7baaf7"),
        ("save_memories", 6.95, 0.4, 1, AMBER),
    ]
    x0, scale, y = 330, 95.0, 292
    for name, start, length, depth, color in rows:
        d.text(40 + depth * 14, y + 12, name, 12, INK)
        d.front.append(f'<rect x="{x0 + start * scale:.1f}" y="{y}" width="{max(length * scale, 3):.1f}" height="16" '
                       f'rx="3" fill="{color}"/>')
        y += 27
    for t in range(0, 9):
        d.text(x0 + t * scale, 520, f"{t}s", 11, MUTED, anchor="middle")
    d.text(40, 552, "Blue: the agent · light blue: Gemini calls · green: tool calls · amber: memory. retrieve_memories runs "
                    "before every model call; only the first is shown.", 11.5, MUTED, italic=True)
    d.text(40, 568, "Timings are illustrative; yours differ.", 11.5, MUTED, italic=True)
    return d


def main() -> None:
    for name, build in {
        "architecture": architecture, "step-3-local": local, "step-4-deploy": deploy, "step-5-console": console,
    }.items():
        build().write(OUT / f"{name}.svg")
        print(f"wrote diagrams/{name}.svg")


if __name__ == "__main__":
    main()
