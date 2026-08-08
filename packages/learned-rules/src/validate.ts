/**
 * Structural validation for a rule set arriving from outside the process.
 *
 * A learned rule set is persisted into a Site Profile and read back in a later
 * session, so it crosses a trust boundary the same way an imported spreadsheet
 * does. This guard is the only thing standing between a hand-edited profile
 * and the pairing policy, so it checks shapes AND ranges: a `precision` of 12
 * or a `grade` of `"definitely"` would otherwise turn proposals into claims.
 */
import type { LearnedRuleSet, NestingGrade } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Finite, non-negative -- every number in a rule set is a count or a share. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return isCount(value) && value <= 1;
}

function isGrade(value: unknown): value is NestingGrade {
  return value === 'claim' || value === 'proposal';
}

function every(value: unknown, check: (entry: Record<string, unknown>) => boolean): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && check(entry));
}

export function validateLearnedRuleSet(value: unknown): value is LearnedRuleSet {
  if (!isRecord(value)) return false;
  if (value['version'] !== 1) return false;

  const trainedFrom = value['trainedFrom'];
  if (!isRecord(trainedFrom)) return false;
  if (!isCount(trainedFrom['rowCount']) || !isString(trainedFrom['label'])) return false;

  const classification = every(
    value['classification'],
    (entry) =>
      isString(entry['discipline']) &&
      isString(entry['pattern']) &&
      isString(entry['class']) &&
      isRate(entry['confidence']) &&
      isCount(entry['sampleCount']),
  );
  if (!classification) return false;

  const roleGates = every(
    value['roleGates'],
    (entry) =>
      isString(entry['class']) &&
      isCount(entry['asParent']) &&
      isCount(entry['asChild']) &&
      isRate(entry['parentRate']) &&
      typeof entry['isChildOnly'] === 'boolean' &&
      typeof entry['isParentCapable'] === 'boolean',
  );
  if (!roleGates) return false;

  const affinities = every(
    value['affinities'],
    (entry) =>
      isString(entry['childClass']) &&
      isString(entry['parentClass']) &&
      isCount(entry['observations']),
  );
  if (!affinities) return false;

  return every(
    value['grades'],
    (entry) =>
      isString(entry['class']) &&
      isCount(entry['predicted']) &&
      isCount(entry['correct']) &&
      isRate(entry['precision']) &&
      isGrade(entry['grade']),
  );
}
