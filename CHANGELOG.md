# Changelog

All notable changes to this project are documented in this file.

The format is inspired by Keep a Changelog, and this project follows Semantic Versioning principles where practical.

## [Unreleased]

## [2026-09-29]

### Added

- Strict nightly batch-to-approval mapping with deterministic precedence:
  - explicit run_id on approval
  - explicit run-to-approval link
  - strict unique timestamp fallback (0-24h)
- Mapping provenance labels for audit trails:
  - explicit-run-id
  - explicit-link
  - timestamp-strict
  - ambiguous-timestamp
  - unmapped
- Agent owner attribution via centralized approval owner configuration.
- Automatic release ref creation on owner approval:
  - tag: planea-YYYYMMDD.b<run_id>
  - branch: release/plane-a/YYYYMMDD-b<run_id>
- Customer-facing export report endpoint for change evidence chain.
- Client-ready release note:
  - RELEASE_NOTES_2026-09-29.md

### Changed

- Default GitHub repository target for integration and documentation now points to ramsharma77/rlaif.
- README expanded with nightly versioning and release evidence flow.

### Notes

- Detailed business and governance narrative is captured in RELEASE_NOTES_2026-09-29.md.
