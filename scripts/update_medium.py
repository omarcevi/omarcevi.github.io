"""Pull the latest Medium posts into the Writing section of index.html.

Rewrites only the lines between <!-- MEDIUM:START --> and <!-- MEDIUM:END -->.
Run by .github/workflows/medium.yml; safe to run locally too.
"""
import email.utils
import html
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

FEED_URL = "https://medium.com/feed/@omarcevi"
MAX_POSTS = 4
INDEX = Path(__file__).resolve().parent.parent / "index.html"
START, END = "<!-- MEDIUM:START -->", "<!-- MEDIUM:END -->"


def fetch_posts():
    req = urllib.request.Request(FEED_URL, headers={"User-Agent": "Mozilla/5.0 (omarcevi.dev feed sync)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        root = ET.fromstring(resp.read())
    posts = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").split("?")[0].strip()
        date = email.utils.parsedate_to_datetime(item.findtext("pubDate"))
        if title and link:
            posts.append((date, title, link))
    posts.sort(reverse=True)
    return posts[:MAX_POSTS]


def render(posts):
    out = []
    for date, title, link in posts:
        out.append(
            "      <li>\n"
            f'        <div class="item-title"><a href="{html.escape(link)}">{html.escape(title)}</a></div>\n'
            f'        <div class="item-meta">Medium · {date.strftime("%B %Y")}</div>\n'
            "      </li>"
        )
    return "\n".join(out)


def main():
    posts = fetch_posts()
    if not posts:
        sys.exit("Feed returned no posts; leaving index.html unchanged.")
    page = INDEX.read_text(encoding="utf-8")
    pattern = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
    if not pattern.search(page):
        sys.exit("Markers not found in index.html.")
    new_page = pattern.sub(lambda _: f"{START}\n{render(posts)}\n{END}", page, count=1)
    if new_page != page:
        INDEX.write_text(new_page, encoding="utf-8")
        print(f"Updated Writing section with {len(posts)} posts.")
    else:
        print("No new posts.")


if __name__ == "__main__":
    main()
