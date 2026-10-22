"""Diagrams for workshops/deploy-agents-workshop (Google Cloud architecture style).

    python3 scripts/deploy_agents_diagrams.py     # writes workshops/deploy-agents-workshop/diagrams/*.svg
"""

from __future__ import annotations

from pathlib import Path

from gcp_diagram import AMBER, BLUE, GREEN, INK, MUTED, RED, Diagram

OUT = Path(__file__).resolve().parents[1] / "workshops" / "deploy-agents-workshop" / "diagrams"


def architecture() -> Diagram:
    d = Diagram(1280, 800, "Workplace Assistant on Google Cloud: system architecture")
    d.zone(20, 20, 230, 290, "Employees", "user")
    d.card("emp", 35, 60, "Employee", "Deniz, platform team", glyph="person", w=200)
    d.card("ge", 35, 140, "Gemini Enterprise", "optional front end", icon="agents", w=200)
    d.card("cli", 35, 220, "Cloud Shell", "agents-cli run · scripts", icon="cloud_shell", w=200)

    d.zone(270, 20, 990, 760, "Your Google Cloud project · europe-west1", "cloud")
    d.zone(290, 55, 360, 440, "Agent Runtime", "runtime", icon="vertexai")
    d.card("agent", 310, 95, "workplace-assistant", "concierge + 3 specialists (ADK)", icon="agents", w=320, h=64,
           accent=BLUE, sub2="query / streamQuery · scales to zero")
    d.card("sess", 310, 190, "Sessions", "one conversation", icon="vertexai", w=155)
    d.card("mem", 475, 190, "Memory Bank", "facts per user", icon="vertexai", w=155)
    d.card("aid", 310, 270, "Agent Identity", "principal://agents.global.… (SPIFFE)", icon="workload_identity_pool", w=320)
    d.text(310, 370, "Step 4 binds the agent to the gateway:", 12, MUTED, italic=True)
    d.text(310, 388, "every outbound call goes through it,", 12, MUTED, italic=True)
    d.text(310, 406, "Gemini and Sessions calls included.", 12, MUTED, italic=True)

    d.zone(670, 55, 210, 440, "Governance", "region", icon="network_security")
    d.card("gw", 685, 95, "Agent Gateway", "egress mode", icon="network_security", w=180, h=64, accent=BLUE)
    d.card("iap", 685, 210, "IAP", "checks the access", icon="identity-aware_proxy", w=180, sub2="policy per call")
    d.card("reg", 685, 310, "Agent Registry", "known destinations", icon="service_discovery", w=180)

    d.zone(900, 55, 340, 300, "Cloud Run · IAM-only ingress", "region", icon="cloud_run")
    d.text(918, 95, "roles/run.invoker for the agent's identity", 11.5, MUTED)
    d.card("hris", 920, 110, "HRIS MCP", "leave, directory", icon="cloud_run", w=300, accent=GREEN)
    d.card("tick", 920, 190, "Ticketing MCP", "IT tickets", icon="cloud_run", w=300, accent=GREEN)
    d.card("comp", 920, 270, "Compensation MCP", "salaries · denied by policy", icon="cloud_run", w=300, accent=RED)
    d.card("gem", 920, 375, "Gemini 3.8 Flash", "global endpoint", icon="vertexai_core", w=300)
    d.zone(900, 440, 340, 100, "Google Workspace · optional", "external", dashed=True)
    d.card("cal", 920, 478, "Calendar", "employee's own OAuth (Auth Manager)", glyph="calendar", w=300, h=50)

    d.zone(290, 570, 950, 190, "Observability and evaluation", "region", icon="observability")
    d.card("trace", 310, 615, "Cloud Trace", "one trace per turn", icon="trace", w=215)
    d.card("log", 540, 615, "Cloud Logging", "audit + gateway logs", icon="cloud_logging", w=215)
    d.card("mon", 770, 615, "Cloud Monitoring", "dashboard, log metrics", icon="cloud_monitoring", w=215)
    d.card("om", 1000, 615, "Online Monitor", "scores live traces", icon="vertexai", w=220)
    d.text(310, 715, "Evals gate deploys (agents-cli eval run + gate.py); the Online Monitor scores production traces;", 12, MUTED)
    d.text(310, 733, "failures become new eval cases.", 12, MUTED)

    d.edge("emp", "agent", "r", "l", num=1, via=[(262, 89), (262, 127)])
    d.edge("ge", "agent", "r", "l", via=[(262, 169), (262, 127)], dashed=True)
    d.edge("cli", "agent", "r", "l", via=[(262, 249), (262, 127)])
    d.edge("agent", "gw", "r", "l", num=2)
    d.edge("gw", "iap", "b", "t", num=3)
    d.edge("iap", "reg", "b", "t", dashed=True)
    # one egress bus from the gateway to every destination
    d.line([(865, 127), (890, 127)])
    d.line([(890, 127), (890, 503)])
    d.edge((890, 139), "hris", "r", "l", num=4)
    d.edge((890, 219), "tick", "r", "l")
    d.edge((890, 299), "comp", "r", "l", blocked=True, badge_at=0.45)
    d.edge((890, 404), "gem", "r", "l")
    d.edge((890, 503), "cal", "r", "l", dashed=True, color=AMBER)
    d.edge((660, 300), (660, 570), num=5, via=[(660, 300)])

    d.legend(35, 360, [
        "Employee asks the agent",
        "Outbound call to the gateway",
        "IAP checks the access policy",
        "Allowed calls reach Cloud Run",
        "Telemetry lands in Observability",
    ], 220, title="Flow")
    d.text(35, 510, "Amber, dashed: optional", 12, AMBER)
    d.text(35, 528, "Red: blocked in step 4", 12, RED)
    return d


def agents() -> Diagram:
    d = Diagram(1180, 540, "Workplace Assistant agent architecture")
    d.zone(20, 20, 1140, 500, "ADK app 'app' · plugins: MemoryBankPlugin (saves every turn)", "runtime", icon="agents")
    d.card("root", 440, 60, "concierge", "routes · small talk · refuses out of scope", icon="agents", w=300, accent=BLUE,
           sub2="PreloadMemoryTool")
    d.card("hr", 60, 200, "hr_policy_agent", "policy questions, salary bands", icon="agents", w=300)
    d.card("leave", 440, 200, "leave_agent", "balance, requests, new leave", icon="agents", w=300)
    d.card("it", 820, 200, "it_desk_agent", "IT problems and tickets", icon="agents", w=300)
    d.line([(590, 118), (590, 160)])
    d.line([(210, 160), (970, 160)])
    for k in ("hr", "leave", "it"):
        x = d.boxes[k].x + 150
        d.edge((x, 160), k, "b", "t")
    d.text(600, 182, "transfer_to_agent", 11.5, MUTED)
    tools = {
        "hr": [("handbook_search", "BM25 over the handbook", None, "doc", None),
               ("compensation MCP", "get_salary_band (Cloud Run)", "cloud_run", None, RED)],
        "leave": [("HRIS MCP", "balance · requests · submit (Cloud Run)", "cloud_run", None, None),
                  ("create_calendar_event", "employee's OAuth via Auth Manager", None, "calendar", AMBER)],
        "it": [("ticketing MCP", "open · status · list (Cloud Run)", "cloud_run", None, None),
               ("handbook_search", "IT rules", None, "doc", None)],
    }
    for k, items in tools.items():
        x = d.boxes[k].x + 30
        for i, (title, sub, icon, glyph, accent) in enumerate(items):
            key = f"{k}-{i}"
            d.card(key, x, 295 + i * 72, title, sub, icon=icon, glyph=glyph, w=270, h=56, accent=accent)
            d.edge((x - 12, 323 + i * 72), key, "r", "l", dashed=accent == AMBER, color=AMBER if accent == AMBER else None)
        d.line([(x - 12, 258), (x - 12, 323 + 72)], dashed=False)
    d.text(40, 470, "Every agent: PreloadMemoryTool recalls the employee's facts at the start of a turn; after_tool_callback "
                    "writes a workplace.tool_blocked", 12, MUTED)
    d.text(40, 488, "audit event when a call is refused. The employee's email travels to the MCP servers in the "
                    "X-User-Email header, set from the session, never by the model.", 12, MUTED)
    return d

def setup() -> Diagram:
    d = Diagram(1180, 470, "Step 1: what setup.sh creates")
    d.zone(20, 20, 210, 430, "You", "user")
    d.card("shell", 35, 70, "Cloud Shell", "./scripts/setup.sh", icon="cloud_shell", w=180)
    d.zone(250, 20, 910, 430, "Your project · europe-west1", "cloud")
    d.card("apis", 270, 70, "Service Usage", "19 APIs enabled", glyph="check", w=190)
    d.card("cb", 270, 160, "Cloud Build", "one image, 3 servers", icon="cloud_build", w=190)
    d.card("ar", 270, 250, "Artifact Registry", "workshop repo", icon="artifact_registry", w=190)
    d.zone(500, 50, 240, 280, "Cloud Run · no public access", "region", icon="cloud_run")
    d.card("h", 515, 90, "hris-mcp", "MCP_SERVER=hris", icon="cloud_run", w=210)
    d.card("t", 515, 170, "ticketing-mcp", "MCP_SERVER=ticketing", icon="cloud_run", w=210)
    d.card("c", 515, 250, "compensation-mcp", "MCP_SERVER=compensation", icon="cloud_run", w=210)
    d.card("reg", 780, 90, "Agent Registry", "3 MCP servers + Google APIs", icon="service_discovery", w=230)
    d.card("lm", 780, 170, "Logs-based metrics", "blocked tool calls", icon="cloud_logging", w=230)
    d.zone(770, 240, 370, 190, "In the background (~6 min, ready by step 4)", "region", dashed=True)
    d.card("gw", 785, 280, "Agent Gateway", "egress, not bound yet", icon="network_security", w=200)
    d.card("iap", 785, 355, "IAP authorization", "REQUEST_AUTHZ policy", icon="identity-aware_proxy", w=200)
    d.edge("shell", "apis", "r", "l", num=1, oa=0.5, via=[(240, 99)])
    d.edge("shell", "cb", "r", "l", num=2, via=[(245, 99), (245, 189)])
    d.edge("cb", "ar", "b", "t", label="push image")
    d.edge("ar", "h", "r", "l", num=3, via=[(480, 279), (480, 119)])
    d.edge("ar", "t", "r", "l", via=[(480, 279), (480, 199)])
    d.edge("ar", "c", "r", "l")
    d.edge("h", "reg", "r", "l", num=4)
    d.edge("t", "lm", "r", "l", num=5)
    d.edge("c", "gw", "r", "l", num=6, via=[(760, 279), (760, 309)])
    d.edge("gw", "iap", "b", "t")
    d.legend(35, 200, [
        "Enable APIs",
        "Build the MCP image",
        "Deploy 3 services",
        "Register them",
        "Create metrics",
        "Start the gateway",
    ], 190, title="setup.sh, in order")
    return d


def deploy() -> Diagram:
    d = Diagram(1180, 470, "Step 2: what agents-cli deploy does")
    d.zone(20, 20, 230, 430, "Cloud Shell", "user", icon="cloud_shell")
    d.card("src", 35, 60, "Project folder", "app/, Dockerfile, .env", glyph="doc", w=200)
    d.card("cli", 35, 145, "agents-cli deploy", "--agent-identity", glyph="terminal", w=200, accent=BLUE)
    d.card("run", 35, 375, "agents-cli run --url", "or the console playground", glyph="terminal", w=200)
    d.legend(35, 240, ["Upload source", "Build and roll out", "Agent Identity", "Grant tool access", "Chat"], 200)

    d.zone(280, 20, 880, 430, "Google Cloud", "cloud")
    d.card("build", 300, 75, "Container build", "Google-managed project", icon="cloud_build", w=210)
    d.zone(540, 50, 600, 300, "Agent Runtime · workplace-assistant", "runtime", icon="vertexai")
    d.card("ctr", 560, 90, "Container (FastAPI + ADK)", "min 0 · max 10 · 1 vCPU · 4 GiB", icon="agents", w=290,
           accent=BLUE, sub2="scales to zero when idle")
    d.card("tel", 870, 90, "Telemetry", "Cloud Trace · Logging", icon="trace", w=250)
    d.card("sess", 560, 185, "Sessions", "one conversation", icon="vertexai", w=175)
    d.card("mem", 750, 185, "Memory Bank", "step 3", icon="vertexai", w=175)
    d.card("id", 940, 185, "Agent Identity", "principal://agents…", icon="workload_identity_pool", w=180)
    d.card("api", 560, 275, ":query / :streamQuery", "IAM-protected HTTP API", glyph="terminal", w=290)
    d.card("ge", 560, 375, "Gemini Enterprise", "agents-cli publish gemini", icon="agents", w=290)
    d.card("mcp", 905, 375, "Cloud Run MCP servers", "roles/run.invoker granted", icon="cloud_run", w=250)

    d.edge("cli", "src", "t", "b", label="packages")
    d.edge("cli", "build", "r", "l", num=1, via=[(265, 174), (265, 104)])
    d.edge("build", "ctr", "r", "l", num=2, ob=0.5, via=[(530, 104), (530, 119)])
    d.badge(1120, 191, 3)
    d.edge("id", "mcp", "b", "t", num=4, label="grant_agent_access.sh")
    d.edge("run", "api", "r", "l", num=5, via=[(520, 404), (520, 304)])
    d.edge("ge", "api", "t", "b", dashed=True, color=AMBER)
    return d

def remember() -> Diagram:
    d = Diagram(1180, 470, "Step 3: Sessions versus Memory Bank")
    days = [("Monday · session A", "“I'm on the platform team in the", "Istanbul office, I like Fridays off.”"),
            ("Wednesday · session B", "“How many leave days do I have?”", "→ 14 days, Istanbul rules"),
            ("Friday · session C", "“Book next Friday off.”", "→ booked; on-call swap reminder")]
    for i, (title, l1, l2) in enumerate(days):
        x = 40 + i * 300
        d.zone(x, 30, 270, 150, title, "runtime" if i == 0 else "region", icon="vertexai")
        d.text(x + 16, 75, "Session: events and state", 12, MUTED)
        d.text(x + 16, 104, l1, 12.5, INK)
        d.text(x + 16, 124, l2, 12.5, INK)
        d.text(x + 16, 160, "Gone when the conversation ends", 11.5, MUTED, italic=True)
    d.zone(40, 250, 870, 190, "Memory Bank · scope {app: \"app\", user: \"cli-user\"}", "cloud", icon="vertexai")
    d.card("f1", 60, 300, "team_and_office", "platform team, Istanbul office", icon="vertexai", w=260)
    d.card("f2", 340, 300, "work_preferences", "prefers Fridays off", icon="vertexai", w=260)
    d.text(60, 410, "Extraction runs in Memory Bank (an LLM pass over the turn), about 1–2 minutes after it.", 12, MUTED)
    d.edge((175, 180), (190, 300), num=1, label="generate memories")
    d.edge((475, 250), (475, 180), num=2, label="recall at turn start", color=BLUE)
    d.edge((775, 250), (775, 180), num=3, color=BLUE)
    d.card("note", 935, 250, "In code", "MemoryBankPlugin saves", glyph="doc", w=225, h=74, sub2="PreloadMemoryTool recalls")
    d.legend(940, 370, ["Monday's facts saved", "Wednesday recalls them", "Friday uses the office"], 220)
    return d


def secure() -> Diagram:
    d = Diagram(1180, 560, "Step 4: identity and Agent Gateway checks")
    d.zone(20, 20, 300, 520, "Agent Runtime", "runtime", icon="vertexai")
    d.card("agent", 40, 60, "workplace-assistant", "Agent Identity (SPIFFE)", icon="workload_identity_pool", w=260, accent=BLUE)
    d.text(40, 155, "Acts as itself", 13, INK, 500)
    d.text(40, 175, "ID token for its own principal", 12, MUTED)
    d.text(40, 191, "→ HRIS, ticketing (IAM, like 2-legged)", 12, MUTED)
    d.text(40, 230, "Acts for the employee", 13, INK, 500)
    d.text(40, 250, "The employee's own OAuth token", 12, MUTED)
    d.text(40, 266, "→ Calendar (3-legged, Auth Manager)", 12, MUTED)
    d.card("am", 40, 300, "Auth Manager", "consent once · token vault", icon="secret_manager", w=260)
    d.card("cal", 40, 410, "Google Calendar", "the employee's calendar", glyph="calendar", w=260)
    d.edge("am", "cal", "b", "t", dashed=True, color=AMBER, label="user's token")

    d.zone(350, 20, 500, 520, "Agent Gateway · egress", "cloud", icon="network_security")
    d.card("c1", 375, 60, "1 · Agent Registry", "which destination is this?", icon="service_discovery", w=450)
    d.card("c2", 375, 160, "2 · IAM access policy (IAP)", "can this agent identity reach it?", icon="identity-aware_proxy",
           w=450, accent=BLUE, sub2="ALLOW HRIS, ticketing, Google APIs · DENY compensation")
    d.card("c3", 375, 270, "3 · Semantic policy + Model Armor", "optional · content and intent checks", icon="cloud_armor",
           w=450, sub2="Preview · needs VPC connectivity")
    d.edge("agent", "c1", "r", "l", num=1)
    d.edge("c1", "c2", "b", "t", num=2)
    d.edge("c2", "c3", "b", "t", num=3, dashed=True)
    d.text(375, 382, "Default deny: unregistered or unlisted destinations", 12.5, INK, 500)
    d.text(375, 400, "are refused, Google APIs included.", 12.5, INK, 500)
    d.text(375, 432, "Owners: the security team writes the policy; the agent", 12, MUTED)
    d.text(375, 448, "team registers its tools; the customer's IAM admins", 12, MUTED)
    d.text(375, 464, "review the agent principals.", 12, MUTED)
    d.text(375, 500, "Ingress mode (CLIENT_TO_AGENT) puts a gateway in front", 12, MUTED, italic=True)
    d.text(375, 516, "of the agent instead: Model Armor on queries.", 12, MUTED, italic=True)

    d.zone(890, 20, 270, 520, "Destinations", "region", icon="cloud_run")
    d.card("hris", 910, 60, "HRIS MCP", "allowed", icon="cloud_run", w=230, accent=GREEN)
    d.card("tick", 910, 140, "Ticketing MCP", "allowed", icon="cloud_run", w=230, accent=GREEN)
    d.card("apis", 910, 220, "Google APIs", "Gemini, Sessions, telemetry", icon="vertexai", w=230, accent=GREEN)
    d.card("comp", 910, 330, "Compensation MCP", "403 Egress request is not", icon="cloud_run", w=230, accent=RED,
           sub2="authorized → logged")
    d.line([(825, 196), (870, 196)])
    d.line([(870, 89), (870, 359)])
    d.edge((870, 89), "hris", "r", "l", num=4)
    d.edge((870, 169), "tick", "r", "l")
    d.edge((870, 249), "apis", "r", "l")
    d.edge((870, 359), "comp", "r", "l", blocked=True, badge_at=0.45)
    return d

def observe() -> Diagram:
    d = Diagram(1180, 520, "Step 5: one leave request as a trace, and where telemetry lands")
    d.zone(20, 20, 760, 480, "Cloud Trace · one turn (“Book next Monday off as a half day…”)", "cloud", icon="trace")
    rows = [
        ("invoke_workflow concierge", 0.0, 12.9, 0, BLUE),
        ("invoke_agent concierge", 0.05, 2.1, 1, BLUE),
        ("call_llm → generate_content", 0.1, 1.9, 2, "#7baaf7"),
        ("execute_tool transfer_to_agent", 2.0, 0.05, 2, MUTED),
        ("invoke_agent leave_agent", 2.1, 10.8, 1, BLUE),
        ("MCP tools/list", 2.19, 0.16, 2, "#9aa0a6"),
        ("call_llm → generate_content", 2.6, 3.1, 2, "#7baaf7"),
        ("execute_tool get_leave_balance", 5.45, 0.13, 2, GREEN),
        ("call_llm → generate_content", 6.0, 4.0, 2, "#7baaf7"),
        ("execute_tool submit_leave_request", 9.75, 0.13, 2, GREEN),
        ("call_llm → generate_content", 10.2, 2.7, 2, "#7baaf7"),
    ]
    x0, scale, y = 300, 26.0, 70
    for name, start, length, depth, color in rows:
        d.text(40 + depth * 14, y + 12, name, 12, INK)
        d.front.append(f'<rect x="{x0 + start * scale:.1f}" y="{y}" width="{max(length * scale, 3):.1f}" height="16" '
                       f'rx="3" fill="{color}"/>')
        y += 30
    for t in range(0, 19, 3):
        d.text(x0 + t * scale, 450, f"{t}s", 11, MUTED, anchor="middle")
    d.text(40, 480, "Blue: agents · light blue: model calls · green: tool calls. Timings are illustrative; yours differ.",
           11.5, MUTED, italic=True)
    d.zone(810, 20, 350, 480, "Where it lands", "region", icon="observability")
    d.card("tr", 830, 60, "Cloud Trace", "spans via telemetry API", icon="trace", w=310)
    d.card("lg", 830, 150, "Cloud Logging", "OTel log records only", icon="cloud_logging", w=310,
           sub2="model I/O events, workplace.tool_blocked")
    d.card("mt", 830, 250, "Cloud Monitoring", "Agent Runtime + ADK metrics", icon="cloud_monitoring", w=310,
           sub2="logs-based metrics, dashboard")
    d.card("gw", 830, 350, "Gateway request log", "allow/deny per request", icon="network_security", w=310)
    d.text(830, 450, "Plain stdout from the container does not reach", 12, MUTED)
    d.text(830, 466, "Cloud Logging on Agent Runtime: log through OTel.", 12, MUTED)
    return d


def evaluate() -> Diagram:
    d = Diagram(1180, 560, "Step 6: the evaluation loop")
    d.zone(20, 20, 1140, 520, "Quality loop", "cloud")
    d.card("set", 60, 80, "Eval set", "evals/cases.yaml → datasets", glyph="doc", w=230)
    d.card("run", 360, 80, "agents-cli eval run", "+ evals/gate.py thresholds", glyph="terminal", w=240, accent=BLUE)
    d.card("dep", 680, 80, "Deploy", "only if the gate passes", icon="vertexai", w=200)
    d.card("prod", 920, 80, "Production traffic", "Agent Runtime sessions", icon="trace", w=210)
    d.card("live", 920, 250, "score_live.sh", "your LLM judges, every turn", glyph="terminal", w=210, accent=BLUE,
           sub2="on demand or scheduled")
    d.card("om", 920, 390, "Online Monitor", "managed, every ~10 minutes", icon="vertexai", w=210,
           sub2="skips multi-agent turns")
    d.card("fail", 560, 250, "Low score or bad session", "find it in Trace / console", icon="cloud_logging", w=280)
    d.card("case", 60, 250, "New eval case", "session_to_eval_case.py", glyph="doc", w=230)
    d.edge("set", "run", "r", "l", num=1)
    d.edge("run", "dep", "r", "l", num=2, label="pass")
    d.edge("dep", "prod", "r", "l", num=3)
    d.edge("prod", "live", "b", "t", num=4)
    d.edge("live", "fail", "l", "r", num=5)
    d.edge("fail", "case", "l", "r", num=6)
    d.edge("case", "set", "t", "b", num=7)
    d.edge("om", "fail", "l", "b", dashed=True, label="when it can score", via=[(700, 425)])
    d.text(60, 410, "Gate metrics: routed_to_expected_agent · tool_trajectory (right tool and arguments) · "
                    "no_compensation_leak", 12.5, INK)
    d.text(60, 432, "· grounding (LLM judge). agents-cli exits 0 whatever the scores; the gate script decides.", 12.5, INK)
    d.text(60, 466, "Live metrics: grounded · resolved · tool_use (LLM judges on Gemini 3.5 Flash) · no_compensation_leak",
           12.5, INK)
    return d


def runtimes() -> Diagram:
    d = Diagram(1180, 470, "Agent Runtime, Cloud Run or GKE: who runs what")
    rows = ["Agent code", "Container image and server", "Scale, revisions", "Sessions and memory",
            "Agent identity", "Agent Gateway for the agent", "Nodes, cluster, network"]
    cols = [("Agent Runtime", "vertexai", ["you", "google", "google", "google", "google", "google", "google"]),
            ("Cloud Run", "cloud_run", ["you", "you", "google", "either", "you", "preview", "google"]),
            ("GKE", "google_kubernetes_engine", ["you", "you", "you", "either", "you", "preview", "you"])]
    labels = {"you": ("You", "#fce8e6", "#c5221f"), "google": ("Google", "#e8f0fe", "#1967d2"),
              "either": ("You or Agent Platform", "#fef7e0", "#b06000"), "preview": ("Preview sign-up", "#f1f3f4", MUTED)}
    d.zone(20, 20, 1140, 430, "Who owns each layer", "cloud")
    for j, (title, icon, cells) in enumerate(cols):
        x = 330 + j * 270
        d.front.append(d.icon(icon, x + 10, 50, 26))
        d.text(x + 44, 68, title, 14, INK, 600)
    for i, row in enumerate(rows):
        y = 100 + i * 46
        d.text(40, y + 22, row, 13, INK)
        for j, (_t, _i, cells) in enumerate(cols):
            text, fill, color = labels[cells[i]]
            x = 330 + j * 270
            d.front.append(f'<rect x="{x}" y="{y + 4}" width="240" height="30" rx="15" fill="{fill}"/>')
            d.text(x + 120, y + 24, text, 12.5, color, 500, "middle")
    d.text(40, 435, "Start on Agent Runtime; move to Cloud Run or GKE when you need control it doesn't give you.", 12.5, BLUE, 500)
    return d

def main() -> None:
    for name, build in {
        "architecture": architecture, "agents": agents, "step-1-setup": setup, "step-2-deploy": deploy,
        "step-3-remember": remember, "step-4-secure": secure, "step-5-observe": observe,
        "step-6-evaluate": evaluate, "runtimes": runtimes,
    }.items():
        build().write(OUT / f"{name}.svg")
        print(f"wrote diagrams/{name}.svg")


if __name__ == "__main__":
    main()
