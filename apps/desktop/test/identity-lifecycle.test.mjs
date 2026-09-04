import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
import { deserializeLedger, PROJECT_SCHEMA_VERSION } from '@matchline/project-store';

import { createProjectService } from '../dist/electron/services/project-session.js';

/**
 * The whole identity lifecycle through the desktop service, headless (P0-9,
 * hard gate 12).
 *
 * `@matchline/asset-identity` proves reconciliation and `@matchline/compiler`
 * proves the splice; both work on values handed to them. This file is about the
 * half neither can test: that the ledger is *written to the project file*, read
 * back on the next compile, and still there after the app has been closed and
 * reopened. An engine that carries an id perfectly across two compiles in one
 * process, and a project file that forgets it overnight, is a project that
 * orphans every manual decision the first time somebody quits the app.
 *
 * ## The fixture
 *
 * Dragon, with one object's tag deliberately mis-spelled — `MAH002-10-1` where
 * the site means `MAH002-10-01`. Nothing else differs: same object id, same
 * InstanceGuid, same position in the tree. Correcting it mid-project is
 * therefore a correction and not a replacement, which is the whole question the
 * ledger answers.
 */

/** The tag as the site means it. */
const CORRECT_TAG = 'MAH002-10-01';
/** The same equipment, as the model first spelled it. */
const TYPO_TAG = 'MAH002-10-1';
/** The parent a person picks by hand. Same building, same system: nothing folds. */
const PARENT_TAG = 'MAH002-10-02';

/** Dragon is 34 tagged assets (see project-service.test.mjs for the derivation). */
const DRAGON_ASSET_COUNT = 34;

const PROPERTY_MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  description: { category: 'Dragon Data', name: 'Manufacturer' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Dragon Data', name: 'Building' },
  nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
};

const ASSET_FILTERS = {
  includedClasses: [],
  excludedClasses: [],
  requireTagProperty: true,
  acceptedTagPatterns: [],
  selectionSetNames: [],
  includedSourceModelFiles: [],
  collapseComponents: false,
  separatelyCommissionableClasses: [],
};

/**
 * Re-spells one object's tag in a written cache, in place.
 *
 * The same three columns `tests/acceptance-1.0/support.mjs` rewrites, for the
 * same reason: the mapped property, the display name and `Item > Name` are the
 * three places the fixture states a tag, and leaving one behind would make the
 * object ambiguous rather than corrected. Nothing touches `instance_guid`,
 * `authoring_id` or the object's place in the tree — that is what makes this a
 * re-tag.
 */
function retag(cachePath, fromTag, toTag) {
  const db = new DatabaseSync(cachePath);
  try {
    db.exec('BEGIN');
    const row = db
      .prepare(
        "SELECT object_id AS id FROM properties WHERE category = 'Dragon Data' " +
          "AND name = 'Tag' AND value_text = ?",
      )
      .get(fromTag);
    assert.ok(row, `the fixture should carry a Dragon Data > Tag of ${fromTag}`);
    db.prepare(
      "UPDATE properties SET value_text = ? WHERE object_id = ? AND category = 'Dragon Data' AND name = 'Tag'",
    ).run(toTag, row.id);
    db.prepare(
      "UPDATE properties SET value_text = ? WHERE object_id = ? AND category = 'Item' AND name = 'Name'",
    ).run(toTag, row.id);
    db.prepare('UPDATE objects SET display_name = ? WHERE id = ?').run(toTag, row.id);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** The ledger a project file is holding right now, read from the file itself. */
function ledgerOnDisk(projectPath) {
  const db = new DatabaseSync(projectPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT compile_id, ledger_json FROM ledger WHERE slot = 0').get();
    return row === undefined
      ? null
      : { compileId: row.compile_id, ledger: deserializeLedger(JSON.parse(row.ledger_json)) };
  } finally {
    db.close();
  }
}

/** One asset row of the compiled tree, by tag. */
function assetRow(service, tag) {
  const [row] = service.treeSearch(tag, 10).filter((candidate) => candidate.label === tag);
  return row;
}

function summaryOf(status) {
  assert.equal(status.state, 'done', `compile failed: ${status.reason ?? ''}`);
  return status.summary;
}

let workDir = '';
let cachePath = '';
let userDataDir = '';

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-identity-'));
  cachePath = join(workDir, 'Dragon.matchline-cache');
  userDataDir = join(workDir, 'userData');
  writeDragonFixture(cachePath);
  // The model arrives with the typo in it, which is how a real one arrives.
  retag(cachePath, CORRECT_TAG, TYPO_TAG);
});

after(() => {
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function newService() {
  return createProjectService({ userDataDir, appVersion: '0.8.1' });
}

/**
 * The model's own UPN decides the System Key.
 *
 * Load-bearing since P0-4: a manual parent is folded like any other winner, and
 * "unknown never equals unknown" applies to it too — so the hand-picked parent
 * below only nests because both ends actually *state* System 002. Without a
 * resolver the System Key is unknown on both sides, and an unproven boundary is
 * not a boundary somebody may nest across.
 */
const DRAGON_RESOLVER = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [{ kind: 'trim' }],
  conflictPolicy: 'review',
  labelTemplate: '',
};

/** A project registered against the cache and mapped far enough to compile. */
async function configure(service, projectPath) {
  service.create(projectPath, 'Dragon');
  await service.addSources([cachePath]);
  service.updateDraft({
    propertyMappings: PROPERTY_MAPPINGS,
    assetFilters: ASSET_FILTERS,
    systemResolver: DRAGON_RESOLVER,
  });
  // A compile records nothing unless the profile it ran is a published
  // revision, and every ledger assertion here is about what a recorded compile
  // wrote down.
  service.saveProfile('screens 1-5');
}

test('the ledger is written, reloaded and honoured across a tag correction', async (t) => {
  const projectPath = join(workDir, 'Identity.matchline');
  let service = newService();
  t.after(() => {
    service.close();
  });

  await configure(service, projectPath);

  /* --- the first compile mints the ids and writes them down ------------- */

  const first = summaryOf(await service.compile());
  assert.equal(first.assetCount, DRAGON_ASSET_COUNT);
  assert.equal(
    first.ledgerNewAssetCount,
    DRAGON_ASSET_COUNT,
    'a project with no ledger mints one id per asset, and says so',
  );
  assert.equal(first.ledgerTagChangedCount, 0);
  assert.equal(first.ledgerDisappearedCount, 0);
  assert.equal(first.orphanedDecisionCount, 0);

  const stored = ledgerOnDisk(projectPath);
  assert.ok(stored, 'the compile wrote a ledger into the project file');
  assert.equal(stored.compileId, first.compileId, 'and tied it to the compile that produced it');
  assert.equal(stored.ledger.entries.length, DRAGON_ASSET_COUNT);

  const mistagged = assetRow(service, TYPO_TAG);
  assert.ok(mistagged, 'the first compile reads the model as it is spelled');
  const assetId = mistagged.assetId;
  assert.equal(
    assetId,
    `tag:${TYPO_TAG}`,
    'a minted id adopts the catalog spelling, so a project that predates the ledger reads the same',
  );

  /* --- a decision recorded the way a 0.8.1 project recorded them -------- */

  // `tag:<tag>` is the id `@matchline/asset-catalog` used to mint, and it is
  // what a project file written before the ledger holds. It has to keep working.
  service.setRelationshipOverride(`tag:${TYPO_TAG}`, `tag:${PARENT_TAG}`, 'One hot water train.');

  const second = summaryOf(await service.compile());
  assert.equal(second.ledgerNewAssetCount, 0, 'nothing is new the second time round');
  assert.equal(second.ledgerTagChangedCount, 0);
  assert.equal(second.orphanedDecisionCount, 0, 'the tag-keyed override resolved');
  assert.equal(
    assetRow(service, TYPO_TAG).assetId,
    assetId,
    'and every asset kept the id the first compile gave it',
  );
  assert.equal(
    assetRow(service, TYPO_TAG).overridden,
    true,
    'the override applied: the parent came from the manual rung',
  );

  /* --- the site corrects the tag ---------------------------------------- */

  retag(cachePath, TYPO_TAG, CORRECT_TAG);
  // Re-registering is what a person does after a model is reissued; the project
  // refuses to compile against bytes it has not recorded.
  await service.addSources([cachePath]);

  const third = summaryOf(await service.compile());
  assert.equal(third.assetCount, DRAGON_ASSET_COUNT, 'still the same equipment');
  assert.equal(
    third.ledgerNewAssetCount,
    0,
    'a corrected tag is not a new asset — that is the whole gate',
  );
  assert.equal(third.ledgerTagChangedCount, 1);
  assert.equal(third.ledgerDisappearedCount, 0);
  assert.equal(third.orphanedDecisionCount, 0);

  assert.equal(assetRow(service, TYPO_TAG), undefined, 'the old spelling is gone from the model');
  const corrected = assetRow(service, CORRECT_TAG);
  assert.equal(corrected.assetId, assetId, 'and the corrected row is the same asset');
  assert.equal(
    corrected.assetId,
    `tag:${TYPO_TAG}`,
    'the id still spells the old tag, which is the proof it is no longer derived from one',
  );
  assert.equal(
    corrected.overridden,
    true,
    'the override recorded under the old tag still applies, through the ledger alias',
  );

  const events = service.compileLedgerEvents(0, 50);
  assert.equal(events.total, 1);
  assert.deepEqual(events.rows[0], {
    kind: 'tag-changed',
    assetId,
    tag: CORRECT_TAG,
    previousTag: TYPO_TAG,
    tier: events.rows[0].tier,
    detail: events.rows[0].detail,
  });
  assert.notEqual(events.rows[0].tier, '', 'a match names the tier that made it');
  assert.notEqual(
    events.rows[0].tier,
    'tag',
    'and it is not the tag tier — the model evidence is what carried the id',
  );

  const afterCorrection = ledgerOnDisk(projectPath);
  const entry = afterCorrection.ledger.entries.find((candidate) => candidate.assetId === assetId);
  assert.equal(entry.currentCanonicalTag, CORRECT_TAG);
  assert.deepEqual(entry.aliases, [TYPO_TAG], 'the old spelling is kept, so old evidence resolves');

  /* --- close the app, open it again ------------------------------------- */

  service.close();
  service = newService();
  const reopened = await service.open(projectPath, false);
  assert.equal(reopened.outcome, 'opened');
  assert.equal(reopened.notice.migration, null, 'the file this build wrote is the file it reads');

  const fourth = summaryOf(await service.compile());
  assert.equal(
    fourth.ledgerNewAssetCount,
    0,
    'the ledger came back off disk: nothing had to be minted again',
  );
  assert.equal(fourth.ledgerTagChangedCount, 0, 'and nothing had to be re-matched');
  assert.equal(assetRow(service, CORRECT_TAG).assetId, assetId, 'the ids survived the close');
  assert.equal(
    assetRow(service, CORRECT_TAG).overridden,
    true,
    'and so did the decision addressed to one of them',
  );
});

test('a decision naming equipment no compile has becomes a review item, not a silence', async (t) => {
  const projectPath = join(workDir, 'Orphan.matchline');
  const service = newService();
  t.after(() => {
    service.close();
  });

  await configure(service, projectPath);
  summaryOf(await service.compile());

  // Written straight into the file rather than through the service, because
  // the service now refuses an override naming an asset the current compile
  // does not have -- a durable row nothing will ever resolve is exactly what
  // that guard exists to stop somebody creating by accident. What this test is
  // about is the OTHER way such a row appears: one that resolved when it was
  // written and stopped resolving when the model changed. A row already in the
  // file is what that looks like from here.
  service.close();
  writeRelationshipOverride(
    projectPath,
    'tag:GHOST999-99-99',
    `tag:${PARENT_TAG}`,
    'Walked down with the mechanical lead.',
  );
  await service.open(projectPath, false);

  const summary = summaryOf(await service.compile());
  assert.equal(summary.orphanedDecisionCount, 1);

  const page = service.reviewPage('', 0, 100);
  const orphaned = page.rows.filter((row) => row.kind === 'orphaned-decision');
  assert.equal(orphaned.length, 1);
  assert.match(orphaned[0].summary, /GHOST999-99-99/);
  assert.match(orphaned[0].summary, /no longer resolves/);

  // The kind reaches the queue's own filter list, so the chip row offers it
  // without anything having to enumerate kinds by hand.
  assert.deepEqual(
    page.kinds.filter((entry) => entry.kind === 'orphaned-decision'),
    [{ kind: 'orphaned-decision', count: 1 }],
  );
  assert.equal(
    service.reviewPage('orphaned-decision', 0, 100).total,
    1,
    'and filtering by it returns the item',
  );

  // The note is the irreplaceable part of a decision, and the override is still
  // stored with it rather than having been dropped along with the reference.
  const [ghost] = service
    .listRelationshipOverrides()
    .filter((row) => row.childAssetId === 'tag:GHOST999-99-99');
  assert.ok(ghost, 'the override the compile could not use is still in the project');
  assert.equal(ghost.note, 'Walked down with the mechanical lead.');
  assert.equal(ghost.parentAssetId, `tag:${PARENT_TAG}`);
});

/* ------------------------------------- two rows, one asset (the v5 re-key) */

/** Writes a relationship override straight into a closed project file. */
function writeRelationshipOverride(projectPath, childAssetId, parentAssetId, note) {
  const db = new DatabaseSync(projectPath);
  try {
    db.prepare(
      `INSERT INTO overrides (kind, asset_key, payload_json, updated_at)
       VALUES ('relationship', ?, ?, ?)
       ON CONFLICT (kind, asset_key) DO UPDATE SET payload_json = excluded.payload_json`,
    ).run(
      childAssetId,
      JSON.stringify({ childAssetId, parentAssetId, ...(note === undefined ? {} : { note }) }),
      '2026-01-15T09:00:00.000Z',
    );
  } finally {
    db.close();
  }
}

function overrideKeys(projectPath) {
  const db = new DatabaseSync(projectPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT asset_key FROM overrides WHERE kind = 'relationship' ORDER BY asset_key")
      .all()
      .map((row) => row.asset_key);
  } finally {
    db.close();
  }
}

/**
 * Two override rows for one asset, which schema v5 made possible.
 *
 * Every build before it filed a manual parent under the bare canonical tag;
 * `@matchline/asset-catalog` mints `tag:<tag>`. A project carried across that
 * line can hold both. BOTH resolve — that is the point of the resolver — so
 * claims assembly is handed two manual parents for one child and reports an
 * `ambiguous-parent` about a disagreement nobody ever had. The first compile
 * after opening collapses them.
 */
test('two spellings of one asset collapse to one override, with no phantom ambiguity', async (t) => {
  const projectPath = join(workDir, 'Rekey.matchline');
  let service = newService();
  t.after(() => {
    service.close();
  });

  await configure(service, projectPath);
  summaryOf(await service.compile());
  service.close();

  // The same decision, written twice, exactly as a project that has lived
  // through the v5 re-key holds it.
  writeRelationshipOverride(projectPath, 'MAH001-10-02', 'tag:MAH001-10-01', 'the pre-v5 row');
  writeRelationshipOverride(
    projectPath,
    'tag:MAH001-10-02',
    'tag:MAH001-10-01',
    'the post-v5 row',
  );
  assert.deepEqual(overrideKeys(projectPath), ['MAH001-10-02', 'tag:MAH001-10-02']);

  service = newService();
  assert.equal((await service.open(projectPath, false)).outcome, 'opened');
  const summary = summaryOf(await service.compile());

  assert.deepEqual(
    overrideKeys(projectPath),
    ['tag:MAH001-10-02'],
    'the first compile after opening left one row, keyed by the ledger id',
  );
  assert.equal(summary.orphanedDecisionCount, 0, 'and neither row was dropped to get there');

  const phantom = service
    .reviewPage('ambiguous-parent', 0, 100)
    .rows.filter((row) => row.summary.includes('MAH001-10-02'));
  assert.deepEqual(phantom, [], 'no ambiguity about a decision that was only ever stated once');
  assert.equal(
    assetRow(service, 'MAH001-10-02').overridden,
    true,
    'and the decision itself still applies',
  );

  // Idempotent: a second compile in the same session has nothing left to do.
  summaryOf(await service.compile());
  assert.deepEqual(overrideKeys(projectPath), ['tag:MAH001-10-02']);
});

/* ------------------------------------------- manual system assignments */

/** Writes a `system` override straight into a closed project file. */
function writeSystemOverride(projectPath, assetKey, override) {
  const db = new DatabaseSync(projectPath);
  try {
    db.prepare(
      `INSERT INTO overrides (kind, asset_key, payload_json, updated_at)
       VALUES ('system', ?, ?, '2026-01-15T09:00:00.000Z')
       ON CONFLICT (kind, asset_key) DO UPDATE SET payload_json = excluded.payload_json`,
    ).run(assetKey, JSON.stringify(override));
  } finally {
    db.close();
  }
}

/** The generated-MEL asset one compile stored for a tag (schema v7). */
function storedAsset(projectPath, compileId, canonicalTag) {
  const db = new DatabaseSync(projectPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT assets_json FROM compile_assets WHERE compile_id = ?')
      .get(compileId);
    assert.ok(row, `compile ${compileId} stored no assets`);
    return JSON.parse(row.assets_json).find((asset) => asset.canonicalTag === canonicalTag);
  } finally {
    db.close();
  }
}

/**
 * `setSystemOverride` has written rows since schema v1 and nothing ever read one.
 *
 * PRODUCT.md §4.1 makes a manual system "always the final word", and it was a
 * word nothing said: the rows were stored, carried forward by every migration,
 * and never handed to the compiler. This is that plumbing, both halves — the
 * override that lands, and the one that no longer names anything and is
 * reported rather than dropped.
 */
test('a stored system override reaches the compiler, and a stale one is reported', async (t) => {
  const projectPath = join(workDir, 'ManualSystem.matchline');
  const service = newService();
  t.after(() => {
    service.close();
  });

  await configure(service, projectPath);
  const first = summaryOf(await service.compile());
  const resolved = storedAsset(projectPath, first.compileId, 'MAH001-10-01');
  assert.equal(resolved.system.systemKey, '001', 'the model’s own UPN decides it by default');
  assert.equal(first.orphanedDecisionCount, 0);

  // One that names a live asset by its canonical tag, and one that names
  // equipment this project has never seen.
  writeSystemOverride(projectPath, 'MAH001-10-01', {
    systemKey: '900',
    systemDescription: 'Reassigned on site',
  });
  writeSystemOverride(projectPath, 'GONE-99-99', { systemKey: '901' });

  const second = summaryOf(await service.compile());
  const overridden = storedAsset(projectPath, second.compileId, 'MAH001-10-01');
  assert.equal(overridden.system.systemKey, '900', 'the person’s answer is the final word');
  assert.equal(overridden.system.systemDescription, 'Reassigned on site');

  assert.equal(second.orphanedDecisionCount, 1, 'and the one that names nothing is not silent');
  const orphan = service
    .reviewPage('orphaned-decision', 0, 50)
    .rows.find((row) => row.reviewKey.includes('GONE-99-99'));
  assert.ok(orphan, 'it arrives in the queue for a person to re-aim or retire');
  assert.match(orphan.summary, /manual-system/);
});

/* ---------------------------------------------- the v4 → v5 migration flow */

/**
 * A project file that declares itself version 4 — the version 0.8.1 shipped.
 *
 * Built by walking a current file back and dropping what v5 added, rather than
 * from a frozen v4 DDL: whether the migration preserves a real v4 file's rows is
 * `@matchline/project-store`'s own test (it holds the frozen DDL), and what this
 * one is about is who gets asked before it runs.
 */
async function writeV4Project(name) {
  const olderPath = join(workDir, name);
  const service = newService();
  await configure(service, olderPath);
  summaryOf(await service.compile());
  service.close();

  const db = new DatabaseSync(olderPath);
  try {
    db.exec('DROP TABLE ledger');
    db.exec('DELETE FROM migrations WHERE version > 4');
    db.exec("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
  } finally {
    db.close();
  }
  return olderPath;
}

test('a v4 project is not upgraded to v5 until the user says so', async (t) => {
  const olderPath = await writeV4Project('Older-v4.matchline');
  const service = newService();
  t.after(() => {
    service.close();
  });

  const asked = await service.open(olderPath, false);
  assert.equal(asked.outcome, 'migration-needed');
  assert.equal(asked.migrationNeeded.fromVersion, 4);
  assert.equal(asked.migrationNeeded.toVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(service.current(), null, 'nothing was opened');

  const accepted = await service.open(olderPath, true);
  assert.equal(accepted.outcome, 'opened');
  assert.equal(accepted.project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.deepEqual(accepted.notice.migration, {
    fromVersion: 4,
    toVersion: PROJECT_SCHEMA_VERSION,
    backupPath: `${olderPath}.backup-4`,
  });

  // A migrated project has no ledger yet, so its first compile mints the ids —
  // and writes them where the next one will find them.
  assert.equal(ledgerOnDisk(olderPath), null);
  const summary = summaryOf(await service.compile());
  assert.equal(summary.ledgerNewAssetCount, DRAGON_ASSET_COUNT);
  assert.equal(ledgerOnDisk(olderPath).ledger.entries.length, DRAGON_ASSET_COUNT);
});
