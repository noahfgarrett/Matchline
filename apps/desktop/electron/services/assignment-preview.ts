import { applyCapture, captureFromPattern, isCapturePattern } from '@matchline/asset-catalog';

import type {
  WireAssignmentMatch,
  WireAssignmentPreview,
  WireAssignmentValue,
  WireSourceAssignmentRule,
} from '../../shared/schemas.js';

/**
 * Screen 6's source-assignment rules editor: which documents one rule speaks
 * for, before it is saved (P0-8, hard gate 6).
 *
 * The three scopes are matched exactly as `@matchline/asset-catalog` matches
 * them, using that package's own pattern functions rather than a second
 * implementation — `isCapturePattern` decides whether a filename pattern is one
 * the engine will run at all, `captureFromPattern` produces what `$1` means, and
 * `applyCapture` expands it. A preview that agreed with a rule the engine would
 * refuse, or that captured a different substring, would be worse than no
 * preview.
 *
 * What this module adds is the count. "This rule matches `Dragon-*.nwc`" is not
 * a decision anybody can make; "this rule assigns Discipline = Mechanical to
 * 51 of the project's 76 objects" is.
 */

/** One document the rule could speak for, as the session knows it. */
export interface AssignmentDocument {
  readonly sourceId: string;
  /** The short per-source label the rows print. */
  readonly label: string;
  /** The source model's file name, or `''` when the cache attributes none. */
  readonly sourceModelFile: string;
  readonly objectCount: number;
}

/** The fields a rule assigns, in the order the editor lists them. */
function assignedValuesOf(
  rule: WireSourceAssignmentRule,
  capture: string,
): readonly WireAssignmentValue[] {
  const values: WireAssignmentValue[] = [];
  if (rule.assign.building !== '') {
    values.push({ field: 'Building', value: applyCapture(rule.assign.building, capture) });
  }
  if (rule.assign.nativeDiscipline !== '') {
    values.push({
      field: 'Discipline',
      value: applyCapture(rule.assign.nativeDiscipline, capture),
    });
  }
  for (const entry of rule.assign.custom) {
    values.push({ field: entry.key, value: applyCapture(entry.value, capture) });
  }
  return values;
}

/**
 * What one rule would do to this project's documents.
 *
 * A rule that matches nothing is `ready` with an empty `matches` and the list
 * of documents it could have matched, because "your pattern is `Dragon-*.nwd`
 * and every file here ends `.nwc`" is a sentence the editor can only write if
 * it knows both halves. Only a pattern the engine would refuse outright — no
 * `*`, or two — produces a `problem`.
 */
export function buildAssignmentPreview(
  rule: WireSourceAssignmentRule,
  documents: readonly AssignmentDocument[],
  universeObjectCount: number,
): WireAssignmentPreview {
  if (documents.length === 0) {
    return {
      state: 'blocked',
      reason: 'Add a model extraction cache on screen 1 to see which files a rule speaks for.',
    };
  }

  if (rule.match.trim() === '') {
    return {
      state: 'ready',
      matches: [],
      matchedObjectCount: 0,
      universeObjectCount,
      assigned: [],
      problem: 'Type what this rule should match — a file name, a source, or a pattern.',
      candidates: [...candidateNames(rule, documents)],
    };
  }

  if (rule.scope === 'filename-pattern' && !isCapturePattern(rule.match)) {
    return {
      state: 'ready',
      matches: [],
      matchedObjectCount: 0,
      universeObjectCount,
      assigned: [],
      problem:
        'A file-name pattern needs exactly one *. With none it is just an exact name, and with ' +
        'two there is no telling which run of characters $1 means.',
      candidates: [...candidateNames(rule, documents)],
    };
  }

  const matches: WireAssignmentMatch[] = [];
  for (const document of documents) {
    const capture = captureFor(rule, document);
    if (capture === null) {
      continue;
    }
    matches.push({
      sourceId: document.sourceId,
      label: document.label,
      sourceModelFile: document.sourceModelFile,
      objectCount: document.objectCount,
      capture,
    });
  }

  return {
    state: 'ready',
    matches,
    matchedObjectCount: matches.reduce((total, match) => total + match.objectCount, 0),
    universeObjectCount,
    // Expanded against the FIRST match, because `$1` differs per document and a
    // preview that showed the pattern rather than a value would be showing the
    // thing the person already typed.
    assigned: [...assignedValuesOf(rule, matches[0]?.capture ?? '')],
    problem: '',
    candidates: [...candidateNames(rule, documents)],
  };
}

/** What the rule would have to match, for the "nothing hit" case. */
function candidateNames(
  rule: WireSourceAssignmentRule,
  documents: readonly AssignmentDocument[],
): readonly string[] {
  const names = new Set<string>();
  for (const document of documents) {
    names.add(
      rule.scope === 'logical-source'
        ? document.sourceId
        : document.sourceModelFile === ''
          ? document.sourceId
          : document.sourceModelFile,
    );
  }
  return [...names].sort();
}

/**
 * `''` for a plain match, the captured run for a pattern, `null` for a miss.
 *
 * The three scopes read `match` at three different strengths, and P0-8 orders
 * them that way: a source model names one model inside a federated file, a
 * logical source names a registered source by its project id — never a file
 * name, which repeats — and a filename pattern is the confirmed guess.
 */
function captureFor(
  rule: WireSourceAssignmentRule,
  document: AssignmentDocument,
): string | null {
  switch (rule.scope) {
    case 'source-model':
      return document.sourceModelFile === rule.match ? '' : null;
    case 'logical-source':
      return document.sourceId === rule.match ? '' : null;
    case 'filename-pattern':
      return document.sourceModelFile === ''
        ? null
        : captureFromPattern(document.sourceModelFile, rule.match);
    default: {
      const exhaustive: never = rule.scope;
      throw new Error(`Unhandled assignment scope: ${String(exhaustive)}`);
    }
  }
}
