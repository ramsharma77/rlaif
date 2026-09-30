"""Failure-theme clustering, root-cause hypotheses and the fix library.

Flagged traces are assigned to themes by observable failure signatures (the
production equivalent is embedding + LLM clustering). Root cause is found by
correlating each theme's rate with harness version changes.
"""
from collections import Counter, defaultdict

from .harness import LINES
from .env import SCENARIO_LABEL
from . import clustering

THEMES = [
    {"key": "policy", "name": "Credit above policy limit issued", "layer": "Guardrail",
     "desc": "Agent applies a credit above the $150 limit without supervisor approval.",
     "match": lambda r: r["violation"]},
    {"key": "premature", "name": "Premature closure on billing disputes", "layer": "Prompt · Control flow",
     "desc": "Agent closes the ticket after quoting a credit, before the customer confirms the dispute is resolved.",
     "match": lambda r: r["premature"]},
    {"key": "silent", "name": "Session closed on a silent customer", "layer": "Prompt",
     "desc": "Agent closes after a single idle period instead of re-prompting.",
     "match": lambda r: r["silent_close"]},
    {"key": "eta", "name": "Unverified outage ETA stated", "layer": "Tools · Control flow",
     "desc": "Agent states a restoration time without checking the outage status tool.",
     "match": lambda r: r["eta_unverified"]},
    {"key": "other", "name": "Flagged with no clear pattern", "layer": "—",
     "desc": "Flagged by a judge or outcome signal with no shared failure signature (includes judge false positives).",
     "match": lambda r: True},
]
THEME_BY_KEY = {t["key"]: t for t in THEMES}

# fixes the reflective proposer knows for each theme: (title, layer, edits)
FIX_LIBRARY = {
    "premature": [
        ("Require customer confirmation before closing a dispute", [{"op": "add_line", "id": "L_confirm"}]),
        ("Gate close_ticket behind a verify_resolution check", [{"op": "gate_on", "id": "G_verify_close"}]),
        ("Add “confirmed resolution” criterion to the resolution judge", [{"op": "add_criterion", "id": "confirmed_resolution"}]),
        ("Replace “few turns” with a concise-answer budget", [{"op": "remove_line", "id": "L_few_turns"},
                                                              {"op": "add_line", "id": "L_concise"}]),
        ("Ask which charge when more than one could match", [{"op": "add_line", "id": "L_clarify_charge"}]),
    ],
    "silent": [("Prompt twice before closing on a silent customer", [{"op": "add_line", "id": "L_silence"}])],
    "policy": [("Block credits above $150 without supervisor approval", [{"op": "gate_on", "id": "G_credit_limit"}])],
    "eta": [("Check outage status before stating a restoration time", [{"op": "add_line", "id": "L_verify_eta"}]),
            ("Gate ETA statements behind outage_status", [{"op": "gate_on", "id": "G_eta_status"}])],
    "other": [],
}

# signature -> candidate edits, used by the optimizer's rule-based reflection
REFLECTION_MAP = {
    "premature": [{"op": "add_line", "id": "L_confirm"}, {"op": "gate_on", "id": "G_verify_close"},
                  {"op": "add_line", "id": "L_answer_open"}, {"op": "remove_line", "id": "L_few_turns"},
                  {"op": "tool", "id": "close_ticket", "value": "strict"}],
    "dispute": [{"op": "add_line", "id": "L_clarify_charge"}],
    "silent": [{"op": "add_line", "id": "L_silence"}, {"op": "remove_line", "id": "L_few_turns"}],
    "violation": [{"op": "gate_on", "id": "G_credit_limit"}],
    "eta": [{"op": "add_line", "id": "L_verify_eta"}, {"op": "gate_on", "id": "G_eta_status"}],
}


def is_flagged(t):
    return (not t["judged_pass"]) or t["violation"] or t["repeat"] or t["anomaly"] or t["csat"] <= 2 or t.get("human_flag")


def theme_of(t):
    for th in THEMES:
        if th["match"](t):
            return th["key"]
    return "other"


def theme_name(key, kind):
    if key == "premature" and kind == "outage":
        return "Premature closure after outage questions"
    return THEME_BY_KEY[key]["name"]


def build_themes(agent, traces, versions):
    """traces: trace summaries for one agent; versions: {harness_id: harness} with release day."""
    flagged = [t for t in traces if t["flagged"]]
    if not traces:
        return []
    last_day = max(t["day"] for t in traces)
    repeat_base = sum(t["repeat"] for t in traces) / len(traces)
    by_theme = defaultdict(list)
    for t in flagged:
        by_theme[t["theme"]].append(t)
    out = []
    for key, items in by_theme.items():
        kind = items[0]["kind"]
        last7 = sum(1 for t in items if t["day"] > last_day - 7)
        prev7 = sum(1 for t in items if last_day - 14 < t["day"] <= last_day - 7)
        daily = Counter(t["day"] for t in items)
        recent_avg = last7 / 7 if last7 else 0
        first_seen = last_day
        while first_seen > 0 and daily.get(first_seen - 1, 0) >= 0.6 * recent_avg:
            first_seen -= 1
        share = len(items) / max(1, len(flagged))
        repeat = sum(t["repeat"] for t in items) / len(items)
        csat = sum(t["csat"] for t in items) / len(items)
        sev = "Critical" if share > 0.2 or (repeat > 0.35 and len(items) > 50) else ("High" if share > 0.08 else "Medium")
        if key == "policy":
            sev = "Critical" if len(items) > 5 else "High"
        if key == "other":
            sev = "Low"
        subs = Counter(t["type"] for t in items)
        subclusters = [{"label": SCENARIO_LABEL.get(k, k), "share": v / len(items)} for k, v in subs.most_common()]
        semantic = None
        if key == "other":
            snippets = [t.get("snippet") or t.get("label") or t["type"] for t in items]
            semantic = clustering.cluster_texts(snippets)
            total = max(1, len(semantic.get("assignments", [])))
            subclusters = [{"label": c["label"], "share": c["count"] / total}
                           for c in semantic.get("clusters", [])]
        out.append({
            "id": f"{agent}-{key}", "key": key, "agent": agent, "name": theme_name(key, kind),
            "desc": THEME_BY_KEY[key]["desc"], "layer": THEME_BY_KEY[key]["layer"], "sev": sev,
            "traces": len(items), "share": share, "trend": (last7 - prev7) / prev7 if prev7 else (1.0 if last7 else 0.0),
            "repeat_rate": repeat, "repeat_base": repeat_base, "csat": csat, "first_seen_day": first_seen,
            "daily": [daily.get(d, 0) for d in range(last_day + 1)],
            "subclusters": subclusters,
            "semantic": semantic,
            "root_cause": root_cause(key, items, traces, versions),
        })
    order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    out.sort(key=lambda t: (order[t["sev"]], -t["traces"]))
    return out


def root_cause(key, items, traces, versions):
    if key == "other":
        return {"text": "No shared signature. Review a sample in the labeling queue: some may be judge false positives.",
                "confidence": 0.3, "change": None, "layers": []}
    by_ver_total, by_ver_theme = Counter(t["harness"] for t in traces), Counter(t["harness"] for t in items)
    rates = {v: by_ver_theme[v] / by_ver_total[v] for v in by_ver_total}
    ordered = sorted(rates, key=lambda v: versions[v]["released_day"])
    change, best = None, 0.0
    for prev, cur in zip(ordered, ordered[1:]):
        jump = rates[cur] - rates[prev]
        if jump > best:
            best, change = jump, (prev, cur)
    text, layers, conf = "", [THEME_BY_KEY[key]["layer"]], 0.55
    if key == "premature":
        pct = round(100 * sum(1 for t in items if t.get("close_right_after_quote")) / len(items))
        text = (f"In {pct}% of affected traces the agent calls close_ticket within one turn of quote_credit, "
                f"without a confirmation turn.")
    elif key == "silent":
        text = "Agent closes after one idle period; re-prompting would have recovered most sessions."
    elif key == "policy":
        text = "The frozen credit-policy line is followed most of the time, but nothing enforces it in the tool layer."
    elif key == "eta":
        text = "Restoration times are stated from memory; the outage_status tool is not called first."
    if change:
        a, b = versions[change[0]], versions[change[1]]
        added = [LINES[l]["text"] for l in b["lines"] if l not in a["lines"]]
        conf = max(0.35, min(0.95, 0.5 + best / max(rates[change[1]], 1e-6) * 0.45))
        text += (f" The pattern starts with {b['version']} (day {b['released_day']})"
                 + (f", which added “{added[0]}”" if added else "") +
                 f". Rate rose from {rates[change[0]]:.1%} of traces on {a['version']} to {rates[change[1]]:.1%}.")
    return {"text": text.strip(), "confidence": round(conf, 2),
            "change": {"from": change[0], "to": change[1]} if change else None, "layers": layers}
