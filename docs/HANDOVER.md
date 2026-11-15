# Nexsale Lead Engine – Handover Guide

This guide is for someone who has **never seen this project**. Follow it from top to bottom and you will have the complete
system running on your own Mac, launch campaigns in three clicks, and know how to test, operate, change and troubleshoot it.

Keep the safety rule in mind from the first minute: **test mode is on by default**. Every email the system writes goes
only to your own test inbox, with `[TEST]` in front of the subject. Real companies receive nothing until the go-live
checklist in section 9 is done.

---

## Contents

1. [What the system does](#1-what-the-system-does)
2. [What you need](#2-what-you-need)
3. [Installation, step by step](#3-installation-step-by-step)
4. [Configure the clients](#4-configure-the-clients)
5. [First check: is everything connected?](#5-first-check-is-everything-connected)
6. [Daily use: running a campaign](#6-daily-use-running-a-campaign)
7. [What happens automatically after launch](#7-what-happens-automatically-after-launch)
8. [Where to see what](#8-where-to-see-what)
9. [Safety switches and going live](#9-safety-switches-and-going-live)
10. [Testing](#10-testing)
11. [Changing the system (developer guide)](#11-changing-the-system-developer-guide)
12. [Troubleshooting](#12-troubleshooting)
13. [Reference](#13-reference)

---

## 1. What the system does

**Everything is operated from one place: the Control Center** (http://localhost:5678/webhook/app, password-protected).
Add clients, start campaigns, review leads and emails, launch, pause, approve replies, handle meetings and see the results –
without touching Airtable or n8n. Slack sends notifications and offers the same quick buttons.

Nexsale is a B2B outbound agency: it finds companies, writes them personal emails, reads the replies and books meetings.
This system automates that so **one person launches a campaign in three clicks** and a person is asked again only when the
AI is unsure about a reply.

### The three clicks

| | Who | What happens |
|---|---|---|
| **Click 1** | You fill in the campaign form | Google Maps search → each company's website (Impressum, team/contact page, jobs page) → the right contact person and email → lead score → AI writes 4 personal German emails per company → code and AI quality checks → you land on a live status page |
| **Click 2** | You open "Campaign ready" in Slack #leads | You see the numbers and 3 sample email sequences |
| **Click 3** | You press **Approve and launch** in Slack | Emails go out (day 0, 3, 7, 14 – minutes in test mode). Replies are sorted by AI, interested leads get a booking link, meetings are booked, HubSpot is updated, the dashboard shows the results |

### Two kinds of campaign

The **Client** field in the form decides on whose behalf the system writes:

| | Nexsale's own outreach | Client campaign |
|---|---|---|
| Client field | leave empty (or "Nexsale GmbH") | e.g. "Real Service GmbH" |
| Who writes | David Gretschmann, Geschäftsführer, Nexsale GmbH | the client's contact person |
| What is offered | Nexsale's service (winning new customers) | the client's service (e.g. cleaning) |
| Who receives it | companies Nexsale wants as clients | the client's potential customers |

Everything client-specific (sender, offer, signature, legal footer, booking link, qualifying questions) comes from the
client's record in Airtable, so a new client needs **no code change** (section 4).

### How it is built (one paragraph)

- **n8n** runs 23 workflows in Docker on your Mac.
- **Airtable** is the database.
- **Google Places** finds companies, **OpenAI** writes and checks.
- **Gmail** sends and receives, **Slack** is the control panel (clicks 2 and 3, notifications).
- **Calendly** books meetings, **HubSpot** is the CRM.
- **ngrok** gives your Mac one fixed public address, so Slack can deliver button clicks. It lets **only** Slack's clicks
  through (`ngrok/policy.yml`); everything else (Control Center, dashboard, n8n editor) is reachable only on your Mac.

All business logic lives in tested JavaScript modules (`code/`) that are embedded into the n8n workflows automatically.
Architecture picture: `docs/architecture.png`. Why things are built the way they are: `docs/decisions.md`.

---

## 2. What you need

### Software (install once)

| Software | Version used | Install |
|---|---|---|
| Docker Desktop | 29.x | https://www.docker.com/products/docker-desktop – start it once and leave it running |
| Node.js | 24.x (20+ works) | https://nodejs.org or `brew install node` |
| uv (Python manager) | 0.13+ | `brew install uv` – it installs Python 3.11 for the project |
| Git | any | comes with Xcode command line tools |

### Accounts (all have free plans or trials)

| Account | Used for | Cost |
|---|---|---|
| 2 × Gmail | one **sender** inbox, one **test prospect** inbox that receives every test email | free |
| Google Cloud | Places API (finding companies) and the Gmail login for n8n | free credit; set a €5 budget alert |
| OpenAI | writing and checking emails, sorting replies | ~€0.001 per lead |
| Airtable | database | free / Team trial |
| Slack | a workspace with a channel **#leads** | free |
| Calendly | one 15-minute event for bookings | free plan works |
| HubSpot | CRM | free CRM |
| ngrok | the fixed public address | free (1 static domain included) |

Plan about **2 hours** for the first installation.

---

## 3. Installation, step by step

Every step ends with a **Check** – do not continue until it passes. All commands run in the project folder.

### 3.1 Get the project and its tools

```bash
cd nexsale-lead-engine
npm install
uv venv --python 3.11 .venv
uv pip install --python .venv requests python-dotenv pytest
cp .env.example .env
```

**Check:** `npm run test:unit` ends with all tests passed. `.venv/bin/python --version` shows Python 3.11.

From now on, every secret and setting goes into **`.env`** – never into any other file (`.env` is git-ignored). Open it
in a text editor; the following steps tell you which lines to fill.

### 3.2 Test inboxes and the safety allowlist

1. Create two Gmail accounts: **sender** (e.g. `firma.sender@gmail.com`) and **test prospect** (e.g. `firma.test@gmail.com`).
2. In `.env`:

```
SENDER_EMAIL=<sender address>
TEST_PROSPECT_EMAIL=<test prospect address>
TEST_RECIPIENT_ALLOWLIST=<sender address>,<test prospect address>
DEMO_MODE=true
ALLOW_REAL_SENDING=false
TEST_LEAD_LIMIT=10
AUTO_REPLY_MIN_CONFIDENCE=0.85
```

**Check:** `DEMO_MODE=true` and `ALLOW_REAL_SENDING=false`. With these two lines, no email can reach anyone except the
addresses on the allowlist.

### 3.3 Fixed public address (ngrok)

Slack must be able to reach your Mac when someone presses a button. ngrok gives you one address that never changes.

1. Sign up at https://dashboard.ngrok.com/signup.
2. **Getting Started → Your Authtoken** → copy it.
3. **Domains** → claim/create your free domain (looks like `something.ngrok-free.dev`).
4. In `.env`:

```
COMPOSE_PROFILES=tunnel
NGROK_AUTHTOKEN=<token>
NGROK_DOMAIN=<your domain, without https://>
WEBHOOK_URL=http://localhost:5678/
N8N_INTERNAL_URL=http://localhost:5678
```

`WEBHOOK_URL` stays **localhost** on purpose: it is n8n's own address and keeps the campaign form working. The tunnel
only forwards Slack's button clicks: `ngrok/policy.yml` answers every other path with 403, so the Control Center, the
dashboard and the n8n editor are never reachable from the internet.

### 3.4 Start n8n and create the API key

```bash
docker compose up -d
```

This starts n8n, its Postgres database and the ngrok tunnel.

1. Open http://localhost:5678 and create the owner account (any email and password – it is local).
2. **Settings → n8n API → Create an API key** → copy it into `.env`: `N8N_API_KEY=<key>`.
3. Choose the **Control Center login** and put it in `.env` (use a long random password):

```
CONTROL_USER=admin
CONTROL_PASSWORD=<long random password>
```

   It protects the Control Center, the dashboard and the campaign status page. Without it they stay locked.
4. Every time you change `.env`, restart n8n so it reads the new values:

```bash
docker compose up -d --force-recreate n8n
```

**Check:** `curl -s -o /dev/null -w "%{http_code}\n" https://<NGROK_DOMAIN>/webhook/dashboard` prints `403` (the tunnel
works and blocks everything except Slack clicks), and http://localhost:5678/webhook/app asks for the login.

### 3.5 Airtable (the database)

1. Create an empty base, e.g. "Nexsale Lead Engine". Its id (`app…`) is in the URL.
2. https://airtable.com/create/tokens → **Create token** with scopes `data.records:read`, `data.records:write`,
   `schema.bases:read`, `schema.bases:write` and access to that base.
3. In `.env`: `AIRTABLE_PAT=<token>` and `AIRTABLE_BASE_ID=<app…>`.
4. Create the 9 tables and the two demo clients:

```bash
.venv/bin/python setup/create_airtable_base.py
.venv/bin/python setup/seed_test_data.py --client-only
```

**Check:** the base has the tables Clients, Campaigns, Leads, Emails, Replies, Meetings, Blocklist, Logs, Tasks, and
Clients contains "Nexsale GmbH" (default) and "Real Service GmbH". Both scripts are safe to run again.

### 3.6 Google Places API (finding companies)

1. https://console.cloud.google.com → new project → **APIs & Services → Library → "Places API (New)" → Enable**.
2. **Billing**: link a billing account (free credit covers testing). **Budgets & alerts → €5 budget**.
3. **Credentials → Create credentials → API key** → restrict it to **Places API (New)**.
4. In `.env`: `GOOGLE_MAPS_API_KEY=<key>`.

Each Google request returns up to 20 companies; a 10-company campaign uses exactly 1 request.

### 3.7 OpenAI

1. https://platform.openai.com/api-keys → **Create new secret key**. Add a small prepaid balance (€5 is plenty).
2. In `.env`: `AI_PROVIDER=openai`, `AI_MODEL=gpt-4o-mini`, `OPENAI_API_KEY=<key>`.

### 3.8 Gmail login in n8n (sending and reading replies)

n8n sends from the **sender** account and watches its inbox for replies. Google needs an OAuth app for this:

1. Google Cloud (same project) → **APIs & Services → Library → Gmail API → Enable**.
2. **OAuth consent screen** → External → app name "Nexsale Lead Engine", support email = sender → add the **sender** address
   as **test user** → save. (Status "Testing" is fine.)
3. **Credentials → Create credentials → OAuth client ID** → type **Web application** → Authorized redirect URI:
   `http://localhost:5678/rest/oauth2-credential/callback` → create → copy client ID and secret.
4. In n8n: **Credentials → Add credential → "Gmail OAuth2 API"** → paste client ID and secret → **Sign in with Google**
   with the sender account → allow → save, name it `Gmail sender`.
5. Open the credential again; its id is the last part of the browser URL (`…/credentials/<id>`). In `.env`:
   `GMAIL_CREDENTIAL_ID=<id>`.

In "Testing" mode Google expires the login after **7 days**: open the credential and press **Sign in with Google** again
(do it the day before any demo).

### 3.9 Slack (clicks 2 and 3, notifications)

1. Create a channel **#leads** in your workspace.
2. https://api.slack.com/apps → **Create New App → From scratch** → pick the workspace.
3. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `chat:write.public` → **Install to Workspace** → copy the
   **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information → Signing Secret** → copy.
5. **Incoming Webhooks** → On → **Add New Webhook to Workspace** → channel #leads → copy the URL.
6. **Interactivity & Shortcuts** → On → Request URL: `https://<NGROK_DOMAIN>/webhook/slack-actions` → **Save Changes**.
7. In Slack, invite the app to #leads (`/invite @<app name>`).
8. In `.env`:

```
SLACK_BOT_TOKEN=xoxb-…
SLACK_SIGNING_SECRET=<signing secret>
SLACK_WEBHOOK_URL=<incoming webhook URL>
SLACK_CHANNEL=#leads
```

### 3.10 Calendly (bookings)

1. Create one event type, **15 minutes**. Copy its link (e.g. `https://calendly.com/<you>/15min`).
2. **Integrations & apps → API and webhooks → Personal access tokens** → generate a token (read access is enough).
3. In `.env`: `CALENDLY_LINK=<event link>`, `CALENDLY_TOKEN=<token>`. Leave `CALENDLY_WEBHOOK_SIGNING_KEY` empty – the free
   plan has no webhooks, so workflow `07d_calendly_poll` checks for new bookings every 3 minutes.
4. Optional (better meeting briefs): in the event's **Invitee questions** add e.g. "Fläche in m²?" and "Wann endet Ihr
   aktueller Vertrag?". The answers appear in the meeting brief automatically.

### 3.11 HubSpot (CRM)

1. HubSpot free CRM → **Settings → Integrations → Private apps** (newer accounts: **Development → Keys / Service keys**) →
   create a key with scopes `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`,
   `crm.objects.deals.read/write`.
2. In `.env`: `HUBSPOT_TOKEN=<token>`.

### 3.12 Deploy the workflows

```bash
docker compose up -d --force-recreate n8n      # reads the final .env
.venv/bin/python setup/deploy_workflows.py
```

The script imports all 23 workflows into n8n (or updates them – it matches by name), connects them with each other and
with the Gmail credential, and activates every workflow that has a trigger.

**Check:** in http://localhost:5678 all "Nexsale …" workflows are listed; those with a trigger show **Active** (13, 14 and
15 are sub-workflows and stay inactive, that is correct).

---

## 4. Configure the clients

Open the **Control Center → Clients** (http://localhost:5678/webhook/app?p=clients) → **+ Neuer Client** or click a client to
edit it. Each client is one company the system writes for. The form checks the input (required fields, unique name,
`https://` booking link) and saves it to Airtable. Fields:

| Field | Meaning | Example |
|---|---|---|
| `name` | exact name typed in the form's Client field | Real Service GmbH |
| `is_default` | ✔ on exactly one client: used when the form's Client field is empty | ✔ on Nexsale GmbH |
| `sender_name`, `sender_title`, `sender_company` | the signature and "Mein Name ist …" | Laura Schmidt, Vertrieb, Real Service GmbH |
| `sender_phone`, `sender_website` | optional signature lines | +49 30 …, https://… |
| `sender_company_footer` | legal footer line (Impressum data: company, address, managing director, register) | Real Service GmbH · Musterstr. 1 · … |
| `offer` | what this client sells, in 1–2 sentences. **The AI only promises what is written here.** | Wir übernehmen die Unterhaltsreinigung … |
| `qualifying_questions` | asked in the answer to interested leads | Wie groß ist die Fläche, wann endet Ihr Vertrag? |
| `calendly_link` | the client's booking link | https://calendly.com/… |
| `target_positive_replies`, `target_meetings` | monthly guarantee for the dashboard | 20, 4 |
| `target_segments` | notes for the team (who to target) | Hausverwaltungen, Hotels, Kliniken |

The demo data contains two clients:
- **Nexsale GmbH:** real public Impressum data, signed by David Gretschmann.
- **Real Service GmbH:** the sender "Laura Schmidt", the footer and the offer are **placeholders**. Replace them with the
  client's real data before using them outside a demo.

**New client:** Control Center → Clients → **+ Neuer Client**, fill the form, save. It appears immediately in the client
dropdown of "Neue Kampagne" and as a filter on the dashboard. No code change, no deployment. (Editing the Airtable row
directly also works.)

---

## 5. First check: is everything connected?

Run these in order. Each takes a minute.

| # | Do | Expected |
|---|---|---|
| 1 | Open http://localhost:5678/webhook/app and log in (`CONTROL_USER` / `CONTROL_PASSWORD`) | the Control Center "Übersicht" with your clients |
| 2 | **+ Neue Kampagne** | the campaign form with the client dropdown |
| 3 | Start a campaign: name "Test Leipzig", client Nexsale GmbH, industry "Reinigungsunternehmen", city "Leipzig", size 10-49, target role "Geschäftsführer, Inhaber", Max leads 15 | the campaign page; leads appear within about a minute, status changes to Ready |
| 4 | Slack #leads | "Campaign ready: Test Leipzig", For Nexsale GmbH, 3 samples, buttons |
| 5 | Press **Approve and launch** (in Slack or on the campaign page in the Control Center) | status Live; Slack shows "Approve and launch by …" and "… is live" |
| 6 | Test prospect inbox (check Spam the first time) | `[TEST] …` emails signed by the client's sender |
| 7 | Reply to one: *Klingt interessant, haben Sie nächste Woche Zeit?* | within ~2 minutes: an answer with the booking link and the qualifying questions in the same thread; Slack "Auto-answered …" |
| 8 | Book a slot through that link | within ~3 minutes: Slack "Meeting booked with …" with the meeting brief; a deal in HubSpot |

If a step fails, see section 12.

---

## 6. Daily use: running a campaign

### 6.0 The Control Center

Open **http://localhost:5678/webhook/app** (bookmark it) and log in. Areas in the left menu:

| Area | What you do there |
|---|---|
| **Übersicht** | what needs you now (replies to approve or sort, campaigns ready to launch or blocked, meetings to mark, open tasks, errors), guarantee per client, key figures |
| **Kampagnen** | every campaign with status and numbers; **Approve and launch**, **Pausieren**, **Fortsetzen**, **Beenden** |
| Campaign page | its leads (contact, source, email, score, quality, status, reason or trigger), costs, link to the live status page |
| Lead page | all details, the 4 emails, replies, meeting brief; **E-Mails neu schreiben** (before launch) and **Lead ausschließen** |
| **+ Neue Kampagne** | click 1, with a dropdown of your clients |
| **Antworten** | drafted answers to **edit and approve** (or discard), unclear replies to **sort**, all replies |
| **Termine** | upcoming and past meetings with the AI brief; **Hat stattgefunden / No-show** |
| **Clients** | add and edit clients |
| **System** | safety switches (test mode), open tasks (**Erledigt**), last errors, links to n8n and Airtable |
| **Dashboard ↗** | the results page (also password-protected) |

Every action shows a confirmation at the top of the page. Actions that Slack also offers (launch, approve, sort, held/no-show)
run through the very same workflow logic, so both always behave identically. A reply can never be approved twice.

### 6.1 Click 1 – the form

Use **Control Center → + Neue Kampagne** (recommended) or the standalone form **http://localhost:5678/form/campaign-setup**.

| Field | What to enter | Tips |
|---|---|---|
| Campaign name | anything you recognise later | "Hausverwaltungen Berlin – Real Service" |
| Client | empty = default client (Nexsale); otherwise the exact client name from Airtable | a typo stops the run with "Unknown client" |
| Industry (search term) | what you would type into Google Maps, in German | "Hausverwaltung", "Steuerberater", "Reinigungsunternehmen" – one industry per campaign |
| City | the city | Berlin, Hamburg, München and Wien are also searched district by district, so more companies are found there; other cities give at most 60 |
| Company size range | recorded for reporting | Google Maps has no employee counts, so it does not filter |
| Target role | who should receive the email, most wanted first, comma-separated | "Objektbetreuung, Hausverwalter, Geschäftsführer". A person with a matching role on the company's team/contact page is chosen; otherwise the managing director from the Impressum |
| Max leads | how many companies to collect (1–500) | empty = 10 in test mode. This counts companies found, not approved leads – roughly half to two thirds end up approved. Launch needs at least 5 approved leads in test mode, so use 12 or more |

Press **Submit**. You land on the **live status page**:
- it shows each step as it happens: found → Impressum checked → emails written,
- it refreshes itself,
- when it says "Kampagne bereit", go to Slack.

10 companies take about 1 minute, 25 about 4–5 minutes, 100 about 15 minutes.

### 6.2 What the system does before "Campaign ready"

- **Google Maps:** only as many requests as needed (10 companies = 1 request). Companies already in Airtable from any campaign are skipped.
- **Per company:**
  - reads the Impressum, team/contact and jobs pages,
  - chooses the contact person (verified on the page; "Herr/Frau" only if written there),
  - finds the published email (own domain first; the company's own Gmail-type address is accepted if it clearly belongs to the company),
  - checks that the email domain can receive mail,
  - scores the lead.
- **Rejected with a reason**, visible in Airtable: no Impressum, no email, score below 50, same person as another lead.
- **Email writing:** the AI writes 4 emails in the client's name. Code checks Nexsale's own rules:
  - email 1 under 90 words, in at least 2 paragraphs,
  - follow-ups at most 50 words,
  - subject at most 5 words,
  - formal "Sie", no filler, the last paragraph asks one question,
  - greeting, signature and legal footer added by code.

  An AI quality check then scores the sequence using quoted evidence: is the opening a real detail of this company, is
  anything invented? Below 80 → rewritten once → still below 80 → "Needs review" (not sent).

### 6.3 Click 2 – review (Slack or Control Center)

The "Campaign ready" message shows:
- the client and the sender,
- the number of approved leads, the average score and quality,
- 3 sample sequences.

**Open full list** shows every approved lead. In the Control Center, the campaign page shows every lead with its emails;
you can rewrite or exclude single leads before launching.

### 6.4 Click 3 – launch

**Approve and launch** (Slack button or Control Center campaign page) runs five checks:
- enough approved leads: **at least 5 in test mode, 20 in real mode** (so use Max leads of about 12+ in tests),
- complete sequences (4 emails, each passed the quality check),
- nobody on the Blocklist,
- nobody already being contacted in another live campaign,
- Gmail works.

Then the campaign goes Live. If a check fails, Slack lists what failed (e.g. "At least 5 Approved leads: 3") and nothing is sent.

---

## 7. What happens automatically after launch

### Sending

| | Test mode (`DEMO_MODE=true`) | Real mode |
|---|---|---|
| Recipient | always the test inbox, subject starts with `[TEST]` | the lead |
| Timing | email 1 now, follow-ups after 3, 7, 14 **minutes** | after 3, 7, 14 **days**, Mon–Fri 08:00–17:00 |
| Pace | a few per minute | 60–180 s apart, max 40 per campaign per day |

Follow-ups go in the same thread ("Re: …"). A reply stops the remaining follow-ups for that lead immediately.

### Replies

Every reply in the sender inbox is matched to its lead and sorted:

| Reply type | Example | What happens |
|---|---|---|
| Interested (AI ≥ 85 % sure) | "Klingt interessant, wann haben Sie Zeit?" | automatic answer with the client's booking link and qualifying questions; Slack info; lead → HubSpot |
| Interested (less sure) | | drafted answer in Slack with **Approve and send / Edit / Reject** |
| Question | "Was kostet das? Schicken Sie Infos." | drafted honest answer (never invents prices) in Slack for one-click approval |
| Referral | "Zuständig ist Frau Klein, klein@firma.de" | intro email to Frau Klein ("Herr X hat mich an Sie verwiesen …"), new lead, her reply is tracked. Without an address on the company's domain: a task |
| Later | "Melden Sie sich im Januar" | follow-up task on that date |
| Not interested | "Kein Bedarf" | lead closed; if a HubSpot deal existed it becomes Closed lost |
| STOP / unsubscribe | "Bitte keine E-Mails mehr" | Blocklist – never contacted again, in any campaign |
| Out of office | auto-reply | sequence paused until the return date |
| Bounce | undeliverable | lead Bounced, address blocked |
| Unclear | "Wer sind Sie?" | Slack asks you to sort it with buttons |
| Newsletter, not from a lead | | stored, no Slack message |

### Meetings

- **Booking via the link:** Slack "Meeting booked …" with an **AI meeting brief** (who, what the company does, why now, the
  booking answers, questions to ask). Saved on the lead and in HubSpot.
- **24 h before:** a reminder email to the lead.
- **After the meeting:** Slack asks "held or no-show?" (buttons). A no-show creates a call task.
- **Cancelled in Calendly:** the meeting is marked cancelled and the lead goes back to Interested.
- **"No" after booking by email:** the meeting is marked cancelled, Slack reminds you to cancel it in Calendly, and the HubSpot deal is Closed lost.

### HubSpot

Interested leads, bookings and meeting results create or update one contact, company and deal each (never duplicates),
with a note. The deal stage follows the lead: Interested / Meeting booked → appointment scheduled; Meeting held →
qualified to buy; No-show or a later "no" → closed lost.

### Reports

- Every hour the metrics are written to Airtable.
- Every Monday at 08:00 a weekly report goes to Slack and by email (in test mode to the test inbox).

---

## 8. Where to see what

| What | Where |
|---|---|
| **Control Center** (everything) | http://localhost:5678/webhook/app (login `CONTROL_USER` / `CONTROL_PASSWORD`) |
| Campaign form (click 1) | Control Center → + Neue Kampagne, or http://localhost:5678/form/campaign-setup |
| Live status of a campaign | opens after Submit; latest: http://localhost:5678/webhook/campaign-status |
| Dashboard (guarantee, funnel, costs, A/B test, replies, meetings) | http://localhost:5678/webhook/dashboard (same login) – buttons at the top filter per client; refreshes every minute |
| Clicks 2 and 3, all notifications, error alerts | Slack #leads |
| All data | Airtable: Campaigns, Leads (contact, `contact_source`, `trigger`, `reject_reason`, `needs_review_reason`, `meeting_brief`), Emails (`body`, `status`), Replies (`category`, `summary`, `suggested_reply`), Meetings, Tasks, Blocklist, Logs |
| Sent emails | sender Gmail → Sent; test emails arrive in the test prospect inbox |
| Every workflow run, step by step | http://localhost:5678 → Executions |
| Deals | HubSpot → Deals |
| Inbound quiz (leads that contact Nexsale) | http://localhost:5678/form/inbound-quiz |

**Delete a person (GDPR request):** this removes the lead and everything about them, and keeps only a Blocklist entry.

```bash
curl -X POST http://localhost:5678/webhook/delete-lead -H "Content-Type: application/json" -d '{"email":"person@firma.de"}'
```

---

## 9. Safety switches and going live

| Setting in `.env` | Effect |
|---|---|
| `DEMO_MODE=true` | every email goes to `TEST_PROSPECT_EMAIL` with `[TEST]`; days become minutes |
| `TEST_RECIPIENT_ALLOWLIST` | a guard right before the only send node stops the run if any recipient is not on this list (empty list = nothing is sent) |
| `ALLOW_REAL_SENDING=false` | even with `DEMO_MODE=false`, real sending stays blocked until this is `true` |
| Blocklist (Airtable) | checked before every single email |
| `CONTROL_PASSWORD` | login for the Control Center, dashboard and status page; empty = locked |
| `ngrok/policy.yml` | only `/webhook/slack-actions` (and `/webhook/calendly`) are reachable from the internet |

After changing `.env`: `docker compose up -d --force-recreate n8n`.

**Before switching to real sending:** work through `docs/datenschutz.md` section 5:
- the legal basis for cold email under § 7 UWG, confirmed per campaign,
- data processing agreements with Airtable, OpenAI, Google, HubSpot, Slack and Calendly,
- separate sending domains with SPF/DKIM/DMARC and warm-up (never the client's main domain),
- real sender and Impressum data for every client,
- a retention job.

Only then set `DEMO_MODE=false` **and** `ALLOW_REAL_SENDING=true`.

---

## 10. Testing

Four levels of automated tests. Levels 2–4 run on a **separate test n8n** (port 5679) where every external service is
replaced by a local fake server, so they cost nothing and send nothing.

### 10.1 Level 1 – unit tests (no setup needed)

```bash
npm test                                   # ~390 Jest tests on code/, 80 %+ coverage, writes docs/test_report.md
npm run lint:workflows                     # every workflow: error handler, retries, Berlin time, guard before every send
npm run scan:secrets                       # no key or token in any file except .env
.venv/bin/python -m pytest -q tests/python # setup scripts
```

### 10.2 Start the test stack (once per session)

```bash
.venv/bin/python tests/mock_server/server.py &
docker compose -p nexsale-test -f docker-compose.yml -f docker-compose.test.yml up -d
.venv/bin/python tests/n8n_bootstrap.py
.venv/bin/python setup/deploy_workflows.py --test-stack
```

### 10.3 Levels 2–4

```bash
.venv/bin/python tests/workflows/run_module.py all          # Level 2: every workflow on its own (19 scenarios)
.venv/bin/python tests/integration/run_integration.py all   # Level 3: chains, failures, safety
.venv/bin/python tests/e2e/run_e2e.py                       # Level 4: the full 3-click flow, twice in a row
```

- One workflow test: `run_module.py 07`.
- The scenario names are printed by `run_module.py all`.
- The safety tests (S1–S4) prove that an email to a real company address is blocked, that test mode rewrites every
  recipient, and that no secret is in any workflow file.

### 10.4 Tests with the real services

```bash
.venv/bin/python tests/e2e/run_e2e.py --live                # guided 3-click run on the real services (test mode)
.venv/bin/python tests/live/eval_email_quality.py --runs 2  # real-AI email quality measurement (~€0.02)
```

Results of every run: `docs/test_report.md`, raw results in `tests/results/`.

---

## 11. Changing the system (developer guide)

**Golden rule:** never edit `workflows/*.json` by hand. They are generated.

| You want to change | Edit | Then |
|---|---|---|
| Logic (scoring, checks, parsing, messages, dashboard) | `code/<module>.js` + its test in `code/__tests__/` | `npm test` |
| An AI prompt | `prompts/<name>.md` | build + deploy |
| A workflow's nodes or wiring | `scripts/workflows/<group>.js` (builder) | build + deploy |
| An Airtable field | `setup/schema.py` | `setup/create_airtable_base.py` (adds missing fields), restart the mock server for tests |

**Build and deploy:**

```bash
npm run build:workflows                          # code/ + prompts/ → workflows/*.json
npm test                                         # a test fails if the JSON is out of date
.venv/bin/python setup/deploy_workflows.py       # live n8n
.venv/bin/python setup/deploy_workflows.py --test-stack   # test n8n
```

**Project layout:**

```
code/        logic of every Code node (plain JS) + Jest tests
prompts/     AI prompts (Markdown, German)
scripts/     workflow builder (scripts/workflows/*.js), lint, secret scan, test report
workflows/   generated n8n JSON (one file per workflow) – do not edit
setup/       Airtable schema/base creation, seed data, deploy script
tests/       fake services (mock_server), fixtures, workflow/integration/e2e/live tests
docs/        this guide, architecture, decisions, data protection, demo script, test report
```

Design decisions with their reasons are numbered in `docs/decisions.md`. Read the relevant entry before changing a rule.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| localhost:5678 does not open | Docker Desktop not running | start Docker Desktop, then `docker compose up -d` |
| Control Center / dashboard keeps asking for the login, or says "CONTROL_PASSWORD is not set" | wrong user/password, or no password in `.env` | check `CONTROL_USER` / `CONTROL_PASSWORD` in `.env`, then `docker compose up -d --force-recreate n8n` |
| A Control Center action shows a red message | the action is not possible in this state (e.g. launch a Live campaign, rewrite after launch, approve twice) | the message says why; nothing was changed |
| The form keeps spinning after Submit | `WEBHOOK_URL` is not `http://localhost:5678/`, or the form was opened through the ngrok address | set `WEBHOOK_URL=http://localhost:5678/`, restart n8n, open the form on localhost |
| Slack: "could not handle this payload" when clicking a button | Slack cannot reach n8n | check `https://<NGROK_DOMAIN>/webhook/dashboard` returns 403 (tunnel up); check the Request URL in the Slack app is `https://<NGROK_DOMAIN>/webhook/slack-actions` and **saved**; `docker compose ps` shows `tunnel` running |
| No Slack messages at all | bot token wrong or bot not in #leads | check `SLACK_BOT_TOKEN`, `/invite` the app to #leads |
| A red error alert in Slack | a workflow failed; the alert names it | open n8n → Executions → the failed run shows the node and the message |
| No emails sent / guard error | recipient not on the allowlist, or Gmail login expired | check `TEST_RECIPIENT_ALLOWLIST`; open the Gmail credential in n8n → Sign in with Google |
| Replies are not picked up | Gmail login expired (7 days in Testing mode) or `07a_gmail_inbox` inactive | sign in again; activate the workflow |
| Bookings do not appear | `CALENDLY_TOKEN` wrong, or the booking was not made through the link in the answer | check the token; the link carries the lead id (`utm_content`) |
| Click 3 does nothing but Slack says "Launch blocked … At least 5 Approved leads" | too few approved leads for a launch (5 in test mode, 20 real) | run a campaign with a higher Max leads, or a bigger city |
| "Unknown field name" from Airtable | the base is older than the code | `.venv/bin/python setup/create_airtable_base.py` |
| "Unknown client" | the form's Client field does not exactly match a name in Clients | use the exact name, or leave empty for the default client |
| Fewer leads than Max leads | companies without website, already known from earlier campaigns, or a small city (max 60 per Google search) | expected; try a larger city or another industry term |
| Many leads "Needs review" | AI quality below 80 after one rewrite, or a rule failed after one retry | read `needs_review_reason` in Airtable; these are deliberately not sent |
| Many "no email found" rejections | the company publishes no email (contact form only) | expected – verified by hand for real cases |
| Emails land in Spam (test inbox) | new Gmail sender | mark as "Not spam" once |
| HubSpot error "INVALID_EMAIL" | HubSpot rejects `.example` test addresses | only real-looking addresses sync; test data on `.example` stays in Airtable |
| Changes in `.env` have no effect | n8n reads `.env` only at start | `docker compose up -d --force-recreate n8n` |

---

## 13. Reference

### Workflows

| Workflow | Job | Trigger |
|---|---|---|
| 00_error_handler | error alerts → Slack + Logs (error workflow of every workflow) | Error Trigger |
| 01_campaign_setup | campaign form (click 1) | Form `/form/campaign-setup` |
| 01b_campaign_status | live status page | GET `/webhook/campaign-status?id=` |
| 02_lead_sourcing | Google Places → leads (paged only as far as Max leads needs) | webhook `lead-sourcing` (from 01) |
| 03_enrichment | Impressum, team/contact, jobs pages → contact, email, trigger, score | every 5 min + webhook `enrichment-run` |
| 04_ai_emails | 4 emails per lead, checks, "Campaign ready" (click 2) | every 5 min + webhook `ai-emails-run` |
| 05_campaign_launch | pre-launch checks → Live (click 3) | Slack button / webhook `campaign-launch` |
| 06_sending | sending and follow-ups; daily bounce check | every minute (test) / every 15 min Mon–Fri 08–17; 17:30 |
| 07_replies | reply sorting and all reply branches | webhook `reply-ingest` |
| 07a_gmail_inbox | watches the sender inbox | Gmail trigger (every minute) |
| 07b_calendly | bookings and cancellations, meeting brief | webhook `calendly` (from 07d) |
| 07c_reminders | reminder 24 h before; "held or no-show?" | every hour |
| 07d_calendly_poll | reads new Calendly bookings (free plan) | every 3 min |
| 08_reporting | metrics (hourly), weekly report Monday 08:00 | schedule |
| 08b_dashboard | live dashboard | GET `/webhook/dashboard?client=` |
| 09_inbound_leads | quiz / ad leads → call task + Slack brief + confirmation | Form `/form/inbound-quiz`, webhook `inbound-lead` |
| 10_crm_sync | HubSpot contact, company, deal | webhook `crm-sync` + every 15 min |
| 11_slack_actions | every Slack button (signature-checked) and the same actions from the Control Center | webhook `slack-actions`; internal `control-action` (password key, local only) |
| 12_delete_lead | GDPR deletion, keeps a Blocklist entry | webhook `delete-lead` |
| 13_send_email | the **only** place that sends email: Blocklist + allowlist guard | sub-workflow |
| 14_ai_call | every AI call: prompt, JSON only, validated, one targeted retry | sub-workflow |
| 15_slack_notify | posts / updates Slack messages | sub-workflow |
| 16_control_center | the Control Center (pages + actions), login | GET `/webhook/app`, POST `/webhook/app-action` |

### Running costs (test mode, measured)

| Item | Cost |
|---|---|
| Google Places | 1 request per 20 companies; free within Google's free tier |
| OpenAI (gpt-4o-mini) | about €0.0006–0.001 per lead (summary, 4 emails, quality check, rewrites) |
| A 10-company campaign | about €0.01 |

### Further documents

| File | Content |
|---|---|
| `README.md` | short overview |
| `docs/decisions.md` | every design decision with its reason (numbered) |
| `docs/datenschutz.md` | data protection, § 7 UWG, processors, go-live checklist |
| `docs/demo_script.md` | the 6-minute interview demo |
| `docs/test_report.md` | latest test results |
| `docs/blockers.md` | original setup notes (this guide supersedes them) |
| `PLAN.md` | the original specification |
