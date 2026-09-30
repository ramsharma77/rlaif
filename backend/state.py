"""Application state and service layer.

Everything lives in memory and is rebuilt deterministically on start
(POST /api/reset re-seeds). Swap `S` for a database in production.
"""
import copy
import datetime as dt
import hashlib
import json
import random
import threading
import zlib
from collections import Counter

from .engine import analysis as A, env, evaluate as E, harness as H, jobs, judges, optimizer, rl, vcs
from .engine.config import get_settings

LOCK = threading.RLock()
START = dt.date(2026, 9, 12)
S = {}

AGENTS = [
    {"id": "billing", "name": "Customer Care Billing Agent", "type": "First-party", "integration": "Repo + CI connected",
     "level": "1p_repo", "owner": "CX Digital", "traffic": "482K / wk", "kind": "billing",
     "repo": f"github.com/{vcs.REPO}", "repo_url": vcs.repo_url(), "repo_path": vcs.agent_path("billing"), "per_day": 150},
    {"id": "store", "name": "Store Appointment Agent", "type": "First-party", "integration": "Traces only, no repo",
     "level": "1p_norepo", "owner": "Retail Ops", "traffic": "96K / wk", "kind": None},
    {"id": "outage", "name": "Network Outage Voice Agent", "type": "Third-party", "integration": "Runtime config API",
     "level": "3p_config", "owner": "Network Care", "traffic": "127K / wk", "kind": "outage",
     "vendor": "[VENDOR NAME]", "per_day": 70},
    {"id": "tradein", "name": "Device Trade-in Chat Agent", "type": "Third-party", "integration": "Observe only",
     "level": "3p_observe", "owner": "Consumer Sales", "traffic": "58K / wk", "kind": None},
]
LEVELS = [("1p_repo", "First-party, repo"), ("1p_norepo", "First-party, no repo"),
          ("3p_config", "Third-party, config API"), ("3p_observe", "Third-party, observe only")]
CAPABILITIES = [
    ("Observe traces and cluster failures", ["Yes", "Yes", "Yes", "Yes"]),
    ("Recommend fixes with evidence", ["Yes", "Yes", "Yes", "Yes"]),
    ("Offline replay on held-out set", ["Yes", "Yes", "Partial", "Partial"]),
    ("Apply prompt / config change", ["Yes", "Partial", "Yes", "No"]),
    ("Open pull request on code", ["Yes", "No", "No", "No"]),
    ("Gateway overlay (Verizon proxy)", ["Yes", "Yes", "Yes", "Yes"]),
    ("RL fine-tune of model weights", ["Partial", "No", "No", "No"]),
    ("Regression tests gate releases", ["Yes", "Yes", "Partial", "Partial"]),
]
POLICY = [
    {"type": "Prompt, tool description (low risk)", "approvers": ["Agent owner"], "rollout": "Shadow, then canary"},
    {"type": "Control flow, context and memory", "approvers": ["Agent owner", "AI Governance"], "rollout": "Shadow, then canary"},
    {"type": "Guardrail-adjacent or data-exposure change", "approvers": ["Agent owner", "AI Governance", "Security"], "rollout": "Canary 1% first"},
    {"type": "Evaluator or judge change", "approvers": ["Agent owner", "AI Governance"], "rollout": "Re-baseline suites"},
    {"type": "Model weights (RL / fine-tune)", "approvers": ["Model risk", "AI Governance", "Security"], "rollout": "Separate release path"},
    {"type": "Third-party agent change", "approvers": ["Agent owner", "Vendor attestation"], "rollout": "Post-deploy verification"},
]
STAGES = ["Shadow traffic, 48 hours", "Canary 5%", "Canary 25%", "Canary 50%", "Full rollout"]
ASSERTIONS = {
    "tool_order": ("Must ask for confirmation before close_ticket", "Tool-call order",
                   lambda o: not (o["closed_after_quote_no_confirm"] and not o["silent_close"])),
    "followup": ("Must address the follow-up question", "LLM-judge rubric", lambda o: not o["open_question"]),
    "dispute": ("Must not close with the disputed charge unaddressed", "LLM-judge rubric", lambda o: not o["dispute_unaddressed"]),
    "policy": ("Must refuse and offer escalation", "Policy check", lambda o: not o["violation"]),
    "silence": ("Close only after two prompts", "Tool-call order", lambda o: not o["silent_close"]),
    "eta": ("Must check outage status before stating an ETA", "Tool-call order", lambda o: not o["eta_unverified"]),
}
TYPE_ASSERTION = {"duplicate_charge": "followup", "partial_refund": "followup", "plan_question": "tool_order",
                  "wrong_charge": "dispute", "credit_over_limit": "policy", "silent_after_quote": "silence",
                  "outage_eta": "eta", "outage_credit": "followup"}


# ----------------------------------------------------------------- utilities
def day_label(d):
    t = START + dt.timedelta(days=int(d))
    return f"{t:%b} {t.day}"


def now_iso():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def next_id(kind, fmt):
    S["counters"][kind] = S["counters"].get(kind, 0) + 1
    return fmt.format(S["counters"][kind])


def agent(aid):
    return next(a for a in AGENTS + S.get("extra_agents", []) if a["id"] == aid)


def prod(aid):
    return S["harnesses"][S["production"][aid]]


def get_h(hid):
    return S["harnesses"][hid]


def register(h, released_day=None):
    if released_day is not None:
        h["released_day"] = released_day
    S["harnesses"][h["id"]] = h
    return h


def evaluator(aid, eid):
    return next(e for e in S["evaluators"][aid] if e["id"] == eid)


def judge_cfg(aid):
    res = evaluator(aid, "resolution")
    emp = evaluator(aid, "empathy")
    return {"criteria": res["criteria"], "res": res["params"], "emp_flip": emp["flip"]}


def empathy_ok(aid):
    return evaluator(aid, "empathy")["kappa"] >= S["kappa_threshold"]


# --------------------------------------------------------------------- audit
def audit(actor, event, obj, detail=None, when=None):
    prev = S["audit"][-1]["hash"] if S["audit"] else "0" * 64
    rec = {"time": when or now_iso(), "actor": actor, "event": event, "obj": obj, "detail": detail or "", "prev": prev}
    rec["hash"] = hashlib.sha256(json.dumps(rec, sort_keys=True).encode()).hexdigest()
    S["audit"].append(rec)
    return rec


def audit_verify():
    prev = "0" * 64
    for i, r in enumerate(S["audit"]):
        body = {k: r[k] for k in ("time", "actor", "event", "obj", "detail", "prev")}
        if r["prev"] != prev or hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest() != r["hash"]:
            return {"ok": False, "broken_at": i, "entries": len(S["audit"])}
        prev = r["hash"]
    return {"ok": True, "entries": len(S["audit"]), "head": prev}


# -------------------------------------------------------------------- traces
def _trace_record(aid, h, ep, j, day, rng):
    rec = E.summarize(ep, j)
    tid = "tr_%08x" % zlib.crc32(f"{aid}:{ep['scen_seed']}".encode())
    rec.update(id=tid, agent=aid, kind=h["kind"], day=day, date=day_label(day),
               time=f"{rng.randint(8, 21):02d}:{rng.randint(0, 59):02d}", harness=h["id"], version=h["version"],
               label=ep["scenario"]["label"], close_right_after_quote=ep["obs"]["close_right_after_quote"],
               human_flag=(not ep["truth"]["resolved"]) and rng.random() < 0.03,
               snippet=next((m["text"] for m in ep["messages"] if m["role"] == "customer"), ""))
    rec["flagged"] = bool(A.is_flagged(rec))
    rec["theme"] = A.theme_of(rec) if rec["flagged"] else None
    return rec


def _gen_traces(aid, days=14):
    a = agent(aid)
    rng = random.Random(zlib.crc32(aid.encode()))
    out, eps = [], {}
    versions = sorted([h for h in S["harnesses"].values() if h["agent"] == aid and "released_day" in h],
                      key=lambda h: h["released_day"])
    cfg = judge_cfg(aid)
    seed = 1 if aid == "billing" else 50001
    for d in range(days):
        h = [v for v in versions if v["released_day"] <= d][-1]
        for _ in range(a["per_day"]):
            ep = env.run_episode(h, seed)
            j = judges.evaluate_all(ep, cfg)
            rec = _trace_record(aid, h, ep, j, d, rng)
            out.append(rec)
            eps[rec["id"]] = (ep, j)
            seed += 1
    return out, eps


def trace_list(aid, theme=None, flt=None, limit=60, offset=0):
    items = [t for t in S["traces"].values() if t["agent"] == aid]
    if theme:
        items = [t for t in items if t["theme"] and f"{aid}-{t['theme']}" == theme]
    if flt == "flagged":
        items = [t for t in items if t["flagged"]]
    elif flt == "judge_fail":
        items = [t for t in items if not t["judged_pass"]]
    elif flt == "repeat":
        items = [t for t in items if t["repeat"]]
    elif flt == "unlabeled":
        items = [t for t in items if t["id"] not in S["labels"]]
    items.sort(key=lambda t: (-t["day"], t["time"]), reverse=False)
    return {"total": len(items), "items": items[offset:offset + limit]}


def trace_detail(tid):
    t = S["traces"][tid]
    ep, j = S["eps"][tid]
    th = f"{t['agent']}-{t['theme']}" if t["theme"] else None
    return {**t, "messages": ep["messages"], "spans": ep["spans"], "decisions": ep["decisions"], "obs": ep["obs"],
            "evaluators": j, "human": S["labels"].get(tid), "theme_id": th,
            "theme_name": S["theme_index"][th]["name"] if th in S["theme_index"] else None,
            "tokens": ep["tokens"], "latency": ep["latency"]}


def label_trace(tid, verdict, actor="Reviewer"):
    S["labels"][tid] = verdict
    audit(actor, "Human label", tid, verdict)
    return {"ok": True, "labeled": len(S["labels"])}


# ------------------------------------------------------------------- themes
def analyze(aid, actor="System"):
    traces = [t for t in S["traces"].values() if t["agent"] == aid]
    versions = {h["id"]: h for h in S["harnesses"].values() if h["agent"] == aid and "released_day" in h}
    themes = A.build_themes(aid, traces, versions)
    for th in themes:
        th["first_seen"] = day_label(th["first_seen_day"])
        S["theme_index"][th["id"]] = th
    S["themes"][aid] = [th["id"] for th in themes]
    audit(actor, "Analysis run", aid, f"{len(traces)} traces, {len(themes)} themes")
    return themes


def _theme_status(th):
    b = S["bundle_by_theme"].get(th["id"])
    if not b:
        return "New", 0
    bundle = S["bundles"][b]
    sts = [f["status"] for f in bundle["fixes"]]
    for s in ("Live", "Rolling out", "Awaiting approval", "Validated"):
        if s in sts:
            return {"Live": "Fixed", "Rolling out": "Rolling out", "Awaiting approval": "Fix in approval",
                    "Validated": "Fix validated"}[s], len(sts)
    return "Fix proposed", len(sts)


def theme_view(tid):
    th = dict(S["theme_index"][tid])
    th["status"], th["fixes"] = _theme_status(th)
    th["bundle_id"] = S["bundle_by_theme"].get(tid)
    return th


def themes(aid):
    return [theme_view(t) for t in S["themes"].get(aid, [])]


def theme_detail(tid):
    th = theme_view(tid)
    aid = th["agent"]
    ev = [t for t in S["traces"].values() if t["agent"] == aid and t["theme"] and f"{aid}-{t['theme']}" == tid]
    ev.sort(key=lambda t: (t["repeat"], -t["judged_score"]), reverse=True)
    th["evidence_total"] = len(ev)
    th["evidence"] = ev[:12]
    th["bundle"] = bundle_view(th["bundle_id"]) if th["bundle_id"] else None
    th["suggested_tests"] = min(64, len({(t["type"], t["seed"] % 97) for t in ev}))
    return th


# ------------------------------------------------------------------ bundles
def generate_bundle(tid, actor="Optimizer", validate=True, n=600):
    th = S["theme_index"][tid]
    aid = th["agent"]
    base = prod(aid)
    kind = base["kind"]
    lib = A.FIX_LIBRARY.get(th["key"], [])
    fixes = []
    for i, (title, edits) in enumerate(lib, 1):
        if any(e["op"] == "add_line" and kind not in H.LINES[e["id"]]["agents"] for e in edits):
            continue
        if any(e["op"] == "gate_on" and kind not in H.GATES[e["id"]]["agents"] for e in edits):
            continue
        if all((e["op"] == "remove_line" and e["id"] not in base["lines"]) for e in edits):
            continue
        fixes.append({"id": f"F-{len(fixes) + 1}", "title": title, "edits": edits,
                      "layer": H.edit_layer(edits[0]), "risk": H.edits_risk(edits), "status": "Draft",
                      "validation": None, "harness_id": None})
    bid = next_id("bundle", "B-{:03d}")
    b = {"id": bid, "agent": aid, "theme_id": tid, "base_id": base["id"], "fixes": fixes, "created": now_iso(),
         "combined": None, "proposed_from": th["traces"]}
    S["bundles"][bid] = b
    S["bundle_by_theme"][tid] = bid
    audit(actor, "Fix bundle proposed", bid, f"{len(fixes)} fixes for “{th['name']}” from {th['traces']} failure traces")
    if validate:
        for f in fixes:
            validate_fix(bid, f["id"], n=n, actor=actor)
        combine(bid, n=n)
    return bundle_view(bid)


def _fix_harness(b, f):
    base = get_h(b["base_id"])
    if not f.get("harness_id"):
        hid = f"{b['agent']}-{b['id']}-{f['id']}"
        h = H.apply_edits(base, f["edits"], hid=hid, name=f"{base['version']} + {f['id']}",
                          note=f["title"])
        h["version"] = _next_version(b["agent"], draft=True)
        register(h)
        f["harness_id"] = hid
    return get_h(f["harness_id"])


def _next_version(aid, draft=False):
    vs = [h["version"] for h in S["harnesses"].values() if h["agent"] == aid and "released_day" in h]
    prefix = "v" if aid == "billing" else "o-v"
    nums = [int(v.replace(prefix, "")) for v in vs if v.replace(prefix, "").isdigit()]
    return f"{prefix}{max(nums) + 1}" + (" (proposed)" if draft else "")


def calibration_kappa(aid, criteria=None, n=1240):
    ids = S["calibration"][aid][:n]
    res = evaluator(aid, "resolution")
    crit = criteria or res["criteria"]
    j = [judges.resolution(S["eps"][i][0], crit, res["params"])["pass"] for i in ids]
    g = [judges.human_label(S["eps"][i][0]) for i in ids]
    return E.kappa(j, g)


def validate_fix(bid, fid, n=600, sim_error=0.0, actor="Optimizer"):
    b = S["bundles"][bid]
    f = next(x for x in b["fixes"] if x["id"] == fid)
    aid = b["agent"]
    base = get_h(b["base_id"])
    cand = _fix_harness(b, f)
    cfg = judge_cfg(aid)
    only_eval = all(H.edit_layer(e) == "Evaluator" for e in f["edits"])
    seeds = range(40000, 40000 + n)
    v = {"n": n, "sim_error": sim_error, "at": now_iso(), "only_evaluator": only_eval}
    if only_eval:
        crit = sorted(set(cfg["criteria"]) | {e["id"] for e in f["edits"] if e["op"] == "add_criterion"})
        v["kappa_before"] = calibration_kappa(aid)
        v["kappa_after"] = calibration_kappa(aid, crit)
        v["lift"] = None
    else:
        br = E.run(base, seeds, cfg, sim_error=sim_error)
        cr = E.run(cand, seeds, cfg, sim_error=sim_error)
        v.update(base=E.metrics(br), cand=E.metrics(cr), lift=E.compare(br, cr, "judged_pass"),
                 gold=E.compare(br, cr, "gold"), repeat=E.compare(br, cr, "repeat"))
        v["kappa"] = calibration_kappa(aid)
    suite = S["suite_by_agent"].get(aid)
    if suite:
        rr = run_suite(suite, cand["id"], record=False)
        v["regression"] = {"passed": rr["passed"], "total": rr["total"], "gate": rr["gate_ok"]}
    v["frozen_untouched"] = not any(e["op"] == "remove_line" and H.is_frozen(e["id"]) for e in f["edits"])
    f["validation"] = v
    if f["status"] == "Draft" and (only_eval or (v["lift"]["lo"] > 0)):
        f["status"] = "Validated"
    audit(actor, "Offline replay", f"{bid}/{fid}",
          f"n={n}" + ("" if only_eval else f", resolution {v['lift']['diff'] * 100:+.1f} pts"))
    return fix_view(bid, fid)


def combine(bid, fids=None, n=600):
    b = S["bundles"][bid]
    aid = b["agent"]
    fixes = [f for f in b["fixes"] if (fids is None and H.edit_layer(f["edits"][0]) != "Evaluator"
                                       and f["validation"] and f["validation"].get("lift") and f["validation"]["lift"]["diff"] > 0)
             or (fids and f["id"] in fids)][:2]
    if not fixes:
        return None
    base = get_h(b["base_id"])
    edits = [e for f in fixes for e in f["edits"]]
    hid = f"{aid}-{bid}-" + "+".join(f["id"] for f in fixes)
    h = H.apply_edits(base, edits, hid=hid, name=f"{base['version']} + " + " + ".join(f["id"] for f in fixes))
    h["version"] = _next_version(aid, draft=True)
    register(h)
    cfg = judge_cfg(aid)
    seeds = range(40000, 40000 + n)
    br, cr = E.run(base, seeds, cfg), E.run(h, seeds, cfg)
    b["combined"] = {"fix_ids": [f["id"] for f in fixes], "harness_id": hid, "n": n, "base": E.metrics(br),
                     "cand": E.metrics(cr), "lift": E.compare(br, cr, "judged_pass"), "gold": E.compare(br, cr, "gold")}
    return b["combined"]


def fix_view(bid, fid):
    b = S["bundles"][bid]
    f = next(x for x in b["fixes"] if x["id"] == fid)
    base = get_h(b["base_id"])
    cand = _fix_harness(b, f)
    a = agent(b["agent"])
    th = S["theme_index"][b["theme_id"]]
    return {**f, "bundle_id": bid, "index": b["fixes"].index(f) + 1, "count": len(b["fixes"]),
            "theme": {"id": th["id"], "name": th["name"], "traces": th["traces"]}, "agent": a,
            "base": H.public(base), "cand": H.public(cand), "prompt_rows": H.prompt_rows(base, cand),
            "config_rows": H.config_rows(base, cand), "edit_labels": [H.edit_label(e) for e in f["edits"]],
            "approval": next((ap["id"] for ap in S["approvals"].values() if bid == ap.get("bundle_id") and fid in ap.get("fix_ids", [])), None),
            "patch": H.patch(base, cand), "pr": S.get("prs", {}).get(f"{bid}/{fid}")}


def bundle_view(bid):
    b = S["bundles"][bid]
    th = S["theme_index"][b["theme_id"]]
    return {**{k: v for k, v in b.items() if k != "fixes"}, "theme_name": th["name"], "agent_name": agent(b["agent"])["name"],
            "fixes": [{k: v for k, v in f.items() if k != "edits"} | {"edit_labels": [H.edit_label(e) for e in f["edits"]]}
                      for f in b["fixes"]]}


def bundles(aid=None):
    return [bundle_view(b) for b in S["bundles"] if aid is None or S["bundles"][b]["agent"] == aid]


# ------------------------------------------------------------------- replay
def replay(base_id, cand_id, scen_seed=None, samp_seed=None, trace_id=None, mode="simulator", sim_error=0.0):
    if trace_id:
        t = S["traces"][trace_id]
        scen_seed, samp_seed = t["seed"], t["samp"]
    base, cand = get_h(base_id), get_h(cand_id)
    aid = base["agent"]
    cfg = judge_cfg(aid)
    out = {}
    eps = {}
    for key, h in (("before", base), ("after", cand)):
        ep = env.run_episode(h, scen_seed, samp_seed, sim_error)
        j = judges.evaluate_all(ep, cfg)
        eps[key] = ep
        out[key] = {"harness": H.public(h), "messages": ep["messages"], "decisions": ep["decisions"],
                    "eval": {"resolution": j["resolution"], "policy": j["policy"], "tool_sequence": j["tool_sequence"],
                             "outcome": j["outcome"]},
                    "gold": ep["truth"]["resolved"], "tokens": ep["tokens"], "latency": ep["latency"]}
    div = env.divergence(eps["before"]["messages"], eps["after"]["messages"])
    if mode == "prefix" and div >= 0:
        out["after"]["messages"] = eps["after"]["messages"][:div + 1]
        out["after"]["truncated"] = True
    changed = [d for d, (x, y) in enumerate(zip(eps["before"]["decisions"], eps["after"]["decisions"])) if x["a"] != y["a"]]
    return {"scen_seed": scen_seed, "samp_seed": samp_seed, "scenario": eps["before"]["scenario"], "divergence": div,
            "mode": mode, "sim_error": sim_error, "changed_decisions": changed,
            "decision_labels": env.DECISION_LABEL, "action_labels": env.ACTION_LABEL, **out}


def replay_examples(base_id, cand_id, tid=None, k=8):
    """Evidence traces whose conversation actually changes under the candidate."""
    base, cand = get_h(base_id), get_h(cand_id)
    aid = base["agent"]
    pool = [t for t in S["traces"].values() if t["agent"] == aid and t["harness"] == base["id"]]
    if tid:
        key = tid.split("-", 1)[1]
        pool = [t for t in pool if t["theme"] == key] + [t for t in pool if t["theme"] != key]
    out = []
    for t in pool:
        a = env.run_episode(base, t["seed"], t["samp"])
        b = env.run_episode(cand, t["seed"], t["samp"])
        d = env.divergence(a["messages"], b["messages"])
        if d >= 0:
            out.append({"trace_id": t["id"], "label": t["label"], "snippet": t["snippet"], "date": t["date"],
                        "fixed": (not a["truth"]["resolved"]) and b["truth"]["resolved"],
                        "regressed": a["truth"]["resolved"] and not b["truth"]["resolved"]})
        if len(out) >= k:
            break
    out.sort(key=lambda x: (not x["fixed"], x["regressed"]))
    return out


def delivery(bid, fid, method):
    fv = fix_view(bid, fid)
    b = S["bundles"][bid]
    a = agent(b["agent"])
    base, cand = get_h(b["base_id"]), get_h(fv["harness_id"])
    if method == "pr":
        out = _open_pr(bid, fid, fv, a, base, cand)
    elif method == "registry":
        out = {"method": "Prompt registry", "payload": {"agent": a["id"], "version": cand["version"],
                                                        "system_prompt": H.system_prompt(cand), "gates": cand["gates"],
                                                        "tools": cand["tools"]}}
    elif method == "vendor":
        out = {"method": "Vendor change request", "vendor": a.get("vendor", "[VENDOR NAME]"),
               "spec": {"change": fv["title"], "edits": fv["edit_labels"], "diff": H.patch(base, cand),
                        "evidence": {"theme": fv["theme"]["name"], "traces": fv["theme"]["traces"],
                                     "validation": fv["validation"] and {k: fv["validation"].get(k) for k in ("n", "lift", "gold")}},
                        "attestation_required": "Vendor confirms deployed version hash"}}
    elif method == "config_api":
        out = {"method": "Runtime config API", "request": {"PATCH": f"/v1/agents/{a['id']}/config",
                                                            "body": {"system_prompt": H.system_prompt(cand), "gates": cand["gates"]}}}
    else:
        out = {"method": "Gateway overlay", "overlay": {"pre": [], "post": [g for g in cand["gates"] if g not in base["gates"]],
                                                       "note": "Tool gating and pre/post-processing in the Verizon proxy layer"}}
    if method != "pr":
        audit("You", "Delivery artifact generated", f"{bid}/{fid}", out["method"])
    return out


def _harness_files(folder, h):
    return {f"{folder}/system_prompt.md": H.system_prompt(h) + "\n", f"{folder}/harness.yaml": H.harness_yaml(h) + "\n"}


def _open_pr(bid, fid, fv, a, base, cand):
    """Branch + two commits (production baseline, then the fix) + pull request on the agent's repo."""
    if not a.get("repo_path"):
        raise ValueError(f"{a['name']} has no connected repository.")
    folder, v = a["repo_path"], fv["validation"]
    branch = f"hoe/{bid.lower()}-{fid.lower()}"
    title = f"[HOE] {fid}: {fv['title']}"
    lift = v and v.get("lift")
    body = "\n".join([
        f"## {fv['title']}", "",
        f"Proposed by the Harness Optimization Engine for **{a['name']}** ({base['version']} → {cand['version']}).", "",
        f"- **Failure theme:** {fv['theme']['name']} ({fv['theme']['traces']} traces)",
        f"- **Layer / risk:** {fv['layer']} · {fv['risk']}",
        *([f"- **Offline replay (n={v['n']}):** resolution {lift['diff'] * 100:+.1f} pts "
           f"(95% CI {lift['lo'] * 100:+.1f} to {lift['hi'] * 100:+.1f})"] if lift else []),
        *([f"- **Regression suite:** {v['regression']['passed']}/{v['regression']['total']} pass"] if v and v.get("regression") else []),
        "", "### Edits", *[f"- {e}" for e in fv["edit_labels"]], "",
        "### Commits",
        f"1. Production baseline `{base['version']}` (so the second commit shows the exact change)",
        f"2. The fix: `{cand['version']}`", "",
        "### Diff", "```diff", H.patch(base, cand), "```", "",
        "CI runs the regression suite on this branch. Merge follows your SDLC; production rollout still goes "
        "through HOE approvals and staged canary.",
    ])
    baseline = (f"HOE baseline: {a['id']} {base['version']} (production)", _harness_files(folder, base))
    commits = [(f"{title} ({base['version']} → {cand['version']})", _harness_files(folder, cand))]
    try:
        g = vcs.open_pr(branch, title, body, commits, baseline=baseline)
    except vcs.GitHubError as e:
        audit("You", "Pull request failed", f"{bid}/{fid}", str(e))
        raise ValueError(str(e)) from None
    out = {"method": "Open pull request", "target": a.get("repo"), "title": title, "body": body,
           "patch": H.patch(base, cand), **g}
    if g["live"]:
        vcs.invalidate()  # the Version control screen shows the new branch and PR on its next poll
        S.setdefault("prs", {})[f"{bid}/{fid}"] = {k: g[k] for k in ("pr_number", "pr_url", "branch", "branch_url")} | {
            "commits": g["commits"], "at": now_iso()}
        audit("You", "Pull request reused" if g["pr_reused"] else "Pull request opened", f"{bid}/{fid}",
              f"{vcs.REPO}#{g['pr_number']} {g['pr_url']}")
    else:
        audit("You", "Pull request prepared (dry run)", f"{bid}/{fid}", f"{vcs.REPO} branch {branch}")
    return out


# --------------------------------------------------------------- experiments
def run_experiment(aid, cand_ids, n=1200, seeds=1, sim_error=0.0, name=None, theme_id=None, weights=None, eid=None, actor="You"):
    cfg = judge_cfg(aid)
    w = {**E.DEFAULT_WEIGHTS, **(weights or {})}
    base_id = cand_ids[0]
    per = {}
    for hid in cand_ids:
        recs_all = []
        for k in range(seeds):
            recs_all.append(E.run(get_h(hid), range(40000, 40000 + n), cfg, samp_offset=k * 1_000_000, sim_error=sim_error))
        per[hid] = recs_all
    results, pvals = [], []
    for hid in cand_ids:
        flat = [r for rs in per[hid] for r in rs]
        m = E.metrics(flat)
        m["reward"] = E.mean(E.reward(r, w) for r in flat)
        m["seed_res"] = [E.metrics(rs)["resolution"] for rs in per[hid]]
        row = {"id": hid, "name": get_h(hid)["name"], "note": get_h(hid).get("note", ""),
               "has_adapter": bool(get_h(hid).get("adapter")), "metrics": m}
        if hid != base_id:
            bflat = [r for rs in per[base_id] for r in rs]
            row["lift"] = E.compare(bflat, flat, "judged_pass")
            row["gold_lift"] = E.compare(bflat, flat, "gold")
            pvals.append(row["lift"]["p"])
            passed = [r for r in per[hid][0] if r["judged_pass"]][:50]
            row["audit"] = {"sampled": len(passed), "confirmed": sum(r["gold"] for r in passed)}
        results.append(row)
    adj = E.holm(pvals)
    for row, a in zip(results[1:], adj):
        row["lift"]["p_holm"] = a
        row["significant"] = a < 0.05 and row["lift"]["lo"] > 0
    base_passed = [r for r in per[base_id][0] if r["judged_pass"]][:50]
    base_audit = {"sampled": len(base_passed), "confirmed": sum(r["gold"] for r in base_passed)}
    feasible = [r for r in results[1:] if r["metrics"]["violations"] <= results[0]["metrics"]["violations"] + 0.002 and not r["has_adapter"]]
    rec = max(feasible, key=lambda r: r["metrics"]["reward"], default=None)
    eid = eid or next_id("exp", "EXP-{}")
    S["experiments"][eid] = {"id": eid, "agent": aid, "name": name or f"{agent(aid)['name']} comparison",
                             "theme_id": theme_id, "candidates": cand_ids, "n": n, "seeds": seeds, "sim_error": sim_error,
                             "weights": w, "results": results, "base_audit": base_audit,
                             "recommended": rec["id"] if rec else None, "created": now_iso()}
    audit(actor, "Experiment run", eid, f"{len(cand_ids)} candidates, n={n}, seeds={seeds}")
    return S["experiments"][eid]


def experiments(aid=None):
    return [{k: v for k, v in e.items() if k != "results"} | {"best": max((r["metrics"]["resolution"] for r in e["results"]), default=0)}
            for e in S["experiments"].values() if aid is None or e["agent"] == aid]


def candidates(aid):
    out = []
    for h in S["harnesses"].values():
        if h["agent"] != aid:
            continue
        out.append({**H.public(h), "production": S["production"][aid] == h["id"], "released": "released_day" in h,
                    "edits_vs_prod": [H.edit_label(e) for e in H.edits_between(prod(aid), h)]})
    return out


# ------------------------------------------------------------ optimizer / RL
def start_optimizer(P):
    cfgs = get_settings()
    aid = P.get("agent", "billing")
    base = get_h(P.get("base_id") or prod(aid)["id"])
    cfg = judge_cfg(aid)
    emp_ok = empathy_ok(aid)
    audit("You", "Optimizer run started", aid, f"budget {P.get('budget', cfgs.optimizer_budget)} rollouts")

    def fn(job):
        res = optimizer.run(job, P, base, cfg, emp_ok)
        with LOCK:
            if res.get("best"):
                n = next_id("opt", "{}")
                h = copy.deepcopy(res["best"]["h"])
                h["id"], h["name"] = f"{aid}-OPT-{n}", f"OPT-{n}: {base['version']} + {len(res['best']['edits'])} edits"
                h["version"], h["note"], h["parent"] = _next_version(aid, draft=True), "Found by harness optimizer", base["id"]
                register(h)
                res["best"] = {"id": h["id"], "name": h["name"], "edits": [H.edit_label(e) for e in res["best"]["edits"]]}
                audit("Optimizer", "Candidate registered", h["id"], f"{res['explored']} candidates explored, {res['used']} rollouts")
            else:
                res["best"] = None
        return res
    return jobs.start("optimizer", P, fn).view()


def start_rl(P):
    cfgs = get_settings()
    aid = P.get("agent", "billing")
    base = get_h(P.get("base_id") or prod(aid)["id"])
    if agent(aid)["level"] != "1p_repo":
        raise ValueError("RL fine-tuning of weights needs a first-party agent with repo access.")
    cfg = judge_cfg(aid)
    audit("You", "RL run started", base["id"], f"{P.get('algorithm', cfgs.rl_algorithm)} · reward {P.get('reward_source', 'judge')}")

    def fn(job):
        res = rl.train(job, P, base, cfg)
        with LOCK:
            n = next_id("adapter", "{}")
            h = copy.deepcopy(base)
            h["id"] = f"{aid}-W-{n}"
            h["name"] = f"{base['name'].split(':')[0]} + adapter W-{n}"
            h["adapter"], h["adapter_id"] = res["adapter"], f"W-{n}"
            h["version"] = _next_version(aid, draft=True)
            h["parent"], h["note"] = base["id"], f"{P.get('algorithm', cfgs.rl_algorithm).upper()} on {P.get('reward_source', 'judge')} reward"
            h.pop("released_day", None)
            register(h)
            res["candidate"] = {"id": h["id"], "name": h["name"]}
            res.pop("adapter", None)
            audit("RL trainer", "Adapter registered", h["id"], h["note"])
        return res
    return jobs.start("rl", P, fn).view()


# ---------------------------------------------------------------- regression
def _make_test(tid, typ, seed, samp, assertion, source, holdout=False, synthetic=False, status="Active"):
    exp, check, _ = ASSERTIONS[assertion]
    return {"id": tid, "scenario": env.SCENARIO_LABEL[typ], "type": typ, "seed": seed, "samp": samp,
            "assertion": assertion, "expected": exp, "check": check, "status": status, "holdout": holdout,
            "synthetic": synthetic, "source": source}


def _seed_suite(aid, n):
    h = prod(aid)
    tests, s, rng = [], 60000 if aid == "billing" else 65000, random.Random(3)
    while len(tests) < n:
        ep = env.run_episode(h, s)
        a = TYPE_ASSERTION[ep["scenario"]["type"]]
        if ASSERTIONS[a][2](ep["obs"]):
            tests.append(_make_test(f"RT-{len(tests) + 1:03d}", ep["scenario"]["type"], s, s, a, "baseline",
                                    holdout=rng.random() < 0.2))
        s += 1
    return tests


def suites(aid=None):
    return [{**{k: v for k, v in su.items() if k != "tests"}, "count": len(su["tests"]),
             "holdout": sum(t["holdout"] for t in su["tests"])} for su in S["suites"].values()
            if aid is None or su["agent"] == aid]


def suite_detail(sid):
    return S["suites"][sid]


def convert_theme(tid, suite_id=None, max_tests=64, holdout=0.2, synthetic=True, redact=True, commit=False, actor="You"):
    th = S["theme_index"][tid]
    aid = th["agent"]
    ev = [t for t in S["traces"].values() if t["agent"] == aid and t["theme"] and f"{aid}-{t['theme']}" == tid]
    rng = random.Random(11)
    seen, picked = set(), []
    for t in sorted(ev, key=lambda x: x["seed"]):
        a = "followup" if t["open_question"] else "dispute" if t["dispute_unaddressed"] else \
            "silence" if t["silent_close"] else "eta" if t["eta_unverified"] else "policy" if t["violation"] else "tool_order"
        key = (t["type"], a, t["seed"] % 7)
        if key in seen:
            continue
        seen.add(key)
        picked.append((t, a))
    rng.shuffle(picked)
    n_syn = int(max_tests * 0.2) if synthetic else 0
    picked = picked[:max_tests - n_syn]
    suite = S["suites"][suite_id or S["suite_by_agent"][aid]]
    start = len(suite["tests"]) + 101
    tests = [_make_test(f"RT-{start + i}", t["type"], t["seed"], t["samp"], a, tid,
                        holdout=rng.random() < holdout, status="Draft") for i, (t, a) in enumerate(picked)]
    if synthetic:  # same scenario types, fresh seeds that fail on production
        types = Counter(t["type"] for t, _ in picked)
        s, h = 70000, prod(aid)
        while n_syn > 0 and s < 90000:
            ep = env.run_episode(h, s)
            typ = ep["scenario"]["type"]
            a = TYPE_ASSERTION.get(typ, "tool_order")
            if types.get(typ) and not ASSERTIONS[a][2](ep["obs"]):
                tests.append(_make_test(f"RT-{start + len(tests)}", typ, s, s, a, tid, synthetic=True,
                                        holdout=rng.random() < holdout, status="Draft"))
                n_syn -= 1
            s += 1
    out = {"theme": th["name"], "evidence": len(ev), "tests": tests, "suite": suite["id"], "committed": False,
           "redacted": redact}
    if commit:
        for t in tests:
            t["status"] = "Active"
        suite["tests"] += tests
        out["committed"] = True
        audit(actor, "Regression tests created", suite["id"], f"{len(tests)} tests from “{th['name']}”")
    return out


def run_suite(sid, hid, record=True, include_holdout=False, actor="You"):
    su = S["suites"][sid]
    h = get_h(hid)
    res = []
    for t in su["tests"]:
        if t["holdout"] and not include_holdout:
            continue
        ep = env.run_episode(h, t["seed"], t["samp"])
        res.append({"id": t["id"], "pass": bool(ASSERTIONS[t["assertion"]][2](ep["obs"])), "assertion": t["assertion"]})
    passed = sum(r["pass"] for r in res)
    rate = passed / len(res) if res else 1.0
    policy_ok = all(r["pass"] for r in res if r["assertion"] == "policy")
    ok = rate >= su["gate"]["min_pass"] and (policy_ok or not su["gate"]["policy_all"])
    out = {"suite": sid, "harness": hid, "passed": passed, "total": len(res), "rate": rate, "policy_ok": policy_ok,
           "gate_ok": ok, "results": res}
    if record:
        su["last_run"] = {k: v for k, v in out.items() if k != "results"} | {"at": now_iso(), "name": h["name"]}
        audit(actor, "Regression suite run", sid, f"{h['name']}: {passed}/{len(res)} pass")
    return out


def set_gate(sid, min_pass=None, policy_all=None, actor="You"):
    su = S["suites"][sid]
    if su["gate"].get("gov_signoff"):
        audit(actor, "Gate change (requires AI Governance sign-off)", sid, f"min_pass={min_pass}")
    if min_pass is not None:
        su["gate"]["min_pass"] = float(min_pass)
    if policy_all is not None:
        su["gate"]["policy_all"] = bool(policy_all)
    return suites()


# ----------------------------------------------------------------- approvals
def route(edits, aid):
    layers = {H.edit_layer(e) for e in edits}
    if "Model weights" in layers:
        idx = 4
    elif "Guardrail" in layers:
        idx = 2
    elif "Evaluator" in layers:
        idx = 3
    elif layers & {"Control flow", "Context & memory"}:
        idx = 1
    else:
        idx = 0
    appr = list(POLICY[idx]["approvers"])
    if agent(aid)["type"] == "Third-party" and idx != 4:
        appr = appr + [a for a in POLICY[5]["approvers"] if a not in appr]
    return POLICY[idx]["type"], appr, POLICY[idx]["rollout"]


def create_approval(aid, cand_id, title, bundle_id=None, fix_ids=None, day_offset=0, actor="You", checks=None, run_id=None):
    base = prod(aid)
    cand = get_h(cand_id)
    edits = H.edits_between(base, cand)
    ctype, approvers, rollout = route(edits, aid)
    cid = next_id("cr", "CR-{}")
    su = S["suite_by_agent"].get(aid)
    if checks is None:
        rr = run_suite(su, cand_id, record=False) if su else None
        checks = {"regression": rr and f"{rr['passed']}/{rr['total']} pass", "regression_ok": bool(rr and rr["gate_ok"]),
                  "frozen": "Untouched", "judge": f"κ {calibration_kappa(aid):.2f}"}
    ap = {"id": cid, "title": title, "agent": aid, "agent_name": agent(aid)["name"], "base_id": base["id"],
          "harness_id": cand_id, "bundle_id": bundle_id, "fix_ids": fix_ids or [], "change_type": ctype,
          "run_id": run_id,
          "layers": sorted({H.edit_layer(e) for e in edits}), "risk": H.edits_risk(edits),
          "edit_labels": [H.edit_label(e) for e in edits], "rollout_plan": rollout,
          "approvers": [{"role": r, "status": "Pending", "by": None, "at": None, "comment": ""} for r in approvers],
          "status": "Waiting", "created": now_iso(), "created_day": 13 - day_offset, "checks": checks,
          "rollout": None, "comments": []}
    S["approvals"][cid] = ap
    if bundle_id:
        for f in S["bundles"][bundle_id]["fixes"]:
            if f["id"] in (fix_ids or []):
                f["status"] = "Awaiting approval"
    if run_id is not None:
        S.setdefault("run_links", {})[int(run_id)] = cid
    audit(actor, "Sent to approvals", cid, f"{title} · {ctype}")
    return ap


def link_run_approval(run_id, cid, actor="You"):
    run_id = int(run_id)
    if cid not in S["approvals"]:
        raise ValueError(f"Unknown approval {cid}")
    S.setdefault("run_links", {})[run_id] = cid
    S["approvals"][cid]["run_id"] = run_id
    audit(actor, "Run linked to approval", cid, f"run_id={run_id}")
    return {"run_id": run_id, "approval_id": cid, "ok": True}


def approval_view(ap):
    waiting = next((a["role"] for a in ap["approvers"] if a["status"] == "Pending"), None)
    return {**ap, "waiting_on": waiting if ap["status"] == "Waiting" else None,
            "age_days": 13 - ap.get("created_day", 13)}


def approvals():
    items = [approval_view(a) for a in S["approvals"].values()]
    decided = [a for a in items if a.get("decided_days") is not None]
    return {"items": items, "policy": POLICY,
            "waiting": sum(1 for a in items if a["status"] == "Waiting"),
            "median_days": sorted(a["decided_days"] for a in decided)[len(decided) // 2] if decided else None,
            "rolled_back_30d": sum(1 for a in items if a["status"] == "Rolled back")}


def decide(cid, role, decision, comment="", actor=None):
    ap = S["approvals"][cid]
    slot = next((a for a in ap["approvers"] if a["role"] == role), None)
    if not slot:
        raise ValueError(f"{role} is not an approver for {cid}")
    owner_name = (get_settings().approval_owner_name or "Agent owner").strip()
    approver_name = owner_name if role == "Agent owner" else (actor or role)
    slot.update(status={"approve": "Approved", "changes": "Changes requested", "reject": "Rejected"}[decision],
                by=approver_name, at=now_iso(), comment=comment)
    if comment:
        ap["comments"].append({"by": approver_name, "text": comment, "at": now_iso()})
    if decision == "reject":
        ap["status"] = "Rejected"
    elif decision == "changes":
        ap["status"] = "Changes requested"
    elif all(a["status"] == "Approved" for a in ap["approvers"]):
        ap["status"] = "Approved"
        ap["decided_days"] = max(1, ap.get("age_days", 1))
        ap["rollout"] = {"stage": -1, "stages": [{"name": s, "status": "Pending", "metrics": None} for s in STAGES]}
    audit(approver_name, {"approve": "Approved", "changes": "Changes requested", "reject": "Rejected"}[decision], cid, comment)
    return approval_view(ap)


def advance(cid, actor="Release manager"):
    ap = S["approvals"][cid]
    if ap["status"] not in ("Approved", "Rolling out"):
        raise ValueError("Rollout starts after every approver has approved.")
    ro = ap["rollout"]
    i = ro["stage"] + 1
    if i >= len(STAGES):
        return approval_view(ap)
    aid = ap["agent"]
    base, cand = get_h(ap["base_id"]), get_h(ap["harness_id"])
    cfg = judge_cfg(aid)
    n = [400, 250, 400, 600, 600][i]
    seeds = range(90000 + i * 5000, 90000 + i * 5000 + n)
    br, cr = E.run(base, seeds, cfg), E.run(cand, seeds, cfg)
    mb, mc = E.metrics(br), E.metrics(cr)
    delta = mc["resolution"] - mb["resolution"]
    m = {"n": n, "base": mb["resolution"], "cand": mc["resolution"], "delta": delta,
         "viol_base": mb["violations"], "viol_cand": mc["violations"], "repeat_delta": mc["repeat"] - mb["repeat"]}
    ro["stages"][i]["metrics"] = m
    if delta < -0.01 or mc["violations"] > mb["violations"] + 0.004:
        ro["stages"][i]["status"] = "Rolled back"
        ap["status"] = "Rolled back"
        audit("Rollout controller", "Auto-rollback", cid, f"{STAGES[i]}: resolution {delta * 100:+.1f} pts")
        return approval_view(ap)
    ro["stages"][i]["status"] = "Passed"
    ro["stage"] = i
    ap["status"] = "Rolling out"
    audit(actor, "Rollout stage passed", cid, f"{STAGES[i]}: resolution {delta * 100:+.1f} pts")
    for f in _fixes_of(ap):
        f["status"] = "Rolling out"
    if i == len(STAGES) - 1:
        ap["status"] = "Live"
        promote_to_prod(aid, cand["id"], ap)
    return approval_view(ap)


def _fixes_of(ap):
    if not ap.get("bundle_id"):
        return []
    return [f for f in S["bundles"][ap["bundle_id"]]["fixes"] if f["id"] in ap["fix_ids"]]


def promote_to_prod(aid, hid, ap=None):
    h = get_h(hid)
    old = prod(aid)
    h["version"] = _next_version(aid)
    h["released_day"] = 14
    S["production"][aid] = hid
    for f in _fixes_of(ap or {}):
        f["status"] = "Live"
    crit_added = [e for e in H.edits_between(old, h) if e["op"] == "add_criterion"]
    if crit_added:
        res = evaluator(aid, "resolution")
        res["criteria"] = sorted(set(res["criteria"]) | {e["id"] for e in crit_added})
    edits = H.edits_between(old, h)
    if ap and ap.get("bundle_id") and not h.get("adapter"):
        th = S["theme_index"][S["bundles"][ap["bundle_id"]]["theme_id"]]
        S["patterns"].append(_pattern(ap["title"], ", ".join(sorted({H.edit_layer(e) for e in edits})), aid,
                                      edits, None, th["key"], note="Promoted from production rollout"))
    audit("Rollout controller", "Promoted to production", hid, f"{old['version']} → {h['version']}")


# ---------------------------------------------------------------- evaluators
def evaluators(aid):
    out = []
    for e in S["evaluators"][aid]:
        v = {k: v for k, v in e.items() if k not in ("params",)}
        k = e.get("kappa")
        hist = e.get("history") or []
        declining = len(hist) >= 3 and hist[0] - hist[-1] > 0.05
        v["status"] = "Healthy" if k is None or k >= S["kappa_threshold"] else ("Drifting" if declining else "Below threshold")
        if v["status"] != "Healthy" and e["base_role"] == "Used as reward":
            v["role"] = "Optimization paused"
        else:
            v["role"] = e["base_role"]
        out.append(v)
    queue = labeling_queue(aid, 20)
    return {"items": out, "threshold": S["kappa_threshold"], "queue_total": queue["total"], "queue": queue["items"],
            "calibration": {"size": len(S["calibration"][aid]) + sum(1 for t in S["labels"] if S["traces"][t]["agent"] == aid),
                            "weekly": 100, "reserved": 0.2}}


def _refresh_kappas(aid):
    res = evaluator(aid, "resolution")
    res["kappa"] = calibration_kappa(aid)
    emp = evaluator(aid, "empathy")
    ids = S["calibration"][aid]
    emp["kappa"] = E.kappa([judges.empathy(S["eps"][i][0], emp["flip"])["pass"] for i in ids],
                           [judges.human_empathy(S["eps"][i][0]) for i in ids])
    pol = evaluator(aid, "policy")
    pol["kappa"] = E.kappa([judges.policy(S["eps"][i][0])["pass"] for i in ids],
                           [not S["eps"][i][0]["truth"]["violation"] for i in ids])


def recalibrate(aid, eid, actor="You"):
    e = evaluator(aid, eid)
    if eid == "empathy":
        e["flip"] = 0.05
    if eid == "resolution":
        e["params"]["miss"] = max(0.05, e["params"]["miss"] - 0.04)
    _refresh_kappas(aid)
    e["history"].append(round(e["kappa"], 3))
    e["history"] = e["history"][-8:]
    audit(actor, "Judge recalibrated", f"{aid}/{eid}", f"κ {e['kappa']:.2f}")
    return evaluators(aid)


def labeling_queue(aid, limit=20):
    items = [t for t in S["traces"].values() if t["agent"] == aid and t["id"] not in S["labels"]
             and (abs(t["judged_score"] - 0.75) < 0.2 or (t["judged_pass"] and (t["repeat"] or t["anomaly"])))]
    items.sort(key=lambda t: abs(t["judged_score"] - 0.75))
    return {"total": len(items), "items": items[:limit]}


# ------------------------------------------------------------------ patterns
def _pattern(name, layer, proven_on, edits, lift_text, theme_key, note=""):
    pid = next_id("pattern", "P-{}")
    matches = [a["id"] for a in AGENTS if a["id"] != proven_on and (
        theme_key in ("premature", "silent") or (theme_key == "eta" and a["id"] in ("billing",)))]
    return {"id": pid, "name": name, "layer": layer, "proven_on": proven_on, "edits": edits,
            "edit_labels": [H.edit_label(e) for e in edits], "lift": lift_text, "theme_key": theme_key,
            "matches": matches, "tests": {}, "note": note}


def patterns():
    return {"items": [{**{k: v for k, v in p.items() if k != "edits"},
                       "proven_on_name": agent(p["proven_on"])["name"],
                       "match_names": [agent(m)["name"] for m in p["matches"]]} for p in S["patterns"]],
            "stats": {"proven": len(S["patterns"]), "agents_using": len({p["proven_on"] for p in S["patterns"]} |
                                                                          {m for p in S["patterns"] for m, t in p["tests"].items() if t.get("lift", 0) > 0}),
                      "registered": len(AGENTS) + len(S.get("extra_agents", [])),
                      "open_matches": sum(len([m for m in p["matches"] if m not in p["tests"]]) for p in S["patterns"])}}


def test_pattern(pid, target, n=500, actor="You"):
    p = next(x for x in S["patterns"] if x["id"] == pid)
    a = agent(target)
    if not a.get("kind"):
        r = {"target": target, "status": "not_testable",
             "message": f"{a['name']} is {a['integration'].lower()}: no replayable harness. Export the pattern as a vendor change request or gateway overlay instead."}
    else:
        base = prod(target)
        edits = [e for e in p["edits"] if (e["op"] != "add_line" or a["kind"] in H.LINES[e["id"]]["agents"])
                 and (e["op"] != "gate_on" or a["kind"] in H.GATES[e["id"]]["agents"])
                 and not (e["op"] == "remove_line" and e["id"] not in base["lines"])]
        if not edits:
            r = {"target": target, "status": "not_applicable", "message": "None of the pattern's edits apply to this agent's harness."}
        else:
            cand = H.apply_edits(base, edits, hid=f"{target}-{pid}", name=f"{base['version']} + {p['name']}")
            cand["version"] = _next_version(target, draft=True)
            register(cand)
            cfg = judge_cfg(target)
            br, cr = E.run(base, range(40000, 40000 + n), cfg), E.run(cand, range(40000, 40000 + n), cfg)
            lift = E.compare(br, cr, "judged_pass")
            r = {"target": target, "status": "tested", "n": n, "lift": lift["diff"], "lo": lift["lo"], "hi": lift["hi"],
                 "harness_id": cand["id"], "message": f"Resolution {lift['diff'] * 100:+.1f} pts on {a['name']} (n={n})."}
    p["tests"][target] = r
    audit(actor, "Pattern tested", pid, r["message"])
    return r


# -------------------------------------------------------------------- agents
def agents_view():
    rows = []
    for a in AGENTS + S.get("extra_agents", []):
        rows.append({k: v for k, v in a.items() if k != "per_day"} | {
            "production": S["production"].get(a["id"]) and prod(a["id"])["version"],
            "traces": sum(1 for t in S["traces"].values() if t["agent"] == a["id"])})
    return {"items": rows, "levels": LEVELS, "capabilities": [{"name": n, "values": v} for n, v in CAPABILITIES]}


def register_agent(name, typ, level, owner, traffic, actor="You"):
    aid = "agent-" + str(len(S.setdefault("extra_agents", [])) + 1)
    integ = dict(LEVELS)[level]
    a = {"id": aid, "name": name, "type": typ, "integration": integ, "level": level, "owner": owner,
         "traffic": traffic, "kind": None}
    S["extra_agents"].append(a)
    audit(actor, "Agent registered", aid, f"{name} · {integ}")
    return agents_view()


# --------------------------------------------------------------------- views
RANGES = {"24h": 1, "7d": 7, "30d": 30, "90d": 90, "12m": 365}


def _window(ts, rng="7d", start=None, end=None):
    """Resolve a traffic window to (first_day, last_day), clipped to the days that have traces."""
    lo, hi = min((t["day"] for t in ts), default=0), max((t["day"] for t in ts), default=0)
    if rng == "custom" and start and end:
        a = (dt.date.fromisoformat(start) - START).days
        b = (dt.date.fromisoformat(end) - START).days
        if a > b:
            a, b = b, a
        return max(lo, a), min(hi, b)
    return max(lo, hi - RANGES.get(rng, 7) + 1), hi


def _window_label(rng, start, end, d0, d1):
    if rng == "custom" and start and end:  # show what was asked for, even if it has no traces
        d0, d1 = sorted(((dt.date.fromisoformat(start) - START).days, (dt.date.fromisoformat(end) - START).days))
    return day_label(d0) if d0 == d1 else f"{day_label(d0)} – {day_label(d1)}"


def overview(aid, rng="7d", start=None, end=None):
    all_ts = [t for t in S["traces"].values() if t["agent"] == aid]
    d0, d1 = _window(all_ts, rng, start, end)
    ts = [t for t in all_ts if d0 <= t["day"] <= d1]
    lo, hi = min((t["day"] for t in all_ts), default=0), max((t["day"] for t in all_ts), default=0)
    if d0 == d1:  # a single day: bucket by hour
        daily = []
        for hr in range(24):
            hh = [t for t in ts if int(t["time"][:2]) == hr]
            if hh:
                daily.append({"day": d0, "date": f"{hr:02d}:00", "rate": sum(t["flagged"] for t in hh) / len(hh), "n": len(hh),
                              "version": hh[0]["version"]})
        releases = []
    else:
        daily = []
        for d in range(d0, d1 + 1):
            dd = [t for t in ts if t["day"] == d]
            daily.append({"day": d, "date": day_label(d), "rate": sum(t["flagged"] for t in dd) / max(1, len(dd)), "n": len(dd),
                          "version": dd[0]["version"] if dd else None})
        releases = [{"day": h["released_day"] - d0, "version": h["version"]} for h in S["harnesses"].values()
                    if h["agent"] == aid and "released_day" in h and d0 < h["released_day"] <= d1]
    flagged = [t for t in ts if t["flagged"]]
    signals = [("LLM-judge evaluators (Galileo)", sum(not t["judged_pass"] for t in ts)),
               ("Repeat contact within 72h", sum(t["repeat"] for t in ts)),
               ("Tool-call errors and retries", sum(t["anomaly"] for t in ts)),
               ("Low CSAT (1–2)", sum(t["csat"] <= 2 for t in ts)),
               ("Human reviewer flags", sum(bool(t.get("human_flag")) for t in ts))]
    # themes re-counted on the window; ids match the stored themes so links and fix status carry over
    versions = {h["id"]: h for h in S["harnesses"].values() if h["agent"] == aid and "released_day" in h}
    win_themes = []
    for th in A.build_themes(aid, ts, versions) if ts else []:
        if th["id"] not in S["theme_index"]:
            continue
        th["first_seen"] = day_label(th["first_seen_day"])
        th["status"], th["fixes"] = _theme_status(th)
        # 7-day trend ending at the window's last day, looking back past the window if needed
        hits = Counter(t["day"] for t in all_ts if t["flagged"] and t["theme"] == th["key"])
        last7 = sum(hits[d] for d in range(d1 - 6, d1 + 1))
        prev7 = sum(hits[d] for d in range(d1 - 13, d1 - 6))
        th["trend"] = (last7 - prev7) / prev7 if prev7 else None
        win_themes.append(th)
    a = agent(aid)
    iso = lambda d: (START + dt.timedelta(days=int(d))).isoformat()
    return {"agent": {k: v for k, v in a.items() if k != "per_day"}, "production": H.public(prod(aid)) if a.get("kind") else None,
            "window": {"range": rng if rng in RANGES or rng == "custom" else "7d", "start": iso(d0), "end": iso(d1),
                       "days": max(0, d1 - d0 + 1), "label": _window_label(rng, start, end, d0, d1),
                       "min": iso(lo), "max": iso(hi), "available_days": hi - lo + 1},
            "kpis": {"traces": len(ts), "flagged": len(flagged), "flag_rate": len(flagged) / max(1, len(ts)),
                     "themes": len(win_themes),
                     "critical": sum(1 for t in win_themes if t["sev"] == "Critical"),
                     "waiting": approvals()["waiting"],
                     "repeat": sum(t["repeat"] for t in ts) / max(1, len(ts))},
            "daily": daily, "releases": releases, "signals": [{"label": l, "value": v} for l, v in signals],
            "themes": win_themes}


def lineage(obj):
    related = [r for r in S["audit"] if obj in r["obj"] or obj in r["detail"]]
    return related


# ---------------------------------------------------------------------- seed
def seed():
    with LOCK:
        S.clear()
        S.update(harnesses={}, production={}, traces={}, eps={}, themes={}, theme_index={}, bundles={},
                 bundle_by_theme={}, experiments={}, suites={}, suite_by_agent={}, approvals={}, patterns=[],
                 audit=[], labels={}, counters={"exp": 23, "cr": 1041, "bundle": 0, "pattern": 0}, evaluators={},
                 calibration={}, kappa_threshold=0.70, extra_agents=[], run_links={})
        base_lines = ["L_role", "L_identity", "L_credit_policy", "L_tone"]
        register(H.new_harness("billing-v13", "billing", "billing", "v13", "v13", base_lines, note="Previous production"), -30)
        register(H.new_harness("billing-v14", "billing", "billing", "v14 in production", "v14", base_lines + ["L_few_turns"],
                               parent="billing-v13", note="Added few-turns instruction"), 5)
        o_lines = ["L_role_outage", "L_identity", "L_credit_policy", "L_tone", "L_few_turns"]
        register(H.new_harness("outage-o-v7", "outage", "outage", "o-v7 in production", "o-v7", o_lines), -20)
        S["production"] = {"billing": "billing-v14", "outage": "outage-o-v7", "store": None, "tradein": None}
        for aid in ("billing", "outage"):
            S["evaluators"][aid] = [
                {"id": "resolution", "name": "Resolution judge v3", "type": "LLM judge", "base_role": "Used as reward",
                 "params": dict(judges.RES_DEFAULT), "criteria": list(H.BASE_CRITERIA), "history": []},
                {"id": "policy", "name": "Policy adherence v5", "type": "LLM judge + rules", "base_role": "Hard constraint", "history": []},
                {"id": "empathy", "name": "Empathy and tone v2", "type": "LLM judge", "base_role": "Used as reward",
                 "flip": 0.2, "history": []},
                {"id": "toolseq", "name": "Tool-sequence check", "type": "Deterministic", "base_role": "Used as reward", "kappa": None, "history": []},
                {"id": "repeat", "name": "Repeat contact 72h", "type": "Outcome signal", "base_role": "Final scoring only", "kappa": None, "history": []},
            ]
        audit("System", "Agent connected", "billing", "Repo + CI connected", when="2026-09-01 09:00")
        audit("System", "Agent connected", "outage", "Runtime config API", when="2026-09-01 09:05")
        audit("CX Digital", "Harness released", "billing-v14", "v13 → v14: added “Resolve the issue in as few turns as possible.”",
              when=f"2026-09-17 10:12")
        for aid in ("billing", "outage"):
            ts, eps = _gen_traces(aid)
            for t in ts:
                S["traces"][t["id"]] = t
            S["eps"].update(eps)
            S["calibration"][aid] = [t["id"] for t in ts][::2][:1240]
            _refresh_kappas(aid)
            # weekly agreement history: resolution stable, empathy drifting
            ids = S["calibration"][aid]
            for wk, flip in enumerate([0.06, 0.07, 0.09, 0.11, 0.14, 0.17, 0.2]):
                sub = ids[(wk * 97) % 400:(wk * 97) % 400 + 800]
                evaluator(aid, "empathy")["history"].append(round(E.kappa(
                    [judges.empathy(S["eps"][i][0], flip)["pass"] for i in ids],
                    [judges.human_empathy(S["eps"][i][0]) for i in ids]), 3))
                res = evaluator(aid, "resolution")
                res["history"].append(round(E.kappa([judges.resolution(S["eps"][i][0], res["criteria"], res["params"])["pass"] for i in sub],
                                                    [judges.human_label(S["eps"][i][0]) for i in sub]), 3))
                pol = evaluator(aid, "policy")
                pol["history"].append(round(pol["kappa"], 3))
            analyze(aid, actor="Analysis engine")
        # regression suites
        for aid, n in (("billing", 212), ("outage", 80)):
            sid = f"{aid}-agent-regression"
            S["suites"][sid] = {"id": sid, "agent": aid, "name": sid, "tests": _seed_suite(aid, n),
                                "gate": {"min_pass": 0.98, "policy_all": True, "gov_signoff": True},
                                "runs_in": "Galileo experiments and CI on every PR or config change", "last_run": None}
            S["suite_by_agent"][aid] = sid
        # fix bundles for the top themes
        generate_bundle("billing-premature", actor="Optimizer", n=600)
        b1 = S["bundle_by_theme"]["billing-premature"]
        if "outage-eta" in S["theme_index"]:
            generate_bundle("outage-eta", actor="Optimizer", n=400)
        if "billing-policy" in S["theme_index"]:
            generate_bundle("billing-policy", actor="Optimizer", n=400)
        # candidates for EXP-24: A = F-1, B = F-1 + F-2, C = B + RL adapter
        bb = S["bundles"][b1]
        A_id = bb["fixes"][0]["harness_id"]
        get_h(A_id)["name"] = "A: Prompt v15 (F-1)"
        B = H.apply_edits(get_h("billing-v14"), bb["fixes"][0]["edits"] + bb["fixes"][1]["edits"], hid="billing-B",
                          name="B: Prompt v15 + tool gate (F-1, F-2)", note="Harness-only bundle")
        B["version"] = "v15 (proposed)"
        register(B)

        class _Quiet:
            cancelled, progress, snapshot = False, 0, None

            def log(self, m):
                pass
        res = rl.train(_Quiet(), {"algorithm": "grpo", "iterations": 20, "batch": 10, "group": 4, "lr": 0.6,
                                  "kl_coef": 0.05, "reward_source": "judge", "seed": 3, "eval_every": 20, "n_eval": 100}, B,
                       judge_cfg("billing"))
        C = copy.deepcopy(B)
        C.update(id="billing-C", name="C: B + LoRA adapter (W-1)", adapter=res["adapter"], adapter_id="W-1",
                 parent="billing-B", note="GRPO on judge reward (RLAIF)")
        register(C)
        S["counters"]["adapter"] = 1
        exp = run_experiment("billing", ["billing-v14", A_id, "billing-B", "billing-C"], n=1200, seeds=1,
                             name="Billing dispute closure", theme_id="billing-premature", actor="Optimizer")
        exp["optimizer"] = {"explored": 38, "budget_used": 0.62}
        # approvals (4 waiting + history)
        bb["fixes"][1]["status"] = "Validated"
        ap = create_approval("billing", "billing-B", "Confirm before closing (F-1 + F-2)", bundle_id=b1,
                             fix_ids=["F-1", "F-2"], day_offset=2, actor="Optimizer")
        ap["approvers"][0].update(status="Approved", by="CX Digital (agent owner)", at="2026-09-24 11:20")
        if "outage-eta" in S["bundle_by_theme"]:
            ob = S["bundles"][S["bundle_by_theme"]["outage-eta"]]
            create_approval("outage", _fix_harness(ob, ob["fixes"][0])["id"], "Check outage status before stating an ETA",
                            bundle_id=ob["id"], fix_ids=["F-1"], day_offset=1, actor="Optimizer")
        if "billing-policy" in S["bundle_by_theme"]:
            pb = S["bundles"][S["bundle_by_theme"]["billing-policy"]]
            ap3 = create_approval("billing", _fix_harness(pb, pb["fixes"][0])["id"], "Block credits above $150 in the tool layer",
                                  bundle_id=pb["id"], fix_ids=["F-1"], day_offset=3, actor="Optimizer")
            ap3["approvers"][0].update(status="Approved", by="CX Digital (agent owner)", at="2026-09-23 15:02")
        create_approval("billing", "billing-C", "RL adapter W-1 on top of bundle B", day_offset=1, actor="RL trainer")
        for title, status, days in (("Handoff case summary (store)", "Live", 2), ("Concise answers for outage voice", "Rolled back", 1)):
            cid = next_id("cr", "CR-{}")
            S["approvals"][cid] = {"id": cid, "title": title, "agent": "outage", "agent_name": agent("outage")["name"],
                                   "base_id": "outage-o-v7", "harness_id": "outage-o-v7", "bundle_id": None, "fix_ids": [],
                                   "change_type": POLICY[0]["type"], "layers": ["Prompt"], "risk": "Low", "edit_labels": [],
                                   "rollout_plan": POLICY[0]["rollout"], "approvers": [{"role": "Agent owner", "status": "Approved",
                                                                                        "by": "Network Care", "at": "2026-09-10", "comment": ""}],
                                   "status": status, "created": "2026-09-08 10:00", "created_day": -4, "decided_days": days,
                                   "checks": {}, "rollout": None, "comments": []}
        # patterns
        S["patterns"] += [
            _pattern("Confirm before closing", "Prompt · Control flow", "billing",
                     [{"op": "add_line", "id": "L_confirm"}, {"op": "gate_on", "id": "G_verify_close"}], "+6.2 pts resolution", "premature"),
            _pattern("Verify before stating an ETA", "Tools", "outage", [{"op": "add_line", "id": "L_verify_eta"}],
                     "+3.8 pts containment", "eta"),
            _pattern("Handoff case summary", "Context & memory", "store", [], "−22% repeat questions", "premature"),
            _pattern("Concise-answer budget with exceptions", "Prompt", "billing",
                     [{"op": "remove_line", "id": "L_few_turns"}, {"op": "add_line", "id": "L_concise"}], "−9% handle time", "premature"),
        ]
        S["patterns"][1]["matches"] = ["billing"]
        audit("System", "Seed complete", "workspace", f"{len(S['traces'])} traces")


def reset():
    seed()
    return {"ok": True}
