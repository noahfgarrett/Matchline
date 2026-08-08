/**
 * Every number the learned-rules engine judges by, in one place.
 *
 * All of them are the donor's (`packages/legacy-parity/src/compiler/nesting.js`
 * and `.../itemmasters.js`), measured there against a real 18k-row registry.
 * They are constants rather than options on purpose: a site profile that could
 * lower the claim bar would turn proposals into hierarchy writes, which is the
 * one thing this package must never allow (ENGINE.md E3).
 */

/** Donor `assignClassifications(..., minConfidence = 0.9)`: below this, no class. */
export const CLASSIFICATION_MIN_CONFIDENCE = 0.9;

/** Donor `NEST_MIN_AFFINITY`: a class pair is a rule only once it repeats. */
export const MIN_AFFINITY_OBSERVATIONS = 3;

/** Donor `isChildClass`: parents almost never, and seen often enough to trust that. */
export const CHILD_ONLY_MAX_PARENT_RATE = 0.05;
export const CHILD_ONLY_MIN_SIGHTINGS = 10;

/** Donor `isParentCapable`: parents regularly, and did so more than a handful of times. */
export const PARENT_CAPABLE_MIN_PARENT_RATE = 0.15;
export const PARENT_CAPABLE_MIN_PARENTINGS = 5;

/** Donor `NEST_GRADE_MIN_ROWS` / `NEST_GRADE_MIN_PRECISION`: the claim bar. */
export const GRADE_MIN_PREDICTIONS = 10;
export const GRADE_MIN_PRECISION = 0.85;

/**
 * Donor containment guard. A tag only "contains" another when the extension is
 * substantive and lands on a separator, so `MAH001-10-01-A` stays a SIBLING of
 * `MAH001-10-01` (DECISIONS.md -- letter-suffixed identities are distinct
 * equipment) while `PLC001-10-01-RACK` genuinely extends its PLC.
 */
export const CONTAINMENT_MIN_PARENT_BODY = 6;
export const CONTAINMENT_MIN_EXTENSION = 3;
