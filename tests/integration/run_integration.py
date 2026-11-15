"""Level 3 – integration, failure and safety tests (PLAN.md "Testing plan").

Modules are chained exactly as in production (webhook kicks, Slack clicks, replies, Calendly).
Default: test stack + mock server (MOCK_EXTERNAL=true). The same scenarios against real services need
the steps in docs/blockers.md (then use tests/e2e/run_e2e.py --live for the full flow).

Usage: python tests/integration/run_integration.py [integration|failure|safety|all]
"""
import json
import os
import pathlib
import subprocess
import sys
import time
from datetime import timedelta

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "tests" / "workflows"))
from lib import Mock, Stack, fixture, wait_for  # noqa: E402
import run_module as rm  # noqa: E402

PROSPECT = rm.PROSPECT
FORM = {"Campaign name": "Reinigungsunternehmen Berlin", "Industry (search term)": "Reinigungsunternehmen", "City": "Berlin",
        "Company size range": "10-49", "Target role": "Geschäftsführer", "Max leads": "10"}


def campaign(mock):
    return mock.table("Campaigns")[0]


def ready_message(mock):
    return next((m for m in mock.state()["slack"] if m["text"].startswith("Campaign ready")), None)


def click_launch(stack, mock):
    msg = ready_message(mock)
    value = next(e["value"] for b in msg["blocks"] if b["type"] == "actions" for e in b["elements"] if e["action_id"] == "approve_launch")
    body, headers = rm.slack_signed(rm.slack_click("approve_launch", value, ts=msg["ts"]))
    return rm.run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions", "05_campaign_launch", "06_sending"])


def tick_sending(stack, mock, lead_id=None):
    if lead_id:
        rm.mock_patch(mock, "Leads", lead_id, {"next_send_at": rm.iso(rm.now() - timedelta(seconds=5))})
    return rm.run(stack, lambda: stack.webhook("sending-run", {}), expect=["06_sending"])


def sourcing_chain(stack, mock):
    mock.reset()
    t0 = time.time()
    rm.run(stack, lambda: stack.submit_form(FORM), expect=["01_campaign_setup"] + rm.CHAIN, timeout=240)
    # Module 4 can run twice (a quick empty run, then the drafting run); the quiet-period wait may return between them.
    # Wait explicitly for the message the next step needs – it is still required, only no longer timing-dependent.
    while ready_message(mock) is None and time.time() - t0 < 240:
        time.sleep(1)
    if ready_message(mock) is None:
        raise AssertionError("no 'Campaign ready' message within 240 s; leads: " + str(sorted({l.get("status") for l in mock.table("Leads")})))
    return time.time() - t0


# ---------------------------------------------------------------- integration scenarios
def s1_sourcing_chain(stack, mock):
    c = rm.Check("I1 sourcing chain (Modules 1–4): form → 'Campaign ready', no clicks")
    secs = sourcing_chain(stack, mock)
    c.ok(ready_message(mock) is not None, "'Campaign ready' arrives with no clicks")
    c.ok(secs < 15 * 60, "within 15 minutes", f"{secs:.0f}s")
    c.ok(len(mock.state()["google_calls"]) == 1, "using 1 Google request")
    c.ok(campaign(mock)["status"] == "Ready", "campaign Ready")
    return c


def s2_launch_chain(stack, mock):
    c = rm.Check("I2 launch chain (Modules 5–6): Approve and launch → 4 [TEST] emails in one thread")
    sourcing_chain(stack, mock)
    click_launch(stack, mock)
    c.ok(campaign(mock)["status"] == "Live", "campaign Live after one click")
    first = mock.state()["gmail"]
    outreach = [g for g in first if "Campaign ready" not in g["subject"]]
    c.ok(outreach and all(g["to"] == PROSPECT and g["subject"].startswith("[TEST]") for g in outreach), "first emails are [TEST] in the test inbox", len(outreach))
    lead = next(l for l in mock.table("Leads") if l["status"] == "Contacted")
    thread = next(e["thread_id"] for e in mock.table("Emails") if e["lead_record_id"] == lead["id"] and e["status"] == "Sent")
    for _ in range(3):
        tick_sending(stack, mock, lead["id"])
    mine = [g for g in mock.state()["gmail"] if g["threadId"] == thread]
    c.ok(len(mine) == 4, "one lead received 4 emails in ONE thread", len(mine))
    c.ok(all(g["subject"].startswith("[TEST]") for g in mine), "all [TEST]")
    return c


def interested_reply(stack, mock, lead, body="Klingt interessant, haben Sie nächste Woche Zeit?"):
    thread = next(e["thread_id"] for e in mock.table("Emails") if e["lead_record_id"] == lead["id"] and e["status"] == "Sent")
    msg = {"message_id": "m-int", "thread_id": thread, "from": PROSPECT, "subject": "Re: [TEST] Unterhaltsreinigung", "body": body, "received_at": rm.iso(rm.now())}
    rm.run(stack, lambda: stack.webhook("reply-ingest", msg), expect=["07_replies"])
    return thread


def book(stack, mock, lead):
    created = fixture("webhooks/calendly_invitee_created.json")
    created["payload"]["email"] = PROSPECT
    created["payload"]["tracking"] = {"utm_content": lead["id"]}
    rm.run(stack, lambda: stack.webhook("calendly", created), expect=["07b_calendly", "10_crm_sync"])


def s3_reply_chain(stack, mock):
    c = rm.Check("I3 reply chain (7, 10, 11): interested → auto answer → booking → Meeting booked + HubSpot deal")
    sourcing_chain(stack, mock)
    click_launch(stack, mock)
    lead = next(l for l in mock.table("Leads") if l["status"] == "Contacted")
    thread = interested_reply(stack, mock, lead)
    ans = [g for g in mock.state()["gmail"] if g["threadId"] == thread and "calendly.com" in g["body"]]
    c.ok(len(ans) == 1, "automatic answer with the Calendly link in the same thread", len(ans))
    book(stack, mock, lead)
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    hs = mock.state()["hubspot"]
    c.ok(l["status"] == "Meeting booked", "Meeting booked in Airtable", l["status"])
    c.ok(len(hs["deals"]) == 1 and list(hs["deals"].values())[0]["properties"]["dealstage"] == "appointmentscheduled", "one deal in HubSpot", len(hs["deals"]))
    return c


def s4_unsure(stack, mock):
    c = rm.Check("I4 unsure reply: Slack buttons → click Interested → same result as I3")
    sourcing_chain(stack, mock)
    click_launch(stack, mock)
    lead = next(l for l in mock.table("Leads") if l["status"] == "Contacted")
    thread = interested_reply(stack, mock, lead, body=fixture("replies/unclear_01.json")["body"])
    sort = next((m for m in mock.state()["slack"] if "Please sort this reply" in m["text"]), None)
    c.ok(sort is not None, "Slack asks to sort the reply")
    value = next(e["value"] for b in sort["blocks"] if b["type"] == "actions" for e in b["elements"] if e["action_id"] == "sort_interested")
    body, headers = rm.slack_signed(rm.slack_click("sort_interested", value, ts=sort["ts"]))
    rm.run(stack, lambda: stack.webhook("slack-actions", raw=body, headers=headers), expect=["11_slack_actions", "07_replies"])
    ans = [g for g in mock.state()["gmail"] if g["threadId"] == thread and "calendly.com" in g["body"]]
    c.ok(len(ans) == 1, "after the click: automatic answer with Calendly link", len(ans))
    upd = next(m for m in mock.state()["slack"] if m["ts"] == sort["ts"])["updates"]
    c.ok(any("Sorted as Interested by demo.user" in (u.get("text") or "") for u in upd), "Slack message shows who sorted it")
    book(stack, mock, lead)
    c.ok(next(x for x in mock.table("Leads") if x["id"] == lead["id"])["status"] == "Meeting booked" and len(mock.state()["hubspot"]["deals"]) == 1, "booking → Meeting booked + deal")
    return c


def s5_inbound(stack, mock):
    c = rm.Check("I5 inbound chain (9, 10): quiz → call task + Slack brief within 1 minute")
    mock.reset()
    t0 = time.time()
    rm.run(stack, lambda: stack.webhook("inbound-lead", fixture("webhooks/quiz_submission.json")), expect=["09_inbound_leads"])
    c.ok(time.time() - t0 < 60 and mock.table("Tasks") and any("inbound lead" in m["text"] for m in mock.state()["slack"]), "task + brief within 1 minute", round(time.time() - t0, 1))
    rm.run(stack, lambda: stack.webhook("crm-sync", {}), expect=["10_crm_sync"])
    c.ok(len(mock.state()["hubspot"]["contacts"]) == 1, "inbound lead (status Interested) synced to HubSpot")
    return c


def s6_stop_rules(stack, mock):
    c = rm.Check("I6 stop rules: reply after email 1 stops 2–4; STOP → Blocklist and a new campaign skips it")
    sourcing_chain(stack, mock)
    click_launch(stack, mock)
    leads = [l for l in mock.table("Leads") if l["status"] == "Contacted"]
    a, b = leads[0], leads[1]
    interested_reply(stack, mock, a, body="Danke, aber wir haben kein Interesse. Wir sind ausgelastet.")
    before = len([g for g in mock.state()["gmail"]])
    thread_a = next(e["thread_id"] for e in mock.table("Emails") if e["lead_record_id"] == a["id"] and e["status"] == "Sent")
    for _ in range(3):
        tick_sending(stack, mock, a["id"])
    c.ok(len([g for g in mock.state()["gmail"] if g["threadId"] == thread_a]) == 1, "emails 2–4 never send after a reply")
    interested_reply(stack, mock, b, body="STOP")
    c.ok(any(x["value"] == b["email"] for x in mock.table("Blocklist")), "STOP → Blocklist")
    # new campaign containing the same company: it is rejected / never sent
    camp2 = rm.seed_campaign(mock, status="Launch", name="Second campaign")
    l2 = rm.seed_leads(mock, camp2["id"], n=5)
    rm.mock_patch(mock, "Leads", l2[0]["id"], {"email": b["email"], "domain": b["domain"]})
    rm.seed_emails(mock, l2)
    rm.run(stack, lambda: stack.webhook("campaign-launch", {}), expect=["05_campaign_launch"])
    c2 = next(x for x in mock.table("Campaigns") if x["id"] == camp2["id"])
    c.ok(c2["status"] == "Ready" and "Blocklist" in (c2.get("launch_failures") or ""), "a new campaign with that address fails the Blocklist check", c2.get("launch_failures"))
    for _ in range(2):
        tick_sending(stack, mock, b["id"])
    sent_b = [e for e in mock.table("Emails") if e["lead_record_id"] == b["id"] and e["status"] == "Sent"]
    c.ok(len(sent_b) == 1, "nothing sent to the unsubscribed address after STOP", len(sent_b))
    return c


# ---------------------------------------------------------------- failure tests
def f1_google(stack, mock):
    return rm.t00_error_handler(stack, mock)


def f2_ai_broken(stack, mock):
    c = rm.Check("F2 AI returns broken JSON → one retry → Needs review")
    mock.reset()
    camp = rm.seed_campaign(mock, leads_sourced=1)
    rm.seed_leads(mock, camp["id"], n=1, status="Enriched")
    mock.ai_mode("broken_json", "email_sequence", count=2)
    rm.run(stack, lambda: stack.webhook("ai-emails-run", {}), expect=["04_ai_emails"])
    calls = [a for a in mock.state()["ai_calls"] if a["prompt_id"] == "email_sequence"]
    c.ok(len(calls) == 2, "exactly one retry", len(calls))
    c.ok(mock.table("Leads")[0]["status"] == "Needs review", "lead → Needs review")
    mock.reset()
    camp = rm.seed_campaign(mock, leads_sourced=1)
    rm.seed_leads(mock, camp["id"], n=1, status="Enriched")
    mock.ai_mode("broken_json", "email_sequence", count=1)
    rm.run(stack, lambda: stack.webhook("ai-emails-run", {}), expect=["04_ai_emails"])
    c.ok(mock.table("Leads")[0]["status"] == "Approved", "broken once → retry succeeds → Approved")
    return c


def f3_airtable_429(stack, mock):
    c = rm.Check("F3 Airtable 429 → wait and retry, no lost records")
    mock.reset()
    camp = rm.seed_campaign(mock)
    # fail the next 2 Airtable calls (the first reads of Module 2) – retries absorb them
    mock.fail("airtable", 429, 2)
    _, ex, st = rm.run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=rm.CHAIN, timeout=200)
    c.ok(len(mock.table("Leads")) == 10, "all 10 leads stored despite 429s", len(mock.table("Leads")))
    c.ok(st.get("02_lead_sourcing") == ["success"], "run succeeded after waiting", st.get("02_lead_sourcing"))
    # a 429 that never stops → the run fails loudly, the error handler reports it
    mock.reset()
    camp = rm.seed_campaign(mock)
    mock.fail("airtable", 429, 3)
    _, ex, st = rm.run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=["02_lead_sourcing", "00_error_handler"], timeout=120)
    c.ok(st.get("02_lead_sourcing") == ["error"] and mock.state()["slack_webhook"], "persistent 429 → error + Slack alert, never silent", st)
    return c


def f4_credentials(stack, mock):
    c = rm.Check("F4 Gmail / Slack credential expired → error handler posts with the workflow name")
    mock.reset()
    camp = rm.seed_campaign(mock, status="Live")
    leads = rm.seed_leads(mock, camp["id"], n=1, sequence_step=1, next_send_at=rm.iso(rm.now() - timedelta(minutes=1)))
    rm.seed_emails(mock, leads)
    mock.fail("gmail", 401, 3)
    _, ex, st = rm.run(stack, lambda: stack.webhook("sending-run", {}), expect=["06_sending", "00_error_handler"], timeout=120)
    alerts = [m.get("text", "") for m in mock.state()["slack_webhook"]]
    c.ok(any("Nexsale 13" in a or "Nexsale 06" in a for a in alerts), "Gmail 401 → Slack alert names the workflow", alerts)
    c.ok(next(e for e in mock.table("Emails") if e["step"] == 1)["status"] == "Approved", "the email is not marked Sent (will retry next tick)")
    mock.reset()
    mock.fail("slack", 401, 3)
    rm.run(stack, lambda: stack.webhook("inbound-lead", fixture("webhooks/quiz_submission.json")), expect=["09_inbound_leads", "00_error_handler"], timeout=120)
    alerts = [m.get("text", "") for m in mock.state()["slack_webhook"]]
    c.ok(any("Nexsale 15" in a or "Nexsale 09" in a for a in alerts), "Slack bot token expired → alert via the independent webhook", alerts)
    return c


def f5_calendly_twice(stack, mock):
    return rm.t07b_calendly(stack, mock)


def f6_rerun(stack, mock):
    c = rm.Check("F6 re-run on the same campaign → no duplicate leads, emails or deals")
    sourcing_chain(stack, mock)
    camp = campaign(mock)
    n_leads, n_emails = len(mock.table("Leads")), len(mock.table("Emails"))
    rm.mock_patch(mock, "Campaigns", camp["id"], {"status": "Sourcing"})
    # no new leads → Module 3 finds nothing New and the chain ends there (Module 4 is not kicked)
    rm.run(stack, lambda: stack.webhook("lead-sourcing", {"campaign_record_id": camp["id"]}), expect=["02_lead_sourcing", "03_enrichment"])
    c.ok(len(mock.table("Leads")) == n_leads, "no duplicate leads", (n_leads, len(mock.table("Leads"))))
    c.ok(len(mock.table("Emails")) == n_emails, "no duplicate emails", (n_emails, len(mock.table("Emails"))))
    rm.run(stack, lambda: stack.webhook("ai-emails-run", {}), expect=["04_ai_emails"])
    c.ok(len(mock.table("Emails")) == n_emails, "AI emails re-run creates no new drafts")
    deal_check = rm.t10_crm(stack, mock)
    c.ok(deal_check.passed, "CRM re-run creates no duplicate deals")
    return c


# ---------------------------------------------------------------- safety tests
def compose(env_file):
    env = dict(os.environ, TEST_ENV_FILE=env_file)
    subprocess.run(["docker", "compose", "-p", "nexsale-test", "-f", "docker-compose.yml", "-f", "docker-compose.test.yml", "up", "-d", "n8n"],
                   cwd=ROOT, env=env, check=True, capture_output=True)
    time.sleep(3)
    wait_for(safe_get_health, timeout=120, what="n8n ready")
    time.sleep(8)  # webhooks re-register after start


def safe_get_health():
    import requests
    try:
        return requests.get("http://localhost:5679/healthz/readiness", timeout=2).ok
    except Exception:  # noqa: BLE001
        return False


def x1_real_company_blocked(stack, mock):
    c = rm.Check("S1 an email addressed to a real company is blocked by the guard and the run stops")
    try:
        compose("tests/test_misconfig.env")
        mock.reset()
        camp = rm.seed_campaign(mock, status="Live")
        leads = rm.seed_leads(mock, camp["id"], n=1, email="info@real-firma.de", domain="real-firma.de", sequence_step=1, next_send_at=rm.iso(rm.now() - timedelta(minutes=1)))
        rm.seed_emails(mock, leads)
        _, ex, st = rm.run(stack, lambda: stack.webhook("sending-run", {}), expect=["06_sending", "00_error_handler"], timeout=120)
        s = mock.state()
        c.ok(not s["gmail"], "nothing reached any inbox", s["gmail"])
        c.ok("error" in st.get("13_send_email", []) and st.get("06_sending") == ["error"], "the run stopped with an error", st)
        alerts = " ".join(m.get("text", "") for m in s["slack_webhook"])
        c.ok("not on allowlist: info@real-firma.de" in alerts, "Slack alert: recipient not on allowlist", alerts[:300])
        c.ok(mock.table("Emails")[0]["status"] == "Approved", "email not marked Sent")
    finally:
        compose("tests/test.env")
        c.ok(subprocess.run(["docker", "exec", "nexsale-test-n8n-1", "printenv", "TEST_PROSPECT_EMAIL"], capture_output=True, text=True).stdout.strip() == PROSPECT,
             "test stack restored to the safe config")
    return c


def x2_demo_mode_test_prefix(stack, mock):
    c = rm.Check("S2 DEMO_MODE: every sent email starts with [TEST] and goes to the test inbox; the company inbox gets nothing")
    r = s2_launch_chain(stack, mock)
    gm = mock.state()["gmail"]
    c.ok(gm and all(g["subject"].startswith("[TEST]") for g in gm), "every email starts with [TEST]", [g["subject"] for g in gm if not g["subject"].startswith("[TEST]")])
    c.ok(all(g["to"] == PROSPECT for g in gm), "every email went to TEST_PROSPECT_EMAIL", {g["to"] for g in gm})
    lead_emails = {l.get("email") for l in mock.table("Leads") if l.get("email")}
    c.ok(not any(g["to"] in lead_emails for g in gm), "no company address received anything")
    c.ok(r.passed, "launch chain passed")
    return c


def x3_one_google_request(stack, mock):
    c = rm.Check("S3 Google requests follow Max leads: 10 (or empty = TEST_LEAD_LIMIT 10) → exactly 1 request, no paging")
    sourcing_chain(stack, mock)
    calls = mock.state()["google_calls"]
    c.ok(len(calls) == 1 and calls[0]["body"]["pageSize"] == 12 and "pageToken" not in calls[0]["body"], "Max leads 10 → 1 request, pageSize 12, no paging", calls)
    mock.reset()
    rm.run(stack, lambda: stack.submit_form(dict(FORM, **{"Max leads": ""})), expect=["01_campaign_setup"] + rm.CHAIN)
    calls = mock.state()["google_calls"]
    c.ok(len(calls) == 1 and "pageToken" not in calls[0]["body"], "empty Max leads → test default 10 → 1 request", calls)
    return c


def x4_no_secrets(stack, mock):
    c = rm.Check("S4 no secret appears in any file in workflows/ (scan also in GitHub Actions)")
    r = subprocess.run(["node", "scripts/secret_scan.js"], cwd=ROOT, capture_output=True, text=True)
    c.ok(r.returncode == 0, "secret scan passed", (r.stdout + r.stderr).strip()[:300])
    r = subprocess.run(["node", "scripts/lint_workflows.js"], cwd=ROOT, capture_output=True, text=True)
    c.ok(r.returncode == 0, "workflow lint passed (guard before every send)", (r.stdout + r.stderr).strip()[:300])
    return c


SUITES = {
    "integration": [s1_sourcing_chain, s2_launch_chain, s3_reply_chain, s4_unsure, s5_inbound, s6_stop_rules],
    "failure": [f1_google, f2_ai_broken, f3_airtable_429, f4_credentials, f5_calendly_twice, f6_rerun],
    "safety": [x1_real_company_blocked, x2_demo_mode_test_prefix, x3_one_google_request, x4_no_secrets],
}


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    suites = list(SUITES) if which == "all" else [which]
    stack, mock = Stack(), Mock()
    results = {}
    for s in suites:
        results[s] = []
        for fn in SUITES[s]:
            t0 = time.time()
            try:
                c = fn(stack, mock)
            except Exception as e:  # noqa: BLE001
                c = rm.Check(fn.__name__ + " (crashed)")
                c.ok(False, "ran without exception", repr(e)[:300])
            results[s].append({"name": c.name, "passed": c.passed, "seconds": round(time.time() - t0, 1), "checks": c.results})
            print(f"[{'PASS' if c.passed else 'FAIL'}] {c.name} ({round(time.time() - t0, 1)}s)", flush=True)
            for r in c.results:
                if not r["pass"]:
                    print(f"     ✗ {r['check']}: {r['detail']}", flush=True)
    out = ROOT / "tests" / "results" / "level3.json"
    prev = json.loads(out.read_text()) if out.exists() else {}
    prev.update({k: {"ran_at": rm.iso(rm.now()), "results": v} for k, v in results.items()})
    out.write_text(json.dumps(prev, indent=2, ensure_ascii=False))
    sys.exit(0 if all(r["passed"] for v in results.values() for r in v) else 1)


if __name__ == "__main__":
    main()
