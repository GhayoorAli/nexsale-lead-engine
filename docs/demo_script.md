# Demo script (6 minutes)

Before the interview: re-login Gmail in n8n the day before (7-day token), start Docker Desktop (`docker compose up -d`
starts n8n and the fixed ngrok tunnel), run one full test (`npm test` + `python tests/workflows/run_module.py all`), and
keep the screen recording open in a second tab. Tabs ready: the campaign form (`http://localhost:5678/form/campaign-setup`),
Slack #leads, the test inbox, the dashboard (`http://localhost:5678/webhook/dashboard`), Airtable, HubSpot deals.
Test mode stays on: every email goes only to the test inbox with `[TEST]`.

| Time | Step | What to show and say |
|---|---|---|
| 0:00 | **The problem** | "Your website says lead research and reply checking are done by people. I automated both: a campaign launches in three clicks, for Nexsale itself or in a client's name, and a person is asked only when the AI is unsure." Show `docs/architecture.png`. |
| 0:30 | **Click 1 – a client campaign** | Form: *Hausverwaltungen Berlin*, client **Real Service GmbH**, target role *Objektbetreuung, Geschäftsführer*, Max leads 10. The page switches to the live status page: companies found → Impressum and team pages checked → emails written. "The right person is taken from the team page if the role matches; every name, email and trigger must literally be on the page, otherwise it is dropped." |
| 1:30 | **Click 2 – quality** | "Campaign ready" in Slack: for Real Service, sender Laura Schmidt, 3 samples. Open one: formal salutation, a real detail from the company's site, Real Service's offer, one question, signature and legal footer. "Nexsale's own blog rules are enforced in code: under 90 words, follow-ups ≤ 50, 5-word subject, no filler – then an evidence-based AI check with a rewrite." |
| 2:30 | **Click 3 – launch** | "Approve and launch" → Live → the first `[TEST]` email in the test inbox. "A guard before the only send node blocks every address that is not on the allowlist." |
| 3:00 | **Replies** | Reply *Klingt interessant, haben Sie nächste Woche Zeit?* → automatic answer with the client's booking link and qualifying questions. Mention: questions ("Was kostet das?") get a drafted answer for one-click approval; "wenden Sie sich an Frau X" → intro email to Frau X; STOP → Blocklist. |
| 4:00 | **Meeting** | Book the slot → Slack "Meeting booked" with the **AI meeting brief** (who, what, why now, what to ask) → HubSpot deal with the brief as note. |
| 4:45 | **Dashboard** | Guarantee per client (positive replies vs 20, meetings vs 4–5) with on-track / behind for today's date, funnel, cost per meeting, A/B subject test. |
| 5:30 | **Close** | "In production: Instantly or Smartlead with warmed-up sending domains, a lead database like Apollo next to Google Maps, n8n on a server. Which CRM and sending tool do you use today?" Data protection: `docs/datenschutz.md` (§ 7 UWG, processors, deletion). |

**If something fails live:** switch to the recording. Errors are not silent: show the Slack alert from `00_error_handler`
and the Logs table.

**Likely questions** – see "Interview talking points" in PLAN.md (n8n vs Make/Zapier, Places API vs scraping, where a
person still decides, deliverability, multi-client scaling, cost per lead) and `docs/decisions.md` #43–#51.
