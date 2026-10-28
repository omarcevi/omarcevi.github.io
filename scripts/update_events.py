"""Write the talks and workshops in events.md into index.html and llms.txt.

Rewrites the lines between <!-- TALKS:START --> / <!-- TALKS:END --> and
<!-- WORKSHOPS:START --> / <!-- WORKSHOPS:END --> in index.html, and the
"Talks and workshops" section of llms.txt. Run by .github/workflows/events.yml
when events.md changes; safe to run locally too. A bad entry stops it before
anything is written.
"""
import calendar
import datetime
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://omarcevi.dev"
KEYS = ("type", "event", "date", "place", "link", "tickets", "guide", "repo", "video", "slides", "photos", "lang", "format", "about")
TYPES = ("talk", "workshop")
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
DATE_RE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$")
ITEM_RE = re.compile(r"^- ([A-Za-z]+):(.*)$")
# the tags under an item, in order; the title links to the first of guide, video, slides, photos, else the event page
TAGS = {
    "tickets": ("tickets", "Get tickets"),
    "guide": ("guide", "Open the {type} guide"),
    "repo": ("repo", "{Type} repository"),
    "video": ("▶ video", "Watch the recording"),
    "slides": ("slides", "Slides from the {type}"),
    "photos": ("photos", "Photos from the {type}"),
}
TITLE_LINK = ("guide", "video", "slides", "photos", "link")
INDENT = " " * 12  # rows sit inside <ul class="rows"> at this depth


class EventsError(Exception):
    pass


# ----------------------------------------------------------------- parse ----
def valid_date(date):
    m = DATE_RE.match(date)
    if not m:
        return False
    y, mo, d = m.groups()
    try:
        datetime.date(int(y), int(mo or 1), int(d or 1))
    except ValueError:
        return False
    return True


def blocks(text):
    """Each '## title' and the non-blank lines under it; anything before the first one is notes."""
    out = []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if line == "##" or line.startswith("## "):
            out.append((line[2:].strip(), n, []))
        elif out and line:
            out[-1][2].append((n, line))
    return out


def entry(title, lines):
    e, problems = {"title": title}, []
    if not title:
        problems.append("no title after ##")
    for n, line in lines:
        m = ITEM_RE.match(line)
        if not m:
            problems.append(f"line {n} should look like '- key: value'")
            continue
        key, value = m.group(1).lower(), m.group(2).strip()
        if key not in KEYS:
            problems.append(f"line {n}: unknown key '{key}' (known: {', '.join(KEYS)})")
        elif key in e:
            problems.append(f"line {n}: '{key}' is given twice")
        elif value:
            e[key] = value
    e["type"] = e.get("type", "").lower()
    if e["type"] not in TYPES:
        problems.append("type must be talk or workshop")
    if "date" not in e:
        problems.append("no date")
    elif not valid_date(e["date"]):
        problems.append(f"date '{e['date']}' should be YYYY-MM-DD, YYYY-MM or YYYY")
    elif len(e["date"]) == 10 and "event" not in e:
        problems.append("an event with a full date needs 'event' (the next-up card shows it)")
    return e, problems


def parse(text):
    events, report = [], []
    for title, start, lines in blocks(text):
        e, problems = entry(title, lines)
        if problems:
            name = f'"{title}" (line {start})' if title else f"the entry on line {start}"
            report.append(f"{name}: " + "; ".join(problems))
        events.append(e)
    if report:
        raise EventsError("events.md has problems:\n  " + "\n  ".join(report))
    return events


# ---------------------------------------------------------------- render ----
def esc(s):
    return html.escape(s, quote=False)


def attr(s):
    return esc(s).replace('"', "&quot;")


def parts(date):
    return [int(p) for p in date.split("-")]


def period_end(date):
    """'2026-10' -> (2026, 10, 31), '2023' -> (2023, 12, 31): the same order speaking.js uses."""
    p = parts(date)
    y, m = p[0], (p[1] if len(p) > 1 else 12)
    return (y, m, p[2] if len(p) > 2 else calendar.monthrange(y, m)[1])


def newest_first(events):
    return sorted(events, key=lambda e: period_end(e["date"]), reverse=True)  # stable: ties keep file order


def short_date(date):
    p = parts(date)
    return f"{MONTHS[p[1] - 1][:3]} {p[0]}" if len(p) > 1 else str(p[0])


def long_date(date):
    p = parts(date)
    return " ".join(([str(p[2])] if len(p) > 2 else []) + ([MONTHS[p[1] - 1]] if len(p) > 1 else []) + [str(p[0])])


def tag(e, key):
    text, label = TAGS[key]
    label = label.format(type=e["type"], Type=e["type"].capitalize())
    if key == "repo" and "github.com" in e["repo"]:
        label += " on GitHub"
    return f'<a class="tag" href="{attr(e[key])}" aria-label="{label}">{text}</a>'


def row(e):
    data = [("date", "date"), ("event", "event"), ("place", "place"), ("format", "format"), ("lang", "lang"), ("url", "link")]
    attrs = "".join(f' data-{name}="{attr(e[key])}"' for name, key in data if key in e)
    href = next((e[k] for k in TITLE_LINK if k in e), None)
    title = f'<a href="{attr(href)}">{esc(e["title"])}</a>' if href else esc(e["title"])
    lines = [f"<li{attrs}>", f'  <span class="date">{short_date(e["date"])}</span>', "  <div>",
             f'    <div class="item-title">{title}</div>']
    if "event" in e:
        lines.append(f'    <div class="item-meta">{esc(e["event"])}</div>')
    if "about" in e:
        lines.append(f'    <p class="item-desc">{esc(e["about"])}</p>')
    tags = "".join(tag(e, k) for k in TAGS if k in e)
    if tags:
        lines.append(f'    <div class="mats">{tags}</div>')
    lines += ["  </div>", "</li>"]
    return "\n".join(INDENT + line for line in lines)


def rows(events):
    return "\n".join(row(e) for e in newest_first(events))


def absolute(url):
    return SITE + url if url.startswith("/") else url


def llms_line(e):
    head = e["title"] + (" (workshop)" if e["type"] == "workshop" else "")
    when = long_date(e["date"])
    bits = [f'{e["event"]}, {when}' if "event" in e else when]
    if "place" in e:
        bits.append(e["place"])
    bits += [f"[{k}]({absolute(e[k])})" for k in TAGS if k in e]
    return f"- {head} — " + " · ".join(bits)


# ----------------------------------------------------------------- apply ----
def between(text, name, body):
    start, end = f"<!-- {name}:START -->", f"<!-- {name}:END -->"
    pattern = re.compile(r"([ \t]*" + re.escape(start) + r"\n).*?([ \t]*" + re.escape(end) + ")", re.S)
    if not pattern.search(text):
        raise EventsError(f"{start} ... {end} not found in index.html")
    return pattern.sub(lambda m: m.group(1) + (body + "\n" if body else "") + m.group(2), text, count=1)


def apply_page(page, events):
    for name, kind in (("TALKS", "talk"), ("WORKSHOPS", "workshop")):
        page = between(page, name, rows([e for e in events if e["type"] == kind]))
    return page


def apply_llms(llms, events):
    pattern = re.compile(r"(^## Talks and workshops\n\n).*?(?=\n\n## |\n*\Z)", re.S | re.M)
    if not pattern.search(llms):
        raise EventsError("'## Talks and workshops' not found in llms.txt")
    lines = "\n".join(llms_line(e) for e in newest_first(events))
    return pattern.sub(lambda m: m.group(1) + lines, llms, count=1)


def main(root=ROOT):
    root = Path(root)
    try:
        events = parse((root / "events.md").read_text(encoding="utf-8"))
        if not events:
            raise EventsError("events.md has no entries")
        updates = []
        for name, apply in (("index.html", apply_page), ("llms.txt", apply_llms)):
            path = root / name
            old = path.read_text(encoding="utf-8")
            updates.append((path, old, apply(old, events)))
    except EventsError as err:
        sys.exit(f"{err}\nNothing was changed.")
    for path, old, new in updates:
        if new != old:
            path.write_text(new, encoding="utf-8")
            print(f"Updated {path.name}.")
    print(f"{len(events)} events.")


if __name__ == "__main__":
    main()
