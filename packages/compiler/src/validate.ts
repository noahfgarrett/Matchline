/**
 * The profile, checked before a single cache is read (audit: "profile typos
 * silently disable ladder tiers and level keys").
 *
 * Every field checked here is a string a person typed that the engine looks up
 * in a closed set. A lookup that misses does not fail -- it produces the same
 * behaviour as "the site chose not to configure this", which is the worst
 * possible outcome for a typo:
 *
 * - a ladder tier spelled `explicit_model` disables the model's own parent
 *   property, and the site sees a flatter tree with no error anywhere;
 * - a level whose key is `system` rather than `systemKey` finds no value on any
 *   asset, so `missingValuePolicy` files the entire site under `(unassigned)`;
 * - a `missingValuePolicy` of `unassigned` (not `unassigned-group`) reaches an
 *   exhaustive switch in the fold and throws from four packages down, naming
 *   nothing a person can act on.
 *
 * So they are refused, up front, with a sentence naming the field and what it
 * is allowed to say. `validateDerivedAttributes` does exactly this for the
 * derived registry already (P0-7); this is the rest of the profile.
 */
import { LADDER_SOURCE_ORDER, migrateHierarchyConfig } from '@matchline/domain';
import type { DerivedAttributeDefinition, SiteProfileV2 } from '@matchline/domain';

import { ATTRIBUTE_KEYS } from './attributes.js';
import { ProfileConfigError } from './errors.js';

/** What `missingValuePolicy` may say. */
const MISSING_VALUE_POLICIES = ['unassigned-group', 'review', 'provisional-root'] as const;

/** What a level's `sort` may say. */
const LEVEL_SORTS = ['label', 'key'] as const;

/**
 * Checks a profile and returns it, or refuses it.
 *
 * Runs after {@link validateDerivedAttributes}, because a level may legitimately
 * name a derived attribute and this needs the registry to know which ones exist.
 *
 * @throws ProfileConfigError naming the field that failed.
 */
export function validateProfile(
  profile: SiteProfileV2,
  derived: ReadonlyArray<DerivedAttributeDefinition>,
): SiteProfileV2 {
  const tiers: ReadonlyArray<string> = LADDER_SOURCE_ORDER;
  profile.ladder.tiers.forEach((tier, index) => {
    if (!tiers.includes(tier)) {
      throw new ProfileConfigError({
        kind: 'unknown-ladder-tier',
        field: `ladder.tiers[${String(index)}]`,
        value: tier,
        allowed: LADDER_SOURCE_ORDER,
      });
    }
  });

  // Every string a level may address: the compiler's own table, plus whatever
  // this site derived. Exactly the set `attributesFor` populates, which is what
  // makes "not in here" mean "no asset will ever have a value for it".
  const attributeKeys = new Set<string>([
    ...ATTRIBUTE_KEYS,
    ...derived.map((definition) => definition.attributeId),
  ]);
  const allowedAttributes = [...attributeKeys].sort();

  migrateHierarchyConfig(profile.hierarchy).levels.forEach((level, index) => {
    const at = `hierarchy.levels[${String(index)}]`;
    const named: ReadonlyArray<readonly [string, string | undefined]> = [
      ['keyAttributeKey', level.keyAttributeKey],
      ['displayAttributeKey', level.displayAttributeKey],
      ['boundaryAttributeKey', level.boundaryAttributeKey],
    ];
    for (const [name, value] of named) {
      // An absent optional key is the level saying "the identity key does both
      // jobs", which is the ordinary case and not a mistake.
      if (value === undefined) {
        continue;
      }
      if (!attributeKeys.has(value)) {
        throw new ProfileConfigError({
          kind: 'unknown-attribute-key',
          field: `${at}.${name}`,
          value,
          allowed: allowedAttributes,
          levelId: level.levelId,
        });
      }
    }

    const policies: ReadonlyArray<string> = MISSING_VALUE_POLICIES;
    if (!policies.includes(level.missingValuePolicy)) {
      throw new ProfileConfigError({
        kind: 'unknown-missing-value-policy',
        field: `${at}.missingValuePolicy`,
        value: level.missingValuePolicy,
        allowed: MISSING_VALUE_POLICIES,
        levelId: level.levelId,
      });
    }

    const sorts: ReadonlyArray<string> = LEVEL_SORTS;
    if (!sorts.includes(level.sort)) {
      throw new ProfileConfigError({
        kind: 'unknown-level-sort',
        field: `${at}.sort`,
        value: level.sort,
        allowed: LEVEL_SORTS,
        levelId: level.levelId,
      });
    }
  });

  return profile;
}
