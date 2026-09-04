# Audit — drop a Navisworks model, get a fully built SSM

**Date:** 2026-09-02
**Branch / commit:** `claude/matchline-1.0.0-hardening-20260810` @ `c8d740c` (1.0.0-rc.1)
**Question asked:** Can a user drop NWD/NWF/NWC files into Matchline and get complete
commissioning hierarchies (SSMs) out?
**Method:** Full build and every TypeScript suite run on this Mac; six independent
read-only code audits (native C#, extraction service, engine, wizard/exports,
proof/CI/packaging, project store); every Blocker and the top High findings
re-verified by hand against the source. No .NET toolchain exists on this machine, so
the C# was audited by reading only. Nothing in the repo was modified except this file.

---

## Verdict

**Not achievable today from an installed build, and not achievable from a dev build
without a human-authored profile.** The engine is genuinely rc-quality on the Dragon
fixture, but the end-to-end path has six independent blockers, three of which are
"the thing does not exist" rather than "the thing is buggy":

| # | Blocker | Stage | Verified |
|---|---------|-------|----------|
| B1 | The Windows installer ships no `Matchline.Extractor.exe`. Every dropped model on an installed app fails with `extractor-not-installed`. | Packaging | Yes, by hand |
| B2 | Nothing deploys the Navisworks plugin into the `Plugins\` folder, nothing ships a real-API-compiled adapter DLL, and a missing plugin is misreported as a generic `EXTRACT_FAILED` with "add the file again to retry". | Packaging / launcher | Yes, by hand |
| B3 | With the shipped default profile (Building and System are hard boundaries, no resolver, no building mapping) every asset becomes a root under `(unassigned)`. The compile succeeds, the workspace opens, screen 9 lists "Building — boundary", and nothing says "0 of N assets nested". | Engine + wizard | Yes, by reading both sides |
| B4 | The SSM tree view requests only the first 200 children of any node and discards `total`. A system with 350 assets shows 200 and looks complete. | Workspace | Yes, by hand |
| B5 | There is no export of the hierarchy tree. The generated MEL is the only carrier; it is flat, has no column for any non-default level (derived attributes such as Area/Level/Package), and encodes roots vs `(unassigned)` implicitly. | Exports | Yes, by hand |
| B6 | No timeout, stall detection or end-record detection anywhere in the launcher or the service. Any modal dialog under `-NoGui` (Autodesk sign-in, autosave recovery after the cancellation test, unknown plugin id) hangs the row forever and blocks the serial queue behind it. | Launcher + service | Yes, by reading |

B1 and B2 mean the first real Windows proof (gates 14–16) cannot even start from the
product; it can only start from a dev checkout with `MATCHLINE_EXTRACTOR_PATH` set and
a hand-copied DLL. B3 means that even after the proof passes, the honest outcome for a
user who takes Quick Setup at its word on a Revit-exported model is a flat tree.

---

## Current state, measured

| Suite | Result |
|-------|--------|
| `npm run build` (`tsc -b`) | clean |
| Workspace packages (19) | 1412 pass / 0 fail |
| Integration | 27 / 0 |
| Windows-proof script tests | 16 / 0 |
| 1.0 acceptance gates (all 7 files) | 44 / 0 |
| Legacy donor (CI skip pattern) | 641 / 0 (15 machine-specific skipped) |
| Scale (250k objects, deterministic twice) | 1 / 0, ~12.8 s |

Total 2155 with the 15 skipped, matching the CHANGELOG claim. Note the gate tracker's
"deliberately part red" acceptance set is now entirely green; the remaining red is all
hardware-blocked (gates 14–21), not test-blocked.

The suite proves the engine on 34–47-asset Dragon fixtures with fully populated
profiles. It does not prove: an empty profile, an untagged or duplicate-tagged model,
unicode tags, unresolved systems at a boundary, any Revit/Plant3D-shaped property
catalog, any renderer behaviour (there is no Playwright config and no renderer test),
or anything about real Navisworks.

---

## What is solid

- **Security posture of the desktop shell.** Exact-origin sender check + Zod request
  and response parse on every channel, sandboxed renderer, `default-src 'none'` CSP,
  path grants only from native dialogs, temp-then-rename on every export. Nothing
  found that can write outside a dialog-chosen path or corrupt a project file.
- **Determinism.** Every list leaving a stage is content-sorted; the shuffled-source
  fingerprint test exercises it; no Map/Set ordering hazards found in the engine.
- **The Autodesk-free half of the native layer.** NDJSON hand-off, atomic
  `.partial` commit, DDL byte-identical to `schemas/extraction-cache.sql`, cancel
  path cleans partials on every exit. The stubbed API member names are, with the
  exceptions listed under High, likely to compile against the real assembly.
- **Protocol fidelity between the fake launcher and the C# launcher.** Argument
  names, line shapes, stage names, exit codes and partial naming all match. The
  Windows-only surprises are in what the launcher does not do, not in the protocol.
- **Store transactions and migrations.** Every mutator is one `BEGIN IMMEDIATE`
  transaction; compile save is one transaction; rollback-journal + `synchronous=FULL`;
  v1→v6 steps drop nothing; newer-version files are refused without a write.
- **Identity ledger** never merges two assets into one id, never deletes, reports
  splits, and orphaned overrides become review items with the note preserved.

---

## Findings by stage

Severity: **Blocker** = stops the goal outright; **High** = wrong output, silent loss,
or a missing capability the goal needs; **Medium** = degrades the goal or the
"one hour" target; **Low** = hygiene.

### 1. Packaging and deployment

- **B1 — Launcher not shipped.** `apps/desktop/electron-builder.yml` has only `files:`;
  no `extraResources`. `extractor-launcher.ts:252-265` looks for
  `<resourcesPath>/extractor/Matchline.Extractor.exe`. CI builds the exe in
  `native-smoke` and discards it; `package-smoke` and `release.yml` never touch
  `native/`. `docs/WINDOWS-RUNBOOK.md:340` ("a packaged build ships the launcher
  beside itself") is false. The launcher's closure that must ship: the exe, its
  `.exe.config`, `Matchline.Extraction.Common.dll`, `Microsoft.Data.Sqlite.dll`, the
  four `SQLitePCLRaw.*` DLLs, `System.{Buffers,Memory,Numerics.Vectors,Runtime.CompilerServices.Unsafe}.dll`,
  and `runtimes\win-x64\native\e_sqlite3.dll`.
- **B2 — Plugin never deployed.** Required layout is
  `<install>\Plugins\Matchline.Extraction.Navisworks<year>\` with `Common.dll` beside it
  (`Matchline.Navisworks.Adapter.props:39-49`). Only mechanism in the repo is a manual
  `xcopy` as admin (runbook §4). Real-API DLLs are compiled only inside
  `navisworks-proof.yml`, which uploads nothing shippable. NSIS is `perMachine: false`
  while `Program Files\...\Plugins` needs elevation (the per-user
  `%APPDATA%\Autodesk Navisworks Manage <year>\Plugins` root may avoid that; the
  runbook itself says which root is scanned is unverified). The launcher never
  pre-checks the plugin folder (`ExtractionRunner.cs:131-138`).
- **High — Proof workflow proves an unknown binary.** `navisworks-proof.yml:115-121`
  compiles, then `:162-168` extracts with no deploy step; on a runner where someone
  hand-copied per §4, the DLL under test is whatever was copied last.
- **High — `MATCHLINE_NAVISWORKS_INSTALL_DIR` never reaches the launcher.**
  `proof-lib.mjs:95` reads it; `:270-272` passes only `--input`/`--cache-dir`. A
  Simulate-on-D: runner fails `NW_NOT_INSTALLED`.
- **High — Anonymizer crashes the proof scripts on their own diagnostics.**
  `proof-lib.mjs:464-473` writes a detail containing `/`; `LEAKY` at `:420` matches
  it; `writeReport` throws; no JSON, and `upload-artifact` then fails too, masking the
  cause. Reproduced locally. `scripts.test.mjs` always sets `MATCHLINE_EXTRACTOR_PATH`
  so this path is untested.
- **High — Release signing signs the wrong layer.** `release.yml:93-94` packages
  first, then signs `win-unpacked/Matchline.exe` and the Setup exe; the NSIS payload
  and portable zip were built from the unsigned tree. Gate 18, not goal-blocking.
- **Medium** — `test:windows-proof` is in `npm test` but not in `ci.yml`; no repo
  `.npmrc` so `ignore-scripts` is Mac-only and CI runs `electron-winstaller`'s install
  script; actions pinned by tag not SHA; `Directory.Build.props` stamps `0.1.0` into
  `meta.extractor_version` while the app is 1.0.0-rc.1; package smoke asserts only
  that files exist and would pass with no extractor (it does); the hosted Windows
  `native-smoke` builds the exe and never runs it, though it could settle the
  `e_sqlite3.dll` load question; "graceful when runner absent" (RELEASE-1.0-PLAN)
  is not implemented; runbook §2 says `git checkout main`, which has none of the
  proof files; INSTALL-TRY-IT still says 0.8.1 and "stock Electron icon".

### 2. Native extraction (C#)

- **B6 — No timeout / stall / end-record detection.**
  `NavisworksProcessRunner.cs:113-121` waits on Roamer forever, checking only cancel.
  `NdjsonProgressMonitor.cs` sniffs `prog` lines only and never sees the `end`
  record, so "plugin finished but Roamer did not exit" is indistinguishable from a
  hang. Runbook §7 "drop `-NoGUI`" would turn a failure into a hang.
- **High — No persistent per-object identity.** `objects.id` is a depth-first ordinal;
  `DocumentWalker.cs:283` hard-sets `AuthoringId = null`; `InstanceGuid` (`:270`) is
  `Guid.Empty` for most readers on real models. Stable for re-extraction of the same
  bytes, not across a republish, which is what the ledger is for. DECISIONS #12 puts
  "persistent id + authoring id" high in the identity ladder; the cache has neither.
  Fix: populate `authoring_id` from well-known internals (Revit `Id`/`UniqueId`, IFC
  `GlobalId`, DWG handle, `LcOaNode` GUID), record `SavedItem.Guid` for sets.
- **High — NWF handling.** Cache key is `sha256(NWF bytes)`; re-exporting the
  referenced NWCs never changes it, so the cache is a permanent stale hit. Missing
  references produce fewer models, `end.ok=true`, a valid committed cache and no
  warning (`DocumentWalker.cs:95-129`; `MatchlineExtractAddIn.cs:134` refuses only
  `Models.Count == 0`). Same conclusion reached independently by the service audit.
- **High — `NW_VERSION_TOO_NEW` is unreachable.** Classification reads Roamer
  stdout/stderr, which a GUI exe never writes; `Document.TryOpenFile` swallows the
  real message and the adapter's own "could not open" text is classified
  `OPEN_FAILED` and never reclassified (`ExtractionRunner.cs:181`). DECISIONS calls
  this mandatory messaging.
- **High — Search-set resolution.** `search.FindAll(document, false)` at
  `DocumentWalker.cs:681`; the stub guesses the bool means "do not select", the real
  API's second argument is (to the auditor's knowledge) `includeHidden`. Membership
  would silently exclude hidden items while the walk includes them. Prefer
  `SelectionSet.GetSelectedItems()`.
- **High — Property keys are localised display names; no units recorded.** Catalog
  keys on `(DisplayName, DisplayName)`; internal names are captured but unused for
  mapping. `Document.Units` is never written to `meta`, so lengths/bboxes from two
  models in different units are incomparable.
- **Medium** — `Application.Version.ToString()` will most likely record the type name
  (`ReflectionProbe` accepts any string); parent-death on stdin EOF is not treated as
  cancel; `Dictionary<ModelItem,long>` pins every item wrapper for the whole run
  (hundreds of MB inside Roamer at 250k+ items); `HasGeometry` gate means group and
  insert nodes (the equipment) get `NULL` bbox; hidden/layer/insert flags not
  recorded; nested appended models misattributed to the top-level model;
  `EXTRACT_FAILED` conflates plugin-not-found / plugin-crashed / Roamer-crashed;
  `SupportedAdapters` labels 2025 `pending-real-proof`, which DECISIONS defines as
  "compiles against the real assembly" — it has only compiled against stubs; locator
  probes `Program Files` paths only, no registry, and the app never passes
  `--navisworks-dir`.
- **Low** — unbounded `WaitForExit()` after a failed kill; `DateTime` shifted by
  machine timezone (breaks determinism promise); `sets` stage missing from
  EXTRACTION.md; `AddInLocation.None` for a headless plugin.

**VERIFY-ON-WINDOWS flags.** 32 flagged sites reviewed one by one. Most member names
and shapes are likely correct. Likely wrong: `Application.Version` as string, the
`FindAll` bool, `HasGeometry` as a bbox gate, and the "too new" wording fragments
(unreachable anyway). Unknowable without hardware: per-user vs install-dir Plugins
root, unknown-plugin-id message box under `-NoGui`, `e_sqlite3` probing on net48.

**Predicted order of failure on the first real run:** (1) plugin not in Plugins folder
→ `EXTRACT_FAILED` in seconds; (2) a dialog under `-NoGui` → hangs forever;
(3) packaged app can't find the launcher; (4) cache spot-check shows
`navisworks_version` garbage, `authoring_id` all null, bbox only on leaves;
(5) search sets exclude hidden items; (6) `NW_VERSION_TOO_NEW` never appears;
(7) an NWF with moved references yields a small, valid, permanently cached tree.

### 3. Extraction service (Electron main)

- **High — Orphaned Navisworks on quit.** `shutdown()` writes `cancel` and `kill()`s
  in the same tick; on Windows that is `TerminateProcess`, so the launcher dies before
  its stdin listener can kill Roamer; no Job Object anywhere. A headless Roamer keeps
  the license and RAM and keeps writing `.ndjson.tmp` after TS deleted it. No
  "extraction in progress" prompt on quit.
- **High — `--input-sha256` is trusted and the file is never re-checked before
  launch.** Hash at registration, launch possibly hours later (serial queue). A model
  re-issued in place is extracted and stamped with the old hash; validation passes;
  the project records the wrong bytes. `file-changed` only fires at project reopen.
- **Medium** — re-adding identical bytes kills the run in flight; row visibly
  regresses `opening → hashing 100% → opening`; cache dir is roaming `%APPDATA%`
  while every doc and the launcher default say `%LOCALAPPDATA%`; reopen trusts a
  cache by filename without re-validating or checking `derivedCacheSha256`; a cache
  that fails TS validation is left in place, the launcher's inspector accepts it, so
  "add the file again to extract it fresh" can never work; partial cleanup is by
  hash not ownership (two sources with identical bytes can delete each other's
  files); SQLite disk-full is `SqliteException` not `IOException` → reported as
  `INTERNAL`; Mac users are promised extraction on screen 1 and then shown
  "Extraction failed"; cancel during self-hash reads the whole file; cancel after
  result-but-before-associate returns true yet the job settles `ready`.
- **Low** — `cancelled` copy says "Nothing was written" when a post-result cancel
  keeps the cache; `ADAPTER_UNVERIFIED` fires on every run with no dismissal;
  spawn failures other than ENOENT are generic; moved model with intact cache is a
  dead source.

### 4. Engine (cache → compiled hierarchy)

- **B3 — Flat tree by default.** `draft-profile.ts:64-89` enables Building and
  System boundaries; `compiler/src/compile.ts:444-448` substitutes `NO_SYSTEM_RESOLVER`
  when none is configured; `ssm-compiler/src/compile.ts:344-361` breaks the ladder on
  a `missing` boundary and roots the asset; `fold.ts:124-144` requires both ends to
  state a value at every enabled boundary. One unmapped field on either side (typical
  Navisworks models have no "Building" property) prevents every nesting on the site.
  Signal: `rootCount` and ~N per-asset `missing-boundary` items. No completeness
  count exists.
- **High — Duplicate-tag claims silently attach to whichever duplicate sorts first.**
  `identity/src/resolve.ts:73-105` returns `sharingAssets`; the compiler bridge at
  `compile.ts:554-557` ignores it and takes the first id by code-unit order. Verified.
- **High — MEL "System Parent" has no path into the hierarchy.** The donor's primary
  structural source (priority 900 in `legacy-parity/src/compiler/edges.js:44-48`) is
  read by `spreadsheet-import/src/mel.ts:26` and dropped by `compile.ts:163-181`;
  `LadderSourceKind` has no MEL rung; no DECISIONS entry records dropping it.
- **High — Rule-driven boundary demotions are silent; boundary compare is
  case-sensitive.** Only the manual rung raises a review item on demotion
  (`ssm-compiler/src/compile.ts:317-324`); `fold.ts:85-91,119` compares raw strings.
  `D1` from a property vs `d1` from an assignment rule demotes every cross-file parent
  with no item anywhere.
- **High — No review item for "system unresolved" or "no parent candidate at all".**
  Such assets are filed into `(unassigned)` with nothing in the queue. Conversely
  `missing-boundary` is per asset per level: 40k assets with no building → ~40k rows
  nobody can work.
- **High — Unicode tag hygiene regressed vs donor.** Donor `cleanTagRaw` did NFKC,
  zero-width strip, dash-family fold. New engine trims only; identity and resolver
  normalization offer `trim|uppercase|stripPrefix|padStart|alias`. An en-dash or NBSP
  in a Revit parameter never matches a cable schedule, never joins the MEL, and
  duplicate detection sees two tags.
- **Medium** — derived-attribute `manual` assignments are keyed by asset id but never
  re-addressed through the ledger (a re-keyed asset silently loses a boundary value);
  `mel-lookup` by tag is O(rows) per subject though a `byTag` index exists; fuzzy
  identity is O(assets) Levenshtein per unmatched string and runs for every
  unmatched endpoint (~10⁸ calls at scale); `prepare()` per `propertiesOf` call;
  the scale test prints durations and asserts no budget, passes no MEL/connectivity/
  ledger/learned inputs, and never reads review items; profile typos silently
  disable ladder tiers and level keys (no `validateProfile` at `compileProject`);
  MEL join is raw-exact while identity applies normalization and aliases.
- **Low** — `ssmDisciplineOf` trimmed-vs-untrimmed lookup; ledger `formatVersion`
  never checked on read; MEL rows with no tag/upn/description dropped uncounted;
  structural parent with no tag written to MEL as root; role vocabulary case drift
  between role graph and learned classes.

**Versus the donor's "complete SSM".** Reproduced: three grouping levels, nested
parent/child, typed dependencies (improvement), milestone ladder, sequencing,
predecessor matrix, EXTO/item-master/classification, revision diff. Deliberately
dropped and documented: feed-chain exception, fallback discipline/system labels.
Dropped without a decision record: MEL System Parent seeding, line-list piping
roll-ups, the *orphan* status (no parent, no dependencies, parents nothing), QA
Scorecard / QA Exceptions / Placement Review / Cross-Sheet Tag Review sheets, the
Completed-MEL `Contradiction`/`Proposed Parent` columns, unicode tag cleaning, and
a starter profile that inherits a working rule set (the new draft is empty).

### 5. Desktop wizard, workspace, exports

- **B4 — Tree truncates at 200 children.** `SsmTreeView.tsx:44` `CHILD_PAGE = 200`;
  `loadChildren` (`:114-127`) always `offset: 0`, stores `rows`, discards `total`.
  Main pages correctly (`compile-service.ts:811-813`); the renderer never asks again.
- **B5 — No hierarchy export.** `exports.ts` exposes generated MEL, template MEL,
  EXTO, predecessors, revision diff. `GeneratedMelAsset` carries no derived
  attributes, so any level a site adds has no column; level order, `(unassigned)`
  buckets, roots vs parents are implicit.
- **High — Suggestion engine is fixture-shaped.** `suggestions.ts`: `TAG_SHAPE`
  requires a separator (Revit `Mark` = `AHU1`/`P101` scores 0 on shape); building
  synonyms are `building/bldg/facility/site` and Revit `Level`/`Workset` route to a
  *derived* attribute nobody groups by, so no Building is ever proposed for a
  federated Revit NWD; `System Classification` is offered as the EXTO classification
  column; anatomy inference tries two families and on `AHU-1` makes `system = "1"`;
  separator-less tags return null. The hierarchy step shows no projected group
  counts, which is the one place a flat outcome could be caught. Only Dragon fixtures
  are tested; there is no Revit/Plant3D fixture anywhere.
- **High — Property pickers see only the top 500 properties by coverage.**
  `Wizard.tsx:58,154-166`. A Revit/Plant3D NWD has 1,000–5,000 pairs; the equipment
  tag often covers 3–8% of objects and can be absent from screen 3's picker while
  Quick Setup (which ranks the whole catalog) can see it.
- **High — Reopening a project discards the compile.** `adopt()` starts every session
  with `view: null, compile: never-run` (`project-session.ts:978-986`, verified); the
  workspace button, every workspace channel and every export throw until a full
  recompile. Multi-minute on a 250k-object site, every morning.
- **High — Boundary confirmation and publish gate are bypassable.** Screen 9's Save
  is gated; the sidebar "Save profile" (`Wizard.tsx:395-405`) and the compile's
  auto-save (`project-session.ts:2145-2148`) are not, and the auto-save also skips
  `publishBlockersFor`, so a draft naming an unresolved selection set is stored as a
  revision the engine then refuses to compile.
- **Medium** — profile sections with no editor while blocker copy points at controls
  that do not exist (`selectionSetNames`, `acceptedTagPatterns`, `identityConfig`,
  `profileLookup`, `priorSsm`, `authorityRules`); the resolver `manual` rung and
  "manual-only" template are dead ends (no per-asset system editor, worker request
  carries no manual systems); WBS training unreachable from screen 7 while the exports
  panel claims it; review queue capped at 100 rows, flow roots at 200; a failed
  recompile nulls the last good view; whole `CompiledProject` structured-cloned in one
  message and deserialised synchronously on main; every compile row stores all
  generated-MEL assets (~12 MB per compile at 40k assets) and `compileHistory` parses
  them all to count; stale "Saved revision N" with no dirty indicator; no renderer or
  e2e tests at all.
- **Low** — reload mid-compile shows a blank panel; `dev:ping` registered in
  production; `override:set` accepts non-existent ids; several PRODUCT.md §7 promises
  (screen 2 "accept suggestions", screen 3 "duplicate handling", suggestions for
  source assignments/boundaries/role pairs) have no UI; the fork card's "around an
  hour" was measured on a 76-object fixture.

### 6. Project store and data integrity

- **High — A failed `COMMIT` wedges the store for the session.** `store.ts:809-821`
  sets `#depth = 0` before `COMMIT` and issues no `ROLLBACK` on failure; the next
  `BEGIN IMMEDIATE` fails; `busy_timeout` is 0 so any concurrent SHARED lock (sync
  client, backup agent) triggers it. Reproduced by the auditor. The compile save at
  `project-session.ts:2278` is unguarded, so `active.running` stays set and every
  later compile returns the stale running status; the "saved" compile is lost on
  reopen. Verified by reading.
- **High — Pre-migration backup is an unverified, un-fsynced `copyFileSync`.**
  Power loss between backup and commit can leave a v6 file and a zero-length
  `.backup-3`. After a crash mid-migration the byte-identical backup blocks the
  retry with `backup-blocked`.
- **Medium** — `system` overrides are preserved by migration and then never fed to
  the compiler (the only path that reports them orphaned is dead code in the app);
  review decisions have no orphan path, a re-keyed item silently reverts to
  undecided; read-only/locked files open "successfully" and fail at first write;
  `adoptConfig` deletes the app-state legacy config before the project write
  succeeds; unbounded growth (assets per compile row, a profile revision per
  compile after any edit, no VACUUM, identity-less objects mint a fresh ordinal and
  a ghost every compile); the unscoped `tag` tier can hand a retired asset's manual
  decisions to new equipment reusing the tag with only a ledger-event, not a review
  item; draft profile edits are memory-only and close/open/quit discard them
  silently; two override rows for one asset after the v5 re-key produce a phantom
  `ambiguous-parent`.
- **Low** — no guard for network shares / sync folders; migration step list chosen
  outside the transaction; portability is re-add-only and caches are machine-local.

---

## Minimum human input today to get a full SSM from a fresh model

Even with the toolchain shipped and the proof passed, a person must:

1. Map `equipmentTag` (no default; Quick Setup proposes from 5 sampled values).
2. Give every asset a non-blank `building` (property chain or per-file assignment
   rule) or disable the Building boundary — otherwise nothing nests (B3).
3. Configure a System Resolver so every asset gets a `systemKey`: `tag-segment`
   (needs step 4), `model-field`, or `mel-lookup` against an exactly spelled MEL.
4. Teach tag anatomy (separators, role and system segments, family key), because the
   system segment, role graph, identity tier and learned rules all read it.
5. Write role-graph rules, or supply a `parentTagProperty`, a connectivity workbook,
   or prior-SSM pairs. A model alone with none of these yields zero structural
   claims (the MEL System Parent column is not consumed).
6. Import cable/EasyPower/PMD workbooks for dependencies; map or assign
   `nativeDiscipline`; write projection rewrites if SSM discipline differs.
7. Confirm boundaries and work the queue, which today includes one `missing-boundary`
   row per asset per level and no row at all for "system unresolved".

Estimate: 20–30 minutes on a Dragon-shaped site (the tested path); 2–4 hours on a
first Revit/Plant3D site, with a flat `(unassigned)` tree as the likeliest end state
for a user who accepts Quick Setup as offered.

---

## Recommended order of work

Each package is sized so it can be its own branch and PR. Packages 1–3 are the
critical path to the first honest proof run; 4–8 are the critical path from "proof
passed" to "fully built SSM".

**WP1 — Ship the toolchain (B1, B2, proof-workflow Highs).**
`extraResources` for the launcher closure; a hosted Windows job that builds the
launcher and feeds `package:win`; an artifact path for real-compiled adapter DLLs;
an in-product deployer into the Plugins root (per-user root first, elevation fallback);
`PLUGIN_NOT_DEPLOYED` pre-flight; deploy step + SHA check in `navisworks-proof.yml`;
`--navisworks-dir` plumbing; anonymizer false-positive fix; package smoke that
executes the launcher; `test:windows-proof` in CI; version stamp from `package.json`.

**WP2 — Launcher hardening before the first run (B6, orphan, sha trust).**
Sniff the `end` record and grace-kill Roamer; stall timeout with a
"possible dialog" message surfaced in the row; Job Object with kill-on-close;
polite cancel before `TerminateProcess` on quit plus a quit prompt; `stat` the file
before launch and fail `file-changed`; `-log` for Roamer; treat stdin EOF as cancel;
`SqliteException` → `CACHE_WRITE_FAILED`; distinct plugin-not-found / plugin-crashed
codes; `Document.OpenFile` in try/catch so `NW_VERSION_TOO_NEW` can be reached.

**WP3 — First real Windows proof (gates 14–16).** Run from a dev checkout only after
WP1/WP2. Expect the predicted-failure list above; capture verbatim; flip
`SupportedAdapters` only with the report in hand.

**WP4 — Extraction semantics, cache schema v3 (identity, NWF, sets, units).**
Populate `authoring_id` from format internals and `SavedItem.Guid`; `structural_key`
fallback; NWF cache key over referenced files, `SOURCE_MODEL_MISSING` warning;
`GetSelectedItems()` for sets; `meta.units`, `meta.ui_language`; hidden/layer/insert
flags; unconditional bbox with `IsEmpty`; invert the set/walk order to stop pinning
every `ModelItem`.

**WP5 — Compile completeness and honesty (B3 and the engine Highs).**
A `CompletenessReport` on `CompiledProject` (assets without system / building /
parent candidate, demotions per level) shown on screen 8, screen 9 and the
workspace; refuse or loudly warn on compile when a boundary level's attribute is
unmapped; aggregate `missing-boundary` per level; `unresolved-system` aggregated by
skip reason; `boundary-demotion` item for non-manual rungs; treat `sharingAssets > 1`
as unresolved in the claims bridge; `mel-parent` ladder rung; `unicodeFold`
normalization step enabled by default; `validateProfile` at `compileProject`;
route derived `manual` keys through the ledger; reuse the tag index in `mel-lookup`;
length-bucket or disable fuzzy in the claims bridge; cache prepared statements.

**WP6 — Workspace and outputs (B4, B5).** Page the tree to `total`; an "SSM
hierarchy" workbook export walking `project.tree` with one column per configured
level including derived ones; rehydrate the last compile view on open; searchable
property picker over the full catalog; gate every save path on the boundary
confirmation and publish blockers; keep the last good view on a failed recompile;
page the review queue and flow roots.

**WP7 — Store robustness.** `COMMIT` inside try with guarded `ROLLBACK`;
`busy_timeout`; guard the compile save and settle failed; fsync + reopen + quick_check
the backup, reuse an identical existing backup; writability probe at open; persist
the draft profile; move generated-MEL assets to their own table with retention;
plumb or remove `system` overrides; `stale-decision` rows; promote `rematched-by-tag`
into the review queue.

**WP8 — Quick Setup for real models.** A Revit-shaped fixture (Element/Item/Revit
Type categories, Mark, Type Name, Family, System Classification, Level, Workset);
let `building` accept `level`/`workset` with a stated reason; a third anatomy family
(`role = alphaPrefix`, `instance = digitSuffix`, no system) ranked by distinct-system
sanity; projected group counts on the hierarchy step; suggestions for source
assignments, boundaries and role pairs as the plan promised; a starter profile that
inherits a working rule set as the donor did.

---

## Limits of this audit

- No `dotnet` on this machine: every C# statement above is from reading, and every
  "real API" claim is the auditor's knowledge of the 2014–2025 Navisworks .NET API,
  not a compile.
- No renderer automation exists in the repo, so every UI finding was verified by
  reading the component source, not by driving the app.
- Six agents read in parallel; where two reached the same conclusion independently
  (launcher not shipped, NWF cache staleness, flat default tree) that is noted, and
  every Blocker plus the top High per stage was re-checked by hand.
