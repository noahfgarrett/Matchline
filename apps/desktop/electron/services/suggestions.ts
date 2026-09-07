import type { UniversePropertyCatalogEntry } from '@matchline/asset-catalog';
import {
  extoRev21SystemName,
  extoRev21UpnCandidates,
} from '@matchline/ssm-audit/exto';
import { previewAnatomy, type AnatomyPreview } from '@matchline/tag-anatomy';

import type {
  WireAnatomySuggestion,
  WireClassSuggestion,
  WireFieldSuggestion,
  WirePropertySuggestion,
  WireResolverTemplate,
  WireRolePairSuggestion,
  WireSegmentName,
  WireSourceAssignmentRule,
  WireSuggestionConfidence,
  WireSuggestionTarget,
  WireTagAnatomy,
} from '../../shared/schemas.js';

/**
 * The data-driven suggestions the Quick Setup path offers
 * (RELEASE-1.0-PLAN "One-hour UX").
 *
 * ## What this is, and what it is not
 *
 * PRODUCT.md §6.5 lists six signals a suggestion could rest on: name synonyms,
 * fill rate, cardinality, value shape, tag overlap with the connectivity
 * sources, and consistency by source model. `property-page.ts` implements the
 * first one for screen 2's hint column and says so. This module implements the
 * first FOUR — the ones that are cheap over a catalog that has already been
 * built — and deliberately not the last two, because tag overlap needs the
 * workbooks parsed and per-source-model consistency needs a second pass over
 * every cache, and neither is worth making a person wait for on a screen whose
 * whole promise is speed.
 *
 * Nothing here decides anything. Every function returns a ranked list with the
 * evidence attached; accepting one is a `profile:update` a person pressed. That
 * is the plan's "never silently published" and it is not negotiable — a
 * suggestion engine that writes to the draft is a robot filling in a
 * commissioning register.
 *
 * ## Scores are within-field only
 *
 * A score is a weighted sum of four signals whose weights differ per field,
 * because the fields want different things: an equipment tag wants values that
 * are nearly all distinct and shaped like tags, and a building wants a handful
 * of repeated short codes. Comparing 0.8 for the tag against 0.8 for the
 * building means nothing, and nothing in the UI puts them side by side.
 */

/* ------------------------------------------------------------------ shapes */

/** What a field's values ought to look like, for the value-shape signal. */
type ValueShape = 'tag' | 'code' | 'words' | 'any';

/** What a field's distinct-value count ought to look like. */
type Cardinality = 'unique' | 'few' | 'many';

/**
 * A tag: runs of upper-case letters and digits joined by separators.
 *
 * `MAH001-10-01`, `P-101A`, `TT_1234`. Deliberately structural rather than a
 * catch-all: a value with no separator at all is a code, not a tag, and a value
 * with lower-case words in it is a description. The point of the signal is to
 * tell `Dragon Data > Tag` from `Item > Name` when both carry `MAH001-10-01` on
 * the equipment rows — `Item > Name` also carries `Solid` and `D1`, and this is
 * what notices.
 */
const TAG_SHAPE = /^[A-Z0-9]+(?:[-_./][A-Z0-9]+)+$/;

/**
 * A tag with no separator in it at all: letters, then digits, then at most one
 * letter. `AHU1`, `P101`, `MCC2A`.
 *
 * Revit's `Mark` is the reason this exists. A mark is typed by a person into a
 * one-line parameter and it very often has no separator — and under the rule
 * above, `P101` scored zero on shape, which put the equipment tag of every
 * Revit-authored model behind whatever else happened to be named like a tag.
 *
 * Worth {@link BARE_TAG_STRENGTH} rather than a full point, because the reason
 * the separated shape is trusted still holds: `AHU-1` cannot be a description
 * and `1811` could be a WBS code. A mark is the best candidate on a Revit model
 * because of its NAME and its uniqueness; the shape signal is there to stop a
 * property full of prose from beating it, and a partial point does that.
 */
const BARE_TAG_SHAPE = /^[A-Z]{1,6}[0-9]{1,6}[A-Z]?$/;

/** What a separator-less tag is worth against one that carries a separator. */
const BARE_TAG_STRENGTH = 0.6;

/** A short code with no spaces: `D1`, `AHU`, `1811`, `VF_MECH_AHU`. */
const CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9\-_./]{0,23}$/;

/** Prose: at least two words, or one long enough to be a name rather than a code. */
function looksLikeWords(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes(' ')) {
    return true;
  }
  return trimmed.length > 12 && /[a-z]/.test(trimmed);
}

/** How well one value fits one shape: 0, 1, or a partial point for a bare tag. */
function shapeStrength(value: string, shape: ValueShape): number {
  const trimmed = value.trim();
  switch (shape) {
    case 'tag':
      return TAG_SHAPE.test(trimmed)
        ? 1
        : BARE_TAG_SHAPE.test(trimmed)
          ? BARE_TAG_STRENGTH
          : 0;
    case 'code':
      return CODE_SHAPE.test(trimmed) && !trimmed.includes(' ') ? 1 : 0;
    case 'words':
      return looksLikeWords(value) ? 1 : 0;
    case 'any':
      return 1;
    default: {
      const exhaustive: never = shape;
      throw new Error(`Unhandled value shape: ${String(exhaustive)}`);
    }
  }
}

/* ------------------------------------------------------------ field profiles */

interface SignalWeights {
  readonly name: number;
  readonly fill: number;
  readonly shape: number;
  readonly cardinality: number;
}

/**
 * A name this field is not usually called, but which is sometimes the only
 * thing a model offers.
 *
 * `strength` is what the name signal is worth, between 0 and 1, against the
 * full point an exact synonym scores. `why` is the sentence the candidate
 * carries onto the screen, because a proposal made on weak evidence has to say
 * that it is a proposal made on weak evidence.
 */
interface WeakSynonym {
  readonly folded: string;
  readonly strength: number;
  readonly why: string;
}

interface FieldProfile {
  readonly target: WireSuggestionTarget;
  readonly label: string;
  readonly what: string;
  readonly example: string;
  /** Folded, exact. See {@link nameScoreOf}. */
  readonly synonyms: ReadonlyArray<string>;
  /** Names that are evidence, but not the field's own name. Never pre-ticked. */
  readonly weakSynonyms?: ReadonlyArray<WeakSynonym>;
  /**
   * Words that disqualify a property from this field outright.
   *
   * Not a low score — an exclusion. `System Classification` is a duct's air
   * system, not the commissioning register's classification column, and a field
   * whose synonym list merely outranked it would still put it on the screen for
   * somebody to accept by mistake.
   */
  readonly antiSynonyms?: ReadonlyArray<string>;
  readonly shape: ValueShape;
  readonly cardinality: Cardinality;
  readonly weights: SignalWeights;
  /** True for the one field a project cannot be published without. */
  readonly required?: boolean;
}

/**
 * `Dragon Data` -> `dragondata`. Lower case, alphanumerics only.
 *
 * The same fold `property-page.ts` uses, so a name that suggests a role on
 * screen 2 suggests the same one here rather than a subtly different one.
 */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `Equipment Tag No.` -> `['equipment', 'tag', 'no']`. camelCase splits too. */
function words(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(fold)
    .filter((word) => word !== '');
}

/**
 * The expanded field list the one-hour directive names.
 *
 * Ten of these are profile sections in their own right. The other six — Area,
 * Level, Manufacturer, Model Number, Functional Location and System/UPN — have
 * no mapping slot and are proposed as `DerivedAttributeDefinition`s with one
 * `model-property` rung (P0-7), which is precisely what they are: a field this
 * site composes out of the evidence it already has. Inventing eight new keys on
 * `PropertyMappings` to hold them would be a domain change made to fit a wizard.
 */
const FIELD_PROFILES: readonly FieldProfile[] = [
  {
    target: { kind: 'mapped-field', field: 'equipmentTag' },
    label: 'Equipment tag',
    what: 'The property Matchline reads the equipment tag from. It is the identity of every asset.',
    example: 'Dragon Data > Tag holding MAH001-10-01',
    synonyms: [
      'tag',
      'tagno',
      'tagnumber',
      'equipmenttag',
      'equipmentid',
      'equipmentnumber',
      'assettag',
      'mark',
      'itemmark',
    ],
    shape: 'tag',
    cardinality: 'unique',
    weights: { name: 0.35, fill: 0.15, shape: 0.3, cardinality: 0.2 },
    required: true,
  },
  {
    target: { kind: 'mapped-field', field: 'description' },
    label: 'Description',
    what: 'Free text shown beside the tag in the register and in the generated MEL.',
    example: 'Primary dry air handling unit',
    synonyms: ['description', 'desc', 'equipmentdescription', 'itemdescription', 'servicedescription', 'service'],
    shape: 'words',
    cardinality: 'many',
    weights: { name: 0.4, fill: 0.3, shape: 0.2, cardinality: 0.1 },
  },
  {
    target: { kind: 'mapped-field', field: 'equipmentType' },
    label: 'Equipment type',
    what: 'What kind of thing this is. Used for grouping and for the role rules later on.',
    example: 'Air Handler',
    synonyms: ['type', 'equipmenttype', 'assettype', 'category', 'family', 'itemtype', 'typename', 'familyandtype'],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.4, fill: 0.2, shape: 0.15, cardinality: 0.25 },
  },
  {
    target: { kind: 'mapped-field', field: 'building' },
    label: 'Building',
    what: 'Which building the asset sits in. Becomes the top level of the hierarchy.',
    example: 'B14',
    synonyms: ['building', 'buildingname', 'buildingcode', 'bldg', 'facility', 'site'],
    // A Revit federation has no property called Building. What it has is a
    // workset, which on a per-building delivery is named after the building,
    // and a level, which is not a building at all but is at least a place. Both
    // are offered with the reason attached and neither is ever pre-ticked — see
    // `confidenceOf`. The better answer on such a model is usually a
    // source-assignment rule read off the file names (`suggestSourceAssignments`).
    weakSynonyms: [
      {
        folded: 'workset',
        strength: 0.6,
        why: 'Named “Workset”. Revit models have no Building parameter; a per-building delivery usually names its worksets after the building, so this is the nearest thing the model states.',
      },
      {
        folded: 'level',
        strength: 0.4,
        why: 'Named “Level”. A level is a floor, not a building — L01 exists in every building on the site — so take this only if this project is one building.',
      },
      {
        folded: 'floor',
        strength: 0.4,
        why: 'Named “Floor”. A floor is not a building; take it only if this project is one building.',
      },
    ],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.4, fill: 0.2, shape: 0.15, cardinality: 0.25 },
  },
  {
    target: { kind: 'mapped-field', field: 'nativeDiscipline' },
    label: 'Native discipline',
    what: 'The discipline as the model authors wrote it. Matchline projects it to an SSM discipline later and never overwrites it.',
    example: 'Mechanical',
    synonyms: ['discipline', 'nativediscipline', 'trade', 'disciplinecode'],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.45, fill: 0.15, shape: 0.15, cardinality: 0.25 },
  },
  {
    target: { kind: 'mapped-field', field: 'wbs' },
    label: 'WBS',
    what: 'The work-breakdown code. Left unmapped, Matchline learns one code per system from a prior registry.',
    example: '1811',
    synonyms: ['wbs', 'wbscode', 'workbreakdown', 'workbreakdownstructure'],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.55, fill: 0.15, shape: 0.1, cardinality: 0.2 },
  },
  {
    target: { kind: 'mapped-field', field: 'itemMaster' },
    label: 'Item Master Unique Identifier',
    what: 'The item-master name. Left unmapped, Matchline learns it from a prior registry.',
    example: 'VF_MECH_AHU',
    synonyms: ['itemmaster', 'itemmasteruniqueidentifier', 'imui', 'itemmastername'],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.6, fill: 0.1, shape: 0.1, cardinality: 0.2 },
  },
  {
    target: { kind: 'mapped-field', field: 'equipmentClassification' },
    label: 'Equipment Classification',
    what: "The register's classification column. Left unmapped, Matchline falls back to the equipment type.",
    example: 'AHU',
    // `category` and `family` are here because on a Revit model they are what
    // this column is filled from: an EXTO classification of an air handling unit
    // is read off `Element > Category` = Mechanical Equipment and
    // `Element > Family` = Air Handling Unit, and nothing else in the file says
    // what kind of thing an object is.
    synonyms: [
      'classification',
      'equipmentclassification',
      'assetclass',
      'classcode',
      'category',
      'family',
      'omniclass',
      'assemblycode',
    ],
    // `System Classification` is a duct's air system — Supply Air, Exhaust Air,
    // Power. It is evidence for the System Resolver and it is not this column;
    // offering it here is how a register ends up classifying every air handler
    // as "Supply Air".
    antiSynonyms: ['system'],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.5, fill: 0.15, shape: 0.1, cardinality: 0.25 },
  },
  {
    target: { kind: 'parent-tag' },
    label: 'Parent tag',
    what: 'A property naming the tag of the equipment this asset hangs off. The strongest parent evidence there is, because the model states it outright.',
    example: 'Dragon Data > Parent holding MAH001-10-01',
    synonyms: ['parent', 'parenttag', 'parentequipment', 'parentid', 'host', 'hostequipment', 'fedfrom'],
    shape: 'tag',
    cardinality: 'many',
    weights: { name: 0.55, fill: 0.1, shape: 0.25, cardinality: 0.1 },
  },
  {
    target: { kind: 'stable-id' },
    label: 'Site-wide asset number',
    what: 'The number a person maintains that follows equipment between documents. Matchline trusts it above every model-borne id.',
    example: 'REG-000123, still REG-000123 after the tag is corrected',
    synonyms: ['assetnumber', 'plantnumber', 'registernumber', 'registrynumber', 'uniqueassetid'],
    shape: 'code',
    cardinality: 'unique',
    weights: { name: 0.5, fill: 0.1, shape: 0.15, cardinality: 0.25 },
  },
  {
    target: { kind: 'derived-attribute', attributeId: 'area' },
    label: 'Area',
    what: 'The area or zone the equipment is in. Becomes a field you can group or bound a hierarchy level by.',
    example: 'North Yard',
    synonyms: ['area', 'zone', 'room', 'space', 'areacode'],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.5, fill: 0.15, shape: 0.1, cardinality: 0.25 },
  },
  {
    target: { kind: 'derived-attribute', attributeId: 'level' },
    label: 'Level',
    what: 'The floor or elevation the equipment sits on. Becomes a field you can group by.',
    example: 'Level 02',
    synonyms: ['level', 'floor', 'storey', 'story', 'elevation'],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.5, fill: 0.15, shape: 0.1, cardinality: 0.25 },
  },
  {
    target: { kind: 'derived-attribute', attributeId: 'manufacturer' },
    label: 'Manufacturer',
    what: 'Who made it. Carried into the register as a field of its own.',
    example: 'Dragon Air Systems',
    synonyms: ['manufacturer', 'make', 'vendor', 'supplier', 'brand'],
    shape: 'words',
    cardinality: 'few',
    weights: { name: 0.55, fill: 0.15, shape: 0.1, cardinality: 0.2 },
  },
  {
    target: { kind: 'derived-attribute', attributeId: 'model-number' },
    label: 'Model number',
    what: "The manufacturer's model or catalogue number.",
    example: 'AHU-4400-X',
    synonyms: ['model', 'modelnumber', 'modelno', 'catalognumber', 'partnumber'],
    shape: 'code',
    cardinality: 'many',
    weights: { name: 0.55, fill: 0.15, shape: 0.15, cardinality: 0.15 },
  },
  {
    target: { kind: 'derived-attribute', attributeId: 'functional-location' },
    label: 'Functional location',
    what: 'The maintenance-system location code, when the model already carries one.',
    example: 'D1-MECH-0100',
    synonyms: ['functionallocation', 'floc', 'functionalloc', 'locationcode', 'sapfloc'],
    shape: 'code',
    cardinality: 'many',
    weights: { name: 0.6, fill: 0.1, shape: 0.15, cardinality: 0.15 },
  },
  {
    target: { kind: 'derived-attribute', attributeId: 'system-upn' },
    label: 'System / UPN',
    what: 'The unit-process number or system code the model states. Worth having as a field even when the System Resolver reads it from the tag.',
    example: '001',
    synonyms: ['upn', 'system', 'systemcode', 'systemno', 'unitprocessnumber', 'processunit'],
    shape: 'code',
    cardinality: 'few',
    weights: { name: 0.5, fill: 0.2, shape: 0.1, cardinality: 0.2 },
  },
];

/* ---------------------------------------------------------------- scoring */

function clamp(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * How much the property's NAME says it plays this role.
 *
 * Exact only, at full strength: `Tag` suggests the equipment tag and
 * `Tag Colour` does not, which is the rule `property-page.ts` already states.
 * A name that merely CONTAINS a synonym as one of its words scores a third,
 * because "Parent Tag" really is evidence for the parent-tag field and refusing
 * to notice it would be a different kind of wrong — but a third is small enough
 * that the value shape and the cardinality decide the ranking, which for
 * `Tag Colour` is exactly what happens.
 */
/**
 * What the name signal came to, and on what evidence.
 *
 * `weak` is true when the only thing that scored was a {@link WeakSynonym} —
 * the fact `confidenceOf` reads to refuse to pre-tick a guess, and the reason
 * the candidate prints.
 */
interface NameEvidence {
  readonly score: number;
  readonly weak: boolean;
  /** The weak synonym's sentence, or `''`. */
  readonly why: string;
  /** True when a word of the name disqualifies it from this field entirely. */
  readonly disqualified: boolean;
}

const NO_NAME_EVIDENCE: NameEvidence = {
  score: 0,
  weak: false,
  why: '',
  disqualified: false,
};

function nameEvidenceOf(name: string, profile: FieldProfile): NameEvidence {
  const folded = fold(name);
  const nameWords = words(name);

  const anti = profile.antiSynonyms ?? [];
  if (anti.length > 0 && nameWords.some((word) => anti.includes(word))) {
    return { ...NO_NAME_EVIDENCE, disqualified: true };
  }

  if (profile.synonyms.includes(folded)) {
    return { score: 1, weak: false, why: '', disqualified: false };
  }

  const weakExact = (profile.weakSynonyms ?? []).find((entry) => entry.folded === folded);
  if (weakExact !== undefined) {
    return { score: weakExact.strength, weak: true, why: weakExact.why, disqualified: false };
  }

  if (nameWords.length <= 3 && nameWords.some((word) => profile.synonyms.includes(word))) {
    return { score: 0.35, weak: false, why: '', disqualified: false };
  }

  const weakWord =
    nameWords.length > 3
      ? undefined
      : (profile.weakSynonyms ?? []).find((entry) => nameWords.includes(entry.folded));
  if (weakWord !== undefined) {
    return {
      score: weakWord.strength * 0.35,
      weak: true,
      why: weakWord.why,
      disqualified: false,
    };
  }

  return NO_NAME_EVIDENCE;
}

/** {@link nameEvidenceOf}'s score alone, for the callers that only want it. */
function nameScoreOf(name: string, profile: FieldProfile): number {
  return nameEvidenceOf(name, profile).score;
}

/** How much of the universe carries the property at all (§6.5 "fill rate"). */
function fillScoreOf(entry: UniversePropertyCatalogEntry): number {
  return clamp(entry.objectFraction);
}

/** How many of the sampled values look like the field wants them to look. */
function shapeScoreOf(entry: UniversePropertyCatalogEntry, shape: ValueShape): number {
  if (shape === 'any' || entry.exampleValues.length === 0) {
    return shape === 'any' ? 1 : 0;
  }
  const strength = entry.exampleValues.reduce(
    (total, value) => total + shapeStrength(value, shape),
    0,
  );
  return strength / entry.exampleValues.length;
}

/**
 * How well the distinct-value count fits the field's shape (§6.5 "cardinality").
 *
 * - `unique` wants one value per object: an equipment tag that repeats is a
 *   duplicate, and a property with four distinct values across four thousand
 *   objects is a category, not an identity.
 * - `few` wants a handful of repeated codes. The taper runs out at 33 distinct
 *   values, which is where a building list stops being a building list.
 * - `many` wants variety without demanding uniqueness — a description repeats
 *   across identical units and is still a description.
 */
function cardinalityScoreOf(
  entry: UniversePropertyCatalogEntry,
  cardinality: Cardinality,
): number {
  if (entry.objectCount === 0) {
    return 0;
  }
  switch (cardinality) {
    case 'unique':
      return clamp(entry.distinctValueCount / entry.objectCount);
    case 'few':
      return entry.distinctValueCount === 0
        ? 0
        : clamp(1 - (entry.distinctValueCount - 1) / 32);
    case 'many':
      return clamp((entry.distinctValueCount / entry.objectCount) * 4);
    default: {
      const exhaustive: never = cardinality;
      throw new Error(`Unhandled cardinality: ${String(exhaustive)}`);
    }
  }
}

/** Rounded to three places so a wire value is stable and a test can pin it. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The evidence behind a score, in the site's own numbers. */
function reasonsFor(
  entry: UniversePropertyCatalogEntry,
  profile: FieldProfile,
  signals: { name: number; fill: number; shape: number; cardinality: number },
  nameEvidence: NameEvidence,
): readonly string[] {
  const reasons: string[] = [];
  if (nameEvidence.weak && nameEvidence.why !== '') {
    reasons.push(nameEvidence.why);
  } else if (signals.name >= 1) {
    reasons.push(`Named “${entry.name}”, which is what this field is usually called`);
  } else if (signals.name > 0) {
    reasons.push(`“${entry.name}” contains the word this field is usually called`);
  }
  reasons.push(
    `${String(Math.round(entry.objectFraction * 100))}% of objects carry it (${String(entry.objectCount)})`,
  );
  if (
    profile.shape === 'tag' &&
    signals.shape > 0 &&
    signals.shape <= BARE_TAG_STRENGTH + 0.001
  ) {
    reasons.push('Sampled values are a role and a number with no separator, the way a mark is');
  } else if (signals.shape >= 0.99 && profile.shape !== 'any') {
    reasons.push(
      profile.shape === 'tag'
        ? 'Every sampled value is shaped like a tag'
        : profile.shape === 'words'
          ? 'Sampled values read as text rather than codes'
          : 'Sampled values are short codes',
    );
  } else if (signals.shape > 0 && profile.shape !== 'any') {
    reasons.push(
      `${String(Math.round(signals.shape * 100))}% of the sampled values fit the shape this field wants`,
    );
  }
  if (profile.cardinality === 'unique' && signals.cardinality >= 0.95) {
    reasons.push('Every value is distinct');
  } else {
    reasons.push(`${String(entry.distinctValueCount)} distinct values`);
  }
  return reasons;
}

/** Below this a candidate is not worth showing at all. */
const CANDIDATE_FLOOR = 0.2;

/** How far ahead of the runner-up a top candidate has to be to be `strong`. */
const STRONG_GAP = 0.15;

/** How good a top candidate has to be on its own to be `strong`. */
const STRONG_SCORE = 0.55;

/** At most this many candidates per field reach the screen. */
const CANDIDATE_LIMIT = 5;

/** Ranks every catalog entry for one field. Highest first, floor applied. */
export function rankCandidates(
  catalog: readonly UniversePropertyCatalogEntry[],
  profile: FieldProfile,
): readonly WirePropertySuggestion[] {
  const scored: WirePropertySuggestion[] = [];
  for (const entry of catalog) {
    const nameEvidence = nameEvidenceOf(entry.name, profile);
    if (nameEvidence.disqualified) {
      // Not a low score — off the list. See `FieldProfile.antiSynonyms`.
      continue;
    }
    const signals = {
      name: nameEvidence.score,
      fill: fillScoreOf(entry),
      shape: shapeScoreOf(entry, profile.shape),
      cardinality: cardinalityScoreOf(entry, profile.cardinality),
    };
    const weights = profile.weights;
    const total =
      signals.name * weights.name +
      signals.fill * weights.fill +
      signals.shape * weights.shape +
      signals.cardinality * weights.cardinality;

    scored.push({
      property: { category: entry.category, name: entry.name },
      score: round(total),
      coverage: entry.objectFraction,
      distinctValueCount: entry.distinctValueCount,
      objectCount: entry.objectCount,
      examples: [...entry.exampleValues].slice(0, 3),
      reasons: [...reasonsFor(entry, profile, signals, nameEvidence)],
    });
  }

  return scored
    .filter((candidate) => candidate.score >= CANDIDATE_FLOOR)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      // Ties break the same way every run: coverage, then the address itself.
      if (left.coverage !== right.coverage) {
        return right.coverage - left.coverage;
      }
      return (
        left.property.category.localeCompare(right.property.category) ||
        left.property.name.localeCompare(right.property.name)
      );
    })
    .slice(0, CANDIDATE_LIMIT);
}

/** `strong` only when the winner is good AND clearly ahead. See the schema. */
function confidenceOf(
  candidates: readonly WirePropertySuggestion[],
  profile: FieldProfile,
): WireSuggestionConfidence {
  const top = candidates[0];
  if (top === undefined || top.score < STRONG_SCORE) {
    return 'possible';
  }
  // A winner whose only name evidence is a weak synonym is never a clear
  // winner, whatever it scored: `Level` outscoring `Workset` for Building says
  // which of two guesses fits the signals better, not that either is the
  // building. Quick Setup's accept-all path takes the strong rows, and a level
  // silently becoming a site's top hierarchy level is exactly the outcome the
  // audit found (B3).
  if (nameEvidenceOf(top.property.name, profile).weak) {
    return 'possible';
  }
  const runnerUp = candidates[1];
  if (runnerUp === undefined) {
    return 'strong';
  }
  return top.score - runnerUp.score >= STRONG_GAP ? 'strong' : 'possible';
}

/**
 * Every field Quick Setup will ask about, with its ranked candidates.
 *
 * ## The gate is name evidence, not a score
 *
 * A field is asked about only when the best candidate for it is *named* like
 * it. That is not a tuning choice, it is the only honest rule available: shape
 * and cardinality cannot tell Area from Level from Equipment Classification,
 * because a short repeated code is a short repeated code, and on a model with
 * none of the three every one of them would propose the same property with the
 * same confidence. Six screens asking six questions with one answer between
 * them is not a one-hour setup, it is a form.
 *
 * So a model that carries `Dragon Data > Building` is asked about Building, and
 * a model that carries no discipline property is not asked about Discipline —
 * which is correct, because it has none. The full screens still map anything to
 * anything; this is about what is worth *proposing*.
 *
 * The equipment tag is the one exception and is always present, because a
 * project cannot be published without it and silence about it would be the
 * wrong kind of tidy.
 */
export function suggestFields(
  catalog: readonly UniversePropertyCatalogEntry[],
): readonly WireFieldSuggestion[] {
  const suggestions: WireFieldSuggestion[] = [];
  for (const profile of FIELD_PROFILES) {
    const candidates = rankCandidates(catalog, profile);
    const top = candidates[0];
    const named = top !== undefined && nameScoreOf(top.property.name, profile) > 0;
    if (profile.required !== true && !named) {
      continue;
    }
    suggestions.push({
      target: profile.target,
      label: profile.label,
      what: profile.what,
      example: profile.example,
      confidence: confidenceOf(candidates, profile),
      candidates: [...candidates],
    });
  }
  return suggestions;
}

/* ------------------------------------------------------- anatomy inference */

/** Separators worth trying, in the order a tag is most likely to use them. */
const SEPARATOR_CANDIDATES: readonly string[] = ['-', '_', '.', '/', ' '];

/**
 * The separators this site's tags actually use.
 *
 * A separator qualifies when at least a third of the sampled tags contain it.
 * A third rather than a majority because a site with two tag conventions is
 * ordinary — `MAH001-10-01` alongside `PLC_001` — and the tokenizer splits on
 * every separator it is given, so including both costs nothing and excluding
 * one loses half the site.
 */
export function inferSeparators(tags: readonly string[]): readonly string[] {
  if (tags.length === 0) {
    return [];
  }
  const found = SEPARATOR_CANDIDATES.filter((separator) => {
    const carrying = tags.filter((tag) => tag.includes(separator)).length;
    return carrying / tags.length >= 1 / 3;
  });
  return found;
}

/** One anatomy worth scoring, and the sentence that explains why it was tried. */
interface AnatomyCandidate {
  readonly rationale: string;
  readonly anatomy: WireTagAnatomy;
}

/**
 * The family key: the tag without its role prefix.
 *
 * `MAH001-10-01` -> `{system}-{token:1}-{token:2}` -> `001-10-01`. That is the
 * rule the tag-family rung wants (PRODUCT.md §11.2): a mechanical unit, its
 * panel, its drive and its instrument all share a family, and the only thing
 * that differs between their tags is the letters at the front. Proposed only
 * when `system` is the digits of the first token, because that is the only
 * arrangement in which dropping the prefix leaves something addressable.
 */
function familyTemplateFor(tokenCount: number): string {
  const rest: string[] = [];
  for (let index = 1; index < tokenCount; index += 1) {
    rest.push(`{token:${String(index)}}`);
  }
  return rest.length === 0 ? '{system}' : `{system}-${rest.join('-')}`;
}

/**
 * The anatomies worth trying against this site's tags.
 *
 * Two families, because two conventions cover the overwhelming majority of
 * equipment tags:
 *
 * 1. **The role and the system share the first token** — `MAH001-10-01`. Letters
 *    are the role, digits are the system, and the remaining tokens locate the
 *    unit and the instance.
 * 2. **The role and the system are separate tokens** — `MAH-001-10`. Same idea,
 *    one token later.
 *
 * Both are proposed at every token count the sample actually has, and the
 * winner is decided by running them (see {@link inferAnatomy}) rather than by
 * arguing about them.
 */
function anatomyCandidates(
  separators: readonly string[],
  tokenCount: number,
): readonly AnatomyCandidate[] {
  const base = {
    separators: [...separators],
    ignoredSuffixes: [],
    localFamilyTemplate: '',
  };

  const sharedFirstToken: WireTagAnatomy = {
    ...base,
    segments: [
      { segment: 'role' as WireSegmentName, extractor: { kind: 'alphaPrefix' as const, token: 0 } },
      { segment: 'system' as WireSegmentName, extractor: { kind: 'digitSuffix' as const, token: 0 } },
      ...(tokenCount > 1
        ? [{ segment: 'unit' as WireSegmentName, extractor: { kind: 'token' as const, token: 1 } }]
        : []),
      ...(tokenCount > 2
        ? [
            {
              segment: 'instance' as WireSegmentName,
              extractor: { kind: 'token' as const, token: 2 },
            },
          ]
        : []),
    ],
    familyKeyTemplate: familyTemplateFor(tokenCount),
  };

  const separateTokens: WireTagAnatomy = {
    ...base,
    segments: [
      { segment: 'role' as WireSegmentName, extractor: { kind: 'token' as const, token: 0 } },
      ...(tokenCount > 1
        ? [{ segment: 'system' as WireSegmentName, extractor: { kind: 'token' as const, token: 1 } }]
        : []),
      ...(tokenCount > 2
        ? [{ segment: 'unit' as WireSegmentName, extractor: { kind: 'token' as const, token: 2 } }]
        : []),
      ...(tokenCount > 3
        ? [
            {
              segment: 'instance' as WireSegmentName,
              extractor: { kind: 'token' as const, token: 3 },
            },
          ]
        : []),
    ],
    familyKeyTemplate: tokenCount > 1 ? familyTemplateFor(tokenCount) : '{system}',
  };

  /**
   * The role is the letters at the front and the number is just which one it
   * is. `AHU-1`, `P101`, `EF-3` — Revit's `Mark`, and every hand-typed tag on a
   * building services model.
   *
   * There is no system in a mark, and the whole reason this family exists is to
   * stop the engine pretending there is: under `separateTokens`, `AHU-1` yields
   * `system = "1"`, which then becomes a hierarchy level with one system per
   * air handler. {@link systemSanityOf} is what catches that; this is what it
   * loses to.
   *
   * Three arrangements of the same idea, because the digits can be at either
   * end of the mark or in a token of their own:
   *
   * 1. **instance in the first token** — `P101`, no separator at all.
   * 2. **instance in the last token** — `AHU-1`.
   * 3. **role only** — the honest answer for a site whose marks are
   *    `MCC-2A` and `VFD-2A-1` alongside `AHU-1`, where no single digit
   *    position is the instance. It teaches one segment, which is one more than
   *    nothing, and it is the vocabulary the role-pair proposals read.
   */
  const noSystemBase = {
    ...base,
    familyKeyTemplate: '',
  };
  const roleAndInstance = (instanceToken: number): WireTagAnatomy => ({
    ...noSystemBase,
    segments: [
      { segment: 'role' as WireSegmentName, extractor: { kind: 'alphaPrefix' as const, token: 0 } },
      {
        segment: 'instance' as WireSegmentName,
        extractor: { kind: 'digitSuffix' as const, token: instanceToken },
      },
    ],
  });
  const roleOnly: WireTagAnatomy = {
    ...noSystemBase,
    segments: [
      { segment: 'role' as WireSegmentName, extractor: { kind: 'alphaPrefix' as const, token: 0 } },
    ],
  };

  const candidates: AnatomyCandidate[] = [
    {
      rationale:
        'The letters and digits of the first token are the role and the system, and the tokens after it place the unit and the instance.',
      anatomy: sharedFirstToken,
    },
    {
      rationale: 'Each token is one field: role, then system, then unit, then instance.',
      anatomy: separateTokens,
    },
    {
      rationale:
        'The letters at the front of the mark are the role and the digits after them are which one it is. There is no system in these marks, so the system has to come from somewhere else.',
      anatomy: roleAndInstance(0),
    },
  ];
  if (tokenCount > 1) {
    candidates.push({
      rationale:
        'The letters at the front are the role and the last token is which one it is. There is no system in these marks, so the system has to come from somewhere else.',
      anatomy: roleAndInstance(tokenCount - 1),
    });
  }
  candidates.push({
    rationale:
      'These marks are a role and a number and nothing else — no system, and no instance in a fixed position. Matchline teaches the role, which is what the parent rules read, and the system comes from a model property instead.',
    anatomy: roleOnly,
  });
  return candidates;
}

/**
 * How much a candidate's `system` segment behaves like a system.
 *
 * A system groups equipment. A `system` segment whose distinct values number
 * about as many as the tags it split has grouped nothing — it is the instance
 * number wearing the wrong name, and a hierarchy built on it gives every air
 * handler a system of its own. That is the audit's "on `AHU-1` makes
 * system = 1", and it is a fact this function can see without knowing anything
 * about the site.
 *
 * `1` for a family that teaches no `system` at all: there is nothing to be
 * wrong about. `1` down to `0` across a distinct-to-matched ratio of a quarter
 * to three quarters — a quarter is an ordinary site (four units per system),
 * and at three quarters the segment is an identifier.
 */
export function systemSanityOf(
  anatomy: WireTagAnatomy,
  preview: AnatomyPreview,
): number {
  if (!anatomy.segments.some((row) => row.segment === 'system')) {
    return 1;
  }
  if (preview.matchedCount === 0) {
    return 0;
  }
  const stat = preview.segmentStats.find((entry) => entry.segment === 'system');
  if (stat === undefined) {
    return 1;
  }
  const ratio = stat.distinctValueCount / preview.matchedCount;
  return clamp(1 - (ratio - 0.25) / 0.5);
}

/** The most common token count across the sample, ties going to the larger. */
function commonTokenCount(tags: readonly string[], separators: readonly string[]): number {
  if (separators.length === 0) {
    return 1;
  }
  const pattern = new RegExp(
    `[${separators.map((separator) => separator.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')).join('')}]`,
  );
  const counts = new Map<number, number>();
  for (const tag of tags) {
    const count = tag.split(pattern).filter((token) => token !== '').length;
    counts.set(count, (counts.get(count) ?? 0) + 1);
  }
  let best = 1;
  let bestCount = -1;
  for (const [tokenCount, occurrences] of [...counts].sort((left, right) => right[0] - left[0])) {
    if (occurrences > bestCount) {
      best = tokenCount;
      bestCount = occurrences;
    }
  }
  return best;
}

/** How many tags the inference reads. Enough to be representative, not a scan. */
const ANATOMY_SAMPLE_LIMIT = 2000;

/**
 * The best anatomy for this site's tags, scored by running every candidate.
 *
 * Coverage decides, because coverage IS the question screen 4 asks: an anatomy
 * that splits 97% of the site's tags is better than one that splits 60%, and no
 * amount of elegance changes that. Ties go to the candidate that teaches more
 * segments, because a segment taught is a segment the System Resolver and the
 * family rung can use, and then to the earlier candidate, so the same tags
 * always produce the same proposal.
 *
 * `null` when nothing scored above nothing at all — a site whose tags are one
 * undivided token has no anatomy to infer, and proposing one that matches
 * everything by matching nothing would be worse than saying so.
 */
export function inferAnatomy(tags: readonly string[]): WireAnatomySuggestion | null {
  const sample = tags.filter((tag) => tag !== '').slice(0, ANATOMY_SAMPLE_LIMIT);
  if (sample.length === 0) {
    return null;
  }

  // No qualifying separator is not the same as no shape. `P101` is one token,
  // and the role-and-instance family reads a role and an instance out of it —
  // which is the whole of what a Revit `Mark` decomposes into (WP8, item 4).
  // A site whose tags really are undivided and unstructured still gets `null`:
  // every family here needs leading letters, so `1234` matches nothing and
  // `matchedCount === 0` below refuses to propose anything.
  const separators = inferSeparators(sample);
  const tokenCount = commonTokenCount(sample, separators);

  let best: {
    readonly candidate: AnatomyCandidate;
    readonly preview: AnatomyPreview;
    readonly score: number;
  } | null = null;
  for (const candidate of anatomyCandidates(separators, tokenCount)) {
    const preview = previewAnatomy(toAnatomyConfig(candidate.anatomy), sample);
    // Coverage decides, discounted by whether the candidate's `system` segment
    // is a system at all. A shape that splits every tag by calling the instance
    // number a system has not read this site's tags; it has renamed them.
    const score = preview.coverage * systemSanityOf(candidate.anatomy, preview);
    if (best === null) {
      best = { candidate, preview, score };
      continue;
    }
    if (score > best.score) {
      best = { candidate, preview, score };
      continue;
    }
    if (
      score === best.score &&
      candidate.anatomy.segments.length > best.candidate.anatomy.segments.length
    ) {
      best = { candidate, preview, score };
    }
  }

  if (best === null || best.preview.matchedCount === 0) {
    return null;
  }

  return {
    rationale: best.candidate.rationale,
    anatomy: best.candidate.anatomy,
    coverage: best.preview.coverage,
    matchedCount: best.preview.matchedCount,
    totalCount: best.preview.total,
    segmentStats: best.preview.segmentStats.map((stat) => ({
      segment: stat.segment,
      distinctValueCount: stat.distinctValueCount,
    })),
    examples: best.preview.examples.slice(0, 5).map((entry) => ({
      tag: entry.tag,
      normalizedTag: entry.result.normalizedTag,
      segments: best === null
        ? []
        : best.candidate.anatomy.segments.map((row) => ({
            segment: row.segment,
            value: entry.result.segments[row.segment] ?? null,
          })),
      familyKey: entry.result.familyKey ?? '',
      localFamily: entry.result.localFamily ?? '',
    })),
  };
}

/**
 * The wire anatomy as `@matchline/tag-anatomy` takes it.
 *
 * A local copy of `draft-profile.ts`'s `toTagAnatomy` minus its "null when
 * nothing is taught" branch: every candidate here has segments by construction,
 * and importing the draft conversion would make this module depend on the
 * draft, which it has nothing to do with.
 */
function toAnatomyConfig(wire: WireTagAnatomy): Parameters<typeof previewAnatomy>[0] {
  const segments: Record<string, { readonly kind: string }> = {};
  for (const row of wire.segments) {
    segments[row.segment] = row.extractor;
  }
  return {
    separators: [...wire.separators],
    ignoredSuffixes: [...wire.ignoredSuffixes],
    segments: segments as Parameters<typeof previewAnatomy>[0]['segments'],
    familyKeyTemplate: wire.familyKeyTemplate,
    localFamilyTemplate: wire.localFamilyTemplate,
  };
}

/**
 * Which of the ranked system-code candidates a resolver should actually key on.
 *
 * Preference, strongest first, and the order is about what the property MEANS
 * rather than what it scored:
 *
 * 1. `System Name` names one system — `Supply Air 1`, `Power 2A`. That is a
 *    system key.
 * 2. `UPN` / `System Code` / `System No` are the same thing on a plant model.
 * 3. `System Classification` names a KIND of system — `Supply Air`, `Power`.
 *    Keying on it merges every supply-air system on the site into one, which is
 *    a worse answer than no answer, so it comes last and only when nothing else
 *    is offered.
 *
 * The ranking cannot see this: a classification has fewer distinct values than
 * a name, and "few distinct values" is exactly what the System/UPN profile
 * rewards, so the classification wins the score and loses the argument.
 */
const SYSTEM_PROPERTY_PREFERENCE: readonly string[] = [
  'systemname',
  'systemcode',
  'systemno',
  'systemnumber',
  'upn',
  'unitprocessnumber',
  'system',
  'systemclassification',
];

export function preferredSystemProperty(
  candidates: readonly WirePropertySuggestion[],
): { readonly category: string; readonly name: string } | null {
  let best: { readonly candidate: WirePropertySuggestion; readonly rank: number } | null = null;
  for (const candidate of candidates) {
    const rank = SYSTEM_PROPERTY_PREFERENCE.indexOf(fold(candidate.property.name));
    if (rank < 0) {
      continue;
    }
    if (best === null || rank < best.rank) {
      best = { candidate, rank };
    }
  }
  const chosen = best?.candidate ?? candidates[0];
  return chosen === undefined
    ? null
    : { category: chosen.property.category, name: chosen.property.name };
}

/* ------------------------------------------------- resolver starter templates */

/** What a template needs from the project before it can answer anything. */
export interface TemplateEvidence {
  /** True when the site has taught a tag anatomy with a `system` segment. */
  readonly hasSystemSegment: boolean;
  /** True when a master equipment list is registered and readable. */
  readonly hasMel: boolean;
  /** The property most likely to hold the system code, if any. */
  readonly systemProperty: { readonly category: string; readonly name: string } | null;
  /** What the approved-UPN rung would find in this site's own tags. */
  readonly upn: ExtoUpnCoverage;
}

/**
 * The share of a site's tags that carry an approved Exto UPN.
 *
 * Read off the real tags, once, and handed to the templates rather than
 * recomputed inside each of them. A proposal whose numbers were derived twice
 * could offer a template on one count and print another underneath it.
 */
export interface ExtoUpnCoverage {
  /** Tags looked at. */
  readonly tagCount: number;
  /** Tags carrying exactly one approved UPN. Zero or several do not count. */
  readonly singleUpnCount: number;
  /** Of those, how many reach an approved System Name with no description. */
  readonly namedCount: number;
  /** Of those, how many own several approved names and need a description. */
  readonly needsDescriptionCount: number;
}

/**
 * How much of this site the approved UPN rung would answer for.
 *
 * `singleUpnCount` is deliberately strict: a tag carrying two approved UPNs is
 * not a tag the rung can read, and counting it as coverage would offer a
 * template that then skips those very assets.
 */
export function extoUpnCoverage(tags: readonly string[]): ExtoUpnCoverage {
  let singleUpnCount = 0;
  let namedCount = 0;
  let needsDescriptionCount = 0;
  for (const tag of tags) {
    const candidates = extoRev21UpnCandidates(tag);
    const only = candidates[0];
    if (only === undefined || candidates.length > 1) {
      continue;
    }
    singleUpnCount += 1;
    // With no description at all, `allowUniqueUpn` is the only way through:
    // `unique-upn` means the UPN owns one name, anything else means the words
    // have to come from somewhere before a name can be settled.
    if (extoRev21SystemName(only, '', true).status === 'unique-upn') {
      namedCount += 1;
    } else {
      needsDescriptionCount += 1;
    }
  }
  return { tagCount: tags.length, singleUpnCount, namedCount, needsDescriptionCount };
}

/**
 * The share of tags that has to carry an approved UPN before the rung is
 * proposed.
 *
 * Four tags in five. Below that the rung is still offered, greyed, with the
 * real number in the reason — a site whose controls package uses UPNs and whose
 * mechanical package does not should be told that, not quietly shown a
 * different template.
 */
export const UPN_TAG_COVERAGE_THRESHOLD = 0.8;

/**
 * The six starter templates the one-hour directive names.
 *
 * Each is a whole `SystemResolverConfig`, not a fragment: accepting one is a
 * single write, and previewing one is a single run over the real assets. The
 * `available` flag is honest rather than tidy — a template that reads a MEL a
 * project does not have is shown, greyed, with the reason, because "add your
 * MEL on screen 1 and this becomes the obvious choice" is more useful than a
 * list that quietly gets shorter.
 */
export function resolverTemplates(evidence: TemplateEvidence): readonly WireResolverTemplate[] {
  const systemProperty = evidence.systemProperty ?? { category: '', name: 'UPN' };
  const normalization = [{ kind: 'trim' as const }];
  const missingProperty =
    evidence.systemProperty === null
      ? 'No model property looks like a system code in these sources.'
      : '';
  const missingMel = evidence.hasMel ? '' : 'No master equipment list is registered on screen 1.';
  const missingSegment = evidence.hasSystemSegment
    ? ''
    : 'No tag anatomy with a “system” segment has been taught on screen 4 yet.';

  const upnShare =
    evidence.upn.tagCount === 0 ? 0 : evidence.upn.singleUpnCount / evidence.upn.tagCount;
  const missingUpn =
    evidence.upn.tagCount === 0
      ? 'No equipment tags have been read yet — choose the tag property on screen 3 first.'
      : upnShare >= UPN_TAG_COVERAGE_THRESHOLD
        ? ''
        : `Only ${String(evidence.upn.singleUpnCount)} of ` +
          `${String(evidence.upn.tagCount)} tags carry exactly one approved Exto UPN, ` +
          'so this would leave most of the site without a system.';

  return [
    {
      templateId: 'exto-approved-list',
      label: 'The tag carries the approved UPN',
      what: 'Reads the approved Exto UPN out of the tag itself and names the system from the approved list. Needs no tag anatomy and no MEL — the standard supplies both halves.',
      example: 'MAH101-01 → UPN 101, named “101  Cleanroom Makeup Air System”',
      available: missingUpn === '',
      unavailableReason: missingUpn,
      impact:
        evidence.upn.tagCount === 0
          ? ''
          : `${String(evidence.upn.namedCount)} of ${String(evidence.upn.tagCount)} assets get an ` +
            'approved System Name; ' +
            `${String(evidence.upn.needsDescriptionCount)} need a description before one can be ` +
            'settled.',
      resolver: {
        keyChain: [{ kind: 'upn-from-tag' }],
        descriptionChain: [
          { kind: 'exto-system-name', allowUniqueUpn: true, descriptionProperty: null },
          ...(evidence.hasMel
            ? ([
                { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
              ] as const)
            : []),
        ],
        normalization,
        conflictPolicy: 'review',
        applyIcDisciplineRule: true,
        labelTemplate: '',
      },
    },
    {
      templateId: 'model-field',
      label: 'The model states the system',
      what: 'Reads the system code straight off each object. The simplest arrangement, and the right one when the authoring tool already carries it.',
      example: 'Dragon Data > UPN holding 001',
      available: missingProperty === '',
      unavailableReason: missingProperty,
      impact: '',
      resolver: {
        keyChain: [{ kind: 'model-field', property: systemProperty }],
        descriptionChain: [],
        normalization,
        conflictPolicy: 'review',
        labelTemplate: '',
        applyIcDisciplineRule: true,
      },
    },
    {
      templateId: 'tag-and-mel',
      label: 'The tag says it, the MEL names it',
      what: 'Takes the system from the tag and the words from the master equipment list. The usual arrangement on a site whose tags encode the system.',
      example: 'MAH001-10-01 → 001, described “Mechanical Dry Air Handling” by the MEL',
      available: missingSegment === '' && missingMel === '',
      unavailableReason: [missingSegment, missingMel].filter((part) => part !== '').join(' '),
      impact: '',
      resolver: {
        keyChain: [{ kind: 'tag-segment', segment: 'system' }],
        descriptionChain: [
          { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
        ],
        normalization,
        conflictPolicy: 'review',
        labelTemplate: '',
        applyIcDisciplineRule: true,
      },
    },
    {
      templateId: 'upn-and-mel',
      label: 'A model property, described by the MEL',
      what: 'Takes the system from a model property and the words from the master equipment list. Use it when the model is authoritative and the spreadsheet is the dictionary.',
      example: 'UPN 001 → “Mechanical Dry Air Handling”',
      available: missingProperty === '' && missingMel === '',
      unavailableReason: [missingProperty, missingMel].filter((part) => part !== '').join(' '),
      impact: '',
      resolver: {
        keyChain: [{ kind: 'model-field', property: systemProperty }],
        descriptionChain: [
          { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
        ],
        normalization,
        conflictPolicy: 'review',
        labelTemplate: '',
        applyIcDisciplineRule: true,
      },
    },
    {
      templateId: 'direct-column',
      label: 'An imported column is the system',
      what: 'Reads a column you have already labelled as the system. Use it when the system lives in an imported register rather than in the model.',
      example: 'The register’s System column holding 001',
      available: missingProperty === '',
      unavailableReason: missingProperty,
      impact: '',
      resolver: {
        keyChain: [{ kind: 'direct-column', property: systemProperty }],
        descriptionChain: [],
        normalization,
        conflictPolicy: 'review',
        labelTemplate: '',
        applyIcDisciplineRule: true,
      },
    },
    {
      templateId: 'composite',
      label: 'The system is assembled from parts',
      what: 'Builds the key out of two or more pieces of the tag. Use it where a system is only unique once the unit is included.',
      example: '{segment:system}-{segment:unit} gives 001-10',
      available: missingSegment === '',
      unavailableReason: missingSegment,
      impact: '',
      resolver: {
        keyChain: [{ kind: 'composite', template: '{segment:system}-{segment:unit}' }],
        descriptionChain: [],
        normalization,
        conflictPolicy: 'review',
        labelTemplate: '',
        applyIcDisciplineRule: true,
      },
    },
    {
      templateId: 'manual-only',
      label: 'Systems are assigned by hand',
      what: 'Nothing is inferred. Every asset waits for a person to say which system it belongs to. Honest, and slow — pick it only when no source states the system at all.',
      example: 'Every asset arrives in the review queue with no system',
      available: true,
      unavailableReason: '',
      impact: '',
      resolver: {
        keyChain: [{ kind: 'manual' }],
        descriptionChain: [],
        normalization,
        conflictPolicy: 'review',
        labelTemplate: '',
        applyIcDisciplineRule: true,
      },
    },
  ];
}

/* --------------------------------------------- source-assignment suggestions */

/**
 * A building code at the front of a file name: letters and digits, then a
 * separator.
 *
 * Both halves are required. `B14-Mechanical.nwc` yields `B14`; `Dragon-
 * Mechanical.nwc` yields nothing, because `Dragon` is the site, not a building,
 * and a rule assigning every asset to a building called Dragon would be a
 * confident wrong answer. A building code that people write on drawings has a
 * number in it.
 */
const FILENAME_PREFIX = /^([A-Za-z]{1,4}[0-9]{1,4}[A-Za-z]?)[-_]/;

/** What one source-assignment proposal is, before its counts are attached. */
export interface AssignmentProposal {
  readonly rule: WireSourceAssignmentRule;
  readonly why: string;
}

/**
 * Rules that read the building off the file names, for a federation that has no
 * building property (audit: "no Building is ever proposed for a federated Revit
 * NWD").
 *
 * The evidence is the whole file list at once, and it has to be unanimous: every
 * document with a file name starts with a code, and the codes are not all the
 * same one. A federation delivered as `B14-Mechanical.nwc`,
 * `B14-Electrical.nwc` and `B22-Mechanical.nwc` has said which building each
 * file is for as plainly as a property would have, and it is the only thing on
 * such a model that HAS said it — `Level` repeats in every building and
 * `Workset` is a coordination convention.
 *
 * One rule per distinct code, in code order, so the same file list always
 * produces the same rules. `match` carries exactly one `*`, which is what
 * `isCapturePattern` requires and what the preview and the engine both read.
 *
 * Nothing is proposed when a project has one building — one rule assigning every
 * file to `B14` is true and useless — or when any file name does not carry a
 * code, because a rule that speaks for four files out of five leaves the fifth
 * silently unassigned, which is the outcome this whole proposal exists to avoid.
 */
export function suggestSourceAssignments(
  fileNames: readonly string[],
): readonly AssignmentProposal[] {
  const named = fileNames.filter((name) => name !== '');
  if (named.length === 0) {
    return [];
  }

  const prefixes = new Set<string>();
  for (const name of named) {
    const match = FILENAME_PREFIX.exec(name);
    if (match === null) {
      return [];
    }
    const prefix = match[1];
    if (prefix === undefined) {
      return [];
    }
    prefixes.add(prefix.toUpperCase());
  }
  if (prefixes.size < 2) {
    return [];
  }

  const separatorOf = (prefix: string): string => {
    const example = named.find((name) => name.toUpperCase().startsWith(`${prefix}-`));
    return example === undefined ? '_' : '-';
  };

  return [...prefixes].sort().map((prefix): AssignmentProposal => ({
    rule: {
      scope: 'filename-pattern',
      match: `${prefix}${separatorOf(prefix)}*`,
      assign: { building: prefix, nativeDiscipline: '', custom: [] },
    },
    why:
      `Every file in this project starts with a short code, and “${prefix}” is one of ` +
      `${String(prefixes.size)} of them. Nothing inside these models says which building an ` +
      'object is in, so the file name is the only thing that does.',
  }));
}

/* -------------------------------------------------------- role-pair proposals */

/** One nesting the model tree draws, in tags. */
export interface TaggedNesting {
  readonly parentTag: string;
  readonly childTag: string;
}

/** At most this many `parent → child` examples travel with one pair. */
const ROLE_PAIR_EXAMPLE_LIMIT = 3;

/**
 * The `parentRole → childRole` rules the model tree has already stated.
 *
 * `roleOf` is the site's own anatomy applied to a tag — never a guess about
 * what a prefix means. A pairing is proposed once per direction and carries its
 * count, because "the model puts a VFD inside an MCC 14 times" is a fact about
 * this site and "a VFD belongs to an MCC" is a rule about the industry, and only
 * the first one is Matchline's to say.
 *
 * Self-pairs are dropped: `AHU → AHU` is a model tree that nested two air
 * handlers, which is a modelling accident far more often than it is a rule, and
 * a role graph containing it would let any air handler parent any other.
 */
export function suggestRolePairs(
  nestings: readonly TaggedNesting[],
  roleOf: (tag: string) => string | null,
): readonly WireRolePairSuggestion[] {
  const counts = new Map<string, { count: number; examples: string[] }>();
  for (const nesting of nestings) {
    const parentRole = roleOf(nesting.parentTag);
    const childRole = roleOf(nesting.childTag);
    if (parentRole === null || childRole === null || parentRole === childRole) {
      continue;
    }
    const key = `${parentRole}\u0000${childRole}`;
    const bucket = counts.get(key) ?? { count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < ROLE_PAIR_EXAMPLE_LIMIT) {
      bucket.examples.push(`${nesting.parentTag} → ${nesting.childTag}`);
    }
    counts.set(key, bucket);
  }

  return [...counts.entries()]
    .map(([key, bucket]): WireRolePairSuggestion => {
      const [parentRole = '', childRole = ''] = key.split('\u0000');
      return { parentRole, childRole, count: bucket.count, examples: [...bucket.examples] };
    })
    .sort((left, right) =>
      left.count === right.count
        ? left.parentRole.localeCompare(right.parentRole) ||
          left.childRole.localeCompare(right.childRole)
        : right.count - left.count,
    );
}

/* ------------------------------------------------------- class suggestions */

/** One class as the caller counted it: objects, and objects carrying a tag. */
export interface ClassTagCount {
  readonly className: string;
  readonly objectCount: number;
  readonly taggedCount: number;
}

/** At or above this share of tagged objects, a class is equipment. */
const INCLUDE_THRESHOLD = 0.5;

/** Below this, and with objects to spare, a class is scenery. */
const EXCLUDE_THRESHOLD = 0.02;

/**
 * Which classes to include and which to exclude, from tag coverage alone.
 *
 * The signal is the one that matters: a class whose objects carry equipment
 * tags is equipment, and a class whose objects never do is geometry. Anything
 * in between is left alone with the reason stated, because a class that is half
 * tagged is a decision about this site rather than a fact about Navisworks.
 *
 * The proposal is never applied by itself — the Quick Setup screen shows the
 * impact of accepting it (how many objects each list removes) before anybody
 * presses anything.
 */
export function suggestClasses(
  counts: readonly ClassTagCount[],
): readonly WireClassSuggestion[] {
  return counts
    .map((entry): WireClassSuggestion => {
      const tagCoverage = entry.objectCount === 0 ? 0 : entry.taggedCount / entry.objectCount;
      if (tagCoverage >= INCLUDE_THRESHOLD) {
        return {
          className: entry.className,
          objectCount: entry.objectCount,
          taggedCount: entry.taggedCount,
          tagCoverage,
          proposal: 'include',
          why: `${String(entry.taggedCount)} of ${String(entry.objectCount)} carry an equipment tag.`,
        };
      }
      if (tagCoverage <= EXCLUDE_THRESHOLD) {
        return {
          className: entry.className,
          objectCount: entry.objectCount,
          taggedCount: entry.taggedCount,
          tagCoverage,
          proposal: 'exclude',
          why:
            entry.taggedCount === 0
              ? `None of its ${String(entry.objectCount)} objects carries an equipment tag.`
              : `Only ${String(entry.taggedCount)} of ${String(entry.objectCount)} carries a tag.`,
        };
      }
      return {
        className: entry.className,
        objectCount: entry.objectCount,
        taggedCount: entry.taggedCount,
        tagCoverage,
        proposal: 'leave',
        why: `${String(Math.round(tagCoverage * 100))}% carry a tag — too mixed for Matchline to call.`,
      };
    })
    .sort((left, right) =>
      left.objectCount === right.objectCount
        ? left.className.localeCompare(right.className)
        : right.objectCount - left.objectCount,
    );
}
