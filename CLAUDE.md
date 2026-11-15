# CLAUDE.md – Nexsale Lead Engine

This repo is a demo project for a job interview at Nexsale GmbH (Working Student IT Automation).
The full spec is in `PLAN.md`. Read it before doing anything. If this file and PLAN.md disagree, ask.

## How to work

- Build the whole project in one go, all phases in the order of "Build order and tests" in PLAN.md. Do not stop to ask for my OK between phases.
- After each phase: run its tests, fix failures until they pass, update the checklist below, and add a short entry to
  `docs/progress.md` (phase, what was built, test results). This lets the work resume if the session ends.
- Never run git commands that change history or the remote: no `git commit`, `git push`, `git add`, branch or reset.
  I will commit and push myself when the project is complete. Read-only git commands (`git status`, `git diff`) are fine.
- If something is unclear, choose the option that best fits PLAN.md, write the decision in `docs/decisions.md`, and continue.
- If a step needs something only I can do (a missing key in `.env`, an OAuth login in the n8n UI, a paid plan),
  do not stop: build and unit-test that part with mocked APIs (`MOCK_EXTERNAL=true`), add the item to `docs/blockers.md`
  with exact steps for me, and continue with the next phase.
- At the very end: run every test level, write `docs/test_report.md`, and give me one summary:
  what works, what was tested, and the list from `docs/blockers.md` that I need to do before the live tests can run.

## Tech rules

- n8n 1.x. Workflows live in `workflows/` as importable JSON, one file per module, named as in PLAN.md.
- Prefer built-in n8n nodes: Form Trigger, Webhook, Schedule, Airtable, Gmail, Slack, HTTP Request, Code, Switch, IF, Loop Over Items.
- Every Code node's logic is first written in `code/` as a plain JS module with Jest tests, then pasted into the workflow.
- AI prompts live in `prompts/` as Markdown. AI output is always JSON, parsed and validated; retry once on invalid output.
- Python 3.11 for scripts in `setup/`. Use `requests` and `python-dotenv` only.
- Set `00_error_handler` as the Error Workflow on every workflow. Retry on fail (3 tries, 5 s) on every external call.
- Airtable: write in batches of 10 records per call and keep polling light (free plan limits are in PLAN.md).
- Timezone everywhere: Europe/Berlin.

## Goal: three clicks to launch

The company wants one person to launch a campaign in 2–3 clicks, with everything else automatic:
click 1 = submit the campaign form, click 2 = open the "Campaign ready" Slack message, click 3 = "Approve and launch".
No per-email ticking. A person is asked only when the AI is unsure about a reply. See "Three clicks to launch" in PLAN.md.

## Safety rules (never break these)

- This is a demo, not a real launch. Test mode stays on for the whole build.
- Lead count = the "Max leads" number in the form, in test mode too (my decision, 2026-11-15). Google is paged only as far as that number needs (+20 % buffer, 20 per request: 10 → 1 request, 30 → 2). `TEST_LEAD_LIMIT=10` is only the default when the field is empty.
- `DEMO_MODE=true` must send every prospect-facing email from every module to `TEST_PROSPECT_EMAIL`; internal notifications (Campaign ready, weekly report) go only to `SENDER_EMAIL`. Test emails carry the header `X-Nexsale-Test: true` instead of a visible [TEST] in the subject (my decision, 2026-11-15).
- Put a guard node right before every email-sending node. It stops the run if any recipient is not in `TEST_RECIPIENT_ALLOWLIST`.
  Write a test that proves a real company address is blocked.
- Never send email to real companies. Never scrape pages behind a login.
- Never put API keys or tokens in any file except `.env`. `.env` is in `.gitignore`.
- Before every commit, check that no workflow JSON contains a secret.
- Check the Blocklist before every send.

## Testing rules (see "Testing plan" in PLAN.md)

- Write the tests together with the code, not at the end. A phase is done only when its tests pass.
- Level 1, unit: every function in `code/` has Jest tests; Python scripts have pytest tests. Keep 80%+ coverage on `code/`.
- Level 2, workflow: with `MOCK_EXTERNAL=true`, external APIs return saved fixtures from `tests/fixtures/`.
  `tests/workflows/run_module.py <module>` triggers one workflow, checks the run status through the n8n API, then checks Airtable and Slack.
- Save one real Google Places response (10 companies) as a fixture early, and reuse it so tests don't spend Google quota.
- Level 3, integration; failure tests; safety tests; Level 4, end-to-end: as listed in PLAN.md. Real services, test mode only.
- The end-to-end test must pass twice in a row with exactly 3 clicks.
- Safety tests run every time: an email to a real company address must be blocked by the guard.
- Never skip, delete or weaken a failing test to make it pass. Fix the code, or tell me why the test is wrong.
- Every test run writes its results to `docs/test_report.md`.
- GitHub Actions (`.github/workflows/tests.yml`) runs the unit tests and a secret scan on every push.

## Progress checklist

- [x] Phase 1 – Foundation (mock services; live parts in docs/blockers.md)
- [x] Phase 2 – Sourcing (Modules 1–2) (mock services; live parts in docs/blockers.md)
- [x] Phase 3 – Enrichment (Module 3) (mock services; live parts in docs/blockers.md)
- [x] Phase 4 – AI emails (Module 4) (mock services; live parts in docs/blockers.md)
- [x] Phase 5 – Launch and sending (Modules 5–6) (mock services; live parts in docs/blockers.md)
- [x] Phase 6 – Replies and booking (Module 7) (mock services; live parts in docs/blockers.md)
- [x] Phase 7 – Reporting (Module 8) (mock services; live parts in docs/blockers.md)
- [x] Phase 8 – Inbound, CRM and Slack (Modules 9–11) (mock services; live parts in docs/blockers.md)
- [x] Phase 9 – Integration and acceptance testing (mock services; live E2E in docs/blockers.md)
- [ ] Phase 10 – Polish (README, architecture diagram, demo script done; screen recording + 2 rehearsals need you, blocker 12)
