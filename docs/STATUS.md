# STATUS — build progress and handoff notes

Living document. Updated at every phase merge. Newest entries at the top of the log.

## Deferred until Noah / Windows / real-world (not blockers for the rest)

| Item | Needs | Where it's specified |
|---|---|---|
| Navisworks extraction proof run | Windows + Navisworks Manage 2025 | docs/WINDOWS-RUNBOOK.md (35 VERIFY-ON-WINDOWS flags) |
| Code signing (MSIX/EXE) | Certificate purchase + org verification | DECISIONS.md open items |
| Navisworks 2024/2026 adapters | Those product versions installed | PRODUCT.md Phase 7 (M7 landed the projects; both are `stub-compiled-unverified` until a real install proves them) |
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

### 2026-08-11 — 1.0 hardening campaign, in progress (branch `claude/matchline-1.0.0-hardening-20260810`)

Directive and live gate tracker: **docs/RELEASE-1.0-PLAN.md**. Baseline for the campaign
was main @ 542f6db (0.8.1, 1737 tests / 0 failures). Suite now **2047 / 0** — 1324 typed
package, 656 donor parity, 27 integration, 40 acceptance-gate. The repository version is
still 0.8.1; 1.0.0 is not claimed and cannot be until the hard gates hold.

**M1 — safety baseline. Complete.** Branch cut, baseline counts recorded, and the whole
1.0 acceptance suite staged in `tests/acceptance-1.0/` — deliberately red, one file per
hard gate, each wired into `npm run test:acceptance10:green` as its milestone lands. A gate
that goes green and then breaks fails CI.

**M2 — multi-model domain and storage. Complete.** `ModelUniverse`/`ModelSource` and the
typed `ModelObjectKey` in `@matchline/domain`; project schema v4 (source-id-keyed `sources`,
`logical_name` split from `raw_file_name`, `raw_sha256` split from `derived_cache_sha256`,
compile input hashes re-keyed) with a frozen-v3 migration fixture; the asset catalog and
the compiler consuming many sources; the desktop session holding every readable cache open
at once with per-source coverage and inclusion impact. Gates 2, 3 and 4 green — split and
federated representations of one site compile to equivalent output, and files sharing a
basename coexist.

**M3 — stable asset identity. Complete.** `@matchline/asset-identity` (evidence ladder,
reconciliation, alias capture), project schema v5 `ledger` table, desktop identity
lifecycle and the `compile:ledger-events` channel. A corrected tag keeps its `assetId`,
decisions recorded against the old tag keep applying, the diff reports a tag change rather
than a remove plus an add, and an override that cannot be mapped becomes an
orphaned-decision review item. Gate 12 green.

**M4 — hierarchy and profile semantics. Complete, in three parts.**
- *M4:* the manual-parent bypass is **gone** — manual wins the ladder and then folds, with
  provenance recording the manual origin and the demotion and a `manual-boundary-demotion`
  review item (gates 9, 10). `DEFAULT_HIERARCHY_LEVELS` ships `boundary: false` on SSM
  Discipline (gate 11). `HierarchyLevelConfig` splits key / display / boundary attributes
  (gate 8).
- *M4b:* property chains with per-source overrides, source assignment rules resolved
  object property > source model > logical file > confirmed filename pattern > review, and
  a derived-attribute registry with seven resolver kinds; project schema v6 (gates 5, 6, 7
  green engine-side).
- *M4c:* `SiteProfileV2` consolidation — one versioned document, profile package format v2
  with v1 import migration, stored v1 revisions lifted on read and legacy `config` sections
  merged into a new revision on open; screen 3's stable-id picker, screen 6's key/display/
  boundary controls, screen 9's pre-publication boundary confirmation (gate 13 partial —
  the end-to-end 0.8.1 migration test is M10's).

**M7 — 2024/2026 adapters. Landed, unverified.** One shared Autodesk-touching source in
`native/navisworks-adapter/` compiled once per year into 2024/2025/2026 assemblies;
newest-installed selection; `SupportedAdapters.cs` is the single source of truth for what
may be claimed. 2025 is `pending-real-proof`, 2024 and 2026 are
`stub-compiled-unverified`, nothing is `verified`. CI stub-compiles every adapter it finds
by glob, so a new year is covered the day it lands. Gate 17 stays open until the labels are
backed by a real run.

**M9 — distribution. Landed except signing.** Hosted CI matrix on ubuntu/macos/windows
plus a native Autodesk-free smoke on Linux and Windows and an unsigned Windows packaging
smoke; a tag-driven `release.yml` whose first step fails loudly when production signing
credentials are absent; a self-hosted `navisworks-proof.yml` whose seven scripts now exist
(`scripts/windows-proof/*.mjs`, tested against the fake extractor) — dispatched on a real
runner it genuinely proves the real thing, rather than reporting a proof that did not
happen; and docs/RELEASE-RUNBOOK.md as the owner-facing release document. Signing itself
is still blocked on the certificate, and the `signtool` invocations in `release.yml` have
never run.

**M5 — integrated extraction service. Complete.** `NavisworksExtractionService`
(`apps/desktop/electron/services/extraction-service.ts`) makes dropping a raw NWD/NWF/NWC
the whole of the job on Windows: a serial queue streams the file's SHA-256 rather than
buffering it, detects the installed Navisworks that will open the file, and drives
`Matchline.Extractor` through the same JSON-lines protocol the manual launcher speaks
(mirrored in `extraction-protocol.ts`, reached through the injectable `ExtractorLauncher`
seam in `extractor-launcher.ts`). Every launcher error code and service-level failure maps
to one plain-language sentence in `extraction-messages.ts`. 17 tests
(`apps/desktop/test/extraction-service.test.mjs`) run the whole flow against
`fake-extractor.mjs` — a second implementation of the launcher's side of the protocol,
run as a real child process writing a real cache — covering cache-hit reuse, cancellation
mid-run with partial-file cleanup, every error code, and streaming-hash fidelity on a
multi-megabyte fixture. Screen 1 shows each source's live status
(queued/hashing/opening/extracting/finalizing/ready/cache-hit/cancelled/failed) with a
Cancel button. Gate 1 GREEN for the code; validating it against a real Navisworks install
is M6, below.

**Not landed.**
- **M6 — real Windows proof.** Blocked on Noah's Windows box. Gates 14, 15, 16 and 21 stay
  BLOCKED; the seven `scripts/windows-proof/*.mjs` scripts are written and tested against
  the fake extractor — what remains is running them for real.
- **M8 — performance and one-hour UX.** Open: the scale targets (≥250k objects aggregate,
  ≥40k assets, ≥1M property rows, shuffled-source determinism, responsive event loop
  during compile) and the Quick Setup suggestion path.
- **M10 — RC.** Open: clean-room build, full matrix, real pilot, the 0.8.1 end-to-end
  migration test, then 1.0.0-rc.1. Final 1.0.0 only when every hard gate holds.

**Editors still owed** for sections the engine already honours and the profile already
carries: the property-chain editor, the source-assignment-rule editor, and the
derived-attribute definition editor. Screen 3 edits one property per field today and the
profile keeps the rest.

### 2026-08-09 — registry-ready polish merged (0.8.1)
- EXTO template mode (registry layout captured at runtime into the LOCAL profile — never
  committed; unmatched/PII columns always blank), WBS learned table (systemKey-keyed,
  0.9 gate), model-first mappings for WBS/Item Master/Classification, blank register
  cells by default, audit heuristic narrowed to whole segments, project schema v3.
- Dry-run against the real registry (local only): template 46/46 headers byte-identical,
  WBS 100% assigned at 99.99% agreement, item masters 75% auto-assigned at 98.94%
  agreement excluding audited rows. Suite 1737/0. Release v0.8.1 published (private).
- Operator note for the first real run: set screen 5 labelTemplate to
  '{systemKey}  {systemDescription}' (double space) to match the site's System Name
  convention — profile-level, deliberately not an engine default.

### 2026-08-08 — verification pass + finishing touches merged (0.8.0)
- Clean-room clone build verified; three adversarial reviews (fold/compiler, identity/
  resolver, desktop IPC) — all findings fixed tests-first, suite 1690/0 run twice.
- Drop zone rebuilt (Electron 43 File.path removal), icon shipped, 0.8.0 installers
  rebuilt and CDP-verified, 40k-object scale test passed, resolver join indexed (29x).
- C# worker compiles on Mac (SDK 8 → net48): fatal csproj defect fixed pre-Windows,
  plugin stub-compiled (20/30 VERIFY flags signature-pinned), CacheWriter executed and
  its output validated by the TS reader — schema v1 agreement proven end to end.
- Remaining before "done-done": Noah's Windows extraction proof (13 open flags + 22
  signature checks), code signing, updater + Releases repo, 2024/2026 adapters, pilots.
  Known open: tag-join branch of mel-lookup still O(n^2) if a profile uses it at scale.

### 2026-08-08 — H1 hardening + packaging merged (0.7.0) — BUILD-OUT COMPLETE
- Review keys storage-safe engine-side (U+241F + percent-escape, injective); project
  schema v2 `config` table with opt-in migration + backup — a .matchline now carries its
  entire configuration; app-state reduced to recents + hash→path index.
- electron-builder 26 (only Squirrel's unused dep has an install script; none run):
  unsigned Windows Setup exe (86 MiB) + portable zip (135 MiB) + mac zip, all verified
  (mac: packaged CDP walk incl. app:// traversal guard; win: structural PE/asar checks).
  Fixed six undeclared workspace deps that dev-mode hoisting had masked.
- docs/INSTALL-TRY-IT.md is the owner's entry point. Open items: app icon, code signing,
  updater + Matchline-Releases repo, Windows extraction proof (runbook), 2024/2026
  adapters, schema-v2 note for orphaned pre-release review decisions (none real).

### 2026-08-08 — A1 desktop app merged (0.6.0)
- Full app: shell (app:// CSP, typed Zod IPC), project-store, wizard 1–9, workspace
  (tree + drag overrides, flow, review, exports). CDP/harness-verified visually.
- Carried into H1: (a) project schema v2 `config` table for hierarchy/roleGraph/ladder/
  projection (currently app-state keyed by path — moving a .matchline loses them);
  (b) engine-side reviewKey uses   which node:sqlite truncates — app escapes it,
  ssm-compiler should switch separators; (c) packaging (electron-builder, unsigned).
- Next: H1 hardening + packaging, then final report to Noah.

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
  *(Superseded 2026-08-11: "manual bypasses fold" was 0.4.0 behaviour. Manual parents fold
  as of M4 — see the 1.0-campaign entry at the top and DECISIONS.md #9.)*
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
