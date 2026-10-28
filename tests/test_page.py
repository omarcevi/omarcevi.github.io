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

    def test_topbar_cta_compact_on_phones(self):
        cta = [a for a in find_all(find_all(self.doc, cls="topbar")[0], "a") if "cta" in a.classes][0]
        self.assertEqual(cta.attrs.get("aria-label"), "Book a call")
        self.assertTrue(find_all(cta, "svg", cls="ic"))
        self.assertEqual(find_all(cta, cls="cta-label")[0].text().strip(), "Book a call")
        phone = re.search(r"@media \(max-width: 640px\) \{(.*?)\n    \}", self.html, re.S)
        self.assertIn(".topbar .cta-label { display: none; }", phone.group(1))

    def test_hero_links_have_icons(self):
        header = find_all(self.doc, "header")[0]
        row = find_all(header, cls="links")[0]
        links = find_all(row, "a")
        self.assertEqual([a.attrs.get("href") for a in links], [
            "#contact", "mailto:hi@omarcevi.dev", "https://www.linkedin.com/in/omarcevi/",
            "https://github.com/omarcevi", "https://omarcevi.medium.com"])
        for a in links:
            self.assertTrue(find_all(a, "svg", cls="ic"), a.attrs.get("href"))


class Simulator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = parse()
        cls.box = find_all(cls.doc, id="simbox")[0]

    def test_scripts_in_order(self):
        srcs = [s.attrs.get("src") for s in find_all(self.doc, "script") if s.attrs.get("src")]
        self.assertLess(srcs.index("assets/sim-engine.js"), srcs.index("assets/sim.js"))
        for s in find_all(self.doc, "script"):
            if s.attrs.get("src", "").startswith("assets/sim"):
                self.assertIn("defer", s.attrs)

    def test_inline_sim_removed(self):
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("function sim()", page)
        self.assertNotIn("sim-batch", page)

    def test_footer_metrics(self):
        for i in ("m-ttft50", "m-ttft99", "m-tpot", "m-thr", "m-kv", "m-gpus", "m-cost", "m-pre", "m-503"):
            self.assertEqual(len(find_all(self.box, id=i)), 1, i)
        # preempted and rejected sit on the counters row on every tab, so the footer never changes shape
        self.assertNotIn("hidden", find_all(self.box, id="m-503-wrap")[0].attrs)
        self.assertNotIn("hidden", find_all(self.box, id="m-pre-wrap")[0].attrs)

    def test_tab_shell(self):
        lists = find_all(self.box, role="tablist")
        self.assertEqual(len(lists), 1)
        self.assertNotIn("hidden", lists[0].attrs)
        tabs = find_all(lists[0], "button", role="tab")
        self.assertEqual([t.attrs.get("data-tab") for t in tabs], ["batching", "kvcache", "mig", "routing", "traffic", "failure", "sandbox"])
        self.assertEqual([" ".join(t.text().split()) for t in tabs],
                         ["01 batching", "02 kv cache", "03 mig layout", "04 routing", "05 real traffic", "06 failure", "sandbox ›"])
        self.assertIn("sb-tab", tabs[-1].classes)   # set apart on the right
        for t in tabs:
            panel = find_all(self.box, id=t.attrs.get("aria-controls"))[0]
            self.assertEqual(panel.attrs.get("role"), "tabpanel")
            self.assertEqual(panel.attrs.get("data-tab"), t.attrs.get("data-tab"))

    def radios(self, panel_id):
        return find_all(find_all(self.box, id=panel_id)[0], "button", role="radio")

    def test_batching_switch(self):
        r = self.radios("sim-tab-batching")
        self.assertEqual([b.attrs.get("data-batching") for b in r], ["request", "continuous"])
        self.assertEqual([b.attrs.get("aria-checked") for b in r], ["false", "true"])

    def test_kvcache_slider(self):
        panel = find_all(self.box, id="sim-tab-kvcache")[0]
        s = find_all(panel, "input", id="sim-kvmem")[0]
        self.assertEqual([s.attrs.get(k) for k in ("type", "min", "max", "step", "value")], ["range", "0.5", "0.95", "0.05", "0.9"])
        self.assertEqual(find_all(panel, "output", id="sim-kvmem-v")[0].text().strip(), "0.90")
        self.assertIn("Synthetic traffic", panel.text())

    def test_mig_switch(self):
        r = self.radios("sim-tab-mig")
        self.assertEqual([b.attrs.get("data-deploy") for b in r], ["gpu", "time", "mig"])
        self.assertEqual([" ".join(b.text().split()) for b in r], ["GPU per model", "time-slicing", "MIG"])
        self.assertEqual([b.attrs.get("aria-checked") for b in r], ["false", "false", "true"])
        self.assertEqual({b.parent.attrs.get("aria-label") for b in r}, {"Deployment"})
        self.assertEqual(r[0].parent.attrs.get("role"), "radiogroup")

    def test_routing_slider(self):
        panel = find_all(self.box, id="sim-tab-routing")[0]
        s = find_all(panel, "input", id="sim-route")[0]
        engine = (ROOT / "assets/sim-engine.js").read_text(encoding="utf-8")
        default = re.search(r"routing: \{ small: [^}]*threshold: ([0-9.]+),", engine).group(1)   # tab04()'s default
        self.assertEqual([s.attrs.get(k) for k in ("type", "min", "max", "step", "value")], ["range", "0", "1", "0.05", default])
        out = find_all(panel, "output", id="sim-route-v")[0]
        self.assertEqual(out.text().strip(), "%.2f" % float(default))
        self.assertEqual(out.attrs.get("for"), "sim-route")
        label = s.parent
        self.assertEqual(label.tag, "label")   # the label text names the slider
        self.assertEqual(" ".join(find_all(label, "span")[0].text().split()), "send to the large model at score ≥")

    def test_routing_switch(self):
        r = self.radios("sim-tab-routing")
        self.assertEqual([b.attrs.get("data-large") for b in r], ["onprem", "api"])
        self.assertEqual([" ".join(b.text().split()) for b in r], ["on-prem 8B", "API model"])
        self.assertEqual([b.attrs.get("aria-checked") for b in r], ["true", "false"])
        self.assertEqual({b.parent.attrs.get("aria-label") for b in r}, {"Large model"})
        self.assertEqual(r[0].parent.attrs.get("role"), "radiogroup")

    def test_routing_footer_items(self):
        # tab 04's items: hidden until assets/sim.js shows them in tab 04 (API spend only in API mode)
        for i in ("m-small", "m-mis", "m-api"):
            self.assertEqual(len(find_all(self.box, id=i)), 1, i)
            wrap = find_all(self.box, id=i + "-wrap")
            self.assertEqual(len(wrap), 1, i)
            self.assertIn("hidden", wrap[0].attrs, i)
            self.assertIn("sim-counters", wrap[0].parent.classes, i)

    def test_routing_views(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")

        def view(key):
            return dict(re.findall(r"(\w+): '([^']*)'", re.search(r"'" + key + r"': \{(.*?)\n    \}", js, re.S).group(1)))
        self.assertEqual(view("routing-onprem"), {
            "note": "· System1 model, Llama 3.2 1B and Llama 3 8B on one H100 · real time",
            "label": "one H100 · MIG 3g+2g+1g", "narrow": "H100 · MIG",
            "aria": "Animated simulation: a System1 model scores each request and routes it to a small or a large "
                    "model on one H100"})
        self.assertEqual(view("routing-api"), {
            "note": "· System1 model and Llama 3.2 1B on one H100, large model by API · real time",
            "label": "H100 + API model", "narrow": "H100 + API",
            "aria": "Animated simulation: a System1 model routes each request to a small model on one H100 or to a "
                    "large model behind an API"})

    def test_box_targets_skip_models_without_a_box(self):
        # tab 04's slo names the 8B and the API model, but each mode runs only one of them, so the p99 refresh
        # and the aria-label go through the models that have an instance, never straight through sim.slo
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertNotRegex(js, r"Object\.keys\(sim\.slo\)\.(map|forEach)")
        self.assertIn("targets: Object.keys(sim.slo || {}).filter(", js)

    def test_cost_tooltip_cites_the_api_in_api_mode(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertIn("E.API_SOURCE", js)
        self.assertIn("E.API.inputPer1M", js)
        self.assertIn("E.API.outputPer1M", js)

    def test_controls(self):
        for i in ("sim-play", "sim-burst"):
            self.assertEqual(len(find_all(self.box, "button", id=i)), 1, i)

    def test_colour_key(self):
        keys = find_all(self.box, cls="sim-key")
        self.assertEqual(len(keys), 1)
        kids = keys[0].parent.elements()   # directly under the canvas, above the footer
        self.assertEqual([k.tag if k.tag == "canvas" else k.classes[0] for k in kids[kids.index(keys[0]) - 1:][:3]],
                         ["canvas", "sim-key", "sim-follow"])   # the follow strip sits between the key and the footer
        entries = keys[0].elements()
        self.assertEqual([" ".join(e.text().split()) for e in entries], [
            "prefill", "decode, one token per step", "finished", "idle slot (request-level only)", "preempted", "KV cache"])
        for e in entries:
            self.assertEqual(len(find_all(e, "i")), 1, e.text())   # its swatch
        self.assertEqual(find_all(entries[4], "i")[0].classes, ["k-pre"])
        # tab 04 adds no entry: the System1 box's rows are prefill blocks, and the API box's rows are a prefill
        # block (its wait for the first token) and decode, in the same colours

    def js_function(self, name):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        return re.search(r"\n  function " + name + r"\(.*?\n  \}\n", js, re.S).group(0)

    def test_routing_box_headers(self):
        # tab 04's System1 box reads "System1 · scoring" with no p99 (its one token is a score no user sees), and
        # the API box names its spend and its requests in flight. Python can't run the canvas, so the browser
        # pass checks what they draw.
        head = self.js_function("header")
        self.assertIn("'System1 · scoring'", head)
        self.assertIn("'API model · '", head)
        self.assertIn(" in flight'", head)
        self.assertNotIn("if (sim.slo)", head)   # a target per model: the System1 model has none ("p99 – / NaNs")

    def test_routing_branches_name_the_rule(self):
        # tab 04 draws System1 in the middle with a branch to each model it routes to, labelled with the rule at
        # the live threshold (just "< 0.45" / "≥ 0.45" where the long label doesn't fit)
        branches = self.js_function("drawBranches")
        for piece in ("'score < '", "'score ≥ '", "' → small'", "' → large'", "'< '", "'≥ '", "sim.routing.threshold"):
            self.assertIn(piece, branches)
        # at 1 nothing goes large (ruling R3: threshold < 1 && score >= threshold), so the rule isn't "score ≥ 1.00"
        for piece in ("'all → small'", "'none → large'", "'all'", "'none'", "sim.routing.threshold >= 1"):
            self.assertIn(piece, branches)
        self.assertIn("if (sim.routing)", self.js_function("layout"))   # the routing layout is tab 04's alone

    def test_header_level_is_clamped(self):
        # draw() puts every box at the highest level any box needs, so a box with fewer levels stays at its barest
        self.assertIn("h.levels[Math.min(level, h.levels.length - 1)]", self.js_function("drawHeader"))

    def test_key_text_size(self):
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        key = re.search(r"\.sim-key \{([^}]*)\}", page).group(1)
        self.assertIn("font-size: 0.72rem;", key)   # the footer's size, and no DOM text under 11px

    def test_page_reads_no_engine_internals(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        for bad in ("inst.step", ".stepEnd", "inst.batch", "sim.cfg"):
            self.assertNotIn(bad, js, bad)

    def test_key_colours_match_canvas(self):
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")

        def squash(s):
            return re.sub(r"\s+", "", s)
        for cls, col in (("k-prefill", "accent"), ("k-decode", "decode"), ("k-done", "ok"), ("k-idle", "idle"), ("k-pre", "warn")):
            css = re.search(r"\.sim-key \." + cls + r" \{ --c: ([^;]+); \}", page)
            canvas = re.search(r"\b" + col + r": '([^']+)'", js)
            self.assertIsNotNone(css, cls)
            self.assertIsNotNone(canvas, col)
            self.assertEqual(squash(css.group(1)), squash(canvas.group(1)), cls)

    def test_caption_is_tab_neutral(self):
        kids = self.box.parent.elements()
        cap = kids[kids.index(self.box) + 1]
        self.assertEqual(cap.classes, ["cap", "js-only"])
        self.assertEqual(" ".join(cap.text().split()),
                         "A model of LLM serving, not a benchmark: step times come from the H100's specs and each "
                         "model's real size. Pick a tab, send a burst, then pause and watch it drain.")

    # A tab's full lesson lives in the window its "?" opens; the panel shows one sentence (summary)
    def lesson(self, panel_id):
        pop = find_all(find_all(self.box, id=panel_id)[0], cls="sim-pop")[0]
        return " ".join(find_all(pop, "p")[0].text().split())

    def summary(self, panel_id):
        p = find_all(find_all(self.box, id=panel_id)[0], "p", cls="sim-sum")[0]
        return " ".join(p.text().split()).removesuffix(" ?")

    SUMMARIES = {
        "batching": "Continuous batching. Requests join and leave at every step, so the queue drains instead of waiting on the slowest reply.",
        "kvcache": "KV cache. When the KV cache fills, the scheduler stops admitting and preempts requests: memory, not compute, caps how many run at once.",
        "mig": "MIG. Three models on one H100 split by MIG meet the same latency targets as three whole GPUs, with a third of the hardware.",
        "routing": "Model routing. A small System1 model sends easy requests to a 1B model and hard ones to the 8B, cutting cost until misroutes hurt answers.",
        "traffic": "Real traffic. Real traffic peaks well above its average, so a GPU sized for the average falls behind at the peak, which random traffic hides.",
        "failure": "Failure. Kill one of two replicas and its requests retry on the survivor, which falls behind until a replacement comes up.",
        "sandbox": "Sandbox. Build any deployment with the knobs or the terminal, watch its config follow, then take the SLO challenge.",
    }

    def test_one_lesson_shape(self):
        # every tab: a bold title and one sentence, then a "?" that opens its full lesson in a popover in the same panel
        for tab, text in self.SUMMARIES.items():
            panel = find_all(self.box, id="sim-tab-" + tab)[0]
            sums = find_all(panel, "p", cls="sim-sum")
            self.assertEqual(len(sums), 1, tab)
            self.assertEqual(self.summary("sim-tab-" + tab), text)
            self.assertEqual(sums[0].children[0].tag, "b", tab)
            more = find_all(sums[0], "button", cls="sim-more")
            self.assertEqual(len(more), 1, tab)
            pop_id = more[0].attrs.get("popovertarget")
            self.assertEqual([more[0].attrs.get("type"), more[0].text().strip()], ["button", "?"], tab)
            self.assertTrue(more[0].attrs.get("aria-label", "").startswith("More about "), tab)
            pops = find_all(panel, id=pop_id)
            self.assertEqual(len(pops), 1, tab)
            self.assertIn("popover", pops[0].attrs, tab)
            self.assertIn("sim-pop", pops[0].classes, tab)
            close = find_all(pops[0], "button", popovertarget=pop_id)
            self.assertEqual([(c.attrs.get("popovertargetaction"), c.attrs.get("aria-label")) for c in close], [("hide", "Close")], tab)
            self.assertTrue(self.lesson("sim-tab-" + tab).startswith(text.split(".")[0] + "."), tab)
            self.assertEqual(len(find_all(panel, "p")), 2, tab)   # the sentence and the full lesson, nothing else

    def test_one_lesson_height_and_canvas_height(self):
        # the lesson lines wrap differently at every width, so the page measures them all and gives every tab the
        # tallest one's height, on load, on resize and once the fonts are in
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertIn("function evenLessons()", js)
        fn = js[js.index("function evenLessons()"):]
        fn = fn[:fn.index("\n  }\n")]
        self.assertIn("panels.forEach", fn)
        self.assertIn("minHeight", fn)
        self.assertIn("evenLessons();", js[js.index("function resize("):])
        self.assertIn("document.fonts.ready.then(", js)
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("#sim { display: block; width: 100%; height: 300px;", page)
        self.assertNotIn("#sim.tall", page)
        self.assertNotIn("TALL_AT", js)
        self.assertNotIn("'tall'", js)

    def test_footer_fixed_cells(self):
        foot = find_all(self.box, cls="p-foot")[0]
        counters = find_all(foot, "div", cls="sim-counters")
        self.assertEqual(len(counters), 1)
        self.assertEqual([c.attrs.get("id") for c in counters[0].children if c.tag == "span"],
                         ["m-spent-wrap", "m-small-wrap", "m-mis-wrap", "m-api-wrap", "m-retry-wrap", "m-pre-wrap", "m-503-wrap"])
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        for metric, width in (("ttft50", "5ch"), ("ttft99", "5ch"), ("tpot", "5ch"), ("thr", "11ch"), ("kv", "4ch"), ("cost", "15ch")):
            self.assertRegex(page, r"#m-" + metric + r"\b[^{]*\{[^}]*min-width: " + width, metric)
        self.assertNotIn("#m-503 { color: var(--p-bad); }", page)   # red only once something was rejected
        self.assertIn("#simbox .p-head { flex-wrap: nowrap; }", page)   # a long note never wraps the header
        phone = page[page.index("@media (max-width: 640px)"):]
        self.assertIn(".sim-counters { min-height: 3.25rem;", phone[:phone.index("\n    }\n")])
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertIn("M.rej.classList.toggle('bad', m.rejected > 0)", js)

    def test_follow_strip_markup(self):
        # under the key, above the footer, the same height whether it follows a request or not
        kids = [c for c in self.box.children if c.tag != "#text" and c.tag != "#comment"]
        names = [c.attrs.get("id") or (c.classes[0] if c.classes else c.tag) for c in kids]
        self.assertLess(names.index("sim-key"), names.index("sim-follow"))
        self.assertLess(names.index("sim-follow"), names.index("p-foot"))
        strip = find_all(self.box, id="sim-follow")[0]
        nxt = find_all(strip, "button", id="fl-next")[0]
        self.assertEqual([nxt.attrs.get("type"), " ".join(nxt.text().split())], ["button", "follow the next request"])
        stop = find_all(strip, "button", id="fl-stop")[0]
        self.assertEqual([stop.attrs.get("aria-label"), "hidden" in stop.attrs], ["Stop following", True])
        self.assertEqual([r.attrs.get("data-kind") for r in find_all(strip, cls="fl-row")], ["queue", "prefill", "decode"])
        self.assertEqual(len(find_all(strip, id="fl-note")), 1)
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertRegex(page, r"\.sim-follow \{[^}]*height: [0-9.]+rem")
        phone = page[page.index("@media (max-width: 640px)"):]
        self.assertRegex(phone[:phone.index("\n    }\n")], r"\.sim-follow \{ height: [0-9.]+rem")

    def test_config_drawer_markup(self):
        btn = find_all(self.box, "button", id="sim-cfg")[0]
        self.assertIn("sim-counters", btn.parent.classes)
        self.assertEqual([btn.attrs.get(k) for k in ("type", "aria-controls", "aria-expanded")], ["button", "sim-config", "false"])
        self.assertEqual(" ".join(btn.text().split()), "config ▾")
        drawer = find_all(self.box, id="sim-config")[0]
        self.assertIn("hidden", drawer.attrs)
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertLess(page.index('<div class="p-foot">', page.index('id="simbox"')), page.index('id="sim-config"'))

    def test_follow_and_config_wiring(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        for needle in ("cv.addEventListener('click'", "E.requestSummary(sim, followed)", "followNext", "$('fl-next')", "$('fl-stop')",
                       "E.serverConfig(sim)", "lastKey = 'gpu-memory-utilization'", "lastKey = 'threshold'", "lastKey = 'batching'",
                       "lastKey = 'autoscaler'", "lastKey = 'large'", "function unfollow()"):
            self.assertIn(needle, js)
        deploy = js[js.index("function deploy("):js.index("function switchTab(")]
        self.assertIn("unfollow();", deploy)   # a redeploy is a new sim: nothing of the old one stays followed

    def test_follow_review_fixes(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        render = js[js.index("function renderFollow("):]
        render = render[:render.index("\n  }\n")]
        # the button pressed hides once a request is caught: focus moves to ×, not to the page
        self.assertIn("document.activeElement === flNext", render)
        self.assertIn("flStop.focus()", render)
        # written at most every FOLLOW_MS of frame time, and only the nodes whose text changed
        self.assertIn("FOLLOW_MS", render)
        self.assertIn("function put(", js)
        # paused, drained or frozen: nothing will arrive, so it follows the newest request in flight
        nxt = js[js.index("flNext.addEventListener('click'"):]
        nxt = nxt[:nxt.index("\n  });\n")]
        self.assertIn("E.playState(sim, frozen) !== 'running'", nxt)
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        # the strip's header stays one line on wide screens (two on phones), so the strip never clips its note
        self.assertRegex(page, r"\.fl-head \{[^}]*flex-wrap: nowrap")
        self.assertRegex(page, r"#fl-what \{[^}]*text-overflow: ellipsis")
        # the config pill is no taller than a counter's line, so the counters row keeps its height on every tab
        self.assertRegex(page, r"\.sim-counters \.sim-cfg \{[^}]*margin-block: -")

    def test_sandbox_panel_and_par(self):
        panel = find_all(self.box, id="sim-tab-sandbox")[0]
        go = find_all(panel, "button", id="sb-go")[0]
        self.assertEqual(" ".join(go.text().split()), "take the SLO challenge ›")
        engine = (ROOT / "assets/sim-engine.js").read_text(encoding="utf-8")
        par = float(re.search(r"parUsdPer1M: ([0-9.]+)", engine).group(1))
        self.assertIn("$%.2f" % par, self.lesson("sim-tab-sandbox"))   # the full lesson states the engine's par

    def test_sandbox_workbench(self):
        work = find_all(self.box, id="sb-work")[0]
        self.assertIn("hidden", work.attrs)
        panes = [(p.attrs.get("role"), p.attrs.get("aria-label")) for p in find_all(work, cls="sb-pane")]   # page <section>s are reading-trace sections
        self.assertEqual(panes, [("region", "Knobs"), ("region", "Terminal"), ("region", "Config")])
        groups = {g.attrs.get("aria-label"): [b.attrs.get("data-v") for b in find_all(g, "button", role="radio")]
                  for g in find_all(work, role="radiogroup")}
        engine = (ROOT / "assets/sim-engine.js").read_text(encoding="utf-8")
        layouts = re.findall(r"'?([a-z0-9+-]+)'?: \[", re.search(r"var SANDBOX_LAYOUTS = \{(.*?)\};", engine, re.S).group(1))
        self.assertEqual(groups, {"GPUs": ["1", "2", "3"], "Layout": layouts, "Batching": ["request", "continuous"],
                                  "Traffic": ["random", "trace"], "Bursts": ["on", "off"], "Router": ["least", "round-robin"],
                                  "Autoscaler": ["off", "on"]})
        for i in ("sb-models", "sb-mem", "sb-mem-v", "sb-seqs", "sb-rate", "sb-rate-v", "sb-lengths", "sb-kill", "sb-config"):
            self.assertEqual(len(find_all(work, id=i)), 1, i)
        log = find_all(work, id="sb-log")[0]
        self.assertEqual(log.attrs.get("role"), "log")
        cmd = find_all(work, "input", id="sb-cmd")[0]
        self.assertEqual([cmd.attrs.get("type"), cmd.attrs.get("aria-label"), cmd.attrs.get("autocomplete")], ["text", "Sandbox command", "off"])
        chal = find_all(self.box, id="sb-chal")[0]
        self.assertIn("hidden", chal.attrs)
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertLess(page.index('id="sim-follow"'), page.index('id="sb-chal"'))
        self.assertLess(page.index('id="sb-chal"'), page.index('<div class="p-foot">', page.index('id="simbox"')))

    def test_sandbox_wiring(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        for needle in ("E.sandboxCommand(SANDBOX, line)", "E.sandboxPreset(SANDBOX, TRACE)", "E.challengePreset(SANDBOX, TRACE)",
                       "E.spentUsd(sim)", "E.setRouter(sim, SANDBOX.router)", "E.CHALLENGE.sloMs", "function startChallenge(",
                       "function syncKnobs(", "lastKey = 'router'"):
            self.assertIn(needle, js)
        deploy = js[js.index("function deploy("):js.index("function switchTab(")]
        self.assertIn("id === 'challenge' ? 0", deploy)   # the challenge starts from empty servers, at minute 20

    def test_sandbox_challenge_holds(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        judge = js[js.index("function judge("):]
        judge = judge[:judge.index("\n  }\n")]
        self.assertIn("E.challengeDone(sim)", judge)          # done once the whole window is served, not when it drains
        self.assertIn("challenge.result", judge)              # the verdict and cost freeze at done
        run = js[js.index("function run(line)"):]
        run = run[:run.index("\n  }\n")]
        self.assertIn("not during the challenge", run)       # pause, play and burst would change the workload
        switch = js[js.index("function switchTab("):js.index("function setMode(")]
        self.assertIn("stopChallenge(false)", switch)
        self.assertIn("sbGo.focus()", js)                     # try again / back to free play keep the keyboard's place
        knob = js[js.index("function knob("):]
        self.assertIn("aria-checked') === 'true'", knob[:knob.index("\n  }\n")])   # re-clicking the choice made does nothing
        said = find_all(self.box, id="sb-chal-said")[0]
        self.assertEqual(said.attrs.get("role"), "status")
        self.assertIn("vh", said.classes)
        self.assertIn("doesn't fit", js)                      # a model too big for its slice is drawn as such
        self.assertNotIn("Everything the other tabs", self.lesson("sim-tab-sandbox"))

    def test_start_screen_markup(self):
        # the panel opens small: one live flow, a line on what's inside, and a start button where play will be
        self.assertIn("start", self.box.classes)
        start = find_all(self.box, "button", id="sim-start")[0]
        self.assertEqual([start.attrs.get("type"), " ".join(start.text().split())], ["button", "▶ start inference sim"])
        shrink = find_all(self.box, "button", id="sim-shrink")[0]
        self.assertEqual([shrink.attrs.get("type"), shrink.attrs.get("aria-label")], ["button", "Shrink the simulator"])
        self.assertEqual(start.parent.attrs.get("class"), shrink.parent.attrs.get("class"))   # both in the header's controls
        intro = find_all(self.box, cls="sim-intro")[0]
        self.assertEqual(" ".join(intro.text().split()),
                         "a live LLM serving simulator: batching · KV cache · MIG · routing · real traffic · failure · sandbox")

    def test_start_screen_hides_the_rest(self):
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        rule = re.search(r"(#simbox\.start [^{]*)\{ display: none; \}", page)
        self.assertIsNotNone(rule, "the start screen's hide rule")
        for sel in (".sim-tabs", "[role=tabpanel]", ".sim-key", ".sim-follow", ".sb-chal", ".p-foot", ".sim-config", ".sb-work",
                    "#sim-play", "#sim-burst", "#sim-shrink"):
            self.assertIn("#simbox.start " + sel, rule.group(1), sel)
        self.assertRegex(page, r"#simbox:not\(\.start\) \.sim-intro, #simbox:not\(\.start\) #sim-start \{ display: none; \}")
        self.assertRegex(page, r"#simbox\.start #sim \{ height: \d+px; \}")

    def test_start_and_shrink_wiring(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        start = js[js.index("function startSim("):]
        start = start[:start.index("\n  }\n")]
        self.assertIn("box.classList.remove('start')", start)
        self.assertIn(".focus()", start)                       # the keyboard lands on the tab list
        shrink = js[js.index("function shrinkSim("):]
        shrink = shrink[:shrink.index("\n  }\n")]
        self.assertIn("switchTab('batching')", shrink)         # the small screen always shows tab 01's flow
        self.assertIn("box.classList.add('start')", shrink)
        self.assertIn("startBtn.focus()", shrink)
        self.assertIn("REDUCE", js[js.index("function grow("):js.index("function startSim(")])   # no grow animation with reduced motion

    def test_popover_placed_by_its_button(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertIn("addEventListener('toggle'", js)
        self.assertIn("'.sim-pop'", js)

    def test_kvcache_lesson(self):
        self.assertEqual(self.lesson("sim-tab-kvcache"),
                         "KV cache. Every token a request holds keeps its keys and values in GPU memory. When that pool "
                         "is full, the scheduler stops admitting and preempts the newest request: its KV is dropped and "
                         "it redoes its prefill later. Give the server less memory and fewer requests fit at once, so "
                         "preemptions start sooner and throughput drops: memory, not compute, limits how many requests "
                         "run at once. Synthetic traffic: long prompts and long replies.")

    def test_mig_lesson(self):
        self.assertEqual(self.lesson("sim-tab-mig"),
                         "MIG. Three models, each with its own traffic and latency target (p99 time to first token: 8B "
                         "2 s, 3B 500 ms, 1B 300 ms). Kubernetes hands each pod a whole GPU, so they take three "
                         "underused H100s. Time-slicing shares one H100: the models take turns and every switch wastes "
                         "GPU time (assumed here to be about 30%), so the 8B misses its target. MIG splits one H100 into "
                         "isolated slices and meets every target with a third of the GPUs, though each slice has less "
                         "headroom than a whole GPU. At Trendyol this gave about 1.75× more serving capacity.")

    def test_routing_lesson(self):
        lesson = self.lesson("sim-tab-routing")
        self.assertEqual(lesson,
                         "Model routing. A small System1 model scores every request, and only the hard ones go to the "
                         "large model; the rest go to a 1B model that costs a fraction as much. Raising the threshold "
                         "cuts cost — on-prem by letting one H100 serve all the traffic, with the API by shrinking the "
                         "bill — but push it too far and hard requests land on the small model and get worse answers. "
                         "Difficulty and answer quality are modelled, not measured.")
        note = find_all(find_all(self.box, id="sim-tab-routing")[0], "span", cls="sim-note")
        self.assertEqual([" ".join(n.text().split()) for n in note], ["Difficulty and answer quality are modelled, not measured."])
        self.assertNotIn("sweet spot", lesson)   # on-prem cost stops falling at about 0.30, below the default

    def test_mig_lesson_states_the_engine_targets_and_overhead(self):
        engine = (ROOT / "assets/sim-engine.js").read_text(encoding="utf-8")
        slo = dict(re.findall(r"'llama-([0-9.-]+b)': (\d+)", re.search(r"var SLOS = \{([^}]*)\}", engine).group(1)))   # tab 03's targets
        said = {"3-8b": "8B", "3.2-3b": "3B", "3.2-1b": "1B"}
        targets = ", ".join(said[m] + " " + (str(int(ms) // 1000) + " s" if int(ms) >= 1000 else ms + " ms")
                            for m, ms in slo.items())
        self.assertIn("(p99 time to first token: " + targets + ")", self.lesson("sim-tab-mig"))
        loss = float(re.search(r"var CTX_SWITCH_LOSS = ([0-9.]+);", engine).group(1))
        self.assertIn("about %d%%" % round(loss * 100), self.lesson("sim-tab-mig"))

    def test_visitor_view_tests_model_the_page(self):
        # tests/sim.test.mjs replays what a visitor sees; its warm-ups, refresh and p99 window must be the page's
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        node = (ROOT / "tests/sim.test.mjs").read_text(encoding="utf-8")

        def num(pattern, text):
            return int(re.search(pattern, text).group(1))
        tick = num(r"TICK_MS = (\d+);", js)
        page = {"tickMs": tick, "warmMs": num(r"var WARMUP_TICKS = (\d+)", js) * tick,
                "tab03WarmMs": num(r"var TAB03_WARMUP_TICKS = (\d+);", js) * tick,
                "sampleMs": num(r"var SAMPLE_MS = (\d+)", js), "p99WindowMs": num(r"var P99_WINDOW_MS = (\d+);", js)}
        modelled = {k: int(v) for k, v in re.findall(r"(\w+): (\d+)", re.search(r"const PAGE = \{([^}]*)\}", node).group(1))}
        self.assertEqual(modelled, page)
        self.assertEqual((page["warmMs"], page["tab03WarmMs"]), (8000, 40000))

    def test_time_sliced_label_says_shared_on_phones(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        view = re.search(r"'mig-time': \{(.*?)\n    \}", js, re.S).group(1)
        self.assertIn("narrow: 'shared H100'", view)

    def test_throughput_and_cost_say_output_tokens(self):
        thr = find_all(self.box, id="m-thr")[0].parent
        self.assertEqual(thr.attrs.get("title"), "output tokens per second")
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertIn("M.cost.parentNode.title = 'per 1M output tokens · H100 at $'", js)

    def test_tab05_exists(self):
        tab = find_all(self.box, "button", id="sim-tabbtn-traffic")[0]
        self.assertEqual([tab.attrs.get(k) for k in ("role", "data-tab", "aria-controls", "aria-selected")],
                         ["tab", "traffic", "sim-tab-traffic", "false"])
        panel = find_all(self.box, id="sim-tab-traffic")[0]
        self.assertEqual([panel.attrs.get(k) for k in ("role", "data-tab", "aria-labelledby")],
                         ["tabpanel", "traffic", "sim-tabbtn-traffic"])
        self.assertIn("hidden", panel.attrs)
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertLess(page.index('id="sim-tab-routing"'), page.index('id="sim-tab-traffic"'))

    def test_tab05_traffic_switch(self):
        r = self.radios("sim-tab-traffic")
        self.assertEqual([b.attrs.get("data-traffic") for b in r], ["random", "trace"])
        self.assertEqual([" ".join(b.text().split()) for b in r], ["random", "Azure trace"])
        self.assertEqual([b.attrs.get("aria-checked") for b in r], ["false", "true"])
        self.assertEqual({b.parent.attrs.get("aria-label") for b in r}, {"Traffic"})
        self.assertEqual(r[0].parent.attrs.get("role"), "radiogroup")

    def test_tab05_credits_the_trace(self):
        panel = find_all(self.box, id="sim-tab-traffic")[0]
        hrefs = [a.attrs.get("href", "") for a in find_all(panel, "a")]
        self.assertTrue(any("github.com/Azure/AzurePublicDataset" in h for h in hrefs), hrefs)
        self.assertTrue(any("creativecommons.org/licenses/by/4.0" in h for h in hrefs), hrefs)
        text = " ".join(panel.text().split())
        for words in ("every 4th request", "12×", "Microsoft", "Splitwise"):
            self.assertIn(words, text)

    def test_tab05_lesson_states_the_measured_peak(self):
        import json
        d = json.loads((ROOT / "assets/sim/azure-conv.json").read_text())
        lesson = self.lesson("sim-tab-traffic")
        self.assertIn("about %.1f× the hour's average" % d["peakRatio"], lesson)
        self.assertIn("Size for the peak, not the average.", lesson)

    def test_tab05_fetches_its_trace_and_survives_failure(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertIn("fetch('assets/sim/azure-conv.json')", js)
        chain = js[js.index("fetch('assets/sim/azure-conv.json')"):]
        self.assertIn(".catch(", chain[:chain.index("\n  }\n")])
        self.assertIn("'loading the trace…'", js)
        self.assertIn("'the trace didn\\'t load'", js)

    def test_tab05_switches_to_the_trace_when_it_arrives(self):
        # Opened before the trace is in (the canvas below the fold, or a slow fetch), tab 05 starts on random;
        # when the trace arrives it switches, unless the visitor picked random. A failed load retries next time.
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        branch = re.search(r"else if \(id === 'traffic'\) \{([^}]*)\}", js)
        self.assertIsNotNone(branch, "switchTab's traffic branch")
        self.assertLess(branch.group(1).index("loadTrace();"), branch.group(1).index("deploy("))
        self.assertIn("pickedRandom = false", js[js.index("function switchTab("):js.index("function setMode(")])
        traffic = js[js.index("function setTraffic("):]
        self.assertIn("pickedRandom = id === 'traffic-random'", traffic[:traffic.index("\n  }\n")])
        load = js[js.index("function loadTrace()"):]
        load = load[:load.index("\n  }\n")]
        self.assertIn("if (preset === 'traffic-random' && !pickedRandom) deploy('traffic-trace');", load)
        self.assertIn("traceAsked = false", load[load.index(".catch("):])

    def test_tab05_credit_links_show_on_the_panel(self):
        # the links take .sim-note's colour, so their underline is what marks them: at least 3:1 on the panel
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        rule = re.search(r"\.sim-note a \{([^}]*)\}", page)
        self.assertIsNotNone(rule, ".sim-note a rule")
        r, g, b, alpha = (float(v) for v in re.search(r"text-decoration-color: rgba\(([^)]*)\)", rule.group(1)).group(1).split(","))
        panel = (0x0f, 0x11, 0x15)
        mixed = "#" + "".join("%02x" % round(c * alpha + p * (1 - alpha)) for c, p in zip((r, g, b), panel))
        self.assertGreaterEqual(contrast(mixed, "#0f1115"), 3)
        hover = re.search(r"\.sim-note a:hover \{([^}]*)\}", page)
        self.assertIsNotNone(hover, ".sim-note a:hover rule")
        self.assertIn("color: var(--p-accent)", hover.group(1))

    def test_tab05_views(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        for key in ("traffic-trace", "traffic-random"):
            self.assertRegex(js, r"'" + key + r"': \{")
        self.assertIn("Azure trace, 1 h in 5 min", js)

    def test_tab06_exists(self):
        tab = find_all(self.box, "button", id="sim-tabbtn-failure")[0]
        self.assertEqual([tab.attrs.get(k) for k in ("role", "data-tab", "aria-controls", "aria-selected")],
                         ["tab", "failure", "sim-tab-failure", "false"])
        panel = find_all(self.box, id="sim-tab-failure")[0]
        self.assertEqual([panel.attrs.get(k) for k in ("role", "data-tab", "aria-labelledby")],
                         ["tabpanel", "failure", "sim-tabbtn-failure"])
        self.assertIn("hidden", panel.attrs)
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertLess(page.index('id="sim-tab-traffic"'), page.index('id="sim-tab-failure"'))

    def test_tab06_controls(self):
        panel = find_all(self.box, id="sim-tab-failure")[0]
        kill = find_all(panel, "button", id="sim-kill")
        self.assertEqual(len(kill), 1)
        self.assertEqual([kill[0].attrs.get("type"), " ".join(kill[0].text().split())], ["button", "kill a GPU"])
        r = self.radios("sim-tab-failure")
        self.assertEqual([b.attrs.get("data-autoscale") for b in r], ["off", "on"])
        self.assertEqual([" ".join(b.text().split()) for b in r], ["autoscaler off", "autoscaler on"])
        self.assertEqual([b.attrs.get("aria-checked") for b in r], ["true", "false"])
        self.assertEqual({b.parent.attrs.get("aria-label") for b in r}, {"Autoscaler"})
        self.assertEqual(r[0].parent.attrs.get("role"), "radiogroup")

    def test_tab06_footer_item(self):
        self.assertEqual(len(find_all(self.box, id="m-retry")), 1)
        wrap = find_all(self.box, id="m-retry-wrap")
        self.assertEqual(len(wrap), 1)
        self.assertIn("hidden", wrap[0].attrs)
        self.assertIn("sim-counters", wrap[0].parent.classes)

    def test_tab06_lesson(self):
        self.assertEqual(self.lesson("sim-tab-failure"),
                         "Failure. Two replicas of Llama 3 8B, each on its own H100, share the traffic. Kill one and its "
                         "requests come back as client retries: their KV cache died with the GPU, so each redoes its "
                         "prefill and starts its reply over, and p99 spikes. The survivor can't carry both GPUs' traffic "
                         "alone, so its queue grows and requests get 503s. Turn the autoscaler on and a replacement H100 "
                         "comes up after a cold start, and the queues drain. Cold start: 30 s, assumed (a warm spare node "
                         "loading the weights); a fresh node takes minutes.")
        engine = (ROOT / "assets/sim-engine.js").read_text(encoding="utf-8")
        self.assertIn("var COLD_START_MS = 30000;", engine)   # the note's 30 s

    def test_tab06_resets_on_open(self):
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertIn("else if (id === 'failure') deploy('failure');", js)
        self.assertRegex(js, r"\n    failure: \{")
        self.assertIn("E.killGpu(sim)", js)
        self.assertIn("E.setAutoscaler(sim", js)

    def test_tab06_dead_box_streams_no_tokens(self):
        # a failed or starting box makes no tokens, so its particle rate drops to 0 at once rather than decaying
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        sync = js[js.index("function sync(dt)"):js.index("function sync(dt)") + 6000]
        self.assertIn("if (!inst.api && E.instanceStatus(sim, inst).state !== 'up') { V.rate[ii] = 0; V.acc[ii] = 0; }", sync)

    def test_tab06_kill_button_keeps_focus(self):
        # disabling a focused button drops focus to the page; aria-disabled keeps it, with the reason as its title
        js = (ROOT / "assets/sim.js").read_text(encoding="utf-8")
        self.assertNotIn("killBtn.disabled", js)
        self.assertIn("killBtn.setAttribute('aria-disabled', 'true')", js)
        self.assertIn("'one GPU left'", js)

    def test_switch_as_tall_as_header_buttons(self):
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        pad = re.compile(r"padding: ([0-9.]+rem [0-9.]+rem);")
        ctrl = re.search(r"\.p-ctrl button, \.p-ctrl select \{([^}]*)\}", page).group(1)
        seg = re.search(r"\.seg button \{([^}]*)\}", page).group(1)
        self.assertEqual(pad.search(seg).group(1), pad.search(ctrl).group(1))


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
        self.assertTrue(talks and shops)  # how many is up to events.md
        for li in talks + shops:
            self.assertRegex(li.attrs.get("data-date", ""), DATE_RE)

    def test_full_dates_name_their_event(self):
        # a full date can become the next-up card, whose strip shows data-event
        for li in self.items("talk-list") + self.items("workshop-list"):
            d = li.attrs.get("data-date", "")
            if FULL_DATE_RE.match(d):
                self.assertTrue(li.attrs.get("data-event"), f"{d} missing data-event")

    def test_no_js_fallback(self):
        card = find_all(self.doc, id="up-card")
        self.assertEqual(len(card), 1)
        self.assertIn("hidden", card[0].attrs)
        self.assertFalse(card[0].elements())
        self.assertIn("hidden", find_all(self.doc, id="strip-next")[0].attrs)
        dated = [li.attrs.get("data-date") for li in self.items("workshop-list")]
        self.assertIn("2026-10-27", dated)

    def test_every_row_shows_without_js(self):
        for li in self.items("talk-list") + self.items("workshop-list"):
            self.assertNotIn("hidden", li.attrs)
        self.assertFalse(find_all(self.sec, "button"))  # speaking.js adds the fold buttons

    def test_strip_hidden_without_js(self):
        strip = find_all(self.doc, id="strip")
        self.assertEqual(len(strip), 1)
        self.assertIn("js-only", strip[0].classes)

    def test_tags_are_links(self):
        self.assertIsNotNone(self.sec)
        tags = find_all(self.sec, cls="tag")
        self.assertTrue(tags)
        for t in tags:
            self.assertEqual(t.tag, "a")
            self.assertTrue(t.attrs.get("href"))


class AboutExperience(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = parse()

    def test_about_two_columns(self):
        about = find_all(self.doc, "section", id="about")[0]
        body = find_all(about, cls="about-body")[0]
        fig = find_all(about, id="att-fig")[0]
        self.assertIs(body.parent, fig.parent)
        self.assertIn("two", body.parent.classes)
        kids = body.parent.elements()
        self.assertLess(kids.index(body), kids.index(fig))

    def test_badge_moved(self):
        about = find_all(self.doc, "section", id="about")[0]
        self.assertFalse(find_all(about, cls="badge"))
        badges = find_all(self.doc, cls="badge")
        self.assertEqual(len(badges), 2)
        self.assertEqual(len(find_all(find_all(self.doc, "header")[0], cls="badge")), 2)

    def test_community_list(self):
        exp = find_all(self.doc, "section", id="experience")[0]
        h3 = [h for h in find_all(exp, "h3") if h.text().strip() == "Community"]
        self.assertEqual(len(h3), 1)
        sib = h3[0].parent.elements()
        ul = sib[sib.index(h3[0]) + 1]
        self.assertEqual((ul.tag, "list" in ul.classes), ("ul", True))
        self.assertEqual([n.text().strip() for n in find_all(ul, cls="item-title")],
                         ["Google Developer Expert, Cloud AI", "Mentor, Google for Startups Accelerator",
                          "Co-organizer, GDG Istanbul", "Gemma Train-the-Trainer"])
        self.assertEqual([n.text().strip() for n in find_all(ul, cls="item-meta")],
                         ["Google · 2026", "Google for Startups · 2026", "Google Developer Groups",
                          "Google Developer Experts · 2026"])
        self.assertFalse([h for h in find_all(exp, "h3") if "Education" in h.text()])


class ProjectsWriting(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.doc = parse(cls.html)

    def cards(self, cls_name):
        box = find_all(self.doc, cls=cls_name)
        self.assertEqual(len(box), 1, cls_name)
        return [c for c in box[0].elements() if c.tag == "article" and "card" in c.classes]

    def test_featured_pair(self):
        cards = self.cards("feat2")
        self.assertEqual([find_all(c, cls="name")[0].text().strip() for c in cards], ["tensorhane.com", "sdlc-agent-pipeline"])
        th = cards[0]
        self.assertEqual(find_all(th, cls="label")[0].text().strip(), "Live · rising")
        self.assertEqual(find_all(th, cls="what")[0].text().strip(), "Learn machine learning by writing it, in Turkish")
        self.assertEqual([s.text().strip() for s in find_all(find_all(th, cls="chips")[0], "span")], ["Python", "NumPy", "Triton", "Türkçe"])
        img = find_all(th, "img")[0]
        self.assertEqual((img.attrs.get("src"), img.attrs.get("width"), img.attrs.get("height")), ("assets/projects/tensorhane.jpg", "880", "550"))
        self.assertEqual(find_all(find_all(th, cls="name")[0], "a")[0].attrs.get("href"), "https://tensorhane.com")

    def test_grid_of_four(self):
        cards = self.cards("grid4")
        self.assertEqual([find_all(c, cls="name")[0].text().strip() for c in cards],
                         ["vllm-metal-bench", "triton-beginner-demo", "augury", "claude-caps"])
        for c in cards:
            kids = c.elements()
            first_img = next(i for i, k in enumerate(kids) if find_all(k, "img") or k.tag == "img")
            first_text = next(i for i, k in enumerate(kids) if find_all(k, cls="name"))
            self.assertLess(first_img, first_text)

    def test_card_img_css(self):
        rule = re.search(r"\.card img \{([^}]*)\}", self.html)
        self.assertIsNotNone(rule)
        self.assertIn("height: auto", rule.group(1))
        self.assertIn("aspect-ratio: 16 / 10", rule.group(1))

    def test_writing_oss_merged(self):
        sec = find_all(self.doc, "section", id="writing")
        self.assertEqual(len(sec), 1)
        self.assertEqual(find_all(sec[0], "h2")[0].text().strip(), "Writing & Open Source")
        self.assertTrue([n for n in sec[0].iter() if n.tag == "#comment" and n.data.strip() == "MEDIUM:START"])
        hrefs = [a.attrs.get("href") for a in find_all(sec[0], "a")]
        self.assertIn("https://github.com/google/adk-python/pull/3037", hrefs)
        self.assertIn("https://github.com/google/adk-web/pull/272", hrefs)
        self.assertFalse(find_all(self.doc, "section", id="oss"))

    def test_span_names_final(self):
        names = [find_all(s, cls="sp-name")[0].text().strip() for s in find_all(self.doc, cls="span")]
        self.assertEqual(names, ["about.md", "experience.md", "speaking.md", "projects.md", "writing.md", "contact.md"])


BOOKING_URL = ("https://calendar.google.com/calendar/appointments/schedules/"
               "AcZssZ0eb5WUAIpBMx4QPBcHLYvEkpsTizdL89jBUa6UXEfyqFAB_blGgZgBPyEFoXzoag5z6xWIRzHT?gv=true")


class Booking(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = parse()

    def test_iframe(self):
        frames = find_all(self.doc, "iframe", cls="booking-frame")
        self.assertEqual(len(frames), 1)
        f = frames[0]
        self.assertEqual(f.attrs.get("src"), BOOKING_URL)
        self.assertTrue(f.attrs.get("title"))
        self.assertEqual(f.attrs.get("loading"), "lazy")
        node = f.parent
        while node is not None and node.tag != "dialog":
            node = node.parent
        self.assertIsNotNone(node, "booking iframe should live in a <dialog>, not inline in the page")
        self.assertEqual(node.attrs.get("id"), "booking")

    def test_trigger(self):
        # a real link, so the booking page still opens (in a new tab) without JS
        a = find_all(self.doc, "a", id="booking-open")
        self.assertEqual(len(a), 1)
        self.assertEqual(a[0].attrs.get("href"), BOOKING_URL)
        self.assertEqual(a[0].attrs.get("target"), "_blank")
        self.assertTrue(find_all(a[0], "svg", cls="ic"))
        dialog = find_all(self.doc, "dialog", id="booking")[0]
        forms = find_all(dialog, "form")
        self.assertEqual([f.attrs.get("method") for f in forms], ["dialog"])
        self.assertTrue(find_all(forms[0], "button", cls="booking-close"))

    def test_fallback_link(self):
        links = find_all(self.doc, "a", cls="booking-link")
        self.assertEqual(len(links), 1)
        a = links[0]
        self.assertEqual(a.attrs.get("href"), BOOKING_URL)
        self.assertEqual(a.text().strip(), "Open the booking page ↗")
        node = a.parent
        while node is not None:
            self.assertNotEqual(node.tag, "iframe")
            node = node.parent

    def test_book_a_call_targets(self):
        booking = [a for a in find_all(self.doc, "a") if a.text().strip() == "Book a call"]
        self.assertGreaterEqual(len(booking), 2)
        for a in booking:
            self.assertEqual(a.attrs.get("href"), "#contact")
        contact = find_all(self.doc, "section", id="contact")[0]
        self.assertEqual(find_all(contact, "h2")[0].text().strip(), "Book a call")

    def test_contact_links_have_icons(self):
        contact = find_all(self.doc, "section", id="contact")[0]
        links = find_all(find_all(contact, cls="links")[0], "a")
        self.assertEqual([a.attrs.get("href") for a in links], [
            BOOKING_URL, "mailto:hi@omarcevi.dev", "https://www.linkedin.com/in/omarcevi/",
            "https://github.com/omarcevi", "https://omarcevi.medium.com"])
        for a in links:
            self.assertTrue(find_all(a, "svg", cls="ic"), a.attrs.get("href"))


def _lum(hex_color):
    rgb = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    hi, lo = sorted((_lum(a), _lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


class Meta(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.llms = (ROOT / "llms.txt").read_text(encoding="utf-8")

    def blocks(self):
        """The three token blocks: light :root, the OS-dark :root, and :root[data-theme="dark"]."""
        heads = [r"    :root \{\n", r':root:not\(\[data-theme="light"\]\) \{\n', r':root\[data-theme="dark"\] \{\n']
        out = []
        for h in heads:
            m = re.search(h + r"(.*?)\}", self.html, re.S)
            self.assertIsNotNone(m, h)
            out.append(dict(re.findall(r"--([a-z-]+):\s*(#[0-9a-fA-F]{6});", m.group(1))))
        return out

    def test_llms_txt(self):
        self.assertIn("Architecting Multi-Agent Systems with Google ADK (workshop) — Google Developer Day Istanbul, 9 October 2026", self.llms)
        self.assertIn("Deploying your agents on Google Cloud Agent Platform (workshop) — Google Cloud Day Türkiye – Builder Connect, 27 October 2026", self.llms)
        self.assertIn("Book a call: " + BOOKING_URL, self.llms)

    def test_faint_contrast(self):
        light, os_dark, dark = self.blocks()
        self.assertEqual(os_dark.get("faint"), dark.get("faint"))
        for block, bg in ((light, light["bg"]), (dark, dark["bg"])):
            self.assertGreaterEqual(contrast(block["faint"], bg), 4.5, block["faint"])
        # keep the hierarchy: faint stays fainter than muted
        self.assertLess(contrast(light["faint"], light["bg"]), contrast(light["muted"], light["bg"]))
        self.assertLess(contrast(dark["faint"], dark["bg"]), contrast(dark["muted"], dark["bg"]))

    def test_primary_hover_readable_in_dark(self):
        # white on the dark theme's light accent (#7aa2ff) is 2.5:1; the page ground colour reads in both themes
        for sel in (r"\.topbar \.cta:hover", r"\.links a\.primary:hover"):
            rule = re.search(sel + r" \{([^}]*)\}", self.html)
            self.assertIsNotNone(rule, sel)
            self.assertIn("color: var(--bg)", rule.group(1), sel)
            self.assertNotIn("#fff", rule.group(1), sel)

    def test_date_modified(self):
        m = re.search(r'"dateModified": "(\d{4}-\d{2}-\d{2})"', self.html)
        self.assertGreaterEqual(m.group(1), "2026-10-23")


if __name__ == "__main__":
    unittest.main()
