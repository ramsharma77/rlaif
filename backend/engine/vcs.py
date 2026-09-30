"""GitHub delivery for first-party agents: branch, commits and a pull request.

Live mode needs GITHUB_TOKEN (a token with contents + pull-request write access to
HOE_GITHUB_REPO). Without it every call is a dry run that returns the same links and
the git/gh commands to do it by hand, so a public demo can never write to the repo.

Env: HOE_GITHUB_REPO (owner/name), HOE_GITHUB_BASE (base branch), HOE_GITHUB_PATH
(folder for agent harness files, "{agent}" is substituted), HOE_GITHUB_API (API root).
"""
import base64
import datetime as dt
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = os.environ.get("HOE_GITHUB_REPO", "ramsharma77/rlaif")
BASE = os.environ.get("HOE_GITHUB_BASE", "main")
PATH = os.environ.get("HOE_GITHUB_PATH", "agents/{agent}")
API = os.environ.get("HOE_GITHUB_API", "https://api.github.com").rstrip("/")
WEB = "https://github.com"


def live():
    return bool(os.environ.get("GITHUB_TOKEN"))


# ------------------------------------------------------------------ links
def repo_url():
    return f"{WEB}/{REPO}"


def branch_url(branch):
    return f"{repo_url()}/tree/{urllib.parse.quote(branch, safe='/')}"


def commit_url(sha):
    return f"{repo_url()}/commit/{sha}"


def pr_url(number):
    return f"{repo_url()}/pull/{number}"


def pulls_url():
    return f"{repo_url()}/pulls"


def compare_url(branch):
    return f"{repo_url()}/compare/{BASE}...{urllib.parse.quote(branch, safe='/')}?expand=1"


def file_url(path, ref=None):
    return f"{repo_url()}/blob/{urllib.parse.quote(ref or BASE, safe='/')}/{path}"


def agent_path(agent):
    return PATH.format(agent=agent)


def status():
    return {"repo": REPO, "url": repo_url(), "base": BASE, "live": live(), "pulls_url": pulls_url()}


# ------------------------------------------------------------------ REST client
class GitHubError(RuntimeError):
    pass


def _call(method, path, body=None, ok_missing=False):
    req = urllib.request.Request(
        f"{API}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "harness-optimization-engine",
                 **({"Content-Type": "application/json"} if body is not None else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if ok_missing and e.code == 404:
            return None
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("message", detail)
        except ValueError:
            pass
        raise GitHubError(f"GitHub {method} {path} failed ({e.code}): {detail}") from None
    except urllib.error.URLError as e:
        raise GitHubError(f"GitHub unreachable: {e.reason}") from None


def _ensure_branch(branch):
    q = urllib.parse.quote(branch, safe="")
    if _call("GET", f"/repos/{REPO}/git/ref/heads/{q}", ok_missing=True):
        return False
    base = _call("GET", f"/repos/{REPO}/git/ref/heads/{urllib.parse.quote(BASE, safe='')}")
    _call("POST", f"/repos/{REPO}/git/refs", {"ref": f"refs/heads/{branch}", "sha": base["object"]["sha"]})
    return True


def _put_file(branch, path, content, message):
    """Create or update one file on the branch; returns the commit sha, or None if unchanged."""
    q = urllib.parse.quote(path)
    cur = _call("GET", f"/repos/{REPO}/contents/{q}?ref={urllib.parse.quote(branch, safe='')}", ok_missing=True)
    encoded = base64.b64encode(content.encode()).decode()
    if cur and cur.get("content", "").replace("\n", "") == encoded:
        return None
    body = {"message": message, "content": encoded, "branch": branch}
    if cur:
        body["sha"] = cur["sha"]
    return _call("PUT", f"/repos/{REPO}/contents/{q}", body)["commit"]["sha"]


def _find_pr(branch):
    owner = REPO.split("/")[0]
    hits = _call("GET", f"/repos/{REPO}/pulls?state=open&head={urllib.parse.quote(f'{owner}:{branch}')}")
    return hits[0] if hits else None


# ------------------------------------------------------------------ pull request
def open_pr(branch, title, body, commits, baseline=None):
    """commits: [(message, {path: content}), ...] applied in order on `branch`, then a PR to BASE.
    baseline: an optional (message, files) committed first, only when the branch is new, so the
    fix commit shows the exact change. Re-running on an up-to-date branch makes no commits.
    Returns links plus, in live mode, the PR number and the commits that were made."""
    everything = ([baseline] if baseline else []) + list(commits)
    out = {"repo": REPO, "repo_url": repo_url(), "base": BASE, "branch": branch, "branch_url": branch_url(branch),
           "compare_url": compare_url(branch), "live": live(),
           "files": sorted({p for _, files in everything for p in files}),
           "file_urls": {p: file_url(p, branch) for _, files in everything for p in files}}
    if not live():
        out["commands"] = _manual_commands(branch, title, everything)
        out["note"] = "Dry run: set GITHUB_TOKEN on the server to create the branch, commits and pull request."
        return out
    created = _ensure_branch(branch)
    made = []
    for message, files in ([baseline] if baseline and created else []) + list(commits):
        for path, content in files.items():
            sha = _put_file(branch, path, content, message)
            if sha:
                made.append({"sha": sha, "short": sha[:7], "message": message, "url": commit_url(sha)})
    pr = _find_pr(branch)
    reused = bool(pr)
    if not pr:
        pr = _call("POST", f"/repos/{REPO}/pulls", {"title": title, "head": branch, "base": BASE, "body": body})
    out.update(branch_created=created, commits=made, pr_number=pr["number"], pr_url=pr["html_url"], pr_reused=reused)
    return out


# ------------------------------------------------------------------ read side: repo state for the UI
# Reads work without a token (public repo). Responses are cached and re-validated with ETags:
# a 304 does not count against GitHub's rate limit, so polling every few seconds stays cheap.
ROOT = Path(__file__).resolve().parents[2]
CODE_SCOPE = ("backend/", "frontend/", "requirements.txt")   # what a deployment actually runs
IGNORE_DIRS = {"__pycache__", ".git", ".venv", "venv", ".azure", "antenv", "node_modules"}
IGNORE_FILES = {".env", ".DS_Store"}
FRESH_S = 15          # serve from cache without asking GitHub for this long
_CACHE, _CACHE_LOCK, _RATE = {}, threading.Lock(), {}


def invalidate():
    with _CACHE_LOCK:
        for v in _CACHE.values():
            v["at"] = 0


def _get(path, force=False):
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(path)
        if hit and not force and now - hit["at"] < FRESH_S:
            return hit["data"]
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "harness-optimization-engine"}
    if _read_token():
        headers["Authorization"] = f"Bearer {_read_token()}"
    if hit and hit.get("etag"):
        headers["If-None-Match"] = hit["etag"]
    req = urllib.request.Request(f"{API}{path}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read() or b"null")
            _note_rate(r.headers)
            etag = r.headers.get("ETag")
    except urllib.error.HTTPError as e:
        _note_rate(e.headers)
        if e.code == 304 and hit:
            with _CACHE_LOCK:
                hit["at"] = now
            return hit["data"]
        if e.code == 404:
            return None
        msg = e.read().decode(errors="replace")
        try:
            msg = json.loads(msg).get("message", msg)
        except ValueError:
            pass
        raise GitHubError(f"GitHub {e.code}: {msg}") from None
    except urllib.error.URLError as e:
        raise GitHubError(f"GitHub unreachable: {e.reason}") from None
    with _CACHE_LOCK:
        _CACHE[path] = {"data": data, "etag": etag, "at": now}
    return data


def _note_rate(h):
    if h and h.get("X-RateLimit-Remaining") is not None:
        _RATE.update(remaining=int(h["X-RateLimit-Remaining"]), limit=int(h.get("X-RateLimit-Limit", 0)),
                     reset=int(h.get("X-RateLimit-Reset", 0)))


def blob_sha(data):
    """Git's blob id. Text is normalised to LF, as git does on commit with autocrlf."""
    if b"\0" not in data:
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def local_files():
    out = {}
    for p in ROOT.rglob("*"):
        rel = p.relative_to(ROOT).as_posix()
        if p.is_dir() or any(part in IGNORE_DIRS for part in p.relative_to(ROOT).parts):
            continue
        if p.name in IGNORE_FILES or p.suffix == ".pyc":
            continue
        out[rel] = blob_sha(p.read_bytes())
    return out


def _in_scope(path):
    return path.startswith(CODE_SCOPE[:2]) or path == CODE_SCOPE[2]


def sync_state(tree, head):
    """Compare the running code with the branch tree, file by file."""
    remote = {e["path"]: e["sha"] for e in (tree or {}).get("tree", []) if e["type"] == "blob"}
    local = local_files()
    rows = []
    for path in sorted(set(remote) | set(local)):
        r, l = remote.get(path), local.get(path)
        if r == l:
            continue
        kind = "modified" if r and l else "local only" if l else "not on server"
        # files outside the runnable code (docs, scripts) are expected to be absent from a deployment
        neutral = not _in_scope(path) and kind != "modified"
        rows.append({"path": path, "status": kind, "neutral": neutral, "url": file_url(path, head) if r else None})
    drift = [r for r in rows if not r["neutral"]]
    return {"in_sync": not drift, "drift": drift, "neutral": [r for r in rows if r["neutral"]],
            "compared": len(set(remote) & set(local)), "local_files": len(local), "remote_files": len(remote)}


def _ts(s):
    return s and dt.datetime.fromisoformat(s.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M UTC")


def _read_token():
    # a read-only token lets a public deployment sync quickly without being able to open PRs
    return os.environ.get("HOE_GITHUB_READ_TOKEN") or os.environ.get("GITHUB_TOKEN")


def poll_interval():
    return 15 if _read_token() else 180   # anonymous: 60 requests/hour shared by the whole server


_SUM = {"data": None, "marker": None, "probe_at": 0.0}
_SUM_LOCK = threading.Lock()
PRS_N = 20


def _now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def summary(force=False):
    """Everything the Version control screen shows. Never raises: errors come back in `error`.

    A cheap probe (branch heads + recently updated PRs: 2 requests) runs at most once per
    poll_interval(); the full refresh (repo, commits, tree, branch comparisons) runs only when
    the probe sees a change, or on force. The file-by-file sync check is local and always fresh."""
    with _SUM_LOCK:
        now, cached = time.time(), _SUM["data"]
        try:
            if cached and not force and now - _SUM["probe_at"] < poll_interval():
                data = cached
            else:
                branches = _get(f"/repos/{REPO}/branches?per_page=30", force=True) or []
                pulls = _get(f"/repos/{REPO}/pulls?state=all&sort=updated&direction=desc&per_page={PRS_N}", force=True) or []
                _SUM["probe_at"] = now
                marker = (tuple((b["name"], b["commit"]["sha"]) for b in branches),
                          tuple((p["number"], p["updated_at"]) for p in pulls))
                if cached and not force and marker == _SUM["marker"]:
                    data = cached
                else:
                    data = _full(branches, pulls)
                    data["fetched_at"] = _now()
                    _SUM.update(data=data, marker=marker)
                data["checked_at"] = _now()
            out = {**data, "error": None}
        except GitHubError as e:
            out = {**(cached or {}), "error": str(e)}
        if out.get("head"):
            out["sync"] = sync_state(_SUM.get("tree"), out["head"]["sha"])
        out.update(status(), rate=dict(_RATE), poll_s=poll_interval(), read_auth=bool(_read_token()),
                   next_check_s=max(0, round(poll_interval() - (time.time() - _SUM["probe_at"]))))
        return out


def _full(branches, pulls, commits_n=25):
    repo = _get(f"/repos/{REPO}", True) or {}
    base = repo.get("default_branch", BASE)
    commits = _get(f"/repos/{REPO}/commits?sha={urllib.parse.quote(base)}&per_page={commits_n}", True) or []
    head = commits[0]["sha"] if commits else None
    _SUM["tree"] = _get(f"/repos/{REPO}/git/trees/{head}?recursive=1", True) if head else None
    rows = []
    for b in branches[:10]:
        cmp = None if b["name"] == base else _get(
            f"/repos/{REPO}/compare/{urllib.parse.quote(base)}...{urllib.parse.quote(b['name'], safe='')}", True)
        pr = next((p for p in pulls if p["head"]["ref"] == b["name"]), None)
        rows.append({"name": b["name"], "sha": b["commit"]["sha"], "short": b["commit"]["sha"][:7],
                     "url": branch_url(b["name"]), "commit_url": commit_url(b["commit"]["sha"]), "default": b["name"] == base,
                     "ahead": cmp and cmp["ahead_by"], "behind": cmp and cmp["behind_by"], "hoe": b["name"].startswith("hoe/"),
                     "pr": pr and {"number": pr["number"], "url": pr["html_url"], "state": _pr_state(pr)}})
    rows.sort(key=lambda r: (not r["default"], r["name"]))
    return {
        "repo_meta": {"default_branch": base, "pushed_at": _ts(repo.get("pushed_at")), "visibility": repo.get("visibility"),
                      "description": repo.get("description")},
        "head": {"sha": head, "short": head and head[:7], "url": head and commit_url(head)},
        "commits": [{"sha": c["sha"], "short": c["sha"][:7], "url": c["html_url"],
                     "message": c["commit"]["message"].split("\n")[0],
                     "author": (c.get("author") or {}).get("login") or c["commit"]["author"]["name"],
                     "date": _ts(c["commit"]["author"]["date"]), "merge": len(c.get("parents", [])) > 1} for c in commits],
        "pulls": [{"number": p["number"], "title": p["title"], "url": p["html_url"], "state": _pr_state(p),
                   "branch": p["head"]["ref"], "base": p["base"]["ref"], "author": p["user"]["login"],
                   "updated": _ts(p["updated_at"]), "merged": _ts(p.get("merged_at")), "hoe": p["head"]["ref"].startswith("hoe/")}
                  for p in pulls],
        "branches": rows,
    }


def _pr_state(p):
    return "merged" if p.get("merged_at") else p["state"]


def _manual_commands(branch, title, commits):
    lines = [f"git clone {repo_url()}.git", f"cd {REPO.split('/')[1]}", f"git checkout -b {branch} origin/{BASE}"]
    for message, files in commits:
        lines.append(f"# write: {', '.join(files)}")
        lines.append(f"git add {' '.join(files)} && git commit -m \"{message}\"")
    lines += [f"git push -u origin {branch}", f"gh pr create --base {BASE} --head {branch} --title \"{title}\" --body-file pr-body.md"]
    return "\n".join(lines)


def ensure_release_refs(tag: str, branch: str):
    """Create release branch and tag at current BASE head.

    In dry-run mode returns planned refs only.
    """
    out = {"live": live(), "repo": REPO, "base": BASE, "tag": tag, "branch": branch,
           "tag_exists": None, "branch_exists": None, "tag_created": False, "branch_created": False}
    if not live():
        out["note"] = "Dry run: set GITHUB_TOKEN to create branch and tag refs."
        return out
    base_ref = _call("GET", f"/repos/{REPO}/git/ref/heads/{urllib.parse.quote(BASE, safe='')}")
    head_sha = base_ref["object"]["sha"]
    out["head_sha"] = head_sha

    q_branch = urllib.parse.quote(branch, safe="")
    b_ref = _call("GET", f"/repos/{REPO}/git/ref/heads/{q_branch}", ok_missing=True)
    out["branch_exists"] = bool(b_ref)
    if not b_ref:
        _call("POST", f"/repos/{REPO}/git/refs", {"ref": f"refs/heads/{branch}", "sha": head_sha})
        out["branch_created"] = True

    q_tag = urllib.parse.quote(tag, safe="")
    t_ref = _call("GET", f"/repos/{REPO}/git/ref/tags/{q_tag}", ok_missing=True)
    out["tag_exists"] = bool(t_ref)
    if not t_ref:
        _call("POST", f"/repos/{REPO}/git/refs", {"ref": f"refs/tags/{tag}", "sha": head_sha})
        out["tag_created"] = True

    return out


def _patch_excerpt(patch: str, max_lines: int = 8) -> str:
    if not patch:
        return ""
    out = []
    for ln in patch.splitlines():
        if ln.startswith("@@"):
            continue
        if ln.startswith("+++") or ln.startswith("---"):
            continue
        if ln.startswith("+") or ln.startswith("-"):
            out.append(ln)
        if len(out) >= max_lines:
            break
    return "\n".join(out)


def change_evidence(limit_commits: int = 8, files_per_commit: int = 3):
    """Recent commit evidence with relevant file snippets for UI review."""
    commits = _get(f"/repos/{REPO}/commits?sha={urllib.parse.quote(BASE)}&per_page={max(1, min(limit_commits, 20))}", True) or []
    out = []
    for c in commits:
        sha = c["sha"]
        d = _get(f"/repos/{REPO}/commits/{sha}", True) or {}
        files = d.get("files") or []
        rel = [f for f in files if (f.get("filename") or "").startswith(("backend/", "frontend/", "agents/", "src/"))]
        if not rel:
            rel = files
        rel.sort(key=lambda f: (f.get("changes") or 0), reverse=True)
        picked = []
        for f in rel[:max(1, files_per_commit)]:
            path = f.get("filename") or ""
            picked.append({
                "path": path,
                "status": f.get("status"),
                "additions": f.get("additions", 0),
                "deletions": f.get("deletions", 0),
                "changes": f.get("changes", 0),
                "url": file_url(path, sha),
                "snippet": _patch_excerpt(f.get("patch") or ""),
            })
        out.append({
            "sha": sha,
            "short": sha[:7],
            "message": (d.get("commit") or {}).get("message", "").split("\n")[0],
            "author": ((d.get("author") or {}).get("login") or ((d.get("commit") or {}).get("author") or {}).get("name")),
            "date": _ts(((d.get("commit") or {}).get("author") or {}).get("date")),
            "url": commit_url(sha),
            "files": picked,
        })
    return out
