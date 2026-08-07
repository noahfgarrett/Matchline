import type { RelationshipClaim } from './claims.js';
import type { EvidenceTier } from './evidence.js';
import type { Provenance } from './provenance.js';
import type { RelationshipType } from './relationship.js';
import type { SystemResolution } from './system.js';

/**
 * What the set of sources, taken together, says about an asset's identity.
 *
 * An asset carries every status that applies, so "the model and the MEL both
 * have it" and "its tag is duplicated" are recorded side by side rather than
 * collapsing into one verdict.
 */
export type SourceStatus =
  | 'MODEL_CONFIRMED'
  | 'MODEL_ONLY'
  | 'FLOW_ONLY'
  | 'PMD_ONLY'
  | 'MEL_ONLY'
  | 'DUPLICATE_MODEL_TAG'
  | 'UNRESOLVED_IDENTITY'
  | 'MODEL_CONFLICT';

/** How far an asset has got through human review. */
export type ReviewStatus = 'UNREVIEWED' | 'ACCEPTED' | 'FLAGGED' | 'OVERRIDDEN';

/** Where the asset sits physically. Absent means no source stated it. */
export interface HierarchyAttributes {
  readonly building?: string;
  readonly level?: string;
  readonly area?: string;
}

/** A pointer back to the object in the model this asset was matched to. */
export interface ModelObjectReference {
  readonly modelFile: string;
  readonly objectId: string;
  readonly category?: string;
}

/** The winning parent claim, after reconciliation picked between candidates. */
export interface ResolvedParent {
  readonly parentAssetId: string;
  readonly relationshipType: RelationshipType;
  readonly evidenceTier: EvidenceTier;
  readonly provenance: Provenance;
}

/**
 * One asset in the compiled register: the reconciled answer for a single
 * physical thing, assembled from every source that mentioned it.
 */
export interface CanonicalAsset {
  /** Stable internal identity. Survives a tag being corrected. */
  readonly assetId: string;
  /** The tag the project should use, after canonicalization. */
  readonly canonicalTag: string;
  /** Other spellings seen in sources, kept so old documents still resolve. */
  readonly aliases: ReadonlyArray<string>;
  readonly description: string;
  readonly equipmentType: string;
  /** Discipline as the source named it. */
  readonly nativeDiscipline: string;
  /** Discipline after mapping onto the standard set. */
  readonly ssmDiscipline: string;
  readonly system: SystemResolution;
  readonly hierarchyAttributes: HierarchyAttributes;
  readonly modelObjectReferences: ReadonlyArray<ModelObjectReference>;
  readonly sourceStatuses: ReadonlyArray<SourceStatus>;
  /**
   * `null` means resolved to the root -- the asset genuinely has no parent.
   * That is a decision, not a gap, which is why this is never absent.
   */
  readonly resolvedParent: ResolvedParent | null;
  /** Relations that order commissioning work but never nest the asset. */
  readonly dependencies: ReadonlyArray<RelationshipClaim>;
  readonly provenance: ReadonlyArray<Provenance>;
  readonly reviewStatus: ReviewStatus;
}
