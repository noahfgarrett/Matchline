# RELEASE 1.0 PLAN — authoritative directive (Noah, 2026-08-09)

Baseline: main @ 542f6db (0.8.1, 1737 tests / 0 failures). Branch:
`claude/matchline-1.0.0-hardening-20260810`. Decisions below are AUTHORITATIVE —
do not relitigate. Donor (SSManagement / packages/legacy-parity) stays frozen.
Do not claim 1.0.0 from synthetic tests alone: real Navisworks 2025 proof and the
hard gates are mandatory; if code-complete but hardware-blocked, produce
1.0.0-rc.1 and state the blockers.

## Gate tracker (update at every milestone merge)

| # | Hard gate | Status |
|---|-----------|--------|
| 1 | Drop one raw NWD → automatic extraction | code GREEN (M5: in-app service + fake-launcher protocol tests). The launcher and adapter DLLs are now packaged into the app (`apps/desktop/scripts/stage-native.mjs` + `extraResources`, CI-built and smoke-executed), with stall detection, an end-record grace kill, a Job Object, and a plugin pre-flight (`PLUGIN_NOT_DEPLOYED`/`PLUGIN_NOT_FOUND`/`NW_STALLED`) ahead of every run. Real-hardware proof is still gate 14 (M6) — none of this has run against a real Navisworks install |
| 2 | Several NWD/NWC/NWF sources in one project | GREEN for cache sources (engine+store v4+UI, M2); raw-NWD auto-extract is gate 1 (M5) |
| 3 | Split AND federated model organization | GREEN (M2: equivalence proven engine + desktop service level) |
| 4 | Duplicate basenames coexist | GREEN (M2: engine + store v4 + session identity rules) |
| 5 | Global / per-source / ordered-fallback metadata mapping | GREEN (M4b engine: `PropertyMappings` fields are chains with per-source overrides, `migratePropertyMappings` lifts every stored profile; `asset-catalog/test/chains.test.mjs` + `compiler/test/mapping-chains.test.mjs`. M8b closes the editor: the WIRE is chain-shaped (`mappedPropertySchema` + `liftMappedProperty`, which keeps every older spelling — absent, `null`, one `PropertyRef` — readable), screen 3 edits the ordered chain and its per-source overrides, and `draft-profile.ts` converts both ways without narrowing; `editors.test.mjs` round-trips a chain + override through draft → profile → stored revision → package v2 → import) |
| 6 | Source-level Building/Discipline/custom assignments | GREEN (M4b engine: object property > source-model > logical file > filename pattern, provenance names the tier and the rule; `asset-catalog/test/assignment-rules.test.mjs`. M8b closes the editor: screen 6 lists the rules with scope, match, assigned Building/Discipline/custom keys, and a live preview naming the documents hit, the object counts and what `$1` expanded to — matched with `@matchline/asset-catalog`'s own pattern functions so a preview cannot disagree with the engine. `sourceAssignmentRuleSchema.match` is no longer `.min(1)`, because a rule being typed has no match yet; `toSourceAssignments` drops a blank-match rule rather than publishing one that matches everything) |
| 7 | Arbitrary model-derived hierarchy levels | GREEN (M4b engine: `DerivedAttributeDefinition` + seven resolver kinds, evaluated after systems and merged into the level attributes; `compiler/test/derived-attributes.test.mjs`; the Composer lists them. M8b closes the editor: screen 6 manages the registry with a per-kind form for all seven rungs and a live preview over the real universe — coverage, which rung answered, examples, and the tags left without a value. `manual` is honest rather than absent: existing hand-assigned rows are carried and answer, and the form says this build has no per-asset editor for them) |
| 8 | System level: Key = identity/boundary, Label = display | GREEN (M4: HierarchyLevelConfig key/display/boundary + tree key/label + diff category; `level-key-display.test.mjs` wired into `npm test`; M4c: screen 6 exposes all three, the two optional ones behind a disclosure that opens when a level uses them) |
| 9 | Manual parent cannot violate an enabled boundary | GREEN (M4: the manual bypass is gone — manual wins the ladder and folds; `manual-parent-boundaries.test.mjs` wired into `npm test`) |
| 10 | Cross-System parents become dependencies | GREEN (M4: holds for every rung, manual included — dependency + provenance + `manual-boundary-demotion` review item) |
| 11 | Default SSM Discipline level nonstructural | GREEN (M4: `DEFAULT_HIERARCHY_LEVELS` ships boundary=false on SSM Discipline; `default-hierarchy.test.mjs` wired into `npm test`) |
| 12 | Stable asset identity survives tag correction | GREEN (M3 ledger engine + store v5 + desktop lifecycle; M4c: tier-1 `stableIdProperty` is a SiteProfileV2 section with a screen 3 picker) |
| 13 | 0.8.1 projects migrate with backup, no silent decision loss | GREEN (M10: `zero-eight-one-migration.test.mjs` runs a real 0.8.1 file — frozen v3 DDL, two V1 profile revisions, the five `config` sections, three learned kinds, TAG-keyed overrides, two decisions, a compile row and a snapshot — through the DESKTOP service with migration accepted, and asserts the whole chain at once: backup taken at `.backup-3` and still v3, file lands at v7 with all five `migrations` rows, V1 profile lifted to V2 and the config sections merged as ONE new revision with both originals unedited, `learned`/`overrides`/`snapshots`/`decisions` byte-for-byte identical to the backup, the captured EXTO template left in `config` where it belongs, then a recompile in which the tag-keyed manual parent still applies through ledger resolution and the stored decision still resolves onto the review item it was filed against. Wired into `npm test`. Building blocks proven separately: v3->v4->v5->v6->v7 opt-in+backup against frozen per-version DDL (`project-store`), and M4c's SiteProfileV2 migrations incl. v1 profile packages on import (`profile-v2.test.mjs`) |
| 14 | Real Navisworks Manage 2025 extraction proof | BLOCKED: needs Noah's Windows box |
| 15 | Selection Set behavior verified | BLOCKED: same |
| 16 | Search Sets fully implemented or honestly blocked | code GREEN / verify on Windows. Cache schema v3 (`26b6e69`) moved sets to resolve BEFORE the walk rather than after, for memory (one dictionary of only the objects some set names, instead of pinning every `ModelItem` in the model until the last set is done), and a search set now calls `SelectionSet.GetSelectedItems()` for real membership, falling through to re-running the search only when that answers empty — because "the set selects nothing" and "the set was never evaluated in this headless session" must not be reported as the same thing (P0-3's empty-as-answer rule). `selection_sets.membership_resolved` still records which case applied, on its own `sets` progress stage, explicit-vs-search kept apart. Fallback path, complete in all three places P0-3 names: the cache records the set WITHOUT members and warns `SEARCH_SET_UNRESOLVED`; the engine REFUSES a filter naming it (`AssetCatalogConfigReason.unresolved-selection-set`) rather than returning empty-as-answer; and the desktop blocks publication before that — `saveProfile` refuses and screen 9 disables Save and prints why, naming the set and both ways out (M10; `project-service.test.mjs`, incl. a v1 cache whose saved search is read as unresolved because a v1 writer never resolved one). `GetSelectedItems()` itself is VERIFY-ON-WINDOWS; resolution against real Navisworks is gate 15's proof run — `scripts/windows-proof/search-sets.mjs` |
| 17 | Navisworks support claims match verified versions | code GREEN, claims match. `SupportedAdapters.cs` now labels all three years (2024, 2025, 2026) `stub-compiled-unverified` — 2025 was carrying the stronger `pending-real-proof` label, which the table itself defines as "compiles against the real Autodesk assembly", and no build in this repository's history has ever done that; every adapter build, CI included, has used `native/navisworks-stubs`. README's support table and docs/PRODUCT.md §0 read the same table and were corrected with it. Still open: an actual `verified` year, which needs gate 14 |
| 18 | Application signed | BLOCKED: needs certificate |
| 19 | Update path works, sends no project data | open (pipeline) / signing blocked |
| 20 | Win/mac/Ubuntu/integration/migration/security/native tests green | code GREEN on mac/Ubuntu (this machine has no Windows to run the win leg). Suite: 2326 tests, 0 failures. Windows-specific legs (native-smoke's launcher run, package-smoke, navisworks-proof) are CI-only and unrun here — see gate 14 |
| 21 | Clean-machine Windows install E2E | BLOCKED: needs Windows |
| 22 | No P0 TODO / VERIFY-ON-WINDOWS / false UI statement remains | GREEN on the sweep (M10, whole repo excluding `packages/legacy-parity`, `node_modules`, build output). **Markers:** zero Matchline-authored `TODO`/`FIXME`/`XXX`/`HACK` — the only hits are this row itself and 56 `"TODO"` MIME-table *values* inside the vendored SheetJS bundle. **VERIFY-ON-WINDOWS:** count at M10 was 42; recounted 2026-09-04 after the audit's work packages (`grep -rn "VERIFY-ON-WINDOWS" native/ docs/ | wc -l`): **52 flags** — 44 in `native/**` (mostly the rewritten `DocumentWalker.cs`, 24, and `MatchlineExtractAddIn.cs`, 7, from the sets/membership/NWF/authoring-id work), 4 in `docs/WINDOWS-RUNBOOK.md`, 1 each in `docs/EXTRACTION.md` and `docs/AUDIT-2026-09-02-NWD-TO-SSM.md`, and 2 in this document quoting the flag system. None claims to be verified — there is not one checked `[x]` box anywhere in the repo, the runbook's 29 boxes are still all empty, and every verb near a flag is still a negation. **False UI statements:** none. The only gate-relevant user-facing string (`extraction-messages.ts` `ADAPTER_UNVERIFIED`) is a denial; no UI string mentions signing, updates or version verification at all, and signing/updater/2024-2026/real-proof/clean-machine are each denied in README, INSTALL-TRY-IT, DECISIONS, RELEASE-RUNBOOK and STATUS. Non-blocking cleanup left for the docs pass, all understating rather than overstating: six statements that `scripts/windows-proof/*.mjs` "do not exist yet" (all seven landed), four stale VERIFY flag counts of 30 (35 today) and one stale `native/navisworks-2025/` path in the runbook |

## P0 findings (semantics binding)

**P0-1 Multi-model universe.** Compiler consumes a ModelUniverse (many
ModelSources: sourceId, displayName, rawFileName, rawSha256, cacheSha256, cache,
assignments) — not one cache. Object/source-model/selection-set identities
namespaced by sourceId via typed ModelObjectKey {sourceId, objectId} — never
ad-hoc string concatenation. Property Catalog aggregates across sources with
per-source + overall coverage. One authoritative asset universe; duplicate tags
detected within one NWD, across NWDs, across source models. Same-basename files
coexist. Replacing one source invalidates only its cache + dependent stages.
Federated vs split representations of one site produce equivalent canonical
outputs (provenance differences excepted). Project store: source_id-keyed
sources table (role, logical_name, raw_file_name, raw_sha256, raw_byte_size,
derived_cache_sha256, added_at); no absolute paths in the portable project;
v3→v4 migration with opt-in, backup, frozen v3 fixture, row-preservation +
duplicate-basename tests.

**P0-2 Direct NWD drop extracts.** Electron-main NavisworksExtractionService:
drop NWD → register logical source → STREAM sha256 → detect installed adapter →
launch Matchline.Extractor → stage/progress/warnings → cancellation → validate
cache → associate automatically → universe updates → wizard continues. User
never sees .matchline-cache. Serial extraction queue by default. Full error
vocabulary (not installed / unsupported version / too-new NWD / open failed /
NWF refs missing / cancelled / cache corrupt / plugin failed / no objects /
set extraction partial). Source rows show queued/hashing/opening/extracting/
finalizing/ready/cache-hit/cancelled/failed/file-changed. A raw NWD is not a
ready source until a valid cache is associated.

**P0-3 Real 2025 proof.** Update WINDOWS-RUNBOOK for the in-app service first.
Resolve every VERIFY-ON-WINDOWS against real assemblies (Models, RootItem,
FileName, persistent ids, child order, InstanceGuid, BoundingBox, category
naming, Variant formatting, set traversal, explicit membership, ModelItem
equality, Search Sets, plugin loading, open behavior, cancellation, atomicity,
too-new classification, NWF missing refs). Search Sets: preferred = resolve real
membership (explicit-vs-search recorded, members cached, progress); fallback =
mark unusable for filtering + block profile publication + explain; never return
empty-as-answer. No client data committed — anonymized counts/timings only.

**P0-4 Manual parents honor boundaries.** Manual = strongest candidate, wins
competition, still folds. Cross-boundary manual → dependency + provenance
records manual origin + boundary demotion + visible review item. Manual
make-root stays final. No "force structural across boundary" in 1.0.
Acceptance: RIO(650) manually parented under Panel(603) → flow unchanged, RIO
roots in 650, Panel a dependency, both provenances present, generated MEL lists
Panel as dependency not parent.

**P0-5 Default hierarchy.** Building boundary=true; SSM Discipline visible,
boundary=FALSE (startup families cross native disciplines: MAH/PLC/VFD/TIT one
branch); System boundary=true comparing System Key. UI must not call
all-three-structural standard. Pre-publication confirmation step summarizing
levels, boundaries, comparisons, cross-boundary consequence. DONE in M4c: screen
9's "Before you publish: check the boundaries" card, and Save revision stays
disabled until it is confirmed — once per publish, reset by every profile edit.

**P0-6 Level key vs display.** HierarchyLevelConfig gains keyAttributeKey /
displayAttributeKey? / boundaryAttributeKey? (defaults collapse to key).
Standard System level: key=systemKey, display=systemLabel, boundary=systemKey.
Description/label edits never move equipment; revision diff reports label
change, not a system move. Migrate old single attributeKey.

**P0-7 Derived attributes.** Versioned profile-level registry:
DerivedAttributeDefinition {attributeId, displayName, resolverChain} with
resolver kinds model-property (ordered PropertyRefs) / tag-segment /
source-assignment / system-field / composite / mel-lookup / manual. Profile
defines fields; compiler resolves deterministically; Composer selects them;
rung provenance; missing stays missing; no fallback value feeds a boundary;
display changes never change grouping identity. Built-ins remain.

**P0-8 Source assignments + per-source mappings.** Assignment scopes: object
property > source-model assignment > logical-file assignment > confirmed
filename-pattern rule > unresolved/review. Profile carries assignment rules
(e.g. source model X → Building B14; Mechanical.nwd → Native Discipline
Mechanical; pattern-derived). Standard fields accept ordered fallback property
chains + optional per-source overrides; migrate existing single mapping to a
one-rung chain.

**P0-9 Stable asset identity.** Identity evidence order: profile-mapped stable
id property > source persistent id + authoring object id > source persistent id
+ InstanceGuid > deterministic source-relative structural key > tag (last-resort
reconciliation only). Content hash never part of identity. Project persists
asset identity ledger {assetId, currentCanonicalTag, aliases, modelIdentities}
so tag corrections keep assetId, manual system/relationship/review decisions
survive, diffs report tag-change not remove+add. Migrate tag-keyed overrides
via latest snapshot; unmappable overrides become orphaned-decision review items,
never dropped. Tests: tag correction w/ same InstanceGuid, content hash change,
tree move, duplicate-tag split, source rename, orphaned override.

## Performance / isolation
Streaming SHA-256 (no full-file buffers). Main process never blocked by
hashing/parsing/compiling/diffing/exporting: child process (extraction),
worker_threads (compiler), streaming I/O, paged IPC, cancellation. Scale tests:
multi-cache ≥250k objects aggregate, ≥40k assets, ≥1M property rows, shuffled
source order determinism, responsive event loop during compile. No absolute
extraction-time gates — record stage timings.

## SiteProfileV2
One versioned profile: mappings (incl. per-source + fallback chains), source
assignments, filters, anatomy, resolver, derived attributes, hierarchy levels
(key/display/boundary), boundaries, role graph, ladder, discipline projection,
explicit parent properties, identity normalization/aliases, authority rules,
profile test examples. Project-specific stays outside (e.g. captured EXTO
template). Profile package format v2; v1 imports migrate, never refused.

## One-hour UX
Quick Setup path with data-driven suggestions (tag/description/type/building/
area/discipline/system/parent-tag/WBS/manufacturer/model-number/functional-
location properties, anatomy, system key segment, description join, source
assignments, class filters, levels, boundaries, role pairs); never silently
published; one-click accept with preview + impact counts. Resolver starter
templates (model field / tag+MEL / UPN+MEL / direct column / composite /
manual-only). Commissioning language everywhere.

## Adapters 2024/2025/2026
Smallest Autodesk-specific surface; detection names the version that will open
the file. Advertise ONLY compiled-and-exercised versions; 2025 must pass the
real proof; 2024/2026 beta/unverified unless proven. Hosted Windows CI for
non-Autodesk build/tests; self-hosted Windows/Navisworks jobs for adapter
tests; graceful behavior when the runner is absent.

## Updater / signing / release
Signed installer + binaries, release artifacts, update manifest, optional auto
+ manual update check, disableable, no telemetry, zero project data in
requests, graceful offline, manual installer path, update failure cannot
corrupt app or projects, migrations stay opt-in+backup. Artifact repo
(Matchline-Releases) or signed static feed. No hardcoded credentials; Actions +
electron-builder consume secrets; release-tag workflow FAILS LOUDLY without
production signing — never silently publishes unsigned 1.0.0. Owner release
docs.

## CI matrix
Hosted: ubuntu/macos/windows node+package+integration, windows packaging smoke,
C# Autodesk-free smoke, stub compile. Self-hosted: real plugin compile, real
extractor smoke, TS cache validation, cache-hit, cancellation, Selection Set,
Search Set (or gate), error classification. Acceptance areas A–G (multi-model,
hierarchy, relationships, identity, resolver, migration, distribution) per the
directive.

## Docs cleanup
Rewrite README (product, local-only, verified Navisworks versions, workflows,
contributor+release docs, no-client-data policy). Update PRODUCT/ENGINE/APP/
EXTRACTION/DECISIONS/STATUS/WINDOWS-RUNBOOK/INSTALL-TRY-IT/CHANGELOG. Remove
stale claims (TS-only dependency, manual cache handoff as normal flow,
all-structural default, manual bypass, single-cache, unverified 2024/2026).

## Milestones
1 Safety baseline (branch, baseline counts, failing acceptance tests staged) —
2 Multi-model domain+storage — 3 Stable identity — 4 Hierarchy+profile
semantics (incl. manual-parent fold) — 5 Integrated extraction service —
6 Real Windows proof — 7 2024/2026 adapters — 8 Perf+UX — 9 Distribution —
10 RC (clean-room, matrix, real pilot, 0.8.1 migration test, 1.0.0-rc.1;
final 1.0.0 only when all hard gates hold).

Commits: focused groups (test gates / multi-model / identity / profile v2 /
manual-parent fix / extraction service / adapters / perf / release / docs /
version). Only green work committed. Never bless changed output by editing
tests except where the new behavior is explicitly required above. Never discard
provenance or review items to make tests pass.

## Final report to Noah
Branch+commit, version, architecture summary, every migration, files/packages
changed, test counts by category, CI by OS, real Navisworks results (version,
counts, sets, timings, warnings, cancellation/cache-hit), multi-model results,
identity migration result, signing/update result, remaining limitations, and a
verdict: READY FOR 1.0.0 / READY FOR 1.0.0-RC ONLY / BLOCKED — evidence-backed
only.
