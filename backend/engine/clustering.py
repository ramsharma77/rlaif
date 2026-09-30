"""Semantic clustering utilities with local-first runtime and Anthropic fallback."""

from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from collections import Counter, defaultdict

from .config import get_settings
from .slm import probe_llama_server

_CACHE: dict[str, dict] = {}


def _cache_key(texts: list[str], top_k: int) -> str:
    h = hashlib.sha256()
    h.update(str(top_k).encode("utf-8"))
    for t in texts:
        h.update(b"\n")
        h.update(t.encode("utf-8", "ignore"))
    return h.hexdigest()


def _prompt(texts: list[str], top_k: int) -> str:
    lines = [f"{i + 1}. {t[:480]}" for i, t in enumerate(texts)]
    return (
        "Cluster the following telecom support failure snippets into semantic groups.\n"
        f"Return at most {top_k} cluster labels.\n"
        "Output strict JSON only in this schema:\n"
        '{"labels": ["..."], "assignments": [{"index": 1, "label": "..."}], "summary": "..."}\n\n'
        "Snippets:\n" + "\n".join(lines)
    )


def _parse_cluster_json(raw: str) -> dict:
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end < 0 or end <= start:
        raise ValueError("No JSON object found in model output")
    data = json.loads(raw[start : end + 1])
    labels = [str(x) for x in data.get("labels", []) if str(x).strip()]
    assignments = data.get("assignments", [])
    out = []
    for a in assignments:
        if not isinstance(a, dict):
            continue
        try:
            idx = int(a.get("index"))
        except (TypeError, ValueError):
            continue
        label = str(a.get("label", "")).strip() or "Unclassified"
        out.append({"index": idx, "label": label})
    return {"labels": labels, "assignments": out, "summary": str(data.get("summary", "")).strip()}


def _cluster_llama(texts: list[str], top_k: int) -> dict:
    s = get_settings()
    url = s.llama_server_url.rstrip("/") + "/v1/chat/completions"
    body = {
        "model": "local-qwen",
        "temperature": 0,
        "messages": [{"role": "user", "content": _prompt(texts, top_k)}],
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=s.llama_timeout_sec) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    content = data["choices"][0]["message"]["content"]
    parsed = _parse_cluster_json(content)
    parsed["provider"] = "llama_cpp_server"
    return parsed


def _cluster_anthropic(texts: list[str], top_k: int) -> dict:
    s = get_settings()
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured")
    body = {
        "model": s.anthropic_fallback_model,
        "max_tokens": 800,
        "messages": [{"role": "user", "content": _prompt(texts, top_k)}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        payload = json.loads(resp.read().decode("utf-8", "replace"))
    text = "".join(part.get("text", "") for part in payload.get("content", []) if part.get("type") == "text")
    parsed = _parse_cluster_json(text)
    parsed["provider"] = "anthropic"
    return parsed


def _cluster_lexical(texts: list[str]) -> dict:
    # Safe deterministic fallback when model providers are unavailable.
    buckets = defaultdict(list)
    for i, txt in enumerate(texts, start=1):
        key = " ".join((txt.lower().split()[:4] or ["unclassified"]))
        buckets[key].append(i)
    labels = list(buckets.keys())
    assignments = [{"index": idx, "label": key} for key, ids in buckets.items() for idx in ids]
    return {
        "provider": "lexical_fallback",
        "labels": labels,
        "assignments": assignments,
        "summary": "Deterministic lexical fallback used.",
    }


def cluster_texts(texts: list[str], top_k: int | None = None) -> dict:
    s = get_settings()
    cleaned = [t.strip() for t in texts if t and t.strip()]
    if len(cleaned) < 2:
        return {
            "provider": "none",
            "labels": ["Unclassified"],
            "assignments": [{"index": i + 1, "label": "Unclassified"} for i in range(len(cleaned))],
            "summary": "Not enough items for semantic clustering.",
        }

    k = int(top_k or s.semantic_top_k)
    if len(cleaned) > s.semantic_max_items:
        cleaned = cleaned[: s.semantic_max_items]

    key = _cache_key(cleaned, k)
    if key in _CACHE:
        return _CACHE[key]

    out = None
    errs = []
    if s.semantic_enabled:
        runtime = probe_llama_server()
        if runtime.get("ready"):
            try:
                out = _cluster_llama(cleaned, k)
            except Exception as ex:  # pragma: no cover - network/runtime dependent
                errs.append(f"llama_cpp_server failed: {type(ex).__name__}: {ex}")
        else:
            errs.append("llama_cpp_server unavailable")

        if out is None and s.semantic_fallback_enabled:
            try:
                out = _cluster_anthropic(cleaned, k)
            except Exception as ex:  # pragma: no cover - network/runtime dependent
                errs.append(f"anthropic fallback failed: {type(ex).__name__}: {ex}")

    if out is None:
        out = _cluster_lexical(cleaned)

    # normalize and fill missing assignments
    by_index = {a["index"]: a["label"] for a in out.get("assignments", [])}
    assignments = []
    for i in range(1, len(cleaned) + 1):
        assignments.append({"index": i, "label": by_index.get(i, "Unclassified")})

    counts = Counter(a["label"] for a in assignments)
    result = {
        "provider": out.get("provider", "unknown"),
        "summary": out.get("summary", ""),
        "labels": list(counts.keys()),
        "assignments": assignments,
        "clusters": [{"label": k1, "count": counts[k1]} for k1 in sorted(counts, key=counts.get, reverse=True)],
        "errors": errs,
    }
    _CACHE[key] = result
    return result
