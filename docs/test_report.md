# Test report

Generated 2026-11-15 03:37 (Europe/Berlin). All runs in test mode: max 10 companies, no email to a real company.

Mode: **mock services** (`MOCK_EXTERNAL=true`, real n8n 1.123.5 in Docker, external APIs from `tests/mock_server`). Live runs against the real services need the steps in `docs/blockers.md`.

## Summary

| Level | Tool | Passed | Failed | Result |
| --- | --- | --- | --- | --- |
| 1 Unit (JS) | Jest | 416 | 0 | Pass – line coverage on `code/` 98.45% (min 80%) |
| 1 Unit (Python) | pytest | 14 | 0 | Pass |
| 2 Workflow | run_module.py | 20 modules | 0 modules | Pass |
| 3 Integration | run_integration.py | 6 | 0 | Pass |
| 3 Failure | run_integration.py | 6 | 0 | Pass |
| 3 Safety | run_integration.py | 4 | 0 | Pass |
| 4 End-to-end (mock) | run_e2e.py | 2 runs | 0 runs | Pass (twice in a row: True) |
| 4 End-to-end (live) | run_e2e.py --live | – | – | Not run – blocked (docs/blockers.md) |

## Level 2 – workflow tests (one per module)

| Module | Checks | Result | Seconds |
| --- | --- | --- | --- |
| 00 error handler / Google 500 → 3 retries → Slack | 6/6 | Pass | 14.0 |
| 01 campaign setup form | 12/12 | Pass | 35.9 |
| 02 lead sourcing | 29/29 | Pass | 32.7 |
| 03 enrichment | 24/24 | Pass | 17.2 |
| 04 AI emails + Campaign ready | 18/18 | Pass | 14.3 |
| 05 campaign launch | 9/9 | Pass | 13.6 |
| 06 sending and follow-ups | 13/13 | Pass | 24.0 |
| 07 reply sorting (all fixtures) | 85/85 | Pass | 68.0 |
| 07b Calendly | 9/9 | Pass | 11.7 |
| 07c reminders | 4/4 | Pass | 3.8 |
| 07d Calendly poll (free plan) | 6/6 | Pass | 15.3 |
| 07 newsletter / notification without a lead → stored, no Slack noise | 4/4 | Pass | 3.8 |
| 07 lead says no after showing interest → meeting cancelled, HubSpot deal Closed lost | 19/19 | Pass | 50.4 |
| 08 reporting | 8/8 | Pass | 3.4 |
| 08b live dashboard | 6/6 | Pass | 0.2 |
| 09 inbound lead | 9/9 | Pass | 7.5 |
| 10 CRM sync | 8/8 | Pass | 7.6 |
| 11 Slack buttons | 10/10 | Pass | 67.0 |
| 12 GDPR delete | 5/5 | Pass | 4.1 |
| 16 Control Center: login, clients, campaign create/launch/pause, leads, replies | 26/26 | Pass | 41.8 |

## Level 3 – integration

| Scenario | Checks | Result |
| --- | --- | --- |
| I1 sourcing chain (Modules 1–4): form → 'Campaign ready', no clicks | 4/4 | Pass |
| I2 launch chain (Modules 5–6): Approve and launch → 4 [TEST] emails in one thread | 4/4 | Pass |
| I3 reply chain (7, 10, 11): interested → auto answer → booking → Meeting booked + HubSpot deal | 3/3 | Pass |
| I4 unsure reply: Slack buttons → click Interested → same result as I3 | 4/4 | Pass |
| I5 inbound chain (9, 10): quiz → call task + Slack brief within 1 minute | 2/2 | Pass |
| I6 stop rules: reply after email 1 stops 2–4; STOP → Blocklist and a new campaign skips it | 4/4 | Pass |

## Level 3 – failure

| Scenario | Checks | Result |
| --- | --- | --- |
| 00 error handler / Google 500 → 3 retries → Slack | 6/6 | Pass |
| F2 AI returns broken JSON → one retry → Needs review | 3/3 | Pass |
| F3 Airtable 429 → wait and retry, no lost records | 3/3 | Pass |
| F4 Gmail / Slack credential expired → error handler posts with the workflow name | 3/3 | Pass |
| 07b Calendly | 9/9 | Pass |
| F6 re-run on the same campaign → no duplicate leads, emails or deals | 4/4 | Pass |

## Level 3 – safety

| Scenario | Checks | Result |
| --- | --- | --- |
| S1 an email addressed to a real company is blocked by the guard and the run stops | 5/5 | Pass |
| S2 DEMO_MODE: every sent email starts with [TEST] and goes to the test inbox; the company inbox gets nothing | 4/4 | Pass |
| S3 Google requests follow Max leads: 10 (or empty = TEST_LEAD_LIMIT 10) → exactly 1 request, no paging | 2/2 | Pass |
| S4 no secret appears in any file in workflows/ (scan also in GitHub Actions) | 2/2 | Pass |

## Level 4 – end-to-end (mock services)

- Run 1: Pass – clicks 3, form → 'Campaign ready' 8.7 s, whole flow 68.2 s
- Run 2: Pass – clicks 3, form → 'Campaign ready' 8.6 s, whole flow 33.6 s

## Live run on the real services (test mode)

- Form → "Campaign ready": 74 s, 1 Google request, AI cost €0.0062
- 9 leads · email found 8/9 · director 7/9 · approved 6 (quality 90-100)
- Rejected: score 35 below 50 (info@ only, no director): 1; no Impressum page found: 1; duplicate contact (same director + address): 1
- Approved emails: 24/24 pass: greeting, sign-off with sender, real line breaks, legal footer, Sie-form, no '!', quality>=80, offer logic
- Live service checks: Gmail guarded send delivered; Slack bot + alert webhook + signed button click; Calendly booking picked up by polling; HubSpot: 1 contact/company/deal, re-run no duplicates, stage update
- Not yet run live: click 3 'Approve and launch' and sending; reply -> auto answer -> booking with lead link; weekly report

## AI email quality (real gpt-4o-mini on the real leads)

- 5/7 sequences pass (80+), 5/7 on the first try; score computed in code from quoted evidence, judge temperature 0
- Negative controls: a generic sequence scores 40, a sequence with invented claims fails (any invented claim = fail)

## Level 5 – acceptance checklist (mock services)

| Requirement | How it's checked | Result |
| --- | --- | --- |
| Campaign launches in 2–3 clicks | E2E click count = 3 | Pass |
| Lead sourcing is automatic | Form → 10 leads with no manual step | Pass |
| Decision-maker found for each lead | 60%+ of leads have a name and email from the Impressum | Pass |
| Emails read as individually written | All sent sequences scored 80+ (mock AI score; real AI + reading 3 aloud needs the key) | Pass |
| Follow-ups day 0, 3, 7, 14, stop on reply | Integration scenarios 2 and 6 | Pass |
| Replies are pre-qualified | All 12 reply fixtures sorted correctly (+ bounce, unclear) | Pass |
| Meetings booked automatically | Integration scenario 3 | Pass |
| CRM kept up to date | One HubSpot deal per booked meeting | Pass |
| Results visible against the guarantees | Dashboard shows replies vs 20 and meetings vs 4–5 | Pass |
| GDPR: source stored, opt-out, delete | Source on every lead; STOP works; delete workflow removes a lead | Pass |
| No email to a real company in test mode | Safety tests | Pass |
| Errors are visible, not silent | Failure tests | Pass |

Note: with mock services the AI answers are deterministic fixtures, so rows that depend on AI *quality* (email tone, reply-sorting accuracy) prove the plumbing, routing and thresholds – not the model. Re-run with a real AI key (`docs/blockers.md` step 7) for that.

