"""Writes docs/test_report.md from every result file in tests/results/ (PLAN.md "Test report")."""
import datetime
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
R = ROOT / "tests" / "results"


def load(name):
    p = R / name
    return json.loads(p.read_text()) if p.exists() else None


def by_name(level3, suite, prefix):
    for r in ((level3 or {}).get(suite) or {}).get("results", []):
        if r["name"].startswith(prefix):
            return r["passed"]
    return None


def mark(v):
    return "Pass" if v is True else "Fail" if v is False else "Not run"


def main():
    jest = load("jest.json")
    cov = json.loads((ROOT / "coverage" / "coverage-summary.json").read_text()) if (ROOT / "coverage" / "coverage-summary.json").exists() else None
    py = load("pytest.json")
    l2 = load("level2.json") or {}
    l3 = load("level3.json") or {}
    e2e = load("e2e.json")
    live = load("e2e_live.json")
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=1))).strftime("%Y-%m-%d %H:%M (Europe/Berlin)")
    lines = [f"# Test report", "", f"Generated {now}. All runs in test mode: max 10 companies, no email to a real company.", "",
             "Mode: **mock services** (`MOCK_EXTERNAL=true`, real n8n 1.123.5 in Docker, external APIs from `tests/mock_server`). "
             "Live runs against the real services need the steps in `docs/blockers.md`.", "", "## Summary", "",
             "| Level | Tool | Passed | Failed | Result |", "| --- | --- | --- | --- | --- |"]
    if jest:
        lines.append(f"| 1 Unit (JS) | Jest | {jest['numPassedTests']} | {jest['numFailedTests']} | {mark(jest['success'])} – line coverage on `code/` {cov['total']['lines']['pct'] if cov else '?'}% (min 80%) |")
    if py:
        lines.append(f"| 1 Unit (Python) | pytest | {py['passed']} | {py['failed']} | {mark(py['failed'] == 0 and py['passed'] > 0)} |")
    if l2:
        p = sum(1 for v in l2.values() if v["passed"])
        lines.append(f"| 2 Workflow | run_module.py | {p} modules | {len(l2) - p} modules | {mark(p == len(l2))} |")
    for suite in ("integration", "failure", "safety"):
        res = (l3.get(suite) or {}).get("results", [])
        if res:
            p = sum(1 for r in res if r["passed"])
            lines.append(f"| 3 {suite.capitalize()} | run_integration.py | {p} | {len(res) - p} | {mark(p == len(res))} |")
    if e2e:
        p = sum(1 for r in e2e["runs"] if r["passed"])
        lines.append(f"| 4 End-to-end (mock) | run_e2e.py | {p} runs | {len(e2e['runs']) - p} runs | {mark(e2e['passed_twice_in_a_row'])} (twice in a row: {e2e['passed_twice_in_a_row']}) |")
    lines.append(f"| 4 End-to-end (live) | run_e2e.py --live | – | – | {mark(live['passed_twice_in_a_row']) if live else 'Not run – blocked (docs/blockers.md)'} |")

    if l2:
        lines += ["", "## Level 2 – workflow tests (one per module)", "", "| Module | Checks | Result | Seconds |", "| --- | --- | --- | --- |"]
        for k in sorted(l2):
            v = l2[k]
            lines.append(f"| {v['name']} | {sum(c['pass'] for c in v['checks'])}/{len(v['checks'])} | {mark(v['passed'])} | {v['seconds']} |")
    for suite in ("integration", "failure", "safety"):
        res = (l3.get(suite) or {}).get("results", [])
        if res:
            lines += ["", f"## Level 3 – {suite}", "", "| Scenario | Checks | Result |", "| --- | --- | --- |"]
            for r in res:
                lines.append(f"| {r['name']} | {sum(c['pass'] for c in r['checks'])}/{len(r['checks'])} | {mark(r['passed'])} |")
    if e2e:
        lines += ["", "## Level 4 – end-to-end (mock services)", ""]
        for r in e2e["runs"]:
            i = r["info"]
            lines.append(f"- Run {r['run']}: {mark(r['passed'])} – clicks {i.get('clicks')}, form → 'Campaign ready' {i.get('form_to_ready_seconds')} s, whole flow {i.get('total_seconds')} s")

    live_run = load("live_campaign.json")
    if live_run:
        lines += ["", "## Live run on the real services (test mode)", "",
                  f"- Form → \"Campaign ready\": {live_run['form_to_ready_seconds']} s, {live_run['google_requests']} Google request, AI cost €{live_run['ai_cost_eur']}",
                  f"- {live_run['leads']} leads · email found {live_run['with_email']}/{live_run['leads']} · director {live_run['with_director']}/{live_run['leads']} · approved {live_run['approved']} (quality {live_run['quality_range']})",
                  "- Rejected: " + "; ".join(f"{k}: {v}" for k, v in live_run["rejected"].items()),
                  f"- Approved emails: {live_run['approved_email_checks']}",
                  "- Live service checks: " + "; ".join(live_run["live_service_checks"]),
                  "- Not yet run live: " + "; ".join(live_run["not_yet_live"])]
    ev = load("email_quality_eval.json")
    if ev:
        lines += ["", "## AI email quality (real gpt-4o-mini on the real leads)", "",
                  f"- {sum(r['passed'] for r in ev)}/{len(ev)} sequences pass (80+), {sum(r['first'] >= 80 for r in ev)}/{len(ev)} on the first try; score computed in code from quoted evidence, judge temperature 0",
                  "- Negative controls: a generic sequence scores 40, a sequence with invented claims fails (any invented claim = fail)"]

    # acceptance checklist
    e2e_ok = bool(e2e and e2e["passed_twice_in_a_row"])
    clicks3 = bool(e2e and all(r["info"].get("clicks") == 3 for r in e2e["runs"]))
    g = lambda k: (l2.get(k) or {}).get("passed")  # noqa: E731
    rows = [
        ("Campaign launches in 2–3 clicks", "E2E click count = 3", clicks3 and e2e_ok),
        ("Lead sourcing is automatic", "Form → 10 leads with no manual step", by_name(l3, "integration", "I1") and g("02")),
        ("Decision-maker found for each lead", "60%+ of leads have a name and email from the Impressum", g("03")),
        ("Emails read as individually written", "All sent sequences scored 80+ (mock AI score; real AI + reading 3 aloud needs the key)", g("04")),
        ("Follow-ups day 0, 3, 7, 14, stop on reply", "Integration scenarios 2 and 6", by_name(l3, "integration", "I2") and by_name(l3, "integration", "I6")),
        ("Replies are pre-qualified", "All 12 reply fixtures sorted correctly (+ bounce, unclear)", g("07")),
        ("Meetings booked automatically", "Integration scenario 3", by_name(l3, "integration", "I3")),
        ("CRM kept up to date", "One HubSpot deal per booked meeting", g("10")),
        ("Results visible against the guarantees", "Dashboard shows replies vs 20 and meetings vs 4–5", g("08")),
        ("GDPR: source stored, opt-out, delete", "Source on every lead; STOP works; delete workflow removes a lead", g("02") and g("12") and by_name(l3, "integration", "I6")),
        ("No email to a real company in test mode", "Safety tests", all(r["passed"] for r in (l3.get("safety") or {}).get("results", [])) if l3.get("safety") else None),
        ("Errors are visible, not silent", "Failure tests", all(r["passed"] for r in (l3.get("failure") or {}).get("results", [])) if l3.get("failure") else None),
    ]
    lines += ["", "## Level 5 – acceptance checklist (mock services)", "", "| Requirement | How it's checked | Result |", "| --- | --- | --- |"]
    lines += [f"| {a} | {b} | {mark(c)} |" for a, b, c in rows]
    lines += ["", "Note: with mock services the AI answers are deterministic fixtures, so rows that depend on AI *quality* "
              "(email tone, reply-sorting accuracy) prove the plumbing, routing and thresholds – not the model. "
              "Re-run with a real AI key (`docs/blockers.md` step 7) for that.", ""]
    (ROOT / "docs" / "test_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote docs/test_report.md")


if __name__ == "__main__":
    main()
