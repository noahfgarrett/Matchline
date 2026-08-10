/**
 * Stable object keys: the one place P0-9's evidence order is spelled.
 *
 * Every key is `<tier>/<component>/…` with each component percent-escaped by
 * `@matchline/domain`'s `escapeSourceId` -- borrowed rather than restated,
 * because that escape is already the project's injective "this string is going
 * inside a composed id" rule (`%` first, then `/` and `#`). Injective escaping
 * is what stops a GUID containing a slash from spelling another object's key.
 *
 * Content never enters a key. No content hash, no property value other than the
 * one the site explicitly nominated as its stable id, no bounding box: a model
 * re-extracted from an unchanged file under a new `input_sha256` has to produce
 * the same keys, or a re-extraction would look like a site rebuild.
 */
import { escapeSourceId } from '@matchline/domain';

import type { ModelObjectIdentityEvidence, StableKeyTier, StableModelObjectIdentity } from './types.js';

/** A blank string is not a value: an extractor writes one where it read nothing. */
function meaningful(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * What the model tiers scope their keys to.
 *
 * The source model's own persistent id, so re-registering the same file under a
 * different project source id is not a new asset. A cache that states neither a
 * model GUID nor a file name falls back to the logical source id -- an
 * unscoped authoring id or child-index path would otherwise be free to collide
 * with another file's.
 */
function modelScope(evidence: ModelObjectIdentityEvidence): string {
  const persistent = meaningful(evidence.sourceModelPersistentId);
  return persistent === null
    ? `source:${escapeSourceId(evidence.logicalSourceId)}`
    : escapeSourceId(persistent);
}

function identity(
  tier: StableKeyTier,
  logicalSourceId: string,
  stableObjectKey: string,
): StableModelObjectIdentity {
  return { logicalSourceId, stableObjectKey, tier };
}

/**
 * Every way this compile can name one object, strongest tier first.
 *
 * A tier with no evidence is absent rather than present-and-empty: reconciliation
 * walks the list looking for the strongest tier BOTH compiles carry, and a
 * placeholder key would let two objects that state nothing match each other.
 */
export function stableObjectIdentities(
  evidence: ModelObjectIdentityEvidence,
): ReadonlyArray<StableModelObjectIdentity> {
  const source = evidence.logicalSourceId;
  const scope = modelScope(evidence);
  const identities: StableModelObjectIdentity[] = [];

  const stableId = meaningful(evidence.stableIdPropertyValue);
  if (stableId !== null) {
    // Deliberately unscoped: a site-wide stable id follows the equipment when
    // it moves from one document to another, which is why P0-9 ranks it first.
    identities.push(identity('stable-id-property', source, `prop/${escapeSourceId(stableId)}`));
  }

  const authoringId = meaningful(evidence.authoringId);
  if (authoringId !== null) {
    identities.push(identity('authoring-id', source, `auth/${scope}/${escapeSourceId(authoringId)}`));
  }

  const instanceGuid = meaningful(evidence.instanceGuid);
  if (instanceGuid !== null) {
    identities.push(identity('instance-guid', source, `guid/${scope}/${escapeSourceId(instanceGuid)}`));
  }

  if (evidence.structuralPath.length > 0) {
    // Positions and class, nothing else. `.` separates positions because they
    // are digits, so no escape is needed and no position can absorb another.
    const path = evidence.structuralPath.join('.');
    const className = escapeSourceId(meaningful(evidence.className) ?? '');
    identities.push(identity('structural', source, `struct/${scope}/${path}/${className}`));
  }

  const tag = meaningful(evidence.canonicalTag);
  if (tag !== null) {
    // Unscoped as well: a tag is supposed to name one thing on the site, so a
    // piece of equipment that moved files still answers to it.
    identities.push(identity('tag', source, `tag/${escapeSourceId(tag)}`));
  }

  return identities;
}
