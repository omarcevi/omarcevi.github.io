# Homepage revamp: wider layout, Speaking, projects showcase, booking

Date: 2026-10-23 · Status: approved by Omar for planning (2026-10-23)

## Intent

omarcevi.dev is a personal portfolio: a quiet, developer-flavoured page (Geist plus Geist Mono labels, thin dividers, the per-section reading trace) built around three live ML demos. Speaking now matters as much as engineering, and the page should serve four visitors:

- event organisers checking what Omar talks about and where Omar has spoken
- workshop attendees coming back for the guide, repo or slides
- recruiters
- people who want to collaborate

Today the page is a 712px column with a lot of empty space on each side. Talks are a plain list, mostly without links. Only two workshops link to anything, and nobody can book time.

bgo.dev is the reference for **structure**, not looks. It uses a roughly 1050px container whose sections split into side-by-side columns, has a "next talk" strip, gives each talk its materials, and has a "Book a call" action.

## Goals

1. Use the width. The content container goes from 760px to **1120px** (with the same 1.5rem gutter), and the extra space is spent on side-by-side columns.
2. Add a **Speaking** section that replaces "Talks & Workshops". It has an upcoming talk, past talks and workshops, and each item carries its materials (slides PDF, recording, guide, repo).
3. Talks **move from Upcoming to Past by themselves** once their date passes, with no edit needed after the event.
4. Add a **"Book a call"** path using an embedded Google Calendar appointment-schedule booking page.
5. A **projects showcase with thumbnails**, including tensorhane.com.
6. A photo of Omar in the hero.
7. Icons on the social and contact links.

## Non-goals

- No move away from GitHub Pages, no build step, no framework. It stays one hand-written `index.html`.
- No CMS or form for adding talks. Talks are added by editing HTML.
- No cutout or background removal of the photo for now (see Later).
- No new favicon in this round (see Later).
- No bilingual (TR) version, no year filter, no references or testimonials section.

## Anti-goals (a failure even if it works)

- **It must not look like a marketing landing page.** A first mockup was rejected for exactly this. That mockup had a giant full-width name, full-colour accent bands, poster-size type and huge contact rows. Keep the current visual language: Geist and Geist Mono, `--accent` used sparingly, thin and dashed dividers, mono labels, dark demo panels, the `read <name>.md` spans, and the trace panel.
- The design-taste skill's house rules (no monospace, no hairlines and so on) do **not** apply to this site.
- Don't break the live demos or the scripts and workflows that parse the page.

## Constraints from the codebase

- `scripts/ml_figures.py` (run by `.github/workflows/ml-figures.yml` on push to main) parses `index.html` with regexes:
  - `<h1 id="name"…>…</h1>`
  - `<p id="tagline"…>…</p>` containing a `<strong>`
  - `<div class="about-body…">…</div>`, with the about text as plain `<p>` paragraphs before the first `</div>`

  These must keep the same shape. **Do not change the hero name, the tagline or the About paragraph text**, because the GPT-2 figures are computed from them. Moving elements around is fine.
- `scripts/update_medium.py` (daily workflow) rewrites only the lines between `<!-- MEDIUM:START -->` and `<!-- MEDIUM:END -->`, emitting `<li><div class="item-title">…</div><div class="item-meta">…</div></li>`. Keep the markers and a parent `<ul class="list">` that this markup styles correctly.
- The reading trace (`index.html` around line 1510) builds its rows from every `.span` element and its `.sp-name`. One span per section, and the span names are what the trace shows.
- The attention overlay (`.att-svg`) is absolutely positioned over `.about-body`, and the arcs are drawn between word positions measured at runtime. It has to keep working when the attention figure sits in a column beside the text.
- Both themes: the light and dark tokens in `:root`, `:root[data-theme]` and the OS media query all stay in sync.
- The phone layout (≤640px today) must stay a clean single column. Every two-column split collapses to one.

## Decided layout (top to bottom)

The approved mockup is `.superpowers/brainstorm/62016-1792758504/content/wide-v4.html`. It's a reference for structure, not code to copy.

1. **Top bar:** as today, inside the 1120px container. Nav: About · Experience · Speaking · Projects · Writing, plus a small primary pill **"Book a call"** linking to `#contact`. The theme toggle stays.
2. **Hero:** two columns.
   - Left: kicker, `h1`, tagline (all unchanged), then a link row: **Book a call** (primary, calendar icon), email (envelope icon), LinkedIn, GitHub, Medium (brand icons). Under that, the GDE badge, moved up from About.
   - Right: **the talk photo** (`/Users/omar6/Downloads/Photos-1-001/ARI02867.jpg`, 4500×3000). It's a portrait crop around Omar at the podium, resized for the web and saved in `assets/`, with rounded corners matching the panels. Optional mono caption: "Google for Developers Day Istanbul".
3. **Next-talk strip:** a full-bleed band (surface background, top and bottom border), with content inside the container.
   - Left: `next talk · <event> · <date> · in N days`. N is computed by JS.
   - Right: counts of talks and workshops, computed from the Speaking lists.
   - With no upcoming talk, the strip hides, or shows an invitation to book. This is the builder's call.
4. **Inference simulator:** full container width, otherwise unchanged. The canvas already resizes.
5. **About:** two columns. Left: the three paragraphs, unchanged. Right: the attention figure.
6. **Experience:** two columns, about 1.35fr : 1fr.
   - Left: the existing timeline.
   - Right: a new **Community** list: Google Developer Expert, Cloud AI (2026); Co-organizer, GDG Istanbul; Gemma Train-the-Trainer (2026).
   - Education is pending Omar's answer and stays out until Omar answers.
7. **Speaking** (span `speaking.md`):
   - An upcoming-talk card across the full width: a date block, title, `event · city · format · language`, and an event-page link.
   - Then two columns: **Talks** on the left and **Workshops** on the right, both in the existing `.rows` style. Each item's materials are `.tag` pills: `slides.pdf`, `▶ video`, `guide`, `repo`.
   - Known material links:
     - MLOps in the Age of GenAI → YouTube recording
     - The Dark Side of ML → Instagram post
     - Deploying your agents on Google Cloud Agent Platform → guide `/workshops/cloud-agents-workshop/`, repo `https://github.com/omarcevi/cloud-agents-workshop`
     - Architecting Multi-Agent Systems with Google ADK → guide `/workshops/adk-multi-agent-workshop/`, repo `https://github.com/omarcevi/adk-multi-agent-workshop`
   - Other materials appear only when the file or link exists. Never show a dead tag.
   - **Slides:** Omar exports them from Google Slides as PDF. They live in the repo under `assets/slides/<yyyy-mm>-<slug>.pdf` and are linked directly.
8. **Projects** (span `projects.md`):
   - The agent replay panel at full container width, as today.
   - Then **two featured cards side by side**:
     - **tensorhane.com**: label "Live · rising", "Learn machine learning by writing it, in Turkish", Python · NumPy · Triton · Türkçe. The thumbnail is a screenshot of tensorhane.com without the cookie banner.
     - **sdlc-agent-pipeline**: the existing featured content.
   - Then **one row of four equal cards**: vllm-metal-bench, triton-beginner-demo, augury, claude-caps.
   - Every card has a 16:10 thumbnail on top, and its chips sit at the bottom of the card. **Image CSS must set `height: auto`** together with `aspect-ratio`, otherwise the `height` attribute on `<img>` stretches the thumbnail. That bug showed up in the mockup.
9. **Writing & Open Source:** **one section with one span** (`writing.md`) and one `h2` "Writing & Open Source", in two columns. Left is Writing, the Medium list between its markers plus "All posts on Medium →". Right is Open source, the two ADK PRs. The old `oss.md` span goes away.
10. **Book a call** (`#contact`, span `contact.md`): two columns.
    - Left: the existing collaboration paragraph, adjusted to invite booking, and the link pills with icons.
    - Right: the **Google Calendar appointment-schedule booking page** in an `<iframe>`. Google's "website embed → inline booking page" snippet gives a `calendar.google.com/calendar/appointments/schedules/…?gv=true` URL.
    - Fallback: a plain link to the booking page if the iframe can't load, or if there's no JS.
11. **Trace panel and footer:** unchanged, at the new width.

## Icons

Brand icons (LinkedIn, GitHub, Medium) come from simple-icons paths, and the email and calendar icons are simple stroke icons in the style of the theme toggle. They go **inline in an SVG sprite** (`<symbol>` plus `<use>`), with no icon library and no network request. They use `currentColor` and are about 14px inside the pills.

## Upcoming vs. past (behaviour)

- Each talk and workshop carries a machine-readable date (for example `data-date="2026-10-27"`).
- On load, JS compares each date with today's date in Istanbul time. Items dated today or later are upcoming.
- *(my call)* **Featured item:** the earliest upcoming item fills the upcoming card and the strip, and is **removed from its column** so it isn't listed twice.
  - The card carries that item's **material tags** (guide, repo, slides) as well as the event link, so workshop attendees have the guide in the days before the event and on the day itself.
- *(my call)* **Other upcoming items:** they stay at the top of their own column, earliest first, each with an `upcoming` tag. Past items follow, newest first.
- *(my call)* **Strip counts:** they count only past items ("6 talks · 4 workshops" means given).
- Without JS, all items render as static lists in their columns, and nothing is hidden.
- **Known now:** "Deploying your agents on Google Cloud Agent Platform", Google Cloud Day Türkiye – Builder Connect, **Tue 27 Oct 2026** (per its guide), is upcoming. Its details:
  - Where: Istanbul, Wyndham Grand Levent
  - Format: in person
  - Language: EN
  - Event page: https://cloudonair.withgoogle.com/events/cloud-day-tr

  It Under these rules it becomes the featured card until 28 Oct. "Architecting Multi-Agent Systems with Google ADK" is **Fri 9 Oct 2026** (per its guide). `llms.txt` wrongly says September, so fix it.

## Booking

Omar has a Google Calendar appointment-schedule booking page. Google offers two embeds:
- **The inline booking page:** an `<iframe>`. **This is the one to use.** It is what the design shows, and it needs no third-party script.
- A popup button: this loads Google's `scheduling-button-script.js`. Don't use it.

The booking URL lives in **one constant** in the page script, the `src` of the inline embed:
`https://calendar.google.com/calendar/appointments/schedules/AcZssZ0eb5WUAIpBMx4QPBcHLYvEkpsTizdL89jBUa6UXEfyqFAB_blGgZgBPyEFoXzoag5z6xWIRzHT?gv=true`
(Google's snippet uses `height="600"`, `width="100%"`, `border: 0`.)
- The "Book a call" pills in the nav and hero go to `#contact`, where the calendar sits.
- Under the iframe there is a plain "Open the booking page ↗" link that opens in a new tab.
- *(my call)* If the constant is ever empty, the pills open `mailto:hi@omarcevi.dev` with the subject "Booking a call", and the iframe column is replaced by a short line inviting an email. Nothing links to a dead page.

## Anchors and script hooks to keep

- `/#talks` is linked from the workshop guide breadcrumbs and from `scripts/build_deploy_agents_guide.py`. Keep an element with `id="talks"` at the Speaking section (for example, an extra anchor) so those links still land.
- Each `.span` stays a direct child of its `<section>`. The trace uses `parentNode` as the section and matches nav links by the section's id.
- The hero column that holds the `h1` needs `position: relative`, because the GPT-2 token popup is positioned relative to `h1.parentNode`.
- The GPT-2 metrics line (`.gen`) stays directly under the tagline.

## Left to the builder

- Exact CSS breakpoints (two columns collapse to one at roughly ≤860px), spacing and the hero photo crop.
- Whether the upcoming card sits inside Speaking only, or is also mirrored in the strip as designed.
- Photo format and size (keep it under ~250 KB, with `width`, `height`, alt text and lazy-loading rules like the other images).
- `llms.txt`, `sitemap.xml` and JSON-LD `dateModified`: update anything that describes talks and workshops so it stays accurate.
- Contrast: the existing `--faint` mono labels are below WCAG AA in places. Bump them while you're in there, without changing the look.

## Inputs needed from Omar (placeholders until then)

- **Which talks have slide PDFs**, and the files.
- The repo for Agentverse, if any.
- Education: include it or not.

## Later (out of scope now)

- A transparent cutout of the photo. Omar paused this. A local macOS Vision script was started in the scratchpad and not run.
- A new "cute" favicon. Show options side by side first.
