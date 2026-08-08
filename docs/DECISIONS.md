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

## Open items (not yet decided)

- Code-signing certificate (MSIX): long-lead item, start before Phase 6.
- Duplicate-model-tag resolution policy detail (review item + explicit pick; refine in Phase 2).
- Linter adoption (ESLint) — no linter configured yet; decide in Phase 1.
