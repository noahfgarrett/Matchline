# SSM Compiler Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork SSManagement at commit `6d51935` into this repo, rebrand the artifact to `SSMCompiler.html` with build + tests green, then make the engine MEL-first: seed the canonical model from MEL rows, apply the partition fold (same-UPN parent / cross-UPN dependency), consume MEL Discipline/UPN/System Description as record attributes, and export the SSM register + Completed MEL backfill sheet.

**Architecture:** Full fork of the zero-dependency single-file app (ES modules concatenated into one shared scope by `build/build.mjs` per `build/manifest.mjs`; duplicate top-level names are build errors). New logic lands as small pure modules (`src/compiler/fold.js`) plus surgical extensions to `src/hierarchy/build.js` (seeding), `src/hierarchy/projection.js` (MEL attributes), `src/io/detect.js` (Project Phase capture), and `src/export/xlsx.js` (exports). No UI work in Phase 1 — the forked UI already renders the canonical model; validation is by tests.

**Tech Stack:** Plain ES modules, `node --test`, vendored SheetJS. No new dependencies. All commands run from `/Users/noahgarrett/Codebase/SSMCompiler`.

**Spec:** `docs/specs/2026-08-03-ssm-compiler-design.md` (§4 model, §5 fold, §6 ladders, §8 outputs, §9 architecture).

---

### Task 1: Bootstrap commit + fork copy

**Files:**
- Create: `docs/FORK.md`
- Copy from `/Users/noahgarrett/Codebase/SSManagement` @ `6d51935`: `src/`, `build/`, `tests/`, `package.json`, `AGENTS.md`

- [ ] **Step 1: Commit the existing bootstrap files on main**

```bash
cd /Users/noahgarrett/Codebase/SSMCompiler
git add README.md docs/ .gitignore
git commit -m "chore: bootstrap repo with design spec and phase 1 plan"
```

- [ ] **Step 2: Create the working branch**

```bash
git checkout -b feat/phase-1-compiler-core
```

- [ ] **Step 3: Copy the fork (never modifies SSManagement)**

```bash
SRC=/Users/noahgarrett/Codebase/SSManagement
git -C "$SRC" rev-parse --short HEAD   # must print 6d51935; if not, record the actual hash in FORK.md
cp -R "$SRC/src" "$SRC/build" "$SRC/tests" ./
cp "$SRC/package.json" "$SRC/AGENTS.md" ./
```

- [ ] **Step 4: Write `docs/FORK.md`**

```markdown
# Fork provenance

This repo began as a full copy of SSManagement's `src/`, `build/`, `tests/`,
`package.json`, and `AGENTS.md` at commit `6d51935` (2026-08-03, v3.5.0).

Policy: one-time fork. No build or runtime coupling with SSManagement.
Improvements flow between repos only by deliberate cherry-pick.
SSManagement is never modified by Compiler work.

Trim of unused surfaces (legend trainer, update UI, etc.) is deferred to
Phase 3 — see docs/specs/2026-08-03-ssm-compiler-design.md §11.
```

- [ ] **Step 5: Verify the copy builds and tests green as-is**

```bash
node build/build.mjs        # writes SSManagement.html (rebrand comes in Task 2)
npm test 2>&1 | tail -5
```
Expected: `built SSManagement.html`; test summary with `fail 0`.

- [ ] **Step 6: Commit**

```bash
printf 'SSManagement.html\n' >> .gitignore   # transient pre-rebrand artifact; removed in Task 2
git add -A
git commit -m "chore: fork SSManagement core at 6d51935"
```

### Task 2: Rebrand the artifact to SSMCompiler.html

**Files:**
- Modify: `build/build.mjs` (output filename), `src/index.html` (title), `package.json` (name/version), `src/update/private-update.js` (release channel + versioned filename), `src/changelog.json` (reset), `.gitignore`
- Modify: every test referencing the artifact name/channel: `tests/build.test.mjs`, `tests/build-transaction.test.mjs`, `tests/deployment.test.mjs`, `tests/eagle-profile.acceptance.test.mjs`, `tests/legend-pdf.test.mjs`, `tests/legend-wizard.test.mjs`, `tests/update.test.mjs`

- [ ] **Step 1: Global rename of artifact and release channel across src, build, tests**

```bash
grep -rl "SSManagement" build src tests | while read f; do
  sed -i '' \
    -e 's/SSManagement-Releases/SSMCompiler-Releases/g' \
    -e 's/SSManagement\.html/SSMCompiler.html/g' \
    -e 's/SSManagement-v/SSMCompiler-v/g' \
    -e 's/<title>SSManagement<\/title>/<title>SSM Compiler<\/title>/g' \
    -e 's/built SSManagement/built SSMCompiler/g' \
    "$f"
done
grep -rn "SSManagement" build src tests | grep -v "FORK\|fork" | head
```
Expected: remaining hits are only prose/comments (deployment test title regex now expects `SSM Compiler`; fix any leftover assertion by hand — `tests/deployment.test.mjs:18` must be `assert.match(html, /<title>SSM Compiler<\/title>/)`).

- [ ] **Step 2: package.json identity**

```json
{
  "name": "ssmcompiler",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build/build.mjs",
    "test": "node --test tests/*.test.mjs"
  }
}
```

- [ ] **Step 3: Reset changelog**

`src/changelog.json` becomes:

```json
[
  { "version": "0.1.0", "date": "2026-08-03", "notes": ["SSM Compiler fork of SSManagement core (see docs/FORK.md)."] }
]
```

If any test asserts on specific changelog content, update that expectation to 0.1.0.

- [ ] **Step 4: Build + full test suite**

```bash
sed -i '' '/^SSManagement\.html$/d' .gitignore
rm -f SSManagement.html
npm run build && npm test 2>&1 | tail -5
```
Expected: `built SSMCompiler.html`, `fail 0`. Iterate on stragglers (the grep in Step 1 is the map).

- [ ] **Step 5: Commit (artifact included — it is a committed build product)**

```bash
git add -A
git commit -m "chore: rebrand artifact to SSMCompiler.html, version 0.1.0"
```

### Task 3: Capture Project Phase in the MEL detector

**Files:**
- Modify: `src/io/detect.js` (`melInfo`), `src/hierarchy/build.js` (`buildMel` lookup columns)
- Test: `tests/compiler-seed.test.mjs` (created here, grown in Task 4)

- [ ] **Step 1: Write the failing test**

Create `tests/compiler-seed.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { melInfo } from '../src/io/detect.js'

const HEADERS = ['Equipment Tag','Equipment Description','Bldg','Discipline','UPN','System Description','System Parent Equipment Tag(s)','Project Phase']

test('melInfo captures Project Phase and Equipment Description columns', () => {
  const info = melInfo(HEADERS)
  assert.ok(info, 'headers should be recognized as a MEL')
  assert.equal(HEADERS[info.projectPhase], 'Project Phase')
  assert.equal(HEADERS[info.description], 'Equipment Description')
})
```

- [ ] **Step 2: Run it — expect failure**

```bash
node --test tests/compiler-seed.test.mjs
```
Expected: FAIL (`info.projectPhase` undefined). Adjust the test to `melInfo`'s real signature if it takes a worksheet rather than a header array — mirror however `tests/*.test.mjs` already call it (check `grep -n "melInfo" tests/*.mjs`).

- [ ] **Step 3: Implement — extend `melInfo` column scan**

In `src/io/detect.js`, alongside the existing System Description/Discipline matchers, add:

```js
const projectPhase = findHeader(headers, h => /project\s*phase/i.test(h))
const description = findHeader(headers, h => /equipment\s*desc/i.test(h))
```

and include `projectPhase, description` in the returned info object (follow the file's existing helper — if it uses inline `.findIndex`, do the same rather than introducing `findHeader`).

In `src/hierarchy/build.js` `buildMel()`, thread the new columns into each stored MEL record and the lookup's `columns` map: `ProjectPhase: clean(row[info.projectPhase])`, `Description: clean(row[info.description])`.

- [ ] **Step 4: Run to green**

```bash
node --test tests/compiler-seed.test.mjs && npm test 2>&1 | tail -3
```
Expected: PASS, suite `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/io/detect.js src/hierarchy/build.js tests/compiler-seed.test.mjs
git commit -m "feat: capture Project Phase and Description in MEL detection"
```

### Task 4: MEL-first seeding of the canonical model

Every MEL row becomes a canonical record even when no other source mentions it (spec §4 "Record"). Excluded-phase rows (default `Future`) are seeded but kept out of the register.

**Files:**
- Modify: `src/hierarchy/projection.js` (`buildCanonicalModel`)
- Modify: `src/profile/schema.js` (`makeDefaultProfile` gains `hierarchy.melSeed = { enabled: true, excludedPhases: ['Future'] }`)
- Test: `tests/compiler-seed.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/compiler-seed.test.mjs` (state setup mirrors existing hierarchy tests — see `tests/hierarchy-correctness.test.mjs` for the established way to populate `S` and invoke `buildCanonicalModel`; reuse its helpers/imports rather than inventing new ones):

```js
test('MEL rows seed canonical records even when absent from every other source', () => {
  // arrange: S.melRows contains a mechanical tag no Easy Power/cable/PMD source mentions
  setupStateWithMel([
    { tag: 'F52-AH104-51-00', building: 'OC31', discipline: 'MECH-DRY', upn: '104', systemDescription: 'General Air Handler System', phase: 'New' },
    { tag: 'F52-FUTURE-1', building: 'OC31', discipline: 'MECH-DRY', upn: '104', systemDescription: 'General Air Handler System', phase: 'Future' },
  ])
  const records = buildCanonicalModel()
  const rec = records.get(tagKey('F52-AH104-51-00'))
  assert.ok(rec, 'MEL-only tag must exist in the canonical model')
  assert.equal(rec.sourceKind, 'mel')
  assert.equal(rec.includeInRegister, true)
  const future = records.get(tagKey('F52-FUTURE-1'))
  assert.ok(future, 'excluded-phase rows are still records')
  assert.equal(future.includeInRegister, false)
  assert.equal(future.phaseExcluded, true)
})
```

- [ ] **Step 2: Run it — expect failure** (`rec` undefined)

```bash
node --test tests/compiler-seed.test.mjs
```

- [ ] **Step 3: Implement seeding in `buildCanonicalModel`**

In `src/hierarchy/projection.js`, after the `S.ssmCombined` loop (line ~113) and before the MEL dependency-claims loop, insert:

```js
/* MEL-first seeding: every MEL row is a commissionable record, whether or not
   any electrical source mentions it. Excluded phases stay out of the register
   but remain records so edges can still attach. */
const melSeed = activeProfile().hierarchy && activeProfile().hierarchy.melSeed
if (melSeed && melSeed.enabled !== false) {
  const excluded = new Set((melSeed.excludedPhases || ['Future']).map(p => clean(p).toLowerCase()))
  for (const row of S.melRows || []) {
    const record = ensure(row.tag, { observed: true })
    if (!record) continue
    const phase = clean(row.projectPhase).toLowerCase()
    record.phaseExcluded = !!phase && excluded.has(phase)
    if (!record.phaseExcluded) { record.includeInRegister = true; record.includeInHierarchy = true }
  }
}
```

Adapt field names to how `S.melRows` rows are actually shaped after Task 3 (`grep -n "melRows" src/hierarchy/build.js`) — if rows are raw arrays plus a column-info object, read via the stored info indices instead of named properties. Add `phaseExcluded: false` to the record literal in `ensure()` so the property always exists. Add `melSeed` to `makeDefaultProfile()`'s `hierarchy` object in `src/profile/schema.js` and to the starter profile if it builds `hierarchy` separately.

- [ ] **Step 4: Run to green, then the full suite**

```bash
node --test tests/compiler-seed.test.mjs && npm test 2>&1 | tail -3
```
Expected: PASS / `fail 0`. If an existing register test now sees extra rows, that test's fixture predates MEL seeding — set `melSeed: { enabled: false }` in that fixture's profile rather than weakening the assertion.

- [ ] **Step 5: Rebuild artifact + commit**

```bash
npm run build
git add -A
git commit -m "feat: seed canonical model from MEL rows (MEL-first universe)"
```

### Task 5: MEL attributes — Discipline and System = "{UPN} {System Description}"

**Files:**
- Modify: `src/hierarchy/projection.js` (`resolveRecordContext`)
- Test: `tests/compiler-attributes.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/compiler-attributes.test.mjs` (same state-setup helpers as Task 4):

```js
test('MEL discipline and UPN+description compose record attributes', () => {
  setupStateWithMel([
    { tag: 'F52-RIO650-4-05', building: 'OC31', discipline: 'I&C', upn: '650', systemDescription: 'FMS Network', phase: 'New' },
  ])
  const records = buildCanonicalModel()
  const rec = records.get(tagKey('F52-RIO650-4-05'))
  assert.equal(rec.discipline, 'I&C')
  assert.equal(rec.system, '650 FMS Network')
  assert.equal(rec.building, 'OC31')
})

test('classify rules and manual overrides still beat MEL attributes', () => {
  // profile with a Classify rule assigning discipline 'ELECTRICAL' to this tag
  // (build the profile the same way rules-classify tests do)
  // assert rec.discipline === 'ELECTRICAL' — rule wins over MEL
})
```

Write the second test fully by copying the profile-construction pattern from `tests/rules-classify.test.mjs`; the assertion is that rule-assigned values outrank MEL-derived ones (existing precedence: override → rule → source-derived → fallback).

- [ ] **Step 2: Run — expect failure** (`system` falls back to 'Unassigned System')

- [ ] **Step 3: Implement in `resolveRecordContext`**

In `src/hierarchy/projection.js:15-30`, the discipline and system lines gain a MEL tier (mirroring how `building` already consumes `mel.building`):

```js
const melDiscipline = clean(mel && mel.discipline)
const melSystem = (() => {
  const upn = clean(mel && mel.upn), desc = clean(mel && mel.systemDescription)
  return upn && desc ? `${upn} ${desc}` : (desc || '')
})()
const discipline = overrideValues.discipline || assign.values.discipline || melDiscipline
  || (record.isInstrument ? clean(h.disciplineFallbacks.instrument) : clean(h.disciplineFallbacks.default)) || 'Unassigned Discipline'
const system = overrideValues.system || assign.values.system || melSystem || record.systemHint
  || clean(h.systemFallbacks[discipline]) || clean(h.systemFallbacks.default) || 'Unassigned System'
```

Update the `explicit` map: `explicit.discipline = !!(assign.values.discipline || melDiscipline) || record.isInstrument;` and `explicit.system = !!(assign.values.system || melSystem) || isSystemName(record.tag);` — MEL-derived values are explicit (they must not be overwritten by parent-attribute inheritance). Field names again per the actual MEL record shape.

- [ ] **Step 4: Run to green + full suite**

```bash
node --test tests/compiler-attributes.test.mjs && npm test 2>&1 | tail -3
```

- [ ] **Step 5: Rebuild + commit**

```bash
npm run build && git add -A && git commit -m "feat: derive discipline and system attributes from MEL (UPN + description)"
```

### Task 6: The partition fold — cross-partition parents demote to dependencies

The heart of the Compiler (spec §5). A pure module so it is trivially testable.

**Files:**
- Create: `src/compiler/fold.js`
- Modify: `build/manifest.mjs` (add `'src/compiler/fold.js'` after `'src/hierarchy/claims.js'`)
- Modify: `src/hierarchy/projection.js` (apply the fold before `resolveHierarchyClaims`)
- Test: `tests/compiler-fold.test.mjs`

- [ ] **Step 1: Write the failing tests (pure function)**

Create `tests/compiler-fold.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { foldClaimsByPartition } from '../src/compiler/fold.js'

const partition = values => id => values[id] ?? null
const parentClaim = (subjectId, targetId, priority, id) =>
  ({ id, kind: 'structural-parent', subjectId, targetId, priority, order: 0, provenance: { source: 'cable' } })

test('canonical RIO case: cross-UPN feeder becomes dependency, RIO roots', () => {
  const claims = [parentClaim('rio650', 'panel603', 900, 'p1')]
  const out = foldClaimsByPartition(claims, partition({ rio650: 'OC31|I&C|650 FMS', panel603: 'OC31|ELECTRICAL|603 Low Voltage' }))
  assert.equal(out.filter(c => c.kind === 'structural-parent').length, 0)
  const dep = out.find(c => c.kind === 'dependency')
  assert.equal(dep.subjectId, 'rio650')
  assert.equal(dep.targetId, 'panel603')
  assert.match(dep.provenance.demoted, /650 FMS.*603 Low Voltage/)
})

test('same-partition low-priority candidate beats cross-partition high-priority one', () => {
  const claims = [
    parentClaim('vfd', 'elecPanel', 1000, 'p1'),   // cross-partition, higher priority
    parentClaim('vfd', 'mah', 500, 'p2'),          // same partition
  ]
  const out = foldClaimsByPartition(claims, partition({ vfd: 'B|MECH|101 MAH', mah: 'B|MECH|101 MAH', elecPanel: 'B|ELECTRICAL|603 LV' }))
  const parents = out.filter(c => c.kind === 'structural-parent')
  assert.equal(parents.length, 1)
  assert.equal(parents[0].targetId, 'mah')
  assert.equal(out.find(c => c.kind === 'dependency').targetId, 'elecPanel')
})

test('unknown partitions never demote', () => {
  const claims = [parentClaim('a', 'b', 900, 'p1')]
  const out = foldClaimsByPartition(claims, partition({ a: 'B|E|603 LV' }))  // b unknown
  assert.equal(out[0].kind, 'structural-parent')
})

test('dependency claims and manual claims pass through untouched', () => {
  const dep = { id: 'd1', kind: 'dependency', subjectId: 'a', targetId: 'c', priority: 1000, order: 1, provenance: {} }
  const out = foldClaimsByPartition([dep], partition({}))
  assert.deepEqual(out, [dep])
})
```

Import the real claim-kind constants instead of string literals if `HIERARCHY_CLAIM_KIND` exports cleanly into the test (`import { HIERARCHY_CLAIM_KIND } from '../src/hierarchy/claims.js'`) — match whatever the actual enum values are (check `src/hierarchy/claims.js`).

- [ ] **Step 2: Run — expect failure** (module does not exist)

```bash
node --test tests/compiler-fold.test.mjs
```

- [ ] **Step 3: Implement `src/compiler/fold.js`**

```js
import { HIERARCHY_CLAIM_KIND } from '../hierarchy/claims.js'

/* The partition fold (spec §5): a structural-parent claim whose subject and
   target live in different partition buckets is demoted to a dependency claim.
   Unknown buckets (record absent from the MEL) never demote — a boundary
   crossing must be proven, not assumed. Pure function: claims in, claims out. */
export function foldClaimsByPartition(claims, partitionOf) {
  return claims.map(claim => {
    if (claim.kind !== HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT) return claim
    const subject = partitionOf(claim.subjectId), target = partitionOf(claim.targetId)
    if (!subject || !target || subject === target) return claim
    return {
      ...claim,
      id: 'fold:' + claim.id,
      kind: HIERARCHY_CLAIM_KIND.DEPENDENCY,
      provenance: { ...claim.provenance, demoted: `crosses ${subject} → ${target}` },
    }
  })
}

/* Partition key for a resolved record: the SSM grouping tuple. Null when any
   component is unassigned — unknown, not provably different. */
export function recordPartitionKey(record) {
  const parts = [record.building, record.discipline, record.system]
  if (parts.some(part => !part || /^unassigned/i.test(part))) return null
  return parts.join('|')
}
```

Add `'src/compiler/fold.js'` to `build/manifest.mjs` immediately after `'src/hierarchy/claims.js'` (it must appear before `src/hierarchy/projection.js`, which will call it).

- [ ] **Step 4: Run the fold tests to green**

```bash
node --test tests/compiler-fold.test.mjs
```

- [ ] **Step 5: Wire the fold into `buildCanonicalModel`**

In `src/hierarchy/projection.js`, records' contexts are resolved (line ~137) *before* candidates are assembled (line ~147), so partition keys are available. Immediately before `const snapshot = resolveHierarchyClaims({...})`:

```js
const partitionOf = id => { const r = records.get(id); return r ? recordPartitionKey(r) : null }
const folded = foldClaimsByPartition(candidates, partitionOf)
const snapshot = resolveHierarchyClaims({ observations, candidates: folded, manualOverrides })
```

Manual overrides intentionally bypass the fold (a human placement wins; spec §5.6 flags contradictions instead — the QA listing for that arrives with Phase 2's scorecard).

- [ ] **Step 6: Add the integration test**

Append to `tests/compiler-fold.test.mjs` (using the Task 4/5 state helpers): seed a MEL with `panel603` (ELECTRICAL / 603) and `rio650` (I&C / 650), record a cable claim `rio650 → panel603` the way `recordSourceParentClaim` stores them (mirror `tests/hierarchy-correctness.test.mjs`), run `buildCanonicalModel()`, then assert:

```js
assert.equal(rec.ssmParentTag, '', 'RIO must root — no structural parent')
assert.ok([...rec.dependencies].some(d => tagKey(d) === tagKey('PANEL-603-TAG')))
```

- [ ] **Step 7: Full suite, rebuild, commit**

```bash
npm test 2>&1 | tail -3 && npm run build
git add -A
git commit -m "feat: partition fold — cross-UPN/discipline feeders demote to dependencies"
```

### Task 7: Exports — register columns + Completed MEL sheet

**Files:**
- Modify: `src/export/xlsx.js` (`addSsm3Sheet` gains System/Building/Discipline columns; new `addCompletedMelSheet`)
- Test: `tests/compiler-exports.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/compiler-exports.test.mjs`, following the sheet-assertion pattern of existing export coverage (`grep -n "addSsm3Sheet\|aoa" tests/*.test.mjs` for the established way to build a workbook and read rows back):

```js
test('register rows carry UPN, system, building, discipline', () => {
  // seed model per Task 6 integration test, export, read header row
  assert.deepEqual(headerRow.slice(0, 7),
    ['Equipment ID', 'Closest Parent', 'Dependencies', 'UPN', 'System', 'Building', 'Discipline'])
})

test('completed MEL sheet proposes parents with provenance and never overwrites asserted cells', () => {
  // MEL fixture: one row with blank System Parent (expect proposal), one with a
  // filled System Parent that contradicts the derived parent (expect original
  // value kept + a Contradiction flag column entry)
})
```

Flesh both out with the fixture from Task 6; the point under test: proposals fill blanks, contradictions flag rather than overwrite (spec §8.2).

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

In `src/export/xlsx.js`:

```js
function registerRecord(equip) { return canonicalRecord(equip) }

function addCompletedMelSheet(wb) {
  const header = ['Equipment Tag', 'Building', 'Discipline', 'UPN', 'System Description',
    'System Parent Equipment Tag(s)', 'Proposed System Parent', 'Proposed Dependencies', 'Provenance', 'Contradiction']
  const rows = [header]
  for (const row of S.melRows || []) {
    const record = registerRecord(row.tag)
    const asserted = clean(row.systemParent)
    const proposed = record && record.ssmParentTag || ''
    const contradiction = asserted && proposed && tagKey(asserted) !== tagKey(proposed)
      ? `derived ${proposed} from wiring; MEL asserts ${asserted}` : ''
    rows.push([row.tag, row.building, row.discipline, row.upn, row.systemDescription,
      asserted, asserted ? '' : proposed,
      record ? [...record.dependencies].join('; ') : '',
      record && record.provenance.join(' | ') || '', contradiction])
  }
  const ws = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, 'Completed MEL')
}
```

Extend `addSsm3Sheet` (line ~120) so each row appends `melUpn(equip)`, `recordAttribute(record,'system')`, `recordAttribute(record,'building')`, `recordAttribute(record,'discipline')` after the existing four values, and call `addCompletedMelSheet(wb)` wherever the SSM workbook is assembled (same call site as `addSsm3Sheet`). Match the file's actual helper names — `melUpn` exists in `src/hierarchy/build.js:106`; import-style references are fine since the bundle is one scope, but keep the module's existing import lines consistent.

- [ ] **Step 4: Run to green + full suite + rebuild**

```bash
node --test tests/compiler-exports.test.mjs && npm test 2>&1 | tail -3 && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: SSM register partition columns + Completed MEL backfill sheet"
```

### Task 8: Phase 1 close-out

- [ ] **Step 1: Full verification**

```bash
npm test 2>&1 | tail -5 && npm run build && git status --short
```
Expected: `fail 0`, fresh artifact, clean tree after commit.

- [ ] **Step 2: Update FORK.md with any deviations discovered during execution** (field-name differences, extra tests touched). Commit:

```bash
git add -A && git commit -m "docs: record phase 1 fork deviations"
```

- [ ] **Step 3: Merge back to main**

```bash
git checkout main && git merge --no-ff feat/phase-1-compiler-core -m "feat: phase 1 — MEL-first fold engine (SSM Compiler core)"
```

---

## Out of scope for Phase 1 (per spec §11)

P6/XER ingestion + milestone ladder, sequencing/polarity, UPN predecessor matrix, QA scorecard, EXTO upload sheet (Phase 2). Diff/rung-promotion report, piping roll-ups, compiler UI screens, fork trim (Phase 3).
