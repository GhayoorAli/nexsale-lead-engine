"""pytest for setup/deploy_workflows.py, setup/seed_test_data.py and setup/capture_places_fixture.py."""
import json
import pathlib
import sys

import pytest
import requests

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "setup"))
import capture_places_fixture as cap  # noqa: E402
import deploy_workflows as dep  # noqa: E402
import seed_test_data as seed  # noqa: E402

MOCK = "http://localhost:8787"


class FakeN8n:
    def __init__(self):
        self.wfs, self.n, self.active = {}, 0, set()

    def workflows(self):
        return [{"id": k, "name": v["name"], "active": k in self.active} for k, v in self.wfs.items()]

    def create(self, wf):
        self.n += 1
        wid = f"real{self.n:04d}"
        self.wfs[wid] = wf
        return {"id": wid}

    def update(self, wid, wf):
        self.wfs[wid] = wf

    def activate(self, wid):
        self.active.add(wid)

    def deactivate(self, wid):
        self.active.discard(wid)


def test_deploy_remaps_ids_and_is_idempotent():
    fake = FakeN8n()
    res = dep.deploy(fake, log=lambda *_: None, skip_oauth=True)
    n_files = len(list((ROOT / "workflows").glob("*.json")))
    assert n_files >= 20 and len(fake.wfs) == n_files  # one n8n workflow per file
    err_id = res["00_error_handler"]["id"]
    for stem, r in res.items():
        body = json.dumps(fake.wfs[r["id"]])
        assert "NxsWf" not in body, stem  # every placeholder ID replaced
        if stem != "00_error_handler":
            assert fake.wfs[r["id"]]["settings"]["errorWorkflow"] == err_id
        assert "REPLACE_WITH_CREDENTIAL_ID" not in body
    assert not res["07a_gmail_inbox"]["active"]  # needs OAuth
    assert res["02_lead_sourcing"]["active"] and not res["13_send_email"]["active"]
    dep.deploy(fake, log=lambda *_: None, skip_oauth=True)
    assert len(fake.wfs) == n_files  # second run updates, never duplicates


def test_api_body_only_allowed_settings():
    stem, wf = dep.load_files()[0]
    body = dep.api_body(wf, True)
    assert set(body) == {"name", "nodes", "connections", "settings"}
    assert set(body["settings"]) <= dep.API_SETTINGS


@pytest.fixture()
def mock():
    try:
        requests.post(MOCK + "/_control/reset", json={"seed_client": False}, timeout=3)
    except requests.ConnectionError:
        pytest.skip("mock server not running")
    return MOCK


def test_seed_creates_client_campaign_and_five_leads(mock):
    base = seed.Base("mock", "appMOCK", mock + "/airtable/v0")
    r = seed.seed(base, "http://localhost:1", replies=False, log=lambda *_: None)
    st = requests.get(mock + "/_control/state", timeout=3).json()["airtable"]
    # two clients: Nexsale itself (default, own outreach) and Real Service (client campaigns)
    assert sorted(c["fields"]["name"] for c in st["Clients"]) == ["Nexsale GmbH", "Real Service GmbH"]
    assert [c["fields"]["name"] for c in st["Clients"] if c["fields"].get("is_default")] == ["Nexsale GmbH"]
    assert len(st["Leads"]) == 5 and len(st["Emails"]) == 5
    assert all(l["fields"]["email"].endswith(".example") for l in st["Leads"])  # fictional addresses only
    r2 = seed.seed(base, "http://localhost:1", replies=False, leads=False, log=lambda *_: None)
    assert r2["client"] == r["client"]  # client is reused, not duplicated
    assert len(requests.get(mock + "/_control/state", timeout=3).json()["airtable"]["Clients"]) == 2  # nothing duplicated
    # a base that already has Nexsale but not Real Service: only Real Service is added
    rs = [c for c in requests.get(mock + "/_control/state", timeout=3).json()["airtable"]["Clients"] if c["fields"]["name"] == "Real Service GmbH"][0]
    requests.delete(mock + "/airtable/v0/appMOCK/Clients", params={"records[]": rs["id"]}, timeout=3)
    seed.seed(base, "http://localhost:1", replies=False, leads=False, log=lambda *_: None)
    assert sorted(c["fields"]["name"] for c in requests.get(mock + "/_control/state", timeout=3).json()["airtable"]["Clients"]) == ["Nexsale GmbH", "Real Service GmbH"]


def test_seed_reply_fixtures_cover_five_categories():
    cats = {json.loads((ROOT / "tests/fixtures/replies" / f"{k}.json").read_text())["expected_category"] for k in seed.REPLY_FIXTURES}
    assert cats == {"Interested", "Later", "Not interested", "Unsubscribe", "Out of office"}


class FakeSession:
    def __init__(self):
        self.calls = []

    def post(self, url, headers, json, timeout):
        self.calls.append((url, headers, json))

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return {"places": [{"id": "x"}], "nextPageToken": "t"}
        return R()


def test_capture_makes_one_request_with_limit_10_and_cheap_mask():
    s = FakeSession()
    data = cap.capture("key", "Reinigungsunternehmen in Berlin", "50", session=s)
    assert len(s.calls) == 1
    url, headers, body = s.calls[0]
    assert body["pageSize"] == 10  # never above the test limit
    assert "reviews" not in headers["X-Goog-FieldMask"] and "photos" not in headers["X-Goog-FieldMask"]
    assert "nextPageToken" not in data


def test_capture_without_key_exits():
    with pytest.raises(SystemExit):
        cap.capture("", "q", 10)


def test_deploy_attaches_existing_gmail_credential():
    fake = FakeN8n()
    res = dep.deploy(fake, log=lambda *_: None, skip_oauth=True, credential_ids={"gmailOAuth2": "credABC"})
    nodes = [n for r in res.values() for n in fake.wfs[r["id"]]["nodes"] if "credentials" in n]
    assert len(nodes) == 3 and all(n["credentials"]["gmailOAuth2"]["id"] == "credABC" for n in nodes)
