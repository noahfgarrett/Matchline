# Changelog

## 0.2.0 — 2026-08-07 — E1: model-first engine core (PRODUCT.md Phase 2)

- Tag anatomy: profile-taught segmentation (role/system/family), whole-set preview.
- Spreadsheet import: donor SheetJS vendored byte-identically, dense/sparse AoA parity
  preserved, explicit-mapping MEL reads, macros never execute.
- Asset catalog: model-first universe from extraction caches — ordered filters with
  inclusion-impact reporting, component collapse, duplicate tags surfaced never merged.
- System Resolver: ordered component chain (model field, tag segment, MEL lookup, direct
  column, composite, manual), explicit normalization with transform trails, System Catalog,
  conflicts as review items; manual assignments always win.
- Generated MEL: canonical §12.1 workbook, byte-stable, leading-zero-safe.
- End-to-end integration test proving all Phase 2 exit criteria on the Dragon fixture.
- Suite: 964 tests (301 new engine + 656 legacy-parity + 7 integration), 0 failures.

## 0.1.0 — 2026-08-07 — Phases 0–1: foundation

- History-preserving fork of SSManagement 4.2.2 (`ssmanagement-origin-4.2.2`), donor frozen
  and runnable in packages/legacy-parity (tree-hash-identical, 656 tests).
- Workspace, strict TypeScript, @matchline/domain vocabulary, CI (ubuntu + macos).
- Extraction architecture: cache schema v1, NDJSON hand-off, atomic cache commit;
  @matchline/model-schema reader + Property Catalog + Dragon fixture.
- C# Navisworks worker skeleton (net48, 30 VERIFY-ON-WINDOWS flags) + Windows runbook.
