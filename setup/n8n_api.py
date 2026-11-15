"""Tiny client for the n8n public API (used by deploy and tests). requests + python-dotenv only."""
import json
import os
import pathlib

import requests
from dotenv import load_dotenv

ROOT = pathlib.Path(__file__).resolve().parents[1]
TEST_CREDS = ROOT / "tests" / ".n8n_test_credentials.json"


def settings(test_stack=False):
    load_dotenv(ROOT / ".env")
    if test_stack or os.environ.get("N8N_TEST_STACK") == "1":
        creds = json.loads(TEST_CREDS.read_text()) if TEST_CREDS.exists() else {}
        return os.environ.get("N8N_URL", "http://localhost:5679").rstrip("/"), creds.get("api_key", "")
    return os.environ.get("N8N_URL", "http://localhost:5678").rstrip("/"), os.environ.get("N8N_API_KEY", "")


class N8n:
    def __init__(self, base, api_key, session=None):
        self.base = base.rstrip("/")
        self.s = session or requests.Session()
        self.s.headers.update({"X-N8N-API-KEY": api_key, "Accept": "application/json"})

    def _req(self, method, path, **kw):
        r = self.s.request(method, self.base + "/api/v1" + path, timeout=30, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"n8n API {method} {path} -> {r.status_code}: {r.text[:400]}")
        return r.json() if r.text else {}

    def workflows(self):
        out, cursor = [], None
        while True:
            params = {"limit": 250}
            if cursor:
                params["cursor"] = cursor
            d = self._req("GET", "/workflows", params=params)
            out += d.get("data", [])
            cursor = d.get("nextCursor")
            if not cursor:
                return out

    def create(self, wf):
        return self._req("POST", "/workflows", json=wf)

    def update(self, wid, wf):
        return self._req("PUT", f"/workflows/{wid}", json=wf)

    def activate(self, wid):
        return self._req("POST", f"/workflows/{wid}/activate")

    def deactivate(self, wid):
        return self._req("POST", f"/workflows/{wid}/deactivate")

    def executions(self, workflow_id=None, limit=20, include_data=False, status=None):
        params = {"limit": limit, "includeData": str(include_data).lower()}
        if workflow_id:
            params["workflowId"] = workflow_id
        if status:
            params["status"] = status
        return self._req("GET", "/executions", params=params).get("data", [])

    def execution(self, eid, include_data=True):
        return self._req("GET", f"/executions/{eid}", params={"includeData": str(include_data).lower()})
