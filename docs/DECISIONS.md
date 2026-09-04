# DECISIONS — locked calls

Canonical log of product/engineering decisions that are not derivable from code.
Newest last. "Locked" means: do not relitigate without Noah.

## 2026-08-07 — plan-review resolutions (Noah)

1. **Hard boundaries, no feed-chain exception.** The SSM hierarchy separates equipment by
   building, discipline, and system as hard structural boundaries. The parent's feed-chain
   exception (top-down-discipline chains nesting across system boundaries) is NOT carried
   over: a cross-boundary feed always demotes to a dependency (the panel 603 → RIO 650
   example in PRODUCT.md §2.5 is the intended behavior). Physical chains stay visible and
   intact in the Electrical Flow projection only.

   > **Amended 2026-08-11 (see the 1.0-campaign section below).** Two parts of this entry
   > were carried into the E3 engine in a way 1.0 reverses.
   > **(a) Manual parents are not an exception either.** The 0.4.0 engine let a manual
   > override bypass the fold — recorded as "manual overrides bypass the fold" in
   > CHANGELOG 0.4.0 and "manual bypasses fold" in the STATUS E3 entry. Both statements
   > are **superseded**: manual wins the ladder and then folds like anything else. The old
   > wording is left in place because those entries are history, not current behaviour.
   > **(b) "Building, discipline and system" describes what a boundary *means* when it is
   > enabled, not which levels a new project *enables*.** The default preset enables
   > Building and System only; SSM Discipline is a visible grouping level with
   > `boundary: false`. A boundary that is enabled is still hard.
2. **Legacy parity scope.** Donor tree stays runnable in `packages/legacy-parity` (full 656
   tests, goldens archived, never regenerated). Only a targeted subset of inherited behaviors
   (fold, claims resolution, tag identity) is ported as executable parity tests in new packages.
3. **Learned rules are v1 scope.** Description→classification training, per-class role gates,
   self-graded precision (claim-grade vs reviewable proposal) carry into Matchline: inference
   in Phase 4, profile persistence and training UX in Phase 5.
4. **Commissioning outputs phase.** P6 import, milestone ladders, sequencing polarity,
   predecessor matrix, and EXTO export form a dedicated phase between Phase 4 (SSM compiler)
   and Phase 5 (Site Profile Studio). EXTO and predecessor outputs are first-production scope.
5. **Stack approved** (explicit dependency sign-off): Electron, React, TypeScript, Vite,
   TanStack Table/Virtual, dnd-kit, Zod — all pinned exact versions. Trims: prefer Node's
   built-in `node:sqlite` over a driver dependency; no Zustand initially (add only if React
   state demonstrably isn't enough).
5b. **Letter-suffixed tags are distinct identities.** Inherited from SSManagement
   v4.2.1/4.2.2 and carried forward as policy: `-A`/`-B`/`-C` endings name separate
   equipment, never variants to merge. Identity tiers, anatomy keys, and learned-rule
   containment guards are all built to refuse sibling merges; a site that wants an
   ending merged teaches it explicitly (alias / normalize rule).
6. **Fixture-site codename is "Dragon".** All invented fixture/model data uses the Dragon
   site. (The donor's "Falcon" mock site was likewise fictional — confirmed not a client
   name; donor history was audited and is clean.)
7. **Naming.** Repo `noahfgarrett/Matchline` (private), local `~/Codebase/Matchline`,
   releases repo `Matchline-Releases` when the updater lands.

## 2026-08-07 — confirmed platform constraints (research, not preference)

- Extraction requires a **licensed Navisworks Simulate/Manage install** on the machine:
  Freedom has no API, and there is no redistributable NWD engine. This is a stated product
  requirement, surfaced in docs and first-run messaging.
- The C# worker targets **.NET Framework 4.8** (Navisworks 2021–2026 all remain on it).
- **NWD has no forward compatibility**: an adapter built against version N cannot open
  files published by version N+1. The app needs a clear "this file needs a newer
  Navisworks" error from the first release, and adapter selection picks the newest
  installed Navisworks version.
- Dev environment: Noah has Navisworks Manage and a Windows machine for extraction work;
  Mac is primary for UI/compiler development against captured extraction fixtures.

## 2026-08-08 — build-out calls (coordinator, within delegated authority)

- electron-builder 26 adopted for packaging (devDependency, exact pin); unsigned builds
  until the code-signing certificate lands. No publish/updater config — the app never
  phones home.
- The desktop package version tracks the product version (0.6.0+) so installer names,
  app.getVersion(), and project-file stamps agree.
- Feed-chain-era note: parent's differential tests and wall-clock budget tests run
  locally only; CI excludes them by name pattern (machine-dependent path / shared-runner
  timing).

## 2026-08-11 — 1.0 release campaign (Noah, authoritative directive)

Source: `docs/RELEASE-1.0-PLAN.md` (directive dated 2026-08-09, P0-1 … P0-9). These are
**locked**: do not relitigate. The gate tracker in that file, not this one, records how far
each is proven.

8. **One model universe, not one cache.** A compile consumes a `ModelUniverse` — many
   `ModelSource`s, each with its own id, logical name, raw file name, raw hash, cache hash,
   cache and assignments. Object, source-model and selection-set identities are namespaced
   by `sourceId` through a typed `ModelObjectKey`, never by string concatenation. Duplicate
   tags are detected within one file, across files and across source models; files sharing
   a basename coexist; replacing one source invalidates only its cache and the stages that
   depend on it; split and federated representations of one site produce equivalent
   canonical output. (P0-1; project schema v4.)
9. **Manual parents fold.** A manual parent is the strongest candidate and wins the
   competition, and then goes through the boundary fold like any other parent. Crossing an
   enabled boundary demotes it to a dependency, with provenance recording both the manual
   origin and the demotion, and a visible review item. Manual make-root stays final. There
   is no "force structural across a boundary" control in 1.0. **This supersedes the E3
   manual-bypass behaviour** — see the amendment on entry #1. (P0-4; gates 9–10.)
10. **The default SSM Discipline level is nonstructural.** New projects get Building
    (boundary), SSM Discipline (grouping only), System (boundary, comparing the System
    Key). A startup family — mechanical unit, controls panel, drive, instrument —
    deliberately crosses native disciplines, and a structural discipline would cut one
    family into four roots. No UI may describe all-three-structural as the standard. A
    pre-publication step summarises the levels, which boundaries are enabled, what each one
    compares, and the cross-boundary consequence, and publication waits on confirming it.
    (P0-5; gate 11.)
11. **A hierarchy level's key and its label are different fields.** `HierarchyLevelConfig`
    carries `keyAttributeKey`, optional `displayAttributeKey` and optional
    `boundaryAttributeKey`, defaulting to the key. The standard System level keys and
    compares on System Key and displays System Label, so editing a description never moves
    equipment and the revision diff reports a label change rather than a system move. The
    old single `attributeKey` migrates. (P0-6; gate 8.)
12. **Stable asset identity, in a persisted ledger.** Evidence order: profile-mapped stable
    id property > source persistent id + authoring object id > source persistent id +
    InstanceGuid > deterministic source-relative structural key > tag, and tag only as
    last-resort reconciliation. A content hash is never part of identity. The project
    persists `{assetId, currentCanonicalTag, aliases, modelIdentities}` so a corrected tag
    keeps its `assetId`, manual system/relationship/review decisions survive, and diffs
    report a tag change rather than a remove plus an add. Overrides that cannot be mapped
    become orphaned-decision review items; they are never dropped. (P0-9; project schema
    v5; gate 12.)
13. **`SiteProfileV2` — a site's decisions are one document.** One versioned profile holds
    mappings (with per-source overrides and ordered fallback chains), source assignment
    rules, filters, anatomy, resolver, derived attributes, hierarchy levels with their
    key/display/boundary attributes, boundaries, role graph, ladder, discipline projection,
    explicit parent properties, identity normalization and aliases, authority rules and
    profile test examples. Project-specific configuration stays outside it — the captured
    EXTO template is the only thing left in the project `config` table. Profile package
    format v2; v1 packages migrate on import and are never refused. Standard fields take
    ordered property chains with optional per-source overrides, and existing single
    mappings migrate to a one-rung chain; derived attributes are a profile-level registry
    resolved deterministically, where a missing value stays missing and no fallback value
    ever feeds a boundary. (P0-7, P0-8, "SiteProfileV2"; project schema v6; gates 5–7, 13.)
14. **Adapters are labelled by what has actually been proven, never by what compiles.**
    `native/navisworks-common/Protocol/SupportedAdapters.cs` is the single source of truth
    and has exactly three states: `stub-compiled-unverified` (type-checks against our own
    hand-written stand-in — a compile check, not support), `pending-real-proof` (compiles
    against the real Autodesk assembly, proof run not completed), `verified` (extracted a
    real model on a real install, recorded). As of this entry: 2024, 2025 and 2026 are
    all `stub-compiled-unverified` and nothing is `verified`. 2025 carried
    `pending-real-proof` for a while, which this entry defines as compiling against the
    real Autodesk assembly -- something no build here has ever done. The label was
    corrected rather than the definition. No document, UI string or release note may
    claim more than this table says.
    Detection names the version that will open the file, and selection takes the newest
    installed. (Directive "Adapters 2024/2025/2026"; gates 14–17.)
15. **The release tag workflow fails loudly rather than shipping unsigned.** No hardcoded
    credentials: Actions and electron-builder consume repository secrets, and the signing
    gate is the first step of the release build, before any work happens. There is no
    unsigned release path. The update path, when it exists, must be optional, disableable,
    carry zero project data, degrade gracefully offline, keep a manual installer route, and
    be unable to corrupt the app or a project on failure; migrations stay opt-in with a
    backup. Neither signing nor the updater is implemented yet — the certificate is still
    an open item below. (Directive "Updater / signing / release"; gates 18–19.)

## Open items (not yet decided)

- Code-signing certificate (MSIX): long-lead item, start before Phase 6.
- Duplicate-model-tag resolution policy detail (review item + explicit pick; refine in Phase 2).
- Linter adoption (ESLint) — no linter configured yet; decide in Phase 1.
