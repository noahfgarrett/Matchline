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
| 1 | Drop one raw NWD → automatic extraction | open |
| 2 | Several NWD/NWC/NWF sources in one project | open |
| 3 | Split AND federated model organization | open |
| 4 | Duplicate basenames coexist | open |
| 5 | Global / per-source / ordered-fallback metadata mapping | open |
| 6 | Source-level Building/Discipline/custom assignments | open |
| 7 | Arbitrary model-derived hierarchy levels | open |
| 8 | System level: Key = identity/boundary, Label = display | open |
| 9 | Manual parent cannot violate an enabled boundary | open |
| 10 | Cross-System parents become dependencies | open (holds today for claims; manual pending) |
| 11 | Default SSM Discipline level nonstructural | open |
| 12 | Stable asset identity survives tag correction | open |
| 13 | 0.8.1 projects migrate with backup, no silent decision loss | open |
| 14 | Real Navisworks Manage 2025 extraction proof | BLOCKED: needs Noah's Windows box |
| 15 | Selection Set behavior verified | BLOCKED: same |
| 16 | Search Sets fully implemented or honestly blocked | open (code side) / verify on Windows |
| 17 | Navisworks support claims match verified versions | open |
| 18 | Application signed | BLOCKED: needs certificate |
| 19 | Update path works, sends no project data | open (pipeline) / signing blocked |
| 20 | Win/mac/Ubuntu/integration/migration/security/native tests green | open |
| 21 | Clean-machine Windows install E2E | BLOCKED: needs Windows |
| 22 | No P0 TODO / VERIFY-ON-WINDOWS / false UI statement remains | open |

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
levels, boundaries, comparisons, cross-boundary consequence.

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
