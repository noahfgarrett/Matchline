import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CompiledProject } from '@matchline/compiler';
import {
  assignItemMasters,
  buildExtoRows,
  validateItemMasterTable,
  writeExtoWorkbook,
  type ExtoAsset,
  type ItemMasterAsset,
  type ItemMasterTable,
} from '@matchline/exto-export';
import {
  CANONICAL_MEL_FIELDS,
  analyzeTemplate,
  diffMelRevisions,
  isCanonicalMelField,
  writeDiffWorkbook,
  writeTemplateMel,
  type GeneratedMelAsset,
  type TemplateColumnSource,
  type TemplateMelMapping,
} from '@matchline/mel-export';
import {
  buildPredecessorMatrix,
  writePredecessorWorkbook,
  type PredecessorAsset,
} from '@matchline/scheduling';

import type {
  WireExportResult,
  WireTemplateAnalysis,
  WireTemplateBinding,
} from '../../shared/schemas.js';

/**
 * The exports panel: engine writers, then one `writeFileSync`.
 *
 * Everything in this file is a thin arrangement of E1/E4 writers over one
 * compiled project. No export invents a value: where a source is missing — no
 * P6 schedule, no trained item-master registry — the corresponding cells stay
 * blank and the success note says so, because a filled cell is read as a fact.
 */

function count(value: number, singular: string, plural: string): string {
  return `${String(value)} ${value === 1 ? singular : plural}`;
}

/** Writes bytes and describes what landed. The one place a file is created. */
function write(absolutePath: string, bytes: Uint8Array, note: string): WireExportResult {
  writeFileSync(absolutePath, bytes);
  return { written: true, path: absolutePath, byteSize: bytes.byteLength, note };
}

/* --------------------------------------------------- 1. the canonical MEL */

/**
 * The generated MEL exactly as the compile produced it (PRODUCT.md §12.1).
 *
 * `project.generatedMel.workbookBytes` is byte-stable, so exporting the same
 * compile twice writes identical files — which is what makes "has anything
 * changed?" answerable by hash.
 */
export function exportGeneratedMel(
  project: CompiledProject,
  absolutePath: string,
): WireExportResult {
  return write(
    absolutePath,
    project.generatedMel.workbookBytes,
    `${count(project.generatedMel.rows.length, 'row', 'rows')} on the canonical column set.`,
  );
}

/* -------------------------------------------------- 2. the site template */

/** Reads a site's own MEL layout and suggests a binding per column (§12.2). */
export function analyzeMelTemplate(bytes: Uint8Array, absolutePath: string): WireTemplateAnalysis {
  const analysis = analyzeTemplate(bytes);
  return {
    path: absolutePath,
    sheetName: analysis.sheetName,
    sheetNames: [...analysis.sheetNames],
    headerRow: analysis.headerRow,
    columns: analysis.columns.map((column) => ({
      index: column.index,
      header: column.header,
      suggestedField: column.suggestion?.field ?? '',
      match: column.suggestion?.match ?? '',
    })),
    fieldChoices: [...CANONICAL_MEL_FIELDS, 'blank'],
  };
}

export class ExportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * The site's layout, filled.
 *
 * Every unknown field name is collected before refusing, not the first one:
 * a mapping edited against a stale field list is wrong in several places at
 * once, and fixing it one refusal at a time is how a user gives up.
 */
export function exportTemplateMel(
  assets: readonly GeneratedMelAsset[],
  bindings: readonly WireTemplateBinding[],
  absolutePath: string,
): WireExportResult {
  const unknown: string[] = [];
  const mapping: TemplateMelMapping = bindings.map((binding) => {
    let field: TemplateColumnSource;
    if (binding.field === 'blank') {
      field = { kind: 'blank' };
    } else if (isCanonicalMelField(binding.field)) {
      field = binding.field;
    } else {
      unknown.push(binding.field);
      field = { kind: 'blank' };
    }
    return { templateColumn: binding.templateColumn, field };
  });

  if (unknown.length > 0) {
    throw new ExportError(
      `Matchline does not know these fields: ${unknown.join(', ')}. ` +
        `It writes ${CANONICAL_MEL_FIELDS.join(', ')}, or leaves a column blank.`,
    );
  }

  const bound = mapping.filter(
    (column) => typeof column.field === 'string' || column.field.kind !== 'blank',
  ).length;

  return write(
    absolutePath,
    writeTemplateMel(assets, mapping),
    `${count(assets.length, 'row', 'rows')} on the template’s own ` +
      `${count(mapping.length, 'column', 'columns')}, ${String(bound)} of them filled.`,
  );
}

/* ------------------------------------------------------------- 3. EXTO */

/**
 * The stored item-master table, or `null` when nothing has been trained.
 *
 * A table this build cannot read is not an export failure: the register still
 * writes, with the item-master column blank and the note saying why.
 */
export function readItemMasterTable(stored: unknown): ItemMasterTable | null {
  return validateItemMasterTable(stored) ? stored : null;
}

/**
 * The Rev21 upload sheet.
 *
 * `milestoneLabel` is deliberately never set: the milestone ladder needs a P6
 * schedule, this build has no P6 import wired into the session, and a printed
 * milestone nobody scheduled is a fabricated commitment. The column comes out
 * blank and the note says why.
 */
export function exportExto(
  project: CompiledProject,
  assets: readonly GeneratedMelAsset[],
  table: ItemMasterTable | null,
  absolutePath: string,
): WireExportResult {
  const itemMasterAssets: ItemMasterAsset[] = assets.map((asset): ItemMasterAsset => {
    const built: {
      canonicalTag: string;
      ssmDiscipline?: string;
      equipmentClass?: string;
      systemKey?: string;
      description?: string;
    } = { canonicalTag: asset.canonicalTag };
    if (asset.ssmDiscipline !== undefined) {
      built.ssmDiscipline = asset.ssmDiscipline;
    }
    if (asset.equipmentType !== undefined) {
      built.equipmentClass = asset.equipmentType;
    }
    if (asset.system !== undefined) {
      built.systemKey = asset.system.systemKey;
    }
    if (asset.description !== undefined) {
      built.description = asset.description;
    }
    return built;
  });

  const outcomes = table === null ? [] : assignItemMasters(table, itemMasterAssets);
  const assigned = new Map<string, string>();
  let proposalCount = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'assigned') {
      assigned.set(outcome.canonicalTag, outcome.itemMaster);
    } else if (outcome.kind === 'proposal') {
      // `unmatched` is deliberately not counted here: nothing was learned about
      // that asset at all, which is silence, not a proposal a reviewer owes an
      // answer to.
      proposalCount += 1;
    }
  }

  const extoAssets: ExtoAsset[] = assets.map((asset, index): ExtoAsset => {
    const base = itemMasterAssets[index];
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
    } = { ...(base ?? { canonicalTag: asset.canonicalTag }) };

    if (asset.system !== undefined) {
      built.systemLabel = asset.system.systemLabel;
    }
    if (asset.systemParentTag !== undefined) {
      built.structuralParentTag = asset.systemParentTag;
    }
    if (asset.dependencyTags !== undefined && asset.dependencyTags.length > 0) {
      built.dependencyTags = asset.dependencyTags;
    }
    const itemMaster = assigned.get(asset.canonicalTag);
    if (itemMaster !== undefined) {
      built.itemMaster = itemMaster;
    }
    return built;
  });

  const options: { itemMasterVocabulary?: ReadonlyArray<string> } = {};
  if (table !== null && table.vocabulary.length > 0) {
    options.itemMasterVocabulary = table.vocabulary;
  }
  const rows = buildExtoRows(extoAssets, options);

  const itemMasterNote =
    table === null
      ? 'No item-master registry has been trained, so that column is blank.'
      : `${count(assigned.size, 'item master', 'item masters')} assigned at or above the 0.9 gate` +
        `${proposalCount === 0 ? '' : `, ${String(proposalCount)} left as review proposals`}.`;

  return write(
    absolutePath,
    writeExtoWorkbook(rows),
    `${count(rows.length, 'row', 'rows')} on the Rev21 upload sheet. ${itemMasterNote} ` +
      'No P6 schedule is loaded, so the milestone column is blank.' +
      (project.stats.assetCount === rows.length ? '' : ' Some assets produced no row.'),
  );
}

/* ------------------------------------------------- 4. predecessor matrix */

export function exportPredecessors(
  project: CompiledProject,
  absolutePath: string,
): WireExportResult {
  const subjectOf = new Map(project.compileSubjects.map((subject) => [subject.assetId, subject]));
  const assets: PredecessorAsset[] = project.catalog.assets.map((asset): PredecessorAsset => {
    const systemKey = subjectOf.get(asset.assetId)?.attributes.get('systemKey');
    const built: { assetId: string; canonicalTag: string; systemKey?: string } = {
      assetId: asset.assetId,
      canonicalTag: asset.canonicalTag,
    };
    if (systemKey !== undefined) {
      built.systemKey = systemKey;
    }
    return built;
  });

  const matrix = buildPredecessorMatrix(project.snapshot, assets);
  const cycles =
    matrix.cycles.length === 0
      ? ''
      : ` ${count(matrix.cycles.length, 'precedence cycle', 'precedence cycles')} reported rather than broken.`;

  return write(
    absolutePath,
    writePredecessorWorkbook(matrix),
    `${count(matrix.rows.length, 'system', 'systems')}, ` +
      `${count(matrix.edges.length, 'predecessor edge', 'predecessor edges')}.${cycles}`,
  );
}

/* ---------------------------------------------------- 5. revision diff */

export function exportRevisionDiff(
  previous: readonly GeneratedMelAsset[],
  current: readonly GeneratedMelAsset[],
  absolutePath: string,
): WireExportResult {
  const diff = diffMelRevisions(previous, current);
  const summary = diff.summary;
  const note =
    summary.added === 0 &&
    summary.removed === 0 &&
    summary.changedTags === 0 &&
    summary.changedDescriptions === 0 &&
    summary.changedSystemKeys === 0 &&
    summary.changedHierarchyLevels === 0 &&
    summary.movedParents === 0 &&
    summary.dependenciesAdded === 0 &&
    summary.dependenciesRemoved === 0 &&
    summary.newConflicts === 0
      ? 'Nothing changed between these two compiles.'
      : `${String(summary.added)} added, ${String(summary.removed)} removed, ` +
        `${String(summary.changedDescriptions)} descriptions changed, ` +
        `${String(summary.movedParents)} parents moved.`;

  return write(absolutePath, writeDiffWorkbook(diff), note);
}

/* -------------------------------------------------------------- helpers */

/** A default file name for a save dialog: `Dragon-EXTO.xlsx`. */
export function defaultExportName(projectPath: string, suffix: string, extension: string): string {
  const base = path.basename(projectPath).replace(/\.matchline$/i, '');
  return `${base === '' ? 'Matchline' : base}-${suffix}.${extension}`;
}
