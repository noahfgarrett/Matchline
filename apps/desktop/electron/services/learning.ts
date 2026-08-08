import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  trainItemMasterTable,
  type ItemMasterTable,
  type ItemMasterTrainingRow,
} from '@matchline/exto-export';
import {
  trainLearnedRules,
  type LearnedRuleSet,
  type TrainingRow,
} from '@matchline/learned-rules';
import { readWorkbook, sheetAoa } from '@matchline/spreadsheet-import';

import type { WireLearnedRuleKind, WireLearnedSummary } from '../../shared/schemas.js';

/**
 * Screen 7's learned-rules section: a finished SSM or registry export in, a
 * stored rule set and a summary out.
 *
 * The workbook is read here and nothing but the summary crosses IPC. Two rules
 * shape the reading:
 *
 * - **Columns are matched by header text, literally.** The synonym lists below
 *   are short and every entry is a spelling a real export uses. A header that
 *   matches nothing is left unmapped; a required column that matches nothing is
 *   a refusal with a sentence naming what was looked for. Guessing a column is
 *   how a wrong parent ends up trained into a site's rules.
 * - **Nothing here grades anything.** `trainLearnedRules` self-grades by
 *   replaying the shipping policy over the export's own answers, and
 *   `trainItemMasterTable` gates at 0.9. This file reports those numbers; it
 *   does not compute a confidence of its own.
 */

export class TrainingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TrainingError';
  }
}

/** Header text folded for comparison: case, spaces and punctuation removed. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Column index for the first header matching any of `spellings`, or `-1`. */
function columnOf(headers: readonly string[], spellings: readonly string[]): number {
  const wanted = new Set(spellings.map(fold));
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (header !== undefined && wanted.has(fold(header))) {
      return index;
    }
  }
  return -1;
}

const TAG_SPELLINGS = ['equipmenttag', 'tag', 'equipmentid', 'equipmentno', 'equipmentnumber'];
const PARENT_SPELLINGS = ['closestparent', 'systemparent', 'parenttag', 'parent'];
const SYSTEM_SPELLINGS = ['upn', 'systemkey', 'system'];
const DISCIPLINE_SPELLINGS = ['discipline', 'ssmdiscipline', 'service'];
const DESCRIPTION_SPELLINGS = ['description', 'equipmentdescription'];
const FAMILY_SPELLINGS = ['familykey', 'family'];
const ITEM_MASTER_SPELLINGS = [
  'itemmasteruniqueidentifier',
  'itemmaster',
  'itemmasterid',
  'itemmasteruid',
];
const CLASS_SPELLINGS = ['equipmentclassification', 'equipmentclass', 'classification', 'class'];

/**
 * The first sheet whose header row carries an equipment-tag column.
 *
 * A registry export routinely has cover sheets and pick-list sheets; picking
 * the first sheet outright would train on whichever one happened to be first.
 */
interface FoundSheet {
  readonly sheetName: string;
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

function findSheet(bytes: Uint8Array, fileName: string): FoundSheet {
  const workbook = readWorkbook(bytes);
  const looked: string[] = [];

  for (const sheetName of workbook.sheetNames) {
    const { aoa } = sheetAoa(workbook.getSheet(sheetName));
    // The header row is the first row with a tag column. Registry exports put a
    // title or a blank spacer above their headers (the EXTO sheet does exactly
    // that), so "row 0" is not a rule that survives real files.
    for (let index = 0; index < Math.min(aoa.length, 20); index += 1) {
      const headers = aoa[index];
      if (headers === undefined || columnOf(headers, TAG_SPELLINGS) < 0) {
        continue;
      }
      return { sheetName, headers, rows: aoa.slice(index + 1) };
    }
    looked.push(sheetName);
  }

  throw new TrainingError(
    `No sheet in ${fileName} has a column Matchline recognizes as the equipment tag ` +
      `(looked at ${looked.length === 0 ? 'no sheets' : looked.join(', ')}). ` +
      'Matchline accepts Equipment Tag, Tag, Equipment ID or Equipment No.',
  );
}

function cell(row: ReadonlyArray<string>, index: number): string {
  return index < 0 ? '' : (row[index] ?? '').trim();
}

/* --------------------------------------------------------- nesting rules */

interface NestingTraining {
  readonly rules: LearnedRuleSet;
  readonly summary: WireLearnedSummary;
}

export function trainNestingFrom(absolutePath: string, savedAt: string): NestingTraining {
  const fileName = path.basename(absolutePath);
  const sheet = findSheet(readFileSync(absolutePath), fileName);

  const tagColumn = columnOf(sheet.headers, TAG_SPELLINGS);
  const descriptionColumn = columnOf(sheet.headers, DESCRIPTION_SPELLINGS);
  const parentColumn = columnOf(sheet.headers, PARENT_SPELLINGS);
  const systemColumn = columnOf(sheet.headers, SYSTEM_SPELLINGS);
  const disciplineColumn = columnOf(sheet.headers, DISCIPLINE_SPELLINGS);
  const familyColumn = columnOf(sheet.headers, FAMILY_SPELLINGS);

  if (parentColumn < 0) {
    throw new TrainingError(
      `${fileName} (sheet ${sheet.sheetName}) has no parent column, so there is nothing to ` +
        'learn nesting from. Matchline accepts Closest Parent, System Parent or Parent Tag.',
    );
  }

  const rows: TrainingRow[] = [];
  for (const raw of sheet.rows) {
    const equipmentTag = cell(raw, tagColumn);
    if (equipmentTag === '') {
      continue;
    }
    const row: {
      equipmentTag: string;
      description: string;
      parentTag?: string;
      systemKey?: string;
      discipline?: string;
      familyKey?: string;
    } = { equipmentTag, description: cell(raw, descriptionColumn) };

    const parentTag = cell(raw, parentColumn);
    if (parentTag !== '') {
      row.parentTag = parentTag;
    }
    const systemKey = cell(raw, systemColumn);
    if (systemKey !== '') {
      row.systemKey = systemKey;
    }
    const discipline = cell(raw, disciplineColumn);
    if (discipline !== '') {
      row.discipline = discipline;
    }
    const familyKey = cell(raw, familyColumn);
    if (familyKey !== '') {
      row.familyKey = familyKey;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    throw new TrainingError(
      `${fileName} (sheet ${sheet.sheetName}) has headers but no rows with an equipment tag.`,
    );
  }

  const rules = trainLearnedRules(rows, { label: fileName });

  return {
    rules,
    summary: {
      kind: 'nesting',
      label: rules.trainedFrom.label,
      savedAt,
      rowCount: rules.trainedFrom.rowCount,
      classCount: rules.classification.length,
      gateCount: rules.roleGates.length,
      affinityCount: rules.affinities.length,
      claimGradeCount: rules.grades.filter((grade) => grade.grade === 'claim').length,
      proposalGradeCount: rules.grades.filter((grade) => grade.grade !== 'claim').length,
      suspectRowCount: 0,
      grades: rules.grades.map((grade) => ({
        className: grade.class,
        predicted: grade.predicted,
        correct: grade.correct,
        precision: grade.precision,
        grade: grade.grade,
      })),
    },
  };
}

/* ----------------------------------------------------- item-master table */

interface ItemMasterTraining {
  readonly table: ItemMasterTable;
  readonly summary: WireLearnedSummary;
}

export function trainItemMastersFrom(absolutePath: string, savedAt: string): ItemMasterTraining {
  const fileName = path.basename(absolutePath);
  const sheet = findSheet(readFileSync(absolutePath), fileName);

  const tagColumn = columnOf(sheet.headers, TAG_SPELLINGS);
  const itemMasterColumn = columnOf(sheet.headers, ITEM_MASTER_SPELLINGS);
  const disciplineColumn = columnOf(sheet.headers, DISCIPLINE_SPELLINGS);
  const systemColumn = columnOf(sheet.headers, SYSTEM_SPELLINGS);
  const classColumn = columnOf(sheet.headers, CLASS_SPELLINGS);
  const descriptionColumn = columnOf(sheet.headers, DESCRIPTION_SPELLINGS);

  if (itemMasterColumn < 0) {
    throw new TrainingError(
      `${fileName} (sheet ${sheet.sheetName}) has no Item Master Unique Identifier column, ` +
        'so there is nothing to learn item masters from.',
    );
  }

  const rows: ItemMasterTrainingRow[] = [];
  for (const raw of sheet.rows) {
    const equipmentId = cell(raw, tagColumn);
    if (equipmentId === '') {
      continue;
    }
    const row: {
      equipmentId: string;
      discipline: string;
      systemKey: string;
      itemMaster: string;
      equipmentClass?: string;
      description?: string;
    } = {
      equipmentId,
      discipline: cell(raw, disciplineColumn),
      systemKey: cell(raw, systemColumn),
      itemMaster: cell(raw, itemMasterColumn),
    };
    const equipmentClass = cell(raw, classColumn);
    if (equipmentClass !== '') {
      row.equipmentClass = equipmentClass;
    }
    const description = cell(raw, descriptionColumn);
    if (description !== '') {
      row.description = description;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    throw new TrainingError(
      `${fileName} (sheet ${sheet.sheetName}) has headers but no rows with an equipment tag.`,
    );
  }

  const table = trainItemMasterTable(rows, { label: fileName });
  const gated = table.entries.filter((entry) => entry.confidence >= 0.9).length;

  return {
    table,
    summary: {
      kind: 'item-master',
      label: table.trainedFrom.label,
      savedAt,
      rowCount: table.trainedFrom.rowCount,
      classCount: table.entries.length,
      gateCount: gated,
      affinityCount: 0,
      claimGradeCount: gated,
      proposalGradeCount: table.entries.length - gated,
      suspectRowCount: table.audit.length,
      grades: [],
    },
  };
}

/* ------------------------------------------------ reading a stored set back */

/** Which kind's summary a stored record describes, for `learned:list`. */
export function summarizeStored(
  kind: WireLearnedRuleKind,
  rules: unknown,
  savedAt: string,
): WireLearnedSummary | null {
  if (typeof rules !== 'object' || rules === null) {
    return null;
  }
  const record = rules as Record<string, unknown>;
  const trainedFrom = record['trainedFrom'];
  const label =
    typeof trainedFrom === 'object' && trainedFrom !== null
      ? String((trainedFrom as Record<string, unknown>)['label'] ?? '')
      : '';
  const rowCount =
    typeof trainedFrom === 'object' && trainedFrom !== null
      ? Number((trainedFrom as Record<string, unknown>)['rowCount'] ?? 0)
      : 0;

  const list = (key: string): readonly unknown[] => {
    const value = record[key];
    return Array.isArray(value) ? value : [];
  };

  if (kind === 'nesting') {
    const grades = list('grades');
    const claim = grades.filter(
      (grade) =>
        typeof grade === 'object' &&
        grade !== null &&
        (grade as Record<string, unknown>)['grade'] === 'claim',
    ).length;
    return {
      kind,
      label,
      savedAt,
      rowCount: Number.isFinite(rowCount) ? rowCount : 0,
      classCount: list('classification').length,
      gateCount: list('roleGates').length,
      affinityCount: list('affinities').length,
      claimGradeCount: claim,
      proposalGradeCount: grades.length - claim,
      suspectRowCount: 0,
      grades: grades.flatMap((grade) => {
        if (typeof grade !== 'object' || grade === null) {
          return [];
        }
        const entry = grade as Record<string, unknown>;
        return [
          {
            className: String(entry['class'] ?? ''),
            predicted: Number(entry['predicted'] ?? 0),
            correct: Number(entry['correct'] ?? 0),
            precision: Number(entry['precision'] ?? 0),
            grade: String(entry['grade'] ?? 'proposal'),
          },
        ];
      }),
    };
  }

  const entries = list('entries');
  const gated = entries.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      Number((entry as Record<string, unknown>)['confidence'] ?? 0) >= 0.9,
  ).length;
  return {
    kind,
    label,
    savedAt,
    rowCount: Number.isFinite(rowCount) ? rowCount : 0,
    classCount: entries.length,
    gateCount: gated,
    affinityCount: 0,
    claimGradeCount: gated,
    proposalGradeCount: entries.length - gated,
    suspectRowCount: list('audit').length,
    grades: [],
  };
}
