"""Persistent ingestion and aggregate views for production trace JSONL files."""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .config import get_settings


@dataclass
class IngestStats:
    files: int = 0
    rows: int = 0
    traces: int = 0
    inserted: int = 0
    updated: int = 0
    parse_errors: int = 0
    line_quarantined: int = 0
    trace_soft_oversize: int = 0


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _db_path() -> Path:
    s = get_settings()
    p = Path(getattr(s, "sqlite_path", "var/rlaif.db"))
    return p if p.is_absolute() else _repo_root() / p


def _quarantine_dir() -> Path:
    s = get_settings()
    p = Path(s.ingest_quarantine_dir)
    q = p if p.is_absolute() else _repo_root() / p
    q.mkdir(parents=True, exist_ok=True)
    return q


def _connect() -> sqlite3.Connection:
    db = _db_path()
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ingest_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                status TEXT NOT NULL,
                files INTEGER NOT NULL DEFAULT 0,
                rows INTEGER NOT NULL DEFAULT 0,
                traces INTEGER NOT NULL DEFAULT 0,
                inserted INTEGER NOT NULL DEFAULT 0,
                updated INTEGER NOT NULL DEFAULT 0,
                parse_errors INTEGER NOT NULL DEFAULT 0,
                line_quarantined INTEGER NOT NULL DEFAULT 0,
                trace_soft_oversize INTEGER NOT NULL DEFAULT 0,
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS traces (
                trace_uid TEXT PRIMARY KEY,
                source_file TEXT NOT NULL,
                source_row INTEGER NOT NULL,
                source_trace_index INTEGER NOT NULL,
                ingested_at TEXT NOT NULL,
                created_at TEXT,
                event_date TEXT,
                trace_id TEXT,
                session_id TEXT,
                run_id TEXT,
                status_code INTEGER,
                line_bytes INTEGER NOT NULL,
                trace_bytes INTEGER NOT NULL,
                trace_soft_oversize INTEGER NOT NULL DEFAULT 0,
                journey TEXT,
                success_value REAL,
                p90_turn_latency_sec REAL,
                avg_turn_latency_sec REAL,
                duration_sec REAL,
                policy_ok INTEGER,
                retry_or_escalation INTEGER,
                metric_cost REAL,
                failure_bucket TEXT NOT NULL,
                raw_metrics TEXT
            );

            CREATE INDEX IF NOT EXISTS ix_traces_event_date ON traces(event_date);
            CREATE INDEX IF NOT EXISTS ix_traces_bucket ON traces(failure_bucket);
            CREATE INDEX IF NOT EXISTS ix_traces_journey ON traces(journey);
            """
        )


def _to_date(value: str | None) -> str | None:
    if not value:
        return None
    txt = str(value).strip().replace("Z", "+00:00")
    for fmt in (None, "%Y-%m-%d %H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S%z"):
        try:
            d = dt.datetime.fromisoformat(txt) if fmt is None else dt.datetime.strptime(txt, fmt)
            return d.date().isoformat()
        except Exception:
            continue
    return None


def _as_num(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    txt = str(v).strip()
    if not txt:
        return None
    try:
        return float(txt)
    except ValueError:
        return None


def _parse_policy(metric) -> tuple[int | None, str | None]:
    if metric is None:
        return None, None
    obj = metric
    if isinstance(metric, str):
        try:
            obj = json.loads(metric)
        except json.JSONDecodeError:
            return None, None
    if isinstance(obj, dict):
        result = obj.get("result")
        ok = None
        if isinstance(result, bool):
            ok = 1 if result else 0
        elif result is not None:
            n = _as_num(result)
            ok = None if n is None else (1 if n >= 1 else 0)
        journey = None
        m = obj.get("metrics")
        if isinstance(m, dict):
            j = m.get("journey")
            if j:
                journey = str(j)
            if ok is None:
                hard_fail = _as_num(m.get("safl_count_hard_policy"))
                fail_soft = _as_num(m.get("fail_count_soft_policy"))
                if hard_fail is not None or fail_soft is not None:
                    ok = 0 if (hard_fail or 0) > 0 or (fail_soft or 0) > 0 else 1
        return ok, journey
    return None, None


def _sum_metric_cost(metrics: dict) -> float | None:
    vals = []
    for k, v in metrics.items():
        if "metric_cost" in str(k).lower():
            n = _as_num(v)
            if n is not None:
                vals.append(n)
    if not vals:
        return None
    return float(sum(vals))


def _classify_failure(success: float | None, policy_ok: int | None, escalation: int | None) -> str:
    if policy_ok == 0:
        return "Policy violation"
    if escalation == 1:
        return "Retry/Escalation"
    if success is None:
        return "Unclassified anomaly"
    return "Pass" if success >= 1 else "Task failure"


def _date_window(range_key: str, start: str | None, end: str | None) -> tuple[str | None, str | None]:
    today = dt.date.today()
    presets = {
        "24h": 1,
        "7d": 7,
        "30d": 30,
        "90d": 90,
        "12m": 365,
    }
    if range_key == "custom" and start and end:
        return start, end
    days = presets.get(range_key, 7)
    return (today - dt.timedelta(days=days - 1)).isoformat(), today.isoformat()


def _iter_trace_files(paths: Iterable[str]) -> list[Path]:
    out = []
    for p in paths:
        path = Path(p)
        if path.exists() and path.is_file():
            out.append(path)
    return out


def ingest_traces(paths: list[str] | None = None) -> dict:
    init_db()
    s = get_settings()
    files = _iter_trace_files(paths or s.trace_file_paths)
    now = dt.datetime.now(dt.UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    qdir = _quarantine_dir()
    stats = IngestStats(files=len(files))

    with _connect() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO ingest_runs(started_at,status,files) VALUES (?,?,?)",
            (now, "running", len(files)),
        )
        run_id = int(cur.lastrowid)

        try:
            for file in files:
                with file.open("r", encoding="utf-8", errors="replace") as fh:
                    for line_no, line in enumerate(fh, start=1):
                        if not line.strip():
                            continue
                        stats.rows += 1
                        line_bytes = len(line.encode("utf-8", "ignore"))
                        if line_bytes > s.ingest_line_max_bytes:
                            stats.line_quarantined += 1
                            name = f"run{run_id}_{file.stem}_row{line_no}.jsonl"
                            (qdir / name).write_text(line, encoding="utf-8")
                            continue
                        try:
                            row = json.loads(line)
                        except json.JSONDecodeError:
                            stats.parse_errors += 1
                            continue
                        traces = row.get("traces")
                        if not isinstance(traces, list):
                            continue
                        for i, tr in enumerate(traces):
                            if not isinstance(tr, dict):
                                continue
                            stats.traces += 1
                            trace_json = json.dumps(tr, ensure_ascii=False, separators=(",", ":"))
                            trace_bytes = len(trace_json.encode("utf-8", "ignore"))
                            soft_oversize = 1 if trace_bytes > s.ingest_trace_soft_max_bytes else 0
                            if soft_oversize:
                                stats.trace_soft_oversize += 1

                            metrics = {}
                            spans = tr.get("spans")
                            if isinstance(spans, list) and spans:
                                m = spans[0].get("metrics") if isinstance(spans[0], dict) else None
                                if isinstance(m, dict):
                                    metrics = m

                            policy_ok, journey = _parse_policy(metrics.get("cm_policy_metric"))
                            success = _as_num(metrics.get("agentic_session_success"))
                            p90 = _as_num(metrics.get("cm_session_p90_turn_latency_sec"))
                            avg = _as_num(metrics.get("cm_session_avg_turn_latency_sec"))
                            duration_ns = _as_num(metrics.get("duration_ns"))
                            duration_sec = duration_ns / 1e9 if duration_ns is not None else None
                            escalation = 1 if str(metrics.get("VZ GracefulEscalation_status", "")).lower() == "fail" else 0
                            cost = _sum_metric_cost(metrics)
                            bucket = _classify_failure(success, policy_ok, escalation)

                            trace_uid = str(tr.get("id") or tr.get("trace_id") or f"{file.name}:{line_no}:{i}")
                            created_at = tr.get("created_at")
                            event_date = _to_date(created_at)

                            existing = conn.execute("SELECT trace_uid FROM traces WHERE trace_uid=?", (trace_uid,)).fetchone()
                            params = (
                                str(file),
                                line_no,
                                i,
                                now,
                                created_at,
                                event_date,
                                tr.get("trace_id"),
                                tr.get("session_id"),
                                tr.get("run_id"),
                                tr.get("status_code"),
                                line_bytes,
                                trace_bytes,
                                soft_oversize,
                                journey,
                                success,
                                p90,
                                avg,
                                duration_sec,
                                policy_ok,
                                escalation,
                                cost,
                                bucket,
                                json.dumps(metrics, ensure_ascii=False),
                                trace_uid,
                            )
                            if existing:
                                conn.execute(
                                    """
                                    UPDATE traces
                                       SET source_file=?, source_row=?, source_trace_index=?, ingested_at=?, created_at=?,
                                           event_date=?, trace_id=?, session_id=?, run_id=?, status_code=?,
                                           line_bytes=?, trace_bytes=?, trace_soft_oversize=?, journey=?,
                                           success_value=?, p90_turn_latency_sec=?, avg_turn_latency_sec=?, duration_sec=?,
                                           policy_ok=?, retry_or_escalation=?, metric_cost=?, failure_bucket=?, raw_metrics=?
                                     WHERE trace_uid=?
                                    """,
                                    params,
                                )
                                stats.updated += 1
                            else:
                                conn.execute(
                                    """
                                    INSERT INTO traces(
                                        source_file, source_row, source_trace_index, ingested_at, created_at, event_date,
                                        trace_id, session_id, run_id, status_code, line_bytes, trace_bytes, trace_soft_oversize,
                                        journey, success_value, p90_turn_latency_sec, avg_turn_latency_sec, duration_sec,
                                        policy_ok, retry_or_escalation, metric_cost, failure_bucket, raw_metrics, trace_uid
                                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                                    """,
                                    params,
                                )
                                stats.inserted += 1

            conn.execute(
                """
                UPDATE ingest_runs
                   SET finished_at=?, status=?, rows=?, traces=?, inserted=?, updated=?,
                       parse_errors=?, line_quarantined=?, trace_soft_oversize=?
                 WHERE id=?
                """,
                (
                    dt.datetime.now(dt.UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
                    "ok",
                    stats.rows,
                    stats.traces,
                    stats.inserted,
                    stats.updated,
                    stats.parse_errors,
                    stats.line_quarantined,
                    stats.trace_soft_oversize,
                    run_id,
                ),
            )
            conn.commit()
        except Exception as ex:
            conn.execute(
                "UPDATE ingest_runs SET finished_at=?, status=?, notes=? WHERE id=?",
                (dt.datetime.now(dt.UTC).isoformat(timespec="seconds").replace("+00:00", "Z"), "failed", str(ex), run_id),
            )
            conn.commit()
            raise

    return {
        "run_id": run_id,
        "files": stats.files,
        "rows": stats.rows,
        "traces": stats.traces,
        "inserted": stats.inserted,
        "updated": stats.updated,
        "parse_errors": stats.parse_errors,
        "line_quarantined": stats.line_quarantined,
        "trace_soft_oversize": stats.trace_soft_oversize,
    }


def list_runs(limit: int = 20) -> dict:
    init_db()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM ingest_runs ORDER BY id DESC LIMIT ?",
            (max(1, min(limit, 200)),),
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


def overview(range_key: str = "7d", start: str | None = None, end: str | None = None) -> dict:
    init_db()
    d0, d1 = _date_window(range_key, start, end)
    where = ""
    args: list = []
    if d0 and d1:
        where = "WHERE event_date BETWEEN ? AND ?"
        args = [d0, d1]

    with _connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS n FROM traces {where}", args).fetchone()["n"]
        fail = conn.execute(
            f"SELECT COUNT(*) AS n FROM traces {where} AND failure_bucket <> 'Pass'" if where else "SELECT COUNT(*) AS n FROM traces WHERE failure_bucket <> 'Pass'",
            args,
        ).fetchone()["n"]

        rows = conn.execute(
            f"SELECT failure_bucket, COUNT(*) AS n FROM traces {where} GROUP BY failure_bucket ORDER BY n DESC",
            args,
        ).fetchall()
        buckets = [{"bucket": r["failure_bucket"], "count": r["n"], "rate": (r["n"] / total if total else 0.0)} for r in rows]

        pr = conn.execute(
            f"SELECT AVG(retry_or_escalation) AS v FROM traces {where}",
            args,
        ).fetchone()["v"]
        pv = conn.execute(
            f"SELECT AVG(CASE WHEN policy_ok=0 THEN 1.0 ELSE 0.0 END) AS v FROM traces {where}",
            args,
        ).fetchone()["v"]

        # Trace-level p95 latency from p90 metric when available, else duration_sec.
        lrows = conn.execute(
            f"SELECT COALESCE(p90_turn_latency_sec, duration_sec) AS lat FROM traces {where} AND COALESCE(p90_turn_latency_sec, duration_sec) IS NOT NULL"
            if where
            else "SELECT COALESCE(p90_turn_latency_sec, duration_sec) AS lat FROM traces WHERE COALESCE(p90_turn_latency_sec, duration_sec) IS NOT NULL",
            args,
        ).fetchall()
        lats = sorted([float(r["lat"]) for r in lrows])
        p95 = None
        if lats:
            idx = max(0, min(len(lats) - 1, int((0.95 * len(lats)) + 0.9999) - 1))
            p95 = lats[idx]

        cost = conn.execute(
            f"SELECT AVG(metric_cost) AS v FROM traces {where} AND metric_cost IS NOT NULL"
            if where
            else "SELECT AVG(metric_cost) AS v FROM traces WHERE metric_cost IS NOT NULL",
            args,
        ).fetchone()["v"]

        daily = conn.execute(
            f"SELECT event_date, COUNT(*) AS n, AVG(CASE WHEN failure_bucket <> 'Pass' THEN 1.0 ELSE 0.0 END) AS failure_rate "
            f"FROM traces {where} GROUP BY event_date ORDER BY event_date",
            args,
        ).fetchall()

    return {
        "window": {"range": range_key, "start": d0, "end": d1},
        "summary": {
            "total_traces": total,
            "failure_rate": (fail / total) if total else 0.0,
            "retry_escalation_rate": float(pr) if pr is not None else None,
            "policy_violation_incidence": float(pv) if pv is not None else None,
            "trace_p95_latency_sec": p95,
            "cost_per_eval_run": float(cost) if cost is not None else None,
        },
        "failure_buckets": buckets,
        "daily": [dict(r) for r in daily],
    }
