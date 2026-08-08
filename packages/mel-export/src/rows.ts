/**
 * Canonical assets → canonical MEL rows.
 *
 * The input shape is this package's own (see {@link GeneratedMelAsset}): the
 * exporter takes the flattened facts it prints and nothing else, so it does not
 * depend on how `asset-catalog` or `system-resolver` happen to spell their
 * outputs today. The coordinator adapts the real producers onto this shape.
 *
 * ## Row order (docs/ENGINE.md, "Deterministic row order")
 *
 * System Key first, then Equipment Tag, both compared by UTF-16 code unit.
 * Code-unit comparison is deliberate: `localeCompare` would order the same
 * project differently on two machines, and a diff between two engineers'
 * exports has to mean a real change. Rows with no System Key sort last, all
 * together, so an unresolved system reads as a block at the bottom of the sheet
 * rather than hiding at the top under a blank.
 *
 * Ties are left in input order — `Array.prototype.sort` is stable — which is
 * what keeps a duplicated tag (`DUPLICATE_MODEL_TAG`: two model objects, one
 * tag, never merged) emitting its two rows the same way every run.
 *
 * ## Values are verbatim
 *
 * Nothing here trims, pads, upper-cases or re-spells a value. Normalization is
 * an explicit, provenanced profile step in `system-resolver` (PRODUCT.md §5.5);
 * an exporter that quietly tidied values would be a second, invisible one. The
 * only transforms are the two joins the column list itself calls for.
 */

import type { SystemResolution } from '@matchline/domain';

import type { CanonicalMelRow } from './columns.js';
import { compareCodeUnits } from './order.js';

/**
 * One compiled asset, flattened to what §12.1 prints.
 *
 * Optional members mean "no source stated this", and every one of them reaches
 * the sheet as an empty cell.
 */
export interface GeneratedMelAsset {
  /** The tag the project should use. Written to Equipment Tag. */
  readonly canonicalTag: string;
  readonly description?: string;
  readonly equipmentType?: string;
  readonly building?: string;
  /** Discipline as the source named it. */
  readonly nativeDiscipline?: string;
  /** Discipline after mapping onto the standard set. */
  readonly ssmDiscipline?: string;
  /** The resolved system. Its three published fields are printed verbatim. */
  readonly system?: SystemResolution;
  /** Parent tag from the SSM hierarchy projection. E3 fills this in. */
  readonly systemParentTag?: string;
  /** Commissioning dependencies, as tags. Order here does not matter. */
  readonly dependencyTags?: ReadonlyArray<string>;
  readonly sourceModelFile?: string;
  /** Extraction-cache object ids. Order here does not matter. */
  readonly modelObjectIds?: ReadonlyArray<number>;
  /**
   * Why the asset is in the register — normally a `SourceStatus` from
   * `@matchline/domain` (`'MODEL_CONFIRMED'`, `'DUPLICATE_MODEL_TAG'`, …).
   * Typed as a string because an asset can carry several statuses and the
   * caller decides how to render that; the exporter prints what it is handed.
   */
  readonly inclusionStatus: string;
  readonly parentEvidence?: string;
  readonly reviewStatus?: string;
  readonly modelRevisionSha256?: string;
}

/**
 * Build the ordered canonical MEL rows for a set of assets.
 *
 * Pure and total: no input is rejected, and the same input always yields the
 * same rows in the same order. An empty input yields no rows — the caller still
 * gets a header row from {@link writeCanonicalMelWorkbook}.
 */
export function buildCanonicalMelRows(
  assets: ReadonlyArray<GeneratedMelAsset>,
): ReadonlyArray<CanonicalMelRow> {
  return assets.map(toRow).sort(compareRows);
}

function toRow(asset: GeneratedMelAsset): CanonicalMelRow {
  const system: SystemResolution | undefined = asset.system;
  return {
    equipmentTag: asset.canonicalTag,
    equipmentDescription: text(asset.description),
    equipmentType: text(asset.equipmentType),
    building: text(asset.building),
    nativeDiscipline: text(asset.nativeDiscipline),
    ssmDiscipline: text(asset.ssmDiscipline),
    systemKey: text(system?.systemKey),
    systemDescription: text(system?.systemDescription),
    systemLabel: text(system?.systemLabel),
    systemParentEquipmentTag: text(asset.systemParentTag),
    dependencies: joinTags(asset.dependencyTags),
    sourceModel: text(asset.sourceModelFile),
    modelObjectId: joinObjectIds(asset.modelObjectIds),
    inclusionStatus: asset.inclusionStatus,
    parentEvidence: text(asset.parentEvidence),
    reviewStatus: text(asset.reviewStatus),
    modelRevisionHash: text(asset.modelRevisionSha256),
  };
}

/** Separator for the two multi-value columns, Dependencies and Model Object ID. */
const VALUE_SEPARATOR = '; ';

/** An absent optional value is an empty cell, never the text `'undefined'`. */
function text(value: string | undefined): string {
  return value ?? '';
}

/** Dependency tags, code-unit sorted so the cell does not depend on input order. */
function joinTags(tags: ReadonlyArray<string> | undefined): string {
  if (tags === undefined || tags.length === 0) return '';
  return [...tags].sort(compareCodeUnits).join(VALUE_SEPARATOR);
}

/**
 * Object ids ascending, rendered as text.
 *
 * Ascending *numerically*: ids are numbers, and code-unit order would put 10
 * before 9. They are rendered here rather than at the cell boundary because the
 * column holds several of them — the sheet only ever sees the joined string.
 */
function joinObjectIds(ids: ReadonlyArray<number> | undefined): string {
  if (ids === undefined || ids.length === 0) return '';
  return [...ids]
    .sort((a, b) => a - b)
    .map((id) => String(id))
    .join(VALUE_SEPARATOR);
}

function compareRows(a: CanonicalMelRow, b: CanonicalMelRow): number {
  const bySystem = compareSystemKeys(a.systemKey, b.systemKey);
  if (bySystem !== 0) return bySystem;
  return compareCodeUnits(a.equipmentTag, b.equipmentTag);
}

/** Code-unit order, except that the empty key sorts after every real one. */
function compareSystemKeys(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  return compareCodeUnits(a, b);
}
