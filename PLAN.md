# Nexsale Lead Engine – Build Plan

Nov 14, 2026 · @Ghayoor Ali

## Overview

Build a working demo of an automated B2B outbound pipeline in n8n. It takes a target customer profile and turns it into scraped leads, AI-written emails, sorted replies, booked meetings and a client dashboard. The demo is for an interview at Nexsale GmbH for the role "Working Student IT Automation & Software Development".

**What Nexsale does.** Nexsale is a B2B outbound agency for the DACH region. It sources leads, runs personalised email campaigns, pre-qualifies replies and books first meetings for its clients. It guarantees 20+ positive replies and 4–5 qualified meetings per month. Its website says lead sourcing is done manually and replies are checked by people, so those are the two bottlenecks this project automates.

**What the job description asks for, and where this project covers it:**

| JD requirement | Covered by |
| --- | --- |
| Workflows in n8n, Make or Zapier | Every module is an n8n workflow |
| Connect CRM, Airtable, databases via APIs | Airtable as database, HubSpot CRM sync (Module 10); Google Places API, Gmail, Slack, Calendly, AI APIs |
| Automate lead, customer and sales data | Modules 2, 3, 6, 7, 9, 10 |
| Dashboards and analyses | Module 8 |
| Python or JavaScript for custom functions | n8n Code nodes (JS) and a Python setup script |
| AI applications, scraping tools, data protection | Modules 2–4 and 7, GDPR rules in Cross-cutting |
| Analyse processes and automate recurring tasks | Replaces their manual sourcing and reply checking |

**Scope.** One end-to-end campaign with real public data (for example cleaning companies in Berlin, one of Nexsale's industry pages). Emails go only to the builder's own test inboxes, never to real companies.

**Out of scope.** Real cold sending, paid data providers, LinkedIn automation, a custom frontend.

## Three clicks to launch

Nexsale asked for a system where one person launches a campaign in 2–3 clicks and everything else runs on its own. A person decides only at launch and when the AI is unsure about a reply.

1. **Click 1 – Start:** fill in the campaign form (client, industry, city, target role) and submit.
2. **Automatic, no clicks (about 5–15 minutes):** sourcing → enrichment → scoring → AI email sequences → AI quality check on every sequence.
3. **Click 2 – Review:** a "Campaign ready" message in Slack and by email shows the number of leads, the average score, 3 sample sequences and a link to the full list.
4. **Click 3 – Approve and launch:** one button runs the pre-launch checks and starts sending.
5. **Automatic after launch:** follow-ups, reply sorting, automatic answers to clear "interested" replies with the Calendly link, booking, CRM sync and the weekly report. Slack asks a person only for unclear replies.

### Test mode (on by default while building)

This is a demo, not a real launch, so test mode limits how much data is pulled and makes it impossible to email a real company.

| Setting | Test value | Real value | What it does |
| --- | --- | --- | --- |
| `DEMO_MODE` | true | false | Every email from every module (outreach, follow-ups, replies, reminders, inbound confirmations) goes to `TEST_PROSPECT_EMAIL`; the subject starts with \[TEST\]; follow-up days become minutes |
| `TEST_LEAD_LIMIT` | 10 | off | Google Places returns at most 10 companies: one request per test run, no paging |
| `TEST_RECIPIENT_ALLOWLIST` | your test inboxes | not used | A guard node right before every send stops the run if any recipient is not on this list |
| `AUTO_REPLY_MIN_CONFIDENCE` | 0.85 | 0.85 | Interested replies at or above this confidence are answered automatically; below it, Slack asks |

In test mode, real company data and email addresses are still found and stored, so enrichment can be tested on real Impressum pages, but nothing is ever sent to those addresses. Before the interview, run one test campaign of 10 real Berlin companies and keep it as the demo data.

## Tech stack

Every tool below has a free tier or trial that's enough for the demo. Each one is named in the JD or on Nexsale's website.

| Layer | Tool | Why this tool |
| --- | --- | --- |
| Workflow engine | n8n, self-hosted with Docker (n8n Cloud trial as backup) | Named first in the JD; workflows export as JSON for Git |
| Public URL for webhooks | Cloudflare Tunnel (free) or ngrok | Calendly and other webhooks can't reach n8n on localhost |
| Database and approval UI | Airtable, on the 14-day Team trial | Named in the JD; doubles as the approval UI and dashboard |
| CRM sync | HubSpot free CRM (private app token) | In Nexsale's logo strip; JD asks to connect CRM systems |
| Company search | Google Places API (New), Text Search, called from an n8n HTTP Request node; OpenStreetMap Overpass as an optional free second source | "Google Maps API" and OpenStreetMap are both listed as sources on Nexsale's site; an official API is easy to defend on data protection |
| Hiring signal (optional) | Apify Indeed scraper | Indeed Jobs is listed as a Nexsale data source |
| AI | OpenAI API (gpt-4o-mini) or Anthropic API (Claude), set in one config value | JD asks for AI applications; a cheap model is fine for drafts and sorting |
| Email for the demo | Gmail (2 accounts: sender and test prospect) via n8n Gmail node | Safe stand-in for Instantly or a similar sending tool |
| Inbound sources | n8n webhook test form standing in for the Web3Forms quiz and Meta Lead Ads | Nexsale's site collects leads with a quiz and Meta ads |
| Notifications and approvals | Slack app with interactive buttons (free workspace, channel #leads) | In Nexsale's logo strip; approve without leaving Slack |
| Booking | Calendly (one 15-minute event); Cal.com as fallback | Nexsale books every call through Calendly |
| Dashboard | Airtable Interface; Looker Studio as an option | JD asks for dashboards |
| Custom code | JavaScript in n8n Code nodes; Python 3.11 for setup and test scripts | JD names Python and JavaScript |
| Version control | GitHub repo with exported workflow JSON | Shows clean, reviewable work |

**Free-plan limits to plan around**

- **Airtable:** the Free plan allows 1,000 API calls per month and 1,000 records per base, which this project would use up in about a day. Start the 14-day Team trial (100,000 calls a month) about 10 days before the interview, write records in batches of 10 per call, and switch schedules on only while testing.
- **Calendly webhooks:** sources disagree on whether the Free plan includes them. Test a webhook subscription in phase 1; if it fails, use Calendly's free trial or Cal.com.
- **Webhooks on localhost:** n8n in Docker has no public address, so phase 1 sets up a tunnel and every webhook uses the tunnel URL.

* **Google Places API:** phone, website and rating are in the Enterprise tier: 1,000 free requests a month, then $35 per 1,000. One request returns up to 20 companies, so 100 leads take about 5–15 requests. A Google Cloud billing account with a card is required even inside the free amount: set a €5 budget alert and a quota of 200 requests a day so nothing is ever charged. Request only the fields in the Module 2 field mask; reviews or photos move every call to a higher price.

**Open question for the interview:** which CRM, sending tool and AI model does Nexsale use today? The design keeps each behind one module so it can be swapped.

## Architecture and data model

Eleven n8n workflows share one Airtable base: the core pipeline (Modules 1–8, drawn below) plus inbound leads, CRM sync and Slack approvals (Modules 9–11). They never call each other directly; each one reacts to a status change in Airtable, a webhook or a schedule. This keeps every module testable on its own.

&#91;embedded content: architecture · 8 n8n workflows around one Airtable base\]

The modules run in order from 1 to 8, but they only talk through Airtable, so any one can be rebuilt or swapped (for example Gmail for Instantly) without touching the others.

**Lead status flow:** New → Enriched (or Rejected) → Drafted → Approved → Contacted → Replied → Interested → Meeting booked → Meeting held (or No-show). Side exits: Not interested, Unsubscribed, Bounced.

**Campaign status flow:** Draft → Sourcing → Ready → Live → Paused → Completed.

### Airtable base: `Nexsale Lead Engine`

**Clients** (new: Nexsale runs campaigns for several clients, and its guarantees are per client)

| Field | Type | Notes |
| --- | --- | --- |
| client\_id | Autonumber |  |
| name, industry | Text | e.g. "Real Service GmbH" |
| calendly\_link | URL | Each client's own booking link |
| sender\_name, sender\_company\_footer | Text / Long text | Used in emails and the legal footer |
| target\_positive\_replies, target\_meetings | Number | Default 20 and 4 per month |
| hubspot\_owner\_id | Text | Where booked meetings land in the CRM |
| slack\_channel | Text | Alerts for this client |

**Campaigns**

| Field | Type | Notes |
| --- | --- | --- |
| campaign\_id | Autonumber | Primary key |
| name | Text | e.g. "Cleaning companies Berlin" |
| industry, city, company\_size, target\_role | Text / Single select | The ICP from the setup form |
| status | Single select | Draft, Sourcing, Ready, Launch, Live, Paused, Completed |
| daily\_limit | Number | Default 40 |
| subject\_a, subject\_b | Text | A/B subject lines |
| created\_at, launched\_at | Date |  |

Also on Campaigns: client (link to Clients), google\_api\_requests, google\_api\_cost\_eur and ai\_cost\_eur (summed by the workflows after each run).

**Leads**

| Field | Type | Notes |
| --- | --- | --- |
| lead\_id | Autonumber |  |
| campaign | Link to Campaigns |  |
| company\_name, domain, website, phone, address, city | Text / URL | From Google Maps |
| google\_rating, review\_count | Number |  |
| contact\_name, contact\_role, email | Text / Email | From the Impressum |
| register\_number, legal\_form | Text | e.g. HRB 12345, GmbH |
| hiring\_signal | Checkbox | Open sales job found on Indeed |
| company\_summary | Long text | AI summary of homepage |
| score | Number 0–100 |  |
| status | Single select | See lead status flow above |
| source, sourced\_at | Text / Date | GDPR: where and when the data came from |
| sequence\_step, next\_send\_at | Number / Date | Sending state |
| last\_reply\_category | Single select | Interested, Later, Not interested, Unsubscribe, Out of office |

Also on Leads: google\_place\_id (used to remove duplicates), lead\_type (Outbound, Inbound quiz, Inbound ad), inbound\_answers (long text), hubspot\_contact\_id, hubspot\_deal\_id.

**Emails**

| Field | Type | Notes |
| --- | --- | --- |
| email\_id | Autonumber |  |
| lead | Link to Leads |  |
| step | Number 1–4 | Day 0, 3, 7, 14 |
| subject, body | Text / Long text | AI draft |
| approved | Checkbox | Set by the AI quality check (score 80+); add a quality\_score number field |
| status | Single select | Draft, Approved, Sent, Skipped |
| sent\_at, gmail\_message\_id, thread\_id | Date / Text |  |

**Replies**: reply\_id, lead (link), received\_at, from\_email, body, category, ai\_confidence, suggested\_reply, reply\_approved (checkbox), handled\_at.

**Meetings**: meeting\_id, lead (link), calendly\_event\_id, start\_time, status (Booked, Reminded, Held, No-show, Cancelled).

**Blocklist**: email or domain, reason, added\_at. Checked before every send.

**Logs**: workflow, lead (link), level (info, error), message, created\_at.

**Tasks** (new): task\_id, lead (link), type (Call inbound lead, Call no-show, Follow up later), due\_at, assigned\_to, summary, status (Open, Done). This is the sales caller's to-do list.

## Modules 1–4: from target profile to approved emails

### Module 1 – Campaign setup (`01_campaign_setup.json`)

- **Trigger:** n8n Form Trigger.
- **Form fields:** campaign name, industry (search term), city, company size range, target role, max leads (default 100).
- **Steps:**
  1. Validate: all fields filled, max leads between 10 and 500.
  2. Create a Campaigns record with status Sourcing.
  3. Call Module 2 by webhook with the campaign\_id.
  4. Show a confirmation page: "Campaign started. You'll get a message in Slack when it's ready to launch." Modules 2, 3 and 4 then run one after another with no clicks, and Module 4 posts the "Campaign ready" message.
- **Done when:** submitting the form creates one campaign and starts sourcing within 10 seconds.

### Module 2 – Lead sourcing (`02_lead_sourcing.json`)

- **Trigger:** Webhook from Module 1 (campaign\_id).
- **Source:** Google Places API (New), Text Search. Docs: [Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search), [searchText reference](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText), [usage and billing](https://developers.google.com/places/web-service/usage).
- **Steps:**
  1. Build one search per district or postcode: `{industry} in {district}, {city}` (for example "Reinigungsunternehmen in Kreuzberg, Berlin"). Each search returns at most 60 results, so a city is split into districts.
  2. HTTP Request node: POST `https://places.googleapis.com/v1/places:searchText` with headers `X-Goog-Api-Key` (from the credential `GOOGLE_MAPS_API_KEY`) and `X-Goog-FieldMask`; body `{"textQuery": "…", "languageCode": "de", "regionCode": "DE", "pageSize": 20}`.
  3. Field mask (Enterprise tier, nothing more expensive): `places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.types,places.businessStatus,places.googleMapsUri,nextPageToken`.
  4. Test mode: one request with pageSize = TEST\_LEAD\_LIMIT (10) and no paging, so a test run uses exactly 1 Google request. Real runs, paging: while `nextPageToken` is returned and the campaign is below max leads, call again with `pageToken` (at most 3 pages per search, 2 seconds apart).
  5. Code node `mapPlaces.js`: map each place to a lead; skip places whose businessStatus is not OPERATIONAL; extract the domain from websiteUri; drop places without a website.
  6. Optional: query the OpenStreetMap Overpass API for the same category and city to add businesses Google missed.
  7. Optional: run an Apify Indeed scraper for `Vertrieb {city}`; set hiring\_signal when the company name matches.
  8. Upsert into Leads by google\_place\_id and domain with status New, source "Google Places API", sourced\_at = now. Add the number of requests used to the campaign's google\_api\_requests.
  9. Log the count; post to Slack: "84 leads sourced for Cleaning companies Berlin (12 Google requests)".
- **Done when:** in test mode, a Berlin search returns exactly 10 leads with website and phone from 1 Google request; with the limit off, 50+ leads with no duplicate domains from fewer than 20 requests.

### Module 3 – Enrichment and scoring (`03_enrichment.json`)

- **Trigger:** Schedule every 5 minutes; picks up to 20 leads with status New.
- **Steps:**
  1. Skip if the domain is on the Blocklist.
  2. HTTP GET the Impressum: try `/impressum`, `/impressum/`, `/imprint`, then find a link containing "impressum" on the homepage.
  3. Code node `parseImpressum.js`: strip HTML, then extract with regex:
     - email: first address on the company's own domain (prefer info@ only if nothing better)
     - director name: text after "Geschäftsführer", "Geschäftsführung", "Inhaber" or "Vertreten durch"
     - register number: `HR[AB]\s?\d+`; legal form: GmbH, UG, AG, GbR, e.K.
  4. Fallback: if regex finds no name, send the Impressum text to the AI with a JSON-only prompt.
  5. Check the email domain has an MX record (DNS lookup via a free DNS-over-HTTPS API).
  6. AI: summarise the homepage in 2 German sentences (services, customers, region).
  7. Code node `score.js`: score 0–100 = director name 30 + personal email 20 + MX ok 15 + rating ≥ 4.0 10 + 20+ reviews 10 + hiring signal 15.
  8. Status Enriched if score ≥ 50 and an email exists, else Rejected with a reason.
- **Done when:** at least 60% of leads with a website get an email, and every lead has a score and status.

### Module 4 – AI emails and approval (`04_ai_emails.json`)

- **Trigger:** Schedule every 5 minutes; picks Enriched leads.
- **Steps:**
  1. Load the lead, its company summary and the campaign ICP.
  2. AI call with a JSON-only response: 4 emails `[{step, subject, body}]`.
  3. Validate: 4 items, each body under 90 words, no placeholders like `{{` left; retry once on failure.
  4. Create 4 Emails records with status Draft; set lead status Drafted.
  5. AI quality check: a second AI call scores each sequence 0–100 against the prompt rules (personal first line, under 90 words, Sie form, no invented facts). Below 80 it is rewritten once; still below 80, the lead is left out of the campaign and flagged. Passing sequences are set Approved automatically: there is no per-email ticking. When all leads are done, post "Campaign ready" to Slack and email: lead count, average score, 3 sample sequences, a link to the full list, and the "Approve and launch" button.
- **Prompt rules (system prompt in `prompts/email_sequence.md`):**
  - German, formal Sie form, plain text, no buzzwords, no exclamation marks.
  - Email 1 opens with a specific detail from the company summary.
  - Step 2 (day 3): new angle on a pain point. Step 3 (day 7): one practical example. Step 4 (day 14): polite break-up that leaves the door open.
  - One call to action: a short call; never invent facts, numbers or client names.
- **Done when:** every Enriched lead has 4 drafts with a quality score, the "Campaign ready" message arrives without any clicks, and nothing is sent before the campaign is approved.

## Modules 5–8: from launch to dashboard

### Module 5 – Campaign launch (`05_campaign_launch.json`)

- **Trigger:** the "Approve and launch" button (in the Slack message via Module 11, or a button in the Airtable Interface), which sets the campaign status to Launch.
- **Pre-launch checks (all must pass):**
  1. At least 5 Approved leads in test mode (20 in real use).
  2. Every sequence of those leads passed the AI quality check.
  3. No lead email or domain is on the Blocklist.
  4. No lead domain is Contacted in another Live campaign.
  5. Gmail credential works (send a test to the sender's own address).
- **If a check fails:** status back to Ready, Slack message listing each failed check and the count.
- **If all pass:** status Live, launched\_at = now; for each Approved lead set sequence\_step = 1 and next\_send\_at = next send slot; assign subject A or B alternately; Slack: "Campaign Cleaning companies Berlin is live: 42 leads, first emails go out today."
- **Done when:** one click on "Approve and launch" takes a ready campaign Live; a campaign that fails a check stays Ready and Slack says why.

### Module 6 – Sending and follow-ups (`06_sending.json`)

- **Trigger:** Schedule every 15 minutes, Monday to Friday, 08:00–17:00 Europe/Berlin.
- **Steps:**
  1. Find leads in Live campaigns with status Approved or Contacted and next\_send\_at ≤ now.
  2. Stop if today's sent count for the campaign has reached daily\_limit.
  3. Skip any lead that has replied or is on the Blocklist.
  4. Send the Email for the current step via the Gmail node. Steps 2–4 reply in the same thread (use thread\_id).
  5. Wait a random 60–180 seconds between sends.
  6. Save sent\_at, gmail\_message\_id, thread\_id; lead status Contacted; advance sequence\_step; set next\_send\_at to day +3, +7, +14 from the first send.
  7. After step 4, mark the lead's sequence finished.
- **Safety check (daily at 17:30):** bounce rate = Bounced / sent today; above 3% sets the campaign to Paused and alerts Slack.
- **Demo mode:** an env variable `DEMO_MODE=true` shrinks days to minutes (day 3 = 3 minutes) and forces every recipient to the test prospect inbox. A guard node sits right before every email-sending node in every module: it rewrites the To address in test mode and stops the run if any recipient is not on TEST\_RECIPIENT\_ALLOWLIST.
- **Done when:** in demo mode, a lead gets 4 emails in one thread on schedule, and no email goes out after a reply.

### Module 7 – Reply sorting and booking (`07_replies.json`, `07b_calendly.json`, `07c_reminders.json`)

- **Trigger:** Gmail trigger on new mail in the sender inbox (poll every minute).
- **Steps:**
  1. Match the reply to a lead by thread\_id, then by from\_email.
  2. Detect bounces (mailer-daemon) → lead Bounced, add to Blocklist.
  3. Stop the lead's sequence at once.
  4. AI sorts the reply, JSON only: `{category, confidence, return_date, summary}`.
  5. Save a Replies record; run the branch below.
- **Branches (n8n Switch node):**

| Category | Action |
| --- | --- |
| Interested | Status Interested; AI drafts a short German reply with the Calendly link; if confidence is at or above AUTO\_REPLY\_MIN\_CONFIDENCE (0.85), send it automatically in the same thread and post it to Slack for information; below that, Slack shows Approve and send / Edit / Reject buttons |
| Later | Status Later; new follow-up date = return\_date or +30 days; Slack note |
| Not interested | Status Not interested; close the lead |
| Unsubscribe | Add to Blocklist; status Unsubscribed; never contact again |
| Out of office | Pause the sequence until return\_date + 1 day, then resume |
| Confidence below 0.7 | Slack: "Please sort this reply" with the text |

- **Calendly (`07b`):** webhook `invitee.created` → match by email → Meetings record, lead Meeting booked, Slack "Meeting booked with …"; `invitee.canceled` → meeting Cancelled.
- **Reminders (`07c`):** hourly; 24 hours before a meeting send a reminder email; 15 minutes after the start, if not marked Held, Slack asks "Held or no-show?"; No-show creates a call task for the sales caller.
- **Done when:** five test replies, one per category, each land in the right branch within 2 minutes.

### Module 8 – Dashboard and weekly report (`08_reporting.json`)

- **Dashboard (Airtable Interface, per client and campaign):** leads sourced, enriched %, emails sent, reply rate, positive replies, meetings booked, meetings held, cost per lead and cost per meeting (Google API + AI).
- **Guarantee tracker:** positive replies and meetings this month against each client's targets (default 20 and 4–5), shown as progress bars.
- **Funnel:** Sourced → Enriched → Contacted → Replied → Interested → Meeting booked.
- **Weekly report workflow:** Monday 08:00 → count the last 7 days per campaign → AI writes a 5-line German summary (what worked, what to change) → post to Slack and email it.
- **Done when:** the dashboard numbers match a manual count in Airtable, and the Monday report arrives with correct figures.

## Modules 9–11: inbound leads, CRM sync, Slack approvals

These three cover the parts of Nexsale's business beyond cold outreach: warm leads from their quiz and ads, the CRM, and fast approvals for the team.

### Module 9 – Inbound lead handling (`09_inbound_leads.json`)

- **Why:** Nexsale's homepage collects leads with a quiz and Meta ads, and its careers page hires a caller for warm inbound leads. This module gets those leads to the caller within minutes.
- **Trigger:** Webhook. For the demo, a small n8n form with the same 6 questions as their quiz stands in for Web3Forms and Meta Lead Ads.
- **Steps:**
  1. Normalise the payload (name, email, phone, company, quiz answers); lead\_type Inbound quiz or Inbound ad.
  2. Deduplicate by email and domain against existing Leads; if the lead is already in outreach, stop its sequence.
  3. Enrich the company with the Module 3 Impressum and summary steps.
  4. AI scores the lead (hot, warm, cold) from the quiz answers and writes a 3-line call brief: who they are, what they need, a suggested first question.
  5. Create a Tasks record "Call inbound lead", due in 15 minutes for hot leads, same day for warm.
  6. Slack message to the caller with the brief, phone number and a "Mark called" button.
  7. Send the lead an instant confirmation email with the client's Calendly link.
- **Done when:** a test quiz submission creates a scored lead, a call task and a Slack message within 1 minute.

### Module 10 – CRM sync to HubSpot (`10_crm_sync.json`)

- **Why:** the JD asks for connecting CRM systems, and HubSpot is on Nexsale's site.
- **Trigger:** lead status changes to Interested or Meeting booked.
- **Steps:**
  1. Search HubSpot for the contact by email; create or update it (name, company, phone, source campaign).
  2. Create or update the company by domain and associate it with the contact.
  3. Create a deal in stage "Meeting booked" with the meeting date; add the email thread summary as a note.
  4. Save hubspot\_contact\_id and hubspot\_deal\_id back to Airtable.
  5. Meeting held or No-show updates the deal stage.
- **Done when:** booking a test meeting creates exactly one contact, company and deal in HubSpot, and re-running does not create duplicates.

### Module 11 – Slack approvals (`11_slack_actions.json`)

- **Why:** approving in Slack is faster than opening Airtable, and it looks great in a demo.
- **Setup:** a Slack app with interactive messages; its request URL points to an n8n webhook through the tunnel.
- **Buttons:**
  - Campaign ready: Approve and launch (the third click). Interested reply below the auto-send confidence: Approve and send, Edit (opens the Airtable record), Reject.
  - Low-confidence reply: Interested, Later, Not interested, Unsubscribe.
  - Inbound lead: Mark called, Not reached (re-schedules the task in 2 hours).
- **Steps:** receive the button click, verify the Slack signature, update Airtable, run the same action Module 7 or 9 would, then update the Slack message to show who clicked and when.
- **Done when:** clicking Approve sends the AI reply in the right email thread and the Slack message changes to "Approved by …".

## Cross-cutting rules

These apply to every workflow. They are what makes the demo look like production work rather than a tutorial.

**Error handling**

- One error workflow `00_error_handler.json`, set as the Error Workflow on all others: writes to Logs and posts the workflow name, node and message to Slack.
- Retry on fail (3 tries, 5 seconds apart) on every HTTP, Google Places, AI and Airtable node.
- Batches of 20 with the Loop node, so one bad lead never stops the run.
- AI output is always parsed as JSON and validated; invalid output retries once, then the lead goes to a Needs review status.

**GDPR and German law**

- Store source and sourced\_at for every lead (Art. 14 GDPR information duty).
- Use only publicly available business data; no private persons, no scraping behind logins. Google Places data is covered by Google's terms (the EEA terms apply to an EU billing account): read the storage rules before keeping Places data long term; the place ID is kept for removing duplicates.
- Blocklist checked before every send; unsubscribe is permanent. Every email ends with a fixed legal footer from the Clients table: company name, address, managing director, register number, and "Reply STOP to stop receiving emails". STOP replies go to the Unsubscribe branch.
- Workflow `12_delete_lead.json`: a webhook takes an email, deletes the lead with its emails and replies, keeps only the Blocklist entry.
- Cold email advertising needs consent in Germany (UWG §7), so the demo sends only to the builder's own test inboxes.
- AI calls send company data, not more personal data than needed.

**Secrets and config**

- All keys in n8n credentials or `.env`, never in workflow JSON or Git. `.env.example` lists them: `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `GOOGLE_MAPS_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, `AI_PROVIDER`, `AI_MODEL`, `SLACK_WEBHOOK_URL`, `CALENDLY_LINK`, `CALENDLY_TOKEN`, `SENDER_EMAIL`, `TEST_PROSPECT_EMAIL`, `DEMO_MODE`, `TZ=Europe/Berlin`.
- Exported workflows must have credentials stripped (n8n does this by default; verify before each commit).

Added for Modules 9–11 and the tunnel: `HUBSPOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `N8N_API_KEY`, `WEBHOOK_URL` (the public tunnel URL, also set as n8n's own WEBHOOK\_URL variable). Optional: APIFY\_TOKEN, only for the Indeed hiring signal. Test mode settings: DEMO\_MODE, TEST\_LEAD\_LIMIT, TEST\_RECIPIENT\_ALLOWLIST, AUTO\_REPLY\_MIN\_CONFIDENCE (see Three clicks to launch).

## Repo structure and deliverables

One GitHub repo, `nexsale-lead-engine`. Claude Code writes the files; the builder imports the workflows into n8n and connects the credentials.

```
nexsale-lead-engine/
├── README.md                  setup, architecture, demo steps
├── docker-compose.yml         n8n + Postgres, TZ=Europe/Berlin
├── .env.example
├── setup/
│   ├── create_airtable_base.py   creates all tables and fields via the Airtable Meta API
│   └── seed_test_data.py         5 fake leads + 5 test replies for testing
├── workflows/
│   ├── 00_error_handler.json
│   ├── 01_campaign_setup.json … 11_slack_actions.json
│   └── 12_delete_lead.json
├── code/                      source of every n8n Code node, with tests
│   ├── parseImpressum.js
│   ├── score.js
│   ├── mapPlaces.js
│   ├── validateEmails.js
│   └── __tests__/               Jest tests with real Impressum HTML samples
├── prompts/
│   ├── email_sequence.md
│   ├── reply_classifier.md
│   ├── impressum_fallback.md
│   ├── weekly_report.md
│   └── inbound_lead_brief.md
├── tests/
│   ├── fixtures/                Google response, Impressum pages, replies, webhook payloads
│   ├── workflows/run_module.py  level 2: one workflow with mocked APIs
│   ├── integration/             level 3: chained modules in test mode
│   └── e2e/run_e2e.py           level 4: the full 3-click flow
├── .github/workflows/tests.yml  unit tests + secret scan on every push
└── docs/
    ├── architecture.png
    ├── demo_script.md
    └── test_report.md
```

**Deliverables for the interview:**

- [ ] All workflows imported and running in n8n
- [ ] Airtable base with one test campaign of 10 real Berlin companies
- [ ] Dashboard Interface in Airtable
- [ ] GitHub repo, public or shared by link
- [ ] One-page architecture diagram
- [ ] 3-minute screen recording of the full flow, as a backup if live demo fails

## Build order and tests

Build in this order; each phase ends with its unit tests, its workflow test (see Testing plan) and the test named below, which must all pass before the next phase starts. Total effort is about 28–32 hours. If time is short, phases 1–4 and 6 are the minimum demo; phase 8 is the first extra to add.

1. **Foundation (2–3 h):** docker-compose, `.env.example`, Airtable setup script, error handler workflow, Cloudflare Tunnel or ngrok, start the Airtable Team trial, create a Google Cloud project with Places API (New) enabled, an API key restricted to that API, a €5 budget alert and a 200-requests-a-day quota. Test: n8n opens on localhost:5678 and on the tunnel URL, the script creates all 9 tables, a forced error reaches Slack, and a test Calendly webhook subscription succeeds (if not, switch to the trial or Cal.com now).
2. **Sourcing (3 h):** Modules 1 and 2. Test: the form creates a campaign and with TEST\_LEAD\_LIMIT=10, exactly 10 Berlin leads appear from 1 Google request. Keep the limit on for the whole build.
3. **Enrichment (4 h):** Module 3 with `parseImpressum.js` and `score.js`. Test: Jest tests pass on 10 saved Impressum pages; 60%+ of live leads get an email.
4. **AI emails (2–3 h):** Module 4 and the review Interface. Test: 4 German drafts per lead with a quality score, and the "Campaign ready" Slack message arrives with no clicks after the form.
5. **Launch and sending (3 h):** Modules 5 and 6 with DEMO\_MODE. Test: one click on "Approve and launch" sends 4 \[TEST\] emails in one thread to the test inbox; a test that tries to send to an address outside the allowlist is stopped by the guard node.
6. **Replies and booking (3–4 h):** Module 7. Test: `seed_test_data.py` replies in all 5 categories, each handled correctly; a Calendly booking sets Meeting booked.
7. **Reporting (2 h):** Module 8. Test: dashboard counts match Airtable per client; cost per lead shows; the weekly report runs on manual trigger.
8. **Inbound, CRM and Slack (4–5 h):** Modules 9–11. Test: a quiz submission creates a call task and Slack brief within 1 minute; a booked meeting creates one HubSpot contact and deal; Slack Approve sends the reply.
9. **Integration and acceptance testing (3–4 h):** run the integration, failure, safety and end-to-end tests from the Testing plan; fix and re-run until everything passes twice in a row; fill in the acceptance checklist and generate `docs/test_report.md`.
10. **Polish (2 h):** README, architecture diagram, screen recording, rehearse the demo twice.

**End-to-end test (run the day before the interview):** fill the form for "Reinigungsunternehmen Berlin" → wait for the "Campaign ready" Slack message → click "Approve and launch" → reply "Klingt interessant, haben Sie nächste Woche Zeit?" from the test inbox → check the AI answered automatically with the Calendly link → book the Calendly slot → check the Slack messages, the lead's status history and the dashboard.

## Testing plan

Testing runs at five levels, from single functions up to the full 3-click flow. Each level must pass before the next one starts, and the last level checks the system against what Nexsale asked for. All tests run in test mode: at most 10 companies, no emails to real companies.

| Level | What is tested | Tool | When | Pass rule |
| --- | --- | --- | --- | --- |
| 1. Unit | Every function in `code/`, the AI output validators, the Python scripts | Jest, pytest | On every change; GitHub Actions on every push | All pass; 80%+ line coverage on `code/` |
| 2. Workflow | One n8n workflow on its own, external APIs replaced by saved responses | `tests/workflows/run_module.py`, `MOCK_EXTERNAL=true` | End of each build phase | Expected Airtable records and Slack message, execution status success |
| 3. Integration | Modules chained together with real APIs in test mode | `tests/integration/` | After phases 4, 6 and 8 | Every scenario below passes |
| 4. End-to-end | The full 3-click flow, from form to booked meeting and dashboard | `tests/e2e/run_e2e.py` | Phase 9 and the day before the interview | All checks pass in one run, twice in a row |
| 5. Acceptance | The finished system against Nexsale's requirements | Checklist below | After level 4 | Every row is Pass |

### Test data (fixtures)

Saved once, reused by every test, so tests don't spend Google or AI quota.

- `tests/fixtures/google_places_berlin_10.json`: one real Google Places response for 10 Berlin cleaning companies.
- `tests/fixtures/impressum/`: 10 real Impressum pages, plus 5 hard cases: no Impressum page, email written as "info \[at\] firma.de", two managing directors, an Austrian page, a Swiss page.
- `tests/fixtures/replies/`: 12 test replies, 2 per category plus 2 tricky ones (English reply, "STOP"), including an out-of-office with a return date.
- `tests/fixtures/webhooks/`: a Calendly `invitee.created` and `invitee.canceled` payload, a Slack button click, a quiz submission.

### Level 1: unit tests (must cover)

- `parseImpressum.js`: the expected name, email, register number and legal form for every fixture page; empty result (no crash) for the hard cases.
- `score.js`: each scoring rule, boundary values (score 49 vs 50), missing fields.
- `mapPlaces.js`: place without a website is dropped, closed business is skipped, duplicate domains are merged, domain extracted from URLs with paths and "www".
- `validateEmails.js`: rejects bodies over 90 words, informal "du", leftover placeholders like `{{`, missing legal footer.
- `guard.js`: blocks any recipient not on the allowlist; in DEMO\_MODE rewrites the To address and adds \[TEST\]; blocks an empty allowlist.
- `schedule.js`: day 0, 3, 7, 14 dates, skips weekends, sends only 08:00–17:00 Berlin time, minutes instead of days in DEMO\_MODE.
- `parseAiJson.js`: valid JSON, JSON wrapped in text, broken JSON (returns an error, never crashes).
- `slackSignature.js`: accepts a valid signature, rejects a wrong or old one.
- Python: `create_airtable_base.py` can run twice without creating duplicate tables.

### Level 2: workflow tests (one per module)

With `MOCK_EXTERNAL=true`, Google, AI, Gmail, Calendly and HubSpot calls return fixtures instead of calling the real service. The script triggers the workflow through its webhook or form, waits for the run, checks the run status through the n8n API executions endpoint, then checks Airtable and Slack.

| Module | Input | Expected result |
| --- | --- | --- |
| 2 Sourcing | Campaign webhook | 10 leads, status New, no duplicates |
| 3 Enrichment | 10 New leads + Impressum fixtures | Emails and names found as in the fixtures, scores set, hard cases Rejected with a reason |
| 4 AI emails | Enriched leads | 4 drafts each, quality score set, one "Campaign ready" message |
| 5 Launch | "Approve and launch" click | Status Live; a campaign with a failed check stays Ready and Slack says why |
| 6 Sending | Live campaign | Each send passes the guard; next send dates correct; no send after a reply |
| 7 Replies | Each reply fixture | Correct category and branch; bounce goes to Blocklist |
| 8 Reporting | Seeded data | Dashboard counts equal the seeded counts |
| 9 Inbound | Quiz fixture | Scored lead, call task, Slack brief |
| 10 CRM | Meeting booked | One contact, company and deal; a second run creates no duplicates |
| 11 Slack | Button fixtures | The matching action runs; message updates to "Approved by …" |

### Level 3: integration tests (real services, test mode)

1. **Sourcing chain (Modules 1–4):** submit the form → "Campaign ready" arrives with no clicks, within 15 minutes, using 1 Google request.
2. **Launch chain (Modules 5–6):** click "Approve and launch" → 4 \[TEST\] emails arrive in the test inbox in one thread, on the demo-mode schedule.
3. **Reply chain (Modules 7, 10, 11):** reply "interested" → automatic answer with the Calendly link → book the slot → Meeting booked in Airtable and a deal in HubSpot.
4. **Unsure reply:** an unclear reply → Slack buttons → click Interested → same result as scenario 3.
5. **Inbound chain (Modules 9, 10):** quiz submission → call task and Slack brief within 1 minute.
6. **Stop rules:** reply after email 1 → emails 2–4 never send; "STOP" → Blocklist, and a new campaign skips that address.

### Failure tests (the system must recover or report, never fail silently)

- Google API returns 429 or 500 → 3 retries, then the error handler posts to Slack.
- AI returns broken JSON → one retry, then the lead goes to Needs review.
- Airtable rate limit (429) → wait and retry; no lost records.
- Gmail or Slack credential expired → error handler posts to Slack with the workflow name.
- The same Calendly webhook arrives twice → one meeting, not two.
- A workflow is re-run on the same campaign → no duplicate leads, emails or deals.

### Safety tests (must pass on every run)

- An email addressed to a real company is blocked by the guard and the run stops.
- With `DEMO_MODE=true`, every sent email in the test inbox starts with \[TEST\]; the real company inbox gets nothing.
- `TEST_LEAD_LIMIT=10` makes exactly 1 Google request per sourcing run.
- No secret appears in any file in `workflows/` (a scan runs in GitHub Actions).

### Level 4: end-to-end test (`run_e2e.py`)

The script plays the full demo with only the three clicks a person would make, and checks each step: form submitted → "Campaign ready" → "Approve and launch" → \[TEST\] emails in the test inbox → an "interested" reply from the test inbox → automatic answer → Calendly booking → HubSpot deal → dashboard shows the right numbers → weekly report runs. It counts the clicks (must be 3) and the time from form to "Campaign ready".

### Level 5: acceptance checklist (what Nexsale asked for)

| Requirement | How it's checked | Result |
| --- | --- | --- |
| Campaign launches in 2–3 clicks | E2E click count = 3 |  |
| Lead sourcing is automatic | Form → 10 leads with no manual step |  |
| Decision-maker found for each lead | 60%+ of leads have a name and email from the Impressum |  |
| Emails read as individually written | All sent sequences scored 80+; 3 read aloud in German sound natural |  |
| Follow-ups day 0, 3, 7, 14, stop on reply | Integration scenarios 2 and 6 |  |
| Replies are pre-qualified | All 12 reply fixtures sorted correctly |  |
| Meetings booked automatically | Integration scenario 3 |  |
| CRM kept up to date | One HubSpot deal per booked meeting |  |
| Results visible against the guarantees | Dashboard shows replies vs 20 and meetings vs 4–5 |  |
| GDPR: source stored, opt-out, delete | Source on every lead; STOP works; delete workflow removes a lead |  |
| No email to a real company in test mode | Safety tests |  |
| Errors are visible, not silent | Failure tests |  |

### Test report

`npm test`, `pytest` and `python tests/e2e/run_e2e.py` write their results to `docs/test_report.md`: date, number passed and failed, and the acceptance checklist with Pass or Fail per row. Bring this report to the interview.

## Instructions for Claude Code

Export this doc as Markdown, save it as `PLAN.md` in an empty folder, and start Claude Code there. Paste this as the first message:

```
Read PLAN.md. It is the full spec for a demo project for a job interview.
Build it phase by phase, following "Build order and tests".

Rules:
- Work one phase at a time. At the end of each phase, run its test, show me the result, and wait for my OK.
- Write n8n workflows as importable JSON (n8n 1.x format). Use built-in nodes where they exist
  (Form Trigger, Airtable, Gmail, Slack, HTTP Request, Code, Switch, Schedule, Webhook).
- Keep every Code node's logic in /code as a plain JS module with Jest tests, then paste it into the workflow.
- Never put API keys in files. Read them from .env or n8n credentials.
- Keep DEMO_MODE support everywhere: all emails go to TEST_PROSPECT_EMAIL.
- If something in the plan is unclear or impossible, ask me instead of guessing.
- Import each finished workflow into my local n8n through the n8n public API (N8N_API_KEY in .env),
  or tell me to import it by hand.

Start with phase 1.
```

**Things only you can do (Claude Code will ask):** create the free accounts (Airtable, Google Cloud with billing and Places API (New), OpenAI or Anthropic, HubSpot, Slack, Calendly, 2 Gmail accounts), paste the keys into `.env`, connect Gmail and Slack credentials inside n8n (OAuth needs a browser), and tick approvals during tests.

## Demo script (5 minutes)

1. **The problem (30 s):** "Your website says lead sourcing and reply checking are manual. I automated the whole flow: a campaign launches in three clicks, and a person is asked only when the AI is unsure."
2. **Sourcing live (1 min):** click 1: submit the form for cleaning companies in Berlin; 10 leads appear in Airtable with the managing director's name from the Impressum, with no further clicks.
3. **AI emails (1 min):** click 2: open the "Campaign ready" Slack message; show a 4-email German sequence and its AI quality score.
4. **Launch (30 s):** click 3: "Approve and launch"; show the checks passing and the first \[TEST\] email arriving in the test inbox.
5. **Reply (1 min):** answer from the test inbox; show the AI category and the automatic answer with the Calendly link, then book a slot and show the HubSpot deal.
6. **Dashboard (30 s):** show progress against 20 positive replies and 4–5 meetings.
7. **Close (30 s):** "Next I would connect this to your real CRM and sending tool. Which ones do you use?"

Have the screen recording open in a second tab in case Wi-Fi or an API fails.

## Interview talking points

Short answers to the questions the demo is likely to raise.

- **Why n8n over Make or Zapier?** It can be self-hosted, so lead data stays in the EU (good for GDPR). There's no cost per task, which matters at hundreds of emails a day. Code nodes allow custom logic, and workflows are JSON files that live in Git.
- **Why the Google Places API instead of a scraper?** Your website lists the Google Maps API and OpenStreetMap as sources. An official API is stable, its terms are clear, and that matters for GDPR. Scraping is used only where it's fair: public Impressum pages.
- **Where does a person still decide?** Only at launch (one click) and for replies where the AI is unsure. Every email passes an AI quality check first, because one wrong email can damage a client's brand. Everything else runs on its own.
- **How would real sending work (deliverability)?**
  - Separate sending domains, never the client's main domain.
  - SPF, DKIM and DMARC records on every sending domain.
  - Warm up new inboxes for 2–4 weeks before full volume.
  - Rotate several inboxes, about 30–50 emails per inbox per day.
  - Verify every email before sending, and pause on high bounce rates (already in Module 6).
  - A tool like Instantly handles rotation and warm-up; it replaces the Gmail node in Module 6.
- **How does it scale to many clients?** One Clients table, campaigns linked to clients, a Slack channel and Calendly link per client, and a dashboard filtered per client. A new client is a new record, not a new workflow.
- **What does a lead cost?** The dashboard shows Google API and AI cost per lead and per meeting, so Nexsale can price campaigns and spot expensive ones. One Google request finds up to 20 companies, and the first 1,000 requests a month are free.
- **What would you build next?** LinkedIn tasks for a second channel (their software page mentions LinkedIn sequences), A/B test reports on subject lines, and connecting their real CRM and sending tool.
- **Questions to ask them:** Which CRM and sending tool do you use today? How do you check replies now, and how long does it take? Where does the team lose the most time each week?
