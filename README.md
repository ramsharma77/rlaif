# Harness Optimization Engine — Verizon RLAIF v2 demo (Capgemini)

A full-stack web app that reproduces the 11 mockup screens and adds an **Optimizer & RL** tab.
It detects agent failures, proposes harness fixes, and validates them with before/after conversation
replays. It also runs harness search and RL fine-tuning on AI feedback, then routes changes through
approvals, regression gates and a staged rollout, recording every step in a hash-chained audit log.

Everything runs on a deterministic simulation, so no model API key is needed.

Repository: https://github.com/ramsharma77/rlaif

## Run

```bash
git clone https://github.com/ramsharma77/rlaif.git
cd rlaif
./run.sh                       # or: pip install -r requirements.txt && uvicorn backend.app:app --reload
open http://localhost:8000
```

Requires Python 3.10+. Seeding takes about 6 seconds on start. **Reset demo data** (bottom of the sidebar)
re-seeds the demo.

Optional: `export ANTHROPIC_API_KEY=...` enables the LLM reflective proposer in harness search.
`HOE_LLM_MODEL` sets the model (default `claude-sonnet-5`).

## Centralized runtime configuration

This repo now exposes a single configuration surface for ingestion, optimizer/RL,
semantic clustering and fallback behavior.

- Environment template: `.env.example`
- Backend settings module: `backend/engine/config.py`
- API view: `GET /api/config`

Key controls include:

- trace inputs and ingestion thresholds (`HOE_TRACE_FILE_PATHS`, line/trace limits)
- optimizer search shape (`HOE_OPT_*`, dimensions, top-p dimensions)
- RL defaults (`HOE_RL_*`)
- KPI focus list (`HOE_BUSINESS_KPIS`)
- semantic clustering runtime and fallback (`HOE_SEMANTIC_*`, `HOE_LLAMA_SERVER_URL`, `HOE_ANTHROPIC_FALLBACK_MODEL`)

## Local SLM (GGUF) and semantic clustering runtime

The local-first semantic runtime uses llama.cpp server. A repo-owned copy of the
newest matching Qwen GGUF can be provisioned from your shared SLM folder.

- Setup and copy model: `POST /api/slm/setup`
- Probe runtime health: `GET /api/slm/probe`
- Launch managed llama.cpp server: `POST /api/slm/launch`
- Managed runtime status: `GET /api/slm/status`
- Stop managed llama.cpp server: `POST /api/slm/stop`
- Ad-hoc semantic clustering: `POST /api/semantic/cluster` with `{"texts": [...]}`

Behavior order:

1. llama.cpp server (`HOE_LLAMA_SERVER_URL`)
2. Anthropic Haiku fallback (only if local runtime is unavailable or fails)
3. deterministic lexical fallback (safety net)

## Production trace ingestion and persisted dashboard metrics

Trace ingestion now supports incremental append from JSONL exports into SQLite
with quarantine-and-continue behavior.

- Run ingestion: `POST /api/ingest/run`
  - Optional body: `{"paths": ["C:/.../file1.jsonl", "C:/.../file2.jsonl"]}`
- List ingest runs: `GET /api/ingest/runs`
- Aggregated KPI window: `GET /api/ingest/overview?range=7d`
  - Supported ranges: `24h`, `7d`, `30d`, `90d`, `12m`, `custom`
  - Custom window: `range=custom&start=YYYY-MM-DD&end=YYYY-MM-DD`

Current guardrails are controlled by env/config:

- line-level quarantine only above 1.5 MB (`HOE_INGEST_LINE_MAX_BYTES`)
- trace-object soft size at 500 KB (`HOE_INGEST_TRACE_SOFT_MAX_BYTES`)

## GitHub pull requests

For the first-party billing agent, **Fix bundles → Open pull request** delivers a fix to
[ramsharma77/rlaif](https://github.com/ramsharma77/rlaif):
it creates branch `hoe/<bundle>-<fix>` from `main`, commits the production baseline and then the fix to
`agents/billing/system_prompt.md` and `agents/billing/harness.yaml`, and opens a PR whose body carries the
theme, offline-replay lift, regression result and diff. The fix page, audit log and Agents page link to the
PR, branch, commits and files. Clicking again reuses the open PR and commits only if something changed.

Without a token it is a **dry run**: the same links, plus the `git` / `gh` commands to do it by hand. To go live:

```bash
export GITHUB_TOKEN=$(gh auth token)   # or a fine-grained token: Contents + Pull requests (read/write)
```

Optional: `HOE_GITHUB_REPO` (default `ramsharma77/rlaif`), `HOE_GITHUB_BASE` (`main`),
`HOE_GITHUB_PATH` (`agents/{agent}`). Code: `backend/engine/vcs.py`. Leave the token unset on public
deployments, or anyone with the URL can open PRs.

## Nightly RL batch versioning and release evidence

The app supports a strict, audit-friendly chain from overnight Plan-B runs to Plane-A harness promotions.

- Strict mapping priority:
  - explicit `run_id` on approval records
  - explicit run-to-approval links (`POST /api/approval/{cid}/link-run`)
  - strict timestamp fallback (only unique candidate in a 0-24h window)
- Mapping source is shown per batch (`explicit-run-id`, `explicit-link`, `timestamp-strict`, `ambiguous-timestamp`, `unmapped`).
- Owner approval identity is centralized (`HOE_APPROVAL_OWNER_NAME`) and used for Agent owner sign-off.
- On Agent owner approval, release refs are auto-created for the mapped nightly batch:
  - tag: `planea-YYYYMMDD.b<run_id>`
  - branch: `release/plane-a/YYYYMMDD-b<run_id>`
- One-click customer export report:
  - UI: **Nightly versions & Git evidence → Export customer report**
  - API: `GET /api/vcs/change-evidence/export`

Related APIs:

- `GET /api/vcs/change-evidence`
- `GET /api/vcs/change-evidence/export`
- `POST /api/approval/{cid}/link-run`

## Version control

**Version control** (bottom of the sidebar, **Git** in the top tabs) shows the repository live: commits on
`main`, pull requests (open, merged, closed; HOE-opened ones are tagged), branches with ahead/behind counts,
and every Git action this app has taken. It refreshes every 15 s and flags anything new; **Sync now** forces
a refresh and logs it to the audit trail.

It also checks that the running code **is** what is on GitHub: each file under `backend/`, `frontend/` and
`requirements.txt` is hashed the way git hashes blobs and compared with the tree at the head of `main`, so
drift shows up file by file even on a zip deployment with no `.git` folder.

GitHub is polled with a cheap probe (branch heads + recent PRs) and fully re-read only when something changed:
every 15 s with a token, every 180 s anonymously (GitHub allows 60 anonymous requests an hour per server).
Set `HOE_GITHUB_READ_TOKEN` (read-only) on a public deployment to sync quickly without enabling PR creation.

## Screens

| Tab | What it does |
|---|---|
| Overview | KPIs, flagged-session rate with release markers, detection signals, themes |
| Failure themes | Clusters by failure signature, root-cause hypothesis correlated with harness versions, evidence, sub-clusters |
| Fix bundles | Per-fix prompt/config diff (frozen lines locked), **before/after chat replay**, offline validation (paired bootstrap CI, human-audit lift, regression, κ), delivery artifacts (PR patch, registry, config API, vendor change request, gateway overlay) |
| Approvals | Policy-based routing by change type, role-based decisions, staged rollout with auto-rollback, before/after replay for reviewers |
| Experiments | Multi-candidate comparison on shared held-out scenarios, multi-seed, Holm correction, quality vs cost, reward-hacking check, replay |
| Optimizer & RL | Reflective harness search (Pareto pool, minibatch filter, merge, select/confirm splits) and RL (GRPO / REINFORCE / DPO) with live curves |
| Regression suites | Theme → deduplicated tests (holdout, synthetic, redaction), suite runs against any harness, release gate |
| Evidence explorer | Trace list and detail: transcript, span timeline, evaluator verdicts, decisions, human labels, replay |
| Evaluator health | Cohen's κ vs human labels, weekly drift, auto-pause below threshold, recalibration, labeling queue |
| Pattern library | Proven fixes tested against other agents |
| Agents & connections | Integration levels, capability matrix, agent registration |
| Audit log | SHA-256 hash chain, verification, JSONL export |

**Under the hood** (sidebar group) explains each mechanism with live numbers for the selected agent:

| Page | What it shows |
|---|---|
| Detection | The six OR-ed flag signals, hits and sole-signal catches, overlap, first-match theme assignment |
| Root cause | Theme rate per harness version, the release with the largest rise, the edits it made, confidence formula |
| Statistics | A live paired replay (production vs a derived candidate) with bootstrap distribution, 95% CI and p-value on judge and human-audit metrics; Holm correction from the latest experiment |
| Judges | Resolution-judge settings and rubric, confusion matrix and Cohen's κ derivation, counterfactual cost of the verbosity bonus |
| Release | Approval routing by change type, regression gate, rollout stages and auto-rollback thresholds, open changes |
| Manifest hash | SHA-256 of each harness version's canonical manifest (content only, names excluded), frozen-lines hash, hash verification for vendor attestation |

API: `GET /api/hood/{detection|rootcause|statistics|judges|release|manifest}/{agent}`, `POST /api/hood/manifest/{agent}/verify` with `{"hash": "..."}`. Code: `backend/hood.py`.

## How the simulation works

- `backend/engine/env.py`: billing and outage agents. At each decision point (close vs confirm, answer a
  follow-up, credit above limit, silent customer, ambiguous charge, ETA, closing style), actions are sampled from a
  softmax. The logits sum base-model priors, prompt-line effects, tool-description effects and RL adapter weights,
  and control-flow gates override actions. All randomness is keyed by (seed, event), so a scenario replayed under
  two harnesses uses **common random numbers**: the transcripts stay identical until a decision actually changes.
- `judges.py`: LLM-judge stand-ins with miss and false-fail rates and a **verbosity bias**, so the judge can be
  reward-hacked. Also policy, tool-sequence, empathy (with drift), outcomes (repeat contact, CSAT) and human labels.
- `optimizer.py`: GEPA-style reflective search over harness edits. Frozen policy lines are never edited.
- `rl.py`: RLAIF on an adapter over decision logits (a stand-in for LoRA), with a KL penalty to the reference
  and a choice of reward source (judge, verifiable end-state, or human oracle). Watch judged vs human-audited
  resolution diverge when the judge is the reward.
- `analysis.py`: theme clustering, root cause and the fix library. `evaluate.py`: reward v3 and statistics.
- `backend/state.py`: in-memory state and services. Replace it with your store (and a real trace source such as
  Galileo) to move beyond the demo.

## Replacing the simulation with real agents

Swap `env.run_episode` for a replay against your agent runtime, using recorded or simulated users.
Swap `judges.resolution` for your LLM-judge calls. Feed `state._gen_traces` from your trace store.
The optimizer, RL loop, statistics, approvals and audit layers work unchanged on the resulting records.
