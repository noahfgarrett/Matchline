# STATUS — build progress and handoff notes

Living document. Updated at every phase merge. Newest entries at the top of the log.

## Deferred until Noah / Windows / real-world (not blockers for the rest)

| Item | Needs | Where it's specified |
|---|---|---|
| Navisworks extraction proof run | Windows + Navisworks Manage 2025 | docs/WINDOWS-RUNBOOK.md (30 VERIFY-ON-WINDOWS flags) |
| Code signing (MSIX/EXE) | Certificate purchase + org verification | DECISIONS.md open items |
| Navisworks 2024/2026 adapters | Those product versions installed | PRODUCT.md Phase 7 |
| Multi-site pilots / baseline refinement | Real sites | PRODUCT.md Phase 8 |

Consequence: the deliverable of this build-out is a feature-complete app, fully tested against
synthetic (Dragon) extraction caches and invented spreadsheets, packaged as an unsigned
Windows build. Extraction is exercised for real on Noah's first runbook run.

## Execution order (differs from PRODUCT.md phase numbering — engine first)

1. **E1 — Model-first engine core** (PRODUCT.md Phase 2): asset candidate filtering,
   canonical tags + duplicate detection, tag anatomy, System Resolver + System Catalog,
   canonical generated MEL. Pure TS packages over model-schema caches.
2. **E2 — Connectivity spine** (Phase 3): EasyPower/Cable/PMD/MEL spreadsheet imports
   (donor parsing behavior behind typed packages), identity reconciliation tiers,
   Electrical Flow projection, source-only statuses.
3. **E3 — SSM compiler** (Phase 4): role graph, flow-anchored family inference, learned
   rules (classification training + self-grading, v1 scope), Hierarchy Composer model,
   boundary fold (hard boundaries — DECISIONS.md #1), deterministic resolved snapshots.
4. **E4 — Commissioning outputs** (Phase 4.5): P6 import, milestone ladders, sequencing
   polarity, predecessor matrix, EXTO export, site-template MEL, revision diff.
5. **A1 — App**: Electron shell + React (wizard screens 1–9, Hierarchy Composer UI,
   Site Profile Studio, review panels, Electrical Flow / SSM tree views, exports),
   ProjectStore on node:sqlite, typed IPC.
6. **H1 — Hardening + packaging**: backups/migrations/recovery, security defaults per
   PRODUCT.md §16, cancellable long ops, unsigned Windows build + install notes.

## Log

### 2026-08-07 — Phase 1 foundation merged (`7473add`)
- Extraction architecture + cache schema v1; `packages/model-schema` (reader, Property
  Catalog, Dragon fixture); C# worker skeleton (uncompiled, 30 VERIFY flags); Windows runbook.
- Suite: 716/716 (16 domain, 44 model-schema, 656 legacy-parity).

### 2026-08-07 — Phase 0 foundation merged (`a260e87`)
- History-preserving fork, `ssmanagement-origin-4.2.2`, donor frozen in legacy-parity
  (tree-hash-identical), workspace 0.1.0, `packages/domain`, CI, docs (PRODUCT/ORIGIN/DECISIONS).
