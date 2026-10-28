import re
import unittest

from pagecheck import ROOT, find_all, parse
from render import dump_dom

TITLE = "Deploying your agents on Google Cloud Agent Platform"


def one(doc, **attrs):
    found = find_all(doc, **attrs)
    assert len(found) == 1, attrs
    return found[0]


def squash(s):
    return " ".join(s.split())


def given(today):
    """The strip's count, straight from events.md: everything except full dates still to come."""
    text = (ROOT / "events.md").read_text(encoding="utf-8")
    n = {"talk": 0, "workshop": 0}
    for block in text.split("\n## ")[1:]:
        kind = re.search(r"^- type: (\w+)", block, re.M).group(1)
        date = re.search(r"^- date: (\S+)", block, re.M).group(1)
        if not (len(date) == 10 and date >= today):
            n[kind] += 1
    return f"{n['talk']} talks · {n['workshop']} workshops"


class SpeakingRender(unittest.TestCase):
    def render(self, today):
        return parse(dump_dom(f"?today={today}"))

    def test_before_devfest_samsun(self):
        doc = self.render("2026-10-23")
        card = one(doc, id="up-card")
        self.assertNotIn("hidden", card.attrs)
        text = squash(card.text())
        for piece in ("Deploy your first AI agent to Google Cloud", "OCT", "24",
                      "DevFest Samsun 2026 · Samsun, Colombia Coffee Ömürevleri · in person · EN"):
            self.assertIn(piece, text)
        hrefs = [a.attrs.get("href") for a in find_all(card, "a")]
        self.assertIn("https://kommunity.com/gdg-samsun/events/devfest-samsun-2026-1057d7ef", hrefs)
        self.assertIn("/workshops/devfest-samsun-agent/", hrefs)
        self.assertIn("https://github.com/omarcevi/devfest-samsun-assistant", hrefs)
        self.assertEqual(squash(one(doc, id="strip-next").text()), "next talk · DevFest Samsun 2026 · 24 Oct 2026 · tomorrow")
        self.assertEqual(squash(one(doc, id="strip-count").text()), given("2026-10-23"))
        first = [c for c in one(doc, id="workshop-list").elements() if c.tag == "li"][0]
        self.assertIn(TITLE, first.text())   # the 27 Oct workshop waits in the list, marked upcoming
        self.assertIn("upcoming", first.text())

    def test_before_workshop(self):
        doc = self.render("2026-10-25")
        card = one(doc, id="up-card")
        self.assertNotIn("hidden", card.attrs)
        text = squash(card.text())
        for piece in (TITLE, "OCT", "27", "Istanbul, Wyndham Grand Levent · in person · EN"):
            self.assertIn(piece, text)
        hrefs = [a.attrs.get("href") for a in find_all(card, "a")]
        self.assertIn("https://cloudonair.withgoogle.com/events/cloud-day-tr", hrefs)
        self.assertIn("/workshops/cloud-agents-workshop/", hrefs)
        self.assertIn("https://github.com/omarcevi/cloud-agents-workshop", hrefs)
        self.assertNotIn(TITLE, one(doc, id="workshop-list").text())
        self.assertEqual(squash(one(doc, id="strip-next").text()),
                         "next talk · Google Cloud Day Türkiye – Builder Connect · 27 Oct 2026 · in 2 days")
        self.assertEqual(squash(one(doc, id="strip-count").text()), given("2026-10-25"))

    def test_on_the_day(self):
        doc = self.render("2026-10-27")
        self.assertTrue(squash(one(doc, id="strip-next").text()).endswith("· today"))

    def test_after_workshop(self):
        doc = self.render("2026-10-28")
        self.assertIn("hidden", one(doc, id="up-card").attrs)
        nxt = one(doc, id="strip-next")
        self.assertIn("no talks scheduled", nxt.text())
        self.assertNotIn("NaN", nxt.text())
        self.assertIn("#contact", [a.attrs.get("href") for a in find_all(nxt, "a")])
        self.assertEqual(squash(one(doc, id="strip-count").text()), given("2026-10-28"))
        first = [c for c in one(doc, id="workshop-list").elements() if c.tag == "li"][0]
        self.assertIn(TITLE, first.text())

    def test_booking_rendered(self):
        html = dump_dom("?today=2026-10-23")
        src = "calendar.google.com/calendar/appointments/schedules/AcZssZ0eb5WUAIpBMx4QPBcHLYvEkpsTizdL89jBUa6UXEfyqFAB_blGgZgBPyEFoXzoag5z6xWIRzHT"
        self.assertTrue(src in html, "booking iframe src missing from the rendered page")


class SimRender(unittest.TestCase):
    def test_metrics_filled_after_warmup(self):
        doc = parse(dump_dom("?today=2026-10-23"))
        self.assertRegex(one(doc, id="m-ttft99").text(), r"\d")
        self.assertRegex(one(doc, id="m-thr").text(), r"tok/s")
        self.assertEqual(one(doc, id="sim-play").text().strip(), "❚❚")


if __name__ == "__main__":
    unittest.main()
