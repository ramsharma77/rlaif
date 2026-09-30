"""Reflective harness optimizer.

GEPA / Meta-Harness-style black-box search over harness edits, scored by AI
judges (direct RLAIF-style reward, no gradients):

  seed -> reflect on failing minibatch traces -> propose an edit -> cheap
  minibatch filter -> full evaluation on the optimization split -> Pareto pool
  (per scenario bucket) -> occasional merge -> ... until the rollout budget is
  spent -> pick on a separate selection split (Holm-corrected) -> confirm once
  on a third split.
"""
import random
from collections import Counter

from . import evaluate as E, harness as H, analysis as A, llm, env
from .config import get_settings

SIG_LABEL = {"premature": "closed right after quote_credit with an open question or dispute",
             "dispute": "closed with the disputed charge unaddressed", "silent": "closed on a silent customer",
             "violation": "applied a credit above the policy limit", "eta": "stated an ETA without outage_status"}


def mutation_space(kind, enabled_dimensions=None):
    dims = set(enabled_dimensions or ["lines", "gates", "tools"])
    space = []
    if "lines" in dims:
        for lid, meta in H.LINES.items():
            if kind in meta.get("agents", []) and not meta.get("frozen") and lid not in ("L_role", "L_role_outage"):
                space += [{"op": "add_line", "id": lid}, {"op": "remove_line", "id": lid}]
    if "gates" in dims:
        for gid, meta in H.GATES.items():
            if kind in meta["agents"]:
                space += [{"op": "gate_on", "id": gid}, {"op": "gate_off", "id": gid}]
    if "tools" in dims:
        space += [{"op": "tool", "id": "close_ticket", "value": "strict"}, {"op": "tool", "id": "close_ticket", "value": "default"}]
    return space


def is_noop(h, e):
    op = e["op"]
    return ((op == "add_line" and e["id"] in h["lines"]) or (op == "remove_line" and e["id"] not in h["lines"])
            or (op == "gate_on" and e["id"] in h["gates"]) or (op == "gate_off" and e["id"] not in h["gates"])
            or (op == "tool" and h["tools"].get(e["id"]) == e["value"]))


def signatures(recs):
    c = Counter()
    for r in recs:
        if r["premature"]:
            c["premature"] += 1
        if r["dispute_unaddressed"]:
            c["dispute"] += 1
        if r["silent_close"]:
            c["silent"] += 1
        if r["violation"]:
            c["violation"] += 1
        if r["eta_unverified"]:
            c["eta"] += 1
    return c


def run(job, P, base, cfg, empathy_ok=True):
    S = get_settings()
    rng = random.Random(P.get("seed", 1))
    kind = base["kind"]
    budget, mb = int(P.get("budget", S.optimizer_budget)), int(P.get("minibatch", S.optimizer_minibatch))
    n_opt = int(P.get("n_opt", S.optimizer_n_opt))
    n_sel = int(P.get("n_sel", S.optimizer_n_sel))
    n_conf = int(P.get("n_conf", S.optimizer_n_conf))
    w = {**S.default_reward_weights, **P.get("weights", {})}
    mode = P.get("policy_mode", "constraint")
    eps = float(P.get("epsilon", S.optimizer_epsilon))
    do_merge = P.get("merge", True)
    use_llm = P.get("use_llm") and llm.available()
    sim_error = float(P.get("sim_error", 0.0))
    if w.get("empathy") and not empathy_ok:
        job.log("Empathy and tone judge is below the κ threshold — excluded from the reward for this run.")
    use_emp = empathy_ok
    off = 1000 * int(P.get("seed", 1))
    opt_seeds = list(range(100000 + off, 100000 + off + n_opt))
    sel_seeds = list(range(200000 + off, 200000 + off + n_sel))
    conf_seeds = list(range(300000 + off, 300000 + off + n_conf))
    rew = lambda r: E.reward(r, w, mode, use_emp)
    dims = P.get("dimensions") or S.optimizer_dimensions
    top_p_dims = int(P.get("top_p_dimensions", S.optimizer_top_p_dimensions))
    if top_p_dims > 0 and len(dims) > top_p_dims:
        dims = dims[:top_p_dims]
    space = mutation_space(kind, dims)

    def evaluate(h, seeds):
        return {r["seed"]: r for r in E.run(h, seeds, cfg, sim_error=sim_error)}

    def score(entry):
        recs = list(entry["recs"].values())
        entry["reward"] = E.mean(rew(r) for r in recs)
        entry["m"] = E.metrics(recs)
        b = {}
        for r in recs:
            b.setdefault(r["type"], []).append(rew(r))
        entry["buckets"] = {k: E.mean(v) for k, v in b.items()}

    pool, seen, rejected, used, gen = [], set(), [], 0, 0
    root = {"id": "c0", "h": base, "edits": [], "parent": None, "reflection": "Production harness (seed).", "gen": 0,
            "recs": evaluate(base, opt_seeds), "kind": "seed"}
    used += n_opt
    score(root)
    base_viol = root["m"]["violations"]
    pool.append(root)
    seen.add(H.fingerprint(base))
    job.log(f"Seed {base['version']}: reward {root['reward']:.3f}, judged resolution {root['m']['resolution']:.1%}, "
            f"policy violations {base_viol:.2%}.")

    def feasible(e):
        return mode != "constraint" or e["m"]["violations"] <= base_viol + 0.003

    def frontier():
        feas = [e for e in pool if feasible(e)]
        wins = Counter()
        for bucket in {k for e in feas for k in e["buckets"]}:
            best = max(feas, key=lambda e: e["buckets"].get(bucket, -9))
            wins[best["id"]] += 1
        best_all = max(feas, key=lambda e: e["reward"])
        wins[best_all["id"]] += 1
        return wins

    tried = {}
    while used + mb <= budget:
        if job.cancelled:
            job.log("Cancelled.")
            break
        wins = frontier()
        ids = list(wins)
        gen += 1
        merge_now = do_merge and len(ids) >= 2 and rng.random() < 0.2
        if merge_now:
            a, b = [next(e for e in pool if e["id"] == i) for i in rng.sample(ids, 2)]
            edits = a["edits"] + [e for e in b["edits"] if e not in a["edits"]]
            parent, new_edits = a, [e for e in b["edits"] if e not in a["edits"]]
            reflection = f"Merge {a['id']} + {b['id']}: combine complementary lessons from the Pareto frontier."
            if not new_edits:
                continue
        else:
            pid = rng.choices(ids, weights=[wins[i] for i in ids])[0]
            parent = next(e for e in pool if e["id"] == pid)
            mbs = rng.sample(opt_seeds, min(mb, len(opt_seeds)))
            fails = [parent["recs"][s] for s in mbs if not parent["recs"][s]["judged_pass"]
                     or parent["recs"][s]["anomaly"] or parent["recs"][s]["violation"]]
            sig = signatures(fails)
            proposal, reflection = None, ""
            if use_llm:
                try:
                    shown = [dict(r, ep=env.run_episode(parent["h"], r["seed"], r["samp"])) for r in fails[:5]]
                    proposal, reflection = llm.propose(parent["h"], shown, [e for e in space if not is_noop(parent["h"], e)])
                except Exception as ex:  # fall back to rule-based reflection
                    job.log(f"LLM proposer failed ({ex}); using rule-based reflection.")
            if proposal is None:
                done = tried.setdefault(parent["id"], [])
                if sig and rng.random() >= eps:
                    top, cnt = sig.most_common(1)[0]
                    opts = [e for e in A.REFLECTION_MAP[top] if not is_noop(parent["h"], e) and e not in done
                            and (e["op"] not in ("add_line",) or kind in H.LINES[e["id"]]["agents"])
                            and (e["op"] not in ("gate_on",) or kind in H.GATES[e["id"]]["agents"])]
                    if opts:
                        proposal = opts[0]
                        reflection = (f"{parent['id']} failed {len(fails)}/{len(mbs)} minibatch sessions; {cnt} "
                                      f"{SIG_LABEL[top]}. Proposal: {H.edit_label(proposal)}.")
                if proposal is None:
                    opts = [e for e in space if not is_noop(parent["h"], e) and e not in done]
                    if not opts:
                        continue
                    proposal = rng.choice(opts)
                    reflection = f"Exploration from {parent['id']}: {H.edit_label(proposal)}."
                done.append(proposal)
            new_edits = [proposal]
            edits = parent["edits"] + new_edits
        try:
            h = H.apply_edits(parent["h"], new_edits, hid=f"c{gen}", name=f"c{gen}")
        except ValueError as ex:
            job.log(f"Rejected: {ex}")
            continue
        fp = H.fingerprint(h)
        if fp in seen:
            continue
        seen.add(fp)
        mbs = rng.sample(opt_seeds, min(mb, len(opt_seeds)))
        child_mb = evaluate(h, mbs)
        used += len(mbs)
        pr, cr = E.mean(rew(parent["recs"][s]) for s in mbs), E.mean(rew(r) for r in child_mb.values())
        entry = {"id": f"c{gen}", "h": h, "edits": edits, "parent": parent["id"], "reflection": reflection,
                 "gen": gen, "kind": "merge" if merge_now else "mutation", "mb": {"parent": pr, "child": cr}}
        if cr < pr - 0.01:
            rejected.append({"id": entry["id"], "parent": parent["id"], "edits": [H.edit_label(e) for e in new_edits],
                             "reason": f"minibatch reward {cr:.3f} < parent {pr:.3f}", "reflection": reflection})
            job.log(f"✗ {entry['id']} rejected at minibatch ({cr:.3f} vs {pr:.3f}). {reflection}")
        else:
            rest = [s for s in opt_seeds if s not in child_mb]
            entry["recs"] = {**child_mb, **evaluate(h, rest)}
            used += len(rest)
            score(entry)
            pool.append(entry)
            job.log(f"✓ {entry['id']} reward {entry['reward']:.3f} (judged {entry['m']['resolution']:.1%}, "
                    f"tokens {entry['m']['tokens']:.0f}). {reflection}")
        job.progress = min(1.0, used / budget)
        job.snapshot = {"used": used, "budget": budget, "explored": len(pool) + len(rejected) - 1,
                        "pool": _pool_view(pool, frontier()), "rejected": rejected[-20:]}

    # ---------------- selection on a separate split, Holm-corrected
    wins = frontier()
    feas = sorted([e for e in pool if feasible(e) and e["id"] != "c0"], key=lambda e: -e["reward"])[:int(P.get("top_k", S.optimizer_top_k))]
    job.log(f"Search finished: {len(pool) + len(rejected) - 1} candidates explored, {used}/{budget} rollouts. "
            f"Selecting among top {len(feas)} on a fresh split (n={n_sel}).")
    base_sel = E.run(base, sel_seeds, cfg, sim_error=sim_error)
    sel = []
    for e in feas:
        recs = E.run(e["h"], sel_seeds, cfg, sim_error=sim_error)
        cmp = E.paired_bootstrap([rew(r) for r in base_sel], [rew(r) for r in recs], B=300)
        sel.append({"id": e["id"], "reward": E.mean(rew(r) for r in recs), "lift": cmp["diff"], "p": cmp["p"], "entry": e})
    adj = E.holm([s["p"] for s in sel]) if sel else []
    for s, a in zip(sel, adj):
        s["p_holm"] = a
    best = max(sel, key=lambda s: s["reward"]) if sel else None
    result = {"used": used, "budget": budget, "explored": len(pool) + len(rejected) - 1,
              "pool": _pool_view(pool, wins), "rejected": rejected,
              "selection": [{k: v for k, v in s.items() if k != "entry"} | {"edits": [H.edit_label(x) for x in s["entry"]["edits"]]} for s in sel],
              "best": None, "confirmation": None}
    if best and best["lift"] > 0:
        e = best["entry"]
        job.log(f"Confirming {e['id']} once on a third split (n={n_conf}).")
        b_conf = E.run(base, conf_seeds, cfg, sim_error=sim_error)
        c_conf = E.run(e["h"], conf_seeds, cfg, sim_error=sim_error)
        result["best"] = {"id": e["id"], "edits": e["edits"], "h": e["h"]}
        result["confirmation"] = {
            "n": n_conf, "base": E.metrics(b_conf), "cand": E.metrics(c_conf),
            "resolution": E.compare(b_conf, c_conf, "judged_pass"),
            "gold": E.compare(b_conf, c_conf, "gold"),
            "reward": E.paired_bootstrap([rew(r) for r in b_conf], [rew(r) for r in c_conf], B=300),
        }
        gap = result["confirmation"]["resolution"]["diff"] - result["confirmation"]["gold"]["diff"]
        job.log(f"Confirmed lift: judged {result['confirmation']['resolution']['diff']*100:+.1f} pts, "
                f"gold (human audit) {result['confirmation']['gold']['diff']*100:+.1f} pts"
                + (" — judge lift exceeds gold lift: check for reward hacking." if gap > 0.02 else "."))
    else:
        job.log("No candidate beat the baseline on the selection split.")
    return result


def _pool_view(pool, wins):
    return [{"id": e["id"], "parent": e["parent"], "gen": e["gen"], "kind": e["kind"],
             "edits": [H.edit_label(x) for x in e["edits"]], "layers": sorted({H.edit_layer(x) for x in e["edits"]}),
             "reward": round(e["reward"], 4), "resolution": e["m"]["resolution"], "gold": e["m"]["gold"],
             "violations": e["m"]["violations"], "tokens": e["m"]["tokens"], "detailed": e["m"]["detailed"],
             "frontier": e["id"] in wins, "reflection": e["reflection"]} for e in pool]
