"""Centralized runtime configuration for ingestion, optimization, RL, and semantic clustering.

All behavior toggles and tunables are controlled from environment variables so the
owner can tune the plane without code changes.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


def _as_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _as_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _as_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _as_list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if raw is None:
        return list(default)
    txt = raw.strip()
    if not txt:
        return []
    if txt.startswith("["):
        try:
            vals = json.loads(txt)
            if isinstance(vals, list):
                return [str(v).strip() for v in vals if str(v).strip()]
        except json.JSONDecodeError:
            pass
    return [p.strip() for p in txt.replace(";", ",").split(",") if p.strip()]


def _as_json_dict(name: str, default: dict[str, float]) -> dict[str, float]:
    raw = os.environ.get(name)
    if raw is None:
        return dict(default)
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            out: dict[str, float] = {}
            for k, v in data.items():
                try:
                    out[str(k)] = float(v)
                except (TypeError, ValueError):
                    continue
            return out or dict(default)
    except json.JSONDecodeError:
        pass
    return dict(default)


@dataclass(frozen=True)
class Settings:
    sqlite_path: str
    approval_owner_name: str

    # ingestion
    trace_file_paths: list[str]
    ingest_line_max_bytes: int
    ingest_trace_soft_max_bytes: int
    ingest_quarantine_dir: str

    # semantic clustering
    semantic_enabled: bool
    semantic_runtime: str
    semantic_fallback_enabled: bool
    semantic_max_items: int
    semantic_top_k: int

    # model runtime
    slm_source_dir: str
    slm_repo_dir: str
    slm_model_pattern: str
    llama_server_url: str
    llama_timeout_sec: int
    llama_server_executable: str
    llama_server_threads: int
    llama_server_ctx_size: int
    llama_server_gpu_layers: int
    anthropic_fallback_model: str

    # optimizer
    optimizer_budget: int
    optimizer_minibatch: int
    optimizer_n_opt: int
    optimizer_n_sel: int
    optimizer_n_conf: int
    optimizer_top_k: int
    optimizer_epsilon: float
    optimizer_dimensions: list[str]
    optimizer_top_p_dimensions: int
    default_reward_weights: dict[str, float]

    # RL
    rl_algorithm: str
    rl_iterations: int
    rl_batch: int
    rl_group: int
    rl_lr: float
    rl_kl_coef: float
    rl_beta: float
    rl_eval_every: int
    rl_eval_n: int

    # business-facing configurable KPIs
    business_kpis: list[str]


_DEFAULT_WEIGHTS = {
    "resolution": 1.0,
    "tokens": 0.15,
    "latency": 0.05,
    "empathy": 0.0,
    "policy": 2.0,
}


def _default_trace_paths() -> list[str]:
    root = Path(__file__).resolve().parents[2]
    return [
        str(root.parent / "Verizon_ivr_agent" / "traces_real_PROD export on 91426 at 50157 PM CDT.jsonl"),
        str(root.parent / "Verizon_ivr_agent" / "traces_PROD export on 92426 at 102050 PM CDT.jsonl"),
    ]


def load_settings() -> Settings:
    traces = _as_list("HOE_TRACE_FILE_PATHS", _default_trace_paths())
    return Settings(
        sqlite_path=os.environ.get("HOE_SQLITE_PATH", "var/rlaif.db"),
        approval_owner_name=os.environ.get("HOE_APPROVAL_OWNER_NAME", "Ram Sharma"),
        trace_file_paths=traces,
        ingest_line_max_bytes=_as_int("HOE_INGEST_LINE_MAX_BYTES", 1572864),
        ingest_trace_soft_max_bytes=_as_int("HOE_INGEST_TRACE_SOFT_MAX_BYTES", 512000),
        ingest_quarantine_dir=os.environ.get("HOE_INGEST_QUARANTINE_DIR", "var/quarantine"),
        semantic_enabled=_as_bool("HOE_SEMANTIC_ENABLED", True),
        semantic_runtime=os.environ.get("HOE_SEMANTIC_RUNTIME", "llama_cpp_server"),
        semantic_fallback_enabled=_as_bool("HOE_SEMANTIC_FALLBACK_ENABLED", True),
        semantic_max_items=_as_int("HOE_SEMANTIC_MAX_ITEMS", 80),
        semantic_top_k=_as_int("HOE_SEMANTIC_TOP_K", 6),
        slm_source_dir=os.environ.get("HOE_SLM_SOURCE_DIR", "C:/projects/proposal/Verizon/SLM"),
        slm_repo_dir=os.environ.get("HOE_SLM_REPO_DIR", "models/gguf"),
        slm_model_pattern=os.environ.get("HOE_SLM_MODEL_PATTERN", "qwen*.gguf"),
        llama_server_url=os.environ.get("HOE_LLAMA_SERVER_URL", "http://127.0.0.1:8080"),
        llama_timeout_sec=_as_int("HOE_LLAMA_TIMEOUT_SEC", 20),
        llama_server_executable=os.environ.get("HOE_LLAMA_SERVER_EXECUTABLE", ""),
        llama_server_threads=_as_int("HOE_LLAMA_SERVER_THREADS", 8),
        llama_server_ctx_size=_as_int("HOE_LLAMA_SERVER_CTX_SIZE", 4096),
        llama_server_gpu_layers=_as_int("HOE_LLAMA_SERVER_GPU_LAYERS", 0),
        anthropic_fallback_model=os.environ.get("HOE_ANTHROPIC_FALLBACK_MODEL", "claude-3-5-haiku-latest"),
        optimizer_budget=_as_int("HOE_OPT_BUDGET", 6000),
        optimizer_minibatch=_as_int("HOE_OPT_MINIBATCH", 40),
        optimizer_n_opt=_as_int("HOE_OPT_N_OPT", 200),
        optimizer_n_sel=_as_int("HOE_OPT_N_SEL", 300),
        optimizer_n_conf=_as_int("HOE_OPT_N_CONF", 600),
        optimizer_top_k=_as_int("HOE_OPT_TOP_K", 3),
        optimizer_epsilon=_as_float("HOE_OPT_EPSILON", 0.2),
        optimizer_dimensions=_as_list("HOE_OPT_DIMENSIONS", ["lines", "gates", "tools"]),
        optimizer_top_p_dimensions=_as_int("HOE_OPT_TOP_P_DIMENSIONS", 3),
        default_reward_weights=_as_json_dict("HOE_DEFAULT_REWARD_WEIGHTS", _DEFAULT_WEIGHTS),
        rl_algorithm=os.environ.get("HOE_RL_ALGORITHM", "grpo"),
        rl_iterations=_as_int("HOE_RL_ITERATIONS", 30),
        rl_batch=_as_int("HOE_RL_BATCH", 12),
        rl_group=_as_int("HOE_RL_GROUP", 4),
        rl_lr=_as_float("HOE_RL_LR", 0.5),
        rl_kl_coef=_as_float("HOE_RL_KL_COEF", 0.05),
        rl_beta=_as_float("HOE_RL_BETA", 0.5),
        rl_eval_every=_as_int("HOE_RL_EVAL_EVERY", 5),
        rl_eval_n=_as_int("HOE_RL_EVAL_N", 200),
        business_kpis=_as_list(
            "HOE_BUSINESS_KPIS",
            [
                "failure_rate_by_bucket",
                "retry_escalation_rate",
                "policy_violation_incidence",
                "cost_per_eval_run",
                "trace_p95_latency",
                "precision_recall_f1",
            ],
        ),
    )


_SETTINGS = load_settings()


def get_settings(refresh: bool = False) -> Settings:
    global _SETTINGS
    if refresh:
        _SETTINGS = load_settings()
    return _SETTINGS


def public_settings(refresh: bool = False) -> dict[str, Any]:
    s = asdict(get_settings(refresh=refresh))
    # keep secrets out; this module does not hold raw keys, but keep a fixed contract here
    return s
