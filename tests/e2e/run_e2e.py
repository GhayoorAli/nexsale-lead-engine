"""Level 4 – end-to-end: the full demo with only the three clicks a person makes.

  click 1  submit the campaign form ("Reinigungsunternehmen Berlin")
  (auto)   sourcing → enrichment → scoring → AI sequences → quality check → "Campaign ready"
  click 2  open the "Campaign ready" Slack message
  click 3  "Approve and launch"
  (auto)   test emails → "interested" reply from the test inbox → automatic answer with Calendly link
           → Calendly booking → Meeting booked → HubSpot deal → dashboard numbers → weekly report

Counts the clicks (must be 3) and the time from form to "Campaign ready". Runs the flow N times (default 2)
and passes only if every run passes.

Mock mode (default): test stack + mock server; the reply and the booking are the test inbox / Calendly
fixtures, schedule ticks are triggered by webhook. --live: real services (docs/blockers.md); the script
then asks you to click in Slack and reply from the test inbox, and only watches Airtable.
"""
import argparse
import json
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "tests" / "workflows"))
sys.path.insert(0, str(ROOT / "tests" / "integration"))
from lib import Mock, Stack, fixture  # noqa: E402
import run_module as rm  # noqa: E402
import run_integration as ri  # noqa: E402

REPLY = "Klingt interessant, haben Sie nächste Woche Zeit?"


def e2e_mock(stack, mock):
    c = rm.Check("E2E 3-click flow (mock services)")
    clicks = 0
    mock.reset()
    t0 = time.time()
    clicks += 1  # click 1: submit the form
    rm.run(stack, lambda: stack.submit_form(ri.FORM), expect=["01_campaign_setup"] + rm.CHAIN, timeout=240)
    msg = ri.ready_message(mock)
    t_ready = time.time() - t0
    c.ok(msg is not None, "'Campaign ready' message arrived without clicks")
    c.ok(t_ready < 15 * 60, "form → Campaign ready within 15 min", f"{t_ready:.0f}s")
    clicks += 1  # click 2: open the Slack message (the person reads it)
    c.ok("Approve and launch" in json.dumps(msg["blocks"]) and len([b for b in msg["blocks"] if b["type"] == "divider"]) == 3, "message shows samples and the button")
    clicks += 1  # click 3: Approve and launch
    ri.click_launch(stack, mock)
    camp = ri.campaign(mock)
    c.ok(camp["status"] == "Live", "campaign Live", camp["status"])
    gm = [g for g in mock.state()["gmail"] if "Kampagne bereit" not in g["subject"]]
    c.ok(gm and all(g["test_marker"] == "true" and g["to"] == rm.PROSPECT for g in gm), "test emails in the test inbox", len(gm))
    lead = next(l for l in mock.table("Leads") if l["status"] == "Contacted")
    thread = ri.interested_reply(stack, mock, lead, REPLY)
    ans = [g for g in mock.state()["gmail"] if g["threadId"] == thread and "calendly.com" in g["body"]]
    c.ok(len(ans) == 1, "AI answered automatically with the Calendly link")
    rep = next(r for r in mock.table("Replies") if r["lead_record_id"] == lead["id"])
    c.ok(rep["category"] == "Interested" and rep.get("reply_approved"), "reply sorted Interested and answered", (rep["category"], rep.get("ai_confidence")))
    ri.book(stack, mock, lead)
    l = next(x for x in mock.table("Leads") if x["id"] == lead["id"])
    c.ok(l["status"] == "Meeting booked", "lead Meeting booked", l["status"])
    hs = mock.state()["hubspot"]
    c.ok(len(hs["deals"]) == 1 and len(hs["contacts"]) == 1, "HubSpot: one contact and one deal")
    resp, _, _ = rm.run(stack, lambda: stack.webhook("reporting-run", {"weekly": True}), expect=["08_reporting"])
    m = resp.json()
    cm = next(x for x in m["campaigns"] if x["campaign_id"] == camp["id"])
    leads = [x for x in mock.table("Leads") if x["campaign_record_id"] == camp["id"]]
    sent = [e for e in mock.table("Emails") if e["campaign_record_id"] == camp["id"] and e["status"] == "Sent"]
    c.ok(cm["leads_sourced"] == len(leads) == 10 and cm["emails_sent"] == len(sent) and cm["positive_replies"] == 1 and cm["meetings_booked"] == 1,
         "dashboard shows the right numbers", {k: cm[k] for k in ("leads_sourced", "emails_sent", "positive_replies", "meetings_booked")})
    g = m["guarantees"][0]
    c.ok(g["target_positive_replies"] == 20 and g["positive_replies"] >= 1 and g["meetings"] >= 1, "guarantee tracker vs 20 / 4")
    c.ok(any("Wochenbericht" in x["text"] for x in mock.state()["slack"]), "weekly report ran")
    c.ok(clicks == 3, "exactly 3 clicks", clicks)
    return c, {"clicks": clicks, "form_to_ready_seconds": round(t_ready, 1), "total_seconds": round(time.time() - t0, 1)}


def e2e_live():
    """Real services, test mode. Guides the person through the 3 clicks and watches Airtable."""
    import os

    import requests
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    need = ["AIRTABLE_PAT", "AIRTABLE_BASE_ID", "GOOGLE_MAPS_API_KEY", "SLACK_BOT_TOKEN", "TEST_PROSPECT_EMAIL", "TEST_RECIPIENT_ALLOWLIST", "WEBHOOK_URL"]
    missing = [k for k in need if not os.environ.get(k)]
    if missing:
        raise SystemExit("live E2E needs: " + ", ".join(missing) + " (docs/blockers.md)")
    if os.environ.get("DEMO_MODE", "true").lower() != "true":
        raise SystemExit("refusing to run: DEMO_MODE must be true")
    base = f"https://api.airtable.com/v0/{os.environ['AIRTABLE_BASE_ID']}"
    H = {"Authorization": f"Bearer {os.environ['AIRTABLE_PAT']}"}

    def campaign():
        r = requests.get(f"{base}/Campaigns", headers=H, params={"filterByFormula": "{name}='Reinigungsunternehmen Berlin'", "sort[0][field]": "created_at", "sort[0][direction]": "desc", "maxRecords": 1}, timeout=30).json()
        return (r.get("records") or [{}])[0]

    c = rm.Check("E2E 3-click flow (live, test mode)")
    clicks = 0
    input(f"Click 1: open {os.environ['WEBHOOK_URL'].rstrip('/')}/form/campaign-setup, submit 'Reinigungsunternehmen Berlin', then press Enter ")
    clicks += 1
    t0 = time.time()
    while campaign().get("fields", {}).get("status") != "Ready" and time.time() - t0 < 900:
        time.sleep(15)
    c.ok(campaign().get("fields", {}).get("status") == "Ready", "Campaign ready within 15 min", f"{time.time() - t0:.0f}s")
    input("Click 2: open the 'Campaign ready' message in Slack. Press Enter ")
    clicks += 1
    input("Click 3: press 'Approve and launch'. Press Enter ")
    clicks += 1
    t1 = time.time()
    while campaign().get("fields", {}).get("status") != "Live" and time.time() - t1 < 300:
        time.sleep(10)
    c.ok(campaign().get("fields", {}).get("status") == "Live", "campaign Live")
    input(f"From the test inbox, reply to the first test email with: '{REPLY}'. Press Enter ")
    input("Check the automatic answer with the Calendly link arrived, book the slot, press Enter ")
    c.ok(input("Did the answer arrive and is the HubSpot deal there? [y/n] ").strip().lower() == "y", "answer + booking + deal confirmed by the tester")
    c.ok(clicks == 3, "exactly 3 clicks", clicks)
    return c, {"clicks": clicks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--live", action="store_true")
    a = ap.parse_args()
    runs = []
    for i in range(a.runs):
        t = time.time()
        try:
            c, info = e2e_live() if a.live else e2e_mock(Stack(), Mock())
        except Exception as e:  # noqa: BLE001
            c, info = rm.Check("E2E (crashed)"), {}
            c.ok(False, "ran without exception", repr(e)[:300])
        runs.append({"run": i + 1, "passed": c.passed, "info": info, "seconds": round(time.time() - t, 1), "checks": c.results})
        print(f"[{'PASS' if c.passed else 'FAIL'}] run {i + 1}: {info}", flush=True)
        for r in c.results:
            if not r["pass"]:
                print(f"     ✗ {r['check']}: {r['detail']}", flush=True)
    out = ROOT / "tests" / "results" / ("e2e_live.json" if a.live else "e2e.json")
    out.write_text(json.dumps({"ran_at": rm.iso(rm.now()), "mode": "live" if a.live else "mock", "runs": runs,
                               "passed_twice_in_a_row": len(runs) >= 2 and all(r["passed"] for r in runs)}, indent=2, ensure_ascii=False))
    sys.exit(0 if all(r["passed"] for r in runs) else 1)


if __name__ == "__main__":
    main()
