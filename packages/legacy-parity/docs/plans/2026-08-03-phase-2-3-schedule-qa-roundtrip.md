# SSM Compiler Phases 2 + 3 Implementation Plan

> Executed inline by the session that authored it; tasks tracked by checkboxes.
> Spec: `docs/specs/2026-08-03-ssm-compiler-design.md` §5 (sequencing), §6 (ladders), §8 (outputs).

**Goal (Phase 2):** P6 ingestion (XER + XLSX, strictly optional), the milestone fallback ladder, discipline-polarity sequencing, the UPN predecessor matrix, and the QA scorecard.
**Goal (Phase 3):** line-list piping roll-ups, change-control diff (broken-dependency callouts), EXTO profile column map, version bump.

**P6-optional invariant:** every Phase 2 output must be complete and valid with no P6 present — milestones default to the building-ready rung, and the rest of the pipeline never depends on P6.

### Task 1: P6 parsing — `src/io/p6.js`
- [x] `parseXer(text)` → `{tasks:[{id,code,name,milestone}],links:[{taskId,predTaskId}]}` from `%T/%F/%R` records (TASK, TASKPRED; milestone = task_type TT_Mile/TT_FinMile)
- [x] `detectP6(headers)` → `{activityId,activityName,equipmentId,upn}` (Activity ID + Activity Name anchor; equipment/UPN columns optional), `p6Info(key)` sheet scanner
- [x] Tests: `tests/compiler-p6.test.mjs` (pure: XER sample round-trip, header variants) — red → green → commit

### Task 2: Ingestion wiring
- [x] `S.p6Sel` in `src/state.js`; auto-select via `isP6Sheet` in `src/ui/screens.js` (mirror the MEL pattern at line ~253); clear handlers extended
- [x] `.xer` upload branch in `src/ui/screens.js` file loop: decode text, store `{ext:'xer', p6:parseXer(text), sheets:[]}`
- [x] `collectP6()` in `src/compiler/ladders.js` merges XER payloads + selected P6 sheets into `S.p6`
- [x] Fixtures: `compiler-p6.xer` (hand-written text), `compiler-p6.xlsx` (make-fixtures) — green suite → commit

### Task 3: Milestone ladder — `src/compiler/ladders.js`
- [x] Profile: `hierarchy.milestones = { upnPattern, buildingReadyLabel }` defaults in `makeDefaultProfile`
- [x] `assignMilestones(records)`: rung 1 explicit equipment-ID column match → rung 2/3 UPN extracted from milestone names → rung 4 building-ready; sets `record.milestone = {label, rung}`
- [x] Integration tests: with P6 (promotion to rungs 1–2) and without P6 (everything rung 4) — commit

### Task 4: Sequencing — `src/compiler/sequence.js`
- [x] `disciplinePolarity(discipline, profile)`: profile map, default top-down for /elec|lss|security|fire/i, bottom-up otherwise
- [x] `computeSequence(records)`: per-system DFS, pre-order (top-down) or post-order (bottom-up) → `record.sequence`
- [x] `upnPrecedence(records)`: cross-partition dependencies collapsed to UPN edges; Kahn topo order; cycles reported
- [x] Pure-function tests + integration (RIO's 650 depends on 1234 → 1234 precedes 650) — commit

### Task 5: Register + matrix + scorecard exports — `src/export/xlsx.js`
- [x] Register header gains `L2 Milestone`, `Sequence`
- [x] `addPredecessorMatrixSheet` (edge list + UPN×UPN matrix), `addQaSheets` (KPIs + exceptions: parent/dependency/milestone coverage with rung distribution, tag-vs-MEL validation, orphans, UPN cycles, MEL contradictions, cable tags absent from MEL)
- [x] Wire into `exportSSMXlsx`; update `tests/compiler-exports.test.mjs`; new `tests/compiler-qa.test.mjs` — commit

### Task 6 (P3): EXTO profile column map
- [x] `hierarchy.extoColumns = {upn:6,equipmentId:10,closestParent:15,dependencies:38,milestone:-1}`; `addExtoSheet` reads it (defaults reproduce today's layout; milestone column emitted when ≥0)
- [x] Test: default layout unchanged; custom map honored — commit

### Task 7 (P3): Line-list piping roll-ups
- [x] `detectLineList(headers)` (`Line ID`/`Line Number` + `UPN`) in `src/io/p6.js` or sibling; `S.lineSel` auto-select
- [x] Roll-up synthesis in `buildCanonicalModel`: one synthetic record per UPN (`UPN {upn} Distribution Piping`), partition attributes from that UPN's MEL majority, `isSyntheticRollup` excluded from tag-vs-MEL KPI
- [x] Fixture `compiler-linelist.xlsx`; integration tests — commit

### Task 8 (P3): Change-control sheet
- [x] `addChangeControlSheet`: dependencies present in the imported working copy but absent from the current register → "Broken dependency (requires approval)" rows; parent moves listed
- [x] Fixture `compiler-wc.xlsx`; test — commit

### Task 9: Version + close-out
- [x] Bump to 0.3.0 (package.json, APP_VERSION, changelog entry), FORK.md deviations (incl. explicitly deferred: manual piping add UI, fork trim, review-queue/authoring UX polish), full suite, rebuild, merge to main

## Explicitly deferred (recorded, not silent)
Manual piping-add UI; fork surface trim; rule-pack authoring polish; review-queue UX; XER rung-1 matching beyond explicit equipment columns (no fuzzy activity-text scanning).
