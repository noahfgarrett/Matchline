/**
 * Learned item-master assignment, ported from the donor's
 * `packages/legacy-parity/src/compiler/itemmasters.js`.
 *
 * ## What the donor does
 *
 * Train from a prior EXTO registry export as a majority-vote table with two key
 * rungs, then assign only above a confidence gate. The donor's own note, on a
 * real 18k-row registry: ~81% of rows auto-assign at ~99% accuracy and the rest
 * go to review.
 *
 * - **rung A** — `(discipline, equipment classification, UPN)`
 * - **rung B** — `(discipline, UPN, first word of the equipment description)`
 *
 * `UPN` is Matchline's `systemKey` (PRODUCT.md §2.3, "System Key = UPN"), so
 * both rungs are scoped to one system: the same description in two systems is
 * two different pieces of equipment and must not vote on each other's master.
 *
 * Confidence is the dominant name's share of the rows behind a key (donor
 * `lookup`: `topCount / total`) and the gate is 0.9. Below it nothing is
 * assigned and the key's candidates become a review proposal — never a guess.
 * That is the same self-grading discipline `@matchline/learned-rules` applies to
 * nesting, and it is why this package writes proposals rather than cells it is
 * not sure of.
 *
 * Legacy site-specific names normalize onto the universal VF vocabulary when a
 * suffix match exists (`CA_NB_EL_MV_GEAR` → `VF_EL_MV_GEAR`), and suspect
 * registry rows — placeholders, electrical-gear masters on non-electrical
 * equipment — are excluded from learning and reported as an audit list.
 *
 * ## Deliberate deviations, all four of them
 *
 * 1. Keys join on U+0001 rather than the donor's empty `IM_KEYSEP` (see
 *    `keys.ts`).
 * 2. Rows with no `systemKey` are not tallied. The donor tallied them and then
 *    never queried them — both of its lookup sites require a non-empty UPN — so
 *    this is behavior-identical and keeps dead entries out of a Site Profile.
 * 3. Review candidates are ordered by count descending, then name, instead of
 *    the donor's `[...counts.keys()].slice(0,3)` insertion order. A reviewer
 *    should see the leading candidate first, and the list should not depend on
 *    which order the registry rows happened to arrive in.
 * 4. Everything is a plain array here, not a `Map`. The table persists in a Site
 *    Profile the way a `LearnedRuleSet` does, so it is JSON-serializable by
 *    construction: no Maps, no Sets, no functions, no `undefined` fields.
 */

import type { ItemMasterAsset } from './asset.js';
import { classRungKey, descriptionRungKey } from './keys.js';
import { clean, compareCodeUnits, firstWord, normalizePart, round } from './text.js';

/**
 * The donor's gate (`minConfidence=0.9` in `assignItemMasters`).
 *
 * Not a parameter with a default: the gate is the reason the layer is trusted to
 * write cells at all, and a caller that could lower it could turn every
 * proposal into an assignment.
 */
export const ITEM_MASTER_MIN_CONFIDENCE = 0.9;

/** How many candidates a below-gate proposal carries (donor `slice(0,3)`). */
export const ITEM_MASTER_PROPOSAL_CANDIDATES = 3;

/** Which learned rung produced an answer. */
export type ItemMasterRung = 'class' | 'description';

/** Why a registry row was audited instead of learned from. */
export type SuspectRowReason =
  | 'blank-item-master'
  | 'placeholder-item-master'
  | 'electrical-gear-on-non-electrical';

/**
 * One row of a prior EXTO registry export / Rev21 upload sheet.
 *
 * Mirrors the donor's `extoRegistryRows` record (`src/io/exto.js`), with `upn`
 * renamed to `systemKey` and the fields this layer never reads left out.
 */
export interface ItemMasterTrainingRow {
  /** Registry "Equipment ID". Only used to name a row in the audit list. */
  readonly equipmentId: string;
  readonly discipline: string;
  /** Registry "UPN". */
  readonly systemKey: string;
  /** Registry "Item Master Unique Identifier". */
  readonly itemMaster: string;
  /** Registry "Equipment Classification". Absent on rung-B-only registries. */
  readonly equipmentClass?: string;
  readonly description?: string;
}

/** A registry row excluded from learning, with the reason it was excluded. */
export interface SuspectRow {
  readonly equipmentId: string;
  readonly itemMaster: string;
  readonly discipline: string;
  readonly reason: SuspectRowReason;
  /** Reviewer-facing wording of {@link reason}. */
  readonly detail: string;
}

/**
 * One learned key: the dominant item master behind it and how dominant it was.
 *
 * The key's parts are carried as separate fields rather than as the joined
 * string, so a profile editor and a review grid can read the table without
 * knowing the separator.
 */
export interface ItemMasterEntry {
  readonly rung: ItemMasterRung;
  /** Normalized discipline. */
  readonly discipline: string;
  /** Normalized classification; `''` on the description rung. */
  readonly equipmentClass: string;
  /** Normalized system key (UPN). */
  readonly systemKey: string;
  /** Normalized first word of the description; `''` on the class rung. */
  readonly descriptionWord: string;
  /** The dominant name, already CA_*→VF_* normalized. */
  readonly itemMaster: string;
  /** `topCount / total`, 4dp — the number the gate reads. */
  readonly confidence: number;
  /** Rows behind the key, across all names — the donor's `total`. */
  readonly sampleCount: number;
  /**
   * Up to {@link ITEM_MASTER_PROPOSAL_CANDIDATES} names, most-voted first. What
   * a below-gate key offers a reviewer instead of an answer.
   */
  readonly candidates: ReadonlyArray<string>;
}

/** The serializable artifact of one training run. Persists in a Site Profile. */
export interface ItemMasterTable {
  readonly version: 1;
  /**
   * The legal VF item-master vocabulary, in the order the template listed it.
   * Retained because normalization is re-run at print time on masters that did
   * not come from this table.
   */
  readonly vocabulary: ReadonlyArray<string>;
  /** Learned keys, in a deterministic order (rung, then key parts). */
  readonly entries: ReadonlyArray<ItemMasterEntry>;
  /** Registry rows excluded from learning, in registry order. */
  readonly audit: ReadonlyArray<SuspectRow>;
  readonly trainedFrom: { readonly rowCount: number; readonly label: string };
}

/** Options for {@link trainItemMasterTable}. */
export interface TrainItemMasterOptions {
  /**
   * Names from the Standardized Item Master Template — the donor's
   * `itemMasterNames`. Without it no `CA_*` name is ever rewritten: an empty
   * vocabulary means no guessing.
   */
  readonly vocabulary?: ReadonlyArray<string>;
  /** Free text naming the training source, for the review UI. */
  readonly label?: string;
}

/** Why one name was, or was not, rewritten onto the VF vocabulary. */
export type NormalizationRule =
  | 'blank'
  | 'already-vf'
  | 'not-legacy-ca'
  | 'no-vocabulary'
  | 'no-vf-match'
  | 'ca-to-vf';

/** A normalization decision with the reasoning the UI shows for it. */
export interface ItemMasterNormalization {
  readonly input: string;
  readonly output: string;
  readonly rule: NormalizationRule;
  readonly detail: string;
}

/**
 * The outcome of querying the table for one asset.
 *
 * A discriminated union rather than `string | null`, because "no answer" comes
 * in two flavors that a review queue must tell apart: a key the registry
 * disagreed about (`proposal`, with candidates to choose between) and a key it
 * never saw (`unmatched`, which no amount of reviewing this table will settle).
 */
export type ItemMasterAssignment =
  | {
      readonly kind: 'assigned';
      readonly canonicalTag: string;
      readonly itemMaster: string;
      readonly rung: ItemMasterRung;
      readonly rule: string;
      readonly confidence: number;
      readonly sampleCount: number;
    }
  | {
      readonly kind: 'proposal';
      readonly canonicalTag: string;
      readonly candidates: ReadonlyArray<string>;
      readonly rung: ItemMasterRung;
      readonly rule: string;
      readonly confidence: number;
      readonly sampleCount: number;
    }
  | {
      readonly kind: 'unmatched';
      readonly canonicalTag: string;
      readonly reason: 'no-system-key' | 'no-learned-key';
    };

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Donor `normalizeItemMasterName`, with its reasoning kept.
 *
 * The rule, exactly as the donor states it: a `CA_<site>_<rest>` name becomes
 * `VF_<rest>` **only** when `VF_<rest>` is already in the legal vocabulary, and
 * the vocabulary's own spelling is what comes out. Anything already `VF_`
 * passes through; an empty vocabulary means nothing is rewritten.
 *
 * The suffix is matched case-insensitively and the *first* vocabulary entry that
 * matches wins, so a template listing two case variants of one name resolves to
 * the one it lists first — deterministic, given a deterministic template.
 */
export function describeItemMasterNormalization(
  name: string | undefined,
  vocabulary: ReadonlyArray<string>,
): ItemMasterNormalization {
  const value = clean(name);
  if (value === '') {
    return { input: value, output: value, rule: 'blank', detail: 'no item master stated' };
  }
  if (/^VF_/i.test(value)) {
    return {
      input: value,
      output: value,
      rule: 'already-vf',
      detail: 'already a universal VF name',
    };
  }
  const match = /^CA_[A-Z0-9]+_(.+)$/i.exec(value);
  if (match === null) {
    return {
      input: value,
      output: value,
      rule: 'not-legacy-ca',
      detail: 'not a CA_<site>_<name> legacy name',
    };
  }
  if (vocabulary.length === 0) {
    return {
      input: value,
      output: value,
      rule: 'no-vocabulary',
      detail: 'no item-master template supplied, so no name is rewritten',
    };
  }
  const candidate = `VF_${match[1] ?? ''}`;
  const wanted = candidate.toLowerCase();
  for (const known of vocabulary) {
    if (known.toLowerCase() !== wanted) continue;
    return {
      input: value,
      output: known,
      rule: 'ca-to-vf',
      detail: `legacy ${value} matches template name ${known}`,
    };
  }
  return {
    input: value,
    output: value,
    rule: 'no-vf-match',
    detail: `${candidate} is not in the item-master template`,
  };
}

/** {@link describeItemMasterNormalization} without the reasoning. */
export function normalizeItemMasterName(
  name: string | undefined,
  vocabulary: ReadonlyArray<string>,
): string {
  return describeItemMasterNormalization(name, vocabulary).output;
}

/* -------------------------------------------------------------------------- */
/* Suspect rows                                                               */
/* -------------------------------------------------------------------------- */

const SUSPECT_DETAIL: Readonly<Record<SuspectRowReason, string>> = {
  'blank-item-master': 'registry row states no item master',
  'placeholder-item-master': 'placeholder item master',
  'electrical-gear-on-non-electrical': 'electrical-gear item master on non-electrical equipment',
};

/**
 * Item-master names are underscore-separated, and the segment after the prefix
 * says which discipline family the name belongs to.
 *
 * Two prefixes exist. A universal name is `VF_<family>_…`, so the family is
 * segment 1. A legacy site-scoped name is `CA_<site>_<family>_…`, so the family
 * is segment 2 — which is exactly what the CA→VF rewrite above assumes when it
 * turns `CA_<site>_<rest>` into `VF_<rest>`. The donor's own worked example,
 * `CA_NB_EL_MV_GEAR` → `VF_EL_MV_GEAR`, is that structure in both spellings.
 *
 * Returns `''` for anything that is neither shape, which reads as "this name
 * states no family" and never as a match.
 */
function familySegment(itemMaster: string): string {
  const segments = itemMaster.split('_');
  if (segments.length < 2) return '';
  const prefix = (segments[0] ?? '').toUpperCase();
  if (prefix === 'VF') return (segments[1] ?? '').toUpperCase();
  if (prefix === 'CA') return (segments[2] ?? '').toUpperCase();
  return '';
}

/** The family segment that means electrical. */
const ELECTRICAL_FAMILY = 'EL';

/**
 * Apparatus that is electrical whatever else a name says: a transformer and
 * switchgear. Neither word has a non-electrical trade meaning, so finding one on
 * non-electrical equipment is a misfiling regardless of the name's family.
 */
const ELECTRICAL_APPARATUS = ['XFMR', 'SWGR'];

/**
 * `GEAR` is not in that list because it is not that kind of word.
 *
 * It means switchgear inside an electrical name and it means a gearbox, a gear
 * pump or a gear reducer inside a mechanical one, and no amount of looking at
 * the four letters tells the two apart. What does tell them apart is the family
 * segment the name already carries — so `GEAR` counts as electrical evidence
 * only in an electrical-family name.
 */
const ELECTRICAL_GEAR = 'GEAR';

function isElectricalDiscipline(discipline: string): boolean {
  return clean(discipline).toUpperCase().includes('ELECTRICAL');
}

/**
 * Donor `suspectRegistryRow`, narrowed on two measured points.
 *
 * Blank and `*blank*` names are bulk-fill artifacts. An electrical-apparatus
 * master on equipment whose discipline is not electrical is somebody's
 * copy-paste. Neither is evidence about what the equipment is, so neither is
 * learned from — but both are reported, because a registry full of them is a
 * fact about the registry, and one worth showing a reviewer.
 *
 * ## The two narrowings, and why each is safe
 *
 * The donor tested `/GEAR|XFMR|SWGR/i` against the whole name, as a substring.
 * This port requires a **whole underscore-delimited segment**. A substring test
 * fires on any name that merely contains the letters — a mechanical `…_GEARBOX_…`
 * would be audited out for spelling — while these names are segmented by
 * construction and the token is always a segment when it is meant. Measured
 * against a real 18k-row registry this changes nothing at all: every occurrence
 * of all three tokens there is already a whole segment. It is a narrowing of what
 * the rule *can* wrongly catch, not of what it does catch.
 *
 * The second narrowing is the one with a judgement in it. `XFMR` and `SWGR` stay
 * unconditional; `GEAR` additionally requires the name's own family segment to be
 * the electrical one, for the reason {@link ELECTRICAL_GEAR} sets out. On the
 * same registry this also changes nothing — every `GEAR`-bearing name there is
 * already electrical-family — so it costs no recall today and stops a mechanical
 * gearbox master being called misfiled tomorrow.
 *
 * What the rule still catches on that registry, and should: one legacy
 * electrical-switchgear master bulk-filled across several thousand rows of
 * valves, transmitters and pumps. Learning from those would teach that a
 * pressure transmitter's item master is switchgear, and then assign it. Roughly
 * a fifth of that registry is audited out on this rule alone, and every one of
 * those rows is a row it is right about.
 */
export function suspectRowReason(
  row: Pick<ItemMasterTrainingRow, 'itemMaster' | 'discipline'>,
): SuspectRowReason | null {
  const itemMaster = clean(row.itemMaster);
  if (itemMaster === '') return 'blank-item-master';
  if (/blank/i.test(itemMaster)) return 'placeholder-item-master';
  if (isElectricalDiscipline(row.discipline)) return null;

  const segments = itemMaster.split('_').map((segment) => segment.toUpperCase());
  if (segments.some((segment) => ELECTRICAL_APPARATUS.includes(segment))) {
    return 'electrical-gear-on-non-electrical';
  }
  if (
    segments.includes(ELECTRICAL_GEAR) &&
    familySegment(itemMaster) === ELECTRICAL_FAMILY
  ) {
    return 'electrical-gear-on-non-electrical';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Training                                                                   */
/* -------------------------------------------------------------------------- */

/** One key's votes while training. */
interface Tally {
  readonly rung: ItemMasterRung;
  readonly discipline: string;
  readonly equipmentClass: string;
  readonly systemKey: string;
  readonly descriptionWord: string;
  readonly counts: Map<string, number>;
  total: number;
}

/**
 * Train the learned table from prior registry rows.
 *
 * Pure and total: no row is rejected outright, and the same rows always yield
 * the same table in the same order. A row that teaches nothing simply teaches
 * nothing — an empty registry yields an empty table, which assigns nothing and
 * proposes nothing, exactly as the donor's `learned:false` table does.
 */
export function trainItemMasterTable(
  rows: ReadonlyArray<ItemMasterTrainingRow>,
  options: TrainItemMasterOptions = {},
): ItemMasterTable {
  const vocabulary = options.vocabulary ?? [];
  const tallies = new Map<string, Tally>();
  const audit: SuspectRow[] = [];

  for (const row of rows) {
    const reason = suspectRowReason(row);
    if (reason !== null) {
      audit.push({
        equipmentId: clean(row.equipmentId),
        itemMaster: clean(row.itemMaster),
        discipline: clean(row.discipline),
        reason,
        detail: SUSPECT_DETAIL[reason],
      });
      continue;
    }
    const systemKey = normalizePart(row.systemKey);
    if (systemKey === '') continue;

    const name = normalizeItemMasterName(row.itemMaster, vocabulary);
    const discipline = normalizePart(row.discipline);
    const equipmentClass = normalizePart(row.equipmentClass);
    const descriptionWord = firstWord(row.description);

    if (equipmentClass !== '') {
      vote(tallies, classRungKey(discipline, equipmentClass, systemKey), name, {
        rung: 'class',
        discipline,
        equipmentClass,
        systemKey,
        descriptionWord: '',
      });
    }
    if (descriptionWord !== '') {
      vote(tallies, descriptionRungKey(discipline, systemKey, descriptionWord), name, {
        rung: 'description',
        discipline,
        equipmentClass: '',
        systemKey,
        descriptionWord,
      });
    }
  }

  return {
    version: 1,
    vocabulary: [...vocabulary],
    entries: [...tallies.values()].map(toEntry).sort(compareEntries),
    audit,
    trainedFrom: { rowCount: rows.length, label: options.label ?? '' },
  };
}

function vote(
  tallies: Map<string, Tally>,
  key: string,
  name: string,
  parts: Omit<Tally, 'counts' | 'total'>,
): void {
  let tally = tallies.get(key);
  if (tally === undefined) {
    tally = { ...parts, counts: new Map(), total: 0 };
    tallies.set(key, tally);
  }
  tally.counts.set(name, (tally.counts.get(name) ?? 0) + 1);
  tally.total++;
}

function toEntry(tally: Tally): ItemMasterEntry {
  /* Count descending, then name by code unit. The donor broke ties by insertion
     order; a stable rule here keeps the serialized table identical no matter
     which order the registry rows arrived in. */
  const ranked = [...tally.counts.entries()].sort(
    (a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]),
  );
  const top = ranked[0];
  return {
    rung: tally.rung,
    discipline: tally.discipline,
    equipmentClass: tally.equipmentClass,
    systemKey: tally.systemKey,
    descriptionWord: tally.descriptionWord,
    itemMaster: top?.[0] ?? '',
    confidence: round(tally.total === 0 ? 0 : (top?.[1] ?? 0) / tally.total, 4),
    sampleCount: tally.total,
    candidates: ranked.slice(0, ITEM_MASTER_PROPOSAL_CANDIDATES).map(([name]) => name),
  };
}

function compareEntries(a: ItemMasterEntry, b: ItemMasterEntry): number {
  return (
    compareCodeUnits(a.rung, b.rung) ||
    compareCodeUnits(a.discipline, b.discipline) ||
    compareCodeUnits(a.systemKey, b.systemKey) ||
    compareCodeUnits(a.equipmentClass, b.equipmentClass) ||
    compareCodeUnits(a.descriptionWord, b.descriptionWord)
  );
}

/* -------------------------------------------------------------------------- */
/* Assignment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-table lookup index, built once and reused.
 *
 * The donor's table *was* a pair of `Map`s; the serialized form here is arrays,
 * so the Maps are rebuilt on first use rather than on every call. A `WeakMap`
 * keyed on the table means a table read out of a Site Profile is indexed once
 * and released when the profile is, and it keeps {@link assignItemMaster}'s
 * signature the single-asset one the caller wants. A table mutated after its
 * first lookup would keep the stale index — the type is `readonly` throughout
 * and nothing in this package mutates one.
 */
interface RungIndex {
  readonly class: Map<string, ItemMasterEntry>;
  readonly description: Map<string, ItemMasterEntry>;
}

const INDEXES = new WeakMap<ItemMasterTable, RungIndex>();

function indexOf(table: ItemMasterTable): RungIndex {
  const existing = INDEXES.get(table);
  if (existing !== undefined) return existing;
  const index: RungIndex = { class: new Map(), description: new Map() };
  for (const entry of table.entries) {
    const map = entry.rung === 'class' ? index.class : index.description;
    const key =
      entry.rung === 'class'
        ? classRungKey(entry.discipline, entry.equipmentClass, entry.systemKey)
        : descriptionRungKey(entry.discipline, entry.systemKey, entry.descriptionWord);
    /* First wins, so a hand-edited profile that repeats a key behaves the same
       way a scan over the array would. */
    if (!map.has(key)) map.set(key, entry);
  }
  INDEXES.set(table, index);
  return index;
}

/**
 * Assign one asset's item master, or say why it could not be assigned.
 *
 * Rung order is the donor's: the classification rung is consulted first and the
 * description rung second, and the first rung that clears the gate wins. If
 * neither clears it, the first rung that *matched* a learned key supplies the
 * proposal — so a reviewer is shown the more specific rung's disagreement, not
 * the looser rung's.
 */
export function assignItemMaster(
  table: ItemMasterTable,
  asset: ItemMasterAsset,
): ItemMasterAssignment {
  const canonicalTag = clean(asset.canonicalTag);
  const systemKey = normalizePart(asset.systemKey);
  if (systemKey === '') return { kind: 'unmatched', canonicalTag, reason: 'no-system-key' };

  const discipline = normalizePart(asset.ssmDiscipline);
  const equipmentClass = normalizePart(asset.equipmentClass);
  const descriptionWord = firstWord(asset.description);
  const index = indexOf(table);

  const matched: ItemMasterEntry[] = [];
  if (equipmentClass !== '') {
    const hit = index.class.get(classRungKey(discipline, equipmentClass, systemKey));
    if (hit !== undefined) matched.push(hit);
  }
  if (descriptionWord !== '') {
    const hit = index.description.get(descriptionRungKey(discipline, systemKey, descriptionWord));
    if (hit !== undefined) matched.push(hit);
  }

  const assigned = matched.find((entry) => entry.confidence >= ITEM_MASTER_MIN_CONFIDENCE);
  if (assigned !== undefined) {
    return {
      kind: 'assigned',
      canonicalTag,
      itemMaster: assigned.itemMaster,
      rung: assigned.rung,
      rule: describeRung(assigned),
      confidence: assigned.confidence,
      sampleCount: assigned.sampleCount,
    };
  }
  const proposed = matched[0];
  if (proposed !== undefined) {
    return {
      kind: 'proposal',
      canonicalTag,
      candidates: proposed.candidates,
      rung: proposed.rung,
      rule: describeRung(proposed),
      confidence: proposed.confidence,
      sampleCount: proposed.sampleCount,
    };
  }
  return { kind: 'unmatched', canonicalTag, reason: 'no-learned-key' };
}

/** Every outcome for a set of assets, in input order. */
export function assignItemMasters(
  table: ItemMasterTable,
  assets: ReadonlyArray<ItemMasterAsset>,
): ReadonlyArray<ItemMasterAssignment> {
  return assets.map((asset) => assignItemMaster(table, asset));
}

/** The reasoning line a review grid shows next to an outcome. */
function describeRung(entry: ItemMasterEntry): string {
  const scope = `UPN ${entry.systemKey}`;
  if (entry.rung === 'class') {
    return `learned from registry: ${entry.discipline || '(no discipline)'} / ${entry.equipmentClass} / ${scope}`;
  }
  return `learned from registry: ${entry.discipline || '(no discipline)'} / ${scope} / description "${entry.descriptionWord}"`;
}
