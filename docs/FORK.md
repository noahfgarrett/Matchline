# Fork provenance

This repo began as a full copy of SSManagement's `src/`, `build/`, `tests/`,
`package.json`, and `AGENTS.md` at commit `6d51935` (2026-08-03, v3.5.0).

Policy: one-time fork. No build or runtime coupling with SSManagement.
Improvements flow between repos only by deliberate cherry-pick.
SSManagement is never modified by Compiler work.

Trim of unused surfaces (legend trainer, update UI, etc.) is deferred to
Phase 3 — see docs/specs/2026-08-03-ssm-compiler-design.md §11.
