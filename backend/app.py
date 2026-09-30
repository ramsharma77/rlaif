"""Harness Optimization Engine — FastAPI backend.

Run:  uvicorn backend.app:app --reload   (from the project root)
"""
import json
import datetime as dt
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import hood, journey, state as st
from .engine import clustering, config, env, harness as H, ingest, jobs, llm, slm, vcs

app = FastAPI(title="Harness Optimization Engine", version="1.0")
FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


@app.on_event("startup")
def _startup():
    st.seed()


@app.exception_handler(Exception)
async def _err(request, exc):
    code = 400 if isinstance(exc, (ValueError, KeyError, StopIteration)) else 500
    return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=code)


async def body(req: Request):
    try:
        return await req.json()
    except Exception:
        return {}


def locked(fn, *a, **k):
    with st.LOCK:
        return fn(*a, **k)


# ------------------------------------------------------------------ meta
@app.get("/api/bootstrap")
def bootstrap():
    return {"agents": st.agents_view()["items"], "waiting": st.approvals()["waiting"], "llm": llm.available(), "git": vcs.status(),
            "settings": config.public_settings(),
            "library": {"lines": H.LINES, "gates": H.GATES, "tools": H.TOOLS, "criteria": H.CRITERIA},
            "decisions": env.DECISION_LABEL, "actions": env.ACTION_LABEL}


@app.post("/api/reset")
def reset():
    return locked(st.reset)


@app.get("/api/config")
def config_view(refresh: bool = False):
    return config.public_settings(refresh=refresh)


@app.post("/api/slm/setup")
def slm_setup():
    # I/O and optional network checks; no state lock needed.
    return slm.setup_local_slm()


@app.get("/api/slm/probe")
def slm_probe(url: str = None):
    return slm.probe_llama_server(base_url=url)


@app.get("/api/slm/status")
def slm_status():
    return slm.llama_status()


@app.post("/api/slm/launch")
def slm_launch():
    return slm.launch_llama_server()


@app.post("/api/slm/stop")
def slm_stop():
    return slm.stop_llama_server()


@app.post("/api/semantic/cluster")
async def semantic_cluster(req: Request):
    b = await body(req)
    texts = b.get("texts") or []
    top_k = b.get("top_k")
    if not isinstance(texts, list):
        raise HTTPException(400, "texts must be an array")
    return clustering.cluster_texts([str(x) for x in texts], top_k=top_k)


@app.post("/api/ingest/run")
async def ingest_run(req: Request):
    b = await body(req)
    paths = b.get("paths")
    if paths is not None and not isinstance(paths, list):
        raise HTTPException(400, "paths must be an array of file paths")
    return ingest.ingest_traces(paths=paths)


@app.get("/api/ingest/runs")
def ingest_runs(limit: int = 20):
    return ingest.list_runs(limit=limit)


@app.get("/api/ingest/overview")
def ingest_overview(range: str = "7d", start: str = None, end: str = None):
    return ingest.overview(range_key=range, start=start, end=end)


# ------------------------------------------------------------------ overview & themes
@app.get("/api/overview/{aid}")
def overview(aid: str, range: str = "7d", start: str = None, end: str = None):
    return locked(st.overview, aid, range, start, end)


@app.post("/api/analysis/{aid}")
def analysis(aid: str):
    return locked(st.analyze, aid, "You")


@app.get("/api/themes/{aid}")
def themes(aid: str):
    return locked(st.themes, aid)


@app.get("/api/theme/{tid}")
def theme(tid: str):
    return locked(st.theme_detail, tid)


# ------------------------------------------------------------------ traces
@app.get("/api/traces/{aid}")
def traces(aid: str, theme: str = None, filter: str = None, limit: int = 60, offset: int = 0):
    return locked(st.trace_list, aid, theme, filter, limit, offset)


@app.get("/api/trace/{tid}")
def trace(tid: str):
    return locked(st.trace_detail, tid)


@app.post("/api/trace/{tid}/label")
async def label(tid: str, req: Request):
    b = await body(req)
    return locked(st.label_trace, tid, b.get("verdict", "Confirmed failure"))


@app.post("/api/trace/{tid}/to-suite")
async def trace_to_suite(tid: str):
    def fn():
        t = st.S["traces"][tid]
        sid = st.S["suite_by_agent"][t["agent"]]
        su = st.S["suites"][sid]
        a = st.TYPE_ASSERTION.get(t["type"], "tool_order")
        test = st._make_test(f"RT-{len(su['tests']) + 101}", t["type"], t["seed"], t["samp"], a, tid)
        su["tests"].append(test)
        st.audit("You", "Trace added to regression suite", sid, f"{tid} → {test['id']}")
        return test
    return locked(fn)


# ------------------------------------------------------------------ harnesses & replay
@app.get("/api/candidates/{aid}")
def candidates(aid: str):
    return locked(st.candidates, aid)


@app.get("/api/harness/{hid}")
def harness(hid: str):
    def fn():
        h = st.get_h(hid)
        base = st.prod(h["agent"])
        return {"harness": H.public(h), "prompt_rows": H.prompt_rows(base, h), "config_rows": H.config_rows(base, h),
                "policy": {d: env.softmax(env.logits(h, d)) for d in env.BASE}, "patch": H.patch(base, h)}
    return locked(fn)


@app.post("/api/replay")
async def replay(req: Request):
    b = await body(req)
    return locked(st.replay, b["base_id"], b["cand_id"], b.get("scen_seed"), b.get("samp_seed"), b.get("trace_id"),
                  b.get("mode", "simulator"), float(b.get("sim_error", 0)))


@app.get("/api/replay-examples")
def replay_examples(base_id: str, cand_id: str, theme: str = None, k: int = 8):
    return locked(st.replay_examples, base_id, cand_id, theme, k)


# ------------------------------------------------------------------ bundles
@app.get("/api/bundles")
def bundles(agent: str = None):
    return locked(st.bundles, agent)


@app.get("/api/bundle/{bid}")
def bundle(bid: str):
    return locked(st.bundle_view, bid)


@app.post("/api/theme/{tid}/bundle")
async def gen_bundle(tid: str, req: Request):
    b = await body(req)
    return locked(st.generate_bundle, tid, "You", True, int(b.get("n", 600)))


@app.get("/api/fix/{bid}/{fid}")
def fix(bid: str, fid: str):
    return locked(st.fix_view, bid, fid)


@app.post("/api/fix/{bid}/{fid}/validate")
async def validate(bid: str, fid: str, req: Request):
    b = await body(req)
    return locked(st.validate_fix, bid, fid, int(b.get("n", 600)), float(b.get("sim_error", 0)), "You")


@app.post("/api/fix/{bid}/{fid}/deliver")
async def deliver(bid: str, fid: str, req: Request):
    b = await body(req)
    return locked(st.delivery, bid, fid, b.get("method", "pr"))


@app.post("/api/fix/{bid}/{fid}/approve-request")
async def fix_to_approval(bid: str, fid: str, req: Request):
    b = await body(req)
    def fn():
        f = next(x for x in st.S["bundles"][bid]["fixes"] if x["id"] == fid)
        h = st._fix_harness(st.S["bundles"][bid], f)
        run_id = b.get("run_id")
        return st.create_approval(st.S["bundles"][bid]["agent"], h["id"], f["title"], bundle_id=bid, fix_ids=[fid], run_id=run_id)
    return locked(fn)


# ------------------------------------------------------------------ experiments
@app.get("/api/experiments")
def experiments(agent: str = None):
    return locked(st.experiments, agent)


@app.get("/api/experiment/{eid}")
def experiment(eid: str):
    return locked(lambda: st.S["experiments"][eid])


@app.post("/api/experiments")
async def new_experiment(req: Request):
    b = await body(req)
    return locked(st.run_experiment, b["agent"], b["candidates"], int(b.get("n", 1200)), int(b.get("seeds", 1)),
                  float(b.get("sim_error", 0)), b.get("name"), b.get("theme_id"), b.get("weights"), b.get("id"))


@app.post("/api/experiment/{eid}/promote")
async def promote(eid: str, req: Request):
    b = await body(req)
    def fn():
        e = st.S["experiments"][eid]
        h = st.get_h(b["candidate"])
        return st.create_approval(e["agent"], h["id"], f"{h['name']} (from {eid})", run_id=b.get("run_id"))
    return locked(fn)


# ------------------------------------------------------------------ optimizer & RL jobs
@app.post("/api/optimizer/run")
async def run_optimizer(req: Request):
    return locked(st.start_optimizer, await body(req))


@app.post("/api/rl/run")
async def run_rl(req: Request):
    return locked(st.start_rl, await body(req))


@app.get("/api/jobs")
def job_list():
    return [j.view(full=False) for j in jobs.JOBS.values()][::-1]


@app.get("/api/jobs/{jid}")
def job(jid: str):
    return jobs.JOBS[jid].view()


@app.post("/api/jobs/{jid}/cancel")
def cancel(jid: str):
    jobs.JOBS[jid].cancelled = True
    return {"ok": True}


# ------------------------------------------------------------------ regression
@app.get("/api/suites")
def suites(agent: str = None):
    return locked(st.suites, agent)


@app.get("/api/suite/{sid}")
def suite(sid: str):
    return locked(st.suite_detail, sid)


@app.post("/api/suite/{sid}/run")
async def suite_run(sid: str, req: Request):
    b = await body(req)
    return locked(st.run_suite, sid, b["harness_id"], True, bool(b.get("include_holdout")))


@app.post("/api/suite/{sid}/gate")
async def suite_gate(sid: str, req: Request):
    b = await body(req)
    return locked(st.set_gate, sid, b.get("min_pass"), b.get("policy_all"))


@app.post("/api/theme/{tid}/convert")
async def convert(tid: str, req: Request):
    b = await body(req)
    return locked(st.convert_theme, tid, b.get("suite"), int(b.get("max_tests", 64)), float(b.get("holdout", 0.2)),
                  bool(b.get("synthetic", True)), bool(b.get("redact", True)), bool(b.get("commit", False)))


# ------------------------------------------------------------------ approvals
@app.get("/api/approvals")
def approvals():
    return locked(st.approvals)


@app.get("/api/approval/{cid}")
def approval(cid: str):
    return locked(lambda: st.approval_view(st.S["approvals"][cid]))


@app.post("/api/approval/{cid}/decide")
async def decide(cid: str, req: Request):
    b = await body(req)
    out = locked(st.decide, cid, b["role"], b["decision"], b.get("comment", ""), b.get("actor"))
    if b.get("role") == "Agent owner" and b.get("decision") == "approve":
        _auto_release_refs_on_owner_approval(cid)
    return out


@app.post("/api/approval/{cid}/link-run")
async def link_run(cid: str, req: Request):
    b = await body(req)
    if b.get("run_id") is None:
        raise HTTPException(400, "run_id is required")
    return locked(st.link_run_approval, int(b["run_id"]), cid, b.get("actor", "You"))


@app.post("/api/approval/{cid}/advance")
def advance(cid: str):
    return locked(st.advance, cid)


# ------------------------------------------------------------------ evaluators, patterns, agents, audit
@app.get("/api/evaluators/{aid}")
def evaluators(aid: str):
    return locked(st.evaluators, aid)


@app.post("/api/evaluators/{aid}/{eid}/recalibrate")
def recalibrate(aid: str, eid: str):
    return locked(st.recalibrate, aid, eid)


@app.get("/api/patterns")
def patterns():
    return locked(st.patterns)


@app.post("/api/pattern/{pid}/test")
async def test_pattern(pid: str, req: Request):
    b = await body(req)
    return locked(st.test_pattern, pid, b["target"])


@app.get("/api/agents")
def agents():
    return locked(st.agents_view)


@app.post("/api/agents")
async def register_agent(req: Request):
    b = await body(req)
    return locked(st.register_agent, b["name"], b.get("type", "First-party"), b.get("level", "1p_norepo"),
                  b.get("owner", ""), b.get("traffic", ""))


@app.get("/api/audit")
def audit(actor: str = None, q: str = None):
    rows = st.S["audit"]
    if actor:
        rows = [r for r in rows if r["actor"] == actor]
    if q:
        rows = [r for r in rows if q.lower() in json.dumps(r).lower()]
    return {"items": rows[::-1], "actors": sorted({r["actor"] for r in st.S["audit"]})}


@app.get("/api/audit/verify")
def audit_verify():
    return st.audit_verify()


@app.get("/api/audit/export")
def audit_export():
    return PlainTextResponse("\n".join(json.dumps(r) for r in st.S["audit"]), media_type="application/x-ndjson",
                             headers={"Content-Disposition": "attachment; filename=hoe-audit.jsonl"})


@app.get("/api/lineage/{obj}")
def lineage(obj: str):
    return st.lineage(obj)


# ------------------------------------------------------------------ under the hood
HOOD = {"detection": hood.detection, "rootcause": hood.root_cause, "statistics": hood.statistics,
        "judges": hood.judges_view, "release": hood.release, "manifest": hood.manifests}


@app.get("/api/hood/{section}/{aid}")
def hood_view(section: str, aid: str):
    if section not in HOOD:
        raise HTTPException(404, f"Unknown section {section}")
    return locked(HOOD[section], aid)


@app.post("/api/hood/manifest/{aid}/verify")
async def hood_verify(aid: str, req: Request):
    b = await body(req)
    return locked(hood.verify_hash, aid, b.get("hash"))


# ------------------------------------------------------------------ trace journey
@app.get("/api/journey/search/{aid}")
def journey_search(aid: str, q: str = ""):
    return locked(journey.search, aid, q)


@app.get("/api/journey/{tid}")
def journey_view(tid: str):
    if tid not in st.S["traces"]:
        raise HTTPException(404, f"No trace {tid}")
    out = locked(journey.journey, tid)
    journey.git_commits(out["git"])  # network I/O: deliberately outside st.LOCK
    return out


# ------------------------------------------------------------------ version control
GIT_EVENTS = ("Pull request", "Version control")


def _vcs_view(force):
    out = vcs.summary(force=force)  # network I/O: deliberately outside st.LOCK
    with st.LOCK:
        out["activity"] = [r for r in st.S["audit"][::-1] if r["event"].startswith(GIT_EVENTS)][:50]
        out["hoe_prs"] = st.S.get("prs", {})
    return out


@app.get("/api/vcs")
def vcs_view():
    return _vcs_view(False)


@app.post("/api/vcs/sync")
def vcs_sync():
    out = _vcs_view(True)
    s = out.get("sync") or {}
    with st.LOCK:
        st.audit("You", "Version control synced", vcs.REPO,
                 out["error"] or f"main @ {out['head']['short']} · " + ("code in sync" if s.get("in_sync") else f"{len(s.get('drift', []))} files differ"))
        out["activity"] = [r for r in st.S["audit"][::-1] if r["event"].startswith(GIT_EVENTS)][:50]
    return out


def _nightly_version_label(run: dict, seq: int) -> tuple[str, str, str]:
    ts = (run.get("finished_at") or run.get("started_at") or "")[:10]
    day = ts.replace("-", "") if ts else "unknown"
    tag = f"planea-{day}.b{run['id']}"
    semver = f"v1.0.{run['id']}-nightly+b{seq}"
    branch = f"release/plane-a/{day}-b{run['id']}"
    return tag, semver, branch


def _parse_ts(ts: str | None) -> dt.datetime | None:
    if not ts:
        return None
    txt = str(ts).strip().replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(txt)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
            try:
                return dt.datetime.strptime(txt, fmt).replace(tzinfo=dt.timezone.utc)
            except ValueError:
                continue
    return None


def _strict_run_approval_map(runs: list[dict], approvals: list[dict], run_links: dict[int, str]) -> dict[int, dict]:
    mapped: dict[int, dict] = {}
    by_id = {a["id"]: a for a in approvals}

    # Explicit links first (run_links and approval.run_id).
    for rid, cid in (run_links or {}).items():
        a = by_id.get(cid)
        if a:
            mapped[int(rid)] = {"approval": a, "source": "explicit-link"}
    for a in approvals:
        rid = a.get("run_id")
        if rid is not None:
            mapped[int(rid)] = {"approval": a, "source": "explicit-run-id"}

    # Strict timestamp fallback only when unique candidate exists in [0, 24h].
    for r in runs:
        rid = int(r["id"])
        if rid in mapped:
            continue
        done = _parse_ts(r.get("finished_at") or r.get("started_at"))
        if not done:
            continue
        cands = []
        for a in approvals:
            created = _parse_ts(a.get("created"))
            if not created:
                continue
            delta = (created - done).total_seconds()
            if 0 <= delta <= 86400:
                cands.append((delta, a))
        cands.sort(key=lambda x: x[0])
        if len(cands) == 1:
            mapped[rid] = {"approval": cands[0][1], "source": "timestamp-strict"}
        elif len(cands) > 1:
            mapped[rid] = {"approval": None, "source": "ambiguous-timestamp"}
    return mapped


def _build_change_evidence(limit_commits: int = 8, limit_runs: int = 20):
    runs = ingest.list_runs(limit=limit_runs).get("items", [])
    commits = vcs.change_evidence(limit_commits=limit_commits, files_per_commit=3)
    owner_name = (config.get_settings().approval_owner_name or "Agent owner").strip()
    with st.LOCK:
        approvals = sorted(st.S.get("approvals", {}).values(), key=lambda a: int(a["id"].split("-")[1]), reverse=True)
        run_links = dict(st.S.get("run_links", {}))

    mapping = _strict_run_approval_map(runs, approvals, run_links)
    items = []
    for i, r in enumerate(runs):
        tag, semver, branch = _nightly_version_label(r, i + 1)
        rid = int(r["id"])
        m = mapping.get(rid)
        ap = m and m.get("approval")
        owner_slot = next((x for x in (ap.get("approvers", []) if ap else []) if x.get("role") == "Agent owner"), None)
        items.append({
            "run_id": rid,
            "status": r.get("status"),
            "started_at": r.get("started_at"),
            "finished_at": r.get("finished_at"),
            "traces": r.get("traces", 0),
            "parse_errors": r.get("parse_errors", 0),
            "line_quarantined": r.get("line_quarantined", 0),
            "trace_soft_oversize": r.get("trace_soft_oversize", 0),
            "version": {"tag": tag, "semver": semver, "branch": branch},
            "mapping": {"source": m.get("source") if m else "unmapped"},
            "promotion": {"plane_b": "Overnight RL Plan-B run", "plane_a": "Request-plane harness components"},
            "approval": None if not ap else {
                "id": ap.get("id"),
                "title": ap.get("title"),
                "status": ap.get("status"),
                "owner_name": owner_name,
                "owner_approved": bool(owner_slot and owner_slot.get("status") == "Approved"),
                "owner_approved_at": owner_slot and owner_slot.get("at"),
                "fix_ids": ap.get("fix_ids", []),
                "bundle_id": ap.get("bundle_id"),
            },
        })
    return {"repo": vcs.status(), "owner_name": owner_name, "batches": items, "commits": commits}


def _auto_release_refs_on_owner_approval(cid: str):
    with st.LOCK:
        ap = st.S.get("approvals", {}).get(cid)
        run_links = dict(st.S.get("run_links", {}))
    if not ap:
        return
    runs = ingest.list_runs(limit=50).get("items", [])
    mapping = _strict_run_approval_map(runs, [ap], run_links)
    run = None
    for r in runs:
        m = mapping.get(int(r["id"]))
        ap = m.get("approval") if m else None
        if ap and ap.get("id") == cid:
            run = r
            break
    if not run:
        return
    seq = next((i + 1 for i, rr in enumerate(runs) if int(rr["id"]) == int(run["id"])), 1)
    tag, _, branch = _nightly_version_label(run, seq)
    refs = vcs.ensure_release_refs(tag=tag, branch=branch)
    with st.LOCK:
        st.audit("Release bot", "Version refs updated", cid,
                 f"run={run['id']} tag={tag} branch={branch} live={refs.get('live')} created_tag={refs.get('tag_created')} created_branch={refs.get('branch_created')}")


@app.get("/api/vcs/change-evidence")
def vcs_change_evidence(limit_commits: int = 8, limit_runs: int = 20):
    return _build_change_evidence(limit_commits=limit_commits, limit_runs=limit_runs)


@app.get("/api/vcs/change-evidence/export")
def vcs_change_evidence_export(limit_commits: int = 8, limit_runs: int = 20):
    d = _build_change_evidence(limit_commits=limit_commits, limit_runs=limit_runs)
    lines = [
        "# Customer Change Evidence Report",
        "",
        f"Repository: {d['repo']['repo']} ({d['repo']['url']})",
        f"Owner approver: {d['owner_name']}",
        "",
        "## Batch to Approval Chain",
    ]
    for b in d["batches"]:
        lines += [
            "",
            f"### Batch run-{b['run_id']} · {b['status']}",
            f"- Window: {b.get('started_at') or 'n/a'} -> {b.get('finished_at') or 'n/a'}",
            f"- Traces: {b.get('traces', 0)} · Parse errors: {b.get('parse_errors', 0)} · Quarantined lines: {b.get('line_quarantined', 0)}",
            f"- Version: {b['version']['semver']} · Tag {b['version']['tag']} · Branch {b['version']['branch']}",
            f"- Mapping source: {b.get('mapping', {}).get('source', 'unmapped')}",
        ]
        ap = b.get("approval")
        if ap:
            lines += [
                f"- Approval: {ap['id']} · {ap['title']} · {ap['status']}",
                f"- Owner approval: {'Yes' if ap.get('owner_approved') else 'No'}" + (f" at {ap.get('owner_approved_at')}" if ap.get("owner_approved_at") else ""),
                f"- Fix IDs: {', '.join(ap.get('fix_ids') or []) or 'n/a'}",
            ]
        else:
            lines.append("- Approval: not mapped")

    lines += ["", "## Relevant Code Changes"]
    for c in d["commits"]:
        lines += ["", f"### {c['short']} {c['message']}", f"- Author: {c.get('author') or 'unknown'}", f"- Date: {c.get('date') or 'n/a'}", f"- URL: {c.get('url')}"]
        for f in c.get("files", []):
            lines += [f"- File: {f.get('path')} ({f.get('status')}, +{f.get('additions', 0)} / -{f.get('deletions', 0)})", f"  - URL: {f.get('url')}"]

    out = "\n".join(lines)
    return PlainTextResponse(out, media_type="text/markdown",
                             headers={"Content-Disposition": "attachment; filename=hoe-change-evidence-report.md"})


# ------------------------------------------------------------------ frontend
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")
