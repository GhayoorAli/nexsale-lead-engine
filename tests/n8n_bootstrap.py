"""Bootstraps the LOCAL test n8n (docker-compose.test.yml, :5679): owner account + API key.

Test-only values are generated here and stored in tests/.n8n_test_credentials.json (gitignored).
Never run this against a real n8n.
"""
import json
import pathlib
import secrets
import sys

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / ".n8n_test_credentials.json"
BASE = "http://localhost:5679"


def main():
    if OUT.exists():
        creds = json.loads(OUT.read_text())
        r = requests.get(BASE + "/api/v1/workflows", headers={"X-N8N-API-KEY": creds["api_key"]}, timeout=10)
        if r.status_code == 200:
            print("test n8n already bootstrapped")
            return
    creds = json.loads(OUT.read_text()) if OUT.exists() else {
        "email": "owner@nexsale-demo.test", "password": "T" + secrets.token_hex(8) + "a1!"}
    s = requests.Session()
    r = s.post(BASE + "/rest/owner/setup", json={"email": creds["email"], "firstName": "Test", "lastName": "Owner", "password": creds["password"]}, timeout=10)
    if r.status_code >= 400:
        r = s.post(BASE + "/rest/login", json={"emailOrLdapLoginId": creds["email"], "password": creds["password"]}, timeout=10)
        if r.status_code >= 400:
            sys.exit("cannot set up or log in to the test n8n: " + r.text[:200])
    scopes = s.get(BASE + "/rest/api-keys/scopes", timeout=10).json()["data"]
    k = s.post(BASE + "/rest/api-keys", json={"label": "tests-" + secrets.token_hex(3), "scopes": scopes, "expiresAt": None}, timeout=10).json()["data"]
    creds["api_key"] = k.get("rawApiKey") or k.get("apiKey")
    OUT.write_text(json.dumps(creds, indent=2))
    print("bootstrapped test n8n, credentials in", OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
