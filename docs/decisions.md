# Decisions made during the build

Choices that PLAN.md / CLAUDE.md left open, or where the plan had to be adapted. Each one lists why.

## Architecture

1. **Workflow JSON is generated, not hand-edited.** `scripts/build_workflows.js` builds every file in `workflows/` and
   embeds the exact modules from `code/` into the Code nodes (and the prompts from `prompts/`). A Jest test fails if the
   JSON drifts from the source. Why: CLAUDE.md says Code node logic is written in `code/` with tests "then pasted in";
   generating it makes the paste automatic and impossible to forget.
2. **External APIs via HTTP Request nodes, not the built-in Airtable/Slack/HubSpot nodes.** Every base URL comes from a
   `Config` Code node (`code/config.js`). With `MOCK_EXTERNAL=true` all URLs point at `tests/mock_server`, which is what makes
   level 2 tests possible without keys. Tokens are read from `$env` in node headers (never in Code node output, so they
   never land in execution data). Built-in nodes are still used where they fit: Form Trigger, Webhook, Schedule, Gmail
   Trigger, Code, IF, Switch, Merge, Loop Over Items, Wait, Execute Workflow, Error Trigger.
3. **Three shared sub-workflows** (not in PLAN.md's list):
   - `13_send_email` – the only place that sends email. Blocklist check + the safety guard sit right before the send node.
     One guard instead of eleven copies; the lint test proves no other workflow can send.
   - `14_ai_call` – every AI call: prompt from `prompts/`, JSON-only, validated per prompt, retried once on invalid output.
   - `15_slack_notify` – posts/updates Slack messages with the bot token and fails loudly on `ok:false`
     (Slack returns HTTP 200 for errors, which would otherwise fail silently).
4. **`07a_gmail_inbox` is separate from `07_replies`.** The Gmail Trigger needs an OAuth credential; keeping it in its own
   workflow lets `07_replies` run (and be tested) through its `reply-ingest` webhook without Gmail.
5. **Kicks + schedules.** Modules 2→3→4 and 5→6 start the next module via its webhook right away (demo is ~1 minute instead
   of 5–15), and the schedules from PLAN.md stay as the fallback. Leads are *claimed* (`Enriching`, `Drafting`) before work
   so a kick and a schedule tick never process the same lead twice; stale claims (> 15 min) are picked up again.
6. **Ready check.** Module 4 sets a campaign Ready (and posts "Campaign ready" once) when all its sourced leads have left
   New/Enriching/Enriched/Drafting. The check runs strictly after drafting in the same run (n8n v1 order).
7. **Status flow.** Leads go `Enriched → Drafting → Approved` (or `Needs review`). `Drafted` exists in the schema but is
   transient: emails are created after the quality check in the same run, so writing `Drafted` first would cost an extra
   Airtable call per batch for no visible benefit. Emails are stored with status `Approved` or `Draft`.
8. **Filtering by record ID.** Linked-record fields can't be filtered reliably by record ID in Airtable formulas, so every
   child table also stores `campaign_record_id` / `lead_record_id` as text (the link fields are kept for the Airtable UI).
9. **Dashboard metrics are written by Module 8** onto Campaigns and Clients (hourly). The Airtable Meta API cannot create
   rollup/count/formula fields, so the Interface reads these number fields instead of computing them.

## Safety

10. **Guard behaviour.** DEMO_MODE rewrites To → `TEST_PROSPECT_EMAIL`, drops Cc/Bcc, prefixes `[TEST]`, then checks every
    final recipient against `TEST_RECIPIENT_ALLOWLIST` (empty list = block). It *throws*, so the run stops and the error
    handler alerts Slack. Extra rule: with `DEMO_MODE=false` the guard still blocks unless `ALLOW_REAL_SENDING=true` is also
    set – two explicit switches are needed for any real send.
11. **Pre-launch Gmail check uses the Gmail profile endpoint instead of sending a test email.** PLAN.md says "send a test to
    the sender's own address", but CLAUDE.md's safety rule says DEMO_MODE sends *every* email to `TEST_PROSPECT_EMAIL`.
    A profile call proves the credential works without sending anything. CLAUDE.md wins on safety rules.
12. **Blocklist hit inside the send sub-workflow throws.** Callers already skip blocked leads; a hit at the guard means a bug,
    so the run stops and alerts.
13. **Sending concurrency.** The DEMO_MODE ticker runs every minute. To make double sends impossible: (a) at most 6 (demo) /
    5 (real) emails per run, so a run ends before the next tick; (b) each email is re-read right before sending and skipped
    unless still `Approved`; (c) when the ticker is active, webhook-triggered runs do nothing. The 60–180 s pause between
    real sends uses the Wait node; demo uses 2–5 s, mock 1 s.
14. **DEMO_MODE ignores the 08:00–17:00 window and weekends** (otherwise demos and tests at night would never send). Real
    mode enforces it in code (`schedule.isSendWindow`) and in the cron (`*/15 8-16 * * 1-5`).

## Data and AI

15. **Synthetic fixtures with fictional companies on the reserved `.example` TLD.** No `GOOGLE_MAPS_API_KEY` was available,
    and fabricating "real" companies would be worse than clearly fake ones. The Google fixture has the exact shape of a
    `places:searchText` response with the Module 2 field mask. Replace it with one real capture as soon as the key exists
    (`docs/blockers.md`). The same applies to the 15 Impressum pages (10 normal + 5 hard cases).
16. **Rule-based pre-classification of replies** (`code/replies.js`): bounces, `STOP`, unsubscribe phrases and auto-replies
    are recognised without AI (cheaper, deterministic, never "unsure" about STOP). Everything else goes to the AI.
17. **Calendly matching.** In DEMO_MODE the invitee email is the test inbox, so leads are matched by
    `utm_content=<lead record id>` on the booking link (Calendly returns it in `payload.tracking`), then by email.
18. **AI provider.** `AI_PROVIDER=openai|anthropic` + `AI_MODEL`; default `gpt-4o-mini` as in `.env.example`. Costs are
    estimated from token usage and summed onto `Campaigns.ai_cost_eur`.
19. **Optional sources skipped:** OpenStreetMap Overpass and the Apify Indeed hiring signal are marked optional in PLAN.md and
    were not built. `hiring_signal` stays in the schema and in `score.js` (15 points) so it can be added later.
20. **HubSpot:** standard properties only (a fresh portal rejects unknown custom properties); `lifecyclestage` is set on
    create only (HubSpot refuses to move it backwards). Idempotency = search first (email / domain / deal name), then create
    or update. A note with source campaign and status is added on every stage change.
21. **Python 3.11** is installed with `uv` into `.venv` (the system Python is 3.9).

## Testing

22. **Level 2 runs on a real n8n** (`docker-compose.test.yml`, port 5679) against the mock server. `DISABLE_SCHEDULES=true`
    and `DISABLE_DEMO_TICKER=true` exist only in `tests/test.env`, so tests drive each module through its webhook and no
    schedule fires mid-test. Follow-up timing is tested by moving `next_send_at` into the past ("time travel") instead of
    waiting 14 minutes.
23. **Form executions end in status `waiting`** in n8n 1.123 when the form shows a "Form ending" page; tests accept
    `waiting` for `01_campaign_setup` only.
24. **n8n Code sandbox has no `URL`, `URLSearchParams`, `TextEncoder` or global `crypto`** (found by running Module 2 on the
    real n8n). Modules parse URLs by hand, and `code/__tests__/sandbox.test.js` loads every module in a VM with only n8n's
    globals so this can't regress.

## During live setup

25. **No 200-requests/day quota on Google Places.** Google Cloud free-trial accounts cannot edit quotas ("Free trial does
    not permit quota increases"; lowering is blocked too). Protection instead: the free trial cannot be charged beyond its
    credit unless the account is upgraded (do not upgrade), `TEST_LEAD_LIMIT=10` makes exactly 1 request per sourcing run,
    and a €5 budget alert. Set the 200/day quota if the account is ever upgraded.
26. **Real Places capture kept separately** (`tests/fixtures/google_places_berlin_10_real.json`, 10 places, 9 with a
    website). The mock tests keep the fictional fixture, because their Impressum pages are mocked per domain.
27. **Quality check gets the exact word counts and does not judge countable rules.** First live test with gpt-4o-mini:
    the writer produced a valid 41–51-word sequence, but the checker scored it 45/100, claiming 92–97 words and
    exclamation marks that were not there. Countable rules (word count, Sie-form, `!`, placeholders) are checked
    exactly in `validateEmails.js`; the prompt now states them as already passed (with the counts) and scores only
    personal first line (35), invented facts (35) and tone/structure (30). Re-test: 70/100 with two fair issues.
    Watch the first real campaign: if most sequences land just under 80 after the rewrite, review the threshold.
28. **Calendly free plan: polling instead of webhooks** (user's choice, no paid plan). New workflow
    `07d_calendly_poll` reads `/users/me`, `/scheduled_events` and each event's `/invitees` every 3 minutes, turns
    bookings created/cancelled in the last 30 minutes into the same payload a webhook sends (`calendly.pollToPayloads`)
    and posts them to `07b_calendly`, whose duplicate check makes overlapping polls harmless. Token scopes: read-only
    (scheduling + user). "Meeting booked" appears up to ~3 minutes after the booking. With a paid plan, create the
    webhook subscription and switch 07d off. Live-tested 2026-11-14: booking found and processed in one poll.
29. **HubSpot "service key" instead of a private app.** New HubSpot accounts no longer offer private/legacy apps; a
    service key with the same 6 CRM scopes is used as the Bearer token (`HUBSPOT_TOKEN`). Live-tested with the real
    10_crm_sync: 1 contact/company/deal, IDs written back, re-run after "Meeting held" → no duplicates, stage updated.
    HubSpot rejects emails on `.example` domains (INVALID_EMAIL): fine for real leads; for a live inbound-quiz demo use
    a real address.
30. **Mock Airtable validates like real Airtable.** Unknown tables/fields and wrong value types are rejected with the real
    error codes, using the same definitions as `setup/create_airtable_base.py` (`setup/schema.py`). Every test run fails if
    any write was rejected. Cause: a live run failed on `Unknown field name: "google_name"` that the permissive mock accepted.
31. **Quality check = evidence, not a guess.** The checker answers concrete questions with quotes; the score is computed in
    code (verified opening 35, no invented claims 35, company detail per email 5 each, no filler 10), at temperature 0.
    The opening only counts if the quoted detail appears verbatim in the company description and the first sentence.
    Measured with gpt-4o-mini on the real leads: same sequence 90/90/90; good sequences 10/10 pass; generic sequence 40;
    any invented claim fails. `tests/live/eval_email_quality.py` re-runs this measurement (~€0.01).
32. **Greeting and sign-off are added in code if missing** (gender-neutral "Guten Tag Vorname Nachname,"), literal `\n`
    from the model is converted to line breaks, and the rules check still runs afterwards. Live: the model had dropped
    them in ~3 of 10 sequences.
33. **One person, one sequence**: duplicates by email, or by director name + same address/phone (transitive). Live: one
    owner with two brand websites at the same address.
34. **Related email domains** (falconcleaning.de ↔ falcon-cleaning.de, dreimann-service.de ↔ dreimann-group.com) are
    accepted; free-mail and unrelated domains (web agencies) are not. Salutations are stripped from names; Google names
    are cleaned (NFKC, no "| SEO tail").
35. **Company summaries collect concrete facts** (districts, customer groups, special services, years, 24/7 …) and skip
    empty adjectives; the email prompt states the offer logic (new customers for the recipient itself).
36. **Newsletters without a lead** (list headers, bulk precedence, noreply/onboarding senders) are stored with branch
    `Ignored` and produce no Slack message. Header names are compared case-insensitively.
37. **Live lead limit raised to 20** (user's request, 2026-11-14). `.env` has `TEST_LEAD_LIMIT=20`: still exactly 1 Google
    request per sourcing run (pageSize 20 is Google's maximum per page), no paging. The automated tests keep 10
    (`tests/test.env`), because their fixture and mocked Impressum pages cover 10 companies. Slack still shows 3 sample
    sequences as PLAN.md specifies; "Open full list" shows every approved lead.
38. **Live lead limit back to 10** (user's request, 2026-11-14, replaces #37 for live runs). The 20-limit live run
    (11 approved of 19 leads, 1 Google request) is recorded in `docs/progress.md`. The unit tests for a limit of 20 stay,
    because the code still supports any limit up to Google's 20 per page.
39. **Fixed tunnel: free ngrok static domain inside docker compose.** The quick Cloudflare tunnel got a new random URL on
    every start and its hostname expired during a live test (Slack: "could not handle this payload", no n8n run).
    `docker-compose.yml` now has a `tunnel` service (profile `tunnel`, enabled by `COMPOSE_PROFILES=tunnel` in `.env`) that
    serves n8n on `NGROK_DOMAIN`, restarts with Docker, and keeps one URL for Slack, Calendly and the forms. Chosen over a
    named Cloudflare tunnel because that needs a paid domain. Note: ngrok's free plan shows a one-time warning page to
    browsers (not to Slack/Calendly API calls); open the forms on http://localhost:5678 during the demo.
40. **A "no" after interest closes the loop.** When a lead that was Interested / Meeting booked (or already has a HubSpot
    deal) replies "not interested" or STOP: booked meetings are set to Cancelled in Airtable, the existing HubSpot deal
    moves to `closedlost` with `closed_lost_reason`, the contact gets `hs_lead_status=UNQUALIFIED`, and Slack says the lead
    withdrew. A first "no" from a lead that was never interested creates nothing in HubSpot (the sync only picks closing
    statuses when `hubspot_deal_id` is set). The Calendly booking itself is not cancelled automatically: the Calendly
    token is read-only (free plan), so Slack asks a person to cancel it there. Logic: `replies.withdrawalPlan`,
    `crm.DEAL_STAGES` / `closedLostReason`; workflow test `07w`. Verified that the real HubSpot portal has these fields.
41. **Professional email format: code writes the frame, the AI writes the message.** Every outgoing email (sequence,
    auto-answer, reminder, inbound confirmation) has the same frame built in `validateEmails.js`:
    - salutation: "Sehr geehrter Herr / Sehr geehrte Frau <Titel> <Nachname>," only when the Impressum states Herr/Frau
      or a female role form (`parseImpressum` → `Leads.contact_salutation`); gender is never guessed from a first name.
      Otherwise "Guten Tag <Vorname Nachname>,"; no contact → "Sehr geehrte Damen und Herren,".
    - "Mit freundlichen Grüßen" + signature from the Clients record (name, title, company, phone, website).
    - footer: company details (Impressum duty), data source (GDPR Art. 14), STOP opt-out.
    The prompt makes email 1 introduce the sender and the offer (`Clients.offer`, default without numbers or promises).
    Checked in code: < 90 words of message text, filler phrases rejected, the last paragraph must ask a question (one
    call to action). Measured with gpt-4o-mini (`tests/live/eval_email_quality.py`, 2 runs × 5 real leads, with the
    workflow's one retry): 9/10 pass, the failed one is held as Needs review.
42. **Form lands on a live status page; n8n's own address is localhost.** Live bug: after "Submit" the form spun forever.
    The form page checks its run at `<WEBHOOK_URL>/form-waiting/<id>/n8n-execution-status`; with `WEBHOOK_URL` set to the
    ngrok address and the form opened on localhost, the browser blocked that cross-site check (CORS), and ngrok's free
    browser warning would block it too. Fix: `WEBHOOK_URL=http://localhost:5678/` (our workflows never read it; Slack and
    Calendly reach n8n through the tunnel by path). The form now redirects to `01b_campaign_status`
    (`/webhook/campaign-status?id=…`), a page that shows each step live (found → Impressum checked → emails written →
    ready) and refreshes every 5 s until Ready, then says "open Slack, click Approve and launch" and lists the approved
    leads. Second live bug found on the way: n8n sends an empty number field as 0, so every form without "Max leads" was
    rejected; 0 now means the default 100. Form errors are in German. Regression checks in workflow test 01.
43. **"Max leads" in the form decides the campaign size, in test mode too** (user's decision, 2026-11-15; replaces the
    fixed 10-company test cap of decisions 25/37/38). 10 → 10 leads, 30 → 30, 100 → 100 (1–500). Google is searched
    city-wide first, then district by district, 20 per request, with a 20 % buffer for companies without website or
    already known, and each search fetches only the pages it needs (`campaign.buildSearchPlan`, paging stops via
    `$pageCount`): 10 → 1 request, 30 → 2, 60 → 4, 100 in Berlin → 6. A re-run tops a campaign up to Max leads and never
    exceeds it. `TEST_LEAD_LIMIT` is now only the default for an empty field. Email safety is unchanged: DEMO_MODE sends
    everything to the test inbox. Cities without a district list give at most 60 companies (Google's limit per search).
44. **Leads are written as an upsert on `google_place_id`, and the AI retry gets its own previous answer.**
    (a) Every Airtable call retries 3× (CLAUDE.md). A retried *create* after a timeout can duplicate records (seen once in
    a full test run: 50 leads for Max leads 30, not reproducible). Module 2 now writes leads with Airtable's
    `performUpsert` (merge on `google_place_id`), so a repeated batch updates instead of duplicating; verified on the real
    base (0 created / 1 updated). Workflow test 02 sends the same batch twice and checks the count.
    (b) 14_ai_call's single retry now includes the model's previous answer and asks it to fix only the named problems.
    Live (25-lead Hamburg run): 6 of 7 "Needs review" leads were rule failures after a from-scratch retry; with the
    targeted retry all 7 pass the rules and 5 of 7 pass overall (the other 2 fail on quality, correctly held back).
45. **Client campaign mode: Nexsale is a client like any other.** Nexsale's job description says automation "for our own
    company and for our customers"; its website shows the core business is outreach in the client's name to the client's
    customers (Real Service → Hausverwaltungen, hotels, clinics). The campaign's client decides sender, offer, signature,
    footer, booking link and qualifying questions (`Clients` table); an empty form field = the default client (Nexsale,
    signed by David Gretschmann with the real public Impressum, user's decision). The email prompt and the quality check are
    industry-neutral and sell only the client's offer; the campaign's own industry and city never count as a "specific"
    opening detail. Live: "Hausverwaltungen Berlin" for Real Service, 7/10 approved, emails in Real Service's name.
46. **The right decision-maker, a relevant trigger, and every published email.** Module 3 also reads the team/contact page
    and the jobs page; the AI lists named people and one trigger, and code keeps only what is verifiably on the pages
    (`code/contacts.js`): the contact whose role matches the campaign's target role wins over the Impressum person, Herr/Frau
    only when written next to the name, a trigger only if it fits the client's offer (live: "sucht Mietverwalter" is not a
    cleaning trigger). Emails: also from mailto: links, the contact page and the homepage; a small firm's free-mail address
    counts when it clearly belongs to the company or owner (live: glanzmarvinreinigung@gmail.com); template/tracking
    addresses never (business@gmx.de, name@beispiel.de, sentry.io); company names are never taken as a person.
47. **Nexsale's own email rules, enforced in code:** first email < 90 words in at least 2 paragraphs (if 40+ words),
    follow-ups ≤ 50 words (prompt aims for 45), subject of email 1 and its A/B alternative ≤ 5 words, no filler, last paragraph
    asks one question. Source: Nexsale's blog (cold-email prompts, follow-up sequences).
48. **Questions and referrals in replies.** New categories: "Question" (price, process, info) → the AI drafts an honest
    answer from the client's offer (never invents prices) with the booking link and the client's qualifying questions; a person
    approves it in Slack (one click). "Referral" with an address in the reply on the company's domain → an intro email to the
    named person through the guard, a new lead and its thread; without a usable address → a task. Positive replies =
    Interested + Question.
49. **Pre-qualification and meeting brief** (Nexsale's "Goldstandard"): the auto-answer asks the client's qualifying
    questions; Calendly booking-form answers are read; on "Meeting booked" an AI brief (who, what, why now, what to ask) goes to
    Slack, is saved on the lead and is used as the HubSpot note. Factual fallback without AI.
50. **Live dashboard** (`08b_dashboard`, GET /webhook/dashboard[?client=]): guarantee per client with pace for the day of the
    month, KPIs, funnel, campaigns, A/B subject test (winner from 20 sends per variant), recent replies, upcoming meetings.
    Computed live from Airtable (refresh 60 s). "Open full list" in Slack opens the campaign status page.
51. **Data protection one-pager** in `docs/datenschutz.md` (sources, legal basis, § 7 UWG risk, processors, retention,
    deletion, go-live checklist).
52. **No paid email finder (Hunter, Apollo, verification services).** User's decision: no paid tools. Companies without a
    published email stay "Rejected" with the reason (`no email found in Impressum`, `no Impressum page found`). The free
    extraction already covers Impressum, mailto: links, the contact page, the homepage and a company's own free-mail
    address; the remaining live rejections were checked by hand and publish no usable email. In production, a paid
    finder or Nexsale's own lead database would be the place to add this.
53. **Control Center instead of editing Airtable.** User's decision: one dashboard to control the whole process. Workflow
    `16_control_center` serves a password-protected web app (GET /webhook/app, POST /webhook/app-action; HTTP Basic with
    `CONTROL_USER` / `CONTROL_PASSWORD`, constant-time compare; empty password = locked). Pages and actions are pure,
    unit-tested functions (`code/controlCenter.js`): overview with to-dos, clients (add/edit with validation), campaigns
    (create, launch, pause/resume/stop with status rules), leads (exclude; rewrite emails before launch – Module 4 now also
    drafts for Ready campaigns), replies (edit + approve, reject, sort; never twice), meetings (held/no-show), tasks, system.
    Actions Slack also offers go through `11_slack_actions` via a second, internal entry (`control-action`, password key),
    so Slack and the Control Center always behave identically. Built in n8n (no extra server, same tests and deploy).
54. **Nothing but Slack clicks is reachable from the internet.** Found while planning 53: the dashboard and status page were
    public through the ngrok address. `ngrok/policy.yml` (traffic policy) answers every path except
    `/webhook/slack-actions` and `/webhook/calendly` with 403; the dashboard and status page also need the login now.
