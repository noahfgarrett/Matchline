/**
 * The vocabulary this package produces.
 *
 * Everything here is data about *what a workbook said*, never a decision about
 * what is true. Two cables between the same pair of tags are two observations;
 * an EasyPower row and a Cable Schedule row that agree are two observations.
 * Reconciliation, deduplication, and identity matching all happen downstream —
 * this package's job is to read three document families faithfully and address
 * every fact it produces back to the cell it came from (PRODUCT.md §8.4).
 */

import type {
  ConnectivityObservation as DomainConnectivityObservation,
  Provenance,
  RelationshipType,
} from '@matchline/domain';

/* ---- sheet kinds ---- */

/**
 * The document families this package can recognize.
 *
 * `'mel'` is recognized but never imported here: a MEL carries equipment
 * identity, not connectivity (PRODUCT.md §2.1/§2.2), and it is read by
 * `@matchline/spreadsheet-import`'s `readMelTable`. It is in the union so that
 * a MEL tab inside a connectivity workbook is *classified* rather than left to
 * masquerade as one of the connectivity kinds.
 */
export type SheetKind = 'easypower' | 'cable-schedule' | 'pmd' | 'mel' | 'unknown';

/** The three kinds that yield connectivity observations. */
export type ConnectivitySourceKind = 'easypower' | 'cable-schedule' | 'pmd';

/**
 * How sure the detector is, and on what grounds.
 *
 * - `name` — the sheet name identified the kind (the donor checks names first).
 * - `exact-headers` — every required header matched a known exact form, which
 *   is trusted on its own.
 * - `corroborated` — at least one required header matched only a loose form, so
 *   a second column had to agree before the kind was accepted.
 * - `none` — nothing matched; the kind is `'unknown'`.
 */
export type DetectionConfidence = 'name' | 'exact-headers' | 'corroborated' | 'none';

/** What {@link detectSheetKind} concluded about one sheet. */
export interface SheetDetection {
  readonly kind: SheetKind;
  readonly confidence: DetectionConfidence;
  /**
   * Zero-based AoA row holding the headers, or `-1` when no header row was
   * found. A `-1` with a recognized `kind` means the sheet *name* claimed the
   * kind but its headers did not back that up: the sheet is reported, never
   * imported on a guess.
   */
  readonly headerRow: number;
  /**
   * Zero-based column indices by role. Roles are per-kind: `source`/`load` for
   * EasyPower, `from`/`to`/`cableTag`/… for Cable Schedule, `panel`/
   * `instrument`/… for PMD, `equipmentTag`/`upn`/… for MEL. Only columns that
   * were actually found appear.
   */
  readonly mappedColumns: Readonly<Record<string, number>>;
}

/** One sheet of a workbook, with what detection made of it. */
export interface SheetDetectionResult {
  readonly sheet: string;
  readonly detection: SheetDetection;
}

/* ---- observations ---- */

/**
 * What a connectivity observation is about.
 *
 * `feed` is a power path — one asset energizes another. `pmd-relation` is a
 * control/monitoring path — a panel owns an instrument point. They are separate
 * because §11 folds them differently: a feed can nest, a control relation is a
 * dependency (`relationshipKindOf` in `@matchline/domain`).
 */
export type ConnectivityKind = 'feed' | 'pmd-relation';

/**
 * The cells this observation was read from.
 *
 * The domain's `Provenance` already answers three of PRODUCT.md §8.4's
 * questions — which file, and which sheet and row via its `sheet-row`
 * `SourceRef` — so this extends it rather than restating it. The fourth,
 * *which columns*, needs more than `propertyOrColumn` can hold: a relationship
 * is read from two or three cells at once, and an engineer sent back to check
 * it needs all of them.
 *
 * The one-based `row` inside `sourceRef` is the true worksheet row when the
 * caller supplied `rowNums` from `sheetAoa`, and the one-based index within the
 * supplied AoA otherwise. See {@link ObservationSource}.
 */
export interface ConnectivityProvenance extends Provenance {
  /** Zero-based column the `fromTag` was read from. */
  readonly fromColumn: number;
  /** Zero-based column the `toTag` was read from. */
  readonly toColumn: number;
  /** Zero-based column the `via` value was read from, when there is one. */
  readonly viaColumn?: number;
}

/**
 * One relationship, exactly as one source document stated it — the domain's
 * observation, narrowed to carry column-level provenance (a relationship is
 * read from two or three cells; see {@link ConnectivityProvenance}).
 */
export interface ConnectivityObservation extends DomainConnectivityObservation {
  readonly provenance: ConnectivityProvenance;
}

/* ---- skips and stats ---- */

/**
 * Why a row produced no observation.
 *
 * Checked in this order, so a row missing both ends reports `missing-from`:
 * a partial row is a partial row, and reporting one reason per row keeps the
 * skip list countable against `rowCount`.
 */
export type SkipReason = 'missing-from' | 'missing-to' | 'self-loop';

/** One row that was read and deliberately not turned into an observation. */
export interface SkippedRow {
  /** One-based row number, addressed the same way as {@link ConnectivityProvenance.row}. */
  readonly row: number;
  readonly reason: SkipReason;
  /** The upstream cell as read (trimmed). Empty when that is why it was skipped. */
  readonly fromTag: string;
  /** The downstream cell as read (trimmed). */
  readonly toTag: string;
}

/**
 * What one sheet contained.
 *
 * `rowCount = observationCount + skipped.length` always holds, so a reviewer
 * can see that no row was quietly dropped.
 */
export interface ImportStats {
  /** Data rows below the header row, blank ones included. */
  readonly rowCount: number;
  readonly observationCount: number;
  /** Skips by reason. Every reason is present, zero included. */
  readonly skippedCount: Readonly<Record<SkipReason, number>>;
  /**
   * Distinct upstream tags among the *kept* observations, compared as exact
   * strings. No case folding and no tag normalization: those are the identity
   * package's job, and folding here would understate what the document says.
   */
  readonly distinctFromTags: number;
  /** Distinct downstream tags among the kept observations, same comparison. */
  readonly distinctToTags: number;
}

/** The result of importing one sheet. */
export interface SheetImportResult {
  readonly observations: ReadonlyArray<ConnectivityObservation>;
  readonly stats: ImportStats;
  readonly skipped: ReadonlyArray<SkippedRow>;
}

/* ---- importer inputs ---- */

/**
 * Where the rows being imported came from, and how to number them.
 *
 * `sheet` is separate from `sourceFile` because provenance has to answer both
 * questions, and a workbook's tabs are not files.
 */
export interface ObservationSource {
  readonly sourceFile: string;
  readonly sheet: string;
  /**
   * `rowNums[i]` is the zero-based worksheet row that produced `aoa[i]`, as
   * returned by `sheetAoa`. Supply it whenever the AoA came from a real
   * workbook: `sheetAoa` drops rows that held no cells at all, so without it a
   * provenance row can point at the wrong line of the engineer's spreadsheet.
   * Omit it when the AoA is literal and index `i` *is* row `i`.
   */
  readonly rowNums?: readonly number[];
}

/** Columns an EasyPower sheet is read through. */
export interface EasyPowerMapping {
  /** Zero-based column holding the upstream bus / starting source. */
  readonly source: number;
  /** Zero-based column holding the downstream load's tag. */
  readonly load: number;
}

/** Columns a Cable Schedule is read through. */
export interface CableMapping {
  /** Zero-based column holding the feeding panel. */
  readonly from: number;
  /** Zero-based column holding the fed load. */
  readonly to: number;
  /** Zero-based column holding the cable tag, when the sheet has one. */
  readonly cableTag?: number;
}

/** Columns a PMD sheet is read through. */
export interface PmdMapping {
  /** Zero-based column holding the owning panel. */
  readonly panel: number;
  /** Zero-based column holding the instrument or point tag. */
  readonly instrument: number;
}
