# Manual test guide – every function, step by step

Test mode stays on the whole time (`DEMO_MODE=true`): every prospect email goes to the **test prospect inbox**, internal
emails go to the **sender inbox**. You play both sides: you run the campaign, and you answer as the "company" from the
test prospect inbox.

**Have open:** the Control Center http://localhost:5678/webhook/app (login `CONTROL_USER` / `CONTROL_PASSWORD` from
`.env`), Slack #leads, both Gmail inboxes, Calendly → Scheduled events, HubSpot → Deals, and n8n → Executions
(http://localhost:5678) to see any run step by step.

**Before you start:** `docker compose up -d` (n8n + tunnel), Docker Desktop running. Optional fresh start: empty the
Airtable tables (keep Clients) and delete the HubSpot test deals.

**How to reply as the company:** in the test prospect inbox open the email and press **Reply** (stay in the same thread,
because that is how a reply is matched to its lead). Replies are picked up within ~1–2 minutes.

---

## A. Before launch (clicks 1 and 2)

| # | Do | Expected |
|---|---|---|
| A1 | Control Center → **+ Neue Kampagne**: name "Test Leipzig", client Nexsale GmbH, industry "Reinigungsunternehmen", city "Leipzig", size 10-49, target role "Geschäftsführer, Inhaber", **Max leads 10** → Start | redirected to the campaigns list; the campaign shows Sourcing |
| A2 | Open the campaign and wait 1–3 minutes (reload) | leads appear: found → checked (Impressum, contact, email) → emails written; status **Ready** |
| A3 | Check **Max leads**: count the leads | about 10 (fewer only if companies had no website or were already known) |
| A4 | Slack #leads | **"Campaign ready: Test Leipzig"** with facts, 3 sample emails and the button **Approve and launch** |
| A5 | Sender inbox | the internal email **"Kampagne bereit: Test Leipzig"** (professional layout). The test prospect inbox gets **nothing** |
| A6 | Open a lead → read its 4 emails | salutation (Herr/Frau + name), short personal first email with paragraphs and a closing question, signature David Gretschmann, Nexsale Impressum footer, no "[TEST]" in the subject |
| A7 | Rejected leads (campaign page) | each has a reason, e.g. "no email found in Impressum" |

**Improve emails before launch (features 1, 3, 5):**

| # | Do | Expected |
|---|---|---|
| A8 | Lead page → edit an email's subject or text → save | saved; salutation, signature and footer added automatically |
| A9 | Edit an email so it breaks a rule (e.g. 150 words or a 9-word subject) → save | refused with the rule that was broken |
| A10 | Clients → Nexsale GmbH → **writing notes**, e.g. "Immer Sie-Form, Fokus auf planbare Termine" → save | saved |
| A11 | Campaign page → **Alle E-Mails neu schreiben** | emails are rewritten within a few minutes and follow the notes |
| A12 | A lead with status Needs review (if any) → **Lead freigeben** | lead Approved, included in the launch |
| A13 | Lead page → **Lead ausschließen** | lead excluded, not sent |
| A14 | New campaign for **Real Service GmbH** in **München** (area is Berlin), or with industry **Reinigungsunternehmen** (its own industry) | red warning after creating and on the campaign page; Slack "Campaign ready" shows **Check before launch** with the reason |
| A15 | A held lead: read the reason on the campaign page, open the lead, fix the draft, **Lead freigeben** | lead Approved; if the campaign is already live, its email 1 goes out with the next send |

## B. Launch (click 3) and sending

| # | Do | Expected |
|---|---|---|
| B1 | Slack: **Approve and launch** (or the button on the campaign page) | Slack "Approve and launch by …", then "… is live"; campaign **Live** |
| B2 | Test prospect inbox (check Spam the first time) | email 1 for each lead, a few per minute |
| B3 | Wait 3, 7, 14 minutes (test-mode timing) | follow-ups 2–4 arrive **in the same thread** ("Re: …") |
| B4 | Campaign page → **Pausieren**, wait 5 minutes | nothing more is sent; **Fortsetzen** → Live again |

## C. Replies – one per lead (use a different lead's thread for each)

Reply with exactly these texts:

| # | Reply text | Expected (within ~2 min) |
|---|---|---|
| C1 Interested | *Klingt interessant, haben Sie nächste Woche Zeit?* | automatic answer in the thread with the booking link and qualifying questions; Slack "Auto-answered …"; follow-ups for this lead stop; contact + deal in HubSpot |
| C2 Question | *Was kostet das? Schicken Sie mir bitte Infos.* | Slack: drafted answer with **Approve and send / Reject** (also on Control Center → Antworten). Edit the text there and approve → exactly your text arrives in the thread |
| C3 Referral | *Zuständig ist Frau Klein, klein@<the lead's company domain>* (domain: see the lead's email on its lead page) | intro email "… hat mich an Sie verwiesen" (arrives in the test inbox), a new lead "Klein"; Slack note |
| C4 Later | *Melden Sie sich bitte im Januar wieder.* | follow-up task with a January date; Slack note |
| C5 Not interested | *Kein Bedarf, danke.* | lead Not interested, follow-ups stop; Slack "not interested, lead closed" |
| C6 STOP | *Bitte keine E-Mails mehr.* | lead Unsubscribed, address on the **Blocklist** (Airtable) |
| C7 Unclear | *Wer sind Sie überhaupt?* | Slack asks you to sort it (buttons Interested / Later / Not interested / Unsubscribe). Click one → the matching flow runs |
| C8 Out of office | *Ich bin bis zum 30.11. nicht im Büro.* | sequence paused until the return date; Slack note |

## D. Meetings and Calendly

| # | Do | Expected |
|---|---|---|
| D1 | In the C1 answer click the booking link, book the **earliest** slot with the test prospect address | within ~3 min: Slack **"Meeting booked with …"** with the AI meeting brief; lead Meeting booked; HubSpot deal "appointment scheduled"; Control Center → Termine lists it |
| D2 | Reminder (slot within 24 h): run `curl -X POST http://localhost:5678/webhook/reminders-run` | reminder email in the test inbox; meeting status Reminded |
| D3 | **Auto-cancel on "no":** in the same thread reply *Kein Interesse mehr, bitte den Termin absagen.* | within ~2 min: event gone from Calendly → Scheduled events; Calendly's cancellation email in the test inbox; meeting Cancelled; HubSpot deal Closed lost; Slack "withdrew after showing interest … cancelled in Calendly automatically" |
| D4 | **Cancel by hand:** book again with another interested lead (repeat C1 + D1), then Control Center → Termine → **Termin absagen** | same cancel in Calendly; lead back to Interested; Slack "Meeting with … cancelled (also in Calendly …)" |
| D5 | **Cancelled by the prospect:** book again, then cancel it in the Calendly confirmation email | within ~3 min: meeting Cancelled, lead back to Interested, Slack ":x: Meeting cancelled" |
| D6 | **Held / no-show:** book a slot, wait until 15 min after its start | Slack asks "held or no-show?" (also on Termine). **Hat stattgefunden** → HubSpot "qualified to buy"; **No-show** → call task + Closed lost |

## E. Stop rules and Blocklist

| # | Do | Expected |
|---|---|---|
| E1 | Start a second campaign with the **same** industry and city | the company that said STOP (C6) and the leads of the first campaign are **not** contacted again |

## F. Inbound, reports, dashboard, GDPR

| # | Do | Expected |
|---|---|---|
| F1 | Fill the quiz http://localhost:5678/form/inbound-quiz (use the test prospect address) | within 1 min: confirmation email, Slack brief with **Mark called**, call task (hot lead: due in 15 min) |
| F2 | Dashboard http://localhost:5678/webhook/dashboard | funnel, costs, replies, meetings, guarantee progress; client buttons filter |
| F3 | Weekly report now: `curl -X POST http://localhost:5678/webhook/reporting-run -H "Content-Type: application/json" -d '{"weekly":true}'` | AI summary in Slack and as an email to the sender inbox |
| F4 | GDPR delete: `curl -X POST http://localhost:5678/webhook/delete-lead -H "Content-Type: application/json" -d '{"email":"<a lead email>"}'` | lead, emails, replies, meetings, tasks removed from Airtable; only a Blocklist entry stays |
| F5 | Control Center → **System** | test mode on, allowlist, recent errors and open tasks |

## G. Safety (run these, do not try real addresses by hand)

```bash
.venv/bin/python tests/integration/run_integration.py safety
```

S1: an email to a real company address is blocked. S2: test mode sends prospect emails to the test inbox only. S3:
Google requests follow Max leads. S4: no secret in any workflow file.

These run on the test stack (mock server + n8n on :5679, see HANDOVER 10.2), never on real services.

---

**If something does not happen:** n8n → Executions shows the failed run and node; a red alert in Slack names the
workflow. Common causes: Gmail login expired (re-sign in the "Gmail sender" credential), Docker not running, or the
reply was sent as a new email instead of a reply in the thread. See HANDOVER section 12.
