/**
 * Hard gate 13, end to end: a real 0.8.1 project opens in a 1.0 build, and
 * nothing a person decided is lost on the way.
 *
 * > 0.8.1 projects migrate with backup, no silent decision loss.
 *
 * The pieces of that have each been proven in isolation — `project-store`'s
 * `migration.test.mjs` walks v3→v4→v5→v6→v7 against frozen per-version DDL,
 * `profile-v2.test.mjs` lifts a stored V1 profile, `workspace-service.test.mjs`
 * moves a `config` table into a new profile revision. What none of them does is
 * run the whole thing at once, through the DESKTOP service, on a file that has
 * all of it in it: sources, two profile revisions in the V1 shape, the five
 * config sections, three kinds of learned rules, overrides keyed by TAG, a
 * review decision, a compile row and a snapshot. This file is that run.
 *
 * ## Why the fixture is built from frozen DDL rather than by the store
 *
 * The same reason `packages/project-store/test/migration.test.mjs` freezes its
 * own copies: a fixture built from today's `schema.ts` drifts with the code, so
 * the test keeps passing while real 0.8.1 files stop opening. The v3 DDL below
 * is copied from that file's frozen snapshot, and the first test asserts it is
 * genuinely pre-v4/v5/v6/v7 — no `source_id`, no `ledger`, no `derivedAttributes`
 * — so it cannot be quietly modernized.
 *
 * ## What "nothing silently lost" is checked against
 *
 * The backup. The migration copies the untouched original to
 * `<path>.backup-3` before it does anything, so the pristine v3 file is still
 * on disk at the end of the run — which makes "the decisions survived" a
 * table-by-table comparison against the real before-state rather than against
 * a list of expectations written here.
 *
 * ## Dragon only
 *
 * Every tag, building, file name and decision below is invented (see
 * `packages/model-schema/src/fixtures/dragon.ts`). No client data.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
import { PROJECT_SCHEMA_VERSION } from '@matchline/project-store';
import { reviewKey } from '@matchline/ssm-compiler';

import { createProjectService } from '../../apps/desktop/dist/electron/services/project-session.js';

import { melWorkbook } from './support.mjs';

/**
 * `PROJECT_SCHEMA_SQL` as **v3** shipped — the schema 0.8.1 wrote.
 *
 * Frozen: copied out of `packages/project-store/test/migration.test.mjs`, which
 * copied it out of `schema.ts` before v4 edited it. It must never be edited to
 * match a later schema. `sources` has no `source_id`, there is no `ledger`
 * table, and the `config` CHECK names neither `derivedAttributes` nor
 * `sourceAssignmentRules` — the three things v4, v5 and v6 respectively add.
 */
const V3_SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE sources (
  role      TEXT NOT NULL CHECK (role IN (
              'model', 'easypower', 'cable-schedule', 'pmd', 'mel', 'p6', 'prior-ssm')),
  file_name TEXT NOT NULL,
  sha256    TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  added_at  TEXT NOT NULL,
  PRIMARY KEY (role, file_name)
);

CREATE TABLE profile (
  revision     INTEGER PRIMARY KEY CHECK (revision > 0),
  profile_json TEXT NOT NULL,
  note         TEXT,
  saved_at     TEXT NOT NULL
);

CREATE TABLE learned (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('nesting', 'item-master', 'wbs')),
  rules_json TEXT NOT NULL,
  saved_at   TEXT NOT NULL
);
CREATE INDEX idx_learned_kind ON learned(kind, id);

CREATE TABLE overrides (
  kind         TEXT NOT NULL CHECK (kind IN ('system', 'relationship')),
  asset_key    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (kind, asset_key)
) WITHOUT ROWID;

CREATE TABLE compiles (
  id                INTEGER PRIMARY KEY,
  input_hashes_json TEXT NOT NULL,
  profile_revision  INTEGER NOT NULL REFERENCES profile(revision),
  stats_json        TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL
);

CREATE TABLE snapshots (
  slot          INTEGER PRIMARY KEY CHECK (slot = 0),
  compile_id    INTEGER NOT NULL REFERENCES compiles(id),
  snapshot_json TEXT NOT NULL,
  saved_at      TEXT NOT NULL
);

CREATE TABLE decisions (
  id         INTEGER PRIMARY KEY,
  review_key TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'deferred')),
  note       TEXT,
  decided_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_key ON decisions(review_key, id);

CREATE TABLE migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE config (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty', 'extoTemplate')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;
`;

const CREATED_AT = '2026-03-02T09:30:00.000Z';

/* ------------------------------------------------ what 0.8.1 had decided --- */

/**
 * The Site Profile, in the **V1** shape 0.8.1 stored.
 *
 * Written out longhand rather than produced by `migrateSiteProfileV1`: this is
 * the shape on disk, and building it through the migration would test the
 * migration against its own output. Mappings are single `PropertyRef`s,
 * `tagAnatomy.segments` is a record rather than a list, and there is no
 * `sourceAssignments`, `derivedAttributes`, `identityConfig` or
 * `stableIdProperty` — none of those sections existed.
 */
function legacyProfileV1(name) {
  return {
    profileId: 'dragon',
    name,
    version: 1,
    propertyMappings: {
      equipmentTag: { category: 'Dragon Data', name: 'Tag' },
      description: { category: 'Dragon Data', name: 'Manufacturer' },
      equipmentType: { category: 'Item', name: 'Type' },
      building: { category: 'Dragon Data', name: 'Building' },
      nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
    },
    assetFilters: { requireTagProperty: true, collapseComponents: false },
    tagAnatomy: {
      separators: ['-'],
      ignoredSuffixes: [],
      segments: {
        role: { kind: 'alphaPrefix', token: 0 },
        system: { kind: 'digitSuffix', token: 0 },
        unit: { kind: 'token', token: 1 },
        instance: { kind: 'token', token: 2 },
      },
      familyKeyTemplate: '{system}-{token:1}-{token:2}',
    },
    // One rung on purpose: the tag says the system, and nothing contradicts it,
    // so the recompile below has no system conflicts and the only review item
    // in it is the boundary demotion this fixture is about.
    systemResolver: {
      keyChain: [{ kind: 'tag-segment', segment: 'system' }],
      descriptionChain: [
        { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
      ],
      normalization: [{ kind: 'trim' }],
      conflictPolicy: 'review',
    },
  };
}

/** The five sections a v3 `config` table kept beside the profile. */
const LEGACY_HIERARCHY = {
  levels: [
    {
      levelId: 'building',
      displayName: 'Building',
      attributeKey: 'building',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'label',
    },
    {
      levelId: 'system',
      displayName: 'System',
      attributeKey: 'systemKey',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'key',
    },
  ],
};
const LEGACY_ROLE_GRAPH = { rules: [{ parentRole: 'MAH', childRole: 'PLC' }] };
/** Manual only, so the recompile's parents are exactly the stored decisions. */
const LEGACY_LADDER = { tiers: ['manual'] };
const LEGACY_PROJECTION = [{ from: 'I&C', to: 'Electrical' }];
/**
 * The project's OWN configuration, which is not a site rule and must NOT move
 * into the profile: a captured registry layout belongs to this project's
 * workbook and would be meaningless at the next site.
 */
const LEGACY_EXTO_TEMPLATE = {
  version: 1,
  sheetName: 'Register',
  headers: ['UPN', 'Equipment Tag', 'Description'],
  headerRowIndex: 0,
  matched: [
    { field: 'upn', columnIndex: 0, match: 'exact' },
    { field: 'equipmentTag', columnIndex: 1, match: 'trimmed-case-insensitive' },
  ],
  capturedFrom: { label: 'Dragon-Registry.xlsx' },
};

const LEGACY_NESTING_RULES = {
  version: 1,
  trainedFrom: { rowCount: 12, label: 'Dragon prior SSM.xlsx' },
  classification: [
    { discipline: 'Mechanical', pattern: 'MAH*', class: 'AHU', confidence: 0.95, sampleCount: 8 },
  ],
  roleGates: [
    {
      class: 'AHU',
      asParent: 6,
      asChild: 0,
      parentRate: 1,
      isChildOnly: false,
      isParentCapable: true,
    },
  ],
  affinities: [{ childClass: 'Fan', parentClass: 'AHU', observations: 6 }],
  grades: [{ class: 'AHU', predicted: 6, correct: 6, precision: 1, grade: 'claim' }],
};
const LEGACY_ITEM_MASTER_RULES = {
  version: 1,
  trainedFrom: { rowCount: 10, label: 'Dragon item master.xlsx' },
  entries: [{ key: 'AHU', itemMaster: 'AHU-STD', confidence: 0.9, sampleCount: 9 }],
  audit: [],
};
const LEGACY_WBS_RULES = {
  version: 1,
  trainedFrom: { rowCount: 4, label: 'Dragon WBS.xlsx' },
  entries: [{ key: '001', wbs: '1.2.3', confidence: 1, sampleCount: 4 }],
};

/**
 * The manual parent that still nests, and the one the boundary refuses.
 *
 * Both are keyed by the bare canonical TAG, which is how a pre-ledger build
 * wrote them (`packages/project-store/src/overrides.ts`: "keyed by `assetKey`
 * — the asset's canonical tag"). Nothing in a v3 file knows about asset ids, so
 * a 1.0 build that only understood `tag:`-prefixed ids would silently drop both
 * of these — which is exactly the loss gate 13 forbids.
 */
const NESTING_CHILD = 'MAH001-10-02';
const NESTING_PARENT = 'MAH001-10-01';
const CROSSING_CHILD = 'MAH002-10-01';
const CROSSING_PARENT = 'TIT603-10-01';

/**
 * The decision a reviewer took in 0.8.1, and the key it was filed under.
 *
 * Computed with the compiler's own `reviewKey` rather than typed out, for the
 * reason `ipc-table.test.mjs` gives about the `review:decide` example: a
 * hand-written key outlives the spelling it was written for and goes on
 * describing something nothing emits. The assertion that matters is further
 * down — the recompiled review row carries this key — and that is what proves
 * the decision still *resolves* rather than merely still existing.
 */
const CROSSING_REVIEW_KEY = reviewKey({
  kind: 'manual-boundary-demotion',
  assetId: `tag:${CROSSING_CHILD}`,
  parentAssetId: `tag:${CROSSING_PARENT}`,
  boundaryLevelId: 'system',
});
const CROSSING_DECISION_NOTE = 'Skid-mounted with the instrument rack; commission them together.';

/**
 * A decision about something this compile no longer produces.
 *
 * Kept deliberately: "no silent decision loss" is not "no decision is ever
 * stale". A row nothing resolves is history the migration has no business
 * throwing away, and it is asserted to still be in the file at the end.
 */
const STALE_REVIEW_KEY = 'system-conflict␟tag:VFD001-10-01␟001␟002';

/* --------------------------------------------------------- the fixture ----- */

let workDir = '';
let cachePath = '';
let melPath = '';
let userDataDir = '';

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-a10-0.8.1-migration-'));
  userDataDir = join(workDir, 'userData');
  mkdirSync(userDataDir, { recursive: true });

  cachePath = join(workDir, 'Dragon-Coordination.matchline-cache');
  writeDragonFixture(cachePath);

  melPath = join(workDir, 'Dragon-MEL.xlsx');
  writeFileSync(melPath, melWorkbook().bytes);
});

after(() => {
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

/**
 * A project file exactly as 0.8.1 left it, with something in every table.
 *
 * The two real files on disk are registered by their real hash and size,
 * because the desktop service re-proves every source's bytes when it reopens a
 * project — a row carrying an invented hash comes back `file-changed` and
 * cannot be compiled, which would make the recompile below prove nothing.
 */
function writeLegacyProject(name) {
  const path = join(workDir, name);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(V3_SCHEMA_SQL);

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of [
      ['schema_version', '3'],
      ['app_version', '0.8.1'],
      ['project_name', 'Dragon'],
      ['created_at', CREATED_AT],
      ['modified_at', CREATED_AT],
    ]) {
      meta.run(key, value);
    }
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(3, CREATED_AT);

    const source = db.prepare(
      'INSERT INTO sources (role, file_name, sha256, byte_size, added_at) VALUES (?, ?, ?, ?, ?)',
    );
    source.run('model', 'Dragon-Coordination.matchline-cache', sha256Of(cachePath), statSync(cachePath).size, CREATED_AT);
    source.run('mel', 'Dragon-MEL.xlsx', sha256Of(melPath), statSync(melPath).size, CREATED_AT);
    // A source whose file is not on this machine any more. It is still a row in
    // the project, and a migration that tidied it away would be deleting the
    // record that this project was ever built on the previous SSM at all.
    // (`prior-ssm` rather than a connectivity role on purpose: a compile
    // refuses outright while an EasyPower, cable schedule or PMD it was told
    // about is unreadable, and that refusal is a different test's subject.)
    source.run('prior-ssm', 'Dragon-Prior-SSM.xlsx', 'd'.repeat(64), 4096, CREATED_AT);

    const profile = db.prepare(
      'INSERT INTO profile (revision, profile_json, note, saved_at) VALUES (?, ?, ?, ?)',
    );
    profile.run(1, JSON.stringify(legacyProfileV1('Dragon')), 'first pass at the tags', CREATED_AT);
    profile.run(2, JSON.stringify(legacyProfileV1('Dragon Phase 2')), null, CREATED_AT);

    const config = db.prepare('INSERT INTO config (key, config_json, updated_at) VALUES (?, ?, ?)');
    config.run('hierarchy', JSON.stringify(LEGACY_HIERARCHY), CREATED_AT);
    config.run('roleGraph', JSON.stringify(LEGACY_ROLE_GRAPH), CREATED_AT);
    config.run('ladder', JSON.stringify(LEGACY_LADDER), CREATED_AT);
    config.run('ssmDisciplineProjection', JSON.stringify(LEGACY_PROJECTION), CREATED_AT);
    config.run('extoTemplate', JSON.stringify(LEGACY_EXTO_TEMPLATE), CREATED_AT);

    const learned = db.prepare(
      'INSERT INTO learned (id, kind, rules_json, saved_at) VALUES (?, ?, ?, ?)',
    );
    learned.run(3, 'nesting', JSON.stringify(LEGACY_NESTING_RULES), CREATED_AT);
    learned.run(9, 'item-master', JSON.stringify(LEGACY_ITEM_MASTER_RULES), CREATED_AT);
    learned.run(11, 'wbs', JSON.stringify(LEGACY_WBS_RULES), CREATED_AT);

    const override = db.prepare(
      'INSERT INTO overrides (kind, asset_key, payload_json, updated_at) VALUES (?, ?, ?, ?)',
    );
    override.run(
      'relationship',
      NESTING_CHILD,
      JSON.stringify({
        childAssetId: NESTING_CHILD,
        parentAssetId: NESTING_PARENT,
        note: 'One air handling train.',
      }),
      CREATED_AT,
    );
    override.run(
      'relationship',
      CROSSING_CHILD,
      JSON.stringify({
        childAssetId: CROSSING_CHILD,
        parentAssetId: CROSSING_PARENT,
        note: 'Panel and rack are one skid.',
      }),
      CREATED_AT,
    );
    override.run('system', CROSSING_PARENT, JSON.stringify({ systemKey: '603' }), CREATED_AT);

    db.prepare(
      `INSERT INTO compiles
         (id, input_hashes_json, profile_revision, stats_json, started_at, finished_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      JSON.stringify({
        'model/Dragon-Coordination.matchline-cache': sha256Of(cachePath),
        'mel/Dragon-MEL.xlsx': sha256Of(melPath),
        'prior-ssm/Dragon-Prior-SSM.xlsx': 'd'.repeat(64),
      }),
      2,
      JSON.stringify({ nodeCount: 34 }),
      '2026-03-02T10:00:00.000Z',
      '2026-03-02T10:00:41.000Z',
      CREATED_AT,
    );
    db.prepare(
      'INSERT INTO snapshots (slot, compile_id, snapshot_json, saved_at) VALUES (0, ?, ?, ?)',
    ).run(1, JSON.stringify({ nodes: [], reviewItems: [], stats: { nodeCount: 34 } }), CREATED_AT);

    const decision = db.prepare(
      'INSERT INTO decisions (id, review_key, decision, note, decided_at) VALUES (?, ?, ?, ?, ?)',
    );
    decision.run(1, CROSSING_REVIEW_KEY, 'accepted', CROSSING_DECISION_NOTE, CREATED_AT);
    decision.run(2, STALE_REVIEW_KEY, 'rejected', 'The model was corrected instead.', CREATED_AT);
  } finally {
    db.close();
  }

  // The installation's sha256 index, which is the only way a reopened project
  // finds its files again (a project stores names and hashes, never paths).
  writeFileSync(
    join(userDataDir, 'app-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        recentProjects: [],
        sourcePaths: { [sha256Of(cachePath)]: cachePath, [sha256Of(melPath)]: melPath },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return path;
}

/** Every row of the named tables, as comparable JSON, in a stable order. */
function dumpTables(path, tables) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const dump = {};
    for (const table of tables) {
      dump[table] = db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(Object.entries(row).sort(([left], [right]) => (left < right ? -1 : 1))),
          ),
        )
        .sort();
    }
    return dump;
  } finally {
    db.close();
  }
}

function scalar(path, sql) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.values(db.prepare(sql).get() ?? {})[0];
  } finally {
    db.close();
  }
}

function newService() {
  return createProjectService({ userDataDir, appVersion: '1.0.0' });
}

/* ------------------------------------------------------------- the gate --- */

test('the fixture really is a 0.8.1 file: pre-v4, pre-v5, pre-v6, pre-v7', () => {
  // The guard on everything below. A fixture quietly rebuilt from today's DDL
  // would make this whole file prove nothing.
  assert.equal(V3_SCHEMA_SQL.includes('source_id'), false, 'v4 added source_id');
  assert.equal(V3_SCHEMA_SQL.includes('ledger'), false, 'v5 added the ledger table');
  assert.equal(V3_SCHEMA_SQL.includes('derivedAttributes'), false, 'v6 widened the config CHECK');
  assert.equal(V3_SCHEMA_SQL.includes('sourceAssignmentRules'), false, 'v6 widened the config CHECK');
  assert.equal(V3_SCHEMA_SQL.includes('profile_draft'), false, 'v7 added the draft slot');
  assert.equal(V3_SCHEMA_SQL.includes('compile_assets'), false, 'v7 added the asset table');

  const path = writeLegacyProject('Frozen.matchline');
  assert.equal(String(scalar(path, "SELECT value FROM meta WHERE key = 'schema_version'")), '3');
  assert.equal(String(scalar(path, "SELECT value FROM meta WHERE key = 'app_version'")), '0.8.1');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(
      db.prepare('PRAGMA table_info(sources)').all().map((row) => row.name),
      ['role', 'file_name', 'sha256', 'byte_size', 'added_at'],
      'the sources table is addressed by name, not by id',
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ledger'").get().n,
      0,
    );
    // And the stored profile is the V1 shape: one PropertyRef per field, and
    // anatomy segments as a record rather than an ordered list.
    const stored = JSON.parse(
      String(db.prepare('SELECT profile_json FROM profile WHERE revision = 2').get().profile_json),
    );
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.propertyMappings.equipmentTag, { category: 'Dragon Data', name: 'Tag' });
    assert.equal(Array.isArray(stored.tagAnatomy.segments), false);
    assert.equal('sourceAssignments' in stored, false);
    assert.equal('derivedAttributes' in stored, false);
  } finally {
    db.close();
  }
});

test('opening a 0.8.1 project without accepting migration changes nothing', async () => {
  const path = writeLegacyProject('Untouched.matchline');
  const service = newService();
  try {
    const result = await service.open(path, false);
    assert.equal(result.outcome, 'migration-needed');
    assert.deepEqual(result.migrationNeeded, {
      fromVersion: 3,
      toVersion: PROJECT_SCHEMA_VERSION,
    });
    assert.equal(String(scalar(path, "SELECT value FROM meta WHERE key = 'schema_version'")), '3');
    assert.equal(existsSync(`${path}.backup-3`), false, 'nothing was copied either');
  } finally {
    service.close();
  }
});

test('a 0.8.1 project migrates, keeps every decision, and recompiles on them', async (t) => {
  const path = writeLegacyProject('Dragon.matchline');
  const backupPath = `${path}.backup-3`;
  const before = dumpTables(path, [
    'sources',
    'profile',
    'learned',
    'overrides',
    'compiles',
    'snapshots',
    'decisions',
    'config',
  ]);

  const service = newService();
  t.after(() => {
    service.close();
  });

  /* ------------------------------------------- the migration, and the backup */

  const opened = await service.open(path, true);
  assert.equal(opened.outcome, 'opened', JSON.stringify(opened));
  assert.deepEqual(
    opened.notice.migration,
    { fromVersion: 3, toVersion: PROJECT_SCHEMA_VERSION, backupPath },
    'the whole chain ran in one open, and the user is told where the original went',
  );
  assert.equal(PROJECT_SCHEMA_VERSION, 7, 'gate 13 is about landing at the current schema');
  assert.ok(existsSync(backupPath), 'the untouched original was copied before anything ran');
  assert.equal(
    String(scalar(backupPath, "SELECT value FROM meta WHERE key = 'schema_version'")),
    '3',
    'and the backup is still the v3 file, which is the point of taking it',
  );
  assert.deepEqual(
    dumpTables(backupPath, [
      'sources',
      'profile',
      'learned',
      'overrides',
      'compiles',
      'snapshots',
      'decisions',
      'config',
    ]),
    before,
    'the backup is byte-for-byte the project as 0.8.1 left it',
  );
  assert.equal(String(scalar(path, "SELECT value FROM meta WHERE key = 'schema_version'")), '7');
  assert.deepEqual(
    (() => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return db.prepare('SELECT version FROM migrations ORDER BY version').all().map((r) => r.version);
      } finally {
        db.close();
      }
    })(),
    [3, 4, 5, 6, 7],
    'every step is recorded, so the chain is auditable rather than assumed',
  );

  /* --------------------------------- the V1 profile, lifted and merged into */

  assert.equal(opened.notice.mergedLegacyConfig, true, 'the config move is reported, not silent');
  assert.equal(opened.project.savedRevision, 3, 'a NEW revision — the two 0.8.1 ones are untouched');

  const { draft } = service.draftState();
  assert.equal(draft.name, 'Dragon Phase 2', 'the latest stored revision is what was rehydrated');
  assert.deepEqual(
    draft.propertyMappings.equipmentTag,
    { chain: [{ category: 'Dragon Data', name: 'Tag' }], bySource: [] },
    'a V1 single mapping lifts to a one-rung chain (P0-5)',
  );
  assert.deepEqual(
    draft.tagAnatomy.segments.map((entry) => entry.segment),
    ['role', 'system', 'unit', 'instance'],
    'and the anatomy record lifts to an ordered list',
  );
  // The five config sections are now sections of the profile itself.
  assert.deepEqual(draft.hierarchy, LEGACY_HIERARCHY);
  assert.deepEqual(draft.roleGraph, LEGACY_ROLE_GRAPH);
  assert.deepEqual(draft.ladder, LEGACY_LADDER);
  assert.deepEqual(draft.ssmDisciplineProjection, LEGACY_PROJECTION);
  // Sections a 0.8.1 file could not carry are present and empty, not missing:
  // "absent" and "none" are different answers, and only one of them is true.
  assert.deepEqual(draft.sourceAssignments, []);
  assert.deepEqual(draft.derivedAttributes, []);
  assert.deepEqual(draft.profileTestExamples, []);
  assert.equal(draft.stableIdProperty, null);
  // And the project's own configuration stayed the project's own.
  assert.deepEqual(service.config(), { extoTemplate: LEGACY_EXTO_TEMPLATE });

  /* -------------------------------------------------- nothing silently lost */

  assert.deepEqual(
    service.listSources().map((source) => ({
      role: source.role,
      rawFileName: source.rawFileName,
      rawSha256: source.rawSha256,
    })),
    [
      { role: 'mel', rawFileName: 'Dragon-MEL.xlsx', rawSha256: sha256Of(melPath) },
      {
        role: 'model',
        rawFileName: 'Dragon-Coordination.matchline-cache',
        rawSha256: sha256Of(cachePath),
      },
      { role: 'prior-ssm', rawFileName: 'Dragon-Prior-SSM.xlsx', rawSha256: 'd'.repeat(64) },
    ],
    'all three sources, including the one whose file is not on this machine',
  );
  assert.deepEqual(
    service.learnedSummaries().map((summary) => [summary.kind, summary.label, summary.rowCount]),
    [
      ['nesting', 'Dragon prior SSM.xlsx', 12],
      ['item-master', 'Dragon item master.xlsx', 10],
      ['wbs', 'Dragon WBS.xlsx', 4],
    ],
    'all three learned kinds, with what they were trained from',
  );
  assert.deepEqual(
    service.listRelationshipOverrides().map((row) => [row.childAssetId, row.parentAssetId, row.note]),
    [
      [NESTING_CHILD, NESTING_PARENT, 'One air handling train.'],
      [CROSSING_CHILD, CROSSING_PARENT, 'Panel and rack are one skid.'],
    ],
    'both manual parents, still spelled the way 0.8.1 filed them',
  );
  const after = dumpTables(path, ['learned', 'overrides', 'snapshots', 'decisions']);
  assert.deepEqual(
    after,
    {
      learned: before.learned,
      overrides: before.overrides,
      snapshots: before.snapshots,
      decisions: before.decisions,
    },
    'the tables the migration has no business rewriting are byte-for-byte what they were',
  );
  const revisionsNow = dumpTables(path, ['profile']).profile;
  assert.equal(
    revisionsNow.length,
    before.profile.length + 1,
    'exactly one profile revision was added: the merge, and nothing else',
  );
  for (const revision of before.profile) {
    assert.ok(
      revisionsNow.includes(revision),
      'and both 0.8.1 revisions are still there, unedited',
    );
  }
  // The compile the 0.8.1 build recorded is history, and history is not the
  // migration's to throw away. Its input hashes are re-keyed to the ids the
  // sources now carry; the hashes themselves are the same bytes.
  const legacyCompile = service.compileHistory().find((entry) => entry.compileId === 1);
  assert.ok(legacyCompile, 'the 0.8.1 compile row survived');
  assert.equal(legacyCompile.profileRevision, 2, 'still pointing at the revision it ran against');
  assert.equal(
    Number(scalar(path, 'SELECT COUNT(*) AS n FROM snapshots')),
    1,
    'and the register it produced is still stored',
  );

  /* ------------------------------- the decisions still apply, on a recompile */

  const status = await service.compile();
  assert.equal(status.state, 'done', status.state === 'failed' ? status.reason : '');
  assert.equal(status.summary.profileRevision, 3, 'compiled against the merged revision');
  assert.equal(status.summary.assetCount, 34, 'the whole Dragon universe, from the recorded cache');

  // P0-9: a tag-keyed override survives because the ledger re-addresses it. The
  // child nests under the parent it was filed against in 0.8.1, by TAG, with no
  // asset id anywhere in the stored row.
  const nested = service.treeSearch(NESTING_CHILD, 5)[0];
  assert.ok(nested, `${NESTING_CHILD} is in the recompiled tree`);
  assert.equal(nested.overridden, true, 'the 0.8.1 manual parent still applies');
  assert.equal(nested.demoted, false, 'and nothing about it crosses a boundary');

  // P0-4: the other one crosses the System boundary, so it folds to a
  // dependency and says so — which is the review item the stored decision is
  // about.
  const review = service.reviewPage('manual-boundary-demotion', 0, 10);
  assert.equal(review.total, 1, 'exactly one refused manual parent');
  const [row] = review.rows;
  assert.equal(
    row.reviewKey,
    CROSSING_REVIEW_KEY,
    'the recompiled item is keyed exactly as 0.8.1 filed the decision',
  );
  assert.equal(row.decision, 'accepted', 'so the decision still resolves onto it');
  assert.equal(row.note, CROSSING_DECISION_NOTE, 'with the words the reviewer wrote');
  assert.equal(review.undecidedCount, 0, 'nothing is waiting on a person again');

  // The stale decision is untouched: not resolved, and not thrown away either.
  assert.equal(
    Number(scalar(path, 'SELECT COUNT(*) AS n FROM decisions')),
    2,
    'a decision this compile no longer produces is still history worth keeping',
  );
  assert.equal(status.summary.orphanedDecisionCount, 0, 'and no manual parent was orphaned');
});

test('a migrated 0.8.1 project reopens as current, with no second backup', async () => {
  const path = join(workDir, 'Dragon.matchline');
  const service = newService();
  try {
    const opened = await service.open(path, false);
    assert.equal(opened.outcome, 'opened', 'it is a current file now; nothing is asked again');
    assert.equal(opened.notice.migration, null);
    assert.equal(opened.notice.mergedLegacyConfig, false, 'the config move happens once');
    assert.equal(opened.project.savedRevision, 3, 'and no second merge revision was written');
    assert.equal(existsSync(`${path}.backup-4`), false);
    assert.deepEqual(service.draftState().draft.hierarchy, LEGACY_HIERARCHY);
  } finally {
    service.close();
  }
});
