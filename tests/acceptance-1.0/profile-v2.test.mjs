/**
 * SiteProfileV2 — one versioned profile, and a package format that migrates.
 *
 * > One versioned profile: mappings (incl. per-source + fallback chains),
 * > source assignments, filters, anatomy, resolver, derived attributes,
 * > hierarchy levels (key/display/boundary), boundaries, role graph, ladder,
 * > discipline projection, explicit parent properties, identity
 * > normalization/aliases, authority rules, profile test examples. [...]
 * > Profile package format v2; v1 imports migrate, never refused.
 *
 * ## What is true today, and why that is the bug
 *
 * A profile is currently two halves that travel together by convention rather
 * than by type. `SiteProfile` (`packages/domain/src/profile.ts`) carries
 * mappings, filters, anatomy and the resolver; everything else — hierarchy,
 * role graph, ladder, discipline projection, parent-tag property — is
 * "configuration the Site Profile cannot yet carry" and arrives on
 * `CompileProjectInput` instead. `apps/desktop/electron/services/
 * profile-package.ts` glues them back together as `{draft, config}` and stamps
 * `formatVersion: 1`.
 *
 * That split is what SiteProfileV2 removes, and it is why the package format
 * has to move with it: the sections P0-1 and P0-7 and P0-8 add (source
 * assignments, per-source mappings, derived attributes) have nowhere to live in
 * a `{draft, config}` package.
 *
 * The migration rule is the load-bearing half. `profilePackageSchema` pins
 * `formatVersion: z.literal(1)`, so a build that simply moved the literal to 2
 * would start *refusing* every package a site had already exported. "v1 imports
 * migrate, never refused" is the requirement; this file is what proves it.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The desktop package's built output: the profile package is a desktop service,
// and reading the real one is the only way this gate can fail honestly.
import { emptyDraft } from '../../apps/desktop/dist/electron/services/draft-profile.js';
import {
  buildPackage,
  readPackage,
} from '../../apps/desktop/dist/electron/services/profile-package.js';
import { defaultProjectConfig } from '../../apps/desktop/dist/electron/services/project-config.js';

import { attempt, mentionsAll, pending } from './support.mjs';

/** Milestone 4: "Hierarchy+profile semantics" — SiteProfileV2 lands with it. */
const MILESTONE = 4;

const EXPORTED_AT = '2026-08-10T09:00:00.000Z';
const APP_VERSION = '1.0.0';

/**
 * The sections SiteProfileV2 is specified to carry.
 *
 * The names are the plan's own vocabulary rendered in this repo's camelCase.
 * They are asserted as *keys* because a versioned profile whose sections are
 * implicit is the thing being replaced — but if milestone 4 settles on
 * different spellings, this list is the one place to reconcile them, and the
 * failure below prints exactly which are missing.
 */
const SITE_PROFILE_V2_SECTIONS = [
  'propertyMappings',
  'sourceAssignments',
  'assetFilters',
  'tagAnatomy',
  'systemResolver',
  'derivedAttributes',
  'hierarchy',
  'roleGraph',
  'ladder',
  'ssmDisciplineProjection',
  'parentTagProperty',
  'identityConfig',
  'authorityRules',
  'profileTestExamples',
];

/** A Dragon draft with enough set that "the decisions survived" is checkable. */
function dragonDraft() {
  const draft = emptyDraft('Dragon');
  return {
    ...draft,
    propertyMappings: {
      ...draft.propertyMappings,
      equipmentTag: { category: 'Dragon Data', name: 'Tag' },
      building: { category: 'Dragon Data', name: 'Building' },
    },
    tagAnatomy: { ...draft.tagAnatomy, familyKeyTemplate: '{system}-{token:1}-{token:2}' },
  };
}

/** A v1 package exactly as a 0.8.1 build wrote them, as JSON on disk. */
function writeV1Package(directory) {
  const path = join(directory, 'dragon.matchline-profile.json');
  const v1 = {
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    appVersion: '0.8.1',
    draft: dragonDraft(),
    config: defaultProjectConfig(),
  };
  writeFileSync(path, `${JSON.stringify(v1, null, 2)}\n`, 'utf8');
  return path;
}

let directory = '';

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'matchline-a10-profile-v2-'));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('a newly built profile package is format version 2', () => {
  const built = buildPackage(dragonDraft(), defaultProjectConfig(), APP_VERSION, EXPORTED_AT);
  assert.equal(
    built.formatVersion,
    2,
    pending(MILESTONE, 'the portable profile package is written at format version 2'),
  );
});

test('a v1 package is migrated on import, never refused', () => {
  const path = writeV1Package(directory);
  const imported = attempt(
    MILESTONE,
    'readPackage accepts a v1 profile package and migrates it',
    () => readPackage(path),
  );

  assert.equal(
    imported.formatVersion,
    2,
    pending(MILESTONE, 'importing a v1 package yields a migrated v2 package, not a v1 one'),
  );
});

test('migration keeps every decision the v1 package carried', () => {
  const path = writeV1Package(directory);
  const imported = attempt(
    MILESTONE,
    'readPackage accepts a v1 profile package and migrates it',
    () => readPackage(path),
  );

  // A migration that dropped decisions would be worse than a refusal: the
  // refusal is visible and the silent loss is not (RELEASE-1.0-PLAN gate 13,
  // "no silent decision loss").
  assert.ok(
    mentionsAll(imported, ['Dragon Data', 'Tag', 'Building', '{system}-{token:1}-{token:2}']),
    pending(MILESTONE, 'the migrated package still carries the v1 mappings and anatomy'),
  );
  assert.ok(
    mentionsAll(imported, ['building', 'ssm-discipline', 'system']),
    pending(MILESTONE, 'the migrated package still carries the v1 hierarchy levels'),
  );
});

test('a v2 package carries ONE versioned profile, not a draft/config pair', () => {
  const built = buildPackage(dragonDraft(), defaultProjectConfig(), APP_VERSION, EXPORTED_AT);
  const profile = built.profile;
  assert.ok(
    profile,
    pending(MILESTONE, 'the package carries a single SiteProfileV2 (`profile`) instead of `{draft, config}`'),
  );

  const missing = SITE_PROFILE_V2_SECTIONS.filter((section) => !(section in profile));
  assert.deepEqual(
    missing,
    [],
    pending(MILESTONE, `SiteProfileV2 carries every specified section (missing: ${missing.join(', ')})`),
  );
});

test('a profile package still carries decisions only — no model or spreadsheet content', () => {
  // Not a target assertion — the §13.3 invariant SiteProfileV2 must not relax.
  // A profile is what a site may send to another site.
  const built = buildPackage(dragonDraft(), defaultProjectConfig(), APP_VERSION, EXPORTED_AT);
  const text = JSON.stringify(built);
  for (const extension of ['.nwd', '.nwc', '.nwf', '.xlsx', '.sqlite', '.matchline-cache']) {
    assert.ok(!text.includes(extension), `a profile package must not name a ${extension} file`);
  }
});
