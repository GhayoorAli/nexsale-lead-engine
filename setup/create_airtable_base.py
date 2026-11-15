"""Creates all 9 tables and their fields in an existing Airtable base via the Meta API.

Idempotent: running it twice creates nothing new (existing tables/fields are kept as they are).
Needs AIRTABLE_PAT (scopes: schema.bases:read, schema.bases:write) and AIRTABLE_BASE_ID in .env.
In tests, AIRTABLE_API_URL points at tests/mock_server.

Usage: python setup/create_airtable_base.py
"""
import os
import pathlib
import sys
import time

import requests
from dotenv import load_dotenv

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from schema import LINKS, TABLES  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]


class Airtable:
    def __init__(self, pat, base_id, api_url="https://api.airtable.com/v0", session=None):
        if not pat or not base_id:
            raise SystemExit("AIRTABLE_PAT and AIRTABLE_BASE_ID must be set in .env (see docs/blockers.md)")
        self.meta = f"{api_url.rstrip('/')}/meta/bases/{base_id}"
        self.s = session or requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {pat}", "Content-Type": "application/json"})

    def _req(self, method, path, **kw):
        for attempt in range(3):  # retry on rate limit / server error
            r = self.s.request(method, self.meta + path, timeout=30, **kw)
            if r.status_code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(5 if r.status_code == 429 else 2)
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"Airtable {method} {path}: {r.status_code} {r.text[:300]}")
            return r.json()
        raise RuntimeError("unreachable")

    def tables(self):
        return self._req("GET", "/tables")["tables"]

    def create_table(self, name, fields):
        return self._req("POST", "/tables", json={"name": name, "fields": fields})

    def create_field(self, table_id, field):
        return self._req("POST", f"/tables/{table_id}/fields", json=field)


def ensure_schema(at, log=print):
    created = {"tables": [], "fields": []}
    existing = {t["name"]: t for t in at.tables()}
    for name, fields in TABLES.items():
        if name not in existing:
            existing[name] = at.create_table(name, fields)
            created["tables"].append(name)
            log(f"created table {name} ({len(fields)} fields)")
            continue
        have = {f["name"] for f in existing[name].get("fields", [])}
        for f in fields:
            if f["name"] not in have:
                at.create_field(existing[name]["id"], f)
                created["fields"].append(f"{name}.{f['name']}")
                log(f"added field {name}.{f['name']}")
    existing = {t["name"]: t for t in at.tables()}
    for tname, fname, target in LINKS:
        have = {f["name"] for f in existing[tname].get("fields", [])}
        if fname not in have:
            at.create_field(existing[tname]["id"], {"name": fname, "type": "multipleRecordLinks", "options": {"linkedTableId": existing[target]["id"]}})
            created["fields"].append(f"{tname}.{fname}")
            log(f"added link {tname}.{fname} -> {target}")
    log(f"done: {len(created['tables'])} tables and {len(created['fields'])} fields created")
    return created


def main():
    load_dotenv(ROOT / ".env")
    at = Airtable(os.environ.get("AIRTABLE_PAT"), os.environ.get("AIRTABLE_BASE_ID"), os.environ.get("AIRTABLE_API_URL", "https://api.airtable.com/v0"))
    ensure_schema(at)


if __name__ == "__main__":
    main()
