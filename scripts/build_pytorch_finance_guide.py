"""Build workshops/pytorch-finance-workshop/ from the written guide in the pytorch-finance-workshop repo.

The guide has one source: guide/pytorch-finance-workshop.md in github.com/omarcevi/pytorch-finance-workshop.
This script splits that Markdown into pages, one per section of the guide, with the same look and navigation
as workshops/coding-agent-workshop and workshops/match-day-agents (side index of pages, previous/next links,
shared guide.css and guide.js), and copies its SVG diagrams.

    python3 scripts/build_pytorch_finance_guide.py                       # repo checked out next to this one
    python3 scripts/build_pytorch_finance_guide.py /content/pytorch-finance-workshop
"""

from __future__ import annotations

import html
import io
import keyword
import re
import shutil
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SLUG = "pytorch-finance-workshop"
BASE = f"/workshops/{SLUG}/"
OUT = ROOT / "workshops" / SLUG
REPO = "https://github.com/omarcevi/pytorch-finance-workshop"
COLAB_STARTER = "https://colab.research.google.com/github/omarcevi/pytorch-finance-workshop/blob/main/notebooks/workshop_starter.ipynb"
COLAB_SOLUTION = "https://colab.research.google.com/github/omarcevi/pytorch-finance-workshop/blob/main/notebooks/workshop_solution.ipynb"
GUIDE_SHORT = "Finansal Verilerle Yapay Zekâyı Buluşturmak"
CSS_FROM = ROOT / "workshops" / "cloud-agents-workshop" / "guide.css"

# (slug, name in the side index, the guide's ## headings on this page, one-line description)
PAGES = [
    ("", "Genel Bakış", [], None),
    ("step-1", "1 · Kurulum ve Veri", ["Bölüm 1 · Kurulum ve Veri"], "THYAO.IS verisini indirme, yedek (snapshot) mekanizması, OHLCV ve düzeltilmiş fiyatların görselleştirilmesi."),
    ("step-2", "2 · Temizlik ve Özellikler", ["Bölüm 2 · Temizlik ve Özellikler"], "Eksik günler (ffill), log getiri, hareketli ortalama, volatilite, RSI, kronolojik bölme (%70/%15/%15) ve sızıntısız StandardScaler."),
    ("step-3", "3 · PyTorch Temelleri", ["Bölüm 3 · PyTorch Temelleri"], "Tensor, 30 günlük SlidingWindowDataset, DataLoader, nn.LSTM mimarisi, tensör boyutları ve 5 adımlı eğitim döngüsü."),
    ("step-4", "4 · Fiyat Tahmini ve Sürpriz", ["Bölüm 4 · Fiyat Tahmini ve Sürpriz"], "Ertesi gün fiyat tahmini, 'Yarın = Bugün' saf referans modeliyle MAE/RMSE karşılaştırması ve 1 günlük gecikme (lag) analizi."),
    ("step-5", "5 · Doğru Kurulum", ["Bölüm 5 · Doğru Kurulum"], "Getiri tabanlı özelliklerle ertesi gün yön sınıflandırması (BCEWithLogitsLoss), çoğunluk sınıfı referansı ve 4 katlı Walk-Forward doğrulama."),
    ("step-6", "6 · Meydan Okumalar", ["Bölüm 6 · Meydan Okumalar"], "Kendi sembolünü deneme, hacim özelliği ekleme, GRU ve TinyTransformer modelleri, işlem maliyetli (15 bps) backtest."),
    ("reading", "İleri Okuma", ["İleri Okuma ve Kaynaklar"], "PyTorch resmi dokümantasyonu, zaman serisi doğrulaması (TimeSeriesSplit) ve veri sızıntısı kaynakları."),
]
GROUPS = {"step-1": "Atölye Bölümleri", "reading": "Kaynaklar"}

EXTRA_CSS = """
/* pytorch-finance-workshop: what this guide needs beyond the shared workshop styles */
    :root { --ts-ink: var(--accent); }
    .topbar::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
                     background: linear-gradient(90deg, #ee4c2c 0 35%, #1f77b4 35% 70%, #2ca02c 70%); }
    .ts-chips { display: inline-flex; gap: .3rem; margin-right: .6rem; vertical-align: -.05em; }
    .ts-chips i { width: .62rem; height: .62rem; border-radius: 3px; background: #ee4c2c; }
    .ts-chips i:nth-child(2) { background: #1f77b4; } .ts-chips i:nth-child(3) { background: #2ca02c; }
    .intro { padding: 0 0 2rem; }
    .intro p, .intro li { max-width: 39em; }
    .intro ol.plain, .intro ul.plain { margin: .8rem 0; }
    .intro p + ol, .intro ol + p, .intro p + ul, .intro ul + p { margin-top: .8rem; }
    section ul.plain, section ol.plain { margin: .7rem 0; }
    .part-of { font-family: var(--mono); font-size: .8rem; color: var(--muted); margin-bottom: 1rem; }
    .part-of em { font-style: normal; color: var(--text); }
    figure.arch { margin: .9rem 0 1.4rem; }
    .page-h1 { font-size: clamp(1.8rem, 4vw, 2.4rem); margin-bottom: .9rem; }
    .src { display: block; font-family: var(--mono); font-size: .72rem; color: var(--faint); margin: 1.2rem 0 .3rem; }
    .src a { text-decoration: none; color: var(--faint); } .src a:hover { color: var(--accent); }
    .code { margin: .3rem 0 1rem; }
    .code pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; overflow-wrap: normal; }
    .code pre { padding-top: 2.4rem; }
    .code.vsc { background: #1e1e1e; border-color: #2b2b2b; color: #d4d4d4; overflow: hidden; }
    .code.vsc .vsc-bar { display: flex; align-items: flex-end; height: 2.15rem; background: #252526; border-bottom: 1px solid #2b2b2b; }
    .code.vsc .vsc-tab { display: inline-flex; align-items: center; gap: .45rem; height: 100%; padding: 0 .95rem; background: #1e1e1e;
                         border-top: 1px solid #0078d4; color: #ffffff; font-size: .74rem; }
    .code.vsc .vsc-dir { color: #8b8b8b; margin-left: .35rem; }
    .code.vsc .vsc-icon { width: .62rem; height: .62rem; border-radius: 2px; background: linear-gradient(135deg, #3572a5 50%, #ffd43b 50%); }
    .code.vsc pre { display: grid; grid-template-columns: auto minmax(0, 1fr); padding: .8rem 1rem .9rem 0; overflow-x: auto; }
    .code.vsc pre code { overflow: visible; }
    .code.vsc .gutter { color: #6e7681; text-align: right; padding: 0 1.1rem 0 1rem; user-select: none; min-width: 2.8rem; }
    .code.vsc .copy { top: .38rem; color: #a0a0a0; border-color: #3c3c3c; }
    .code.vsc .copy:hover { color: #ffffff; border-color: #6e6e6e; }
    .tk-kw { color: #569cd6; } .tk-ctl { color: #c586c0; } .tk-fn { color: #dcdcaa; } .tk-cls { color: #4ec9b0; }
    .tk-var { color: #9cdcfe; } .tk-const { color: #4fc1ff; } .tk-str { color: #ce9178; } .tk-num { color: #b5cea8; }
    .tk-com { color: #6a9955; } .tk-str .tk-ph, .tk-ph { color: #569cd6; }
    blockquote.sample { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--ts-ink);
                        border-radius: 10px; padding: .85rem 1.1rem; margin: .8rem 0 1.2rem; font-size: .93rem; max-width: 42em; }
    blockquote.sample::before { content: "önemli not"; display: block; font-family: var(--mono); font-size: .68rem;
                                letter-spacing: .07em; text-transform: uppercase; color: var(--ts-ink); margin-bottom: .35rem; }
    .table-wrap { overflow-x: auto; margin: 1rem 0; }
    table { width: 100%; border-collapse: collapse; font-size: .92rem; }
    th, td { text-align: left; vertical-align: top; padding: .55rem .7rem .55rem 0; border-bottom: 1px solid var(--border); }
    th { font-family: var(--mono); font-size: .7rem; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
    .steps-grid li a span.d { display: block; color: var(--muted); font-size: .9rem; margin-top: .25rem; }
"""


def inline(text: str) -> str:
    codes: list[str] = []

    def keep(m):
        codes.append(f"<code>{html.escape(m.group(1))}</code>")
        return f"\x00{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", keep, text)
    text = html.escape(text, quote=False)
    text = re.sub(
        r'\[([^\]]+)\]\(([^)\s]+)(?: "[^"]*")?\)',
        lambda m: f'<a href="{html.escape(link(m.group(2)))}">{m.group(1)}</a>',
        text,
    )
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], text)


def link(url: str) -> str:
    if url.startswith("images/"):
        return BASE + "diagrams/" + url.removeprefix("images/")
    if url.startswith(("http", "/", "#")):
        return url
    return f"{REPO}/blob/main/{url}"


def svg_size(path: Path) -> tuple[str, str]:
    head = path.read_text(encoding="utf-8")[:600]
    w_m = re.search(r'width="(\d+)"', head)
    h_m = re.search(r'height="(\d+)"', head)
    return (w_m.group(1) if w_m else "960"), (h_m.group(1) if h_m else "400")


def figure(line: str, caption: str, images: Path) -> str:
    m = re.match(r'\[!\[([^\]]*)\]\(images/([^)]+)\)\]\(images/[^)\s]+(?: "[^"]*")?\)', line)
    alt, name = m.group(1), m.group(2)
    w, h = svg_size(images / name)
    src = BASE + "diagrams/" + name
    cap = f"\n          <figcaption>{inline(caption)}</figcaption>" if caption else ""
    return (
        f'<figure class="arch" id="fig-{Path(name).stem}">\n'
        f'          <div class="arch-frame"><a href="{src}" title="Tam boyutta aç"><img src="{src}" alt="{html.escape(alt)}" '
        f'width="{w}" height="{h}" loading="lazy"></a></div>{cap}\n        </figure>'
    )


CONTROL = {
    "return", "if", "elif", "else", "for", "while", "import", "from", "raise", "try", "except",
    "finally", "yield", "await", "async", "with", "break", "continue", "pass", "assert", "del",
}
BUILTIN_TYPES = {"str", "int", "float", "bool", "list", "dict", "tuple", "set", "bytes", "object", "type"}


def _token_class(tokens: list, i: int, depth: int) -> str | None:
    kind, text = tokens[i].type, tokens[i].string
    if kind == tokenize.COMMENT:
        return "com"
    if kind == tokenize.STRING or kind in {getattr(tokenize, n, -1) for n in ("FSTRING_START", "FSTRING_MIDDLE", "FSTRING_END")}:
        return "str"
    if kind == tokenize.NUMBER:
        return "num"
    if kind != tokenize.NAME:
        return None
    prev = next((t.string for t in reversed(tokens[:i]) if t.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.INDENT)), "")
    nxt = next((t.string for t in tokens[i + 1 :] if t.type not in (tokenize.NL, tokenize.NEWLINE)), "")
    if keyword.iskeyword(text):
        return "ctl" if text in CONTROL else "kw"
    if prev == "def":
        return "fn"
    if prev == "class" or text in BUILTIN_TYPES:
        return "cls"
    if nxt == "(":
        return "cls" if text[:1].isupper() and not text.isupper() else "fn"
    if nxt == "=" and depth > 0:
        return "var"
    if text.isupper() and len(text) > 1:
        return "const"
    if text[:1].isupper():
        return "cls"
    return "var"


def highlight_python(code: str) -> str:
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(code).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return f'<span class="tk-str">{html.escape(code)}</span>'
    if any(t.type == tokenize.ERRORTOKEN and t.string.strip() for t in tokens):
        return f'<span class="tk-str">{html.escape(code)}</span>'
    starts = [0]
    for line in code.split("\n"):
        starts.append(starts[-1] + len(line) + 1)
    offset = lambda pos: starts[pos[0] - 1] + pos[1]
    out, last, depth = [], 0, 0
    for i, tok in enumerate(tokens):
        if tok.type in (tokenize.ENDMARKER, tokenize.DEDENT, tokenize.INDENT, tokenize.NEWLINE, tokenize.NL):
            continue
        a, b = offset(tok.start), offset(tok.end)
        out.append(html.escape(code[last:a]))
        cls = _token_class(tokens, i, depth)
        piece = html.escape(code[a:b])
        out.append(f'<span class="tk-{cls}">{piece}</span>' if cls else piece)
        if tok.string in "([{":
            depth += 1
        elif tok.string in ")]}":
            depth = max(0, depth - 1)
        last = b
    out.append(html.escape(code[last:]))
    return "".join(out)


def code_block(lang: str, body: str, source: tuple[str, str | None] | None) -> str:
    label = ""
    if source:
        path, _ = source
        label = f'<span class="src"><a href="{REPO}/blob/main/{path}">{html.escape(path)}</a></span>\n        '
    if lang == "python":
        name = Path(source[0]).name if source else "notebook_cell.py"
        folder = str(Path(source[0]).parent) + "/" if source and "/" in source[0] else ""
        gutter = "\n".join(str(n) for n in range(1, body.count("\n") + 2))
        return (
            f'{label}<div class="code vsc" data-lang="python"><div class="vsc-bar"><span class="vsc-tab">'
            f'<span class="vsc-icon" aria-hidden="true"></span>{html.escape(name)}'
            f'<span class="vsc-dir">{html.escape(folder)}</span></span></div>'
            f'<pre><span class="gutter" aria-hidden="true">{gutter}</span><code>{highlight_python(body)}</code></pre></div>'
        )
    return f'{label}<div class="code" data-lang="{lang or "text"}"><pre><code>{html.escape(body)}</code></pre></div>'


def list_html(lines: list[str]) -> str:
    ordered = bool(re.match(r"\d+\. ", lines[0].lstrip()))
    tag = "ol" if ordered else "ul"
    items: list[list] = []
    for line in lines:
        text = re.sub(r"^\s*(?:[-*]|\d+\.) ", "", line)
        if line.startswith("  ") and items:
            items[-1][1].append(text)
        elif re.match(r"^\s*(?:[-*]|\d+\.) ", line):
            items.append([text, []])
        elif items:
            items[-1][0] += " " + line.strip()
    out = []
    for text, children in items:
        sub = "".join(f"<li>{inline(c)}</li>" for c in children)
        out.append(f"<li>{inline(text)}" + (f"<ul>{sub}</ul>" if sub else "") + "</li>")
    return f'<{tag} class="plain">' + "".join(out) + f"</{tag}>"


def table_html(lines: list[str]) -> str:
    rows = [[c.strip() for c in line.strip().strip("|").split("|")] for line in lines]
    head, body = rows[0], rows[2:]
    th = "".join(f"<th>{inline(c)}</th>" for c in head)
    tb = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body)
    return f'<div class="table-wrap"><table><thead><tr>{th}</tr></thead><tbody>{tb}</tbody></table></div>'


def blocks(md: str, images: Path) -> list[str]:
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
            m = re.match(r"<!-- source: (\S+)(?: blank: (\w+))? -->", line)
            if m:
                source = (m.group(1), m.group(2))
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
            i += 1
        else:
            para = []
            while i < len(lines) and lines[i].strip() and not re.match(r"^(?:```|<!--|\[!\[|\||>|#|(?:[-*]|\d+\.) )", lines[i]):
                para.append(lines[i].strip())
                i += 1
            text = " ".join(para)
            cls = ' class="goal"' if text.startswith("**Hedef:**") else ""
            out.append(f"<p{cls}>{inline(text)}</p>")
    return out


def reading_time(md: str) -> float:
    code = " ".join(re.findall(r"```.*?```", md, re.S))
    prose = re.sub(r"```.*?```|<!--.*?-->", "", md, flags=re.S)
    prose = re.sub(r"^\[!\[.*$", "", prose, flags=re.M)
    prose = re.sub(r"\]\([^)]*\)", "]", prose)
    words = [w for w in re.sub(r"[*_>#|`\[\]]", " ", prose).split() if re.search(r"\w", w)]
    code_words = [w for w in code.split() if re.search(r"[A-Za-z]", w)]
    return len(words) / 238 + len(code_words) / 476 + md.count("[![") / 5


def minutes(md: str) -> int:
    return max(1, round(reading_time(md)))


def frontmatter(md: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n", md, re.S)
    meta = {}
    for line in m.group(1).split("\n"):
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip().strip('"')
    return meta, md[m.end() :]


def grid_label(slug: str) -> str:
    if slug.startswith("step-"):
        return "BÖLÜM " + slug.removeprefix("step-")
    return {"reading": "KAYNAKLAR"}[slug]


def url(slug: str) -> str:
    return BASE + (slug + "/" if slug else "")


def toc(current: str, times: dict[str, int]) -> str:
    lines = []
    for slug, short, _headings, _desc in PAGES:
        if slug in GROUPS:
            lines.append(f'        <li class="group">{GROUPS[slug]}</li>')
        cls = ' class="here" aria-current="page"' if slug == current else ""
        t = f'<span class="t">{times[slug]} dk</span>' if slug else ""
        lines.append(f'        <li><a{cls} href="{url(slug)}"><span class="n">{html.escape(short)}</span>{t}</a></li>')
    return "\n".join(lines)


def pager(index: int) -> str:
    prev_link = next_link = ""
    if index > 0:
        slug, short = PAGES[index - 1][0], PAGES[index - 1][1]
        prev_link = f'<a class="prev" href="{url(slug)}">← {html.escape(short)}</a>'
    if index < len(PAGES) - 1:
        slug, short = PAGES[index + 1][0], PAGES[index + 1][1]
        next_link = f'<a class="next" href="{url(slug)}">{html.escape(short)} →</a>'
    return f'      <nav class="pager" aria-label="Önceki ve sonraki sayfa">{prev_link}{next_link}</nav>'


def build(source_repo: Path) -> None:
    guide = source_repo / "guide" / "pytorch-finance-workshop.md"
    images = source_repo / "guide" / "images"
    meta, body = frontmatter(guide.read_text(encoding="utf-8"))
    body = re.sub(r"^# .*\n", "", body, count=1, flags=re.M)
    parts = re.split(r"^## (.+)$", body, flags=re.M)
    intro, sections = parts[0], {t.strip(): text for t, text in zip(parts[1::2], parts[2::2])}
    placed = [h for _, _, headings, _ in PAGES for h in headings]
    missing = set(sections) - set(placed)
    if missing:
        sys.exit(f"guide sections with no page: {sorted(missing)} (add them to PAGES)")

    times = {slug: minutes("\n".join(sections[h] for h in headings)) for slug, _, headings, _ in PAGES if slug}
    title, desc = meta["title"], meta["description"]
    total = minutes(body)

    for index, (slug, short, headings, page_desc) in enumerate(PAGES):
        if not slug:
            grid = "\n".join(
                f'          <li><a href="{url(s)}"><span class="num">{grid_label(s)} · {times[s]} DK</span>'
                f'<b>{html.escape(h[0].split(" · ", 1)[-1])}</b><span class="d">{html.escape(d)}</span></a></li>'
                for s, n, h, d in PAGES[1:]
            )
            content = OVERVIEW.format(
                title=html.escape(title),
                desc=html.escape(desc),
                total=total,
                repo=REPO,
                colab_starter=COLAB_STARTER,
                colab_solution=COLAB_SOLUTION,
                first=url("step-1"),
                intro="\n        ".join(blocks(intro, images)),
                grid=grid,
            )
        else:
            chunks = []
            for k, heading in enumerate(headings):
                inner = "\n        ".join(blocks(sections[heading], images))
                tag = f'<h1 class="page-h1">{html.escape(heading)}</h1>' if k == 0 else f"<h2>{html.escape(heading)}</h2>"
                chunks.append(f"        {tag}\n        {inner}")
            content = f'      <section id="{slug}">\n' + "\n\n".join(chunks) + "\n      </section>\n"
        page_title = title if not slug else f"{headings[0]} · {GUIDE_SHORT}"
        crumb = f'<span class="cur"> / <span class="here">{html.escape(short)}</span></span>' if slug else ""
        page = (
            HEAD.format(
                title=html.escape(page_title),
                desc=html.escape(page_desc or desc),
                url=url(slug),
                base=BASE,
                repo=REPO,
                crumb=crumb,
                toc=toc(slug, times),
            )
            + content
            + FOOT.format(pager=pager(index), base=BASE, repo=REPO)
        )
        target = OUT / slug / "index.html" if slug else OUT / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page, encoding="utf-8")

    css = CSS_FROM.read_text(encoding="utf-8").split("\n")
    css[0:2] = [
        "/* Shared styles for the pytorch-finance-workshop guide pages. Generated by scripts/build_pytorch_finance_guide.py:",
        "   workshops/cloud-agents-workshop/guide.css plus the extras at the end. */",
    ]
    (OUT / "guide.css").write_text("\n".join(css).rstrip() + "\n" + EXTRA_CSS, encoding="utf-8")
    (OUT / "guide.js").write_text(SCRIPT.lstrip(), encoding="utf-8")
    (OUT / "diagrams").mkdir(exist_ok=True)
    for svg in sorted(images.glob("*.svg")):
        shutil.copyfile(svg, OUT / "diagrams" / svg.name)
    print(
        f"wrote {len(PAGES)} pages, guide.css, guide.js and {len(list(images.glob('*.svg')))} diagrams "
        f"in {OUT.relative_to(ROOT)}/ ({total} min to read)"
    )


HEAD = """<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} · Omar Elcircevi</title>
  <meta name="description" content="{desc}">
  <link rel="canonical" href="https://omarcevi.dev{url}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="https://omarcevi.dev{url}">
  <meta property="og:image" content="https://omarcevi.dev/og-image.png">
  <meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#111318" media="(prefers-color-scheme: dark)">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
  <noscript><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet"></noscript>
  <script>
  (d => {{
    d.classList.add('js');
    window.applyTheme = t => {{
      d.setAttribute('data-theme', t);
      document.querySelectorAll('meta[name="theme-color"]').forEach(m => {{ m.content = t === 'dark' ? '#111318' : '#f7f7f5'; }});
    }};
    try {{ const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') applyTheme(t); }} catch (e) {{}}
  }})(document.documentElement);
  </script>
  <!-- Generated by scripts/build_pytorch_finance_guide.py from guide/pytorch-finance-workshop.md in {repo}: edit the guide there, then rebuild. -->
  <link rel="stylesheet" href="{base}guide.css">
</head>
<body>
<div class="page">
  <div class="topbar">
    <span class="crumbs"><a href="/">omarcevi.dev</a><span class="ws"> / <a href="/#talks">workshops</a></span> / <a class="here" href="{base}">pytorch-finance-workshop</a>{crumb}</span>
    <nav aria-label="Rehber bölümleri">
      <a href="{base}">Genel Bakış</a>
      <a href="{base}step-1/">Bölümler</a>
      <a href="{base}reading/">İleri Okuma</a>
      <a href="{repo}">GitHub</a>
    </nav>
    <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Koyu temayı değiştir">
      <svg class="i-moon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z"/></svg>
      <svg class="i-sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/></svg>
    </button>
  </div>

  <div class="layout">
    <aside class="toc" aria-label="Rehber sayfaları">
      <p class="label">Rehber</p>
      <ol>
{toc}
      </ol>
    </aside>

    <main>
"""

OVERVIEW = """      <header class="hero" id="overview">
        <p class="kicker"><span class="ts-chips" aria-hidden="true"><i></i><i></i><i></i></span>Işık IEEE Computer Society · Atölye Rehberi · yaklaşık {total} dk okuma</p>
        <h1>{title}</h1>
        <p class="part-of">2 saat 15 dakikalık uygulamalı PyTorch atölyesinin adım adım yazılı rehberi · <em>Omar Elcircevi</em></p>
        <p class="tagline">{desc}</p>
        <div class="actions">
          <a class="btn primary" href="{first}">1. Bölümden Başla</a>
          <a class="btn" href="{colab_starter}">Başlangıç Defteri (Colab)</a>
          <a class="btn" href="{colab_solution}">Çözüm Defteri (Colab)</a>
          <a class="btn" href="{repo}">GitHub Deposu</a>
        </div>
      </header>

      <div class="intro">
        {intro}
      </div>

      <section id="pages">
        <h2>Atölye Bölümleri</h2>
        <ul class="steps-grid">
{grid}
        </ul>
      </section>
"""

FOOT = """
{pager}
      <footer>
        <p><a href="/">omarcevi.dev</a> · <a href="{repo}">kaynak kod</a></p>
        <p>Işık Üniversitesi Şile Kampüsü (DMF-214) · 18 Kasım 2026 · Yatırım tavsiyesi değildir.</p>
      </footer>
    </main>
  </div>
</div>
<script src="{base}guide.js"></script>
</body>
</html>
"""

SCRIPT = """
// Shared behaviour for the pytorch-finance-workshop guide pages (copy buttons, diagram lightbox, theme toggle).
(() => {
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
    b.setAttribute('aria-label', 'Kodu kopyala');
    b.addEventListener('click', () => {
      const clone = pre.cloneNode(true);
      clone.querySelectorAll('.c, .gutter').forEach(c => c.remove());
      let lines = clone.textContent.split('\\n').map(l => l.replace(/\\s+$/, ''));
      if (block.dataset.lang === 'bash') lines = lines.filter(l => l);
      copy(b, lines.join('\\n').replace(/^\\n+|\\n+$/g, ''));
    });
    block.appendChild(b);
  });

  const box = document.createElement('dialog');
  if (box.showModal) {
    box.className = 'lightbox'; box.setAttribute('aria-label', 'Diyagram');
    box.innerHTML = '<button type="button" class="lightbox-close" aria-label="Kapat"><svg viewBox="0 0 16 16" aria-hidden="true">'
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
    build(Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else ROOT.parent / "pytorch-finance-workshop")
