# Progress log

Build of the Nexsale Lead Engine, following "Build order and tests" in PLAN.md.
Test stack used throughout: n8n 1.123.5 + Postgres in Docker (`docker-compose.test.yml`, port 5679) with
`MOCK_EXTERNAL=true`; every external API is served by `tests/mock_server/server.py` (port 8787).

## How to resume
1. `python tests/mock_server/server.py &` (from `.venv`)
2. `docker compose -p nexsale-test -f docker-compose.yml -f docker-compose.test.yml up -d`
3. `python tests/n8n_bootstrap.py && npm run build:workflows && python setup/deploy_workflows.py --test-stack`
4. `python tests/workflows/run_module.py all`

## Log

### 2026-11-14 – in progress (phases 1–5 built, workflow tests being written)
- Code modules (24) in `code/` with Jest tests; sandbox test proves they run without Node-only globals
  (n8n's Code node has no `URL`/`URLSearchParams`; found by running Module 2 on real n8n).
- Workflows 00, 01–06, 13–15 built by `scripts/build_workflows.js`, deployed and run on the test stack:
  form → 10 leads (1 Google request) → 8 Enriched / 2 Rejected → 32 emails (quality 88) → "Campaign ready"
  (Slack + [TEST] email) → launch checks → Live → first [TEST] emails, all rewritten to the test inbox.

### 2026-11-14 – Phases 1–8 done (mock services)
Built: all 19 workflows (00–12 + shared 13 send/guard, 14 AI call, 15 Slack), 24 code modules, 8 prompts,
Airtable schema/setup/seed/capture scripts, deploy script, mock server, level 2–4 runners, CI workflow.

| Phase | Built | Tests |
|---|---|---|
| 1 Foundation | docker-compose, .env.example, create_airtable_base.py (9 tables, idempotent), 00_error_handler, deploy | pytest 13/13; L2 "00": forced Google 500 → 3 tries → error → Logs + Slack alert ✔ |
| 2 Sourcing | 01 form, 02 Google Places | L2 01 8/8, 02 14/14: 10 leads, exactly 1 Google request, no duplicates on re-run |
| 3 Enrichment | 03, parseImpressum.js, score.js | Jest on 15 Impressum fixtures; L2 03 18/18: 9/10 with email, hard cases Rejected with reason |
| 4 AI emails | 04, prompts, validators, 14_ai_call | L2 04 16/16: 4 drafts/lead, quality 80+, one "Campaign ready", broken JSON → retry → Needs review |
| 5 Launch + sending | 05, 06, 13_send_email guard | L2 05 9/9, 06 13/13: Live in one click, 4 [TEST] mails in one thread, nothing after a reply |
| 6 Replies + booking | 07, 07a, 07b, 07c | L2 07 66/66 (14 fixtures), 07b 7/7 (double webhook → 1 meeting), 07c 4/4 |
| 7 Reporting | 08 | L2 08 8/8: counts equal seeded data, cost per lead/meeting, weekly report |
| 8 Inbound/CRM/Slack | 09, 10, 11, 12 | L2 09 9/9, 10 8/8 (no duplicates), 11 10/10 (signature verified, "Approved by"), 12 5/5 |

Bugs found by running on the real n8n and fixed in code (not in tests): no `URL` global in the Code sandbox;
pagination swallows HTTP errors (a failed Blocklist read looked empty → now throws); Slack/Calendly signature
nodes read the wrong input's raw body; all-failed AI batch left leads stuck in Drafting; subject/[TEST] threading.
Live tests are blocked on accounts and keys (docs/blockers.md).

### 2026-11-14 – Phases 9–10 (mock services)
- Level 3: 6 integration scenarios, 6 failure tests, 4 safety tests – all pass. The safety suite includes a
  misconfiguration drill: n8n restarted with a non-allowlisted TEST_PROSPECT_EMAIL → guard stops the run, nothing sent,
  Slack alert, stack restored to the safe config.
- Level 4: 3-click E2E passed twice in a row (form → "Campaign ready" in 9–19 s; whole flow 34–43 s).
- Final full run (all levels in order): Jest 293/293 (99.8 % lines on code/), pytest 13/13, L2 15/15 modules,
  L3 16/16, L4 2/2. Report: docs/test_report.md.
- Phase 10: README, docs/architecture.svg/.png, docs/demo_script.md, .env.example. Screen recording and rehearsals
  are for you (docs/blockers.md step 12).
- Bugs fixed in this phase: runner waiting logic (running/"waiting" executions are not listed by the API),
  secret-scan self-match in its own test.

### 2026-11-14 – live setup with the user (steps 1–7 of docs/blockers.md)
- Done: test inboxes + allowlist in `.env`; n8n self-hosted on :5678 with a Cloudflare quick tunnel (URL changes on
  restart); n8n API key; all 19 workflows deployed **inactive**; Airtable base with 9 tables + client
  "Real Service GmbH"; Google Places key (free trial, €5 budget alert; quota edit not allowed on trial), one real
  capture saved; OpenAI key (gpt-4o-mini) verified with one real sequence + quality check.
- Fixed from the live AI test: quality-check prompt (see decisions #27). Jest 294/294, L2 module 04 passes.
- Next: Gmail OAuth credential in n8n, Slack app, Calendly, HubSpot, Airtable Interface, fixed tunnel URL.
- Gmail OAuth credential connected (sender), guarded test email delivered (landed in Spam first: new accounts).
- Slack app (bot in private #leads, alert webhook, interactivity via tunnel) – button click verified with signature.
- Calendly free plan + new 07d_calendly_poll (L2 test 6/6); live booking picked up and processed.
- Active on the real n8n: 07b, 07d, 11. Remaining: HubSpot, fixed tunnel URL, Airtable Interface, first live campaign.
- HubSpot service key; real CRM sync tested twice (no duplicates) and cleaned up. All external services are now
  connected. Remaining: fixed tunnel URL, Airtable Interface, first live campaign + live E2E, recording.

### 2026-11-14 – full re-test after the first live campaign
- Live run 1 exposed gaps the mocks hid: unknown Airtable field, emails on related domains, salutations in names,
  SEO names, duplicate owner, generic AI emails, an inconsistent AI quality judge, literal "\n", missing greetings.
- Fixed in code (not by loosening tests); mock Airtable is now schema-strict; AI quality measured with the real model.
- Final automated run: Jest 315/315 (99.8 %), pytest 14/14, L2 17/17, L3 16/16, L4 2/2 (3 clicks).
- Live (real services): Campaign ready in 43–74 s, 1 Google request, 6/9 approved, 24/24 approved emails pass all checks.
- Waiting for the user: click 3 in Slack, then reply/booking to complete the live end-to-end run.

## 2026-11-14 – Live lead limit raised to 20 (user's request)
- `.env` `TEST_LEAD_LIMIT=20` (still 1 Google request, pageSize 20, no paging); automated tests keep 10. Unit tests 317/317.
- Old unlaunched test campaign deleted (user approved), fresh live run: Campaign ready in 75 s, 1 Google request, AI €0.014.
- 19 leads from 20 places: 11 Approved (44 emails, quality 85–100), 3 Needs review (quality 50–65 after one rewrite),
  5 Rejected (3 no email in Impressum, 1 score 35, 1 duplicate owner). 16/19 with email, 18/19 with director.
- Same day: limit set back to `TEST_LEAD_LIMIT=10` at the user's request. The 11-lead campaign stays in Airtable (not launched).

## 2026-11-14 – Lead withdraws after interest (HubSpot gap)
- New: Not interested / STOP after interest → meetings Cancelled, HubSpot deal Closed lost (+ reason), contact UNQUALIFIED,
  Slack "withdrew … please cancel it in Calendly". First "no" without earlier interest → nothing in HubSpot.
- Tests: 11 new unit tests (`code/__tests__/withdrawal.test.js`), new workflow scenario `07w` (19 checks: booked + deal,
  first no, STOP after interest). Deployed to the live n8n; HubSpot fields checked against the real portal.
- Fixed tunnel: ngrok static domain runs as the `tunnel` service in docker compose (decision 39).

## 2026-11-14 – Professional email format
- Frame in code (salutation from Impressum Herr/Frau, "Mit freundlichen Grüßen", full signature, legal footer with GDPR
  data source) for sequences, auto-answers, reminders and inbound confirmations. Email 1 introduces sender and offer.
- New rules in code: filler phrases rejected, closing question required. New Airtable fields: Leads.contact_salutation,
  Clients.sender_title / sender_company / sender_phone / sender_website / offer (added to the real base).
- Tests: unit tests for salutation, signature, footer, filler, CTA, Impressum salutation; workflow test 04 checks the frame.
  Real AI: 9/10 sequences pass (decision 41).

## 2026-11-14 – Form no longer hangs; live status page
- Cause: cross-site status check (form on localhost, WEBHOOK_URL = ngrok). `WEBHOOK_URL=http://localhost:5678/`.
- New workflow `01b_campaign_status`: live progress page after click 1 (`code/statusPage.js`, unit-tested, HTML escaped).
- Fixed: empty "Max leads" (sent as 0) was rejected; German error messages.
- Verified in the browser: submit → status page → "Kampagne bereit: Klick 2 und 3 in Slack" in about 1 minute.

## 2026-11-15 – Max leads controls the campaign size
- Form number decides (1–500) in test mode too; Google paged only as needed; re-runs never exceed Max leads.
- Tests rewritten for the new rule: campaign unit tests, workflow test 02 (10 → 1 request, 30 → 2 with page token, 3 → 3),
  S3 (10 or empty → exactly 1 request). Fake Google now serves pages 2–3.

## 2026-11-15 – Complete feature set for "everything automated, top quality"
- Client campaign mode (Nexsale + Real Service as clients), industry-neutral prompts, Nexsale's own email rules.
- Decision-maker from team/contact pages, offer-relevant triggers, better email discovery (mailto, contact page, homepage,
  company free-mail), company names never as persons.
- Replies: Question (approved answer) and Referral (intro email or task); qualifying questions; AI meeting brief.
- Live dashboard per client; data-protection one-pager.
- Live checks: Hausverwaltungen Berlin for Real Service (7/10 approved, client's sender and offer); Nexsale outreach in
  Leipzig, Dresden, Chemnitz used to find and fix extraction gaps (remaining rejections verified as correct by hand).

## 2026-11-15 – Handover guide and final test run
- `docs/HANDOVER.md`: complete guide (installation with checks, clients, first check, daily use, automation, where to
  see what, safety/go-live, testing, developer guide, troubleshooting, reference). Verified against the code; fixed on
  the way: seed script could duplicate the Nexsale client; the first check now uses enough leads for the launch minimum.
- Full run on the latest version: unit 394/394 (+1 dashboard money test), pytest 14/14, workflow 19/19, integration /
  failure / safety 16/16, end-to-end 2/2 with 3 clicks. One flaky integration case (I6, 1 failure in 4 runs) traced to
  the test's quiet-period wait returning between two Module 4 runs; the test now waits explicitly for "Campaign ready".

## 2026-11-15 – Control Center
- Workflow 16 + `code/controlCenter.js`: login, overview, clients, campaigns (create/launch/pause/resume/stop), leads
  (exclude, rewrite), replies (approve with edits, reject, sort), meetings, tasks, system. 20 unit tests, workflow test 16
  (26 checks). Slack actions reused through 11's internal entry.
- Security: ngrok traffic policy (only Slack clicks pass), login on dashboard and status page. Verified live: 401 without
  login, 200 with, 403 from the internet.
