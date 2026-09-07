/**
 * The System Resolver's own input and output shapes (PRODUCT.md §5).
 *
 * Deliberately decoupled: this package takes plain records, not the classes of
 * the packages that happen to produce them today. A subject is "an asset id, a
 * canonical tag and a property bag"; an MEL row is "three optional strings".
 * That keeps the resolver testable on hand-written fixtures and keeps the
 * asset-catalog and spreadsheet-import packages free to change shape.
 */
import type {
  AttributeClaim,
  EvidenceTier,
  NormalizationStep,
  Provenance,
  ReviewItem,
  SystemComponentConfig,
  SystemConflictStatus,
  SystemResolution,
  TagAnatomyConfig,
} from '@matchline/domain';

/** The rungs a chain can be built from (PRODUCT.md §5.2). */
export type SystemComponentKind = SystemComponentConfig['kind'];

/** Which of the two chains a rung belongs to. */
export type ChainName = 'keyChain' | 'descriptionChain';

/**
 * One asset as the resolver sees it.
 *
 * `properties` is nested category -> name -> value, mirroring `PropertyRef`:
 * Navisworks property names repeat across categories, so `Item > Name` and
 * `Revit Type > Name` have to stay addressable as a pair. Nesting two maps is
 * used rather than a joined `"category name"` string key precisely so that no
 * separator or control byte has to be reserved -- a category or property name
 * containing any character at all still round-trips.
 *
 * Values are the property as read: untrimmed, unnormalized. The resolver trims
 * for the blank test and records every further transform (PRODUCT.md §5.5).
 */
export interface ResolverSubject {
  readonly assetId: string;
  /** The tag as canonicalized upstream. MEL tag joins compare against this. */
  readonly canonicalTag: string;
  readonly properties: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * Document this subject was read from, for provenance. When the caller does
   * not state one the claims carry `UNSTATED_SOURCE_FILE`.
   */
  readonly sourceFile?: string;
  /** Model object address, for provenance. Defaults to `assetId`. */
  readonly objectId?: string;
}

/**
 * One pre-parsed MEL row.
 *
 * Every field is optional because a real MEL has ragged rows; a row that
 * states nothing useful is skipped rather than treated as an empty statement.
 * The address fields are what the importer recorded, and are used only to
 * build provenance.
 */
export interface MelCatalogRow {
  readonly equipmentTag?: string;
  readonly systemKey?: string;
  readonly systemDescription?: string;
  readonly sourceFile?: string;
  readonly sheet?: string;
  /** 1-based row number as the importer counted it. */
  readonly row?: number;
}

/** One system as the MEL describes it (PRODUCT.md §5.7). */
export interface SystemCatalogEntry {
  /** First-seen nonblank description. Later disagreements become review items. */
  readonly description?: string;
  /** How many MEL rows named this key, including rows with no description. */
  readonly sourceRowCount: number;
  /**
   * Other raw spellings of this key seen in the MEL -- the same key written
   * with surrounding whitespace. Leading zeros are never an alias: `1` and
   * `001` are different keys until a profile `alias` step says otherwise.
   */
  readonly aliases: ReadonlyArray<string>;
}

/** systemKey -> what the MEL says about it. Insertion order is first-seen order. */
export type SystemCatalog = ReadonlyMap<string, SystemCatalogEntry>;

/** What a person assigned to one asset. Always the final word (PRODUCT.md §4.1). */
export interface ManualAssignment {
  readonly systemKey?: string;
  readonly systemDescription?: string;
  /** Free text recorded on the claim's provenance, e.g. who decided and why. */
  readonly note?: string;
}

/** assetId -> the human's decision for that asset. */
export type ManualAssignments = ReadonlyMap<string, ManualAssignment>;

/** One normalization step and what it did (PRODUCT.md §5.5: never silent). */
export interface TransformRecord {
  readonly step: NormalizationStep;
  readonly from: string;
  readonly to: string;
}

/**
 * A claim with the resolver's own audit fields attached.
 *
 * Structurally an `AttributeClaim`, so it can be handed to a
 * `SystemConflictReviewItem` unchanged, but it also carries the value as the
 * source wrote it plus the transform trail that turned it into
 * `proposedValue`. Losing the raw value would make a leading-zero pad
 * unreviewable, which §5.5 forbids.
 */
export interface SystemClaim extends AttributeClaim {
  readonly attribute: 'systemKey' | 'systemDescription';
  readonly component: SystemComponentKind;
  readonly chain: ChainName;
  /** 0-based position in the configured chain. Provenance carries it 1-based. */
  readonly rungIndex: number;
  /** The value before `config.normalization` ran. */
  readonly rawValue: string;
  /** The value after normalization; identical to `proposedValue`. */
  readonly proposedValue: string;
  /** Every configured step in order, no-ops included. */
  readonly transforms: ReadonlyArray<TransformRecord>;
}

/** Why a rung produced nothing. */
export type SkipReason =
  /** The property, segment, row or manual entry the rung named is not there. */
  | 'no-value'
  /** The rung needs something the caller did not supply (anatomy, rows, catalog). */
  | 'not-configured'
  /** A `mel-lookup` by systemKey with no key resolved by an earlier rung. */
  | 'no-join-key'
  /**
   * A `mel-lookup` by systemKey whose key several distinct MEL spellings reach
   * once `normalization` has run. The rung refuses rather than picks one.
   */
  | 'ambiguous-join'
  /** A composite whose placeholders could not all be filled. */
  | 'placeholder-unfilled'
  /** The value was present but blank once trimmed. */
  | 'blank-value'
  /** An `upn-from-tag` rung whose tag carries no approved UPN at all. */
  | 'no-upn-candidate'
  /**
   * An `upn-from-tag` rung whose tag carries several approved UPNs. The rung
   * refuses rather than takes the first: both are real systems.
   */
  | 'ambiguous-upn'
  /**
   * An `exto-system-name` rung whose UPN is approved but whose description
   * reaches none of the UPN's approved System Names. `candidates` lists them.
   */
  | 'description-mismatch'
  /** An `exto-system-name` rung whose UPN owns no approved System Name. */
  | 'unknown-system';

/**
 * A rung that yielded nothing.
 *
 * Skipped rungs get their own record rather than an empty claim: a claim
 * asserts a value, and a rung that found nothing asserts nothing. The chain
 * position still has to stay visible, which is what this is for.
 */
export interface SkippedRung {
  readonly chain: ChainName;
  readonly rungIndex: number;
  readonly component: SystemComponentKind;
  readonly reason: SkipReason;
  readonly detail: string;
  /**
   * The approved values the rung would have accepted, when it knows them.
   *
   * Only the vocabulary rungs carry this: an `ambiguous-upn` names the UPNs it
   * refused to choose between, a `description-mismatch` names every approved
   * System Name the UPN owns. It is what lets the aggregate `unresolved-system`
   * item tell a person what to write, rather than only that they wrote the
   * wrong thing. Absent everywhere else -- an empty list would claim the rung
   * had looked and found nothing.
   */
  readonly candidates?: ReadonlyArray<string>;
}

/**
 * How much the key-chain rungs agreed.
 *
 * Finer-grained than the domain's `SystemConflictStatus`, which has no way to
 * say "only one rung spoke". `CONFLICT_STATUS_OF` maps these onto the domain
 * vocabulary for `SystemResolution.systemConflictStatus`.
 */
export type KeyAgreement =
  /** Exactly one rung yielded a value. */
  | 'single-source'
  /** Several rungs yielded, all agreeing after normalization. */
  | 'agreement'
  /** Rungs disagreed and `conflictPolicy: 'precedence'` let chain order decide. */
  | 'resolved-by-precedence'
  /** Rungs disagreed and a person had already assigned the answer. */
  | 'manual-override'
  /** Rungs disagreed under `conflictPolicy: 'review'`. A review item was raised. */
  | 'conflict'
  /** No rung yielded anything. `resolution` is null. */
  | 'unresolved';

/**
 * The domain's five-value status is the published shape; these three are the
 * only ones a non-null resolution can carry, because an unresolved subject has
 * no `SystemResolution` at all and nothing here decides by tier alone.
 */
export type ResolvedConflictStatus = Extract<
  SystemConflictStatus,
  'AGREED' | 'RESOLVED_BY_TIER' | 'CONFLICTING'
>;

/** What one subject resolved to, with every losing claim retained. */
export interface SubjectResolution {
  /** Null when no rung yielded a key. Nothing is invented to fill the gap. */
  readonly resolution: SystemResolution | null;
  /** Key claims in chain order, then description claims in chain order. */
  readonly claims: ReadonlyArray<SystemClaim>;
  /** The claim that supplied `resolution.systemKey`. */
  readonly keyClaim: SystemClaim | null;
  /** The claim that supplied `resolution.systemDescription`. */
  readonly descriptionClaim: SystemClaim | null;
  readonly agreement: KeyAgreement;
  readonly skippedRungs: ReadonlyArray<SkippedRung>;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
}

/** Everything the resolver needs beyond the subjects themselves. */
export interface ResolveContext {
  /** Required by `tag-segment` rungs; absent means those rungs are skipped. */
  readonly anatomy?: TagAnatomyConfig;
  /** Built by `buildSystemCatalog`. Consulted by `mel-lookup` on systemKey. */
  readonly catalog?: SystemCatalog;
  /** Needed by `mel-lookup` on equipmentTag, which the catalog cannot answer. */
  readonly melRows?: ReadonlyArray<MelCatalogRow>;
  readonly manual?: ManualAssignments;
}

/** Per-subject resolutions in input order, plus every review item raised. */
export interface ResolveSystemsResult {
  readonly bySubject: ReadonlyMap<string, SubjectResolution>;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
}

/** The catalog plus the disagreements found while building it. */
export interface SystemCatalogResult {
  readonly catalog: SystemCatalog;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
}

/** Internal: a rung's outcome, before it becomes a claim or a skip record. */
export interface RungYield {
  readonly rawValue: string;
  readonly provenance: Provenance;
  readonly evidenceTier: EvidenceTier;
}
