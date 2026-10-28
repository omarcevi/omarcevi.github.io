# Events

The talks and workshops in the Speaking section of omarcevi.dev. Commit a change
to this file and the site updates itself a minute or two later
(`.github/workflows/events.yml` runs `scripts/update_events.py`).

One block per event: a `## Title` line, then `- key: value` lines.

- `type`: talk or workshop (required)
- `date`: 2026-10-27, or 2026-10 / 2023 when the day doesn't matter (required)
- `event`: the event's name (required when the date has a day)
- `place`, `link` (the event's page), `lang` (EN, TR), `format` (in person, online)
- `guide`, `repo`, `video`, `slides`, `photos`: links shown as tags under the title
- `about`: one sentence shown under the title

Order doesn't matter: the site lists newest first, and the next event with a full
date becomes the "next up" card. If an entry has a mistake, the update stops,
nothing on the site changes, and GitHub emails you the reason.

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

## Build with AI: Gemini SDK & Cloud Run
- type: talk
- event: 42 Türkiye
- date: 2026-04

## Build with AI: Google Antigravity
- type: talk
- event: 42 Türkiye
- date: 2026-04

## Architecture of High Performance ML Solutions
- type: talk
- event: GDG Baku
- date: 2025-11

## MLOps in the Age of GenAI
- type: talk
- event: DevFest Istanbul
- date: 2023
- video: https://www.youtube.com/watch?v=PKqyohMo4I8

## The Dark Side of ML: Exploring Vulnerabilities
- type: talk
- event: DevFest Trabzon
- date: 2023
- photos: https://www.instagram.com/p/CzMdVHatqDF/
