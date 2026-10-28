"""events.md -> the Speaking lists in index.html and the talks in llms.txt (scripts/update_events.py)."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from pagecheck import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import update_events as ev  # noqa: E402

WORKSHOP = """\
## Deploying your agents on Google Cloud Agent Platform
- type: workshop
- event: Google Cloud Day Türkiye – Builder Connect
- date: 2026-10-27
- place: Istanbul, Wyndham Grand Levent
- link: https://cloudonair.withgoogle.com/events/cloud-day-tr
- guide: /workshops/cloud-agents-workshop/
- repo: https://github.com/omarcevi/cloud-agents-workshop
- lang: EN
- format: in person
"""

# the row index.html held for this workshop before events.md existed
WORKSHOP_ROW = """\
            <li data-date="2026-10-27" data-event="Google Cloud Day Türkiye – Builder Connect" data-place="Istanbul, Wyndham Grand Levent" data-format="in person" data-lang="EN" data-url="https://cloudonair.withgoogle.com/events/cloud-day-tr">
              <span class="date">Oct 2026</span>
              <div>
                <div class="item-title"><a href="/workshops/cloud-agents-workshop/">Deploying your agents on Google Cloud Agent Platform</a></div>
                <div class="item-meta">Google Cloud Day Türkiye – Builder Connect</div>
                <div class="mats"><a class="tag" href="/workshops/cloud-agents-workshop/" aria-label="Open the workshop guide">guide</a><a class="tag" href="https://github.com/omarcevi/cloud-agents-workshop" aria-label="Workshop repository on GitHub">repo</a></div>
              </div>
            </li>"""

VIDEO_TALK = """\
## MLOps in the Age of GenAI
- type: talk
- event: DevFest Istanbul
- date: 2023
- video: https://www.youtube.com/watch?v=PKqyohMo4I8
"""

PLAIN_TALK = """\
## Build with AI: Gemini SDK & Cloud Run
- type: talk
- event: 42 Türkiye
- date: 2026-04
"""

NO_EVENT = """\
## Agentverse: Multi-Agent Systems with ADK, MCP and A2A
- type: workshop
- date: 2026-05
- about: A team of research, judge and builder agents talking over A2A, with a self-hosted Gemma model on Cloud Run GPUs.
"""

BASE = """\
## Talk title
- type: talk
- event: Some Event
- date: 2026-04
"""

PAGE = """\
<ul id="talk-list">
            <!-- TALKS:START -->
            <li>old talk</li>
            <!-- TALKS:END -->
</ul>
<ul id="workshop-list">
            <!-- WORKSHOPS:START -->
            <li>old workshop</li>
            <!-- WORKSHOPS:END -->
</ul>
"""

LLMS = """\
# Omar

## Talks and workshops

- old line

## Writing

- a post
"""


class Parse(unittest.TestCase):
    def test_reads_an_entry(self):
        [e] = ev.parse(WORKSHOP)
        self.assertEqual(e["title"], "Deploying your agents on Google Cloud Agent Platform")
        self.assertEqual(e["type"], "workshop")
        self.assertEqual(e["date"], "2026-10-27")
        self.assertEqual(e["link"], "https://cloudonair.withgoogle.com/events/cloud-day-tr")

    def test_text_before_the_first_entry_is_ignored(self):
        intro = "# Events\n\nOne block per talk or workshop.\n- type: talk or workshop\n\n"
        self.assertEqual([e["title"] for e in ev.parse(intro + VIDEO_TALK)], ["MLOps in the Age of GenAI"])

    def test_a_blank_value_counts_as_missing(self):
        [e] = ev.parse(BASE + "- video:\n")
        self.assertNotIn("video", e)

    def test_rejects_a_bad_entry_and_names_it(self):
        bad = {
            "unknown key": BASE + "- vidoe: https://example.com\n",
            "unknown type": BASE.replace("type: talk", "type: keynote"),
            "month name": BASE.replace("2026-04", "Apr 2026"),
            "month 13": BASE.replace("2026-04", "2026-13"),
            "no such day": BASE.replace("2026-04", "2026-02-30"),
            "no date": BASE.replace("- date: 2026-04\n", ""),
            "no type": BASE.replace("- type: talk\n", ""),
            "full date, no event": BASE.replace("- event: Some Event\n", "").replace("2026-04", "2026-11-02"),
            "same key twice": BASE + "- date: 2026-05\n",
            "stray text": BASE + "slides are coming\n",
        }
        for name, text in bad.items():
            with self.subTest(name), self.assertRaises(ev.EventsError) as cm:
                ev.parse(text)
            self.assertIn("Talk title", str(cm.exception))

    def test_an_entry_without_a_title_is_named_by_its_line(self):
        with self.assertRaises(ev.EventsError) as cm:
            ev.parse(BASE + "\n## \n- type: talk\n- date: 2026\n")
        self.assertIn("line 6", str(cm.exception))

    def test_reports_every_bad_entry(self):
        with self.assertRaises(ev.EventsError) as cm:
            ev.parse(BASE.replace("2026-04", "soon") + BASE.replace("Talk title", "Second").replace("talk\n", "panel\n"))
        self.assertIn("Talk title", str(cm.exception))
        self.assertIn("Second", str(cm.exception))


class Rows(unittest.TestCase):
    def test_workshop_row_matches_the_hand_written_markup(self):
        self.assertEqual(ev.rows(ev.parse(WORKSHOP)), WORKSHOP_ROW)

    def test_talk_title_links_to_its_video(self):
        self.assertEqual(ev.rows(ev.parse(VIDEO_TALK)), """\
            <li data-date="2023" data-event="DevFest Istanbul">
              <span class="date">2023</span>
              <div>
                <div class="item-title"><a href="https://www.youtube.com/watch?v=PKqyohMo4I8">MLOps in the Age of GenAI</a></div>
                <div class="item-meta">DevFest Istanbul</div>
                <div class="mats"><a class="tag" href="https://www.youtube.com/watch?v=PKqyohMo4I8" aria-label="Watch the recording">▶ video</a></div>
              </div>
            </li>""")

    def test_title_without_materials_is_plain_and_escaped(self):
        self.assertEqual(ev.rows(ev.parse(PLAIN_TALK)), """\
            <li data-date="2026-04" data-event="42 Türkiye">
              <span class="date">Apr 2026</span>
              <div>
                <div class="item-title">Build with AI: Gemini SDK &amp; Cloud Run</div>
                <div class="item-meta">42 Türkiye</div>
              </div>
            </li>""")

    def test_about_shows_under_the_title(self):
        self.assertEqual(ev.rows(ev.parse(NO_EVENT)), """\
            <li data-date="2026-05">
              <span class="date">May 2026</span>
              <div>
                <div class="item-title">Agentverse: Multi-Agent Systems with ADK, MCP and A2A</div>
                <p class="item-desc">A team of research, judge and builder agents talking over A2A, with a self-hosted Gemma model on Cloud Run GPUs.</p>
              </div>
            </li>""")

    def test_tags_follow_guide_repo_video_slides_photos(self):
        text = BASE + "- photos: https://p\n- slides: https://s\n- video: https://v\n- repo: https://github.com/r\n- guide: /g/\n"
        row = ev.rows(ev.parse(text))
        self.assertIn('<div class="item-title"><a href="/g/">Talk title</a></div>', row)
        self.assertIn(
            '<div class="mats">'
            '<a class="tag" href="/g/" aria-label="Open the talk guide">guide</a>'
            '<a class="tag" href="https://github.com/r" aria-label="Talk repository on GitHub">repo</a>'
            '<a class="tag" href="https://v" aria-label="Watch the recording">▶ video</a>'
            '<a class="tag" href="https://s" aria-label="Slides from the talk">slides</a>'
            '<a class="tag" href="https://p" aria-label="Photos from the talk">photos</a>'
            '</div>', row)

    def test_tickets_come_first_and_leave_the_title_plain(self):
        row = ev.rows(ev.parse(BASE + "- video: https://v\n- tickets: https://t\n"))
        self.assertIn('<a href="https://v">Talk title</a>', row)
        self.assertIn('<div class="mats"><a class="tag" href="https://t" aria-label="Get tickets">tickets</a>'
                      '<a class="tag" href="https://v" aria-label="Watch the recording">▶ video</a></div>', row)
        row = ev.rows(ev.parse(BASE + "- tickets: https://t\n"))
        self.assertIn('<div class="item-title">Talk title</div>', row)

    def test_title_falls_back_to_the_event_page(self):
        row = ev.rows(ev.parse(BASE + "- link: https://e\n"))
        self.assertIn('<a href="https://e">Talk title</a>', row)
        row = ev.rows(ev.parse(BASE + "- link: https://e\n- photos: https://p\n"))
        self.assertIn('<a href="https://p">Talk title</a>', row)  # what happened there beats the event page

    def test_title_falls_back_to_slides_then_photos(self):
        row = ev.rows(ev.parse(BASE + "- photos: https://p\n- slides: https://s\n"))
        self.assertIn('<a href="https://s">Talk title</a>', row)
        row = ev.rows(ev.parse(BASE + "- photos: https://p\n"))
        self.assertIn('<a href="https://p">Talk title</a>', row)

    def test_newest_first_and_ties_keep_file_order(self):
        text = "".join(BASE.replace("Talk title", t).replace("2026-04", d) for t, d in [
            ("A", "2023"), ("B", "2025-11"), ("C", "2026-04"), ("D", "2026-04"), ("E", "2026-10-24"), ("F", "2026-10")])
        row = ev.rows(ev.parse(text))
        self.assertEqual(sorted("ABCDEF", key=lambda t: row.index(f">{t}<")), list("FECDBA"))


class Apply(unittest.TestCase):
    def test_talks_and_workshops_land_between_their_markers(self):
        page = ev.apply_page(PAGE, ev.parse(VIDEO_TALK + WORKSHOP))
        talks = page[page.index("TALKS:START"):page.index("TALKS:END")]
        shops = page[page.index("WORKSHOPS:START"):page.index("WORKSHOPS:END")]
        self.assertIn("MLOps in the Age of GenAI", talks)
        self.assertNotIn("Deploying your agents", talks)
        self.assertIn(WORKSHOP_ROW, shops)
        self.assertNotIn("old", page)
        self.assertTrue(page.startswith('<ul id="talk-list">\n            <!-- TALKS:START -->\n            <li data-date="2023"'))
        self.assertTrue(page.endswith("            </li>\n            <!-- WORKSHOPS:END -->\n</ul>\n"))

    def test_missing_markers_are_an_error(self):
        with self.assertRaises(ev.EventsError):
            ev.apply_page(PAGE.replace("<!-- WORKSHOPS:END -->", ""), ev.parse(WORKSHOP))

    def test_llms_section_is_rewritten_and_the_rest_kept(self):
        out = ev.apply_llms(LLMS, ev.parse(VIDEO_TALK + NO_EVENT + WORKSHOP))
        self.assertEqual(out, """\
# Omar

## Talks and workshops

- Deploying your agents on Google Cloud Agent Platform (workshop) — Google Cloud Day Türkiye – Builder Connect, 27 October 2026 · Istanbul, Wyndham Grand Levent · [guide](https://omarcevi.dev/workshops/cloud-agents-workshop/) · [repo](https://github.com/omarcevi/cloud-agents-workshop)
- Agentverse: Multi-Agent Systems with ADK, MCP and A2A (workshop) — May 2026
- MLOps in the Age of GenAI — DevFest Istanbul, 2023 · [video](https://www.youtube.com/watch?v=PKqyohMo4I8)

## Writing

- a post
""")

    def test_llms_without_the_section_is_an_error(self):
        with self.assertRaises(ev.EventsError):
            ev.apply_llms(LLMS.replace("## Talks and workshops", "## Talks"), ev.parse(WORKSHOP))


class Main(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "index.html").write_text(PAGE, encoding="utf-8")
        (self.root / "llms.txt").write_text(LLMS, encoding="utf-8")

    def test_writes_both_files(self):
        (self.root / "events.md").write_text(VIDEO_TALK + WORKSHOP, encoding="utf-8")
        ev.main(self.root)
        self.assertIn(WORKSHOP_ROW, (self.root / "index.html").read_text(encoding="utf-8"))
        self.assertIn("- MLOps in the Age of GenAI — DevFest Istanbul", (self.root / "llms.txt").read_text(encoding="utf-8"))

    def test_a_bad_entry_fails_and_changes_nothing(self):
        (self.root / "events.md").write_text(VIDEO_TALK + BASE.replace("2026-04", "next week"), encoding="utf-8")
        with self.assertRaises(SystemExit) as cm:
            ev.main(self.root)
        self.assertIn("Talk title", str(cm.exception.code))
        self.assertEqual((self.root / "index.html").read_text(encoding="utf-8"), PAGE)
        self.assertEqual((self.root / "llms.txt").read_text(encoding="utf-8"), LLMS)

    def test_an_empty_file_fails_and_changes_nothing(self):
        (self.root / "events.md").write_text("# Events\n", encoding="utf-8")
        with self.assertRaises(SystemExit):
            ev.main(self.root)
        self.assertEqual((self.root / "index.html").read_text(encoding="utf-8"), PAGE)


class InSync(unittest.TestCase):
    """The committed page and llms.txt are what events.md produces."""

    def test_site_matches_events_md(self):
        events = ev.parse((ROOT / "events.md").read_text(encoding="utf-8"))
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        llms = (ROOT / "llms.txt").read_text(encoding="utf-8")
        self.assertEqual(ev.apply_page(page, events), page, "index.html is out of date: run python scripts/update_events.py")
        self.assertEqual(ev.apply_llms(llms, events), llms, "llms.txt is out of date: run python scripts/update_events.py")


if __name__ == "__main__":
    unittest.main()
