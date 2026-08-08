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

## Architecture notes for later stages

- **Property-bag seam (E3 owes this):** asset-catalog outputs mapped fields only;
  system-resolver's model-field/direct-column rungs need the raw category→name→value bag.
  The E1 integration test bridges via `cache.propertiesOf(objectId)` per asset; the compiler
  orchestration layer (E3) must own that bridge as a real API.
- Under `conflictPolicy: 'review'` a conflicted subject still resolves to the first rung's
  value with status CONFLICTING + a review item — visibility, not nullification. Deliberate.

## Log

### 2026-08-08 — E4 commissioning outputs merged (0.5.0)
- scheduling (P6 xer+xlsx, milestone ladder, polarity sequencing, predecessor matrix),
  exto-export (Rev21 positional map — donor code beat its own comment, AN not AM; item
  masters at 0.9 gate), mel-export extended (template fill, §12.3 comparison, §12.4 diff).
- CompiledProject now publishes generatedMel.assets so template/compare/diff need no
  reimplemented adapter. E4 integration test green.
- ENGINE COMPLETE. All engine-side phases (2, 3, 4, 4.5) proven on Dragon fixtures.
- Next: A1 app (Electron shell, typed IPC, ProjectStore on node:sqlite, React wizard
  screens 1–9, Hierarchy Composer, Studio, review panels, tree/flow views, exports).

### 2026-08-07 — E3 SSM compiler merged (0.4.0)
- relationship-claims (8-source assembly, make-root directives), learned-rules (donor §7
  port: shared pickParent policy, thresholds table in its report/tests), ssm-compiler
  (ladder, hard-boundary fold — RIO §2.5 verbatim acceptance test, differ-outranks-unknown,
  manual bypasses fold), compiler orchestrator (owns the property-bag seam; all 8 ladder
  rungs reachable; model-tree ancestry walk).
- E3 integration test proves all Phase 4 exit criteria incl. programmatic boundary sweep.
- Known quirk: MEL provenance can't name sheet rows (readMelTable returns records, not
  addresses) — needs a spreadsheet-import extension someday.
- Next: E4 commissioning outputs (P6 import, milestone ladders, sequencing polarity,
  predecessor matrix, EXTO export, site-template MEL, revision diff), then A1 app shell.

### 2026-08-07 — E2 connectivity spine merged (0.3.0)
- connectivity-import (donor detection ported, EasyPower fallback → honest unknown),
  identity (six tiers, ambiguity terminal, -A/-B protected), electrical-flow (source-only
  nodes visible, SCC cycle anomalies). E2 integration test proves Phase 3 exit criteria.
- CI fixed: donor differential tests (absolute path to local SSM-Builder checkout) excluded
  on runners via --test-skip-pattern; integration tests added to CI. Donor tree untouched.
- Next: E3 SSM compiler (role graph, family inference, learned rules, Hierarchy Composer
  model, boundary fold, resolved snapshots).

### 2026-08-07 — E1 engine core merged (0.2.0)
- tag-anatomy, spreadsheet-import (vendored donor SheetJS), asset-catalog, system-resolver,
  mel-export; E1 pipeline integration test proves all Phase 2 exit criteria on Dragon.
- Suite: 964/964. Next: E2 connectivity spine (EasyPower/Cable/PMD imports, identity
  reconciliation tiers, Electrical Flow projection, source-only statuses).

### 2026-08-07 — Phase 1 foundation merged (`7473add`)
- Extraction architecture + cache schema v1; `packages/model-schema` (reader, Property
  Catalog, Dragon fixture); C# worker skeleton (uncompiled, 30 VERIFY flags); Windows runbook.
- Suite: 716/716 (16 domain, 44 model-schema, 656 legacy-parity).

### 2026-08-07 — Phase 0 foundation merged (`a260e87`)
- History-preserving fork, `ssmanagement-origin-4.2.2`, donor frozen in legacy-parity
  (tree-hash-identical), workspace 0.1.0, `packages/domain`, CI, docs (PRODUCT/ORIGIN/DECISIONS).
