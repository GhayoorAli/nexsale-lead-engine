"""Imports (or updates) every workflow in workflows/ into n8n through the public API.

- Workflows are matched by name, so running this twice updates instead of duplicating.
- Placeholder IDs in the JSON (errorWorkflow, Execute Workflow targets) are mapped to the
  IDs n8n assigned.
- Workflows with a trigger are activated. 07a_gmail_inbox needs a Gmail OAuth credential and is
  skipped when MOCK_EXTERNAL=true or with --skip-oauth.

Usage:  python setup/deploy_workflows.py [--test-stack] [--no-activate] [--skip-oauth]
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from n8n_api import N8n, settings  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF_DIR = ROOT / "workflows"
TRIGGERS = {"n8n-nodes-base.webhook", "n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.formTrigger", "n8n-nodes-base.gmailTrigger"}
OAUTH_WORKFLOWS = {"07a_gmail_inbox"}
API_SETTINGS = {"saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution", "saveDataSuccessExecution",
                "executionTimeout", "errorWorkflow", "timezone", "executionOrder", "callerPolicy"}


def load_files():
    files = sorted(WF_DIR.glob("*.json"))
    return [(p.stem, json.loads(p.read_text())) for p in files]


def remap(obj, mapping):
    s = json.dumps(obj)
    for placeholder, real in mapping.items():
        s = s.replace(f'"{placeholder}"', f'"{real}"')
    return json.loads(s)


def api_body(wf, strip_credentials, credential_ids=None):
    """credential_ids: {"gmailOAuth2": "<n8n credential id>"} attaches existing n8n credentials (ids are not secrets)."""
    credential_ids = credential_ids or {}
    nodes = []
    for n in wf["nodes"]:
        n = dict(n)
        if "credentials" in n:
            creds = {t: {"id": credential_ids[t], "name": c.get("name", t)} for t, c in n["credentials"].items() if credential_ids.get(t)}
            if creds:
                n["credentials"] = creds
            elif strip_credentials:
                n.pop("credentials")
        nodes.append(n)
    return {"name": wf["name"], "nodes": nodes, "connections": wf["connections"],
            "settings": {k: v for k, v in wf["settings"].items() if k in API_SETTINGS}}


def has_trigger(wf):
    return any(n["type"] in TRIGGERS for n in wf["nodes"])


def deploy(client, activate=True, skip_oauth=False, strip_credentials=True, log=print, credential_ids=None):
    files = load_files()
    existing = {w["name"]: w for w in client.workflows()}
    mapping = {}
    # pass 1: make sure every workflow exists so every ID is known
    for stem, wf in files:
        if wf["name"] in existing:
            mapping[wf["id"]] = existing[wf["name"]]["id"]
        else:
            stub = {"name": wf["name"], "nodes": [], "connections": {}, "settings": {"executionOrder": "v1"}}
            created = client.create(stub)
            mapping[wf["id"]] = created["id"]
            log(f"created {stem} -> {created['id']}")
    # pass 2: full content with remapped references
    result = {}
    for stem, wf in files:
        wid = mapping[wf["id"]]
        body = api_body(remap(wf, mapping), strip_credentials, credential_ids)
        was_active = existing.get(wf["name"], {}).get("active")
        if was_active:
            client.deactivate(wid)
        client.update(wid, body)
        result[stem] = {"id": wid, "name": wf["name"], "active": False}
        if activate and has_trigger(wf) and not (skip_oauth and stem in OAUTH_WORKFLOWS):
            client.activate(wid)
            result[stem]["active"] = True
        log(f"deployed {stem:<20} id={wid} active={result[stem]['active']}")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-stack", action="store_true", help="deploy to the mock test stack on :5679")
    ap.add_argument("--no-activate", action="store_true")
    ap.add_argument("--skip-oauth", action="store_true", help="do not activate workflows that need a Gmail OAuth credential")
    a = ap.parse_args()
    base, key = settings(a.test_stack)
    if not key:
        sys.exit("N8N_API_KEY is empty (see docs/blockers.md)")
    import os
    creds = {} if a.test_stack else {"gmailOAuth2": os.environ.get("GMAIL_CREDENTIAL_ID", "")}
    res = deploy(N8n(base, key), activate=not a.no_activate, skip_oauth=a.skip_oauth or a.test_stack, credential_ids=creds)
    (ROOT / "tests" / "results").mkdir(parents=True, exist_ok=True)
    (ROOT / "tests" / "results" / ("deployed_test.json" if a.test_stack else "deployed.json")).write_text(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
