import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CompiledProject } from '@matchline/compiler';
import {
  analyzeExtoTemplate,
  assignItemMasters,
  assignWbs,
  buildExtoRows,
  countCanonicalizedCells,
  validateExtoTemplate,
  validateItemMasterTable,
  validateWbsTable,
  writeExtoWorkbook,
  type ExtoAsset,
  type ExtoDropdownField,
  type ExtoTemplate,
  type ItemMasterAsset,
  type ItemMasterTable,
  type WbsTable,
} from '@matchline/exto-export';
import { extoRev21Canonical } from '@matchline/ssm-audit/exto';
import {
  classifyDescription,
  validateLearnedRuleSet,
  type LearnedRuleSet,
} from '@matchline/learned-rules';
import {
  CANONICAL_MEL_FIELDS,
  analyzeTemplate,
  diffMelRevisions,
  isCanonicalMelField,
  writeDiffWorkbook,
  writeSsmHierarchyWorkbook,
  writeTemplateMel,
  type GeneratedMelAsset,
  type SsmHierarchyLevelConfig,
  type SsmHierarchyRow,
  type TemplateColumnSource,
  type TemplateMelMapping,
} from '@matchline/mel-export';
import {
  buildPredecessorMatrix,
  writePredecessorWorkbook,
  type PredecessorAsset,
} from '@matchline/scheduling';
import { writeSsmAuditWorkbook } from '@matchline/ssm-audit';
import type { HierarchyAssetNode, HierarchyLevelNode } from '@matchline/ssm-compiler';

import type {
  WireExportResult,
  WireExtoTemplate,
  WireHierarchyConfig,
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

/**
 * Writes bytes and describes what landed. The one place a file is created.
 *
 * Temp file then rename, the same way app-store.ts writes its state: an export
 * commonly lands *on top of* last week's copy of itself, and a crash or a full
 * disk halfway through a direct write would leave a half-written workbook
 * wearing the name of a good one. Rename within a directory is atomic, so the
 * path either still holds the old file or holds the whole new one.
 */
function write(absolutePath: string, bytes: Uint8Array, note: string): WireExportResult {
  const temporaryPath = `${absolutePath}.tmp`;
  try {
    writeFileSync(temporaryPath, bytes);
    renameSync(temporaryPath, absolutePath);
  } catch (error: unknown) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
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

/** The stored WBS table, on the same terms. */
export function readWbsTable(stored: unknown): WbsTable | null {
  return validateWbsTable(stored) ? stored : null;
}

/** The stored nesting rules, read here only for `classifyDescription`. */
export function readLearnedRules(stored: unknown): LearnedRuleSet | null {
  return validateLearnedRuleSet(stored) ? stored : null;
}

/** The captured EXTO layout, on the same terms. */
export function readExtoTemplate(stored: unknown): ExtoTemplate | null {
  return validateExtoTemplate(stored) ? stored : null;
}

/**
 * Capture a registry workbook's layout, so later EXTO exports are written on it.
 *
 * Reads bytes and returns a value; it writes no file and stores nothing. The
 * caller decides whether to keep what comes back — which is the point of the
 * split, because what the user reviewed is what should ship.
 *
 * The result is copied onto the wire shape rather than returned as the engine
 * type: the engine's arrays are `readonly`, the stored config's are not, and a
 * cast between them would be a lie about which one owns the value.
 */
export function analyzeExtoTemplateFile(bytes: Uint8Array, label: string): WireExtoTemplate {
  const template = analyzeExtoTemplate(bytes, { label });
  return {
    version: template.version,
    sheetName: template.sheetName,
    headers: [...template.headers],
    headerRowIndex: template.headerRowIndex,
    matched: template.matched.map((binding) => ({
      field: binding.field,
      columnIndex: binding.columnIndex,
      match: binding.match,
    })),
    capturedFrom: { label: template.capturedFrom.label },
  };
}

/**
 * The three fields a model mapping can answer and a learned table can otherwise
 * infer, resolved per asset.
 *
 * One rule, applied the same way three times: **a non-blank mapped model value
 * beats a learned assignment, and a learned assignment beats a blank cell.** A
 * value the model states is a fact about this project; a learned value is an
 * inference from somebody else's spreadsheet, however well it scored. When the
 * model has said nothing, the inference is the best truthful answer available,
 * and when neither has anything the cell stays empty rather than being filled
 * with a guess.
 *
 * Classification has one extra rung in the middle: the equipment *type* mapping,
 * which sites have been mapping since long before `equipmentClassification`
 * existed and which the EXTO export has always written into that column. It sits
 * below the explicit mapping and above the learned answer, so nothing a site
 * already configured changes meaning.
 */
interface RegisterFields {
  readonly wbs?: string;
  readonly itemMaster?: string;
  readonly equipmentClassification?: string;
}

/** What each field's value came from, counted for the export note. */
interface PrecedenceCounts {
  modelWbs: number;
  learnedWbs: number;
  modelItemMaster: number;
  learnedItemMaster: number;
  modelClassification: number;
  learnedClassification: number;
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Everything the EXTO assembly may consult, beyond the compiled assets. */
export interface ExtoLearning {
  readonly itemMasterTable: ItemMasterTable | null;
  readonly wbsTable: WbsTable | null;
  /** Consulted only for `classifyDescription`, and only below the model. */
  readonly nestingRules: LearnedRuleSet | null;
  /** The site's captured layout, or `null` for the generic Rev21 map. */
  readonly template: ExtoTemplate | null;
}

/**
 * The Rev21 upload sheet.
 *
 * `milestoneLabel` is deliberately never set: the milestone ladder needs a P6
 * schedule, this build has no P6 import wired into the session, and a printed
 * milestone nobody scheduled is a fabricated commitment. The column comes out
 * blank and the note says why.
 *
 * Three columns are settled by the precedence rule described above
 * ({@link RegisterFields}) rather than by one source: WBS, Item Master and
 * Equipment Classification each take the model's mapped value when there is one,
 * a learned answer when there is not, and nothing when neither has anything.
 */
export function exportExto(
  project: CompiledProject,
  assets: readonly GeneratedMelAsset[],
  learning: ExtoLearning,
  absolutePath: string,
): WireExportResult {
  const { itemMasterTable, wbsTable, nestingRules, template } = learning;

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
    // The item-master rungs key on the classification, so they must see the same
    // value the Classification column will print — model mapping first.
    const equipmentClass =
      nonBlank(asset.equipmentClassification) ?? nonBlank(asset.equipmentType);
    if (equipmentClass !== undefined) {
      built.equipmentClass = equipmentClass;
    }
    if (asset.system !== undefined) {
      built.systemKey = asset.system.systemKey;
    }
    if (asset.description !== undefined) {
      built.description = asset.description;
    }
    return built;
  });

  const outcomes = itemMasterTable === null ? [] : assignItemMasters(itemMasterTable, itemMasterAssets);
  const learnedItemMasters = new Map<string, string>();
  let proposalCount = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'assigned') {
      learnedItemMasters.set(outcome.canonicalTag, outcome.itemMaster);
    } else if (outcome.kind === 'proposal') {
      // `unmatched` is deliberately not counted here: nothing was learned about
      // that asset at all, which is silence, not a proposal a reviewer owes an
      // answer to.
      proposalCount += 1;
    }
  }

  const counts: PrecedenceCounts = {
    modelWbs: 0,
    learnedWbs: 0,
    modelItemMaster: 0,
    learnedItemMaster: 0,
    modelClassification: 0,
    learnedClassification: 0,
  };
  let wbsProposalCount = 0;

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
      building?: string;
      wbs?: string;
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
    if (asset.building !== undefined) {
      built.building = asset.building;
    }

    /* --- WBS: mapped model value, then the learned table, then blank --- */
    const modelWbs = nonBlank(asset.wbs);
    if (modelWbs !== undefined) {
      built.wbs = modelWbs;
      counts.modelWbs += 1;
    } else if (wbsTable !== null) {
      const outcome = assignWbs(wbsTable, asset.system?.systemKey);
      if (outcome.kind === 'assigned') {
        built.wbs = outcome.wbs;
        counts.learnedWbs += 1;
      } else if (outcome.kind === 'proposal') {
        wbsProposalCount += 1;
      }
    }

    /* --- Item Master: mapped model value, then the learned table, then blank --- */
    const modelItemMaster = nonBlank(asset.itemMaster);
    if (modelItemMaster !== undefined) {
      built.itemMaster = modelItemMaster;
      counts.modelItemMaster += 1;
    } else {
      const learned = learnedItemMasters.get(asset.canonicalTag);
      if (learned !== undefined) {
        built.itemMaster = learned;
        counts.learnedItemMaster += 1;
      }
    }

    /* --- Classification: mapped, then equipment type, then learned, then blank --- */
    if (built.equipmentClass !== undefined) {
      counts.modelClassification += 1;
    } else if (nestingRules !== null) {
      const hit = classifyDescription(nestingRules, asset.description, asset.ssmDiscipline);
      if (hit !== null) {
        built.equipmentClass = hit.class;
        counts.learnedClassification += 1;
      }
    }

    return built;
  });

  const options: {
    itemMasterVocabulary?: ReadonlyArray<string>;
    canonicalize: (field: ExtoDropdownField, value: string) => string;
  } = {
    // The delivered sheet is the one place the approved spelling matters, so it
    // is the one place the canonicaliser is supplied. `@matchline/ssm-audit`'s
    // own row builder deliberately does not: the audit has to see the register
    // as it stands, and auditing a copy this export had already corrected would
    // report a site as compliant because of what happened on the way out.
    canonicalize: extoRev21Canonical,
  };
  if (itemMasterTable !== null && itemMasterTable.vocabulary.length > 0) {
    options.itemMasterVocabulary = itemMasterTable.vocabulary;
  }
  const rows = buildExtoRows(extoAssets, options);
  const canonicalizedCells = countCanonicalizedCells(rows);

  const assignedItemMasters = counts.modelItemMaster + counts.learnedItemMaster;
  const itemMasterNote =
    itemMasterTable === null && counts.modelItemMaster === 0
      ? 'No item-master registry has been trained and no model property is mapped, so that column is blank.'
      : `${count(assignedItemMasters, 'item master', 'item masters')} filled ` +
        `(${String(counts.modelItemMaster)} from the model, ${String(counts.learnedItemMaster)} learned)` +
        `${proposalCount === 0 ? '' : `, ${String(proposalCount)} left as review proposals`}.`;

  const wbsNote =
    wbsTable === null && counts.modelWbs === 0
      ? ' No WBS table has been trained and no model property is mapped, so that column is blank.'
      : ` ${count(counts.modelWbs + counts.learnedWbs, 'WBS code', 'WBS codes')} filled ` +
        `(${String(counts.modelWbs)} from the model, ${String(counts.learnedWbs)} learned)` +
        `${wbsProposalCount === 0 ? '' : `, ${String(wbsProposalCount)} below the gate`}.`;

  const classificationNote =
    counts.learnedClassification === 0
      ? ''
      : ` ${count(counts.learnedClassification, 'classification', 'classifications')} came from ` +
        'the learned description table.';

  const canonicalNote =
    canonicalizedCells === 0
      ? ''
      : ` ${count(canonicalizedCells, 'cell was', 'cells were')} rewritten to the approved ` +
        'Exto spelling.';

  const layoutNote =
    template === null
      ? "Matchline's own Rev21 columns"
      : `the site template's own ${count(template.headers.length, 'column', 'columns')}, ` +
        `${count(template.matched.length, 'of them filled', 'of them filled')}`;

  const writeOptions: { template?: ExtoTemplate } = {};
  if (template !== null) {
    writeOptions.template = template;
  }

  return write(
    absolutePath,
    writeExtoWorkbook(rows, writeOptions),
    `${count(rows.length, 'row', 'rows')} on ${layoutNote}. ${itemMasterNote}${wbsNote}${classificationNote}${canonicalNote} ` +
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

/* -------------------------------------------------- 5. the SSM hierarchy */

/** Level values gathered on the way down, keyed by `levelId`. */
type LevelPath = ReadonlyMap<string, string>;

/**
 * The SSM hierarchy itself, widened onto one sheet (audit blocker B5).
 *
 * Every other export describes equipment as a flat list. The generated MEL
 * carries no derived attribute, so a level a site defined for itself had no
 * column anywhere; level order, the `(unassigned)` buckets and which assets are
 * roots were all implicit in a tree nobody outside the app could see. This is
 * the export that hands the tree over.
 *
 * One column per configured level, in stack order — derived-attribute levels
 * included, under the display name the site gave them, because to a reviewer
 * they are levels like any other. Then the asset's own facts, then a second
 * sheet stating which of those levels are structural boundaries, since "these
 * two never nest" is the single most consequential thing the configuration
 * says and it is invisible in the data columns.
 *
 * The tree is walked, not the catalog: an asset's place in the hierarchy is the
 * thing being exported, and the walk is the only reading of it that cannot
 * disagree with the compile. An asset the projection did not place therefore
 * produces no row, and the note says how many.
 */
/**
 * The SSM Audit findings, on SSM-Audit's own All Findings and Rules columns.
 *
 * The gate itself runs inside the compile (docs/ENGINE.md, "SSM Audit gate");
 * this hands over the report. Nothing is recomputed here — the findings are the
 * ones on screen 8 and in the review queue, so the file and the app can never
 * describe different registers.
 *
 * The note leads with the blockers, because "Exto would refuse 34 of these
 * rows" is the sentence a coordinator needs before they open the file.
 */
export function exportSsmAudit(project: CompiledProject, absolutePath: string): WireExportResult {
  const audit = project.ssmAudit;
  const bytes = writeSsmAuditWorkbook(audit, { assets: project.generatedMel.assets });
  const disabled = audit.rulesEnabled.filter((rule) => !rule.enabled).length;
  const note =
    `${count(audit.findings.length, 'finding', 'findings')} over ` +
    `${count(audit.rowCount, 'row', 'rows')}: ` +
    `${String(audit.bySeverity.blocker)} Exto would refuse, ` +
    `${String(audit.bySeverity.error)} broken SOP rules, ` +
    `${String(audit.bySeverity.warning)} to check, ` +
    `${String(audit.bySeverity.info)} notes. ` +
    (disabled === 0
      ? 'Every rule is switched on.'
      : `${count(disabled, 'rule is', 'rules are')} switched off for this site and ` +
        'neither their findings nor they themselves are in the file.');
  return write(absolutePath, bytes, note);
}

export function exportSsmHierarchy(
  project: CompiledProject,
  hierarchy: WireHierarchyConfig,
  absolutePath: string,
): WireExportResult {
  const levels: readonly SsmHierarchyLevelConfig[] = hierarchy.levels.map((level) => ({
    displayName: level.displayName,
    attributeKey: level.attributeKey,
    boundary: level.boundary,
  }));
  const columnOf = new Map(hierarchy.levels.map((level, index) => [level.levelId, index]));

  const tagOf = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset.canonicalTag]));
  const assetOf = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset]));
  const subjectOf = new Map(project.compileSubjects.map((subject) => [subject.assetId, subject]));

  const rows: SsmHierarchyRow[] = [];

  const emit = (node: HierarchyAssetNode, path: LevelPath): void => {
    const asset = assetOf.get(node.assetId);
    const resolution = project.systems.bySubject.get(node.assetId)?.resolution ?? null;
    const resolved = project.snapshot.nodes.get(node.assetId);

    // Positional, so a level that placed no value still occupies its column.
    const levelValues: string[] = hierarchy.levels.map(
      (level) => path.get(level.levelId) ?? '',
    );

    rows.push({
      levelValues,
      canonicalTag: tagOf.get(node.assetId) ?? node.assetId,
      description: asset?.description ?? '',
      equipmentType: asset?.equipmentType ?? '',
      nativeDiscipline: asset?.nativeDiscipline ?? '',
      ssmDiscipline: subjectOf.get(node.assetId)?.attributes.get('ssmDiscipline') ?? '',
      systemKey: resolution?.systemKey ?? '',
      systemLabel: resolution?.systemLabel ?? '',
      structuralParentTag:
        node.parentAssetId === null ? '' : (tagOf.get(node.parentAssetId) ?? node.parentAssetId),
      // Deduplicated and sorted so two exports of one compile read alike; the
      // engine lists a dependency once per claim that produced it.
      dependencyTags: [
        ...new Set(
          (resolved?.dependencies ?? [])
            .map((dependency): string => tagOf.get(dependency.parentAssetId) ?? '')
            .filter((tag) => tag !== ''),
        ),
      ].sort(),
      root: node.parentAssetId === null,
      // The same values again, joined, so a reader who has collapsed the level
      // columns can still see where the row sits.
      levelPath: levelValues.filter((value) => value !== '').join(' › '),
    });

    for (const child of node.children) {
      emit(child, path);
    }
  };

  const descend = (node: HierarchyLevelNode, path: LevelPath): void => {
    const next = new Map(path);
    // The label, not the key: this sheet is read by a person, and the key is on
    // the Levels sheet under the attribute that produced it.
    next.set(node.levelId, node.label);
    for (const child of node.levels) {
      descend(child, next);
    }
    for (const asset of node.assets) {
      emit(asset, next);
    }
  };

  for (const level of project.tree.levels) {
    descend(level, new Map());
  }
  for (const asset of project.tree.assets) {
    emit(asset, new Map());
  }

  const rootCount = rows.filter((row) => row.root).length;
  const boundaryCount = levels.filter((level) => level.boundary).length;
  const unplaced = project.stats.assetCount - rows.length;

  return write(
    absolutePath,
    writeSsmHierarchyWorkbook(rows, levels),
    `${count(rows.length, 'row', 'rows')} across ` +
      `${count(levels.length, 'level', 'levels')}, ${String(rootCount)} of them roots. ` +
      `${count(boundaryCount, 'level is a structural boundary', 'levels are structural boundaries')}.` +
      (unplaced > 0
        ? ` ${count(unplaced, 'asset', 'assets')} the projection did not place produced no row.`
        : ''),
  );
}

/* ---------------------------------------------------- 6. revision diff */

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
    summary.changedSystemDescriptions === 0 &&
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
