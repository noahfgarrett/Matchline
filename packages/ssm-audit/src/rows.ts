/**
 * A compiled project, flattened into the rows the SSM Audit rulebook reads.
 *
 * The rulebook audits a finished Exto Cx Registry: a wide sheet with one row
 * per piece of commissionable equipment. Matchline can hand it exactly that,
 * because `@matchline/exto-export` already builds the upload rows — so the
 * audit sees what the upload sheet would carry, cell for cell, rather than a
 * second flattening that could disagree with it.
 *
 * ## Three fields the upload sheet does not carry
 *
 * 1. **Equipment Description.** The Rev21 map positions the column and
 *    `@matchline/exto-export` deliberately leaves it blank ("the Rev21 map
 *    positions no cell this package fills from it"). The rulebook's whole
 *    commissioning-logic half reads it — a VESDA, an RIO, a heat-trace panel
 *    are all recognised by description — so it is filled here, from the
 *    asset the row was built from. Auditing a description Matchline holds and
 *    does not print is honest; the audit is about the equipment, not about the
 *    sheet's blank cells.
 * 2. **Closest Parent Status.** The Rev21 map positions no cell for it either,
 *    and the rulebook reads it hard: a root (`Closest Parent` = its own System
 *    Name) is exempt from "parent not found in this registry" only on a `NEW`
 *    row. So it is derived, and derived narrowly — `NEW` exactly when Matchline
 *    can see the parent, which is when the Closest Parent is another row of
 *    this upload or the row's own System Name, and blank otherwise. `NEW`
 *    asserts "the parent row is created by this upload", so asserting it for a
 *    parent that is not in the upload would be a claim Matchline cannot make;
 *    and blanket `NEW` would silence the one blocker that catches a Closest
 *    Parent naming nothing. Blanket blank would do the opposite — every root in
 *    the project would come out a blocker.
 * 3. **Milestones.** Blank, both levels, because no P6 schedule is wired into
 *    a compile. The rulebook checks milestones only when the project uses
 *    them, so the whole milestone family stays silent rather than reporting
 *    every row as missing something nobody has scheduled.
 *
 * Every other Rev21 field Matchline states nothing about is the empty string.
 * A gap that reads as a fact is the failure mode the export layer is arranged
 * to avoid, and an audit finding invented out of one would be worse.
 */

import type { ExtoAsset, ExtoRow } from '@matchline/exto-export';
import { buildExtoRows } from '@matchline/exto-export';
import type { GeneratedMelAsset } from '@matchline/mel-export';

import type { SsmAuditRow } from '../vendor/audit/engine.js';
import { auditNormId } from '../vendor/audit/model.js';
import { EXTO_REV21_COLUMNS } from '../vendor/exto/rev21-contract.js';

/** The sheet name a finding names, standing in for the workbook tab. */
export const AUDIT_SHEET_NAME = 'Exto SSM';

/**
 * Closest Parent Status on a row whose parent this upload carries.
 *
 * One of the two values the approved dropdown carries (`EXISTING`, `NEW`). See
 * note 2 in the module doc for when it is written and when the cell is blank.
 */
export const AUDIT_CLOSEST_PARENT_STATUS = 'NEW';

/** One audit row and the asset it was built from, kept together. */
export interface AuditRowWithAsset {
  readonly row: SsmAuditRow;
  /** The row's Equipment ID. Empty only if the asset has no tag. */
  readonly canonicalTag: string;
}

/**
 * The asset shape this module reads.
 *
 * Structural, and deliberately not `CompiledProject`: the compiler depends on
 * this package, so a dependency the other way would be a cycle. What is needed
 * is the flattened asset the coordinator already assembles once and hands to
 * every exporter.
 */
export type AuditableAsset = GeneratedMelAsset;

/** Options that change what the rows carry. */
export interface BuildAuditRowsOptions {
  /**
   * The legal VF item-master vocabulary, when the project has trained one.
   *
   * Passed straight through to `buildExtoRows`, so a legacy `CA_<site>_<name>`
   * master is audited as the VF name the upload sheet would actually print
   * rather than as the name the model happens to hold.
   */
  readonly itemMasterVocabulary?: ReadonlyArray<string>;
}

/**
 * Build the audit rows for a set of compiled assets, in upload-sheet order.
 *
 * Pure and total. The same assets always produce the same rows, because
 * `buildExtoRows` sorts them.
 */
export function buildAuditRows(
  assets: ReadonlyArray<AuditableAsset>,
  options: BuildAuditRowsOptions = {},
): ReadonlyArray<AuditRowWithAsset> {
  const descriptions = new Map<string, string>();
  for (const asset of assets) {
    // First writer wins, so a duplicated tag does not have its description
    // rewritten by whichever of its rows was assembled last.
    if (asset.description !== undefined && !descriptions.has(asset.canonicalTag)) {
      descriptions.set(asset.canonicalTag, asset.description);
    }
  }

  const rowOptions: { itemMasterVocabulary?: ReadonlyArray<string> } = {};
  if (options.itemMasterVocabulary !== undefined) {
    rowOptions.itemMasterVocabulary = options.itemMasterVocabulary;
  }

  const rows = buildExtoRows(assets.map(extoAssetOf), rowOptions);

  // What the upload itself contains, so a Closest Parent can be judged against
  // it: every Equipment ID, and every System Name a root may attach to.
  const known = new Set<string>();
  for (const row of rows) {
    if (row.equipmentId !== '') known.add(auditNormId(row.equipmentId));
    if (row.systemName !== '') known.add(auditNormId(row.systemName));
  }

  return rows.map((row: ExtoRow, index: number): AuditRowWithAsset => ({
    row: auditRowOf(row, descriptions.get(row.equipmentId) ?? '', index + 1, known),
    canonicalTag: row.equipmentId,
  }));
}

/**
 * One compiled asset as the EXTO layer's own input shape.
 *
 * The same adaptation the desktop's exporter performs, minus the two learned
 * tables: a compile has no item-master registry or WBS table in hand, and the
 * audit is about what the model and the profile settled, not about what a
 * learned rung would add on the way out. A site that has trained those tables
 * sees their effect in the export; what the audit reports is either way a
 * statement about the same hierarchy.
 */
function extoAssetOf(asset: AuditableAsset): ExtoAsset {
  const built: {
    canonicalTag: string;
    ssmDiscipline?: string;
    equipmentClass?: string;
    systemKey?: string;
    description?: string;
    systemLabel?: string;
    structuralParentTag?: string;
    dependencyTags?: ReadonlyArray<string>;
    itemMaster?: string;
    building?: string;
    wbs?: string;
  } = { canonicalTag: asset.canonicalTag };

  if (asset.ssmDiscipline !== undefined) {
    built.ssmDiscipline = asset.ssmDiscipline;
  }
  // The classification column prefers the model's mapped value and falls back
  // to the equipment type, exactly as the exporter does.
  const equipmentClass = nonBlank(asset.equipmentClassification) ?? nonBlank(asset.equipmentType);
  if (equipmentClass !== undefined) {
    built.equipmentClass = equipmentClass;
  }
  if (asset.system !== undefined) {
    built.systemKey = asset.system.systemKey;
    built.systemLabel = asset.system.systemLabel;
  }
  if (asset.description !== undefined) {
    built.description = asset.description;
  }
  if (asset.systemParentTag !== undefined) {
    built.structuralParentTag = asset.systemParentTag;
  }
  if (asset.dependencyTags !== undefined && asset.dependencyTags.length > 0) {
    built.dependencyTags = asset.dependencyTags;
  }
  if (asset.building !== undefined) {
    built.building = asset.building;
  }
  if (asset.wbs !== undefined) {
    built.wbs = asset.wbs;
  }
  if (asset.itemMaster !== undefined) {
    built.itemMaster = asset.itemMaster;
  }
  return built;
}

/** One upload row on the rulebook's own 44-field row shape. */
function auditRowOf(
  row: ExtoRow,
  description: string,
  rowNumber: number,
  known: ReadonlySet<string>,
): SsmAuditRow {
  const record: Record<string, string> = {};
  for (const column of EXTO_REV21_COLUMNS) {
    record[column.field] = '';
  }

  record['building'] = row.building;
  record['level'] = row.level;
  record['grid'] = row.grid;
  record['upn'] = row.upn;
  record['discipline'] = row.discipline;
  record['wbs'] = row.wbs;
  record['systemName'] = row.systemName;
  record['equipmentId'] = row.equipmentId;
  record['equipmentDescription'] = description;
  record['manufacturer'] = row.manufacturer;
  record['modelNumber'] = row.modelNumber;
  record['closestParent'] = row.closestParent;
  record['closestParentStatus'] =
    row.closestParent !== '' && known.has(auditNormId(row.closestParent))
      ? AUDIT_CLOSEST_PARENT_STATUS
      : '';
  record['milestone'] = row.milestone;
  record['itemMaster'] = row.itemMaster;
  record['equipmentClassification'] = row.equipmentClassification;
  record['dependencies'] = row.dependencies;

  const built: SsmAuditRow = {
    ...record,
    _source: {
      file: '',
      sheet: AUDIT_SHEET_NAME,
      row: rowNumber,
      columns: {},
    },
  };
  return built;
}

/** A value that says something, or `undefined`. Whitespace says nothing. */
function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
