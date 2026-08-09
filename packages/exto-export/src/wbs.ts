/**
 * The learned WBS table: a work-breakdown code per System Key.
 *
 * ## Why this rung and no other
 *
 * The item-master table next door keys on two rungs — `(discipline, class, UPN)`
 * and `(discipline, UPN, description word)` — because an item master describes a
 * *piece of equipment*, and two pieces of equipment in one system can honestly
 * want different masters.
 *
 * A WBS code does not describe equipment. It describes the system the equipment
 * is being commissioned under, so the only thing it can honestly be a function
 * of is the System Key (PRODUCT.md §2.3, "System Key = UPN"). That was measured
 * before it was written: on a real hand-built registry, keying on the System Key
 * alone put 99.99% of rows under their key's dominant code, and every key cleared
 * the 0.9 gate. Richer keys — adding the discipline, or the classification —
 * only split those keys into smaller ones that agree with each other, which is
 * overfitting: more entries, no more knowledge, and a lookup that starts missing
 * whenever a compile spells a discipline differently from the registry.
 *
 * So: one rung, keyed on the System Key, and the table says so in its shape
 * rather than in a comment somebody could ignore.
 *
 * ## Everything else is the item-master table's discipline, deliberately
 *
 * Same majority vote, same {@link WBS_MIN_CONFIDENCE} gate, same
 * "below the gate is a proposal, never a guess", same plain-array serialization
 * so the table persists in a project file as JSON with no Maps and no
 * `undefined` fields. A reviewer who has read `itemmasters.ts` already knows how
 * to read this, and that is worth more than any cleverness available here.
 *
 * Codes are stored exactly as the registry spelled them. A WBS code is text —
 * `'0110'` is not the number 110 — so nothing here parses one, pads one, or
 * compares two numerically.
 */

import { clean, compareCodeUnits, normalizePart, round } from './text.js';

/**
 * The gate, matching the item-master table's.
 *
 * Not a parameter with a default, for the same reason: the gate is the reason
 * this layer is trusted to write a cell at all, and a caller that could lower it
 * could turn every proposal into an assignment.
 */
export const WBS_MIN_CONFIDENCE = 0.9;

/** How many candidates a below-gate proposal carries. */
export const WBS_PROPOSAL_CANDIDATES = 3;

/** One row of a prior registry export, as this layer reads it. */
export interface WbsTrainingRow {
  /** Registry "UPN". */
  readonly systemKey: string;
  /** Registry "WBS", verbatim. */
  readonly wbs: string;
}

/** One learned key: the dominant code behind it and how dominant it was. */
export interface WbsEntry {
  /** Normalized system key (UPN) — the whole of the key. */
  readonly systemKey: string;
  /** The dominant code, spelled as the registry spelled it. */
  readonly wbs: string;
  /** `topCount / total`, 4dp — the number the gate reads. */
  readonly confidence: number;
  /** Rows behind the key, across all codes. */
  readonly sampleCount: number;
  /**
   * Up to {@link WBS_PROPOSAL_CANDIDATES} codes, most-voted first. What a
   * below-gate key offers a reviewer instead of an answer.
   */
  readonly candidates: ReadonlyArray<string>;
}

/** The serializable artifact of one training run. Persists in a project file. */
export interface WbsTable {
  readonly version: 1;
  /** Learned keys, in system-key order. */
  readonly entries: ReadonlyArray<WbsEntry>;
  readonly trainedFrom: { readonly rowCount: number; readonly label: string };
}

/** Options for {@link trainWbsTable}. */
export interface TrainWbsOptions {
  /** Free text naming the training source, for the review UI. */
  readonly label?: string;
}

/**
 * The outcome of querying the table for one system key.
 *
 * A discriminated union rather than `string | null`, for the reason
 * `ItemMasterAssignment` is one: "no answer" comes in two flavors a review
 * queue must tell apart — a key the registry disagreed about (`proposal`, with
 * candidates to choose between) and a key it never saw (`unmatched`, which no
 * amount of reviewing this table will settle).
 */
export type WbsAssignment =
  | {
      readonly kind: 'assigned';
      readonly systemKey: string;
      readonly wbs: string;
      readonly rule: string;
      readonly confidence: number;
      readonly sampleCount: number;
    }
  | {
      readonly kind: 'proposal';
      readonly systemKey: string;
      readonly candidates: ReadonlyArray<string>;
      readonly rule: string;
      readonly confidence: number;
      readonly sampleCount: number;
    }
  | {
      readonly kind: 'unmatched';
      readonly systemKey: string;
      readonly reason: 'no-system-key' | 'no-learned-key';
    };

/* -------------------------------------------------------------------------- */
/* Training                                                                   */
/* -------------------------------------------------------------------------- */

/** One key's votes while training. */
interface Tally {
  readonly systemKey: string;
  readonly counts: Map<string, number>;
  total: number;
}

/**
 * Train the learned table from prior registry rows.
 *
 * Pure and total: no row is rejected outright, and the same rows always yield
 * the same table in the same order. A row with no system key, or no code, simply
 * teaches nothing — there is no key to file it under, or no answer to file.
 * An empty registry yields an empty table, which assigns nothing and proposes
 * nothing.
 */
export function trainWbsTable(
  rows: ReadonlyArray<WbsTrainingRow>,
  options: TrainWbsOptions = {},
): WbsTable {
  const tallies = new Map<string, Tally>();

  for (const row of rows) {
    const systemKey = normalizePart(row.systemKey);
    if (systemKey === '') continue;
    const wbs = clean(row.wbs);
    if (wbs === '') continue;

    let tally = tallies.get(systemKey);
    if (tally === undefined) {
      tally = { systemKey, counts: new Map(), total: 0 };
      tallies.set(systemKey, tally);
    }
    tally.counts.set(wbs, (tally.counts.get(wbs) ?? 0) + 1);
    tally.total += 1;
  }

  return {
    version: 1,
    entries: [...tallies.values()]
      .map(toEntry)
      .sort((a, b) => compareCodeUnits(a.systemKey, b.systemKey)),
    trainedFrom: { rowCount: rows.length, label: options.label ?? '' },
  };
}

function toEntry(tally: Tally): WbsEntry {
  /* Count descending, then code by code unit — a stable rule, so the serialized
     table is identical no matter which order the registry rows arrived in. */
  const ranked = [...tally.counts.entries()].sort(
    (a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]),
  );
  const top = ranked[0];
  return {
    systemKey: tally.systemKey,
    wbs: top?.[0] ?? '',
    confidence: round(tally.total === 0 ? 0 : (top?.[1] ?? 0) / tally.total, 4),
    sampleCount: tally.total,
    candidates: ranked.slice(0, WBS_PROPOSAL_CANDIDATES).map(([code]) => code),
  };
}

/* -------------------------------------------------------------------------- */
/* Assignment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-table lookup index, built once and reused.
 *
 * A `WeakMap` keyed on the table, exactly as `itemmasters.ts` does it: a table
 * read out of a project file is indexed once and released when the file is, and
 * {@link assignWbs} keeps the single-key signature the caller wants.
 */
const INDEXES = new WeakMap<WbsTable, ReadonlyMap<string, WbsEntry>>();

function indexOf(table: WbsTable): ReadonlyMap<string, WbsEntry> {
  const existing = INDEXES.get(table);
  if (existing !== undefined) return existing;
  const index = new Map<string, WbsEntry>();
  for (const entry of table.entries) {
    /* First wins, so a hand-edited table that repeats a key behaves the same way
       a scan over the array would. */
    if (!index.has(entry.systemKey)) index.set(entry.systemKey, entry);
  }
  INDEXES.set(table, index);
  return index;
}

/** Assign one system's WBS code, or say why it could not be assigned. */
export function assignWbs(table: WbsTable, systemKey: string | undefined): WbsAssignment {
  const key = normalizePart(systemKey);
  if (key === '') return { kind: 'unmatched', systemKey: '', reason: 'no-system-key' };

  const entry = indexOf(table).get(key);
  if (entry === undefined) return { kind: 'unmatched', systemKey: key, reason: 'no-learned-key' };

  const rule = `learned from registry: UPN ${entry.systemKey}`;
  if (entry.confidence >= WBS_MIN_CONFIDENCE) {
    return {
      kind: 'assigned',
      systemKey: key,
      wbs: entry.wbs,
      rule,
      confidence: entry.confidence,
      sampleCount: entry.sampleCount,
    };
  }
  return {
    kind: 'proposal',
    systemKey: key,
    candidates: entry.candidates,
    rule,
    confidence: entry.confidence,
    sampleCount: entry.sampleCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Structural validation for a table arriving from outside the process.
 *
 * The table persists in a project file and is read back in a later session, so
 * it crosses a trust boundary the same way an imported spreadsheet does. This
 * guard is the only thing between a hand-edited file and the 0.9 gate, so it
 * checks ranges as well as shapes: a `confidence` of 12 would otherwise turn
 * every proposal into an assignment.
 */
export function validateWbsTable(value: unknown): value is WbsTable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1) return false;

  const trainedFrom = record['trainedFrom'];
  if (typeof trainedFrom !== 'object' || trainedFrom === null || Array.isArray(trainedFrom)) {
    return false;
  }
  const from = trainedFrom as Record<string, unknown>;
  if (!isCount(from['rowCount']) || typeof from['label'] !== 'string') return false;

  const entries = record['entries'];
  if (!Array.isArray(entries)) return false;
  return entries.every((entry: unknown): boolean => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    return (
      typeof row['systemKey'] === 'string' &&
      typeof row['wbs'] === 'string' &&
      isRate(row['confidence']) &&
      isCount(row['sampleCount']) &&
      Array.isArray(row['candidates']) &&
      row['candidates'].every((candidate: unknown): boolean => typeof candidate === 'string')
    );
  });
}

/** Finite, non-negative — every number in the table is a count or a share. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return isCount(value) && value <= 1;
}
