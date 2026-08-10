/**
 * Hand-written ledger fixtures.
 *
 * This package reads no cache, so its tests do not open one: the whole point of
 * taking plain evidence is that a scenario -- a rebuilt model, a moved object, a
 * corrected tag -- is a few lines of data rather than a SQLite file. The compiler
 * package's own tests exercise the same rules against real Dragon caches.
 *
 * Dragon spelling throughout (`docs/EXTRACTION.md`, "Confidentiality"): every
 * tag, GUID and file name here is invented.
 */
import { stableObjectIdentities } from '../dist/index.js';

/** The invented model file every fixture object lives in. */
export const MODEL_GUID = '00000000-0000-4000-8000-000000001001';

/** The project source id the fixtures register that file under. */
export const SOURCE_ID = 'dragon';

/**
 * One object's evidence, with the fields a scenario does not care about filled
 * in. Every default is "the model states this", so a test that wants a tier
 * absent has to say so with `null`.
 */
export function evidence(overrides = {}) {
  return {
    logicalSourceId: SOURCE_ID,
    sourceModelPersistentId: MODEL_GUID,
    authoringId: 'id-MAH001-10-01',
    instanceGuid: '00000000-0000-4000-8000-000000000004',
    structuralPath: [0, 1, 2],
    className: 'Equipment',
    canonicalTag: 'MAH001-10-01',
    ...overrides,
  };
}

/** One candidate, from evidence plus the id the catalog would have minted. */
export function candidate(overrides = {}) {
  const facts = evidence(overrides);
  return {
    assetId: overrides.assetId ?? `tag:${facts.canonicalTag}`,
    canonicalTag: facts.canonicalTag,
    identities: stableObjectIdentities(facts),
  };
}

/** The stable key one candidate carries at one tier, or `undefined`. */
export function keyAt(entry, tier) {
  return entry.identities.find((identity) => identity.tier === tier)?.stableObjectKey;
}

/** A ledger entry by its id. */
export function entryOf(ledger, assetId) {
  return ledger.entries.find((entry) => entry.assetId === assetId);
}

/** Events of one kind, in the order the result reports them. */
export function eventsOf(result, kind) {
  return result.events.filter((event) => event.kind === kind);
}
