import json
import os
from pathlib import Path

from backend.engine import config, ingest


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def test_ingest_and_overview(tmp_path):
    db = tmp_path / "test.db"
    qdir = tmp_path / "quarantine"
    src = tmp_path / "traces.jsonl"

    row = {
        "traces": [
            {
                "id": "t-1",
                "trace_id": "trace-1",
                "session_id": "s-1",
                "run_id": "r-1",
                "created_at": "2026-09-24 10:20:50+00:00",
                "status_code": 0,
                "spans": [
                    {
                        "metrics": {
                            "agentic_session_success": 1,
                            "cm_session_p90_turn_latency_sec": 0.9,
                            "cm_policy_metric": {"result": True, "metrics": {"journey": "bill-explanation"}},
                            "x_metric_cost": 0.05,
                        }
                    }
                ],
            },
            {
                "id": "t-2",
                "trace_id": "trace-2",
                "session_id": "s-2",
                "run_id": "r-2",
                "created_at": "2026-09-24 10:20:52+00:00",
                "status_code": 0,
                "spans": [
                    {
                        "metrics": {
                            "agentic_session_success": 0,
                            "cm_session_p90_turn_latency_sec": 1.2,
                            "cm_policy_metric": {"result": False, "metrics": {"journey": "due-date-change"}},
                            "x_metric_cost": 0.07,
                        }
                    }
                ],
            },
        ]
    }
    _write_jsonl(src, [row])

    os.environ["HOE_SQLITE_PATH"] = str(db)
    os.environ["HOE_INGEST_QUARANTINE_DIR"] = str(qdir)
    os.environ["HOE_TRACE_FILE_PATHS"] = str(src)
    config.get_settings(refresh=True)

    out = ingest.ingest_traces()
    assert out["traces"] == 2
    assert out["line_quarantined"] == 0

    ov = ingest.overview(range_key="12m")
    assert ov["summary"]["total_traces"] >= 2
    assert ov["summary"]["failure_rate"] >= 0
    assert ov["summary"]["trace_p95_latency_sec"] is not None

    runs = ingest.list_runs(limit=5)
    assert runs["items"]
