/**
 * Structural validation for an item-master table arriving from outside the
 * process.
 *
 * The table is persisted into a Site Profile and read back in a later session,
 * so it crosses a trust boundary the same way an imported spreadsheet does —
 * the same argument `@matchline/learned-rules/src/validate.ts` makes for its
 * rule set. This guard is the only thing between a hand-edited profile and the
 * 0.9 gate, so it checks shapes AND ranges: a `confidence` of 12, or a `rung` of
 * `"definitely"`, would otherwise turn every proposal into an assignment.
 */

import type { ItemMasterRung, ItemMasterTable, SuspectRowReason } from './itemmasters.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Finite, non-negative — every number in the table is a count or a share. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return isCount(value) && value <= 1;
}

function isRung(value: unknown): value is ItemMasterRung {
  return value === 'class' || value === 'description';
}

function isSuspectReason(value: unknown): value is SuspectRowReason {
  return (
    value === 'blank-item-master' ||
    value === 'placeholder-item-master' ||
    value === 'electrical-gear-on-non-electrical'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function every(value: unknown, check: (entry: Record<string, unknown>) => boolean): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && check(entry));
}

export function validateItemMasterTable(value: unknown): value is ItemMasterTable {
  if (!isRecord(value)) return false;
  if (value['version'] !== 1) return false;
  if (!isStringArray(value['vocabulary'])) return false;

  const trainedFrom = value['trainedFrom'];
  if (!isRecord(trainedFrom)) return false;
  if (!isCount(trainedFrom['rowCount']) || !isString(trainedFrom['label'])) return false;

  const entries = every(
    value['entries'],
    (entry) =>
      isRung(entry['rung']) &&
      isString(entry['discipline']) &&
      isString(entry['equipmentClass']) &&
      isString(entry['systemKey']) &&
      isString(entry['descriptionWord']) &&
      isString(entry['itemMaster']) &&
      isRate(entry['confidence']) &&
      isCount(entry['sampleCount']) &&
      isStringArray(entry['candidates']),
  );
  if (!entries) return false;

  return every(
    value['audit'],
    (entry) =>
      isString(entry['equipmentId']) &&
      isString(entry['itemMaster']) &&
      isString(entry['discipline']) &&
      isSuspectReason(entry['reason']) &&
      isString(entry['detail']),
  );
}
