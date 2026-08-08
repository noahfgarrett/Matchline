/**
 * Existing-MEL comparison (PRODUCT.md §12.3).
 *
 * When a project already has an MEL, it is evidence — not the asset universe.
 * §9.3 is explicit: "MEL_ONLY records are discrepancy evidence, not automatic
 * authoritative assets". So this module answers one question and no more:
 * *where do Matchline and the supplied MEL disagree?*
 *
 * It returns plain data. It creates no `ReviewItem`s, promotes nothing, and
 * never turns an MEL-only tag into an asset — the compiler layer aggregates
 * these findings into review, which is also what keeps a Matchline-generated
 * MEL from becoming circular authority when someone reimports it (§12.3).
 *
 * ## Matching
 *
 * By Equipment Tag, exactly, after trimming. A site with accepted aliases
 * passes {@link CompareWithExistingMelOptions.aliases} — MEL spelling to
 * canonical tag — and nothing else is tried: a fuzzy match here would silently
 * decide an identity question that §7 sends to review.
 *
 * ## Absent is blank
 *
 * Values are compared trimmed, and a cell the MEL left empty, a cell holding
 * only spaces, and a mapped column the MEL row does not have at all all read as
 * `''`. The distinction between "the MEL did not state this" and "the MEL
 * stated it is empty" is **not preserved**. That is a real loss, and it is
 * deliberate: an .xlsx round trip does not reliably carry it either, so
 * pretending to know the difference would be worse than not claiming it.
 */

import { CANONICAL_MEL_COLUMNS } from './columns.js';
import type { CanonicalMelField, CanonicalMelRow } from './columns.js';
import { CANONICAL_MEL_FIELDS, MelExportError, isCanonicalMelField } from './errors.js';
import { compareCodeUnits } from './order.js';
import type { GeneratedMelAsset } from './rows.js';
import { buildCanonicalMelRows } from './rows.js';

/* ---- inputs ---- */

/** One §12.1 field and the key it is stored under in the supplied MEL rows. */
export interface ExistingMelColumn {
  readonly field: CanonicalMelField;
  /** The record key — the `field` name used when the MEL was read. */
  readonly melKey: string;
}

/**
 * The fields to compare. Must bind `equipmentTag`: it is the join key.
 *
 * A field bound twice keeps its first binding; the rest is ignored rather than
 * compared twice under two names.
 */
export type ExistingMelMapping = ReadonlyArray<ExistingMelColumn>;

/** Options for {@link compareWithExistingMel}. */
export interface CompareWithExistingMelOptions {
  /**
   * Accepted aliases: the tag as the MEL spells it → the canonical tag. Applied
   * to the MEL side only, after trimming.
   */
  readonly aliases?: ReadonlyMap<string, string>;
}

/* ---- results ---- */

/** One field, on one tag, on both sides. */
export interface MelFieldComparison {
  readonly field: CanonicalMelField;
  /** What Matchline would print in the canonical MEL, trimmed. */
  readonly matchlineValue: string;
  /** What the supplied MEL holds, trimmed. Absent and blank are both `''`. */
  readonly melValue: string;
  readonly agree: boolean;
}

/** One tag both sides have. */
export interface MelTagComparison {
  readonly canonicalTag: string;
  /** The tag as the MEL spelled it — different from `canonicalTag` via an alias. */
  readonly melTag: string;
  /** Every mapped field except `equipmentTag`, in §12.1 column order. */
  readonly fields: ReadonlyArray<MelFieldComparison>;
  readonly agreeCount: number;
  readonly disagreeCount: number;
  /**
   * How many Matchline rows carry this tag. Above one means the tag is
   * duplicated (`DUPLICATE_MODEL_TAG`, never merged — §9.3) and the values
   * compared are the first row's, in canonical order.
   */
  readonly matchlineRowCount: number;
  /** How many supplied MEL rows carry this tag. Same rule: the first wins. */
  readonly melRowCount: number;
}

/** Counts over the whole comparison. */
export interface MelComparisonSummary {
  readonly matchedTagCount: number;
  readonly melOnlyTagCount: number;
  readonly matchlineOnlyTagCount: number;
  /** Field comparisons emitted, across every matched tag. */
  readonly comparedFieldCount: number;
  readonly agreeCount: number;
  readonly disagreeCount: number;
  /** Tags where at least one mapped field disagreed. */
  readonly disagreeingTagCount: number;
  /** Supplied MEL rows dropped because their tag cell was empty. */
  readonly unkeyedMelRowCount: number;
}

/** What {@link compareWithExistingMel} found. Every list is deterministically ordered. */
export interface MelComparison {
  /** Tags both sides have, by canonical tag, code-unit ascending. */
  readonly matched: ReadonlyArray<MelTagComparison>;
  /**
   * Tags only the supplied MEL has, code-unit ascending. Discrepancy evidence
   * (§9.3) — never assets, and nothing here is promoted by this module.
   */
  readonly melOnlyTags: ReadonlyArray<string>;
  /** Tags only Matchline has, code-unit ascending. */
  readonly matchlineOnlyTags: ReadonlyArray<string>;
  readonly summary: MelComparisonSummary;
}

/**
 * Compare the assets Matchline compiled against an MEL the project supplied.
 *
 * `existingRows` is what a reader produced — `readMappedTable(...).rows` from
 * `@matchline/spreadsheet-import`, or any records keyed the same way. Rows
 * whose tag cell is empty are counted and dropped: a row with no tag cannot be
 * matched to anything, and inventing a key for it would manufacture a
 * discrepancy.
 *
 * @throws {MelExportError} `unknown-canonical-field` when the mapping names
 * something that is not a §12.1 field, `comparison-mapping-missing-tag` when it
 * does not bind `equipmentTag`.
 */
export function compareWithExistingMel(
  assets: ReadonlyArray<GeneratedMelAsset>,
  existingRows: ReadonlyArray<Readonly<Record<string, string>>>,
  mapping: ExistingMelMapping,
  options: CompareWithExistingMelOptions = {},
): MelComparison {
  const bound = bindMapping(mapping);
  const tagKey = bound.get('equipmentTag');
  if (tagKey === undefined) {
    throw new MelExportError({
      kind: 'comparison-mapping-missing-tag',
      mappedFields: [...bound.keys()],
    });
  }

  const comparedFields = CANONICAL_MEL_COLUMNS.map((column) => column.field).filter(
    (field) => field !== 'equipmentTag' && bound.has(field),
  );

  const matchlineByTag = groupMatchlineRows(assets);
  const melByTag = new Map<string, Array<Readonly<Record<string, string>>>>();
  const melTagSpelling = new Map<string, string>();
  const aliases = options.aliases;
  let unkeyedMelRowCount = 0;
  for (const row of existingRows) {
    const melTag = (row[tagKey] ?? '').trim();
    if (melTag === '') {
      unkeyedMelRowCount++;
      continue;
    }
    const canonicalTag = aliases?.get(melTag) ?? melTag;
    const rows = melByTag.get(canonicalTag);
    if (rows === undefined) {
      melByTag.set(canonicalTag, [row]);
      melTagSpelling.set(canonicalTag, melTag);
    } else {
      rows.push(row);
    }
  }

  const matched: MelTagComparison[] = [];
  const matchlineOnlyTags: string[] = [];
  for (const [canonicalTag, matchlineRows] of matchlineByTag) {
    const melRows = melByTag.get(canonicalTag);
    if (melRows === undefined) {
      matchlineOnlyTags.push(canonicalTag);
      continue;
    }
    matched.push(
      compareTag(
        canonicalTag,
        melTagSpelling.get(canonicalTag) ?? canonicalTag,
        matchlineRows,
        melRows,
        comparedFields,
        bound,
      ),
    );
  }

  const melOnlyTags = [...melByTag.keys()].filter((tag) => !matchlineByTag.has(tag));
  matched.sort((a, b) => compareCodeUnits(a.canonicalTag, b.canonicalTag));
  matchlineOnlyTags.sort(compareCodeUnits);
  melOnlyTags.sort(compareCodeUnits);

  return {
    matched,
    melOnlyTags,
    matchlineOnlyTags,
    summary: summarise(matched, melOnlyTags, matchlineOnlyTags, unkeyedMelRowCount),
  };
}

/** Field → MEL key, first binding wins, every field checked against §12.1. */
function bindMapping(mapping: ExistingMelMapping): Map<CanonicalMelField, string> {
  const unknown: string[] = [];
  const bound = new Map<CanonicalMelField, string>();
  for (const column of mapping) {
    const field: string = column.field;
    if (!isCanonicalMelField(field)) {
      unknown.push(field);
      continue;
    }
    if (!bound.has(field)) bound.set(field, column.melKey);
  }
  if (unknown.length > 0) {
    throw new MelExportError({
      kind: 'unknown-canonical-field',
      fields: unknown,
      knownFields: CANONICAL_MEL_FIELDS,
    });
  }
  return bound;
}

/** Canonical rows grouped by tag, in canonical row order. */
function groupMatchlineRows(
  assets: ReadonlyArray<GeneratedMelAsset>,
): Map<string, CanonicalMelRow[]> {
  const byTag = new Map<string, CanonicalMelRow[]>();
  for (const row of buildCanonicalMelRows(assets)) {
    const rows = byTag.get(row.equipmentTag);
    if (rows === undefined) byTag.set(row.equipmentTag, [row]);
    else rows.push(row);
  }
  return byTag;
}

function compareTag(
  canonicalTag: string,
  melTag: string,
  matchlineRows: ReadonlyArray<CanonicalMelRow>,
  melRows: ReadonlyArray<Readonly<Record<string, string>>>,
  comparedFields: ReadonlyArray<CanonicalMelField>,
  bound: ReadonlyMap<CanonicalMelField, string>,
): MelTagComparison {
  const matchlineRow = matchlineRows[0];
  const melRow = melRows[0];
  const fields: MelFieldComparison[] = [];
  let agreeCount = 0;
  for (const field of comparedFields) {
    const melKey = bound.get(field) ?? '';
    const matchlineValue = (matchlineRow?.[field] ?? '').trim();
    const melValue = (melRow?.[melKey] ?? '').trim();
    const agree = matchlineValue === melValue;
    if (agree) agreeCount++;
    fields.push({ field, matchlineValue, melValue, agree });
  }
  return {
    canonicalTag,
    melTag,
    fields,
    agreeCount,
    disagreeCount: fields.length - agreeCount,
    matchlineRowCount: matchlineRows.length,
    melRowCount: melRows.length,
  };
}

function summarise(
  matched: ReadonlyArray<MelTagComparison>,
  melOnlyTags: ReadonlyArray<string>,
  matchlineOnlyTags: ReadonlyArray<string>,
  unkeyedMelRowCount: number,
): MelComparisonSummary {
  let comparedFieldCount = 0;
  let agreeCount = 0;
  let disagreeCount = 0;
  let disagreeingTagCount = 0;
  for (const tag of matched) {
    comparedFieldCount += tag.fields.length;
    agreeCount += tag.agreeCount;
    disagreeCount += tag.disagreeCount;
    if (tag.disagreeCount > 0) disagreeingTagCount++;
  }
  return {
    matchedTagCount: matched.length,
    melOnlyTagCount: melOnlyTags.length,
    matchlineOnlyTagCount: matchlineOnlyTags.length,
    comparedFieldCount,
    agreeCount,
    disagreeCount,
    disagreeingTagCount,
    unkeyedMelRowCount,
  };
}
