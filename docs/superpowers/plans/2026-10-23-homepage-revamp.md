# Homepage Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen omarcevi.dev to a 1120px two-column layout in its current visual language. Add a Speaking section with upcoming and past talks and per-item materials, a next-talk strip, a projects showcase that includes tensorhane.com, a hero photo, social icons, and an embedded Google Calendar booking page.

**Architecture:** The site stays one hand-written `index.html` on GitHub Pages with no build step. One new script, `assets/speaking.js`, holds the date logic as pure functions (testable in Node) plus the DOM wiring that fills the upcoming card and the strip. Structural guarantees are checked by a stdlib-only Python test suite. Rendered behaviour is checked by headless Chrome `--dump-dom` with a `?today=YYYY-MM-DD` override.

**Tech Stack:** HTML/CSS/vanilla JS (ES5 style, matching the inline scripts), Python 3 `unittest` (stdlib only), `node --test`, headless Google Chrome.

**Spec:** `docs/superpowers/specs/2026-10-23-homepage-revamp-design.md`. Read it before starting. The approved visual reference is `.superpowers/brainstorm/62016-1792758504/content/wide-v4.html`. It's a reference for structure only, not code to copy.

## Global Constraints

- One `index.html`, no build step, no framework. The only new script is `assets/speaking.js`. Inline SVG icons only, with no icon library and no new third-party script.
- **Keep the current look:** Geist plus Geist Mono labels, `--accent` used sparingly, thin and dashed dividers, dark demo panels, `read <name>.md` spans, the trace panel. Not a landing page: no giant type, no full-colour bands.
- **Do not change** the text of `<h1 id="name">`, `<p id="tagline">` (with its `<strong>`) or the `<p>` paragraphs inside `<div class="about-body prose">`. `assets/ml/source.sha` must keep matching (`15e78698526dec86`).
- Keep `<!-- MEDIUM:START -->` and `<!-- MEDIUM:END -->` inside a `<ul class="list">`.
- One `.span` per `<section>`, as a direct child. The final span names, in order: `about.md, experience.md, speaking.md, projects.md, writing.md, contact.md`.
- Keep `/#talks` working (the workshop guides link to it).
- Container: `.page` `max-width: 1120px`, gutter `1.5rem`. Two-column grids collapse to one at `max-width: 860px`. The existing `max-width: 640px` rules stay.
- Light and dark tokens stay in sync across `:root`, the OS dark media query and `:root[data-theme="dark"]`.
- Every `<img>` has `width`, `height` and `alt`. Images below the fold use `loading="lazy" decoding="async"`.
- Booking URL, verbatim: `https://calendar.google.com/calendar/appointments/schedules/AcZssZ0eb5WUAIpBMx4QPBcHLYvEkpsTizdL89jBUa6UXEfyqFAB_blGgZgBPyEFoXzoag5z6xWIRzHT?gv=true`
- Commits: plain messages in the repo's style (`Homepage: …`). **Never** add a `Co-Authored-By: Claude` trailer or any Claude attribution (user's global CLAUDE.md).

## Review Focus

1. **A visitor east or west of Istanbul near midnight:** "today" is Istanbul's date, not the browser's local date. A talk on 27 Oct is still upcoming at 01:30 Istanbul time on 27 Oct, whatever the visitor's timezone. This is pinned in Task 4 (`istanbulToday` test).
2. **The talk is today:** it stays upcoming and featured, and the strip reads `today`, not `in 0 days`. Pinned in Task 4 (`daysLabel` and `partition` tests).
3. **No upcoming items** (from 28 Oct): the upcoming card stays hidden, the strip shows the invite line instead of `in NaN days`, and the counts include the 27 Oct workshop. Pinned in Task 4 (render test with `today=2026-10-28`).
4. **JS disabled or the script fails to load:** every talk and workshop is still listed in its column, and the empty card shell is never visible because it ships with `hidden`. Pinned in Task 3 (static test).
5. **The booking iframe is blocked** (third-party cookie or ad blockers): a plain "Open the booking page ↗" link sits outside the iframe and always works. Pinned in Task 7 (static test).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `index.html` (modify) | Markup, CSS and the existing inline scripts. Every task touches it. |
| `assets/speaking.js` (create) | Pure date functions plus the `initSpeaking(doc)` DOM wiring. Exposes `window.Speaking`, and `module.exports` in Node. |
| `assets/photos/omar-gdd-istanbul.jpg` (create) | Hero photo, 720×900, copied from the scratchpad crop. |
| `assets/projects/tensorhane.jpg` (create) | tensorhane.com thumbnail, 880×550. |
| `tests/pagecheck.py` (create) | Stdlib HTML parsing helpers shared by the Python tests: `load_page()`, `sections()`, `find_all(tag, **attrs)`. |
| `tests/test_page.py` (create) | Static structural tests. |
| `tests/render.py` (create) | `dump_dom(query: str) -> str`: serves the repo on a free port, runs headless Chrome `--dump-dom`. It skips the test if Chrome is missing. |
| `tests/test_render.py` (create) | Rendered-DOM tests for Speaking, the strip and booking. |
| `tests/speaking.test.mjs` (create) | `node --test` unit tests for `assets/speaking.js`. |
| `.gitignore` (modify) | Add `.superpowers/`, `.taste-skill/`, `.impeccable/`. |
| `llms.txt`, `sitemap.xml` (modify) | Keep the descriptions of talks and workshops accurate. |

Commands used throughout:
- Python tests: `python3 -m unittest discover -s tests -v`
- Node tests: `node --test tests/`
- Local preview: `python3 -m http.server 8000` from the repo root, then open `http://localhost:8000/`

---

### Task 1: Guard rails (test harness on the current page)

**Files:**
- Create: `tests/pagecheck.py`, `tests/test_page.py`
- Modify: `.gitignore`
- Also commit: `docs/superpowers/specs/2026-10-23-homepage-revamp-design.md`, this plan

**Interfaces:**
- Produces:
  - `pagecheck.load_page() -> str`: the text of `index.html`.
  - `pagecheck.parse() -> Node`: a tiny tree built with `html.parser`. A `Node` has `.tag`, `.attrs` (dict), `.children`, `.parent` and `.text()`.
  - `pagecheck.find_all(root, tag=None, cls=None, **attrs) -> list[Node]`: `cls` matches one class token.
  - `pagecheck.ml_digest() -> str`: imports `scripts/ml_figures.py` with stub `numpy` and `regex` modules, then returns `sha256(json.dumps(read_page(index), sort_keys=True))[:16]`.

- [ ] **Step 1: Write the tests that must hold before and after the revamp**

`tests/test_page.py`, class `GuardRails(unittest.TestCase)`:
- `test_ml_source_text_unchanged`: `ml_digest() == open('assets/ml/source.sha').read().strip()`.
- `test_medium_markers_inside_list`: both markers are present, the text between them parses as `<li>` items, and the nearest element enclosing the start marker is `<ul class="list">`.
- `test_one_span_per_section`: every `<section>` has exactly one direct child with class `span`, and no `.span` exists outside a section.
- `test_images_have_dimensions_and_alt`: every `<img>` has non-empty `width` and `height`, and an `alt` attribute. It may be empty: the decorative Turkcell `logo-mark` uses `alt=""` today.
- `test_local_links_resolve`: every `href` or `src` that starts with `/` or has no scheme (ignoring `#…`, `mailto:` and `data:`) maps to an existing file or directory in the repo, where `/x/` means `x/index.html`.
- `test_talks_anchor_exists`: an element with `id="talks"` exists.

- [ ] **Step 2: Run on the current page and verify it passes**

Run: `python3 -m unittest discover -s tests -v`
Expected: all 6 PASS. These are guard rails. If one fails on the untouched page, fix the test, not the page.

- [ ] **Step 3: Add `.superpowers/`, `.taste-skill/` and `.impeccable/` to `.gitignore`, then commit**

```bash
git add .gitignore tests/ docs/superpowers/
git commit -m "Homepage revamp: design, plan and page guard-rail tests"
```

---

### Task 2: Wide frame, hero photo, icons in the link row

**Files:**
- Modify: `index.html`: the `.page` CSS, the top bar, `<header>`, and the `.links` CSS
- Create: `assets/photos/omar-gdd-istanbul.jpg`, copied from `/private/tmp/claude-501/-Users-omar6-Documents-Programming-omarcevi-github-io/274529d8-62ef-4bf0-a084-3aa045883dcf/scratchpad/photo/hero-4x5.jpg` (720×900, 174 KB)
- Test: `tests/test_page.py`

**Interfaces:**
- Produces:
  - An SVG sprite right after `<body>` with symbol ids `i-gh`, `i-li`, `i-md` (simple-icons paths, `fill="currentColor"`) and `i-mail`, `i-cal` (16×16 stroke icons, `stroke-width 1.5`, matching `.theme-toggle`). Later tasks use them as `<svg class="ic" aria-hidden="true"><use href="#i-…"/></svg>`.
  - CSS `.ic { width: 14px; height: 14px; flex: none; }`, and `.links a` becomes `inline-flex` with a `0.5rem` gap.
  - CSS class `.two` (two equal columns, `gap: 3rem`) and its modifier `.two.wide-left` (`1.35fr 1fr`). Both collapse to one column at ≤860px. Later tasks use them.

- [ ] **Step 1: Write the failing tests**

Class `Hero` in `tests/test_page.py`:
- `test_page_width_1120`: the CSS contains `.page { max-width: 1120px;`.
- `test_hero_photo`: an `<img>` with `src="assets/photos/omar-gdd-istanbul.jpg"`, `width="720"`, `height="900"` and alt `Omar Elcircevi speaking at Google for Developers Day Istanbul`. It is **not** lazy-loaded, because it's above the fold.
- `test_sprite_symbols`: `<symbol>` elements exist with ids `i-gh`, `i-li`, `i-md`, `i-mail`, `i-cal`.
- `test_nav`: the top-bar links in order are `#about`, `#experience`, `#speaking`, `#projects`, `#writing`, then a link with class `cta`, text `Book a call` and `href="#contact"`.
- `test_hero_links_have_icons`: in the header's `.links`, the hrefs in order are `#contact`, `mailto:hi@omarcevi.dev`, LinkedIn, GitHub, Medium, and each contains an `<svg class="ic">`.

- [ ] **Step 2: Run them and verify they fail**

Run: `python3 -m unittest tests.test_page.Hero -v`
Expected: 5 FAIL.

- [ ] **Step 3: Implement**

- `.page` gets `max-width: 1120px`.
- The header becomes a `.hero` grid, `minmax(0,1fr) 340px`, `gap: 3rem`, `align-items: end`.
  - Left column (`position: relative`): kicker, `h1`, tagline and `.gen`, unchanged and in that order. Then the link row: Book a call (primary, `i-cal`), the email (`i-mail`), LinkedIn, GitHub, Medium. Then the GDE badge, moved here from About.
  - Right column: `<figure>` with the photo (`border-radius: 14px; border: 1px solid var(--border)`) and a mono `.cap` figcaption: `Google for Developers Day Istanbul`.
- The simulator panel stays below the grid at full width.
- Top bar: add the `cta` pill (`.links a.primary` colours, mono, small). The nav label "Talks" becomes "Speaking" with `href="#speaking"`.
- At ≤860px, the photo stacks under the text, `max-width: 340px`.

- [ ] **Step 4: Run all Python tests**

Run: `python3 -m unittest discover -s tests -v`
Expected: all PASS, including `test_ml_source_text_unchanged`. `test_talks_anchor_exists` must still pass, because the Talks section is untouched until Task 3.

- [ ] **Step 5: Look at it**

Serve locally and check at 1440px and 390px, in light and dark:
- The GPT-2 token popup still appears next to the `h1`.
- The simulator fills the container.
- The photo crops cleanly.

- [ ] **Step 6: Commit**

```bash
git add index.html assets/photos/omar-gdd-istanbul.jpg tests/test_page.py
git commit -m "Homepage: widen to 1120px, hero photo, icons on links"
```

---

### Task 3: Speaking section markup and next-talk strip shell

**Files:**
- Modify: `index.html`: replace `<section id="talks">` (currently lines ~633–716), and insert the strip **inside `<header>`, right after the `.hero` grid and before `#simbox`**. The simulator lives in `<header>`.
- Test: `tests/test_page.py`

**Interfaces:**
- Produces (consumed by Task 4's JS):
  - `<section id="speaking">` with span `speaking.md`, and `<a id="talks"></a>` as its first child after the span. The span must stay the first `.span` child.
  - `<div class="up-card" id="up-card" hidden>`: an empty shell that Task 4 fills.
  - Two columns (`.two`): `<ul class="rows" id="talk-list">` under an `h3` "Talks", and `<ul class="rows" id="workshop-list">` under an `h3` "Workshops".
  - Each item is an `<li data-date="YYYY-MM-DD|YYYY-MM|YYYY">`. Optional attributes: `data-event`, `data-place`, `data-format`, `data-lang`, `data-url`. Inside it: the existing `.date`, `.item-title` and `.item-meta`, then materials as `<a class="tag">`.
  - The strip: `<div class="strip" id="strip">` full-bleed (`margin-inline: calc(50% - 50vw)`), inner `.strip-in` limited to 1120px, with `<span id="strip-next" hidden></span>` on the left and `<span id="strip-count"></span>` on the right.

Item data (dates from the page and the workshop guides):

| list | data-date | title | materials |
| --- | --- | --- | --- |
| talk | 2026-09 | Managing Agentic Systems on Google Cloud: From Deployment to Monitoring · Google Developer Day Istanbul | — |
| talk | 2026-04 | Build with AI: Gemini SDK & Cloud Run · 42 Türkiye | — |
| talk | 2026-04 | Build with AI: Google Antigravity · 42 Türkiye | — |
| talk | 2025-11 | Architecture of High Performance ML Solutions · GDG Baku | — |
| talk | 2023 | MLOps in the Age of GenAI · DevFest Istanbul | `▶ video` → https://www.youtube.com/watch?v=PKqyohMo4I8 |
| talk | 2023 | The Dark Side of ML: Exploring Vulnerabilities · DevFest Trabzon | `photos` → https://www.instagram.com/p/CzMdVHatqDF/ |
| workshop | 2026-10-27 | Deploying your agents on Google Cloud Agent Platform · Google Cloud Day Türkiye – Builder Connect; data-event `Google Cloud Day Türkiye – Builder Connect`, data-place `Istanbul, Wyndham Grand Levent`, data-format `in person`, data-lang `EN`, data-url `https://cloudonair.withgoogle.com/events/cloud-day-tr` | `guide` → /workshops/cloud-agents-workshop/, `repo` → https://github.com/omarcevi/cloud-agents-workshop |
| workshop | 2026-10-09 | Architecting Multi-Agent Systems with Google ADK · Google Developer Day Istanbul | `guide` → /workshops/adk-multi-agent-workshop/, `repo` → https://github.com/omarcevi/adk-multi-agent-workshop |
| workshop | 2026-08 | Gemma Train-the-Trainer: Running AI Models · Google Developer Experts | — |
| workshop | 2026-05 | Agentverse: Multi-Agent Systems with ADK, MCP and A2A (keep its existing description) | — |

No `slides.pdf` tags yet, because no PDFs exist. Never add a tag whose target doesn't exist.

- [ ] **Step 1: Write the failing tests**

Class `Speaking`:
- `test_speaking_section`: `section#speaking` exists, its span name is `speaking.md`, `#talks` sits inside it, and no `section#talks` remains.
- `test_item_dates`: every `li` in `#talk-list` and `#workshop-list` has a `data-date` matching `^\d{4}(-\d{2}(-\d{2})?)?$`. There are 6 talks and 4 workshops.
- `test_upcoming_needs_full_date`: every item whose `data-date` is a full date and on or after `2026-10-23` has `data-event`, `data-place`, `data-format`, `data-lang` and `data-url`.
- `test_no_js_fallback` (Review Focus 4): `#up-card` has the `hidden` attribute and no children, `#strip-next` has `hidden`, and the workshop dated `2026-10-27` appears in `#workshop-list` in the static HTML.
- `test_tags_are_links`: every `.tag` inside Speaking is an `<a>` with a non-empty `href` (local ones are already covered by `test_local_links_resolve`).

- [ ] **Step 2: Run them and verify they fail**

Run: `python3 -m unittest tests.test_page.Speaking -v`
Expected: 5 FAIL.

- [ ] **Step 3: Implement the markup and CSS**

- Strip styles: surface background, borders above and below, mono `0.8rem`. The `.soon` pill reuses `.tag` colours.
- Up-card styles: surface card, `grid-template-columns: 4.6rem 1fr auto`, date block with `--accent` header.
- The section heading is `Speaking`. The `h3` labels reuse the `.sub h3` style.

- [ ] **Step 4: Run all Python tests**

Run: `python3 -m unittest discover -s tests -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/test_page.py
git commit -m "Homepage: Speaking section with dated talks and workshops"
```

---

### Task 4: Upcoming/past logic (`assets/speaking.js`)

**Files:**
- Create: `assets/speaking.js`, `tests/speaking.test.mjs`, `tests/render.py`, `tests/test_render.py`
- Modify: `index.html`: add `<script src="assets/speaking.js" defer></script>` before `</body>`

**Interfaces:**
- Consumes: Task 3's ids, `data-*` attributes and `.tag` links.
- Produces (`window.Speaking`, and `module.exports` in Node):
  - `istanbulToday(now: Date) -> string`: `YYYY-MM-DD` in `Europe/Istanbul`, using `Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Istanbul'})`.
  - `periodEnd(date: string) -> string`: `'2026-10'` becomes `'2026-10-31'`, `'2023'` becomes `'2023-12-31'`, and full dates are returned unchanged.
  - `daysBetween(from: string, to: string) -> number`: whole days between two full ISO dates, computed in UTC.
  - `daysLabel(n: number) -> string`: `0` gives `'today'`, `1` gives `'tomorrow'`, otherwise `'in N days'`.
  - `partition(items: {date: string}[], today: string) -> {featured, upcoming, past}`:
    - An item is upcoming when it has a **full** date and `date >= today`. Partial dates are always past.
    - `featured` is the earliest upcoming item, or `null`.
    - `upcoming` is the rest of the upcoming items, earliest first.
    - `past` is sorted by `periodEnd` descending. The sort is stable, so ties keep source order.
  - `initSpeaking(doc: Document) -> void`. Today's date is the `?today=YYYY-MM-DD` query parameter when it is valid (test hook), otherwise `istanbulToday(new Date())`. Then:
    - It fills `#up-card` from the featured `li`: a date block (`MON` and day), the title, the meta line `event · place · format · lang`, a clone of the item's `.tag` links, and an `event page ↗` link to `data-url`. It removes `hidden` and removes the `li` from its list.
    - It moves other upcoming `li`s to the top of their list and appends `<span class="tag">upcoming</span>` to each.
    - It sets `#strip-next` to `next talk · {data-event} · {D Mon YYYY} · {daysLabel}` and unhides it. With no featured item, it shows `no talks scheduled · <a href="#contact">invite me to speak →</a>` instead.
    - It sets `#strip-count` to `{n} talks · {m} workshops`, counting **past items only**.
    - Month names are English three-letter abbreviations. The card shows them in capitals (`OCT`); the strip uses title case (`27 Oct 2026`).

- [ ] **Step 1: Write the failing Node tests** (`tests/speaking.test.mjs`, loaded with `createRequire`)

```js
test('istanbulToday uses Istanbul, not the local zone', () => {
  assert.equal(S.istanbulToday(new Date('2026-10-26T22:30:00Z')), '2026-10-27'); // 01:30 in Istanbul
  assert.equal(S.istanbulToday(new Date('2026-10-26T20:59:00Z')), '2026-10-26');
});
test('periodEnd', () => { assert.equal(S.periodEnd('2026-02'), '2026-02-28'); assert.equal(S.periodEnd('2023'), '2023-12-31'); });
test('daysLabel', () => { assert.equal(S.daysLabel(0), 'today'); assert.equal(S.daysLabel(1), 'tomorrow'); assert.equal(S.daysLabel(4), 'in 4 days'); });
test('event today is featured', () => {
  const r = S.partition([{date: '2026-10-27'}, {date: '2026-10-09'}], '2026-10-27');
  assert.equal(r.featured.date, '2026-10-27'); assert.equal(r.past.length, 1);
});
test('partial dates are past even in the current month', () => {
  assert.equal(S.partition([{date: '2026-10'}], '2026-10-01').featured, null);
});
test('second upcoming item goes to upcoming, earliest first', () => {
  const r = S.partition([{date: '2026-12-01'}, {date: '2026-11-02'}, {date: '2026-11-20'}], '2026-10-23');
  assert.deepEqual([r.featured.date, ...r.upcoming.map(i => i.date)], ['2026-11-02', '2026-11-20', '2026-12-01']);
});
test('past sorted newest first, ties stable', () => {
  const r = S.partition([{date: '2023', id: 'a'}, {date: '2026-04', id: 'b'}, {date: '2023', id: 'c'}, {date: '2026-04', id: 'd'}], '2026-10-23');
  assert.deepEqual(r.past.map(i => i.id), ['b', 'd', 'a', 'c']);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test tests/`
Expected: FAIL, "Cannot find module '../assets/speaking.js'".

- [ ] **Step 3: Implement the pure functions in `assets/speaking.js`**

ES5 style (`var`, `function`), wrapped in `(function (root) { … })(this)`. It exports with `module.exports = api` when `module` exists, otherwise `root.Speaking = api` plus `document.addEventListener('DOMContentLoaded', function () { api.initSpeaking(document); })`.

- [ ] **Step 4: Run the Node tests and verify they pass**

Run: `node --test tests/`
Expected: 7 PASS.

- [ ] **Step 5: Write the failing render tests**

`tests/render.py`:
- `dump_dom(query)` starts `http.server.ThreadingHTTPServer` on port 0 in a daemon thread, rooted at the repo.
- It runs `CHROME` (env var, default `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`) with `--headless=new --disable-gpu --virtual-time-budget=5000 --dump-dom http://127.0.0.1:{port}/index.html{query}`.
- It returns stdout. When the binary is missing it raises `unittest.SkipTest`.

`tests/test_render.py`, class `SpeakingRender`:
- `test_before_workshop` (`?today=2026-10-23`):
  - `#up-card` is not hidden and contains `Deploying your agents on Google Cloud Agent Platform`, `OCT`, `27`, `Istanbul, Wyndham Grand Levent · in person · EN`, an `href` of `https://cloudonair.withgoogle.com/events/cloud-day-tr`, and the guide and repo tags.
  - `#workshop-list` no longer contains that title.
  - `#strip-next` text is `next talk · Google Cloud Day Türkiye – Builder Connect · 27 Oct 2026 · in 4 days`.
  - `#strip-count` is `6 talks · 3 workshops`.
- `test_on_the_day` (`?today=2026-10-27`): the strip ends with `· today`.
- `test_after_workshop` (Review Focus 3, `?today=2026-10-28`):
  - `#up-card` still has `hidden`.
  - `#strip-next` contains `no talks scheduled` and a link to `#contact`, and no `NaN` appears anywhere in it.
  - `#strip-count` is `6 talks · 4 workshops`.
  - The workshop is the first `li` in `#workshop-list`.

- [ ] **Step 6: Run them and verify they fail**

Run: `python3 -m unittest tests.test_render -v`
Expected: 3 FAIL, because the script isn't included yet.

- [ ] **Step 7: Include the script and implement `initSpeaking`, then run everything**

Run: `node --test tests/ && python3 -m unittest discover -s tests -v`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add assets/speaking.js tests/ index.html
git commit -m "Homepage: upcoming talk card and next-talk strip from talk dates"
```

---

### Task 5: About and Experience in two columns

**Files:**
- Modify: `index.html`: `#about`, `#experience` and their CSS
- Test: `tests/test_page.py`

**Interfaces:**
- Consumes: `.two` and `.two.wide-left` from Task 2.

- [ ] **Step 1: Write the failing tests**

Class `AboutExperience`:
- `test_about_two_columns`: in `#about`, `.about-body` and `#att-fig` are both children of the same `.two` element, and `.about-body` comes first.
- `test_badge_moved`: there is no `.badge` inside `#about`, and exactly one `.badge` exists on the page, inside `<header>`.
- `test_community_list`: `#experience` contains an `h3` with the text `Community`. It is followed by a `ul.list` whose `.item-title` texts are exactly `Google Developer Expert, Cloud AI`, `Co-organizer, GDG Istanbul` and `Gemma Train-the-Trainer`, with `.item-meta` values `Google · 2026`, `Google Developer Groups` and `Google Developer Experts · 2026`. There is no Education heading.

- [ ] **Step 2: Run them and verify they fail**

Run: `python3 -m unittest tests.test_page.AboutExperience -v`
Expected: 3 FAIL.

- [ ] **Step 3: Implement**

- `#about`: span, then `h2`, then `#att-hint`, then a `.two` with `.about-body` and `#att-fig`.
- `.att-fig` loses its vertical margin inside the grid and gets `align-self: start`.
- `#experience`: a `.two.wide-left` with the existing timeline and the Community column.

- [ ] **Step 4: Run all tests and verify the attention overlay by eye**

Run: `python3 -m unittest discover -s tests -v` (expect all PASS, including the ML hash).

Then serve locally at 1440px. Hover the words in About and click a head square: the arcs must land on the words in the left column. Check again at 390px.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/test_page.py
git commit -m "Homepage: About and Experience side by side, Community column"
```

---

### Task 6: Projects showcase, and Writing with Open Source as one section

**Files:**
- Modify: `index.html`: `#projects`, `#writing`, `#oss` and the card CSS
- Create: `assets/projects/tensorhane.jpg`, copied from `.superpowers/brainstorm/62016-1792758504/content/tensorhane.jpg` (880×550)
- Test: `tests/test_page.py`

**Interfaces:**
- Produces: CSS `.feat2` (two columns), `.grid4` (four columns at desktop, two at ≤860px, one at ≤640px), and `.card` as a flex column with its chips pushed to the bottom (`margin-top: auto`).
- Card images: `.card img { width: 100%; height: auto; aspect-ratio: 16 / 10; object-fit: cover; }`. **`height: auto` is required.** The `height` attribute otherwise stretches the image; this bug showed up in the mockup.

- [ ] **Step 1: Write the failing tests**

Class `ProjectsWriting`:
- `test_featured_pair`: `.feat2` holds exactly two `article.card`, whose `.name` texts are `tensorhane.com` and `sdlc-agent-pipeline`, in that order.
  - The tensorhane card's `.label` is `Live · rising` and its `.what` is `Learn machine learning by writing it, in Turkish`.
  - Its chips are `Python`, `NumPy`, `Triton`, `Türkçe`.
  - Its `img` `src` is `assets/projects/tensorhane.jpg`, with `width="880"` and `height="550"`.
  - Its `.name` link points to `https://tensorhane.com`.
- `test_grid_of_four`: `.grid4` holds four `article.card`, with names `vllm-metal-bench`, `triton-beginner-demo`, `augury`, `claude-caps`. Each card's `img` comes before its text.
- `test_card_img_css`: the CSS rule for `.card img` contains both `height: auto` and `aspect-ratio: 16 / 10`.
- `test_writing_oss_merged`: `section#writing` exists, its `h2` text is `Writing & Open Source`, it holds the Medium markers and both ADK PR links, and there is no `section#oss`.
- `test_span_names_final`: the span names, in order, are `['about.md','experience.md','speaking.md','projects.md','writing.md','contact.md']`.

- [ ] **Step 2: Run them and verify they fail**

Run: `python3 -m unittest tests.test_page.ProjectsWriting -v`
Expected: 5 FAIL.

- [ ] **Step 3: Implement**

- `#projects`: the agent-replay panel and caption stay as they are. Below them go `.feat2`, then `.grid4`.
  - Reuse the existing card copy and chips.
  - The tensorhane description is the spec's sentence: "Short lessons and coding problems in Python, with interactive demos of gradient descent, BPE tokenization, attention and the KV cache. ML foundations are open now; LLM internals and writing an LLM from scratch are next."
- `#writing`: one span (`writing.md`), the `h2` `Writing & Open Source`, then a `.two` with two columns.
  - Left: the `h3` Writing, the `ul.list` with the Medium markers, and "All posts on Medium →".
  - Right: the `h3` Open source and its list.
  - Delete `#oss`.

- [ ] **Step 4: Run all tests, and check the trace panel by eye**

Run: `python3 -m unittest discover -s tests -v`
Expected: all PASS.

Then serve locally and scroll to the bottom. The trace panel should list 6 rows, and clicking `writing.md` should jump to the merged section.

- [ ] **Step 5: Commit**

```bash
git add index.html assets/projects/tensorhane.jpg tests/test_page.py
git commit -m "Homepage: projects showcase with tensorhane, Writing & Open Source merged"
```

---

### Task 7: Book a call (inline Google booking page)

**Files:**
- Modify: `index.html`: `#contact` and its CSS
- Test: `tests/test_page.py`, `tests/test_render.py`

**Interfaces:**
- Consumes: the sprite icons and `.two` from Task 2.
- Produces:
  - `<section id="contact" class="contact">`, span `contact.md`, `h2` `Book a call`.
  - A `.two` with two columns:
    - Left: the paragraph "I'm open to collaborations: talks and workshops, open-source work, and teams figuring out how to serve models or agents in production. Pick a slot, or just write to compare notes on inference at scale.", then the `.links` pills with icons (email primary, LinkedIn, GitHub, Medium).
    - Right: `<div class="booking">` containing `<iframe class="booking-frame" src="{BOOKING_URL}" title="Book a 30-minute call with Omar" loading="lazy" style="border:0" width="100%" height="600"></iframe>`, then `<a class="booking-link" href="{BOOKING_URL}" target="_blank" rel="noopener">Open the booking page ↗</a>` outside the iframe.
  - The URL appears in the HTML as written, so there's no JS dependency. The spec's "one constant" is the iframe's `src`. *(Plan decision: static markup beats a JS constant for no-JS visitors. The mailto fallback is only needed if the URL is removed; that is covered by the spec and no code is needed now.)*

- [ ] **Step 1: Write the failing tests**

Class `Booking` (static):
- `test_iframe`: exactly one `iframe.booking-frame`, whose `src` equals the Global Constraints URL verbatim and which has a non-empty `title` and `loading="lazy"`.
- `test_fallback_link` (Review Focus 5): `a.booking-link` has the same `href`, is not inside the iframe, and its text is `Open the booking page ↗`.
- `test_book_a_call_targets`: every `<a>` whose text (ignoring the icon) is `Book a call` has `href="#contact"`, and there are at least two (nav and hero). The `h2` is not a link.

Render test `test_booking_rendered` (`?today=2026-10-23`): the dumped DOM contains the iframe `src`.

- [ ] **Step 2: Run them and verify they fail**

Run: `python3 -m unittest tests.test_page.Booking tests.test_render -v`
Expected: the Booking tests FAIL.

- [ ] **Step 3: Implement**

- The iframe sits in a frame with `border: 1px solid var(--border)`, `border-radius: 12px`, `overflow: hidden` and a `#fff` background, because Google's page is light in both themes.
- The trace panel stays after this section.

- [ ] **Step 4: Run all tests**

Run: `node --test tests/ && python3 -m unittest discover -s tests -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/
git commit -m "Homepage: Book a call with the inline Google booking page"
```

---

### Task 8: Metadata, contrast and the final look

**Files:**
- Modify: `index.html` (tokens, the JSON-LD `dateModified`, the footer "Last updated"), `llms.txt`, `sitemap.xml`
- Test: `tests/test_page.py`

- [ ] **Step 1: Write the failing tests**

Class `Meta`:
- `test_llms_txt`:
  - It contains `Architecting Multi-Agent Systems with Google ADK (workshop) — Google Developer Day, October 2026`.
  - It contains `Deploying your agents on Google Cloud Agent Platform (workshop) — Google Cloud Day Türkiye, October 2026`.
  - It contains a `Book a call:` line with the booking URL.
- `test_faint_contrast`: parse `--faint` and `--bg` from the light `:root` block and from both dark blocks. Assert that the WCAG contrast ratio of `--faint` against `--bg` is **≥ 4.5** in each block, and that the two dark blocks agree. Pick the closest greys that pass, staying lighter than `--muted` in light mode and darker than it in dark mode, so the hierarchy is kept.
- `test_date_modified`: the JSON-LD `dateModified` is `2026-10-23` or later.

- [ ] **Step 2: Run them and verify they fail, then implement**

Run: `python3 -m unittest tests.test_page.Meta -v` (expect FAIL). Then make the edits. In `sitemap.xml`, set `<lastmod>` for `/` to the same date.

- [ ] **Step 3: Run the whole suite**

Run: `node --test tests/ && python3 -m unittest discover -s tests -v`
Expected: all PASS.

- [ ] **Step 4: Look at every width, in both themes**

Serve locally and screenshot `index.html?today=2026-10-23` with headless Chrome at 1440×900, 768×1024 and 390×844, full page, in light (`data-theme="light"`) and dark. Check:
- There's no horizontal scroll at 390px.
- Every two-column section is a single column at 768px and 390px.
- The strip runs edge to edge while its text lines up with the container.
- The four project thumbnails are identical 16:10 frames.
- The booking iframe isn't clipped.
- The trace panel works.

Fix anything visible, then re-run the suite.

- [ ] **Step 5: Commit**

```bash
git add index.html llms.txt sitemap.xml tests/test_page.py
git commit -m "Homepage revamp: metadata, contrast, final layout pass"
```

Merging to `main` deploys to omarcevi.dev, and the ML figures workflow then runs. Confirm with Omar before opening the PR.
