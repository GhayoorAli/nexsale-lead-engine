"""Shared helpers for level 2–4 tests: mock server control, n8n executions, waiting."""
import json
import pathlib
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "setup"))
from n8n_api import N8n, settings  # noqa: E402

MOCK = "http://localhost:8787"
N8N_PUBLIC = "http://localhost:5679"
FIX = ROOT / "tests" / "fixtures"


class Mock:
    def __init__(self, base=MOCK):
        self.base = base

    def reset(self, seed_client=True):
        requests.post(self.base + "/_control/reset", json={"seed_client": seed_client}, timeout=5).raise_for_status()

    def state(self):
        return requests.get(self.base + "/_control/state", timeout=5).json()

    def fail(self, service, status=500, count=1):
        requests.post(self.base + "/_control/fail", json={"service": service, "status": status, "count": count}, timeout=5).raise_for_status()

    def ai_mode(self, mode, prompt_id="*", count=1):
        requests.post(self.base + "/_control/ai_mode", json={"mode": mode, "prompt_id": prompt_id, "count": count}, timeout=5).raise_for_status()

    def seed(self, table, records):
        return requests.post(self.base + "/_control/seed", json={"table": table, "records": records}, timeout=5).json()["records"]

    def table(self, name):
        return [dict(r["fields"], id=r["id"]) for r in self.state()["airtable"].get(name, [])]

    def up(self):
        try:
            requests.get(self.base + "/_control/state", timeout=2)
            return True
        except requests.ConnectionError:
            return False


class Stack:
    """The local test n8n (:5679) with workflows deployed by setup/deploy_workflows.py --test-stack."""

    def __init__(self):
        base, key = settings(test_stack=True)
        self.api = N8n(base, key)
        self.base = base
        dep = ROOT / "tests" / "results" / "deployed_test.json"
        self.ids = json.loads(dep.read_text()) if dep.exists() else {}

    def wid(self, stem):
        return self.ids[stem]["id"]

    def last_execution_id(self):
        ex = self.api.executions(limit=1)
        return int(ex[0]["id"]) if ex else 0

    def executions_since(self, since_id, stem=None):
        wid = self.wid(stem) if stem else None
        ex = self.api.executions(workflow_id=wid, limit=100)  # form runs (status waiting) are read by id in run_module.run
        seen, out = set(), []
        for e in ex:
            if int(e["id"]) > since_id and e["id"] not in seen and e.get("mode") != "trigger":  # disabled schedule ticks are noise
                seen.add(e["id"])
                out.append(e)
        return out

    def wait_idle(self, since_id, expect=None, timeout=120, settle=3.0, mock=None):
        """Wait until every expected workflow has a finished execution after since_id and nothing new
        has happened (no new executions, no new mock requests) for `settle` seconds.
        The public API does not list running executions, hence the quiet-period check."""
        expect = list(expect or [])
        end = time.time() + timeout
        last_sig, quiet_since = None, time.time()
        while time.time() < end:
            ex = self.executions_since(since_id)
            seen = self.status_by_workflow(ex)
            reqs = len(mock.state()["requests"]) if mock else 0
            sig = (len(ex), reqs)
            if sig != last_sig:
                last_sig, quiet_since = sig, time.time()
            if all(stem in seen for stem in expect) and time.time() - quiet_since >= settle:
                return ex
            time.sleep(0.5)
        raise TimeoutError(f"timed out after {timeout}s waiting for {expect}; seen {self.status_by_workflow(self.executions_since(since_id))}")

    def status_by_workflow(self, executions):
        names = {v["id"]: k for k, v in self.ids.items()}
        out = {}
        for e in executions:
            out.setdefault(names.get(e["workflowId"], e["workflowId"]), []).append(e["status"])
        return out

    def error_of(self, execution_id):
        d = self.api.execution(execution_id)
        err = d.get("data", {}).get("resultData", {}).get("error") or {}
        return err.get("message"), (err.get("node") or {}).get("name")

    def webhook(self, path, payload=None, raw=None, headers=None, method="POST", timeout=60):
        url = f"{self.base}/webhook/{path}"
        if raw is not None:
            return requests.request(method, url, data=raw, headers=headers or {}, timeout=timeout)
        return requests.request(method, url, json=payload or {}, headers=headers or {}, timeout=timeout)

    def submit_form(self, fields, timeout=30):
        """Click 1: submit the n8n campaign form like a browser (multipart field-0..field-6)."""
        order = ["Campaign name", "Client", "Industry (search term)", "City", "Company size range", "Target role", "Max leads"]
        files = {f"field-{i}": (None, str(fields.get(k, ""))) for i, k in enumerate(order)}
        return requests.post(f"{self.base}/form/campaign-setup", files=files, timeout=timeout)


def fixture(path):
    return json.loads((FIX / path).read_text(encoding="utf-8"))


def wait_for(fn, timeout=60, interval=0.7, what="condition"):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {what} (last={last!r})")
