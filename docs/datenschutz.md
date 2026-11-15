# Data protection and legal notes (one page)

What the Lead Engine processes, why, where it goes, and what still has to be decided before real sending.
This is an engineering summary for the team, **not legal advice**; the open points need a lawyer's or DPO's sign-off.

## 1. What data, from where

| Data | Source | Why |
|---|---|---|
| Company name, address, phone, website, rating | Google Places API (public business listing) | find companies that fit the campaign |
| Contact person (name, role, Herr/Frau), business email | the company's **own public pages**: Impressum, team/contact page, homepage (never pages behind a login) | address the right decision-maker |
| Company facts, a trigger (e.g. a job ad) | the same public pages, summarised by the AI | personalise the first email; only facts that are verifiably on the page are kept |
| Replies, meeting bookings, booking-form answers | the prospect's own replies and Calendly booking | sort replies, book and prepare meetings |

Every lead stores `source` and `sourced_at`; the email footer says where the contact data comes from (Art. 14 GDPR information).

## 2. Legal basis and cold email

- **GDPR:** processing of business contact data for B2B outreach is based on legitimate interest (Art. 6(1)(f)); the right to
  object (Art. 21) is honoured immediately: a reply "STOP" (or similar) puts the address on the Blocklist, checked before
  **every** send and in every future campaign.
- **§ 7 UWG (German unfair competition law):** email advertising generally needs **prior consent, also in B2B**; only a narrow
  "presumed interest" exception exists, decided case by case. Nexsale's own Wissen FAQ says the same. → **Open point 1:** the
  legal basis for real cold sending must be confirmed per campaign/client before `DEMO_MODE` is switched off.
- **Demo safety (active now):** `DEMO_MODE=true` sends every email only to the test inbox with `[TEST]`; a guard before the only
  send node blocks any recipient not on `TEST_RECIPIENT_ALLOWLIST`; real sending needs `DEMO_MODE=false` **and**
  `ALLOW_REAL_SENDING=true`. Tested in every test run (safety tests S1, S2).

## 3. Processors (data leaves our system to)

| Service | Data | Region / transfer | Contract needed |
|---|---|---|---|
| Airtable | all lead, email and reply data | USA (EU-US Data Privacy Framework) | DPA (AVV) |
| OpenAI (AI_PROVIDER) | company text, contact name, reply text | USA; EU data residency available | DPA; consider EU processing or Anthropic/EU model |
| Google (Gmail, Places) | emails sent and received; search queries | EU/USA (DPF) | DPA (Workspace) |
| HubSpot | interested leads only (contact, company, deal) | EU data centre available | DPA |
| Slack | lead names, reply summaries, meeting briefs | USA (DPF) | DPA |
| Calendly | invitee name, email, booking answers | USA (DPF) | DPA (Nexsale already lists Calendly) |

→ **Open point 2:** Nexsale's privacy notice currently names none of Airtable, OpenAI, HubSpot or Slack; add them before go-live.

## 4. Minimisation, retention, deletion

- Only business contact data is stored; no private social profiles, no scraping behind logins.
- Access: the Control Center, dashboard and status page need a password (`CONTROL_PASSWORD`); from the internet only
  Slack's button endpoint is reachable (`ngrok/policy.yml`), never the data pages or the n8n editor.
- Only leads with interest go to HubSpot; a later "no" closes the deal (Closed lost) instead of keeping an open opportunity.
- **Deletion on request:** workflow `12_delete_lead` (GDPR) removes a person from Airtable (lead, emails, replies, meetings,
  tasks, logs) and keeps only the address on the Blocklist so they are never contacted again.
- → **Open point 3:** automatic retention, e.g. delete leads that were never contacted after 6 months and contacted leads 12
  months after the last activity (a scheduled workflow; not built yet).

## 5. Before real sending (checklist)

1. Legal basis per campaign confirmed (§ 7 UWG); otherwise stay in `DEMO_MODE`.
2. DPAs signed with all processors above; privacy notice updated.
3. Separate sending domains with SPF/DKIM/DMARC and warm-up (never the client's main domain).
4. Real sender name and Impressum data per client in Airtable (`Clients`).
5. Retention job (open point 3) scheduled.
