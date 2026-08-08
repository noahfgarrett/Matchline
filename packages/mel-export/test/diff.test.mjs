/**
 * Revision output (PRODUCT.md §12.4) and the workbook it writes.
 *
 * Dragon revision A → revision B is built to hold exactly one instance of each
 * §12.4 category and nothing else, so a category that fires twice is a bug
 * rather than a fixture accident. The awkward pairs are deliberate: an asset
 * whose System Key changed but whose parent did not, and an asset whose parent
 * moved but whose System Key did not.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { readWorkbook, sheetAoa } from '@matchline/spreadsheet-import';

import {
  CANONICAL_MEL_HEADERS,
  DIFF_SUMMARY_SHEET_NAME,
  MelExportError,
  diffMelRevisions,
  writeDiffWorkbook,
} from '../dist/index.js';
import {
  DRAGON_RENAME_HINT,
  DRAGON_REVISION_A,
  DRAGON_REVISION_B,
} from './dist/dragon.fixture.js';

function diff(options = { renamedTags: DRAGON_RENAME_HINT }) {
  return diffMelRevisions(DRAGON_REVISION_A, DRAGON_REVISION_B, options);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `{ sheetName: aoa }` for a written diff workbook. */
function sheets(bytes) {
  const workbook = readWorkbook(bytes);
  return Object.fromEntries(
    workbook.sheetNames.map((name) => [name, sheetAoa(workbook.getSheet(name)).aoa]),
  );
}

/* ---- every §12.4 category ---- */

test('an added asset is listed with its whole canonical row', () => {
  const { added } = diff();
  assert.equal(added.length, 1);
  assert.equal(added[0].canonicalTag, 'PMP003-01-01');
  assert.equal(added[0].row.equipmentTag, 'PMP003-01-01');
  assert.equal(added[0].row.systemKey, '003');
});

test('a removed asset is listed with the row the previous revision held', () => {
  const { removed } = diff();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].canonicalTag, 'FCU-SPARE-09');
  assert.equal(removed[0].row.equipmentDescription, 'Dragon FCU-SPARE-09');
});

test('a rename hint turns an add and a remove into one changed tag', () => {
  assert.deepEqual([...diff().changedTags], [
    { canonicalTag: 'VFD001-10-01A', before: 'VFD001-10-01', after: 'VFD001-10-01A' },
  ]);
});

test('without the hint the same rename is honestly an add and a remove', () => {
  /* Two workbooks alone cannot tell a rename from a disappearance plus an
     appearance, and this diff does not pretend otherwise. */
  const blind = diff({});
  assert.equal(blind.changedTags.length, 0);
  assert.deepEqual(
    blind.added.map((change) => change.canonicalTag),
    ['PMP003-01-01', 'VFD001-10-01A'],
  );
  assert.deepEqual(
    blind.removed.map((change) => change.canonicalTag),
    ['FCU-SPARE-09', 'VFD001-10-01'],
  );
});

test('a changed description is reported once, before and after', () => {
  assert.deepEqual([...diff().changedDescriptions], [
    {
      canonicalTag: 'MAH001-10-01',
      before: 'Primary air handler',
      after: 'Primary air handling unit',
    },
  ]);
});

test('a changed System Key is reported, and does not report a moved parent', () => {
  const result = diff();
  assert.deepEqual([...result.changedSystemKeys], [
    { canonicalTag: 'CHW001-01-01', before: '001', after: '002' },
  ]);
  /* CHW001-01-01 kept MAH001-10-02 as its parent throughout. */
  assert.ok(!result.movedParents.some((change) => change.canonicalTag === 'CHW001-01-01'));
});

test('a moved parent is reported, and does not report a changed System Key', () => {
  const result = diff();
  assert.deepEqual([...result.movedParents], [
    { canonicalTag: 'PLC001-10-01', before: 'MAH001-10-01', after: 'MAH001-10-02' },
  ]);
  /* PLC001-10-01 stayed in system 001 while its parent moved within it. */
  assert.ok(!result.changedSystemKeys.some((change) => change.canonicalTag === 'PLC001-10-01'));
});

test('both hierarchy levels are watched: building and SSM discipline', () => {
  assert.deepEqual([...diff().changedHierarchyLevels], [
    { canonicalTag: 'EPB002-01-01', level: 'building', before: 'D-200', after: 'D-300' },
    {
      canonicalTag: 'TIT001-10-01',
      level: 'ssmDiscipline',
      before: 'Mechanical',
      after: 'Instrumentation',
    },
  ]);
});

test('gained and lost dependencies are reported separately, with the whole cell', () => {
  const { dependencyChanges } = diff();
  assert.deepEqual([...dependencyChanges.added], [
    {
      canonicalTag: 'MAH001-10-02',
      dependencyTag: 'PMP003-01-01',
      before: 'CHW001-01-01; EPB002-01-01',
      after: 'EPB002-01-01; PMP003-01-01',
    },
  ]);
  assert.deepEqual([...dependencyChanges.removed], [
    {
      canonicalTag: 'MAH001-10-02',
      dependencyTag: 'CHW001-01-01',
      before: 'CHW001-01-01; EPB002-01-01',
      after: 'EPB002-01-01; PMP003-01-01',
    },
  ]);
});

test('a tag that became duplicated is a new conflict item', () => {
  assert.deepEqual([...diff().newConflicts], [
    {
      canonicalTag: 'ESB002-01',
      before: '',
      after: 'DUPLICATE_TAG; DUPLICATE_MODEL_TAG',
    },
  ]);
});

test('a conflict that was already there is not reported as new', () => {
  const stillDuplicated = diffMelRevisions(DRAGON_REVISION_B, DRAGON_REVISION_B);
  assert.deepEqual([...stillDuplicated.newConflicts], []);
});

test('an added asset that arrives already conflicted is a new conflict item', () => {
  const conflicted = [
    ...DRAGON_REVISION_A,
    { canonicalTag: 'NEW-01', inclusionStatus: 'MODEL_CONFLICT' },
  ];
  assert.deepEqual([...diffMelRevisions(DRAGON_REVISION_A, conflicted).newConflicts], [
    { canonicalTag: 'NEW-01', before: '', after: 'MODEL_CONFLICT' },
  ]);
});

test('the summary counts one of every §12.4 category', () => {
  assert.deepEqual(diff().summary, {
    added: 1,
    removed: 1,
    changedTags: 1,
    changedDescriptions: 1,
    changedSystemKeys: 1,
    changedHierarchyLevels: 2,
    movedParents: 1,
    dependenciesAdded: 1,
    dependenciesRemoved: 1,
    newConflicts: 1,
  });
});

/* ---- empty and reversed ---- */

test('a revision that changed nothing diffs to empty lists and a summary of zeros', () => {
  const unchanged = diffMelRevisions(DRAGON_REVISION_A, DRAGON_REVISION_A);
  assert.deepEqual(unchanged.added, []);
  assert.deepEqual(unchanged.removed, []);
  assert.deepEqual(unchanged.changedTags, []);
  assert.deepEqual(unchanged.changedDescriptions, []);
  assert.deepEqual(unchanged.changedSystemKeys, []);
  assert.deepEqual(unchanged.changedHierarchyLevels, []);
  assert.deepEqual(unchanged.movedParents, []);
  assert.deepEqual(unchanged.dependencyChanges, { added: [], removed: [] });
  assert.deepEqual(unchanged.newConflicts, []);
  assert.deepEqual(
    Object.values(unchanged.summary),
    Array.from({ length: 10 }, () => 0),
  );
});

test('two empty revisions diff to nothing rather than failing', () => {
  assert.deepEqual(diffMelRevisions([], []).summary.added, 0);
  assert.equal(diffMelRevisions([], DRAGON_REVISION_A).summary.added, 9);
  assert.equal(diffMelRevisions(DRAGON_REVISION_A, []).summary.removed, 9);
});

test('the diff does not depend on the order the assets arrive in', () => {
  const forwards = diff();
  const backwards = diffMelRevisions(
    [...DRAGON_REVISION_A].reverse(),
    [...DRAGON_REVISION_B].reverse(),
    { renamedTags: DRAGON_RENAME_HINT },
  );
  assert.deepEqual(backwards.summary, forwards.summary);
  assert.deepEqual(backwards.changedHierarchyLevels, forwards.changedHierarchyLevels);
  assert.deepEqual(backwards.movedParents, forwards.movedParents);
});

/* ---- rename hints are checked, not trusted ---- */

test('a rename hint that does not describe these revisions is refused', () => {
  const cases = [
    [new Map([['NOT-IN-A', 'PMP003-01-01']]), 'the previous revision has no'],
    [new Map([['FCU-SPARE-09', 'NOT-IN-B']]), 'the current revision has no'],
    [new Map([['MAH001-10-01', 'PMP003-01-01']]), 'the current revision still has'],
    [new Map([['FCU-SPARE-09', 'MAH001-10-01']]), 'the previous revision already had'],
    [new Map([['MAH001-10-01', 'MAH001-10-01']]), 'the two tags are the same'],
  ];
  for (const [renamedTags, detail] of cases) {
    assert.throws(
      () => diff({ renamedTags }),
      (error) =>
        error instanceof MelExportError &&
        error.reason.kind === 'inapplicable-rename-hint' &&
        error.reason.detail.startsWith(detail),
      detail,
    );
  }
});

test('two hints claiming the same new tag are refused', () => {
  assert.throws(
    () =>
      diff({
        renamedTags: new Map([
          ['VFD001-10-01', 'VFD001-10-01A'],
          ['FCU-SPARE-09', 'VFD001-10-01A'],
        ]),
      }),
    (error) =>
      error instanceof MelExportError &&
      error.reason.kind === 'inapplicable-rename-hint' &&
      error.reason.detail.includes('already claimed by'),
  );
});

/* ---- the workbook ---- */

test('the workbook holds a Summary and one sheet per non-empty category', () => {
  const written = sheets(writeDiffWorkbook(diff()));
  assert.deepEqual(Object.keys(written), [
    DIFF_SUMMARY_SHEET_NAME,
    'Added Assets',
    'Removed Assets',
    'Changed Tags',
    'Changed Descriptions',
    'Changed System Keys',
    'Changed Hierarchy Levels',
    'Moved Parents',
    'Added Dependencies',
    'Removed Dependencies',
    'New Conflicts',
  ]);
});

test('the Summary lists every §12.4 category with its count', () => {
  const written = sheets(writeDiffWorkbook(diff()));
  assert.deepEqual(written[DIFF_SUMMARY_SHEET_NAME], [
    ['Category', 'Count'],
    ['Added Assets', '1'],
    ['Removed Assets', '1'],
    ['Changed Tags', '1'],
    ['Changed Descriptions', '1'],
    ['Changed System Keys', '1'],
    ['Changed Hierarchy Levels', '2'],
    ['Moved Parents', '1'],
    ['Added Dependencies', '1'],
    ['Removed Dependencies', '1'],
    ['New Conflicts', '1'],
  ]);
});

test('added and removed assets print the whole §12.1 row', () => {
  const written = sheets(writeDiffWorkbook(diff()));
  assert.deepEqual(written['Added Assets'][0], [...CANONICAL_MEL_HEADERS]);
  assert.equal(written['Added Assets'][1][0], 'PMP003-01-01');
  assert.deepEqual(written['Removed Assets'][0], [...CANONICAL_MEL_HEADERS]);
  assert.equal(written['Removed Assets'][1][0], 'FCU-SPARE-09');
});

test('a change sheet is Equipment Tag, Before, After', () => {
  const written = sheets(writeDiffWorkbook(diff()));
  assert.deepEqual(written['Changed Descriptions'], [
    ['Equipment Tag', 'Before', 'After'],
    ['MAH001-10-01', 'Primary air handler', 'Primary air handling unit'],
  ]);
  assert.deepEqual(written['Changed Hierarchy Levels'][0], [
    'Equipment Tag',
    'Level',
    'Before',
    'After',
  ]);
  assert.deepEqual(written['Added Dependencies'][1], [
    'MAH001-10-02',
    'PMP003-01-01',
    'CHW001-01-01; EPB002-01-01',
    'EPB002-01-01; PMP003-01-01',
  ]);
});

test('an empty diff still writes a Summary of zeros, and nothing else', () => {
  const written = sheets(writeDiffWorkbook(diffMelRevisions(DRAGON_REVISION_A, DRAGON_REVISION_A)));
  assert.deepEqual(Object.keys(written), [DIFF_SUMMARY_SHEET_NAME]);
  assert.deepEqual(
    written[DIFF_SUMMARY_SHEET_NAME].slice(1).map((row) => row[1]),
    Array.from({ length: 10 }, () => '0'),
  );
});

test('every cell of the diff workbook is a text cell', () => {
  const workbook = readWorkbook(writeDiffWorkbook(diff()));
  for (const name of workbook.sheetNames) {
    for (const row of workbook.getSheet(name)) {
      for (const cell of row ?? []) {
        if (cell === null || cell === undefined) continue;
        assert.equal(cell.t, 's', `${name}: expected a text cell, got ${cell.t}`);
      }
    }
  }
});

test('the same diff always writes the same bytes', () => {
  assert.equal(sha256(writeDiffWorkbook(diff())), sha256(writeDiffWorkbook(diff())));
  /* And the negative half: a different diff must not write the same file. */
  assert.notEqual(
    sha256(writeDiffWorkbook(diff())),
    sha256(writeDiffWorkbook(diffMelRevisions(DRAGON_REVISION_A, DRAGON_REVISION_A))),
  );
});

test('the diff bytes do not depend on the clock, the process, or the time zone', () => {
  /* The multi-sheet write is a path the canonical export never takes, so the
     faked-clock guard is repeated for it: a vendor bump that started stamping
     document timestamps must fail here rather than quietly ending byte
     stability for the revision report. */
  const inProcess = sha256(writeDiffWorkbook(diff()));
  const script = `
    const RealDate = Date;
    const FAKE = RealDate.parse('2099-12-31T23:59:59Z');
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(FAKE); else super(...args); }
      static now() { return FAKE; }
    }
    globalThis.Date = FakeDate;
    const { createHash } = await import('node:crypto');
    const { diffMelRevisions, writeDiffWorkbook } = await import('./dist/index.js');
    const fixture = await import('./test/dist/dragon.fixture.js');
    const diff = diffMelRevisions(fixture.DRAGON_REVISION_A, fixture.DRAGON_REVISION_B, {
      renamedTags: fixture.DRAGON_RENAME_HINT,
    });
    process.stdout.write(createHash('sha256').update(writeDiffWorkbook(diff)).digest('hex'));
  `;
  const elsewhere = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, TZ: 'Asia/Kolkata' },
    encoding: 'utf8',
  });
  assert.equal(elsewhere, inProcess);
});

test('the bytes do not depend on the order the revisions arrived in', () => {
  const backwards = diffMelRevisions(
    [...DRAGON_REVISION_A].reverse(),
    [...DRAGON_REVISION_B].reverse(),
    { renamedTags: DRAGON_RENAME_HINT },
  );
  assert.equal(sha256(writeDiffWorkbook(backwards)), sha256(writeDiffWorkbook(diff())));
});
