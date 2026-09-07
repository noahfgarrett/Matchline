# Changelog

## Unreleased — since 1.0.0-rc.1

Seven of the eight work packages from docs/AUDIT-2026-09-02-NWD-TO-SSM.md landed on
the hardening branch (docs/AUDIT-2026-09-02-NWD-TO-SSM.md, "Status after the work
packages"). No `dotnet` on this machine: every C# change below is unverified
against a real Autodesk assembly.

- **Packaging:** the launcher and adapter DLLs are staged into the app
  (`apps/desktop/scripts/stage-native.mjs` + `extraResources`); CI builds, packages
  and smoke-executes the launcher; the release workflow signs the tree before
  packaging rather than after; `.npmrc` guards `npm ci` install scripts.
- **Launcher:** stall detection (`--stall-timeout-seconds`, default 900s), an
  end-record grace kill before Roamer is force-killed, a kill-on-close Job Object,
  a plugin pre-flight before Navisworks is started, quit confirmation, pre-launch
  file re-check, `%LOCALAPPDATA%` cache with rejected caches moved aside. New codes
  `NW_STALLED`, `PLUGIN_NOT_DEPLOYED`, `PLUGIN_NOT_FOUND`, `SOURCE_MODEL_MISSING`.
- **Extraction cache:** schema v3 — authoring ids keyed on (kind, id), structural
  keys, flags, set GUIDs, real search-set membership via `GetSelectedItems()`
  resolved before the walk (memory-bounded), nested/appended models. NWF inputs are
  never served from cache, and a document that opens without one of its models
  fails `SOURCE_MODEL_MISSING` rather than committing a smaller cache.
- **Navisworks adapters:** every year (2024, 2025, 2026) is now labelled
  `stub-compiled-unverified` — 2025 was carrying the stronger `pending-real-proof`
  label; every build in this project's history has compiled only against
  `native/navisworks-stubs`, never the real assembly.
- **Compiler:** publishes a `CompletenessReport` (nested vs. rooted, per-level gaps,
  demotions, unresolved systems); new counted review kinds
  `missing-boundary-level`, `unresolved-system`, `boundary-demotion`; a `mel-parent`
  ladder rung joins the MEL's System Parent column through identity; `unicodeFold`
  normalization; `validateProfile` up front; `possible-rematch` review items when a
  tag-only identity match agrees with nothing else.
- **Desktop:** the last compile is restored on project open instead of every
  session starting blank; every save path is gated behind screen 9's publish
  confirmation — compiling an unpublished draft is a preview that records nothing;
  the SSM tree and Flow roots page to their real totals; property pickers search
  the whole catalog, not a 500-row page; the review queue pages and surfaces stale
  decisions; Quick Setup now reads Revit-shaped models (building from
  Workset/Level/filename rules, bare-mark tag shapes, projected group counts).
- **Exports:** SSM hierarchy workbook — one column per configured level, plus a
  sheet naming the structural boundaries.
- **Project store:** schema v7 (draft slot, `compile_assets` table, retention);
  guarded transaction commit with a busy timeout; verified, fsynced pre-migration
  backup; read-only/locked files open as results, not failures; system overrides
  now reach the compiler; one override row per asset regardless of key spelling.
- **The SSM SOP, as build rules:** the vendored SSM-Audit rulebook now works in both
  directions. Its description classifiers are restated as `@matchline/ssm-audit/classify`
  and pinned to the vendored regexes by test; a `sop-rule` ladder rung pairs a device to
  the equipment its tag names (UPN + instance, Noah's directive) and carries the SOP's
  nesting and commissioning-logic rules as claims, each individually switchable
  (`SiteProfileV2.sopRules`); a hierarchy level may waive its boundary for named child
  classes, which is SSM-Audit's own approved cross-discipline exception. The default level
  preset is unchanged (P0-5); the Quick Setup starter profile proposes the exception, the
  rung and the SOP's pairings in the site's own role letters, with projected claim counts.
  `tests/integration/e5-ssm-sop.test.mjs` compiles the scenario and proves the gate then
  reports zero `sop.*` / `logic.*` findings.
- Suite: 2431 tests, 0 failures. Remaining gates: the real Navisworks proof, code
  signing, the updater, and clean-machine install.

## 1.0.0-rc.1 — 2026-08-11 — release candidate

The 1.0 hardening campaign (docs/RELEASE-1.0-PLAN.md), all nine P0 findings landed:

- Multi-model universe: many NWD/NWC/NWF sources per project, split or federated,
  duplicate basenames and cross-source duplicate tags handled; equivalent output
  proven for split vs federated organization. Project schema v4.
- In-app extraction: drop a raw model on Windows and it extracts — serial queue,
  streaming SHA-256, live stage progress, cancellation, full plain-language error
  vocabulary. Tested against a protocol-faithful fake launcher.
- Stable asset identity: a persisted ledger keyed on model evidence (stable-id
  property, authoring ids, instance GUIDs, structural keys) so tag corrections keep
  the asset, decisions survive, and diffs report renames. Schema v5.
- Manual parents now honor boundaries: strongest candidate, wins the ladder, folds
  like everything else; cross-boundary manual becomes a dependency with full
  provenance and a review item.
- Default hierarchy: Building and System are boundaries, SSM Discipline is visible
  but nonstructural; level key, display and boundary attributes are separate fields.
- SiteProfileV2: one versioned document for the whole site rule set — chains with
  per-source overrides, source-assignment rules, derived attributes (seven resolver
  kinds), identity, ladder, projection. Profile package format v2; v1 imports
  migrate. Schema v6.
- Quick Setup with data-driven suggestions; chain, derived-attribute and
  assignment-rule editors; pre-publication boundary confirmation.
- Compile runs in a worker thread with Stop; async project open; scale-proven at
  280k objects / 40k assets / 1.28M property rows.
- Search sets resolved in the adapter (cache schema v2) with an honest three-state
  contract; unresolved sets refuse filtering and block publication.
- Navisworks 2024/2025/2026 adapters from one shared source; newest-installed
  selection; support claims limited to what is actually verified (nothing yet).
- CI: ubuntu/macos/windows matrix, native smoke, packaging smoke, self-hosted
  proof workflow, release workflow that refuses to ship unsigned.
- 0.8.1 projects migrate end to end (v3 through v6) with backup and no decision loss.
- Suite: 2155 tests, 0 failures. UNSIGNED build; the real Navisworks proof, code
  signing, and the updater are the remaining gates to 1.0.0.

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
