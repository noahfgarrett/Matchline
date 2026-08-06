# Handoff — SSManagement (paste this whole document as the opening prompt)

You are picking up **SSManagement**, a single-file offline web app that compiles
a Start-Up System Matrix (SSM) for industrial commissioning from standard
project documents. The work that used to take a team of engineers months —
building the equipment hierarchy by hand — this app does in one build, with
humans reviewing and massaging the result. The owner is Noah Garrett
(commissioning engineer, LotusWorks). Everything below is current truth as of
v4.2.0, 653 tests green.

## What the app does

Inputs (drag-and-drop Excel/CSV/XER, all detected automatically):
- **MEL** (Master Equipment List) — the only required input; the equipment
  universe. Columns: Equipment Tag, Equipment Description, Bldg, Discipline,
  UPN, System Description, System Parent Equipment Tag(s), Project Phase.
- **Easy Power export** — the electrical feed hierarchy (source → downstream).
- **Cable schedule** — Load Name (To) ← Panel (From) power edges.
- **PMD** — instrument → panel wiring.
- Optional: **P6 schedule** (XER/XLSX, milestones), **prior registry export**
  (training data for learned rules), **item-master template**, **P&ID line
  list**, and a **working copy** (live SSM export) for comparison.

Outputs: SSM register (xlsx), Completed MEL with backfilled parents +
provenance, optional EXTO upload sheet (Rev21 column map), UPN predecessor
matrix, QA scorecard, change-control sheet.

**Read `docs/HOW-IT-BUILDS.md` first.** It is the complete, current decision
logic: MEL-first seeding, identity tiers, the claims model with its priority
table, the partition fold with the electrical feed-chain exception, the
learned nesting pipeline with self-grading, milestone ladders, and the two
views. Do not guess at semantics that document already states.

## Repository and environment

- Local checkout: `/Users/noahgarrett/Codebase/SSManagement`
  (directory used to be named SSMCompiler; some memory/docs may reference it).
- GitHub: `noahfgarrett/SSManagement` (private source),
  `noahfgarrett/SSManagement-Releases` (public artifacts). The retired
  original app lives at `noahfgarrett/SSManagement-Legacy` (+`-Legacy-Releases`)
  and at `~/Codebase/SSManagement-Legacy` — do not touch it.
- Build: `npm run build` → concatenates `src/` into `SSManagement.html`
  (committed at repo root). Test: `npm test` (node --test, ~650 tests, ~30s).
- Single-file constraints: all `src/` modules are stripped of ESM and
  concatenated into ONE shared script scope by `build/build.mjs` (manifest
  order matters). Top-level names must be unique ACROSS modules. No runtime
  dependencies; SheetJS/fflate/PDF.js are vendored in `src/vendor/`.
  `assertKnownIcons` fails the build if you reference an icon id that is not
  in `src/ui/icons.js`.

## Architecture map (where things live)

- `src/io/detect.js` — sheet-kind detection (MEL/cable/PMD/registry/…),
  header-row scanning (rows 1–3+), loose tag-header forms gated by
  corroborating columns. `src/io/workbook.js` — dense+sparse AoA scan.
- `src/hierarchy/build.js` — buildMel (tag indexes, suffix identity),
  buildHierarchy pipeline, manual reparenting (`applyManualReparent`,
  undo/redo stacks, `similarNestingMoves` drag-to-teach), `emptyBuildDiagnosis`.
- `src/hierarchy/projection.js` — `buildCanonicalModel`: seeding, claims
  assembly (`addParent`/`addDependency`), the fold call, resolution, register
  synthesis, mode projections (`buildModeProjection` with `sameGroup` +
  `chainGroup`).
- `src/compiler/` — `fold.js` (partition fold + `keepCrossing`),
  `nesting.js` (learned roles/affinity/containment/self-grading),
  `itemmasters.js`, `ladders.js` (milestone rungs), `sequence.js`
  (`disciplinePolarity`), `rollups.js`, `edges.js`.
- `src/rules/` — engine (anatomy → normalize → classify), `defaults.js`
  (the shipped rule set, plain-language names/notes), provider with
  `ruleEngineGeneration()`. `src/profile/schema.js` — profile store, the
  universal built-in ("SSManagement Default", locked) + starter ("New Site
  Profile"), `makeLegacyEagleProfile()` (frozen baseline, not in the picker),
  `addTaughtSuffixRule` (highlight-to-teach backend).
- `src/ui/` — screens (upload/sheets), result (tree, search, drawer,
  teach-strip selection UI), studio (profile sections incl. Visual Trainer),
  legend-trainer (PDF legend extraction + lasso), progress/icons.
- `src/update/private-update.js` — updater. Channel:
  `noahfgarrett/SSManagement-Releases`; asset selection is suffix-based;
  BOTH channel names (SSManagement/SSMCompiler-Releases) are trusted.
- `src/review/panels.js` — review + comparison panels (buckets:
  off / gap / match / extra).

## Invariants you must not break

1. **Golden freeze.** `tests/golden/*.json` pin the ORIGINAL legacy behavior,
   captured under `makeLegacyEagleProfile()` (pinned explicitly in
   `tests/support/snapshot.mjs` and `legacy-differential.mjs`). If a golden
   diff appears, your change leaked into the legacy path — fix the leak.
   NEVER regenerate goldens to make tests pass. New behavior belongs in the
   modern profiles (gated on `melFirst` / `melSeed.enabled` or built into
   `makeDefaultProfile` with the legacy factory restoring the frozen values).
2. **Explicit attributes only for structural decisions.** Partition keys,
   the feed-chain exception, and priority adjustments require
   `record.context.explicit.*`. Profile FALLBACK values (e.g. discipline
   fallback "Electrical") must never drive fold/priority/nesting decisions.
3. **Never mutate rule arrays in place.** `applyNormalize`/classify compile
   caches are WeakMap-keyed on the rules ARRAY identity; replace the array
   (see `addTaughtSuffixRule`) or you serve stale compiled rules.
4. **Claims, not writes.** Sources contribute claims with priority +
   provenance; resolution decides. Manual overrides outrank everything and
   bypass the fold. Contradictions surface in review — nothing is silently
   rewritten.
5. **Locked profiles persist nothing.** Built-in = locked reference
   (session-only overrides, no learned models). Teaching flows must refuse or
   route with a clear toast.
6. **Confidentiality.** Client documents (site SOP, registry exports,
   templates) are private — never commit them, never encode client names in
   code, tests, fixtures, or public release notes. Conventions live as
   generic rule data. Fixtures are invented.
7. Auth tokens/credentials never appear in the public updater path.

## Gotchas that will bite you

- Some files contain a literal `` control byte (KEYSEP): grep them with
  `grep -a`, and exact-match editing can fail on invisible characters —
  verify bytes (`sed -n 'Np' | cat -v`) before assuming a mismatch.
- `tagKey`/`cleanTag`/`cleanRegisterTag`/engine resolve are memoized, all
  invalidated via `ruleEngineGeneration()` (bumped by `setRuleProfile` /
  `invalidateRuleEngine`). If identity behavior "doesn't change" after a rule
  edit, you forgot to go through those.
- Workbooks are read `{dense:true}`; `sheetAoa` has dense+sparse paths that
  must stay byte-identical (`tests/aoa-dense.test.mjs`).
- Browser testing: drive the built HTML over localhost; a hidden pane starves
  requestAnimationFrame — patch `window.requestAnimationFrame = cb =>
  setTimeout(() => cb(performance.now()), 0)` before driving, and expect
  background throttling to inflate timings anyway.
- The VM test harness (`tests/support/harness.mjs`) strips the boot block; the
  fallback active profile is the modern built-in. `buildProjectApp` in
  `compiler-harness.mjs` activates an editable project profile — use it for
  compiler-behavior tests. Fixtures are generated by
  `tests/support/make-fixtures.mjs` (deterministic; rerun after editing).
- Fixture tag names matter: letter endings (-A/-B/-C) are panel sides the
  modern profiles MERGE — use digit endings in fixtures unless testing that.
- The Legend Trainer's PDF path only runs in a real browser (PDF.js is
  skipped in the VM harness) — UI wiring bugs there never fail tests, so
  verify in-browser.

## Working conventions (Noah's expectations)

- Branch per change (`feat/`, `fix/`), conventional commits, merge `--no-ff`
  to main, push. Never commit directly to main.
- Tests FIRST for bugs (reproduce red → fix → green). Full suite must pass —
  zero failures — before any release.
- UI changes get real-browser visual verification, not just tests.
- User-facing text is plain language: what it does, an example, when to
  change it. No implementation talk in the UI.
- "Stupid easy" UX, sophisticated backend: one-click flows in front of
  ordinary, inspectable profile rules behind.
- Release every completed increment: bump `package.json` version +
  `APP_VERSION` in `src/update/private-update.js` + prepend
  `src/changelog.json` entry (types: feature|fix|major; entry[0].version must
  equal pkg.version) → build → test → commit/merge/push → copy
  `SSManagement.html` to `SSManagement-vX.Y.Z.html`, `gzip -9 -k`, then
  `gh release create vX.Y.Z -R noahfgarrett/SSManagement-Releases` with BOTH
  assets. Versioning continues the SSManagement lineage (4.x).

## Current state and open threads

Done and verified: MEL-first compile with diagnosis-on-empty; suffix identity
unification; learned classification/nesting with per-class self-grading
(claim ≥85% precision over ≥10, else propose) persisted in the profile;
drag-and-drop massaging with undo/redo and reviewable drag-to-teach;
milestone ladder + polarity sequencing; EXTO layer (optional); comparison
tab with directional buckets; teach-a-suffix from a highlighted tag ending;
electrical feed-chain fold (chain persists within building+discipline,
feed beats MEL System Parent for that gear, breaks at building/discipline
boundaries); large-workbook perf (dense parsing, memoized identity,
precompiled rules); Visual Trainer/test-tab caching + post-build prewarm.

Known follow-ups (not started):
1. `computeSequence` still numbers within (building|discipline|system)
   groups — a feed chain spanning systems does not sequence continuously
   down the chain. Noah may want chain-ordered sequencing for top-down
   disciplines.
2. Real-data trials may justify promoting more nesting classes to
   claim-grade, and tuning the containment guards.
3. The comparison "gap" bucket is the live findings list — expect iteration
   after Noah runs it against the site working copy at scale.

When in doubt about intent: the register/EXTO output must match what a
commissioning team would hand-build under their SOP — hierarchy correctness
beats cleverness, provenance beats magic, and nothing user-facing should
require reading this document to understand.
