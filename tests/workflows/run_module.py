"""Level 2 – workflow tests: one n8n workflow at a time, external APIs replaced by fixtures.

Each scenario seeds the mock Airtable, triggers the workflow through its webhook or form,
waits for the run, checks the execution status through the n8n API executions endpoint,
then checks Airtable and Slack (and the mock Gmail "test inbox").

Usage:  python tests/workflows/run_module.py <module|all>     e.g. 02, 07, all
Needs:  mock server on :8787 and the test stack on :5679 with workflows deployed (--test-stack).
"""
import hashlib
import hmac
import json
import pathlib
import sys
import time
import traceback
import urllib.parse
from datetime import datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from lib import FIX, Mock, Stack, fixture  # noqa: E402

SIGNING_SECRET = "test_signing_secret_not_real"  # from tests/test.env (test-only value)
PROSPECT = "prospect.test@nexsale-demo.test"
SENDER = "sender.test@nexsale-demo.test"
AUTH = ("admin", "test-control-password-1")  # Control Center login from tests/test.env (test-only value)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def now():
    return datetime.now(timezone.utc)


class Check:
    def __init__(self, name):
        self.name = name
        self.results = []

    def ok(self, cond, what, detail=""):
        self.results.append({"check": what, "pass": bool(cond), "detail": str(detail)[:300]})
        return bool(cond)

    @property
    def passed(self):
        return all(r["pass"] for r in self.results) and bool(self.results)


# ------------------------------------------------------------------ seeding helpers
def client_id(mock):
    return mock.table("Clients")[0]["id"]


def seed_campaign(mock, status="Sourcing", **extra):
    f = {"name": "Cleaning companies Berlin", "client": [client_id(mock)], "client_record_id": client_id(mock), "industry": "Reinigungsunternehmen",
         "city": "Berlin", "company_size": "10-49", "target_role": "Geschäftsführer", "max_leads": 10, "status": status, "daily_limit": 40,
         "google_api_requests": 0, "google_api_cost_eur": 0, "ai_cost_eur": 0}
    f.update(extra)
    return mock.seed("Campaigns", [f])[0]


def seed_leads(mock, camp_id, n=8, status="Approved", **extra):
    recs = []
    for i in range(n):
        f = {"company_name": f"Testfirma {i + 1} GmbH", "domain": f"testfirma{i + 1}.example", "website": f"https://testfirma{i + 1}.example",
             "email": f"gf{i + 1}@testfirma{i + 1}.example", "contact_name": f"Max Muster{i + 1}", "contact_role": "Geschäftsführer",
             "campaign": [camp_id], "campaign_record_id": camp_id, "status": status, "score": 85, "quality_score": 88, "city": "Berlin",
             "company_summary": "Testfirma bietet Büroreinigung in Berlin an. Kunden sind Praxen und Büros.", "lead_type": "Outbound",
             "source": "Google Places API", "sourced_at": iso(now())}
        f.update(extra)
        recs.append(f)
    return mock.seed("Leads", recs)


def seed_emails(mock, leads, status="Approved", quality=88):
    recs = []
    for l in leads:
        for step in (1, 2, 3, 4):
            recs.append({"key": f"{l['fields']['company_name']} · step {step}", "lead": [l["id"]], "lead_record_id": l["id"],
                         "campaign_record_id": l["fields"]["campaign_record_id"], "step": step, "subject": f"Betreff {step} für {l['fields']['company_name']}",
                         "subject_b": "Alternativer Betreff" if step == 1 else None, "approved": quality >= 80, "quality_score": quality, "status": status,
                         "body": f"Guten Tag,\n\nText für Schritt {step}.\n\nViele Grüße\nAnna Berger\n\n-- \nNexsale GmbH (Demo)\nAntworten Sie mit STOP, wenn Sie keine weiteren E-Mails erhalten möchten."})
    return mock.seed("Emails", recs)


def seed_contacted_lead(mock, email="t.becker@glanzwerk-berlin.example", company="Glanzwerk Gebäudereinigung GmbH", thread="thr-test-1"):
    camp = seed_campaign(mock, status="Live")
    lead = seed_leads(mock, camp["id"], n=1, status="Contacted", email=email, company_name=company, contact_name="Thomas Becker",
                      sequence_step=2, next_send_at=iso(now() + timedelta(minutes=3)), first_sent_at=iso(now()))[0]
    em = seed_emails(mock, [lead])
    mock_patch(mock, "Emails", em[0]["id"], {"status": "Sent", "thread_id": thread, "sent_at": iso(now()), "subject_sent": "[TEST] Unterhaltsreinigung bei Glanzwerk"})
    return camp, lead, em


def mock_patch(mock, table, rid, fields):
    import requests
    requests.patch(f"{mock.base}/airtable/v0/appMOCKBASE000001/{table}", json={"records": [{"id": rid, "fields": fields}]}, timeout=5).raise_for_status()


def slack_signed(payload, ts=None, secret=SIGNING_SECRET):
    body = "payload=" + urllib.parse.quote(json.dumps(payload), safe="")
    ts = str(ts or int(time.time()))
    sig = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:{body}".encode(), hashlib.sha256).hexdigest()
    return body, {"Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig}


def slack_click(action, value, ts="1763110000.000100"):
    p = fixture("webhooks/slack_button_click.json")
    p["actions"] = [{"action_id": action, "value": value, "type": "button"}]
    p["message"]["ts"] = ts
    p["container"]["message_ts"] = ts
    p["message"]["blocks"] = [{"type": "section", "text": {"type": "mrkdwn", "text": "original"}}, {"type": "actions", "elements": []}]
    return p


MOCK = Mock()
CHAIN = ["02_lead_sourcing", "03_enrichment", "04_ai_emails"]


def run(stack, trigger, expect=None, timeout=150):
    since = stack.last_execution_id()
    resp = trigger()
    expect = list(expect or [])
    form_exec = None
    try:  # the form answers with {"formWaitingUrl": ".../form-waiting/<execution id>"}
        url = resp.json().get("formWaitingUrl", "") if resp is not None and hasattr(resp, "json") else ""
        form_exec = url.rstrip("/").rsplit("/", 1)[-1] if url else None
    except ValueError:
        pass
    if form_exec:
        expect = [e for e in expect if e != "01_campaign_setup"]
    ex = stack.wait_idle(since, expect=expect, timeout=timeout, mock=MOCK)
    st = stack.status_by_workflow([e for e in ex if not (form_exec and e["id"] == form_exec)])
    if form_exec:
        st["01_campaign_setup"] = [stack.api.execution(form_exec, include_data=False)["status"]]
    rejected = MOCK.state().get("airtable_rejected", [])
    if rejected:  # real Airtable would have refused these writes – never let that pass silently
        raise AssertionError("Airtable rejected writes: " + "; ".join(f"{r['table']} {r['method']}: {r['error']}" for r in rejected[:5]))
    return resp, ex, st


def all_success(c, statuses, expect=None):
    # a Form-ending page keeps the form execution in status "waiting"; that is its normal end state
    bad = {k: v for k, v in statuses.items() if any(s != "success" and not (k == "01_campaign_setup" and s == "waiting") for s in v)}
    c.ok(not bad, "every execution has status success", bad or statuses)
    for stem in expect or []:
        c.ok(stem in statuses, f"{stem} ran", statuses)


# ------------------------------------------------------------------ scenarios
def t00_error_handler(stack, mock):
    c = Check("00 error handler / Google 500 → 3 retries → Slack")
    mock.reset()
    camp = seed_campaign(mock)
    mock.fail("google", 500, 3)
    _, ex, st = run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=["02_lead_sourcing", "00_error_handler"], timeout=90)
    s = mock.state()
    g = [r for r in s["requests"] if r["service"] == "google"]
    c.ok(len(g) == 3, "Google API was tried 3 times (retry on fail)", len(g))
    c.ok(st.get("02_lead_sourcing") == ["error"], "02 execution status error", st)
    c.ok("00_error_handler" in st and st["00_error_handler"] == ["success"], "error workflow ran", st)
    msgs = [m.get("text", "") for m in s["slack_webhook"]]
    c.ok(any("Nexsale 02" in m and "Node:" in m and "500" in m for m in msgs), "Slack alert names the workflow, the node and the error", msgs)
    logs = mock.table("Logs")
    c.ok(len(logs) == 1 and logs[0]["level"] == "error" and "Nexsale 02" in logs[0]["workflow"], "error written to Logs", logs)
    c.ok(len(mock.table("Leads")) == 0, "no partial leads written", len(mock.table("Leads")))
    return c


def t01_campaign_setup(stack, mock):
    c = Check("01 campaign setup form")
    mock.reset()
    form = {"Campaign name": "Cleaning companies Berlin", "Industry (search term)": "Reinigungsunternehmen", "City": "Berlin", "Company size range": "10-49", "Target role": "Geschäftsführer", "Max leads": "10"}
    t0 = time.time()
    resp, ex, st = run(stack, lambda: stack.submit_form(form), expect=["01_campaign_setup"] + CHAIN)
    camps = mock.table("Campaigns")
    c.ok(resp.status_code == 200, "form accepted", resp.status_code)
    c.ok(len(camps) == 1 and camps[0]["status"] in ("Sourcing", "Ready"), "one campaign created with status Sourcing", camps)
    first_google = next((r for r in mock.state()["requests"] if r["service"] == "google"), None)
    c.ok(first_google is not None, "sourcing started", first_google)
    c.ok("02_lead_sourcing" in st, "Module 2 started by webhook", st)
    c.ok(time.time() - t0 < 60, "form to sourcing in seconds", round(time.time() - t0, 1))
    all_success(c, st, ["01_campaign_setup"])
    mock.reset()
    bad = dict(form, **{"Max leads": "501"})
    resp, ex, st = run(stack, lambda: stack.submit_form(bad), expect=["01_campaign_setup"])
    c.ok(len(mock.table("Campaigns")) == 0, "invalid form (max leads 501) creates no campaign", mock.table("Campaigns"))
    # live bug: the form page polled the public tunnel URL from localhost (CORS) and spun forever
    import requests
    mock.reset()
    resp, ex, st = run(stack, lambda: stack.submit_form(dict(form, **{"Max leads": "0"})), expect=["01_campaign_setup"] + CHAIN)
    try:
        waiting = resp.json().get("formWaitingUrl", "")
    except ValueError:
        waiting = ""
    c.ok(waiting.startswith(stack.base + "/"), "the form page follows its run on its own address (no cross-site status check)", waiting)
    c.ok(len(mock.table("Campaigns")) == 1 and mock.table("Campaigns")[0]["max_leads"] == 10, "empty 'Max leads' (sent as 0 by n8n) → test-mode default 10, campaign created", mock.table("Campaigns"))
    cid = mock.table("Campaigns")[0]["id"] if mock.table("Campaigns") else ""
    c.ok(requests.get(f"{stack.base}/webhook/campaign-status", params={"id": cid}, timeout=30).status_code == 401, "status page needs the login (401 without)")
    page = requests.get(f"{stack.base}/webhook/campaign-status", params={"id": cid}, auth=AUTH, timeout=30)
    c.ok(page.status_code == 200 and "text/html" in page.headers.get("content-type", "") and "Cleaning companies Berlin" in page.text and "Kampagne angelegt" in page.text,
         "status page shows the campaign and its steps", (page.status_code, page.text[:120]))
    c.ok("Kampagne nicht gefunden" in requests.get(f"{stack.base}/webhook/campaign-status", params={"id": "recDOESNOTEXIST"}, auth=AUTH, timeout=30).text, "unknown campaign → clear message")
    return c


def t02_lead_sourcing(stack, mock):
    c = Check("02 lead sourcing")
    mock.reset()
    camp = seed_campaign(mock)
    _, ex, st = run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=CHAIN)
    leads = [l for l in mock.table("Leads") if l["campaign_record_id"] == camp["id"]]
    s = mock.state()
    c.ok(len(s["google_calls"]) == 1, "Max leads 10 → exactly 1 Google request", len(s["google_calls"]))
    c.ok(s["google_calls"][0]["body"].get("pageSize") == 12 and not s["google_calls"][0]["body"].get("pageToken"), "pageSize 12 (10 + 20 % buffer), no paging", s["google_calls"][0]["body"])
    c.ok("reviews" not in s["google_calls"][0]["mask"] and "photos" not in s["google_calls"][0]["mask"], "field mask stays on the Enterprise tier", s["google_calls"][0]["mask"])
    c.ok(len(leads) == 10, "10 leads", len(leads))
    creates = [w for w in mock.state()["airtable_writes"] if w["table"] == "Leads" and w["method"] == "POST"]
    c.ok(creates and all(r.get("status") == "New" for w in creates for r in w["records"]), "leads created with status New", creates[:1])
    c.ok(creates and all(w.get("upsert") for w in creates), "leads are written as upsert on google_place_id (a retried request cannot duplicate)", creates[:1])
    c.ok(all(len(w["records"]) <= 10 for w in mock.state()["airtable_writes"]), "every Airtable write has at most 10 records")
    c.ok(len({l["domain"] for l in leads}) == 10, "no duplicate domains", len({l["domain"] for l in leads}))
    c.ok(all(l.get("website") and l.get("phone") for l in leads), "website and phone on every lead")
    c.ok(all(l.get("source") == "Google Places API" and l.get("sourced_at") for l in leads), "GDPR: source and sourced_at stored")
    cmp = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])
    c.ok(cmp.get("google_api_requests") == 1, "campaign google_api_requests = 1", cmp.get("google_api_requests"))
    c.ok(any("10 leads sourced" in m["text"] and "1 Google request" in m["text"] for m in s["slack"]), "Slack: '10 leads sourced … (1 Google request)'", [m["text"] for m in s["slack"]])
    all_success(c, {k: v for k, v in st.items() if k == "02_lead_sourcing"}, ["02_lead_sourcing"])
    # re-run on the same campaign → no duplicates
    _, ex, st = run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=["02_lead_sourcing"])
    c.ok(len(mock.table("Leads")) == 10, "re-run on the same campaign creates no duplicate leads", len(mock.table("Leads")))
    # a retried write (same batch sent twice) must not duplicate: send one saved batch again as n8n's retry would
    import requests
    batch = [{"fields": {k: v for k, v in l.items() if k in ("company_name", "google_place_id", "campaign_record_id", "domain", "status")}} for l in mock.table("Leads")[:10]]
    requests.patch(f"{mock.base}/airtable/v0/appMOCKBASE000001/Leads", json={"performUpsert": {"fieldsToMergeOn": ["google_place_id"]}, "records": batch, "typecast": True}, timeout=5).raise_for_status()
    c.ok(len(mock.table("Leads")) == 10, "the same lead batch written twice (retry) → still 10 leads", len(mock.table("Leads")))
    # the form number decides the size: 30 → page 2 of the same search, then stop; 3 → 3
    for n, calls, page_sizes in ((30, 2, [20, 20]), (3, 1, [4])):
        mock.reset()
        camp = seed_campaign(mock, max_leads=n)
        _, ex, st = run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=CHAIN)
        g = mock.state()["google_calls"]
        leads = [l for l in mock.table("Leads") if l["campaign_record_id"] == camp["id"]]
        c.ok(len(leads) == n, f"Max leads {n} → exactly {n} leads", len(leads))
        c.ok(len({l["google_place_id"] for l in leads}) == len(leads), "no duplicate companies", len({l["google_place_id"] for l in leads}))
        c.ok(len(g) == calls and [x["body"].get("pageSize") for x in g] == page_sizes, f"Max leads {n} → {calls} Google request(s), paging stops when enough",
             [(x["body"].get("pageSize"), x["body"].get("pageToken")) for x in g])
        if calls == 2:
            c.ok(g[1]["body"].get("pageToken") == "p2" and g[1]["body"].get("textQuery") == g[0]["body"].get("textQuery"), "page 2 uses Google's nextPageToken")
        cmp = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])
        c.ok(cmp.get("google_api_requests") == calls, f"campaign records {calls} Google request(s)", cmp.get("google_api_requests"))
        all_success(c, {k: v for k, v in st.items() if k == "02_lead_sourcing"}, ["02_lead_sourcing"])
    return c


def t03_enrichment(stack, mock):
    c = Check("03 enrichment")
    mock.reset()
    camp = seed_campaign(mock)
    # Module 2 maps the saved Google fixture (tested in 02); its kick starts Module 3
    _, ex, st = run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=CHAIN, timeout=150)
    leads = {l["domain"]: l for l in mock.table("Leads")}
    expected = fixture("impressum/expected.json")
    web = json.loads((FIX / "web_map.json").read_text())
    for domain, entry in web.items():
        if domain not in leads:
            continue
        key = next((v.split("/")[1].replace(".html", "") for k, v in entry.items() if v.startswith("impressum/")), "hard_no_impressum")
        exp = expected[key]
        l = leads[domain]
        c.ok(l.get("email") == exp["email"] and l.get("contact_name") == exp["contact_name"], f"{domain}: email + name as in fixture", (l.get("email"), l.get("contact_name")))
    c.ok(all(isinstance(l.get("score"), (int, float)) for l in leads.values()), "every lead has a score")
    c.ok(all(l["status"] in ("Enriched", "Rejected", "Drafting", "Approved", "Needs review") for l in leads.values()), "every lead has a final status", {l["status"] for l in leads.values()})
    rej = {d: l.get("reject_reason") for d, l in leads.items() if l["status"] == "Rejected"}
    c.ok(rej.get("weissensee-clean.example") == "no Impressum page found", "hard case without Impressum Rejected with reason", rej)
    c.ok("score 35 below 50" in str(rej.get("cb-hausdienst.example")), "info@-only lead Rejected (score below 50)", rej)
    with_email = sum(1 for l in leads.values() if l.get("email"))
    c.ok(with_email / max(1, len(leads)) >= 0.6, "60%+ of leads with a website get an email", f"{with_email}/{len(leads)}")
    c.ok(all(l.get("company_summary") for l in leads.values() if l["status"] != "Rejected"), "AI summary on every enriched lead")
    g = leads.get("glanzwerk-berlin.example", {})
    c.ok(g.get("contact_source") == "Impressum" and g.get("contact_name") == "Thomas Becker", "target role Geschäftsführer → the Impressum person stays", (g.get("contact_name"), g.get("contact_source")))
    c.ok(str(g.get("trigger", "")).startswith("Wir suchen ab sofort Reinigungskräfte"), "trigger from the jobs page stored (verified on the page)", g.get("trigger"))
    c.ok(not any(l.get("trigger") for d, l in leads.items() if d != "glanzwerk-berlin.example"), "no trigger invented for companies without one")
    all_success(c, {k: v for k, v in st.items() if k in ("02_lead_sourcing", "03_enrichment")}, ["03_enrichment"])
    # target role "Objektleitung" → the person from the team page, with her personal email and "Frau" as written there
    mock.reset()
    camp = seed_campaign(mock, target_role="Objektleitung, Geschäftsführer")
    _, ex, st = run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=CHAIN, timeout=150)
    g = next((l for l in mock.table("Leads") if l["domain"] == "glanzwerk-berlin.example"), {})
    c.ok((g.get("contact_name"), g.get("contact_role"), g.get("contact_salutation"), g.get("email"), g.get("contact_source")) ==
         ("Petra Klein", "Objektleitung", "Frau", "p.klein@glanzwerk-berlin.example", "Website (Team/Kontakt)"),
         "target role Objektleitung → Frau Petra Klein from the team page, personal email", (g.get("contact_name"), g.get("contact_role"), g.get("contact_salutation"), g.get("email"), g.get("contact_source")))
    all_success(c, {k: v for k, v in st.items() if k in ("02_lead_sourcing", "03_enrichment")}, ["03_enrichment"])
    return c


def t04_ai_emails(stack, mock):
    c = Check("04 AI emails + Campaign ready")
    mock.reset()
    camp = seed_campaign(mock, leads_sourced=8)
    leads = seed_leads(mock, camp["id"], n=8, status="Enriched")
    _, ex, st = run(stack, lambda: stack.webhook("ai-emails-run", {}), expect=["04_ai_emails"], timeout=150)
    L = {l["id"]: l for l in mock.table("Leads")}
    E = mock.table("Emails")
    approved = [l for l in L.values() if l["status"] == "Approved"]
    review = [l for l in L.values() if l["status"] == "Needs review"]
    c.ok(len(approved) == 8 and not review, "all 8 leads Approved automatically (no per-email ticking)", len(approved))
    per = {}
    for e in E:
        per.setdefault(e["lead_record_id"], []).append(e)
    c.ok(all(len(per.get(l["id"], [])) == 4 for l in approved), "4 drafts per approved lead", {k: len(v) for k, v in per.items()})
    c.ok(all(e.get("quality_score") and e.get("approved") for l in approved for e in per[l["id"]]), "quality score set and passed (80+)")
    c.ok(all("Antworten Sie mit STOP" in e["body"] for e in E), "legal footer on every email")
    sal = ("Sehr geehrter Herr ", "Sehr geehrte Frau ", "Guten Tag ", "Sehr geehrte Damen und Herren,")
    sig = "Mit freundlichen Grüßen\n\nAnna Berger\nBusiness Development\nNexsale GmbH (Demo)\nTel. +49 30 0000000 · nexsale.example"
    c.ok(all(e["body"].startswith(sal) and e["body"].count("Mit freundlichen Grüßen") == 1 and sig in e["body"] for e in E),
         "professional frame on every email: one formal salutation, one sign-off, full signature", [e["body"][:60] for e in E[:2]])
    c.ok(all("öffentlichen Impressum" in e["body"] and "Viele Grüße" not in e["body"] for e in E), "footer names the data source (GDPR); no informal sign-off left from the AI")
    c.ok(all("[TEST]" not in e["subject"] for e in E), "drafts carry no [TEST]")
    cmp = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])
    s = mock.state()
    ready = [m for m in s["slack"] if m["text"].startswith("Campaign ready")]
    c.ok(cmp["status"] == "Ready" and len(ready) == 1, "exactly one 'Campaign ready' message, campaign Ready", (cmp["status"], len(ready)))
    btn = [e for m in ready for b in m["blocks"] if b["type"] == "actions" for e in b["elements"] if e["action_id"] == "approve_launch"]
    c.ok(len(btn) == 1 and btn[0]["value"] == f"approve_launch|{camp['id']}", "message has the 'Approve and launch' button", btn)
    c.ok(sum(1 for b in ready[0]["blocks"] if b["type"] == "divider") == 3, "3 sample sequences")
    mails = [g for g in s["gmail"] if "Kampagne bereit" in g["subject"]]
    c.ok(len(mails) == 1 and mails[0]["to"] == SENDER and mails[0]["test_marker"] == "true" and "[TEST]" not in mails[0]["subject"],
         "'Campaign ready' email goes to the SENDER only (never the test prospect inbox), marked as test, no [TEST] in the subject", [(m["to"], m["subject"]) for m in mails])
    c.ok(mails and mails[0]["subject"].startswith("Kampagne bereit:") and "<table" in mails[0]["html"] and "Beispiele" in mails[0]["body"] and "Im Control Center öffnen" in mails[0]["html"],
         "professional format: German subject, HTML layout + plain text, samples, button to the Control Center", mails[0]["subject"] if mails else None)
    c.ok(not any(g for g in s["gmail"] if "Kampagne bereit" not in g["subject"]), "nothing sent to leads before approval")
    all_success(c, {k: v for k, v in st.items() if k == "04_ai_emails"}, ["04_ai_emails"])
    # broken AI JSON twice (one lead, so parallel AI calls can't share the failures) → Needs review
    mock.reset()
    camp = seed_campaign(mock, leads_sourced=1)
    seed_leads(mock, camp["id"], n=1, status="Enriched")
    mock.ai_mode("broken_json", "email_sequence", count=2)
    run(stack, lambda: stack.webhook("ai-emails-run", {}), expect=["04_ai_emails"], timeout=90)
    l = mock.table("Leads")[0]
    c.ok(l["status"] == "Needs review" and "invalid after one retry" in l.get("needs_review_reason", ""), "broken AI JSON → one retry → Needs review", l.get("needs_review_reason"))
    c.ok(ready_count(mock) == 1, "campaign with only flagged leads still reports Ready (0 approved)", ready_count(mock))
    # quality below 80 twice → left out and flagged
    mock.reset()
    camp = seed_campaign(mock, leads_sourced=1)
    seed_leads(mock, camp["id"], n=1, status="Enriched")
    mock.ai_mode("low_quality", "quality_check", count=2)
    run(stack, lambda: stack.webhook("ai-emails-run", {}), expect=["04_ai_emails"], timeout=90)
    l = mock.table("Leads")[0]
    c.ok(l["status"] == "Needs review" and "below 80 after one rewrite" in l.get("needs_review_reason", ""), "quality < 80 → rewritten once → still < 80 → flagged", l.get("needs_review_reason"))
    c.ok(sum(1 for a in mock.state()["ai_calls"] if a["prompt_id"] == "email_sequence") == 2, "exactly one rewrite")
    rw = [a for a in mock.state()["ai_calls"] if a["prompt_id"] == "email_sequence"][-1]["user_tail"]
    c.ok("Die vorige Version wurde abgelehnt" in rw and "erste Satz von E-Mail 1" in rw and "seit 20 Jahren" in rw and "Floskeln" in rw,
         "the rewrite gets exact feedback computed in code (opening, invented claim, filler)", rw[-600:])
    # a readable draft that breaks a rule twice (write + retry) → rewritten with exact fix instructions → Approved
    mock.reset()
    camp = seed_campaign(mock, leads_sourced=1)
    seed_leads(mock, camp["id"], n=1, status="Enriched")
    mock.ai_mode("filler", "email_sequence", count=2)
    run(stack, lambda: stack.webhook("ai-emails-run", {}), expect=["04_ai_emails"], timeout=90)
    calls = [a for a in mock.state()["ai_calls"] if a["prompt_id"] == "email_sequence"]
    l = mock.table("Leads")[0]
    c.ok(len(calls) == 3 and "Behebe genau diese Punkte" in calls[1]["user_tail"] and "Synergien besprechen" in calls[1]["user_tail"], "retry names the exact fix", [x["user_tail"][-300:] for x in calls[1:2]])
    c.ok("Die vorige Version wurde abgelehnt" in calls[2]["user_tail"] and "Synergie" in calls[2]["user_tail"], "still broken after the retry → one rewrite with the fix instructions")
    c.ok(l["status"] == "Approved" and len(mock.table("Emails")) == 4, "the rewrite passes → lead Approved with 4 emails", (l["status"], l.get("needs_review_reason")))
    # broken in every attempt → Needs review, but the draft is kept so a person can fix it in the Control Center
    mock.reset()
    camp = seed_campaign(mock, leads_sourced=1)
    seed_leads(mock, camp["id"], n=1, status="Enriched")
    mock.ai_mode("filler", "email_sequence", count=4)
    run(stack, lambda: stack.webhook("ai-emails-run", {}), expect=["04_ai_emails"], timeout=90)
    l = mock.table("Leads")[0]
    E = mock.table("Emails")
    c.ok(l["status"] == "Needs review" and "broke a rule after the rewrite" in l.get("needs_review_reason", "") and "Synergie" in l.get("needs_review_reason", ""),
         "rule broken in every attempt → Needs review with the reason", l.get("needs_review_reason"))
    c.ok(len(E) == 4 and all(e["status"] == "Draft" and not e.get("approved") for e in E) and all("-- " in e["body"] for e in E), "the draft is kept (4 unapproved emails with footer) for editing", [(e["status"], e.get("approved")) for e in E])
    return c


def ready_count(mock):
    return sum(1 for m in mock.state()["slack"] if m["text"].startswith("Campaign ready"))


def t05_launch(stack, mock):
    c = Check("05 campaign launch")
    mock.reset()
    camp = seed_campaign(mock, status="Launch", leads_sourced=8)
    leads = seed_leads(mock, camp["id"], n=8)
    seed_emails(mock, leads)
    _, ex, st = run(stack, lambda: stack.webhook("campaign-launch", {"campaign_record_id": camp["id"]}), expect=["05_campaign_launch", "06_sending"], timeout=120)
    cmp = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])
    c.ok(cmp["status"] == "Live" and cmp.get("launched_at"), "status Live, launched_at set", cmp["status"])
    L = [l for l in mock.table("Leads") if l["campaign_record_id"] == camp["id"]]
    c.ok(all(l.get("sequence_step") is not None for l in L), "every Approved lead scheduled (sequence_step set)")
    c.ok([l.get("subject_variant") for l in L][:4] == ["A", "B", "A", "B"], "subject A/B assigned alternately", [l.get("subject_variant") for l in L])
    c.ok(any("is live: 8 leads" in m["text"] for m in mock.state()["slack"]), "Slack: campaign is live with lead count")
    all_success(c, {k: v for k, v in st.items() if k == "05_campaign_launch"}, ["05_campaign_launch"])
    # failing checks
    mock.reset()
    camp = seed_campaign(mock, status="Launch")
    leads = seed_leads(mock, camp["id"], n=3)
    seed_emails(mock, leads)
    mock.seed("Blocklist", [{"value": leads[0]["fields"]["email"], "reason": "test"}])
    _, ex, st = run(stack, lambda: stack.webhook("campaign-launch", {"campaign_record_id": camp["id"]}), expect=["05_campaign_launch"])
    cmp = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])
    msg = [m["text"] for m in mock.state()["slack"] if "not launched" in m["text"]]
    c.ok(cmp["status"] == "Ready", "a campaign with a failed check stays Ready", cmp["status"])
    c.ok(msg and "At least 5 Approved leads" in msg[0] and "Blocklist" in msg[0], "Slack lists each failed check with the count", msg)
    c.ok(not mock.state()["gmail"], "nothing sent")
    return c


def t06_sending(stack, mock):
    c = Check("06 sending and follow-ups")
    mock.reset()
    camp = seed_campaign(mock, status="Live")
    leads = seed_leads(mock, camp["id"], n=2, sequence_step=1, next_send_at=iso(now() - timedelta(minutes=1)), subject_variant="A")
    seed_emails(mock, leads)
    _, ex, st = run(stack, lambda: stack.webhook("sending-run", {}), expect=["06_sending"], timeout=120)
    s = mock.state()
    c.ok(len(s["gmail"]) == 2, "2 first emails sent", len(s["gmail"]))
    c.ok(all(g["to"] == PROSPECT and g["test_marker"] == "true" and "[TEST]" not in g["subject"] for g in s["gmail"]), "SAFETY: every send rewritten to the test inbox and marked as test (header, no [TEST] in the subject)", [(g["to"], g["subject"]) for g in s["gmail"]])
    c.ok(not any("testfirma" in g["to"] for g in s["gmail"]), "SAFETY: the real company inbox gets nothing")
    L = {l["id"]: l for l in mock.table("Leads")}
    l0 = L[leads[0]["id"]]
    first = datetime.fromisoformat(l0["first_sent_at"].replace("Z", "+00:00"))
    nxt = datetime.fromisoformat(l0["next_send_at"].replace("Z", "+00:00"))
    c.ok(l0["status"] == "Contacted" and l0["sequence_step"] == 2, "lead Contacted, step 2 next", (l0["status"], l0["sequence_step"]))
    c.ok(abs((nxt - first).total_seconds() - 180) < 5, "DEMO_MODE: step 2 due 3 minutes after the first send", (nxt - first).total_seconds())
    E = mock.table("Emails")
    sent1 = [e for e in E if e["status"] == "Sent"]
    c.ok(all(e.get("gmail_message_id") and e.get("thread_id") and e.get("sent_at") for e in sent1), "sent_at, gmail_message_id, thread_id saved")
    # steps 2–4: time-travel the schedule instead of waiting 14 minutes
    thread = next(e["thread_id"] for e in sent1 if e["lead_record_id"] == leads[0]["id"])
    for step in (2, 3, 4):
        mock_patch(mock, "Leads", leads[0]["id"], {"next_send_at": iso(now() - timedelta(seconds=5))})
        mock_patch(mock, "Leads", leads[1]["id"], {"next_send_at": iso(now() + timedelta(days=1))})
        run(stack, lambda: stack.webhook("sending-run", {}), expect=["06_sending"], timeout=90)
    mine = [g for g in mock.state()["gmail"] if g["threadId"] == thread]
    c.ok(len(mine) == 4, "lead 1 got 4 emails in ONE thread", len(mine))
    c.ok(all(g["subject"].startswith("Re: ") for g in mine[1:]), "steps 2–4 reply in the thread (Re:)", [g["subject"] for g in mine])
    l0 = next(l for l in mock.table("Leads") if l["id"] == leads[0]["id"])
    c.ok(l0.get("sequence_finished") is True, "after step 4 the sequence is finished")
    # no email after a reply
    mock.seed("Replies", [{"key": "r", "lead": [leads[1]["id"]], "lead_record_id": leads[1]["id"], "category": "Later"}])
    mock_patch(mock, "Leads", leads[1]["id"], {"next_send_at": iso(now() - timedelta(seconds=5))})
    before = len(mock.state()["gmail"])
    run(stack, lambda: stack.webhook("sending-run", {}), expect=["06_sending"], timeout=60)
    c.ok(len(mock.state()["gmail"]) == before, "no email goes out after a reply", len(mock.state()["gmail"]) - before)
    # blocklisted lead is skipped
    mock_patch(mock, "Leads", leads[1]["id"], {"status": "Contacted"})
    all_success(c, {k: v for k, v in st.items() if k in ("06_sending", "13_send_email")}, ["06_sending", "13_send_email"])
    # send order (live bug): a follow-up due for longer must still wait until every due first email is out
    mock.reset()
    camp = seed_campaign(mock, status="Live")
    fu = seed_leads(mock, camp["id"], n=1, status="Contacted", sequence_step=2, next_send_at=iso(now() - timedelta(minutes=30)), subject_variant="A", first_sent_at=iso(now() - timedelta(minutes=33)))
    firsts = seed_leads(mock, camp["id"], n=3, sequence_step=1, next_send_at=iso(now() - timedelta(minutes=1)), subject_variant="A")
    # distinct names/addresses for the follow-up lead
    mock_patch(mock, "Leads", fu[0]["id"], {"company_name": "Folgefirma GmbH", "email": "f@folgefirma.example", "domain": "folgefirma.example"})
    fu[0]["fields"]["company_name"] = "Folgefirma GmbH"
    seed_emails(mock, fu + firsts)
    e1 = next(e for e in mock.table("Emails") if e["lead_record_id"] == fu[0]["id"] and e["step"] == 1)
    mock_patch(mock, "Emails", e1["id"], {"status": "Sent", "sent_at": iso(now() - timedelta(minutes=33)), "thread_id": "thr-fu"})
    run(stack, lambda: stack.webhook("sending-run", {}), expect=["06_sending"], timeout=120)
    order = [g["subject"] for g in mock.state()["gmail"]]
    c.ok(len(order) == 4 and all(x.startswith("Betreff 1 für Testfirma") for x in order[:3]) and order[3] == "Re: Betreff 1 für Folgefirma GmbH",
         "all 3 due first emails are sent before the follow-up that was due 30 minutes earlier", order)
    return c


REPLY_EXPECT = {
    "interested_01": ("Interested", "Interested"), "interested_02": ("Interested", "Interested"), "tricky_english": ("Interested", "Interested"),
    "later_01": ("Later", "Later"), "later_02": ("Later", "Later"), "not_interested_01": ("Not interested", "Not interested"),
    "not_interested_02": ("Not interested", "Not interested"), "unsubscribe_01": ("Unsubscribe", "Unsubscribe"), "unsubscribe_02": ("Unsubscribe", "Unsubscribe"),
    "tricky_stop": ("Unsubscribe", "Unsubscribe"), "ooo_01": ("Out of office", "Out of office"), "ooo_02": ("Out of office", "Out of office"),
    "unclear_01": ("Unclear", "Unsure"), "bounce_01": ("Bounce", "Bounce"),
    "question_01": ("Question", "Question"), "referral_01": ("Referral", "Referral"), "referral_02": ("Referral", "Referral"),
}


def post_reply(stack, key, thread):
    fx = fixture(f"replies/{key}.json")
    msg = {"message_id": "m-" + key, "thread_id": thread, "from": fx.get("from_email", PROSPECT), "subject": fx["subject"], "body": fx["body"],
           "received_at": iso(now()), "auto_submitted": fx.get("auto_submitted", "")}
    return stack.webhook("reply-ingest", msg)


def t07_replies(stack, mock):
    c = Check("07 reply sorting (all fixtures)")
    for key, (cat, branch) in REPLY_EXPECT.items():
        mock.reset()
        camp, lead, em = seed_contacted_lead(mock)
        thread = "thr-test-1"
        t0 = time.time()
        _, ex, st = run(stack, lambda: post_reply(stack, key, thread if key != "bounce_01" else ""), expect=["07_replies"], timeout=90)
        R = mock.table("Replies")
        l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
        s = mock.state()
        ok_cat = len(R) == 1 and R[0]["category"] == cat and R[0]["branch"] == branch
        c.ok(ok_cat, f"{key}: category {cat}, branch {branch}", (R[0]["category"], R[0]["branch"]) if R else None)
        c.ok(time.time() - t0 < 120, f"{key}: handled within 2 minutes", round(time.time() - t0, 1))
        if branch != "Out of office":
            c.ok(not l.get("next_send_at"), f"{key}: sequence stopped at once")
        if key == "interested_01":
            ans = [g for g in s["gmail"] if g["threadId"] == thread]
            c.ok(ans and "Damit ich das Gespräch gut vorbereiten kann, gern vorab kurz: Wie groß ist die Fläche" in ans[0]["body"] and ans[0]["body"].count("Mit freundlichen Grüßen") == 1,
                 "the client's qualifying questions are in the answer, before one sign-off", ans[0]["body"][:600] if ans else None)
            c.ok(len(ans) == 1 and "calendly.com" in ans[0]["body"] and ans[0]["subject"].startswith("Re:") and ans[0]["test_marker"] == "true", "interested ≥ 0.85: automatic answer with Calendly link in the same thread", ans)
            c.ok("utm_content=" + lead["id"] in ans[0]["body"], "booking link carries the lead id")
            c.ok(l["status"] == "Interested", "lead Interested")
        if key == "interested_02":
            appr = [m for m in s["slack"] if "approve the answer" in m["text"]]
            c.ok(not s["gmail"] and len(appr) == 1, "interested 0.80 (< 0.85): no auto-send, Slack Approve/Edit/Reject", (len(s["gmail"]), len(appr)))
        if key == "later_01":
            t = mock.table("Tasks")
            c.ok(t and t[0]["type"] == "Follow up later" and t[0]["due_at"].startswith("2027-01-12"), "later: follow-up task on the return date", t)
        if key == "later_02":
            t = mock.table("Tasks")
            due = datetime.fromisoformat(t[0]["due_at"].replace("Z", "+00:00")) if t else None
            c.ok(due and 29 <= (due - now()).days <= 30, "later without date: +30 days", t)
        if branch == "Unsubscribe":
            b = mock.table("Blocklist")
            c.ok(any(x["value"] == lead["fields"]["email"] for x in b) and l["status"] == "Unsubscribed", f"{key}: Blocklist + Unsubscribed", b)
        if key == "ooo_01":
            c.ok(l.get("next_send_at") and l["status"] == "Contacted", "out of office: sequence paused and resumes later", l.get("next_send_at"))
        if key == "question_01":
            appr = [m for m in s["slack"] if "Question reply" in m["text"]]
            c.ok(not s["gmail"] and len(appr) == 1 and l["status"] == "Interested", "question: drafted answer waits for approval in Slack, nothing sent automatically", (len(s["gmail"]), len(appr), l["status"]))
        if key == "referral_01":
            new = [x for x in mock.table("Leads") if x.get("email") == "p.klein@glanzwerk-berlin.example"]
            sent = [g for g in s["gmail"] if g.get("original_to") == "p.klein@glanzwerk-berlin.example" or "p.klein" in json.dumps(g)]
            em = [e for e in mock.table("Emails") if new and e.get("lead_record_id") == new[0]["id"]]
            c.ok(len(new) == 1 and new[0].get("contact_name") == "Petra Klein" and new[0]["status"] == "Contacted" and new[0].get("contact_source") == "Empfehlung",
                 "referral with email: new lead for Petra Klein (Contacted, source Empfehlung)", new)
            c.ok(len(s["gmail"]) == 1 and s["gmail"][0]["to"] == PROSPECT and s["gmail"][0]["test_marker"] == "true" and "hat mich an Sie verwiesen" in s["gmail"][0]["body"] and "Sehr geehrte Damen und Herren" not in s["gmail"][0]["body"],
                 "intro email to the referred person sent through the guard (test inbox, marked as test)", [g.get("subject") for g in s["gmail"]])
            c.ok(len(em) == 1 and em[0].get("thread_id") and em[0]["status"] == "Sent", "the intro email is stored with its thread, so her reply is matched", em)
            c.ok(l["status"] == "Replied" and not l.get("next_send_at"), "original lead: sequence stopped", (l["status"], l.get("next_send_at")))
        if key == "referral_02":
            t = mock.table("Tasks")
            c.ok(not s["gmail"] and t and t[0]["type"] == "Follow up referral" and "Klein" in t[0]["summary"], "referral without email: task + Slack, nothing sent", t)
        if key == "unclear_01":
            srt = [m for m in s["slack"] if "Please sort this reply" in m["text"]]
            c.ok(len(srt) == 1, "confidence < 0.7: Slack 'Please sort this reply' with buttons", len(srt))
        if key == "bounce_01":
            c.ok(l["status"] == "Bounced" and any(x["value"] == "t.becker@glanzwerk-berlin.example" for x in mock.table("Blocklist")), "bounce → lead Bounced + Blocklist")
        bad = {k: v for k, v in st.items() if any(x != "success" for x in v) and k != "10_crm_sync"}
        c.ok(not bad, f"{key}: executions success", st)
    return c


def t07_newsletter(stack, mock):
    c = Check("07 newsletter / notification without a lead → stored, no Slack noise")
    mock.reset()
    seed_contacted_lead(mock)
    msg = {"message_id": "m-news", "thread_id": "thr-news", "from": "HubSpot <onboarding@crm-newsletter.example>", "subject": "Welcome to HubSpot",
           "body": "Let's make it yours.", "headers": {"list-unsubscribe": "<mailto:unsub@crm-newsletter.example>"}}
    _, ex, st = run(stack, lambda: stack.webhook("reply-ingest", msg), expect=["07_replies"])
    R = mock.table("Replies")
    c.ok(len(R) == 1 and R[0]["branch"] == "Ignored", "stored with branch Ignored", [r.get("branch") for r in R])
    c.ok(not mock.state()["slack"], "no Slack message", [m["text"] for m in mock.state()["slack"]])
    all_success(c, st, ["07_replies"])
    return c


def t07w_withdrawal(stack, mock):
    c = Check("07 lead says no after showing interest → meeting cancelled, HubSpot deal Closed lost")
    # A) booked meeting + HubSpot deal, then "not interested"
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Meeting booked", "next_send_at": None})
    mock.seed("Meetings", [{"key": "m", "lead": [lead["id"]], "lead_record_id": lead["id"], "status": "Booked", "start_time": iso(now() + timedelta(days=2)), "calendly_event_id": "WD-EVT-1"},
                           {"key": "m2", "lead": [lead["id"]], "lead_record_id": lead["id"], "status": "Reminded", "start_time": iso(now() + timedelta(hours=20)), "calendly_event_id": "WD-EVT-2"}])
    run(stack, lambda: stack.webhook("crm-sync", {"lead_record_id": lead["id"]}), expect=["10_crm_sync"])
    hs = mock.state()["hubspot"]
    c.ok(len(hs["deals"]) == 1 and list(hs["deals"].values())[0]["properties"]["dealstage"] == "appointmentscheduled", "setup: open deal in HubSpot")
    _, ex, st = run(stack, lambda: post_reply(stack, "not_interested_01", "thr-test-1"), expect=["07_replies", "10_crm_sync"], timeout=120)
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    c.ok(l["status"] == "Not interested", "lead Not interested", l["status"])
    c.ok(all(m["status"] == "Cancelled" for m in mock.table("Meetings")), "booked and reminded meetings marked Cancelled", [m["status"] for m in mock.table("Meetings")])
    cx = mock.state()["calendly_cancellations"]
    c.ok(sorted(x["uuid"] for x in cx) == ["WD-EVT-1", "WD-EVT-2"] and all(x["auth"] == "Bearer " and x["reason"] for x in cx), "both events cancelled in Calendly (token, reason)", cx)
    hs = mock.state()["hubspot"]
    deal = list(hs["deals"].values())[0]["properties"]
    c.ok(len(hs["deals"]) == 1 and deal["dealstage"] == "closedlost" and deal.get("closed_lost_reason"), "the same HubSpot deal is Closed lost with a reason", deal)
    contact = list(hs["contacts"].values())[0]["properties"]
    c.ok(contact.get("hs_lead_status") == "UNQUALIFIED", "HubSpot contact UNQUALIFIED", contact.get("hs_lead_status"))
    c.ok(l.get("crm_synced_status") == "Not interested", "Airtable records the synced status", l.get("crm_synced_status"))
    sl = [m["text"] for m in mock.state()["slack"]]
    c.ok(any("withdrew after showing interest" in t and "Closed lost" in t and t.count("cancelled in Calendly automatically") == 2 and "please cancel" not in t for t in sl),
         "Slack: withdrew, deal closed, both meetings cancelled in Calendly automatically", sl)
    all_success(c, {k: v for k, v in st.items() if k in ("07_replies", "10_crm_sync")}, ["07_replies", "10_crm_sync"])
    # A2) Calendly refuses (token revoked / event gone): meeting still Cancelled in Airtable, Slack asks for a manual cancel, run succeeds
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Meeting booked", "next_send_at": None})
    mock.seed("Meetings", [{"key": "m", "lead": [lead["id"]], "lead_record_id": lead["id"], "status": "Booked", "start_time": iso(now() + timedelta(days=2)), "calendly_event_id": "WD-EVT-3"}])
    mock.fail("calendly", 403, 1)
    _, ex, st = run(stack, lambda: post_reply(stack, "not_interested_01", "thr-test-1"), expect=["07_replies"])
    c.ok(mock.table("Meetings")[0]["status"] == "Cancelled" and not mock.state()["calendly_cancellations"], "Calendly 403 → Airtable still Cancelled, nothing cancelled in Calendly")
    sl = [m["text"] for m in mock.state()["slack"]]
    c.ok(any("please cancel it in Calendly too* (Calendly: 403" in t for t in sl), "Slack asks for a manual cancel with Calendly's answer", sl)
    all_success(c, {k: v for k, v in st.items() if k == "07_replies"}, ["07_replies"])
    # B) a first "no" from a contacted lead: nothing in HubSpot
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    _, ex, st = run(stack, lambda: post_reply(stack, "not_interested_01", "thr-test-1"), expect=["07_replies"])
    c.ok(not mock.state()["hubspot"]["deals"] and not mock.state()["hubspot"]["contacts"], "first 'no' without earlier interest → nothing created in HubSpot")
    sl = [m["text"] for m in mock.state()["slack"]]
    c.ok(any("not interested, lead closed" in t for t in sl) and not any("withdrew" in t for t in sl), "Slack: normal 'not interested' note", sl)
    all_success(c, {k: v for k, v in st.items() if k == "07_replies"}, ["07_replies"])
    # C) interested but not yet in HubSpot, then STOP: Blocklist, no deal created
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Interested", "next_send_at": None})
    _, ex, st = run(stack, lambda: post_reply(stack, "unsubscribe_01", "thr-test-1"), expect=["07_replies"])
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    c.ok(l["status"] == "Unsubscribed" and mock.table("Blocklist"), "STOP after interest → Unsubscribed + Blocklist")
    c.ok(not mock.state()["hubspot"]["deals"], "no closed deal is created for a lead that never had one")
    c.ok(any("withdrew after showing interest (STOP" in m["text"] for m in mock.state()["slack"]), "Slack: withdrew (STOP)")
    all_success(c, {k: v for k, v in st.items() if k == "07_replies"}, ["07_replies"])
    return c


def t07b_calendly(stack, mock):
    c = Check("07b Calendly")
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Interested"})
    created = fixture("webhooks/calendly_invitee_created.json")
    created["payload"]["email"] = PROSPECT
    created["payload"]["tracking"] = {"utm_source": "nexsale", "utm_content": lead["id"]}
    created["payload"]["questions_and_answers"] = [{"question": "Fläche in m²", "answer": "ca. 3.000"}]
    _, ex, st = run(stack, lambda: stack.webhook("calendly", created), expect=["07b_calendly"])
    M = mock.table("Meetings")
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    c.ok(len(M) == 1 and M[0]["status"] == "Booked" and M[0]["lead_record_id"] == lead["id"], "Meetings record (matched via utm_content)", M)
    c.ok(l["status"] == "Meeting booked", "lead Meeting booked", l["status"])
    c.ok(any("Meeting booked with" in m["text"] for m in mock.state()["slack"]), "Slack 'Meeting booked with …'")
    booked = next((m["text"] for m in mock.state()["slack"] if "Meeting booked with" in m["text"]), "")
    c.ok("Meeting-Briefing" in booked and "Im Gespräch klären" in booked and "Fläche" in booked, "meeting brief in Slack: who, what, booking answers, questions to ask", booked[:400])
    c.ok("Meeting-Briefing" in str(l.get("meeting_brief", "")) and "*" not in str(l.get("meeting_brief", "")), "brief saved on the lead (plain text, also used in the HubSpot note)", str(l.get("meeting_brief"))[:120])
    run(stack, lambda: stack.webhook("calendly", created), expect=["07b_calendly"])
    c.ok(len(mock.table("Meetings")) == 1, "the same webhook twice → one meeting", len(mock.table("Meetings")))
    canceled = fixture("webhooks/calendly_invitee_canceled.json")
    canceled["payload"]["email"] = PROSPECT
    _, ex2, st2 = run(stack, lambda: stack.webhook("calendly", canceled), expect=["07b_calendly"])
    c.ok(mock.table("Meetings")[0]["status"] == "Cancelled", "invitee.canceled → Cancelled")
    all_success(c, {k: v for k, v in st.items() if k == "07b_calendly"}, ["07b_calendly"])
    return c


def t07d_calendly_poll(stack, mock):
    import requests
    c = Check("07d Calendly poll (free plan)")
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Interested"})
    ev = {"uri": "https://api.calendly.com/scheduled_events/POLL-EVT-1", "name": "Erstgespräch (15 Min.)", "status": "active",
          "start_time": iso(now() + timedelta(days=2)), "end_time": iso(now() + timedelta(days=2, minutes=15))}
    inv = {"uri": "https://api.calendly.com/scheduled_events/POLL-EVT-1/invitees/I1", "email": PROSPECT, "name": "Thomas Becker", "status": "active",
           "created_at": iso(now() - timedelta(minutes=1)), "updated_at": iso(now() - timedelta(minutes=1)), "tracking": {"utm_content": lead["id"]}}
    requests.post(mock.base + "/_control/calendly", json={"events": [{"event": ev, "invitees": [inv]}]}, timeout=5)
    _, ex, st = run(stack, lambda: stack.webhook("calendly-poll", {}), expect=["07d_calendly_poll", "07b_calendly"])
    M = mock.table("Meetings")
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    c.ok(len(M) == 1 and M[0]["calendly_event_id"] == "POLL-EVT-1" and l["status"] == "Meeting booked", "new booking found by polling → Meeting booked", (len(M), l["status"]))
    run(stack, lambda: stack.webhook("calendly-poll", {}), expect=["07d_calendly_poll", "07b_calendly"])
    c.ok(len(mock.table("Meetings")) == 1, "polling again (overlapping window) → still one meeting")
    canc = dict(inv, status="canceled", updated_at=iso(now()), cancellation={"reason": "Terminkonflikt"})
    requests.post(mock.base + "/_control/calendly", json={"events": [{"event": dict(ev, status="canceled"), "invitees": [canc]}]}, timeout=5)
    run(stack, lambda: stack.webhook("calendly-poll", {}), expect=["07d_calendly_poll", "07b_calendly"])
    c.ok(mock.table("Meetings")[0]["status"] == "Cancelled", "cancelled booking → meeting Cancelled")
    old = dict(inv, created_at=iso(now() - timedelta(days=1)), updated_at=iso(now() - timedelta(days=1)), uri="x/I2")
    requests.post(mock.base + "/_control/calendly", json={"events": [{"event": dict(ev, uri="https://api.calendly.com/scheduled_events/OLD"), "invitees": [old]}]}, timeout=5)
    _, ex, st = run(stack, lambda: stack.webhook("calendly-poll", {}), expect=["07d_calendly_poll"])
    c.ok("07b_calendly" not in st, "old bookings (outside the 30-min window) are not handed on again", st)
    all_success(c, {k: v for k, v in st.items() if k == "07d_calendly_poll"}, ["07d_calendly_poll"])
    return c


def t07c_reminders(stack, mock):
    c = Check("07c reminders")
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    soon = mock.seed("Meetings", [{"key": "soon", "lead": [lead["id"]], "lead_record_id": lead["id"], "calendly_event_id": "E1", "start_time": iso(now() + timedelta(hours=23)), "status": "Booked"}])[0]
    past = mock.seed("Meetings", [{"key": "past", "lead": [lead["id"]], "lead_record_id": lead["id"], "calendly_event_id": "E2", "start_time": iso(now() - timedelta(minutes=20)), "status": "Reminded"}])[0]
    _, ex, st = run(stack, lambda: stack.webhook("reminders-run", {}), expect=["07c_reminders"])
    M = {m["id"]: m for m in mock.table("Meetings")}
    s = mock.state()
    c.ok(M[soon["id"]]["status"] == "Reminded" and any("Erinnerung" in g["subject"] for g in s["gmail"]), "reminder email 24 h before (guarded, test inbox)")
    c.ok(any("held or no-show" in m["text"].lower() for m in s["slack"]) and M[past["id"]].get("held_check_sent_at"), "15 min after start Slack asks 'Held or no-show?'")
    all_success(c, {k: v for k, v in st.items() if k == "07c_reminders"}, ["07c_reminders"])
    return c


def t08_reporting(stack, mock):
    c = Check("08 reporting")
    mock.reset()
    camp = seed_campaign(mock, status="Live", google_api_cost_eur=0.032, ai_cost_eur=0.068)
    leads = seed_leads(mock, camp["id"], n=4, status="Contacted")
    mock_patch(mock, "Leads", leads[3]["id"], {"status": "Rejected"})
    mock_patch(mock, "Leads", leads[0]["id"], {"status": "Meeting booked"})
    em = seed_emails(mock, leads[:3])
    for e in em:
        if e["fields"]["step"] == 1:
            mock_patch(mock, "Emails", e["id"], {"status": "Sent", "sent_at": iso(now() - timedelta(days=1))})
    mock.seed("Replies", [{"key": "r1", "lead": [leads[0]["id"]], "lead_record_id": leads[0]["id"], "category": "Interested", "received_at": iso(now())},
                          {"key": "r2", "lead": [leads[1]["id"]], "lead_record_id": leads[1]["id"], "category": "Not interested", "received_at": iso(now())}])
    mock.seed("Meetings", [{"key": "m1", "lead": [leads[0]["id"]], "lead_record_id": leads[0]["id"], "status": "Booked", "start_time": iso(now() + timedelta(days=2))}])
    resp, ex, st = run(stack, lambda: stack.webhook("reporting-run", {"weekly": True}), expect=["08_reporting"])
    m = resp.json()
    cm = next(x for x in m["campaigns"] if x["campaign_id"] == camp["id"])
    expect = {"leads_sourced": 4, "enriched": 3, "emails_sent": 3, "contacted": 3, "replied": 2, "positive_replies": 1, "meetings_booked": 1}
    c.ok(all(cm[k] == v for k, v in expect.items()), "dashboard counts equal the seeded counts", {k: cm[k] for k in expect})
    c.ok(cm["cost_per_lead_eur"] == 0.025 and cm["cost_per_meeting_eur"] == 0.1, "cost per lead / per meeting (Google + AI)", (cm["cost_per_lead_eur"], cm["cost_per_meeting_eur"]))
    g = m["guarantees"][0]
    c.ok(g["target_positive_replies"] == 20 and g["positive_replies"] == 1 and g["meetings"] == 1, "guarantee tracker vs 20 / 4", g)
    cf = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])
    c.ok(cf.get("emails_sent") == 3 and cf.get("reply_rate_pct") == 66.7, "metrics written to Airtable for the Interface", (cf.get("emails_sent"), cf.get("reply_rate_pct")))
    s = mock.state()
    c.ok(any("Wochenbericht" in x["text"] for x in s["slack"]), "weekly report posted to Slack (manual trigger)")
    c.ok(any("Wochenbericht" in x["subject"] for x in s["gmail"]), "weekly report emailed (guarded)")
    all_success(c, {k: v for k, v in st.items() if k == "08_reporting"}, ["08_reporting"])
    return c


def t08b_dashboard(stack, mock):
    import requests
    c = Check("08b live dashboard")
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Meeting booked"})
    mock.seed("Replies", [{"key": "r", "lead": [lead["id"]], "lead_record_id": lead["id"], "category": "Interested", "received_at": iso(now()), "summary": "Möchte einen Termin <script>"}])
    mock.seed("Meetings", [{"key": "m", "lead": [lead["id"]], "lead_record_id": lead["id"], "status": "Booked", "start_time": iso(now() + timedelta(days=2))}])
    t0 = time.time()
    no_login = requests.get(f"{stack.base}/webhook/dashboard", timeout=60)
    c.ok(no_login.status_code == 401 and "Basic" in no_login.headers.get("www-authenticate", ""), "dashboard needs the login (401 + Basic challenge without)", no_login.status_code)
    c.ok(requests.get(f"{stack.base}/webhook/dashboard", auth=("admin", "wrong"), timeout=60).status_code == 401, "wrong password → 401")
    page = requests.get(f"{stack.base}/webhook/dashboard", auth=AUTH, timeout=60)
    c.ok(page.status_code == 200 and "text/html" in page.headers.get("content-type", ""), "dashboard answers with an HTML page", page.status_code)
    c.ok(time.time() - t0 < 10, "loads in under 10 seconds", round(time.time() - t0, 1))
    h = page.text
    c.ok("Garantie" in h and "Real Service GmbH" in h and "1 / 20" in h and "1 / 4" in h, "guarantee per client: 1/20 positive replies, 1/4 meetings", h[h.find("Garantie"):h.find("Garantie") + 300] if "Garantie" in h else h[:200])
    c.ok("Glanzwerk" in h and "Anstehende Termine" in h, "campaign row, recent reply and upcoming meeting shown")
    c.ok("&lt;script&gt;" in h and "<script>" not in h, "data from replies is escaped")
    cid = client_id(mock)
    c.ok(requests.get(f"{stack.base}/webhook/dashboard", params={"client": cid}, auth=AUTH, timeout=60).status_code == 200, "client filter works")
    return c


def t16_control_center(stack, mock):
    import requests
    c = Check("16 Control Center: login, clients, campaign create/launch/pause, leads, replies")
    base = f"{stack.base}/webhook"
    act = lambda form: requests.post(f"{base}/app-action", data=form, auth=AUTH, allow_redirects=False, timeout=60)  # noqa: E731
    mock.reset()
    # login
    r = requests.get(f"{base}/app", timeout=30)
    c.ok(r.status_code == 401 and "Basic" in r.headers.get("www-authenticate", ""), "no login → 401 with a Basic login prompt", r.status_code)
    c.ok(requests.post(f"{base}/app-action", data={"action": "campaign_stop", "id": "x"}, timeout=30).status_code == 401, "actions without login → 401")
    r = requests.get(f"{base}/app", auth=AUTH, timeout=60)
    c.ok(r.status_code == 200 and "<h1>Übersicht</h1>" in r.text and "Testmodus" in r.text, "overview page after login", r.status_code)
    for p in ("campaigns", "new-campaign", "replies", "meetings", "clients", "system"):
        rr = requests.get(f"{base}/app", params={"p": p}, auth=AUTH, timeout=60)
        c.ok(rr.status_code == 200 and "<h1>" in rr.text, f"page {p} renders", rr.status_code)
    # client: create, then validation error
    r = act({"action": "client_save", "id": "", "name": "Müller Facility GmbH", "sender_name": "Tom Müller", "sender_title": "Geschäftsführer", "sender_company": "Müller Facility GmbH",
             "sender_company_footer": "Müller Facility GmbH · Musterstr. 1, 10115 Berlin", "offer": "Wir reinigen Büros und Praxen in Berlin.", "target_positive_replies": "20", "target_meetings": "4"})
    clients = mock.table("Clients")
    c.ok(r.status_code == 303 and r.headers.get("location", "").startswith(stack.base + "/webhook/app?p=clients") and any(k["name"] == "Müller Facility GmbH" for k in clients),
         "new client saved → redirected to the client list (full address)", (r.status_code, r.headers.get("location")))
    follow = requests.get(r.headers["location"], auth=AUTH, timeout=60)
    c.ok(follow.status_code == 200 and "Müller Facility GmbH" in follow.text and "gespeichert" in follow.text, "following the redirect shows the page with the confirmation", follow.status_code)
    r = act({"action": "client_save", "id": "", "name": "Ohne Angebot", "sender_name": "X", "sender_company_footer": "Y"})
    c.ok(r.status_code == 303 and "err=1" in r.headers.get("location", "") and not any(k["name"] == "Ohne Angebot" for k in mock.table("Clients")), "invalid client is refused with a message")
    # campaign: create (click 1) → sourcing chain runs
    resp, ex, st = run(stack, lambda: act({"action": "campaign_create", "name": "CC Test", "client": "Real Service GmbH", "industry": "Reinigungsunternehmen", "city": "Berlin",
                                           "company_size": "10-49", "target_role": "Geschäftsführer", "max_leads": "10"}), expect=["16_control_center"] + CHAIN, timeout=200)
    camps = mock.table("Campaigns")
    camp = camps[0] if camps else {}
    c.ok(resp.status_code == 303 and f"id={camp.get('id')}" in resp.headers.get("location", ""), "campaign created → redirected to its page", resp.headers.get("location"))
    c.ok(camp.get("client_record_id") == client_id(mock) and len(mock.state()["google_calls"]) == 1, "for the chosen client, Google search started", (camp.get("client_record_id"), len(mock.state()["google_calls"])))
    for _ in range(60):
        if next((x for x in mock.table("Campaigns") if x["id"] == camp["id"]), {}).get("status") == "Ready":
            break
        time.sleep(1)
    page = requests.get(f"{base}/app", params={"p": "campaign", "id": camp["id"]}, auth=AUTH, timeout=60).text
    c.ok("Approve and launch" in page and "Glanzwerk" in page, "campaign page: leads and the launch button", page[:200] if "Glanzwerk" not in page else "")
    # leads: exclude one, rewrite another
    approved = [l for l in mock.table("Leads") if l["campaign_record_id"] == camp["id"] and l["status"] == "Approved"]
    ex_lead, rw_lead = approved[0], approved[1]
    act({"action": "lead_exclude", "id": ex_lead["id"]})
    c.ok(next(l for l in mock.table("Leads") if l["id"] == ex_lead["id"])["status"] == "Rejected", "lead excluded → Rejected")
    old_ids = {e["id"] for e in mock.table("Emails") if e["lead_record_id"] == rw_lead["id"]}
    run(stack, lambda: act({"action": "lead_rewrite", "id": rw_lead["id"]}), expect=["16_control_center", "04_ai_emails"], timeout=120)
    new = [e for e in mock.table("Emails") if e["lead_record_id"] == rw_lead["id"]]
    c.ok(len(new) == 4 and not ({e["id"] for e in new} & old_ids) and next(l for l in mock.table("Leads") if l["id"] == rw_lead["id"])["status"] == "Approved",
         "rewrite: old emails deleted, 4 new ones, lead Approved again", (len(new), len(old_ids)))
    # edit one email by hand: framed and rule-checked; a rule-breaking edit is refused
    e2 = next(e for e in mock.table("Emails") if e["lead_record_id"] == rw_lead["id"] and int(e["step"]) == 2)
    r = act({"action": "email_save", "id": e2["id"], "subject": e2["subject"], "text": "Ein kurzer Nachtrag zu Ihren Objekten in Berlin.\n\nPasst Ihnen Dienstag oder Donnerstag?"})
    e2n = next(e for e in mock.table("Emails") if e["id"] == e2["id"])
    c.ok("err=1" not in r.headers.get("location", "") and "Ein kurzer Nachtrag zu Ihren Objekten in Berlin." in e2n["body"] and "Mit freundlichen Grüßen" in e2n["body"] and "Antworten Sie mit STOP" in e2n["body"] and e2n.get("edited_by"),
         "manual edit saved with salutation, signature and legal footer added by code", r.headers.get("location"))
    r = act({"action": "email_save", "id": e2["id"], "subject": e2["subject"], "text": "Wir sind Ihr zuverlässiger Partner."})
    c.ok("err=1" in r.headers.get("location", "") and next(e for e in mock.table("Emails") if e["id"] == e2["id"])["body"] == e2n["body"], "a rule-breaking edit is refused and nothing changes")
    # approve a held lead by hand
    held = approved[2]
    mock_patch(mock, "Leads", held["id"], {"status": "Needs review", "needs_review_reason": "quality 70 below 80 after one rewrite"})
    for e in [e for e in mock.table("Emails") if e["lead_record_id"] == held["id"]]:
        mock_patch(mock, "Emails", e["id"], {"status": "Draft", "approved": False, "quality_score": 70})
    act({"action": "lead_approve", "id": held["id"]})
    hl = next(l for l in mock.table("Leads") if l["id"] == held["id"])
    hes = [e for e in mock.table("Emails") if e["lead_record_id"] == held["id"]]
    c.ok(hl["status"] == "Approved" and all(e["status"] == "Approved" and e.get("approved_by") for e in hes), "held lead approved by hand → lead and its 4 emails Approved", (hl["status"], [e["status"] for e in hes]))
    # rewrite the whole campaign before launch
    before_ids = {e["id"] for e in mock.table("Emails")}
    run(stack, lambda: act({"action": "campaign_rewrite", "id": camp["id"]}), expect=["16_control_center", "04_ai_emails"], timeout=150)
    cl = [l for l in mock.table("Leads") if l["campaign_record_id"] == camp["id"] and l["status"] == "Approved"]
    fresh = [e for e in mock.table("Emails") if e["lead_record_id"] in {l["id"] for l in cl}]
    c.ok(cl and len(fresh) == 4 * len(cl) and not ({e["id"] for e in fresh} & before_ids), "whole campaign rewritten: every approved lead has 4 new emails", (len(cl), len(fresh)))
    # launch (click 3) through the same logic as the Slack button
    run(stack, lambda: act({"action": "campaign_launch", "id": camp["id"]}), expect=["16_control_center", "11_slack_actions", "05_campaign_launch", "06_sending"], timeout=150)
    camp = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])
    sent = [g for g in mock.state()["gmail"] if "Kampagne bereit" not in g["subject"]]
    c.ok(camp["status"] == "Live" and sent and all(g["to"] == PROSPECT and g["test_marker"] == "true" for g in sent), "launch from the Control Center → Live, first emails only to the test inbox (marked as test)", (camp["status"], len(sent)))
    c.ok(not any(e for e in mock.table("Emails") if e["lead_record_id"] == ex_lead["id"] and e["status"] == "Sent"), "the excluded lead got nothing")
    c.ok(any("Approve and launch by Control Center" in m["text"] for m in mock.state()["slack"]), "Slack shows who launched it")
    # pause → nothing is sent; resume → Live
    act({"action": "campaign_pause", "id": camp["id"]})
    c.ok(next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])["status"] == "Paused", "pause → Paused")
    before = len(mock.state()["gmail"])
    lead = next(l for l in mock.table("Leads") if l["campaign_record_id"] == camp["id"] and l["status"] == "Contacted")
    mock_patch(mock, "Leads", lead["id"], {"next_send_at": iso(now() - timedelta(seconds=5))})
    run(stack, lambda: stack.webhook("sending-run", {}), expect=["06_sending"])
    c.ok(len(mock.state()["gmail"]) == before, "a paused campaign sends nothing", len(mock.state()["gmail"]) - before)
    act({"action": "campaign_resume", "id": camp["id"]})
    c.ok(next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])["status"] == "Live", "resume → Live")
    # replies: a question waits for approval; approve with edited text
    thread = next(e["thread_id"] for e in mock.table("Emails") if e["lead_record_id"] == lead["id"] and e["status"] == "Sent")
    run(stack, lambda: post_reply(stack, "question_01", thread), expect=["07_replies"])
    rep = next(x for x in mock.table("Replies") if x["lead_record_id"] == lead["id"])
    page = requests.get(f"{base}/app", params={"p": "replies"}, auth=AUTH, timeout=60).text
    c.ok('name="action" value="reply_approve"' in page and rep["id"] in page, "the question waits on the replies page")
    before = len(mock.state()["gmail"])
    run(stack, lambda: act({"action": "reply_approve", "id": rep["id"], "text": "Guten Tag,\n\ngern erkläre ich Ihnen den Ablauf in 15 Minuten. Passt Ihnen Dienstag?\n\nMit freundlichen Grüßen\nLaura Schmidt"}),
        expect=["16_control_center", "11_slack_actions", "13_send_email"], timeout=120)
    mails = mock.state()["gmail"][before:]
    rep = next(x for x in mock.table("Replies") if x["id"] == rep["id"])
    c.ok(len(mails) == 1 and "gern erkläre ich Ihnen den Ablauf" in mails[0]["body"] and mails[0]["threadId"] == thread and rep.get("reply_approved") is True,
         "approve with edited text → exactly that text sent in the thread, reply marked answered", (len(mails), rep.get("reply_approved")))
    r = act({"action": "reply_approve", "id": rep["id"], "text": "nochmal"})
    c.ok("err=1" in r.headers.get("location", ""), "approving twice is refused (never sent twice)")
    # meetings: "Termin absagen" cancels in Airtable and Calendly, lead back to Interested
    mock_patch(mock, "Leads", lead["id"], {"status": "Meeting booked", "next_send_at": None})
    meet = mock.seed("Meetings", [{"key": "cc-m", "lead": [lead["id"]], "lead_record_id": lead["id"], "status": "Booked", "start_time": iso(now() + timedelta(days=3)), "calendly_event_id": "CC-EVT-1"}])[0]
    page = requests.get(f"{base}/app", params={"p": "meetings"}, auth=AUTH, timeout=60).text
    c.ok('value="meeting_cancel"' in page and meet["id"] in page, "meetings page: upcoming meeting has 'Termin absagen'")
    run(stack, lambda: act({"action": "meeting_cancel", "id": meet["id"]}), expect=["16_control_center", "11_slack_actions"], timeout=120)
    m = next(x for x in mock.table("Meetings") if x["id"] == meet["id"])
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    cx = mock.state()["calendly_cancellations"]
    c.ok(m["status"] == "Cancelled" and l["status"] == "Interested" and [x["uuid"] for x in cx] == ["CC-EVT-1"],
         "Termin absagen → Meeting Cancelled, lead Interested, event cancelled in Calendly", (m["status"], l["status"], cx))
    c.ok(any("cancelled (also in Calendly" in x["text"] for x in mock.state()["slack"]), "Slack confirms the cancel (also in Calendly)")
    r = act({"action": "meeting_cancel", "id": meet["id"]})
    c.ok("err=1" in r.headers.get("location", ""), "cancelling twice is refused")
    # security: the internal entry needs the key
    before_status = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])["status"]
    run(stack, lambda: stack.webhook("control-action", {"action": "approve_launch", "recordId": camp["id"]}), expect=["11_slack_actions"])
    c.ok(next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])["status"] == before_status, "control-action without the key does nothing")
    return c


def t09_inbound(stack, mock):
    c = Check("09 inbound lead")
    mock.reset()
    t0 = time.time()
    _, ex, st = run(stack, lambda: stack.webhook("inbound-lead", fixture("webhooks/quiz_submission.json")), expect=["09_inbound_leads"])
    L = mock.table("Leads")
    T = mock.table("Tasks")
    s = mock.state()
    c.ok(len(L) == 1 and L[0]["lead_type"] == "Inbound quiz" and L[0].get("inbound_temperature") == "hot", "scored lead (hot)", L)
    c.ok(len(T) == 1 and T[0]["type"] == "Call inbound lead", "call task created", T)
    due = datetime.fromisoformat(T[0]["due_at"].replace("Z", "+00:00")) if T else now()
    c.ok(10 <= (due - now()).total_seconds() / 60 <= 16, "hot lead: due in 15 minutes", due)
    brief = [m for m in s["slack"] if "inbound lead" in m["text"]]
    c.ok(brief and any(e["action_id"] == "task_called" for b in brief[0]["blocks"] if b["type"] == "actions" for e in b["elements"]), "Slack brief with 'Mark called'")
    c.ok(any("Danke für Ihre Anfrage" in g["subject"] and g["to"] == PROSPECT for g in s["gmail"]), "instant confirmation email (guarded)")
    c.ok(time.time() - t0 < 60, "within 1 minute", round(time.time() - t0, 1))
    all_success(c, {k: v for k, v in st.items() if k == "09_inbound_leads"}, ["09_inbound_leads"])
    # same person again → no duplicate lead
    run(stack, lambda: stack.webhook("inbound-lead", fixture("webhooks/quiz_submission.json")), expect=["09_inbound_leads"])
    c.ok(len(mock.table("Leads")) == 1, "dedupe by email: second submission updates the same lead")
    return c


def t10_crm(stack, mock):
    c = Check("10 CRM sync")
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Meeting booked"})
    mock.seed("Meetings", [{"key": "m", "lead": [lead["id"]], "lead_record_id": lead["id"], "status": "Booked", "start_time": iso(now() + timedelta(days=2))}])
    _, ex, st = run(stack, lambda: stack.webhook("crm-sync", {"lead_record_id": lead["id"]}), expect=["10_crm_sync"])
    hs = mock.state()["hubspot"]
    c.ok(len(hs["contacts"]) == 1 and len(hs["companies"]) == 1 and len(hs["deals"]) == 1, "one contact, company and deal", {k: len(v) for k, v in hs.items() if isinstance(v, dict)})
    deal = list(hs["deals"].values())[0]["properties"] if hs["deals"] else {}
    c.ok(deal.get("dealstage") == "appointmentscheduled" and deal.get("closedate"), "deal in stage 'Meeting booked' with the meeting date", deal)
    c.ok(len(hs["associations"]) == 3 and len(hs["notes"]) == 1, "associations and a note", (len(hs["associations"]), len(hs["notes"])))
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    c.ok(l.get("hubspot_contact_id") and l.get("hubspot_deal_id") and l.get("crm_synced_status") == "Meeting booked", "HubSpot ids saved back to Airtable")
    # re-run: force a second sync of the same lead
    mock_patch(mock, "Leads", lead["id"], {"crm_synced_status": None, "status": "Meeting held"})
    run(stack, lambda: stack.webhook("crm-sync", {}), expect=["10_crm_sync"])
    hs = mock.state()["hubspot"]
    c.ok(len(hs["contacts"]) == 1 and len(hs["companies"]) == 1 and len(hs["deals"]) == 1, "re-running creates no duplicates", {k: len(v) for k, v in hs.items() if isinstance(v, dict)})
    c.ok(list(hs["deals"].values())[0]["properties"]["dealstage"] == "qualifiedtobuy", "Meeting held updates the deal stage")
    all_success(c, {k: v for k, v in st.items() if k == "10_crm_sync"}, ["10_crm_sync"])
    # race (live): another run created the contact a moment ago, HubSpot's search does not show it yet → 409 → existing id
    import requests as rq
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Interested"})
    lead_email = next(x for x in mock.table("Leads") if x["id"] == lead["id"])["email"]
    rq.post(mock.base + "/_control/hubspot_seed", json={"type": "contacts", "id": "925138341073", "unindexed": True, "properties": {"email": lead_email, "firstname": "Other run"}}, timeout=5)
    _, ex, st = run(stack, lambda: stack.webhook("crm-sync", {"lead_record_id": lead["id"]}), expect=["10_crm_sync"])
    hs = mock.state()["hubspot"]
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    c.ok(len(hs["contacts"]) == 1 and l.get("hubspot_contact_id") == "925138341073" and l.get("crm_synced_status") == "Interested",
         "contact exists but is not searchable yet → 409 → the existing contact is used, no duplicate, run completes", (len(hs["contacts"]), l.get("hubspot_contact_id")))
    c.ok(["contact", "925138341073", "company", list(hs["companies"])[0]] in hs["associations"], "the existing contact is linked to the company")
    all_success(c, {k: v for k, v in st.items() if k == "10_crm_sync"}, ["10_crm_sync"])
    # ids saved in Airtable are used directly (no search): nothing new is created even if search shows nothing
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    for t, i in (("contacts", "501"), ("companies", "502"), ("deals", "503")):
        rq.post(mock.base + "/_control/hubspot_seed", json={"type": t, "id": i, "unindexed": True, "properties": {"dealname": "x"} if t == "deals" else {}}, timeout=5)
    mock_patch(mock, "Leads", lead["id"], {"status": "Meeting held", "hubspot_contact_id": "501", "hubspot_company_id": "502", "hubspot_deal_id": "503", "crm_synced_status": "Interested"})
    _, ex, st = run(stack, lambda: stack.webhook("crm-sync", {"lead_record_id": lead["id"]}), expect=["10_crm_sync"])
    hs = mock.state()["hubspot"]
    c.ok({k: len(v) for k, v in hs.items() if k in ("contacts", "companies", "deals")} == {"contacts": 1, "companies": 1, "deals": 1} and hs["deals"]["503"]["properties"].get("dealstage") == "qualifiedtobuy",
         "saved HubSpot ids → the same contact, company and deal are updated, nothing duplicated", {k: list(v) for k, v in hs.items() if k in ("contacts", "companies", "deals")})
    all_success(c, {k: v for k, v in st.items() if k == "10_crm_sync"}, ["10_crm_sync"])
    # HubSpot's own "create companies with contacts" automation (on by default in the fake, as in the live portal) must
    # not lead to a second company; with the automation off, the workflow creates exactly one itself
    for auto in (True, False):
        mock.reset()
        __import__("requests").post(mock.base + "/_control/hubspot_auto_company", json={"on": auto}, timeout=5)
        camp, lead, em = seed_contacted_lead(mock)
        mock_patch(mock, "Leads", lead["id"], {"status": "Interested"})
        _, ex, st = run(stack, lambda: stack.webhook("crm-sync", {"lead_record_id": lead["id"]}), expect=["10_crm_sync"])
        hs = mock.state()["hubspot"]
        l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
        co = list(hs["companies"].values())
        c.ok(len(co) == 1 and l.get("hubspot_company_id") == co[0]["id"] and co[0]["properties"].get("name"),
             f"HubSpot company automation {'on' if auto else 'off'} → exactly 1 company, named, saved on the lead", [(x["id"], x["properties"].get("name")) for x in co])
        all_success(c, {k: v for k, v in st.items() if k == "10_crm_sync"}, ["10_crm_sync"])
    # concurrency: fire syncs at the same moment (threads), as two events in the same second would
    import threading

    def burst(bodies):
        def go():
            ts = [threading.Thread(target=lambda b=b: stack.webhook("crm-sync", b)) for b in bodies]
            [t.start() for t in ts]
            [t.join() for t in ts]
        return go

    def counts():
        h = mock.state()["hubspot"]
        return {k: len(h[k]) for k in ("contacts", "companies", "deals")}
    # the same brand-new lead, twice at once
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock_patch(mock, "Leads", lead["id"], {"status": "Interested"})
    _, ex, st = run(stack, burst([{"lead_record_id": lead["id"]}, {"lead_record_id": lead["id"]}]), expect=["10_crm_sync"], timeout=120)
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    c.ok(counts() == {"contacts": 1, "companies": 1, "deals": 1}, "same lead synced twice at the same moment → exactly 1 contact, 1 company, 1 deal", counts())
    c.ok(len(st.get("10_crm_sync", [])) == 2, "both runs ran", st.get("10_crm_sync"))
    c.ok(not l.get("crm_lock") and l.get("crm_synced_status") == "Interested", "lock released, lead marked synced", (l.get("crm_lock"), l.get("crm_synced_status")))
    all_success(c, {k: v for k, v in st.items() if k == "10_crm_sync"}, ["10_crm_sync"])
    # two different new leads, each with its own event, at the same moment
    mock.reset()
    camp = seed_campaign(mock, status="Live")
    two = seed_leads(mock, camp["id"], n=2, status="Interested")
    _, ex, st = run(stack, burst([{"lead_record_id": two[0]["id"]}, {"lead_record_id": two[1]["id"]}]), expect=["10_crm_sync"], timeout=120)
    c.ok(counts() == {"contacts": 2, "companies": 2, "deals": 2}, "two leads at the same moment → each synced exactly once", counts())
    all_success(c, {k: v for k, v in st.items() if k == "10_crm_sync"}, ["10_crm_sync"])
    # a lead locked by another live run is left alone; a stale lock (crashed run) is taken over
    mock.reset()
    camp = seed_campaign(mock, status="Live")
    two = seed_leads(mock, camp["id"], n=2, status="Interested")
    mock_patch(mock, "Leads", two[0]["id"], {"crm_lock": "crm-live-run", "crm_lock_at": iso(now())})
    mock_patch(mock, "Leads", two[1]["id"], {"crm_lock": "crm-crashed-run", "crm_lock_at": iso(now() - timedelta(minutes=10))})
    run(stack, lambda: stack.webhook("crm-sync", {"lead_record_id": two[0]["id"]}), expect=["10_crm_sync"])
    c.ok(counts()["contacts"] == 0 and next(x for x in mock.table("Leads") if x["id"] == two[0]["id"]).get("crm_lock") == "crm-live-run",
         "lead locked by a running sync → this run leaves it alone", counts())
    _, ex, st = run(stack, lambda: stack.webhook("crm-sync", {"lead_record_id": two[1]["id"]}), expect=["10_crm_sync"])
    l = next(x for x in mock.table("Leads") if x["id"] == two[1]["id"])
    c.ok(counts()["contacts"] == 1 and not l.get("crm_lock") and l.get("hubspot_deal_id"), "stale lock (> 2 min) is taken over and synced", (counts(), l.get("crm_lock")))
    all_success(c, {k: v for k, v in st.items() if k == "10_crm_sync"}, ["10_crm_sync"])
    return c


def t11_slack(stack, mock):
    c = Check("11 Slack buttons")
    mock.reset()
    camp = seed_campaign(mock, status="Ready", slack_ts="1763110000.000100")
    leads = seed_leads(mock, camp["id"], n=6)
    seed_emails(mock, leads)
    mock.state()  # warm
    posted = __import__("requests").post(mock.base + "/slack/api/chat.postMessage", json={"channel": "C0LEADS", "text": "Campaign ready"}, timeout=5).json()
    body, headers = slack_signed(slack_click("approve_launch", f"approve_launch|{camp['id']}", ts=posted["ts"]))
    _, ex, st = run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions", "05_campaign_launch", "06_sending"], timeout=120)
    cmp = next(x for x in mock.table("Campaigns") if x["id"] == camp["id"])
    msg = next(m for m in mock.state()["slack"] if m["ts"] == posted["ts"])
    c.ok(cmp["status"] == "Live" and cmp.get("launched_by") == "demo.user", "'Approve and launch' → checks → Live", cmp["status"])
    c.ok(any("Approve and launch by demo.user" in (u.get("text") or "") for u in msg["updates"]), "message updated to '… by <user> at <time>'", msg["updates"])
    # Approve and send a suggested reply
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    rep = mock.seed("Replies", [{"key": "r", "lead": [lead["id"]], "lead_record_id": lead["id"], "category": "Interested", "ai_confidence": 0.8, "subject": "Re: [TEST] Unterhaltsreinigung",
                                 "thread_id": "thr-test-1", "suggested_reply": "Gerne, hier ist der Link: https://calendly.com/nexsale-demo/15min", "from_email": PROSPECT}])[0]
    posted = __import__("requests").post(mock.base + "/slack/api/chat.postMessage", json={"channel": "C0LEADS", "text": "Interested reply"}, timeout=5).json()
    body, headers = slack_signed(slack_click("reply_approve", f"reply_approve|{rep['id']}", ts=posted["ts"]))
    run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions"])
    s = mock.state()
    sent = [g for g in s["gmail"] if g["threadId"] == "thr-test-1"]
    c.ok(len(sent) == 1 and sent[0]["subject"] == "Re: Unterhaltsreinigung", "Approve sends the AI reply in the right email thread", sent)
    msg = next(m for m in s["slack"] if m["ts"] == posted["ts"])
    c.ok(any("Approved by demo.user" in (u.get("text") or "") for u in msg["updates"]), "Slack message changes to 'Approved by …'")
    r = mock.table("Replies")[0]
    c.ok(r.get("reply_approved") is True and r.get("handled_by") == "demo.user", "reply marked approved")
    # a second click must not send twice
    before = len(s["gmail"])
    body, headers = slack_signed(slack_click("reply_approve", f"reply_approve|{rep['id']}", ts=posted["ts"]))
    run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions"])
    c.ok(len(mock.state()["gmail"]) == before, "double click does not send the answer twice")
    # bad signature is rejected
    before_ids = stack.last_execution_id()
    body, headers = slack_signed(slack_click("reply_approve", f"reply_approve|{rep['id']}"), secret="wrong-secret")
    _, ex, st = run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions"])
    c.ok(st.get("11_slack_actions") == ["error"], "wrong Slack signature → rejected", st)
    old_ts = int(time.time()) - 600
    body, headers = slack_signed(slack_click("task_called", "task_called|x"), ts=old_ts)
    _, ex, st = run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions"])
    c.ok(st.get("11_slack_actions") == ["error"], "old Slack signature (replay) → rejected", st)
    # task buttons and meeting buttons
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    task = mock.seed("Tasks", [{"key": "t", "lead": [lead["id"]], "lead_record_id": lead["id"], "type": "Call inbound lead", "status": "Open", "due_at": iso(now())}])[0]
    meet = mock.seed("Meetings", [{"key": "m", "lead": [lead["id"]], "lead_record_id": lead["id"], "status": "Reminded", "start_time": iso(now() - timedelta(minutes=30))}])[0]
    body, headers = slack_signed(slack_click("task_called", f"task_called|{task['id']}"))
    run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions"])
    c.ok(mock.table("Tasks")[0]["status"] == "Done", "Mark called → task Done")
    body, headers = slack_signed(slack_click("meeting_noshow", f"meeting_noshow|{meet['id']}"))
    run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions"])
    c.ok(mock.table("Meetings")[0]["status"] == "No-show" and any(t["type"] == "Call no-show" for t in mock.table("Tasks")), "No-show → call task for the sales caller")
    return c


def t12_delete(stack, mock):
    c = Check("12 GDPR delete")
    mock.reset()
    camp, lead, em = seed_contacted_lead(mock)
    mock.seed("Replies", [{"key": "r", "lead": [lead["id"]], "lead_record_id": lead["id"], "category": "Later"}])
    mock.seed("Tasks", [{"key": "t", "lead": [lead["id"]], "lead_record_id": lead["id"], "type": "Follow up later", "status": "Open"}])
    resp, ex, st = run(stack, lambda: stack.webhook("delete-lead", {"email": lead["fields"]["email"]}), expect=["12_delete_lead"])
    c.ok(not [l for l in mock.table("Leads") if l["id"] == lead["id"]], "lead deleted")
    c.ok(not mock.table("Emails") and not mock.table("Replies") and not mock.table("Tasks"), "its emails, replies and tasks deleted")
    c.ok([b["value"] for b in mock.table("Blocklist")] == [lead["fields"]["email"]], "only the Blocklist entry is kept")
    all_success(c, {k: v for k, v in st.items() if k == "12_delete_lead"}, ["12_delete_lead"])
    return c


SCENARIOS = {"00": t00_error_handler, "01": t01_campaign_setup, "02": t02_lead_sourcing, "03": t03_enrichment, "04": t04_ai_emails, "05": t05_launch,
             "06": t06_sending, "07": t07_replies, "07n": t07_newsletter, "07w": t07w_withdrawal, "07b": t07b_calendly, "07c": t07c_reminders, "07d": t07d_calendly_poll, "08": t08_reporting, "08b": t08b_dashboard, "09": t09_inbound,
             "10": t10_crm, "11": t11_slack, "12": t12_delete, "16": t16_control_center}


def run_scenarios(keys, log=print):
    stack, mock = Stack(), Mock()
    if not mock.up():
        raise SystemExit("mock server not running on :8787")
    out = []
    for k in keys:
        t0 = time.time()
        try:
            c = SCENARIOS[k](stack, mock)
        except Exception as e:  # noqa: BLE001 – report and continue with the next module
            c = Check(f"{k} (crashed)")
            c.ok(False, "scenario ran without exception", "".join(traceback.format_exception_only(type(e), e)).strip())
        dur = round(time.time() - t0, 1)
        res = {"module": k, "name": c.name, "passed": c.passed, "seconds": dur, "checks": c.results}
        out.append(res)
        log(f"[{'PASS' if c.passed else 'FAIL'}] {c.name} ({dur}s, {sum(r['pass'] for r in c.results)}/{len(c.results)} checks)")
        for r in c.results:
            if not r["pass"]:
                log(f"     ✗ {r['check']}: {r['detail']}")
    return out


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    keys = list(SCENARIOS) if arg == "all" else [x.strip() for x in arg.split(",")]
    res = run_scenarios(keys)
    p = ROOT / "tests" / "results"
    p.mkdir(parents=True, exist_ok=True)
    existing = json.loads((p / "level2.json").read_text()) if (p / "level2.json").exists() else {}
    for r in res:
        existing[r["module"]] = dict(r, ran_at=iso(now()))
    (p / "level2.json").write_text(json.dumps(existing, indent=2, ensure_ascii=False))
    sys.exit(0 if all(r["passed"] for r in res) else 1)


if __name__ == "__main__":
    main()
