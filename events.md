# Events

The talks and workshops in the Speaking section of omarcevi.dev. Commit a change
to this file and the site updates itself a minute or two later
(`.github/workflows/events.yml` runs `scripts/update_events.py`).

One block per event: a `## Title` line, then `- key: value` lines.

- `type`: talk or workshop (required)
- `date`: 2026-10-27, or 2026-10 / 2023 when the day doesn't matter (required)
- `event`: the event's name (required when the date has a day)
- `place`, `link` (the event's page), `lang` (EN, TR), `format` (in person, online)
- `tickets`, `guide`, `repo`, `video`, `slides`, `photos`: links shown as tags under the title
- `about`: one sentence shown under the title

Order doesn't matter: the site lists newest first, and the next event with a full
date becomes the "next up" card. If an entry has a mistake, the update stops,
nothing on the site changes, and GitHub emails you the reason.

## Retrieval Is All You Need (Almost)
- type: talk
- event: DevFest İzmir 2026
- date: 2026-12-05
- place: İzmir, Tepekule Congress Center, Bayraklı
- link: https://gdg.community.dev/events/details/google-gdg-izmir-presents-devfest-izmir-2026/cohost-gdg-cloud-izmir
- tickets: https://kommunity.com/gdg-izmir/events/devfest-izmir-2026-16cae32b
- format: in person

## Recipes for Your Agent Systems
- type: workshop
- event: DevFest Trabzon 2026
- date: 2026-10-31
- place: Trabzon, Prof. Dr. Osman Turan Congress Center, KTÜ
- link: https://gdg.community.dev/events/details/google-gdg-trabzon-presents-devfest-trabzon-2026/
- guide: /workshops/match-day-agents/
- repo: https://github.com/omarcevi/trabzonspor_analyst
- format: in person

## Deploying your agents on Google Cloud Agent Platform
- type: workshop
- event: Google Cloud Day Türkiye – Builder Connect
- date: 2026-10-27
- place: Istanbul, Wyndham Grand Levent
- link: https://cloudonair.withgoogle.com/events/cloud-day-tr
- format: in person
- lang: EN
- guide: /workshops/cloud-agents-workshop/
- repo: https://github.com/omarcevi/cloud-agents-workshop

## Deploy your first AI agent to Google Cloud
- type: workshop
- event: DevFest Samsun 2026
- date: 2026-10-24
- place: Samsun, Colombia Coffee Ömürevleri
- link: https://kommunity.com/gdg-samsun/events/devfest-samsun-2026-1057d7ef
- format: in person
- lang: EN
- guide: /workshops/devfest-samsun-agent/
- repo: https://github.com/omarcevi/devfest-samsun-assistant

## Architecting Multi-Agent Systems with Google ADK
- type: workshop
- event: Google Developer Day Istanbul
- date: 2026-10-09
- guide: /workshops/adk-multi-agent-workshop/
- repo: https://github.com/omarcevi/adk-multi-agent-workshop

## Managing Agentic Systems on Google Cloud: From Deployment to Monitoring
- type: talk
- event: Google Developer Day Istanbul
- date: 2026-09

## Gemma Train-the-Trainer: Running AI Models
- type: workshop
- event: Google Developer Experts
- date: 2026-08

## Agentverse: Multi-Agent Systems with ADK, MCP and A2A
- type: workshop
- date: 2026-05
- about: A team of research, judge and builder agents talking over A2A, with a self-hosted Gemma model on Cloud Run GPUs.

## Build with AI: Google Antigravity
- type: talk
- event: 42 Türkiye
- date: 2026-04-25

## Build with AI: Vertex AI Studio
- type: talk
- event: 42 Türkiye
- date: 2026-04-18

## Build with AI: Build a Gemini-Powered YouTube Summarizer with the GenAI SDK
- type: talk
- event: 42 Türkiye
- date: 2026-04-11

## Vapurda Tech Talk 2025
- type: talk
- event: GDSC Marmara
- date: 2025
- photos: https://www.instagram.com/p/DSJzQRmDYa2/

## Architecture of High Performance ML Solutions
- type: talk
- event: GDG Baku
- date: 2025-11-22

## How AI Agents Can Save You: Google Agent Development Kit Demo
- type: talk
- event: GDG Istanbul – Build with AI Extended
- date: 2025-05-17
- place: Istanbul, Trendyol Campus
- link: https://gdg.community.dev/events/details/google-gdg-istanbul-presents-build-with-ai-extended-1/

## Supercharging AI Agents with Gemini 2.0
- type: workshop
- event: GDG Istanbul – Build with AI
- date: 2025-02-27
- place: Istanbul, Google Istanbul Office
- link: https://gdg.community.dev/events/details/google-gdg-istanbul-presents-supercharging-ai-agents-with-gemini-20-a-hands-on-workshop/

## Vapurda Tech Talk 2024
- type: talk
- event: GDSC Marmara
- date: 2024
- photos: https://www.instagram.com/p/DDM_0NWgiXV/

## The Dark Side of ML: Exploring Vulnerabilities in ML Systems
- type: talk
- event: DevFest Trabzon 2023
- date: 2023
- photos: https://www.instagram.com/p/CzMdVHatqDF/

## MLOps in the Age of GenAI
- type: talk
- event: DevFest Izmir 2023
- date: 2023-12
- photos: https://www.instagram.com/p/CzEh2MAMk6B/

## MLOps in the Age of GenAI
- type: talk
- event: DevFest Istanbul 2023
- date: 2023-11-26
- place: Istanbul, UNIQ Istanbul
- video: https://www.youtube.com/watch?v=PKqyohMo4I8&t=928s

## Machine Learning Event
- type: talk
- event: GDSC Sabancı
- date: 2023-11
- photos: https://www.instagram.com/p/CzT_LVKt2Vp/

## MLOps in the Age of GenAI
- type: talk
- event: DevFest Kocaeli 2023
- date: 2023-11-04
- place: Kocaeli, Kocaeli Kongre Merkezi
- photos: https://www.instagram.com/p/CzJqZuHN2bi/

## TensorFlow Applications
- type: talk
- event: GDG Samsun – Talk About ML
- date: 2023-08-20
- video: https://www.youtube.com/live/7eqp89f7GiA

## TensorFlow Workshop: Cloud Computer Vision
- type: workshop
- event: GDSC Marmara
- date: 2023-05-20
- video: https://www.youtube.com/live/Q5DB-fs1lkU

## Beyond ML Notebook
- type: talk
- event: GDG Istanbul
- date: 2023-03-18
- place: Istanbul, Zemin İstanbul
- link: https://gdg.community.dev/events/details/google-gdg-istanbul-presents-flutter-mobil-gelistirme-yapay-zeka-uclusu/

## TensorFlow Workshop 2: Computer Vision and CNNs
- type: workshop
- event: GDSC Bilkent
- date: 2022-12-31
- video: https://www.youtube.com/live/MzlWHu2D1z4

## But What Is TensorFlow?
- type: talk
- event: GDSC Üsküdar & GDSC 29 Mayıs
- date: 2022-12-30
- video: https://www.youtube.com/live/5llTde9TLdA

## TensorFlow Workshop 1: Intro to TensorFlow
- type: workshop
- event: GDSC Bilkent
- date: 2022-12
- video: https://youtu.be/TPJp42fF12I
