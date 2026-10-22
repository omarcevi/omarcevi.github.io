"""Build the static pages of workshops/cloud-agents-workshop/.

Plain HTML, same look as workshops/adk-multi-agent-workshop (shared guide.css and
guide.js in the workshop folder). Page bodies live in scripts/deploy_agents_guide/*.html;
this script wraps them with the head, top bar, side index, pager and footer.

    python3 scripts/build_deploy_agents_guide.py
"""

from __future__ import annotations

import html
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(__file__).resolve().parent / "deploy_agents_guide"
OUT = ROOT / "workshops" / "cloud-agents-workshop"
BASE = "/workshops/cloud-agents-workshop/"
REPO = "https://github.com/omarcevi/cloud-agents-workshop"
GUIDE_TITLE = "Deploying your agents on Google Cloud Agent Platform"

# (slug, short name for the index, page title, minutes, description)
PAGES = [
    ("", "Overview", "Deploying your agents on Google Cloud Agent Platform", None,
     "Follow-along guide: deploy a multi-agent Workplace Assistant to Agent Runtime with Agent Identity, Memory Bank, Agent Gateway, Cloud Trace and evals."),
    ("step-1", "1 · Set up", "Step 1 · Set up", 5, "Enable APIs, deploy three MCP servers to Cloud Run and register them."),
    ("step-2", "2 · Deploy", "Step 2 · Deploy", 8, "Deploy the agent to Agent Runtime with its own Agent Identity."),
    ("step-3", "3 · Remember", "Step 3 · Remember", 6, "Sessions versus Memory Bank: facts that follow an employee across conversations."),
    ("step-4", "4 · Secure", "Step 4 · Secure", 8, "Agent Identity, delegated OAuth and Agent Gateway: block a tool with policy, not code."),
    ("step-5", "5 · Observe", "Step 5 · Observe", 5, "Follow one leave request through Cloud Trace and build the dashboard."),
    ("step-6", "6 · Evaluate", "Step 6 · Evaluate", 7, "Gate deploys on an eval set and score live traffic with an Online Monitor."),
    ("runtimes", "Runtime choice", "Agent Runtime, Cloud Run or GKE", None, "When to use each runtime for agents."),
    ("production", "Production checklist", "Production readiness checklist", None, "What to settle before an agent goes live at a customer."),
    ("teardown", "Teardown", "Teardown", None, "Delete everything the lab created."),
    ("reading", "Further information", "Further information", None, "Official documentation for every product used in the lab."),
]

HEAD = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}{suffix} · Omar Elcircevi</title>
  <meta name="description" content="{desc}">
  <link rel="canonical" href="https://omarcevi.dev{url}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{title}{suffix}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="https://omarcevi.dev{url}">
  <meta property="og:image" content="https://omarcevi.dev/og-image.png">
  <meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#111318" media="(prefers-color-scheme: dark)">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script>
  // a theme picked with the top-bar toggle (shared with omarcevi.dev) overrides the OS setting; applied before first paint
  (d => {{
    d.classList.add('js');
    window.applyTheme = t => {{
      d.setAttribute('data-theme', t);
      document.querySelectorAll('meta[name="theme-color"]').forEach(m => {{ m.content = t === 'dark' ? '#111318' : '#f7f7f5'; }});
    }};
    try {{ const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') applyTheme(t); }} catch (e) {{}}
  }})(document.documentElement);
  </script>
  <link rel="stylesheet" href="{base}guide.css">
</head>
<body>
<div class="page">
  <div class="topbar">
    <span class="crumbs"><a href="/">omarcevi.dev</a><span class="ws"> / <a href="/#talks">workshops</a></span> / <a class="here" href="{base}">cloud-agents-workshop</a>{crumb}</span>
    <nav aria-label="Workshop sections">
      <a href="{base}">Overview</a>
      <a href="{base}step-1/">Steps</a>
      <a href="{base}production/">Checklist</a>
      <a href="{base}teardown/">Teardown</a>
      <a href="{repo}">GitHub</a>
    </nav>
    <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle dark theme">
      <svg class="i-moon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z"/></svg>
      <svg class="i-sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/></svg>
    </button>
  </div>

  <div class="layout">
    <aside class="toc" aria-label="Guide pages">
      <p class="label">Follow along</p>
      <ol>
{toc}
      </ol>
    </aside>

    <main>
"""

FOOT = """
{pager}
      <footer>
        <p><a href="/">omarcevi.dev</a> · <a href="{repo}">source</a> · Google Cloud icons from <a href="https://cloud.google.com/icons">cloud.google.com/icons</a></p>
        <p>Google Cloud Day Türkiye · 27 October 2026</p>
      </footer>
    </main>
  </div>
</div>
<script src="{base}guide.js"></script>
</body>
</html>
"""


def toc(current: str) -> str:
    lines = []
    for slug, short, _title, minutes, _desc in PAGES:
        if slug == "step-1":
            lines.append('        <li class="group">Lab</li>')
        if slug == "runtimes":
            lines.append('        <li class="group">After the lab</li>')
        cls = ' class="here"' if slug == current else ""
        mod = f' data-mod="{slug}"' if slug.startswith("step-") else ""
        t = f'<span class="t">{minutes} min</span>' if minutes else ""
        lines.append(f'        <li><a{cls}{mod} href="{BASE}{slug + "/" if slug else ""}"><span class="n">{short}</span>{t}</a></li>')
    return "\n".join(lines)


def pager(index: int) -> str:
    prev_link = next_link = ""
    if index > 0:
        slug, short = PAGES[index - 1][0], PAGES[index - 1][1]
        prev_link = f'<a class="prev" href="{BASE}{slug + "/" if slug else ""}">← {short}</a>'
    if index < len(PAGES) - 1:
        slug, short = PAGES[index + 1][0], PAGES[index + 1][1]
        next_link = f'<a class="next" href="{BASE}{slug}/">{short} →</a>'
    return f'      <nav class="pager" aria-label="Previous and next page">{prev_link}{next_link}</nav>'


def build() -> None:
    for i, (slug, short, title, _minutes, desc) in enumerate(PAGES):
        body = (SRC / f"{slug or 'index'}.html").read_text(encoding="utf-8")
        url = BASE + (slug + "/" if slug else "")
        crumb = f'<span class="cur"> / <span class="here">{html.escape(short)}</span></span>' if slug else ""
        suffix = f" · {GUIDE_TITLE}" if slug else ""
        page = (
            HEAD.format(title=html.escape(title), suffix=html.escape(suffix), desc=html.escape(desc), url=url, base=BASE, repo=REPO, crumb=crumb,
                        toc=toc(slug))
            + body.replace("{{BASE}}", BASE).replace("{{REPO}}", REPO)
            + FOOT.format(pager=pager(i), base=BASE, repo=REPO)
        )
        target = OUT / slug / "index.html" if slug else OUT / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page, encoding="utf-8")
        print(f"wrote {target.relative_to(ROOT)}")


if __name__ == "__main__":
    build()
