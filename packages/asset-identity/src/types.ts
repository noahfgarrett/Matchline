/**
 * The asset identity ledger (RELEASE-1.0-PLAN P0-9).
 *
 * An asset id has to outlive the facts it was first derived from. A tag typo is
 * corrected, a model is rebuilt under a new content hash, an object is moved in
 * the tree -- none of those is a different piece of equipment, and every manual
 * system, relationship and review decision a person recorded is addressed to an
 * id. So the project keeps a ledger: which id belongs to which physical thing,
 * what that thing is called now, what it used to be called, and the model
 * evidence that ties the two compiles together.
 *
 * Types only; {@link reconcileLedger} in `reconcile.ts` is the one function that
 * moves a ledger forward, and `keys.ts` is the one place a stable key is spelled.
 */

/**
 * The identity evidence order P0-9 binds, strongest first.
 *
 * - `stable-id-property` -- a value the site's profile maps as the stable id.
 *   The only tier that is not scoped to a model file: a site-wide asset number
 *   follows the equipment when it moves between documents, which is the whole
 *   reason a site maintains one.
 * - `authoring-id` -- the source model's persistent id plus the authoring
 *   application's own object id (`objects.authoring_id`).
 * - `instance-guid` -- the source model's persistent id plus the Navisworks
 *   InstanceGuid (`objects.instance_guid`).
 * - `structural` -- the source model's persistent id, the object's
 *   root-relative child-index path, and its class name. Derived from the shape
 *   of the tree and never from content, so a re-extraction of an unchanged
 *   model under a new content hash produces the same key.
 * - `tag` -- the canonical tag. Reconciliation only: it is the field most
 *   likely to be corrected, so it can never be the reason two compiles agree
 *   when a stronger tier disagreed. A match here is reported as its own event.
 *
 * The order is load-bearing: {@link reconcileLedger} walks it and takes the
 * first tier that names exactly one previous entry.
 */
export type StableKeyTier =
  | 'stable-id-property'
  | 'authoring-id'
  | 'instance-guid'
  | 'structural'
  | 'tag';

/** Every {@link StableKeyTier} in evidence order, for callers that walk it. */
export const STABLE_KEY_TIER_ORDER = [
  'stable-id-property',
  'authoring-id',
  'instance-guid',
  'structural',
  'tag',
] as const satisfies ReadonlyArray<StableKeyTier>;

/**
 * Compile-time completeness guard. Adding a member to {@link StableKeyTier}
 * without adding it to {@link STABLE_KEY_TIER_ORDER} resolves this to `false`
 * and the assignment below stops compiling.
 */
type EveryTierListed =
  Exclude<StableKeyTier, (typeof STABLE_KEY_TIER_ORDER)[number]> extends never ? true : false;

const TIERS_ARE_COMPLETE: EveryTierListed = true;
void TIERS_ARE_COMPLETE;

/**
 * One way of naming one model object, durably.
 *
 * `stableObjectKey` is the whole matching key: the model tiers already embed
 * the *source model's* persistent id (P0-9's "source persistent id"), so an
 * NWD re-registered under a different project `sourceId` keeps its identity.
 * `logicalSourceId` is recorded rather than matched on -- it says which
 * registered source last carried the object, which is what a reviewer needs in
 * order to go and look at it.
 */
export interface StableModelObjectIdentity {
  /** The project source the object was last read from. Provenance, not a key. */
  readonly logicalSourceId: string;
  /** Injectively escaped and prefixed by its tier. Compared verbatim. */
  readonly stableObjectKey: string;
  /** Which rung of the evidence order produced {@link stableObjectKey}. */
  readonly tier: StableKeyTier;
}

/** Whether the ledger saw this asset in the compile that last wrote the ledger. */
export type LedgerEntryStatus = 'present' | 'disappeared';

/**
 * One physical thing, and the id it keeps.
 *
 * A `disappeared` entry is never deleted. A source that was not registered for
 * one compile, a filter tightened by mistake, a model handed over late -- all of
 * them make an asset vanish, and dropping the entry would throw away the id
 * every stored decision about that asset is addressed to.
 */
export interface AssetLedgerEntry {
  /** Project-scoped and permanent. Never re-derived once minted. */
  readonly assetId: string;
  /** The tag the latest compile read. `''` for an untagged asset. */
  readonly currentCanonicalTag: string;
  /**
   * Every earlier spelling, oldest first. Never contains
   * {@link currentCanonicalTag}, and never the empty string.
   */
  readonly aliases: ReadonlyArray<string>;
  /** The identities of the latest compile's representative object, strongest first. */
  readonly modelIdentities: ReadonlyArray<StableModelObjectIdentity>;
  readonly status: LedgerEntryStatus;
}

/** The version {@link reconcileLedger} writes. Bumped when the shape changes. */
export const ASSET_LEDGER_FORMAT_VERSION = 1;

/**
 * The whole ledger, as the project persists it.
 *
 * Plain JSON on purpose -- no `Map`, no `Set`, no `undefined` -- because the
 * project store round-trips it through `JSON.stringify`.
 */
export interface AssetLedger {
  readonly formatVersion: typeof ASSET_LEDGER_FORMAT_VERSION;
  /** Previously known entries in their existing order, then newly minted ones. */
  readonly entries: ReadonlyArray<AssetLedgerEntry>;
  /** The next ordinal {@link mintAssetId} will try. Only ever grows. */
  readonly nextOrdinal: number;
}

/** A project that has never been compiled. */
export const EMPTY_ASSET_LEDGER: AssetLedger = {
  formatVersion: ASSET_LEDGER_FORMAT_VERSION,
  entries: [],
  nextOrdinal: 1,
};

/**
 * What one compile knows about one model object's durable identity.
 *
 * Gathered by the caller, because reading a cache is not this package's job:
 * `@matchline/asset-catalog` publishes the model half on every `ModelAsset` and
 * `@matchline/compiler` adds the profile-mapped stable id it read through the
 * property-bag seam.
 */
export interface ModelObjectIdentityEvidence {
  /** The project source id the object was read under. */
  readonly logicalSourceId: string;
  /**
   * The persistent id of the object's source model -- `source_models.guid`,
   * else its file name. `null` when the cache states neither, in which case the
   * logical source id stands in so the key is still addressable.
   */
  readonly sourceModelPersistentId: string | null;
  readonly authoringId: string | null;
  readonly instanceGuid: string | null;
  /**
   * Sibling positions from the root of the object's own tree down to the object
   * itself (`objects.path_index`). Empty only for an object the cache does not
   * place.
   */
  readonly structuralPath: ReadonlyArray<number>;
  readonly className: string | null;
  /** The profile-mapped stable id, when the site maps one and the object has it. */
  readonly stableIdPropertyValue?: string;
  /** The asset's canonical tag. `''` when the asset is untagged. */
  readonly canonicalTag: string;
}

/** One of this compile's assets, as the ledger reads it. */
export interface LedgerCandidate {
  /**
   * The id this compile's catalog minted. Only a within-compile handle: the
   * result's `mapping` translates it to the ledger id every stage keys on.
   */
  readonly assetId: string;
  readonly canonicalTag: string;
  /** Strongest tier first, tiers with no evidence omitted. */
  readonly identities: ReadonlyArray<StableModelObjectIdentity>;
}

/**
 * What reconciliation did to one asset. Everything except a silent re-match at
 * a model tier, which is the ordinary case and says nothing.
 *
 * - `new-asset` -- no previous entry claimed it; an id was minted.
 * - `tag-changed` -- a model tier matched a previous entry whose tag differs.
 *   The old spelling became an alias and the id did not move.
 * - `rematched-by-tag` -- no model tier matched, and the tag did. The weakest
 *   possible reason for two compiles to agree, so it is always reported.
 * - `disappeared` -- a previous entry no candidate claimed. Kept, flagged.
 * - `split` -- one previous entry's evidence now names several assets. One
 *   keeps the id, the rest are new, and nothing is merged.
 */
export type LedgerEventKind =
  | 'new-asset'
  | 'tag-changed'
  | 'rematched-by-tag'
  | 'split'
  | 'disappeared';

/** Every {@link LedgerEventKind}, in the order events are reported. */
export const LEDGER_EVENT_KIND_ORDER = [
  'new-asset',
  'tag-changed',
  'rematched-by-tag',
  'split',
  'disappeared',
] as const satisfies ReadonlyArray<LedgerEventKind>;

/** Compile-time completeness guard, as above. */
type EveryEventKindListed =
  Exclude<LedgerEventKind, (typeof LEDGER_EVENT_KIND_ORDER)[number]> extends never ? true : false;

const EVENT_KINDS_ARE_COMPLETE: EveryEventKindListed = true;
void EVENT_KINDS_ARE_COMPLETE;

/** One thing reconciliation did, in reviewable words. */
export interface LedgerEvent {
  readonly kind: LedgerEventKind;
  /** The ledger id the event is about. */
  readonly assetId: string;
  /** That asset's tag after this compile. `''` when untagged. */
  readonly canonicalTag: string;
  /** `tag-changed` only: the spelling that became an alias. */
  readonly previousCanonicalTag?: string;
  /** Which tier tied this compile to the previous ledger. Absent for `new-asset`. */
  readonly tier?: StableKeyTier;
  /** `split` only: the ids minted for the assets that did not keep the entry. */
  readonly siblingAssetIds?: ReadonlyArray<string>;
  /** One line a person can read, for the review queue and the compile log. */
  readonly detail: string;
}

/** A ledger moved forward by one compile. */
export interface ReconcileLedgerResult {
  readonly ledger: AssetLedger;
  /** Catalog asset id -> ledger asset id. One entry per candidate. */
  readonly mapping: ReadonlyMap<string, string>;
  /** Ordered by event kind, then by asset id. Never carries a no-op. */
  readonly events: ReadonlyArray<LedgerEvent>;
}
