# Release Notes - 2026-09-29

## Summary

This release strengthens governed promotion from Plan-B nightly RL runs to Plane-A harness changes with strict lineage, owner-controlled approval, and exportable customer evidence.

## Scope

- Product area: Offline RLAIF optimization and promotion governance
- Branch: `main`
- Intended audience: Delivery leads, governance reviewers, customer stakeholders

## Included Changes

### 1) Strict nightly batch to approval mapping

The evidence pipeline now maps each nightly batch to candidate approvals using deterministic precedence:

1. Approval contains explicit `run_id`
2. Explicit run-to-approval link exists (`POST /api/approval/{cid}/link-run`)
3. Strict timestamp fallback only when a unique approval candidate exists within 0-24 hours

Per-batch provenance labels are exposed for auditability:

- `explicit-run-id`
- `explicit-link`
- `timestamp-strict`
- `ambiguous-timestamp`
- `unmapped`

### 2) Owner-attributed approval and auto release refs

Agent owner approvals are now attributed using centralized config:

- `HOE_APPROVAL_OWNER_NAME`

On Agent owner approval, release refs are auto-created for the mapped batch:

- Tag: `planea-YYYYMMDD.b<run_id>`
- Branch: `release/plane-a/YYYYMMDD-b<run_id>`

The ref creation path is idempotent and respects dry-run mode when GitHub write auth is unavailable.

### 3) Customer-ready evidence export

A one-click exportable report is available for customer and audit review:

- UI: Nightly versions & Git evidence -> Export customer report
- API: `GET /api/vcs/change-evidence/export`

The export includes the chain from batch metadata through approvals/fixes to Git references and snippets.

## Key APIs

- `GET /api/vcs/change-evidence`
- `GET /api/vcs/change-evidence/export`
- `POST /api/approval/{cid}/link-run`
- `POST /api/approval/{cid}/decide`

## Configuration

- `HOE_APPROVAL_OWNER_NAME`
- `HOE_GITHUB_REPO` (default `ramsharma77/rlaif`)
- `HOE_GITHUB_BASE` (default `main`)
- `HOE_GITHUB_PATH` (default `agents/{agent}`)

## Validation Status

- Editor diagnostics were clean for modified backend and frontend files at implementation time.
- Push verification: changes were pushed to `origin/main` at `https://github.com/ramsharma77/rlaif.git`.

## Notes And Boundaries

- Timestamp fallback is intentionally conservative and does not map when multiple candidates exist.
- Export evidence quality depends on available Git metadata and configured repository access.
