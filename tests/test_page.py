import re
import unittest
from urllib.parse import urlsplit

from pagecheck import ROOT, find_all, ml_digest, parse

SKIP_SCHEMES = ("#", "mailto:", "data:", "tel:", "javascript:", "http:", "https:", "//")


class GuardRails(unittest.TestCase):
    """Must hold before and after the revamp."""

    @classmethod
    def setUpClass(cls):
        cls.doc = parse()

    def test_ml_source_text_unchanged(self):
        self.assertEqual(ml_digest(), (ROOT / "assets/ml/source.sha").read_text().strip())

    def test_medium_markers_inside_list(self):
        comments = [n for n in self.doc.iter() if n.tag == "#comment"]
        start = [c for c in comments if c.data.strip() == "MEDIUM:START"]
        end = [c for c in comments if c.data.strip() == "MEDIUM:END"]
        self.assertEqual((len(start), len(end)), (1, 1))
        parent = start[0].parent
        self.assertIs(parent, end[0].parent)
        self.assertEqual(parent.tag, "ul")
        self.assertIn("list", parent.classes)
        between = parent.children[parent.children.index(start[0]) + 1:parent.children.index(end[0])]
        items = [n for n in between if n.tag != "#text"]
        self.assertTrue(items)
        self.assertTrue(all(n.tag == "li" for n in items))

    def test_one_span_per_section(self):
        sections = find_all(self.doc, "section")
        self.assertTrue(sections)
        for s in sections:
            spans = [c for c in s.elements() if "span" in c.classes]
            self.assertEqual(len(spans), 1, s.attrs.get("id"))
        in_sections = {id(c) for s in sections for c in s.elements() if "span" in c.classes}
        self.assertEqual({id(n) for n in find_all(self.doc, cls="span")}, in_sections)

    def test_images_have_dimensions_and_alt(self):
        for img in find_all(self.doc, "img"):
            self.assertTrue(img.attrs.get("width"), img)
            self.assertTrue(img.attrs.get("height"), img)
            self.assertIn("alt", img.attrs, img)

    def test_local_links_resolve(self):
        for n in self.doc.iter():
            for key in ("href", "src"):
                url = n.attrs.get(key)
                if not url or url.startswith(SKIP_SCHEMES):
                    continue
                path = urlsplit(url).path
                target = ROOT / path.lstrip("/")
                if path.endswith("/") or path == "":
                    target = target / "index.html"
                self.assertTrue(target.exists(), f"{key}={url} on {n.tag}")

    def test_talks_anchor_exists(self):
        self.assertTrue(find_all(self.doc, id="talks"))


class Hero(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.doc = parse(cls.html)

    def test_page_width_1120(self):
        self.assertIn(".page { max-width: 1120px;", self.html)

    def test_hero_photo(self):
        imgs = find_all(self.doc, "img", src="assets/photos/omar-gdd-istanbul.jpg")
        self.assertEqual(len(imgs), 1)
        img = imgs[0]
        self.assertEqual((img.attrs.get("width"), img.attrs.get("height")), ("720", "900"))
        self.assertEqual(img.attrs.get("alt"), "Omar Elcircevi speaking at Google for Developers Day Istanbul")
        self.assertNotEqual(img.attrs.get("loading"), "lazy")

    def test_sprite_symbols(self):
        ids = {n.attrs.get("id") for n in find_all(self.doc, "symbol")}
        self.assertLessEqual({"i-gh", "i-li", "i-md", "i-mail", "i-cal"}, ids)

    def test_nav(self):
        topbar = find_all(self.doc, cls="topbar")[0]
        links = find_all(topbar, "a")
        nav = [a.attrs.get("href") for a in links if "domain" not in a.classes]
        self.assertEqual(nav, ["#about", "#experience", "#speaking", "#projects", "#writing", "#contact"])
        cta = links[-1]
        self.assertIn("cta", cta.classes)
        self.assertEqual(cta.text().strip(), "Book a call")

    def test_hero_links_have_icons(self):
        header = find_all(self.doc, "header")[0]
        row = find_all(header, cls="links")[0]
        links = find_all(row, "a")
        self.assertEqual([a.attrs.get("href") for a in links], [
            "#contact", "mailto:hi@omarcevi.dev", "https://www.linkedin.com/in/omarcevi/",
            "https://github.com/omarcevi", "https://omarcevi.medium.com"])
        for a in links:
            self.assertTrue(find_all(a, "svg", cls="ic"), a.attrs.get("href"))


DATE_RE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")
FULL_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Speaking(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = parse()
        found = find_all(cls.doc, "section", id="speaking")
        cls.sec = found[0] if found else None

    def items(self, list_id):
        lists = find_all(self.doc, "ul", id=list_id)
        self.assertEqual(len(lists), 1, list_id)
        return [c for c in lists[0].elements() if c.tag == "li"]

    def test_speaking_section(self):
        self.assertIsNotNone(self.sec)
        span = [c for c in self.sec.elements() if "span" in c.classes][0]
        self.assertEqual(find_all(span, cls="sp-name")[0].text().strip(), "speaking.md")
        self.assertTrue(find_all(self.sec, id="talks"))
        self.assertFalse(find_all(self.doc, "section", id="talks"))

    def test_item_dates(self):
        talks, shops = self.items("talk-list"), self.items("workshop-list")
        self.assertEqual((len(talks), len(shops)), (6, 4))
        for li in talks + shops:
            self.assertRegex(li.attrs.get("data-date", ""), DATE_RE)

    def test_upcoming_needs_full_date(self):
        for li in self.items("talk-list") + self.items("workshop-list"):
            d = li.attrs.get("data-date", "")
            if FULL_DATE_RE.match(d) and d >= "2026-10-23":
                for key in ("data-event", "data-place", "data-format", "data-lang", "data-url"):
                    self.assertTrue(li.attrs.get(key), f"{d} missing {key}")

    def test_no_js_fallback(self):
        card = find_all(self.doc, id="up-card")
        self.assertEqual(len(card), 1)
        self.assertIn("hidden", card[0].attrs)
        self.assertFalse(card[0].elements())
        self.assertIn("hidden", find_all(self.doc, id="strip-next")[0].attrs)
        dated = [li.attrs.get("data-date") for li in self.items("workshop-list")]
        self.assertIn("2026-10-27", dated)

    def test_tags_are_links(self):
        self.assertIsNotNone(self.sec)
        tags = find_all(self.sec, cls="tag")
        self.assertTrue(tags)
        for t in tags:
            self.assertEqual(t.tag, "a")
            self.assertTrue(t.attrs.get("href"))


if __name__ == "__main__":
    unittest.main()
