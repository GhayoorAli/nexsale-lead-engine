"""Seeds test data: one client, one campaign, 5 fake leads (on .example domains) and 5 test replies.

The 5 replies (one per category) are posted to the 07_replies webhook so Module 7 sorts them,
exactly like Gmail would deliver them. All addresses are fictional; nothing is ever sent to them
(the guard rewrites to TEST_PROSPECT_EMAIL in DEMO_MODE).

Usage: python setup/seed_test_data.py [--no-replies] [--client-only]
"""
import argparse
import json
import os
import pathlib
import time

import requests
from dotenv import load_dotenv

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"

# Nexsale itself is the default client (its own outreach, signed by the managing director, real public Impressum);
# Real Service GmbH is a client campaign example (sender and offer are DEMO placeholders – replace with the client's data).
NEXSALE = {
    "name": "Nexsale GmbH", "industry": "B2B-Neukundengewinnung", "calendly_link": "https://calendly.com/nexsale/15min", "is_default": True,
    "sender_name": "David Gretschmann", "sender_title": "Geschäftsführer", "sender_company": "Nexsale GmbH", "sender_website": "https://www.nexsale-consulting.de",
    "sender_company_footer": "Nexsale GmbH · Anklamer Str. 31, 10115 Berlin · Geschäftsführer: David Gretschmann · Amtsgericht Charlottenburg, HRB 288079",
    "offer": "Wir gewinnen für B2B-Unternehmen planbar Neukunden: Wir identifizieren die Wunschkunden, sprechen die Entscheider persönlich per E-Mail an, "
             "qualifizieren die Antworten vor und legen nur Termine mit echtem Bedarf in den Kalender – ohne Cold Calling.",
    "qualifying_questions": "Welche Kundengruppen möchten Sie gewinnen, und wie gewinnen Sie Neukunden heute?",
    "target_positive_replies": 20, "target_meetings": 4, "slack_channel": "#leads",
}
CLIENT = {
    "name": "Real Service GmbH", "industry": "Gebäudereinigung", "calendly_link": "https://calendly.com/nexsale-demo/15min", "is_default": False,
    "sender_name": "Laura Schmidt", "sender_title": "Vertrieb", "sender_company": "Real Service GmbH", "sender_company_footer": "Real Service GmbH · Gebäudereinigung · Berlin",
    "offer": "Wir übernehmen die regelmäßige Unterhaltsreinigung von Wohnanlagen, Treppenhäusern, Büros und Praxen in Berlin – mit festen Teams, "
             "festen Zeiten und dokumentierter Qualitätskontrolle.",
    "qualifying_questions": "Wie groß ist die zu reinigende Fläche ungefähr, und wann endet Ihr aktueller Reinigungsvertrag?",
    "target_segments": "Hausverwaltungen, Hotels, Kliniken & Praxen, Schulen & Kitas",
    "target_positive_replies": 20, "target_meetings": 4, "slack_channel": "#leads",
}
LEADS = [
    ("Seed Reinigung Eins GmbH", "seed-eins.example", "Eva Eins", "e.eins@seed-eins.example"),
    ("Seed Reinigung Zwei GmbH", "seed-zwei.example", "Zoe Zwei", "z.zwei@seed-zwei.example"),
    ("Seed Reinigung Drei GmbH", "seed-drei.example", "Dirk Drei", "d.drei@seed-drei.example"),
    ("Seed Reinigung Vier GmbH", "seed-vier.example", "Vera Vier", "v.vier@seed-vier.example"),
    ("Seed Reinigung Fünf GmbH", "seed-fuenf.example", "Felix Fünf", "f.fuenf@seed-fuenf.example"),
]
REPLY_FIXTURES = ["interested_01", "later_01", "not_interested_01", "unsubscribe_01", "ooo_01"]


class Base:
    def __init__(self, pat, base_id, api_url):
        self.url = f"{api_url.rstrip('/')}/{base_id}"
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {pat}", "Content-Type": "application/json"})

    def list(self, table, formula=None):
        params = {"pageSize": 100}
        if formula:
            params["filterByFormula"] = formula
        r = self.s.get(f"{self.url}/{table}", params=params, timeout=30)
        r.raise_for_status()
        return r.json()["records"]

    def create(self, table, fields_list):
        out = []
        for i in range(0, len(fields_list), 10):  # batches of 10
            r = self.s.post(f"{self.url}/{table}", json={"records": [{"fields": f} for f in fields_list[i:i + 10]], "typecast": True}, timeout=30)
            r.raise_for_status()
            out += r.json()["records"]
            time.sleep(0.25)
        return out


def seed(base, n8n_url, replies=True, leads=True, log=print):
    clients = base.list("Clients")
    names = {c["fields"].get("name") for c in clients}
    if NEXSALE["name"] not in names:  # each client is created once, whatever already exists
        base.create("Clients", [NEXSALE])
    client = next((c for c in clients if c["fields"].get("name") == CLIENT["name"]), None) or base.create("Clients", [CLIENT])[0]
    result = {"client": client["id"], "leads": [], "emails": [], "replies": []}
    if leads:
        camp = base.create("Campaigns", [{"name": "Seed campaign (test data)", "client": [client["id"]], "client_record_id": client["id"], "industry": "Reinigungsunternehmen",
                                         "city": "Berlin", "status": "Live", "daily_limit": 40, "target_role": "Geschäftsführer"}])[0]
        now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        lead_recs = base.create("Leads", [{"company_name": n, "domain": d, "website": f"https://{d}", "contact_name": c, "contact_role": "Geschäftsführer", "email": e,
                                           "campaign": [camp["id"]], "campaign_record_id": camp["id"], "status": "Contacted", "lead_type": "Outbound",
                                           "source": "Seed data (fictional)", "sourced_at": now, "score": 80, "sequence_step": 2, "first_sent_at": now} for n, d, c, e in LEADS])
        emails = base.create("Emails", [{"key": f"{l['fields']['company_name']} · step 1", "lead": [l["id"]], "lead_record_id": l["id"], "campaign_record_id": camp["id"],
                                         "step": 1, "subject": "Unterhaltsreinigung", "body": "Seed", "status": "Sent", "approved": True, "quality_score": 90,
                                         "sent_at": now, "thread_id": f"thr-seed-{i}", "gmail_message_id": f"msg-seed-{i}"} for i, l in enumerate(lead_recs)])
        result.update(campaign=camp["id"], leads=[l["id"] for l in lead_recs], emails=[e["id"] for e in emails])
        log(f"seeded client, campaign, {len(lead_recs)} leads, {len(emails)} sent emails")
    if replies and leads:
        for i, key in enumerate(REPLY_FIXTURES):
            fx = json.loads((FIX / "replies" / f"{key}.json").read_text(encoding="utf-8"))
            msg = {"message_id": f"seed-reply-{i}", "thread_id": f"thr-seed-{i}", "from": LEADS[i][3], "subject": fx["subject"], "body": fx["body"],
                   "received_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "auto_submitted": fx.get("auto_submitted", "")}
            r = requests.post(f"{n8n_url.rstrip('/')}/webhook/reply-ingest", json=msg, timeout=30)
            result["replies"].append({"fixture": key, "status": r.status_code})
            log(f"posted reply {key} -> {r.status_code}")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-replies", action="store_true")
    ap.add_argument("--client-only", action="store_true", help="only the client record (for the real demo base)")
    a = ap.parse_args()
    load_dotenv(ROOT / ".env")
    base = Base(os.environ.get("AIRTABLE_PAT", ""), os.environ.get("AIRTABLE_BASE_ID", ""), os.environ.get("AIRTABLE_API_URL", "https://api.airtable.com/v0"))
    seed(base, os.environ.get("N8N_URL", "http://localhost:5678"), replies=not (a.no_replies or a.client_only), leads=not a.client_only)


if __name__ == "__main__":
    main()
