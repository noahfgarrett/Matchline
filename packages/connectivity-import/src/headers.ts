/**
 * Header vocabulary and the per-kind column detectors.
 *
 * ## What was ported, and from where
 *
 * The donor's detection lives in `packages/legacy-parity/src/io/detect.js`.
 * These lists are ported from it, name for name:
 *
 * - `normH` — the header normalizer (`clean().toLowerCase()` with every
 *   non-alphanumeric character removed). Reproduced as {@link normalizeHeader}.
 * - `autoDetect` — the EasyPower ladders for `source`, `idName`, the
 *   `Downstream<n>` / `DS<n>` pattern, `loadDesc`, `finalSource`, `circuit`.
 * - `CABLE_FIELDS` + `detectCable` — the ordered, first-match-wins,
 *   header-used-once Cable Schedule field list, including its requirement that
 *   both `Load Name (To)` and `Panel (From)` be present.
 * - `PMD_FIELDS` + `detectPmd` — `PANEL` + `INSTRUMENT TAG` plus the `CARD`,
 *   `POINT POSITION`, `POINT TYPE`, `P&ID`, `Location`, `RELEASE`,
 *   `DESCRIPTION` detail columns.
 * - `MEL_LOOSE_TAG` + `detectMel` — the strong/loose equipment-tag split and
 *   the corroboration rule quoted below.
 *
 * ## The corroboration rule, restated
 *
 * The donor's comment above `MEL_LOOSE_TAG` is the whole idea:
 *
 * > Loose tag-header forms ("Equipment Tag Number", "Tag No.", "Asset Tag") are
 * > only trusted alongside a UPN or System Parent column plus a second
 * > corroborating MEL column, so a cable schedule's "Cable Tag" [...] can't
 * > masquerade as a MEL.
 *
 * Generalized to all four kinds here: a kind whose required headers all matched
 * *exact* known forms is trusted on its own; a kind that had to fall back to a
 * loose form needs a second column of its own family to agree. For the two
 * endpoint-pair kinds (EasyPower, Cable Schedule) one exact endpoint corroborates
 * a loose one; when *both* endpoints are loose, an additional column of that
 * family is required. Without this a two-column `From`/`To` sheet would be read
 * as a power study.
 *
 * ## Matchline additions
 *
 * Matchline uses neutral vocabulary (PRODUCT.md §3), so each ladder also
 * carries the generic bus wording: `From Bus`/`Source Bus`, `To Bus`/`Load Bus`,
 * `Origin`/`Destination`, `Cable Number`. Bare `Tag` is deliberately *not* an
 * instrument-tag or equipment-tag synonym — that is the exact door the donor's
 * corroboration rule closes.
 */

/* ---- normalizers ---- */

/**
 * The donor's `normH`: trim, lowercase, drop everything that is not a letter or
 * a digit. `'P&ID'` → `'pid'`, `'Load Name (To)'` → `'loadnameto'`.
 * `toLowerCase()` takes no locale argument on purpose — locale-aware casing
 * would make the same workbook detect differently on different machines.
 */
export function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The donor's `low` form in `autoDetect`: trimmed and lowercased, whitespace
 * kept. The EasyPower ladders match against this because their patterns are
 * written with `\s*` in them.
 */
export function foldHeader(value: string): string {
  return value.trim().toLowerCase();
}

/** Both forms of one header row, computed once per row scanned. */
interface HeaderCells {
  readonly fold: readonly string[];
  readonly norm: readonly string[];
}

function headerCells(headers: ReadonlyArray<string>): HeaderCells {
  return { fold: headers.map(foldHeader), norm: headers.map(normalizeHeader) };
}

/** What a detector found: the columns by role, and how much they are trusted. */
export interface DetectedColumns {
  readonly columns: Readonly<Record<string, number>>;
  readonly strength: 'exact-headers' | 'corroborated';
}

type HeaderTest = (fold: string, norm: string) => boolean;

/** One rung of a ladder. Rungs are tried in order; within a rung, leftmost wins. */
interface Rung {
  readonly test: HeaderTest;
  /** Whether a match on this rung is a known exact form, trusted on its own. */
  readonly exact: boolean;
}

interface Located {
  readonly index: number;
  readonly exact: boolean;
}

const NOTHING_TAKEN: ReadonlySet<number> = new Set<number>();

/** First header matching the ladder, skipping columns another role already claimed. */
function locate(cells: HeaderCells, ladder: readonly Rung[], taken: ReadonlySet<number>): Located | null {
  for (const rung of ladder) {
    for (let i = 0; i < cells.fold.length; i++) {
      if (taken.has(i)) continue;
      if (rung.test(cells.fold[i] ?? '', cells.norm[i] ?? '')) return { index: i, exact: rung.exact };
    }
  }
  return null;
}

/* ---- EasyPower ---- */

/** Donor `autoDetect`: `^start(ing)? source$` → `start.*source` → `^source$`. */
const EASYPOWER_SOURCE: readonly Rung[] = [
  { exact: true, test: (fold) => /^start(ing)?\s*source$/.test(fold) },
  { exact: true, test: (_fold, norm) => norm === 'frombus' || norm === 'sourcebus' },
  { exact: false, test: (fold) => /start.*source/.test(fold) },
  { exact: false, test: (fold) => /^source$/.test(fold) },
];

/**
 * Donor `autoDetect`: `^id[\s_]*name$` → `id[\s_]*name` → `final load|^id$`.
 *
 * The donor's `loadDesc` column (`load\s*desc`) is the last rung rather than a
 * separate field. The donor picks the leaf tag per row as `ID Name` falling back
 * to `Load Description`; this package's contract is one load column, so the
 * fallback happens at *detection* time — `Load Description` is only the load
 * endpoint on a sheet that has no ID-Name-shaped column at all. On a sheet that
 * has both, rows with a blank `ID Name` are skipped as `missing-to` rather than
 * silently re-read from another column, and a caller who wants the other
 * behavior passes an explicit mapping.
 */
const EASYPOWER_LOAD: readonly Rung[] = [
  { exact: true, test: (fold) => /^id[\s_]*name$/.test(fold) },
  { exact: true, test: (_fold, norm) => norm === 'tobus' || norm === 'loadbus' },
  { exact: false, test: (fold) => /id[\s_]*name/.test(fold) },
  { exact: false, test: (fold) => /(final\s*load|^id$)/.test(fold) },
  { exact: false, test: (fold) => /^load$/.test(fold) },
  { exact: false, test: (fold) => /load\s*desc/.test(fold) },
];

/** The donor's other EasyPower columns, reported but not required. */
function easyPowerExtras(cells: HeaderCells, taken: ReadonlySet<number>): Record<string, number> {
  const extras: Record<string, number> = {};
  const downstream: Array<{ readonly level: number; readonly index: number }> = [];
  for (let i = 0; i < cells.fold.length; i++) {
    if (taken.has(i)) continue;
    const fold = cells.fold[i] ?? '';
    const norm = cells.norm[i] ?? '';
    const level = /down\s*stream\s*0*(\d+)/.exec(fold) ?? /^ds\s*0*(\d+)$/.exec(fold);
    if (level) {
      downstream.push({ level: Number(level[1] ?? '0'), index: i });
      continue;
    }
    if (extras['finalSource'] === undefined && /final.*source/.test(fold)) {
      extras['finalSource'] = i;
      continue;
    }
    if (extras['circuit'] === undefined && (/circuit\s*#/.test(fold) || norm === 'circuit')) {
      extras['circuit'] = i;
      continue;
    }
    if (extras['loadDescription'] === undefined && /load\s*desc/.test(fold)) {
      extras['loadDescription'] = i;
    }
  }
  /* Donor sorts the Downstream columns by their number, not by position. */
  downstream.sort((a, b) => a.level - b.level || a.index - b.index);
  for (const column of downstream) extras[`downstream${column.level}`] = column.index;
  return extras;
}

/** EasyPower needs both ends: the donor's `ok` requires `source` and `idName`. */
export function detectEasyPowerColumns(headers: ReadonlyArray<string>): DetectedColumns | null {
  const cells = headerCells(headers);
  const source = locate(cells, EASYPOWER_SOURCE, NOTHING_TAKEN);
  if (source === null) return null;
  const taken = new Set<number>([source.index]);
  const load = locate(cells, EASYPOWER_LOAD, taken);
  if (load === null) return null;
  taken.add(load.index);

  const extras = easyPowerExtras(cells, taken);
  if (!source.exact && !load.exact && Object.keys(extras).length === 0) return null;
  return {
    columns: { source: source.index, load: load.index, ...extras },
    strength: source.exact && load.exact ? 'exact-headers' : 'corroborated',
  };
}

/* ---- Cable Schedule ---- */

/** One donor `CABLE_FIELDS` entry, split into its exact and loose forms. */
interface CableField {
  readonly role: string;
  readonly exact?: HeaderTest;
  readonly loose: HeaderTest;
}

/**
 * Donor `CABLE_FIELDS`, order preserved — first match wins and a header is used
 * once, so `Cable Tag` claims `cabletag` before `Cable (ref table)` can.
 */
const CABLE_FIELDS: readonly CableField[] = [
  {
    role: 'to',
    exact: (_fold, norm) => norm === 'loadnameto' || norm === 'destination',
    loose: (_fold, norm) =>
      (norm.includes('loadname') && norm.includes('to')) || norm === 'to' || norm === 'tobus',
  },
  {
    role: 'from',
    exact: (_fold, norm) => norm === 'panelfrom' || norm === 'origin',
    loose: (_fold, norm) =>
      (norm.includes('panel') && norm.includes('from')) || norm === 'from' || norm === 'frombus',
  },
  { role: 'circuitsId', loose: (_fold, norm) => norm === 'circuitsid' },
  {
    role: 'cableTag',
    loose: (_fold, norm) =>
      norm.includes('cabletag') || (norm.includes('cable') && norm.includes('number')),
  },
  {
    role: 'circuitNumber',
    loose: (_fold, norm) =>
      norm.includes('circuitnumber') || (norm.includes('circuit') && norm.includes('number')),
  },
  { role: 'circuitId', loose: (_fold, norm) => norm === 'circuitid' },
  {
    role: 'loadRating',
    loose: (_fold, norm) =>
      norm.includes('kva') ||
      norm.includes('hpamps') ||
      (norm.includes('load') && (norm.includes('kva') || norm.includes('hp') || norm.includes('amps'))),
  },
  { role: 'cableReference', loose: (_fold, norm) => norm.includes('reference') || norm === 'cable' },
  {
    role: 'packageRevision',
    loose: (_fold, norm) => norm.includes('package') || norm.includes('revision'),
  },
  { role: 'rfiNumber', loose: (_fold, norm) => norm.includes('rfi') },
  {
    role: 'cableLength',
    loose: (_fold, norm) =>
      norm.includes('cablelength') || (norm.includes('cable') && norm.includes('length')),
  },
  { role: 'raceway', loose: (_fold, norm) => norm.includes('raceway') },
];

/** Donor `detectCable`: no `Load Name (To)` or no `Panel (From)` means no cable sheet. */
export function detectCableColumns(headers: ReadonlyArray<string>): DetectedColumns | null {
  const cells = headerCells(headers);
  const taken = new Set<number>();
  const columns: Record<string, number> = {};
  const exactRoles = new Set<string>();

  for (const field of CABLE_FIELDS) {
    const ladder: Rung[] = [];
    if (field.exact) ladder.push({ test: field.exact, exact: true });
    ladder.push({ test: field.loose, exact: false });
    const found = locate(cells, ladder, taken);
    if (found === null) continue;
    columns[field.role] = found.index;
    if (found.exact) exactRoles.add(field.role);
    taken.add(found.index);
  }

  if (columns['to'] === undefined || columns['from'] === undefined) return null;
  const endpointsExact = exactRoles.has('to') && exactRoles.has('from');
  const anyEndpointExact = exactRoles.has('to') || exactRoles.has('from');
  const detailCount = Object.keys(columns).length - 2;
  if (!anyEndpointExact && detailCount === 0) return null;
  return { columns, strength: endpointsExact ? 'exact-headers' : 'corroborated' };
}

/* ---- PMD ---- */

/** Donor `detectPmd`: exact `panel`. Prefixed forms are the loose fallback. */
const PMD_PANEL: readonly Rung[] = [
  { exact: true, test: (_fold, norm) => norm === 'panel' },
  { exact: false, test: (_fold, norm) => norm.startsWith('panel') },
];

/**
 * Donor `detectPmd`: exact `instrumenttag`. Bare `tag` is intentionally absent —
 * accepting it would let a MEL or a cable schedule detect as PMD.
 */
const PMD_INSTRUMENT: readonly Rung[] = [
  { exact: true, test: (_fold, norm) => norm === 'instrumenttag' },
  {
    exact: false,
    test: (_fold, norm) => norm === 'instrument' || norm === 'pointtag' || norm === 'devicetag',
  },
];

/** Donor `PMD_FIELDS`, by normalized header. */
const PMD_DETAILS: ReadonlyArray<readonly [role: string, norm: string]> = [
  ['card', 'card'],
  ['pointPosition', 'pointposition'],
  ['pointType', 'pointtype'],
  ['pid', 'pid'],
  ['location', 'location'],
  ['release', 'release'],
  ['description', 'description'],
];

export function detectPmdColumns(headers: ReadonlyArray<string>): DetectedColumns | null {
  const cells = headerCells(headers);
  const panel = locate(cells, PMD_PANEL, NOTHING_TAKEN);
  if (panel === null) return null;
  const taken = new Set<number>([panel.index]);
  const instrument = locate(cells, PMD_INSTRUMENT, taken);
  if (instrument === null) return null;
  taken.add(instrument.index);

  const columns: Record<string, number> = { panel: panel.index, instrument: instrument.index };
  for (const [role, norm] of PMD_DETAILS) {
    const index = cells.norm.findIndex((cell, i) => !taken.has(i) && cell === norm);
    if (index < 0) continue;
    columns[role] = index;
    taken.add(index);
  }

  const bothExact = panel.exact && instrument.exact;
  if (!bothExact && Object.keys(columns).length === 2) return null;
  return { columns, strength: bothExact ? 'exact-headers' : 'corroborated' };
}

/* ---- MEL ---- */

/** Donor `MEL_LOOSE_TAG`, verbatim. */
const MEL_LOOSE_TAG = /^(equipment|equip|asset)?tag(s|no|num|number)?$/;

/**
 * Donor `detectMel`, ported whole. Recognized so a MEL tab is classified rather
 * than left to be read as connectivity; this package never imports one.
 */
export function detectMelColumns(headers: ReadonlyArray<string>): DetectedColumns | null {
  const norm = headers.map(normalizeHeader);
  const find = (test: (value: string) => boolean): number => norm.findIndex(test);

  const strongTag = (value: string): boolean =>
    value === 'equipmenttag' || (value.endsWith('equipmenttag') && !value.startsWith('systemparent'));
  let tag = find(strongTag);
  let loose = false;
  if (tag < 0) {
    tag = find((value) => MEL_LOOSE_TAG.test(value));
    loose = true;
  }
  if (tag < 0) return null;

  const upn = find((value) => value === 'upn' || value.startsWith('upn') || value.endsWith('upn'));
  const building = find(
    (value) => value === 'bldg' || value === 'building' || value.startsWith('building'),
  );
  const systemParent = find((value) => value.startsWith('systemparent') && value.includes('tag'));
  const discipline = find((value) => value === 'discipline' || value.startsWith('discipline'));
  const systemDescription = find(
    (value) => value === 'systemdescription' || (value.startsWith('system') && value.includes('description')),
  );
  const projectPhase = find((value) => value === 'projectphase' || value.startsWith('projectphase'));
  const description = find((value) => value === 'equipmentdescription' || value === 'description');

  const corroborators: ReadonlyArray<readonly [role: string, index: number]> = [
    ['upn', upn],
    ['building', building],
    ['systemParent', systemParent],
    ['discipline', discipline],
    ['systemDescription', systemDescription],
    ['projectPhase', projectPhase],
    ['description', description],
  ];
  if (loose) {
    const present = corroborators.filter(([, index]) => index >= 0).length;
    if (present < 2 || (upn < 0 && systemParent < 0)) return null;
  }

  const columns: Record<string, number> = { equipmentTag: tag };
  for (const [role, index] of corroborators) if (index >= 0) columns[role] = index;
  return { columns, strength: loose ? 'corroborated' : 'exact-headers' };
}
