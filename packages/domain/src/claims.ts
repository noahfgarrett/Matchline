import type { EvidenceTier, SourceKind } from './evidence.js';
import type { Provenance } from './provenance.js';
import type { RelationshipKind, RelationshipType } from './relationship.js';

/**
 * Values arrive from spreadsheets and model properties, so they are text far
 * more often than not. `null` is a real answer -- it means the source stated
 * the field was empty, which is different from the source never mentioning it.
 */
export type AttributeValue = string | number | boolean | null;

/**
 * One row or model object as it was read, before any reconciliation.
 *
 * Attributes are kept raw and unnormalized here; normalization happens on the
 * way to claims, so the untouched reading stays available for review.
 */
export interface SourceObservation {
  readonly observationId: string;
  readonly source: SourceKind;
  /** The tag exactly as written in the source, before canonicalization. */
  readonly rawTag: string;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly provenance: Provenance;
}

/** A source's proposal for one field of one asset. Proposals, not decisions. */
export interface AttributeClaim {
  readonly subjectAssetId: string;
  readonly attribute: string;
  readonly proposedValue: AttributeValue;
  readonly source: SourceKind;
  readonly rule: string;
  readonly evidenceTier: EvidenceTier;
  readonly provenance: Provenance;
}

/** A source's proposal that two assets are related. */
export interface RelationshipClaim {
  readonly subjectAssetId: string;
  readonly targetAssetId: string;
  readonly kind: RelationshipKind;
  readonly relationshipType: RelationshipType;
  readonly source: SourceKind;
  readonly rule: string;
  readonly evidenceTier: EvidenceTier;
  readonly provenance: Provenance;
}
