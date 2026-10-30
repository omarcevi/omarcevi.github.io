"""Build workshops/match-day-agents/ from the written guide in the trabzonspor_analyst repo.

The guide has one source: guide/match-day-agents.md in github.com/omarcevi/trabzonspor_analyst
(a test there keeps its code snippets identical to the repo). This script turns that Markdown into
a page with the same look as the other workshop guides (the CSS is read from
workshops/devfest-samsun-agent/index.html) and copies its SVG diagrams next to it.

    python3 scripts/build_match_day_guide.py                       # repo checked out next to this one
    python3 scripts/build_match_day_guide.py ~/code/trabzonspor_analyst

Only the Markdown the guide uses is supported: headings, paragraphs, lists (one nested level),
blockquotes, tables, fenced code, linked images with a caption line, and HTML comments
(<!-- source: path --> labels the next code block; other comments are kept as they are).
"""

from __future__ import annotations

import html
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SLUG = "match-day-agents"
BASE = f"/workshops/{SLUG}/"
OUT = ROOT / "workshops" / SLUG
REPO = "https://github.com/omarcevi/trabzonspor_analyst"
COLAB = "https://colab.research.google.com/github/omarcevi/trabzonspor_analyst/blob/main/notebook/match_day_agents.ipynb"
EVENT = "Recipes for Your Agent Systems"
STYLE_FROM = ROOT / "workshops" / "devfest-samsun-agent" / "index.html"

# section ids and the short names in the side index, by heading
SECTIONS = {
    "Setup": ("setup", "Setup"),
    "The data": ("data", "The data"),
    "Step 1 · The Scout": ("step-1", "1 · Scout"),
    "Step 2 · Match Prep": ("step-2", "2 · Match Prep"),
    "Step 3 · Scouting Department": ("step-3", "3 · Scouting Dept"),
    "Step 4 · Tribün": ("step-4", "4 · Tribün"),
    "Step 5 · Technical Director": ("step-5", "5 · Technical Director"),
    "Bonus · Live data over MCP": ("bonus", "Bonus · live MCP"),
    "Which recipe when": ("recipes", "Which recipe when"),
    "Try it yourself": ("try-it", "Try it yourself"),
}
GROUPS = {"step-1": "Steps", "recipes": "Wrap-up"}

EXTRA_CSS = """
    /* match-day-agents: what this guide needs beyond the shared workshop styles */
    .intro { padding: 0 0 2rem; }
    .intro p, .intro li { max-width: 37em; }
    .intro ol.plain { margin: .8rem 0; }
    .intro p + ol, .intro ol + p { margin-top: .8rem; }
    section ul.plain, section ol.plain { margin: .7rem 0; }
    .src { display: block; font-family: var(--mono); font-size: .72rem; color: var(--faint); margin: 1.2rem 0 .3rem; }
    .src a { text-decoration: none; color: var(--faint); } .src a:hover { color: var(--accent); }
    .code { margin: .3rem 0 1rem; }
    .code + .src { margin-top: 1.4rem; }
    .code pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; overflow-wrap: normal; }
    blockquote.sample { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
                        border-radius: 10px; padding: .85rem 1.1rem; margin: .8rem 0 1.2rem; font-size: .93rem; max-width: 42em; }
    blockquote.sample::before { content: "agent output"; display: block; font-family: var(--mono); font-size: .68rem;
                                letter-spacing: .07em; text-transform: uppercase; color: var(--accent); margin-bottom: .35rem; }
    blockquote.sample ul, blockquote.sample ol { padding-left: 1.2rem; margin: .3rem 0; }
    blockquote.sample li + li { margin-top: .25rem; }
    blockquote.sample p + p, blockquote.sample p + ul, blockquote.sample ul + p { margin-top: .5rem; }
    .table-wrap { overflow-x: auto; margin: 1rem 0; }
    table { width: 100%; border-collapse: collapse; font-size: .92rem; }
    th, td { text-align: left; vertical-align: top; padding: .55rem .7rem .55rem 0; border-bottom: 1px solid var(--border); }
    th { font-family: var(--mono); font-size: .7rem; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
"""


# --- Markdown → HTML (the subset the guide uses) -------------------------------------


def inline(text: str) -> str:
    """Code spans, links, bold and italics; everything else is escaped."""
    codes: list[str] = []

    def keep(m):
        codes.append(f"<code>{html.escape(m.group(1))}</code>")
        return f"\x00{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", keep, text)
    text = html.escape(text, quote=False)
    text = re.sub(r'\[([^\]]+)\]\(([^)\s]+)(?: "[^"]*")?\)',
                  lambda m: f'<a href="{html.escape(link(m.group(2)))}">{m.group(1)}</a>', text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], text)


def link(url: str) -> str:
    if url.startswith("images/"):
        return BASE + "diagrams/" + url.removeprefix("images/")
    if url.startswith("http") or url.startswith("/") or url.startswith("#"):
        return url
    return f"{REPO}/blob/main/{url}"


def svg_size(path: Path) -> tuple[str, str]:
    head = path.read_text(encoding="utf-8")[:600]
    return re.search(r'width="(\d+)"', head).group(1), re.search(r'height="(\d+)"', head).group(1)


def figure(line: str, caption: str, images: Path) -> str:
    m = re.match(r'\[!\[([^\]]*)\]\(images/([^)]+)\)\]\(images/[^)\s]+(?: "[^"]*")?\)', line)
    alt, name = m.group(1), m.group(2)
    w, h = svg_size(images / name)
    src = BASE + "diagrams/" + name
    cap = f"\n          <figcaption>{inline(caption)}</figcaption>" if caption else ""
    return (f'<figure class="arch" id="fig-{Path(name).stem}">\n'
            f'          <div class="arch-frame"><a href="{src}" title="Open full size"><img src="{src}" alt="{html.escape(alt)}" '
            f'width="{w}" height="{h}" loading="lazy"></a></div>{cap}\n        </figure>')


def code_block(lang: str, body: str, source: str | None) -> str:
    label = ""
    if source:
        label = f'<span class="src"><a href="{REPO}/blob/main/{source}">{html.escape(source)}</a></span>\n        '
    if lang == "bash":   # shell lines: comments greyed and left out of the copy, long lines wrap
        rows = []
        for line in body.split("\n"):
            cmd, hash_, comment = line.partition("  #")
            rows.append(html.escape(cmd) + (f'<span class="c">  #{html.escape(comment)}</span>' if hash_ else ""))
        return f'{label}<div class="code" data-lang="bash"><pre>' + "\n".join(rows) + "</pre></div>"
    return f'{label}<div class="code" data-lang="{lang or "text"}"><pre><code>{html.escape(body)}</code></pre></div>'


def list_html(lines: list[str]) -> str:
    """A list, with items indented by 2+ spaces nested one level under the previous item."""
    ordered = bool(re.match(r"\d+\. ", lines[0].lstrip()))
    tag = "ol" if ordered else "ul"
    items: list[list] = []
    for line in lines:
        text = re.sub(r"^\s*(?:[-*]|\d+\.) ", "", line)
        if line.startswith("  ") and items:
            items[-1][1].append(text)
        elif re.match(r"^\s*(?:[-*]|\d+\.) ", line):
            items.append([text, []])
        elif items:   # a continuation line of the last item
            items[-1][0] += " " + line.strip()
    out = []
    for text, children in items:
        sub = "".join(f"<li>{inline(c)}</li>" for c in children)
        out.append(f"<li>{inline(text)}" + (f"<ul>{sub}</ul>" if sub else "") + "</li>")
    return f'<{tag} class="plain">' + "".join(out) + f"</{tag}>"


def table_html(lines: list[str]) -> str:
    rows = [[c.strip() for c in line.strip().strip("|").split("|")] for line in lines]
    head, body = rows[0], [r for r in rows[2:]]
    th = "".join(f"<th>{inline(c)}</th>" for c in head)
    tb = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body)
    return f'<div class="table-wrap"><table><thead><tr>{th}</tr></thead><tbody>{tb}</tbody></table></div>'


def blocks(md: str, images: Path) -> list[str]:
    """Markdown → a list of HTML blocks."""
    lines, out, i, source = md.split("\n"), [], 0, None
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
        elif line.startswith("```"):
            lang, body = line[3:].strip(), []
            i += 1
            while not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            out.append(code_block(lang, "\n".join(body), source))
            source = None
            i += 1
        elif line.startswith("<!--"):
            m = re.match(r"<!-- source: (\S+) -->", line)
            if m:
                source = m.group(1)
            else:
                out.append(line.strip())
            i += 1
        elif line.startswith("[!["):
            caption = ""
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and re.match(r"^\*[^*].*\*$", lines[j].strip()):
                caption, i = lines[j].strip()[1:-1], j + 1
            else:
                i += 1
            out.append(figure(line.strip(), caption, images))
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(lines[i])
                i += 1
            out.append(table_html(rows))
        elif line.startswith(">"):
            quoted = []
            while i < len(lines) and lines[i].startswith(">"):
                quoted.append(re.sub(r"^> ?", "", lines[i]))
                i += 1
            out.append('<blockquote class="sample">' + "".join(blocks("\n".join(quoted), images)) + "</blockquote>")
        elif re.match(r"^(?:[-*]|\d+\.) ", line):
            items = []
            while i < len(lines) and lines[i].strip() and (re.match(r"^\s*(?:[-*]|\d+\.) ", lines[i]) or lines[i].startswith("  ")):
                items.append(lines[i])
                i += 1
            out.append(list_html(items))
        elif line.startswith("#"):
            out.append(line)   # headings are handled by the page builder
            i += 1
        else:
            para = []
            while i < len(lines) and lines[i].strip() and not re.match(r"^(?:```|<!--|\[!\[|\||>|#|(?:[-*]|\d+\.) )", lines[i]):
                para.append(lines[i].strip())
                i += 1
            out.append(f"<p>{inline(' '.join(para))}</p>")
    return out


# --- the page ---------------------------------------------------------------------------


def frontmatter(md: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n", md, re.S)
    meta = {}
    for line in m.group(1).split("\n"):
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip().strip('"')
    return meta, md[m.end():]


def build(source_repo: Path) -> None:
    guide = source_repo / "guide" / "match-day-agents.md"
    images = source_repo / "guide" / "images"
    meta, body = frontmatter(guide.read_text(encoding="utf-8"))
    body = re.sub(r"^# .*\n", "", body, count=1, flags=re.M)   # the title goes in the hero

    # split into the intro (before the first ##) and one chunk per ## section
    parts = re.split(r"^## (.+)$", body, flags=re.M)
    intro, sections = parts[0], list(zip(parts[1::2], parts[2::2]))
    toc, html_sections = [], []
    for title, text in sections:
        sid, short = SECTIONS[title.strip()]
        if sid in GROUPS:
            toc.append(f'        <li class="group">{GROUPS[sid]}</li>')
        toc.append(f'        <li><a href="#{sid}"><span class="n">{html.escape(short)}</span></a></li>')
        inner = "\n        ".join(blocks(text, images))
        html_sections.append(f'      <section id="{sid}">\n        <h2>{html.escape(title.strip())}</h2>\n        {inner}\n      </section>')

    style = re.search(r"<style>(.*?)</style>", STYLE_FROM.read_text(encoding="utf-8"), re.S).group(1)
    style = style.rstrip() + "\n" + EXTRA_CSS
    title, desc = meta["title"], meta["description"]
    intro_html = "\n        ".join(blocks(intro, images))

    page = TEMPLATE.format(
        title=html.escape(title), desc=html.escape(desc), base=BASE, style=style, repo=REPO, colab=COLAB,
        event=html.escape(EVENT), toc="\n".join(toc), intro=intro_html, sections="\n\n".join(html_sections),
        script=SCRIPT,
    )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.html").write_text(page, encoding="utf-8")
    (OUT / "diagrams").mkdir(exist_ok=True)
    for svg in sorted(images.glob("*.svg")):
        shutil.copyfile(svg, OUT / "diagrams" / svg.name)
    print(f"wrote {OUT.relative_to(ROOT)}/index.html and {len(list(images.glob('*.svg')))} diagrams")


TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} — DevFest Trabzon 2026 · Omar Elcircevi</title>
  <meta name="description" content="{desc}">
  <link rel="canonical" href="https://omarcevi.dev{base}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="https://omarcevi.dev{base}">
  <meta property="og:image" content="https://omarcevi.dev/og-image.png">
  <meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#111318" media="(prefers-color-scheme: dark)">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
  <noscript><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet"></noscript>
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
  <!-- Generated by scripts/build_match_day_guide.py from guide/match-day-agents.md in {repo}: edit the guide there, then rebuild. -->
  <style>{style}  </style>
</head>
<body>
<div class="page">
  <div class="topbar">
    <span class="crumbs"><a href="/">omarcevi.dev</a><span class="ws"> / <a href="/#talks">workshops</a></span> / <a class="here" href="{base}">match-day-agents</a></span>
    <nav aria-label="Guide sections">
      <a href="#step-1">Steps</a>
      <a href="#recipes">Cheat sheet</a>
      <a href="{repo}">GitHub</a>
    </nav>
    <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle dark theme">
      <svg class="i-moon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z"/></svg>
      <svg class="i-sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/></svg>
    </button>
  </div>

  <div class="layout">
    <aside class="toc" aria-label="On this page">
      <p class="label">On this page</p>
      <ol>
        <li><a href="#overview"><span class="n">Overview</span></a></li>
{toc}
      </ol>
    </aside>

    <main>
      <header class="hero" id="overview">
        <p class="kicker">DevFest Trabzon 2026 · Workshop guide · about 15 minutes to read</p>
        <h1>{title}</h1>
        <p class="part-of">The written version of <em>{event}</em> by Omar Elcircevi</p>
        <p class="tagline">{desc}</p>
        <div class="actions">
          <a class="btn primary" href="#setup">Start with the setup</a>
          <a class="btn" href="{repo}">Code on GitHub</a>
          <a class="btn" href="{colab}">Open in Colab</a>
        </div>
      </header>

      <div class="intro">
        {intro}
      </div>

{sections}

      <footer>
        <p><a href="/">omarcevi.dev</a> · <a href="{repo}">source</a></p>
        <p>DevFest Trabzon · 31 October 2026</p>
      </footer>
    </main>
  </div>
</div>

<script>{script}</script>
</body>
</html>
"""

SCRIPT = """
(() => {
  // Copy buttons on code blocks. Shell blocks copy without their # comments; code keeps its blank lines.
  const fallbackCopy = text => {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    t.remove(); return ok;
  };
  const copy = (btn, text) => {
    const done = () => { btn.textContent = 'copied'; btn.classList.add('ok');
      setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('ok'); }, 1400); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => { if (fallbackCopy(text)) done(); });
    else if (fallbackCopy(text)) done();
  };
  document.querySelectorAll('.code').forEach(block => {
    const pre = block.querySelector('pre');
    const b = document.createElement('button'); b.className = 'copy'; b.type = 'button'; b.textContent = 'copy';
    b.setAttribute('aria-label', 'Copy code');
    b.addEventListener('click', () => {
      const clone = pre.cloneNode(true);
      clone.querySelectorAll('.c').forEach(c => c.remove());
      let lines = clone.textContent.split('\\n').map(l => l.replace(/\\s+$/, ''));
      if (block.dataset.lang === 'bash') lines = lines.filter(l => l);
      copy(b, lines.join('\\n').replace(/^\\n+|\\n+$/g, ''));
    });
    block.appendChild(b);
  });

  // Highlight the section you're reading in the side index
  const links = [...document.querySelectorAll('.toc a')];
  const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const targets = [...byId.keys()].map(id => document.getElementById(id)).filter(Boolean);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) {
        links.forEach(a => a.classList.remove('active'));
        const a = byId.get(e.target.id); if (a) a.classList.add('active');
      }});
    }, { rootMargin: '-20% 0px -70% 0px' });
    targets.forEach(t => io.observe(t));
  }

  // Diagrams open magnified in a dialog over the page; Esc, a click anywhere or the close button closes it.
  // A modified click still opens the SVG itself, and so does any click in a browser without <dialog>.
  const box = document.createElement('dialog');
  if (box.showModal) {
    box.className = 'lightbox'; box.setAttribute('aria-label', 'Diagram');
    box.innerHTML = '<button type="button" class="lightbox-close" aria-label="Close"><svg viewBox="0 0 16 16" aria-hidden="true">'
      + '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button><img alt="">';
    const big = box.querySelector('img');
    document.body.appendChild(box);
    document.querySelectorAll('.arch-frame a').forEach(a => a.addEventListener('click', e => {
      const img = a.querySelector('img');
      if (!img || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      big.src = a.href; big.alt = img.alt;
      big.style.setProperty('--ratio', img.getAttribute('width') / img.getAttribute('height'));
      box.showModal(); box.scrollTo(0, 0);
    }));
    box.addEventListener('click', () => box.close());
  }

  // Theme toggle: flips light/dark and remembers it (applyTheme and the saved choice are read in <head>)
  const btn = document.getElementById('theme-toggle'), root = document.documentElement;
  const os = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
  const current = () => root.getAttribute('data-theme') || (os && os.matches ? 'dark' : 'light');
  const label = () => {
    const l = `Switch to ${current() === 'dark' ? 'light' : 'dark'} theme`;
    btn.setAttribute('aria-label', l); btn.title = l;
  };
  btn.addEventListener('click', () => {
    const t = current() === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem('theme', t); } catch (e) {}
    label();
  });
  if (os && os.addEventListener) os.addEventListener('change', label);
  label();
})();
"""


if __name__ == "__main__":
    build(Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else ROOT.parent / "trabzonspor_analyst")
