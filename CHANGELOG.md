# Changelog

## 0.8.1 — 2026-08-09 — registry-ready polish

- EXTO template mode: capture your registry workbook layout into the local profile;
  exports reproduce it exactly (headers, width, row position), unmatched columns stay
  blank, register cells blank by default (legacy N/A behind an option).
- WBS learned table keyed on System Key with the 0.9 gate; model-first property mappings
  for WBS, Item Master, and Equipment Classification (model value wins over learned).
- Item-master audit narrowed to whole segments with family-aware GEAR handling.
- Project schema v3 (template config + wbs learned kind), migration with backup.
- Suite: 1737 tests, 0 failures.

## 0.8.0 — 2026-08-08 — verification pass and finishing touches

- Adversarial verification of the whole build (clean-room clone, three review passes):
  every finding fixed tests-first. Highlights: two-sided normalization at the MEL system
  join, terminal unresolvable aliases, absorbed-tagged-component visibility, content-
  complete conflict review keys, dead claim rules surfaced, source hashes re-verified
  with a file-changed state, profile-revision dirty tracking, opt-in migration with
  confirmation, exact-origin IPC sender checks, dialog-granted path allowlist, atomic
  export writes, spellcheck disabled (the last residual network path).
- Drop zone rebuilt on webUtils (Electron 43 removed File.path) with main-side screening.
- App icon (matchline M mark), version-synced unsigned installers for Windows and Mac.
- Scale-tested at 40k objects: compile ~1s, tree at 60fps; resolver provenance scan
  indexed (29x at 16k assets) with a perf guard test.
- C# worker now compiles (SDK 8 cross-targeting net48): one fatal csproj defect fixed,
  plugin stub-compiled (20 of 30 VERIFY flags signature-pinned), cache writer executed
  on macOS and its output validated by the TypeScript reader.
- Suite: 1690 tests, 0 failures.

## 0.7.0 — 2026-08-08 — H1: hardening and packaging

- Review keys made storage-safe end to end; project files carry their whole
  configuration (schema v2 config table, opt-in migration with automatic backup).
- Unsigned try-it builds: Windows Setup exe + portable zip, mac zip — see
  docs/INSTALL-TRY-IT.md. Code signing, icon, and the updater remain open items.
- Suite: 1627 tests, 0 failures.

## 0.6.0 — 2026-08-08 — A1: desktop application

- Electron shell: sandboxed renderer, app:// scheme with enforced CSP, typed Zod IPC
  from a single channel-declaration table, envelope responses.
- Project files (.matchline, SQLite): sources, versioned profiles, learned rules,
  overrides, compile history, snapshots, review decisions — all transactional.
- Site Setup wizard screens 1-9: sources with detection, Property Catalog, asset
  definition with live inclusion impact, tag anatomy with whole-set preview, System
  Resolver with rung usage and conflicts, Hierarchy Composer (dnd), relationship rules
  with learned-rules training, compile preview/QA checklist, publish + portable profiles.
- Workspace: virtualized SSM tree with drag reparenting as persistent overrides,
  Electrical Flow view, review queue with decisions, five exports.
- Suite: 1610 tests, 0 failures.

## 0.5.0 — 2026-08-08 — E4: commissioning outputs

- P6 import (.xer and activity sheets), four-rung milestone ladder, discipline-polarity
  sequencing (top-down electrical, bottom-up mechanical), predecessor matrix + workbook.
- EXTO Rev21 upload sheet (donor positional map pinned), item-master learning with the
  0.9 confidence gate, CA_-to-VF_ normalization with template-spelling priority.
- Site-template MEL fill, existing-MEL comparison (§12.3), full §12.4 revision diff
  with multi-sheet workbook. All writers byte-stable.
- Suite: 1475 tests, 0 failures.

## 0.4.0 — 2026-08-07 — E3: SSM compiler (PRODUCT.md Phase 4)

- Relationship claims assembly: eight evidence sources, claims compete, nothing writes.
- Learned rules ported from the donor: digit-masked classification, role gates, affinities,
  self-grading (claim grade at >=85% precision over >=10; everything else proposals).
- Parent ladder + hard-boundary fold: cross-boundary parents demote to dependencies
  (RIO acceptance case verbatim), missing boundaries never guessed, manual overrides
  bypass the fold, cycles broken deterministically to review items.
- Compiler orchestrator: one call from extraction cache + workbooks + profile to snapshot,
  hierarchy tree, Electrical Flow, generated MEL, and aggregated review items.
- Suite: 1282 tests, 0 failures.

## 0.3.0 — 2026-08-07 — E2: connectivity spine (PRODUCT.md Phase 3)

- EasyPower / Cable Schedule / PMD imports with donor-ported sheet detection and
  cell-level provenance; unrecognized sheets reported honestly, never guessed.
- Identity reconciliation: six ordered tiers, terminal ambiguity, letter-suffix siblings
  never merged, fuzzy as review-only proposals.
- Electrical Flow projection: multiple/alternate feeds, model enrichment, visible
  flow-only/PMD-only nodes, ring feeds kept with cycle anomalies.
- CI: machine-dependent donor differential tests excluded on runners; integration suite added.
- Suite: 1106 tests, 0 failures.

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
