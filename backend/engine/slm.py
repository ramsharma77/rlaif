"""Local SLM utilities for GGUF lifecycle and llama.cpp endpoint checks."""

from __future__ import annotations

import json
import os
import subprocess
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from .config import Settings, get_settings

_LLAMA_PROC: subprocess.Popen | None = None


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _abs_repo_model_dir(settings: Settings) -> Path:
    root = _repo_root()
    path = Path(settings.slm_repo_dir)
    return path if path.is_absolute() else root / path


def find_newest_qwen_gguf(settings: Settings | None = None) -> Path:
    cfg = settings or get_settings()
    src_root = Path(cfg.slm_source_dir)
    if not src_root.exists():
        raise FileNotFoundError(f"SLM source directory not found: {src_root}")

    pattern = cfg.slm_model_pattern or "qwen*.gguf"
    candidates = sorted(src_root.rglob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        # fallback catch-all in case the pattern is too narrow
        candidates = sorted([p for p in src_root.rglob("*.gguf") if "qwen" in p.name.lower()],
                            key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise FileNotFoundError(f"No Qwen GGUF model found under {src_root}")
    return candidates[0]


def ensure_repo_model_copy(settings: Settings | None = None) -> dict:
    cfg = settings or get_settings()
    src = find_newest_qwen_gguf(cfg)
    dst_dir = _abs_repo_model_dir(cfg)
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / src.name
    shutil.copy2(src, dst)
    return {
        "source": str(src),
        "copy": str(dst),
        "size_bytes": dst.stat().st_size,
    }


def _get_json(url: str, timeout_sec: int) -> tuple[bool, int | None, dict | list | None, str | None]:
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            body = resp.read().decode("utf-8", "replace")
            status = getattr(resp, "status", 200)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = None
        return True, int(status), data, None
    except urllib.error.HTTPError as ex:
        return False, int(ex.code), None, f"HTTPError: {ex.reason}"
    except urllib.error.URLError as ex:
        return False, None, None, f"URLError: {ex.reason}"
    except Exception as ex:  # pragma: no cover - safety
        return False, None, None, f"{type(ex).__name__}: {ex}"


def probe_llama_server(base_url: str | None = None, timeout_sec: int | None = None, settings: Settings | None = None) -> dict:
    cfg = settings or get_settings()
    root = (base_url or cfg.llama_server_url).rstrip("/")
    timeout = int(timeout_sec or cfg.llama_timeout_sec)

    checks = []
    for path in ("/health", "/v1/models"):
        ok, status, data, err = _get_json(root + path, timeout)
        checks.append({"path": path, "ok": ok, "status": status, "error": err, "data": data})

    models = []
    mcheck = next((c for c in checks if c["path"] == "/v1/models"), None)
    if mcheck and isinstance(mcheck.get("data"), dict):
        raw = mcheck["data"].get("data")
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict) and item.get("id"):
                    models.append(str(item["id"]))

    ready = any(c["ok"] for c in checks)
    return {
        "url": root,
        "ready": ready,
        "models": models,
        "checks": checks,
    }


def setup_local_slm(settings: Settings | None = None) -> dict:
    cfg = settings or get_settings()
    copy_info = ensure_repo_model_copy(cfg)
    runtime = probe_llama_server(settings=cfg)
    runtime["provider"] = "llama_cpp_server" if runtime["ready"] else "not_ready"
    return {
        "copy": copy_info,
        "runtime": runtime,
        "fallback": {
            "provider": "anthropic",
            "model": cfg.anthropic_fallback_model,
            "when": "only when local GGUF clustering is unavailable or fails",
        },
    }


def _default_server_candidates(cfg: Settings) -> list[Path]:
    root = Path(cfg.slm_source_dir)
    names = ["llama-server.exe", "llama-server", "server.exe"]
    out: list[Path] = []
    for n in names:
        out.extend(root.rglob(n))
    # Only keep likely llama.cpp binaries.
    return [p for p in out if "llama" in str(p).lower()]


def find_llama_server_executable(settings: Settings | None = None) -> Path | None:
    cfg = settings or get_settings()
    if cfg.llama_server_executable:
        p = Path(cfg.llama_server_executable)
        if p.exists():
            return p
    candidates = _default_server_candidates(cfg)
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def _parse_host_port(url: str) -> tuple[str, int]:
    u = urlparse(url)
    host = u.hostname or "127.0.0.1"
    port = u.port or (443 if u.scheme == "https" else 80)
    return host, int(port)


def launch_llama_server(settings: Settings | None = None) -> dict:
    global _LLAMA_PROC
    cfg = settings or get_settings()
    if _LLAMA_PROC and _LLAMA_PROC.poll() is None:
        return {"started": False, "already_running": True, "pid": _LLAMA_PROC.pid, "probe": probe_llama_server(settings=cfg)}

    exe = find_llama_server_executable(cfg)
    if exe is None:
        return {
            "started": False,
            "error": "llama.cpp server executable not found",
            "probe": probe_llama_server(settings=cfg),
        }

    copy_info = ensure_repo_model_copy(cfg)
    host, port = _parse_host_port(cfg.llama_server_url)
    cmd = [
        str(exe),
        "-m",
        copy_info["copy"],
        "--host",
        host,
        "--port",
        str(port),
        "-t",
        str(cfg.llama_server_threads),
        "-c",
        str(cfg.llama_server_ctx_size),
    ]
    if cfg.llama_server_gpu_layers != 0:
        cmd.extend(["-ngl", str(cfg.llama_server_gpu_layers)])

    log_dir = _repo_root() / "var" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    out_path = log_dir / "llama_server.log"
    fp = out_path.open("a", encoding="utf-8")
    _LLAMA_PROC = subprocess.Popen(
        cmd,
        cwd=str(exe.parent),
        stdout=fp,
        stderr=subprocess.STDOUT,
        creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
    )
    probe = probe_llama_server(settings=cfg)
    return {
        "started": True,
        "pid": _LLAMA_PROC.pid,
        "command": cmd,
        "log": str(out_path),
        "copy": copy_info,
        "probe": probe,
    }


def llama_status(settings: Settings | None = None) -> dict:
    cfg = settings or get_settings()
    running = bool(_LLAMA_PROC and _LLAMA_PROC.poll() is None)
    return {
        "managed_running": running,
        "pid": (_LLAMA_PROC.pid if running else None),
        "probe": probe_llama_server(settings=cfg),
    }


def stop_llama_server(settings: Settings | None = None) -> dict:
    global _LLAMA_PROC
    running = bool(_LLAMA_PROC and _LLAMA_PROC.poll() is None)
    if running:
        _LLAMA_PROC.terminate()
    stopped = False
    if _LLAMA_PROC:
        try:
            _LLAMA_PROC.wait(timeout=5)
            stopped = True
        except Exception:
            _LLAMA_PROC.kill()
            _LLAMA_PROC.wait(timeout=5)
            stopped = True
    _LLAMA_PROC = None
    return {"stopped": stopped, "probe": probe_llama_server(settings=settings or get_settings())}
