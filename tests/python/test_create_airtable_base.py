"""create_airtable_base.py against the mock Airtable Meta API: creates 9 tables, second run creates nothing."""
import pathlib
import sys

import pytest
import requests

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "setup"))
import create_airtable_base as cab  # noqa: E402
from schema import LINKS, TABLES  # noqa: E402

MOCK = "http://localhost:8787"


@pytest.fixture()
def at():
    try:
        requests.post(MOCK + "/_control/reset", json={}, timeout=3)
    except requests.ConnectionError:
        pytest.skip("mock server not running (python tests/mock_server/server.py)")
    return cab.Airtable("mock-pat", "appTEST", MOCK + "/airtable/v0")


def test_creates_all_nine_tables(at):
    created = cab.ensure_schema(at, log=lambda *_: None)
    assert sorted(created["tables"]) == sorted(TABLES.keys())
    assert len(TABLES) == 9
    names = {t["name"] for t in at.tables()}
    assert names == set(TABLES)


def test_second_run_creates_no_duplicates(at):
    cab.ensure_schema(at, log=lambda *_: None)
    again = cab.ensure_schema(at, log=lambda *_: None)
    assert again == {"tables": [], "fields": []}
    assert len(at.tables()) == 9


def test_adds_missing_fields_and_links(at):
    at.create_table("Blocklist", [{"name": "value", "type": "singleLineText"}])
    created = cab.ensure_schema(at, log=lambda *_: None)
    assert "Blocklist" not in created["tables"]
    assert "Blocklist.reason" in created["fields"]
    assert len([f for f in created["fields"] if "." in f and f.split(".")[1] in {l[1] for l in LINKS}]) == len(LINKS)


def test_every_table_has_text_primary_field():
    for name, fields in TABLES.items():
        assert fields[0]["type"] == "singleLineText", name


def test_missing_credentials_exit():
    with pytest.raises(SystemExit):
        cab.Airtable("", "")


def test_retries_on_429(at, monkeypatch):
    requests.post(MOCK + "/_control/fail", json={"service": "airtable", "status": 429, "count": 1}, timeout=3)
    monkeypatch.setattr(cab.time, "sleep", lambda s: None)
    assert at.tables() == []


def test_error_is_raised(at, monkeypatch):
    requests.post(MOCK + "/_control/fail", json={"service": "airtable", "status": 403, "count": 1}, timeout=3)
    with pytest.raises(RuntimeError):
        at.tables()
