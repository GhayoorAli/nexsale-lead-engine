"""Writes pytest totals to tests/results/pytest.json for docs/test_report.md."""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]


def pytest_sessionfinish(session, exitstatus):
    tr = session.config.pluginmanager.get_plugin("terminalreporter")
    stats = tr.stats if tr else {}
    out = ROOT / "tests" / "results"
    out.mkdir(parents=True, exist_ok=True)
    (out / "pytest.json").write_text(json.dumps({"passed": len(stats.get("passed", [])), "failed": len(stats.get("failed", [])) + len(stats.get("error", [])),
                                                 "skipped": len(stats.get("skipped", []))}))
