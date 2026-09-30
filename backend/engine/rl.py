"""RL fine-tuning on AI feedback (RLAIF).

The trainable object is an adapter: additive weights on the agent's decision
logits — the simulator's analogue of a LoRA adapter on the policy model.

Algorithms
  grpo      group-relative advantages, (r - mean_group) / std_group, KL to reference
  reinforce policy gradient with a moving-average baseline, KL to reference
  dpo       pairs sampled per prompt, preferred by a pairwise AI judge (with optional
            position-bias swap), optimized with the DPO loss against the reference

Reward sources
  judge       AI judge score (RLAIF; carries the judge's verbosity bias)
  verifiable  backend end-state checks (RLVR-style; blind to open questions)
  gold        human-label oracle (for comparison only; not available in production)
"""
import copy
import math
import random

from . import env, judges, evaluate as E
from .config import get_settings


def _zero(kind):
    return {d: {a: 0.0 for a in acts} for d, acts in env.BASE.items()}


def _kl(p, q):
    return sum(p[a] * math.log(p[a] / q[a]) for a in p if p[a] > 0)


def train(job, P, base, cfg):
    S = get_settings()
    algo = P.get("algorithm", S.rl_algorithm)
    iters = int(P.get("iterations", S.rl_iterations))
    batch = int(P.get("batch", S.rl_batch))
    group = int(P.get("group", S.rl_group))
    lr = float(P.get("lr", S.rl_lr))
    kl_coef = float(P.get("kl_coef", S.rl_kl_coef))
    beta = float(P.get("beta", S.rl_beta))
    source, mode = P.get("reward_source", "judge"), P.get("policy_mode", "constraint")
    w = {**S.default_reward_weights, **P.get("weights", {})}
    swap, pos_bias = P.get("swap_positions", True), float(P.get("position_bias", 0.08))
    seed = int(P.get("seed", 1))
    eval_every = int(P.get("eval_every", S.rl_eval_every))
    n_eval = int(P.get("n_eval", S.rl_eval_n))
    rng = random.Random(seed)

    ref = copy.deepcopy(base)
    W = copy.deepcopy(base.get("adapter")) or _zero(base["kind"])
    for d, acts in env.BASE.items():
        W.setdefault(d, {a: 0.0 for a in acts})

    def with_w():
        h = copy.deepcopy(base)
        h["adapter"] = W
        return h

    def rec_of(ep):
        return E.summarize(ep, judges.evaluate_all(ep, cfg))

    def rew(r):
        return E.reward(r, w, mode, True, source)

    def heldout(h):
        recs = E.run(h, range(400000 + seed * 1000, 400000 + seed * 1000 + n_eval), cfg)
        return E.metrics(recs)

    before = env.policy_table(with_w())
    curve, held, running_b = [], [], None
    h0 = heldout(with_w())
    held.append({"it": 0, **h0})
    job.log(f"{algo.upper()} on {base['name']} · reward source: {source} · held-out judged {h0['resolution']:.1%}, gold {h0['gold']:.1%}")

    for it in range(1, iters + 1):
        if job.cancelled:
            job.log("Cancelled.")
            break
        h = with_w()
        grads = {d: {a: 0.0 for a in acts} for d, acts in W.items()}
        prompts = [500000 + seed * 100000 + it * batch + b for b in range(batch)]
        all_recs, agree, pairs = [], 0, 0
        if algo in ("grpo", "reinforce"):
            n_eps = 0
            for ps in prompts:
                eps_ = [env.run_episode(h, ps, ps * 37 + g + 1) for g in range(group)]
                recs = [rec_of(e) for e in eps_]
                rs = [rew(r) for r in recs]
                all_recs += recs
                if algo == "grpo":
                    mu = sum(rs) / len(rs)
                    sd = math.sqrt(sum((x - mu) ** 2 for x in rs) / len(rs)) + 1e-6
                    advs = [(x - mu) / sd for x in rs]
                else:
                    b = running_b if running_b is not None else sum(rs) / len(rs)
                    advs = [x - b for x in rs]
                    running_b = 0.9 * (running_b if running_b is not None else b) + 0.1 * (sum(rs) / len(rs))
                for ep, adv in zip(eps_, advs):
                    n_eps += 1
                    for dec in ep["decisions"]:
                        for a, pa in dec["p"].items():
                            grads[dec["d"]][a] += adv * ((1.0 if a == dec["a"] else 0.0) - pa)
            for d in grads:
                p, q = env.softmax(env.logits(h, d)), env.softmax(env.logits(ref, d))
                kl = _kl(p, q)
                for a in grads[d]:
                    g = grads[d][a] / max(1, n_eps) - kl_coef * p[a] * (math.log(p[a] / q[a]) - kl)
                    W[d][a] += lr * g
        else:  # DPO with a pairwise AI judge
            for ps in prompts:
                e1, e2 = env.run_episode(h, ps, ps * 37 + 1), env.run_episode(h, ps, ps * 37 + 2)
                r1, r2 = rec_of(e1), rec_of(e2)
                all_recs += [r1, r2]
                s1, s2 = rew(r1), rew(r2)
                if swap:  # judge both orders; keep only consistent verdicts
                    v1, v2 = (s1 + pos_bias > s2), (s1 > s2 + pos_bias)
                    if v1 != v2:
                        continue
                    first_wins = v1
                else:  # first position gets a bias bump
                    first_wins = s1 + pos_bias > s2
                if abs(s1 - s2) < 1e-9:
                    continue
                pairs += 1
                agree += int(first_wins == (r1["gold"] >= r2["gold"]))
                win, lose = (e1, e2) if first_wins else (e2, e1)

                def logratio(ep):
                    s = 0.0
                    for dec in ep["decisions"]:
                        p = env.softmax(env.logits(h, dec["d"]))
                        q = env.softmax(env.logits(ref, dec["d"]))
                        s += math.log(p[dec["a"]]) - math.log(q[dec["a"]])
                    return s
                z = beta * (logratio(win) - logratio(lose))
                coef = beta * (1.0 - 1.0 / (1.0 + math.exp(-z)))
                for ep, sign in ((win, 1.0), (lose, -1.0)):
                    for dec in ep["decisions"]:
                        p = env.softmax(env.logits(h, dec["d"]))
                        for a in p:
                            grads[dec["d"]][a] += sign * coef * ((1.0 if a == dec["a"] else 0.0) - p[a])
            for d in grads:
                for a in grads[d]:
                    W[d][a] += lr * grads[d][a] / max(1, pairs)
        h = with_w()
        m = E.metrics(all_recs)
        kl_avg = sum(_kl(env.softmax(env.logits(h, d)), env.softmax(env.logits(ref, d))) for d in env.BASE) / len(env.BASE)
        point = {"it": it, "reward": E.mean(rew(r) for r in all_recs), "judge": m["judge_score"],
                 "resolution": m["resolution"], "gold": m["gold"], "violations": m["violations"],
                 "tokens": m["tokens"], "detailed": m["detailed"], "kl": kl_avg}
        if algo == "dpo":
            point["pairs"], point["judge_gold_agreement"] = pairs, (agree / pairs if pairs else None)
        curve.append(point)
        if it % eval_every == 0 or it == iters:
            hm = heldout(h)
            held.append({"it": it, **hm})
            job.log(f"iter {it}: train reward {point['reward']:.3f}, KL {kl_avg:.3f} · held-out judged "
                    f"{hm['resolution']:.1%}, gold {hm['gold']:.1%}, detailed summaries {hm['detailed']:.0%}")
        job.progress = it / iters
        job.snapshot = {"curve": curve, "held": held}

    after = env.policy_table(with_w())
    table = [{"d": d, "label": env.DECISION_LABEL[d],
              "actions": [{"a": a, "label": env.ACTION_LABEL[a], "before": before[d][a], "after": after[d][a]}
                          for a in env.BASE[d]]}
             for d in env.BASE if (base["kind"] == "billing" and d != "D6") or (base["kind"] == "outage" and d in ("D1", "D2", "D6", "D7"))]
    first, last = held[0], held[-1]
    warn = None
    if (last["resolution"] - first["resolution"]) - (last["gold"] - first["gold"]) > 0.02 or last["detailed"] - first["detailed"] > 0.2:
        warn = ("Proxy and gold diverge: the adapter improved the judge's score more than the human-audited outcome "
                "(e.g. by learning verbose summaries the judge rewards). Treat as reward hacking.")
        job.log("⚠ " + warn)
    return {"adapter": W, "curve": curve, "held": held, "policy": table, "warning": warn}
