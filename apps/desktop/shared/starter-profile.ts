import { LADDER_SOURCE_ORDER } from '@matchline/domain';

import type { WireDraftPatch } from './schemas.js';

/**
 * The patch the Quick Setup path merges on its way through: the one starter
 * rule set in the app, and the only thing on the wire side that is a
 * recommendation rather than a shape.
 *
 * It lives beside the schemas rather than in `draft-profile.ts` because both
 * sides need it — the Quick Setup screen builds the patch, and main's tests
 * assert what taking the fast path gets you — and the renderer must never
 * import a main-process module.
 *
 * A project created without Quick Setup gets `emptyDraft` and nothing
 * else — the numbered screens are where a person decides these for themselves,
 * and a wizard that pre-loaded a site's rule set would be answering questions
 * nobody asked. Taking the fast path is that answer, so the fast path is where
 * this is applied.
 *
 * Three things, and each is here for a stated reason:
 *
 * 1. **Identity normalization: `trim`, `unicodeFold`, `uppercase`.** A new
 *    draft already carries `unicodeFold` (an en dash is not a different tag).
 *    The other two are the two facts about tags that hold on every site
 *    Matchline has ever seen: `AHU-1 ` is `AHU-1`, and a tag typed `ahu-1` into
 *    a schedule is the same equipment as `AHU-1` in the model. They are
 *    normalization for IDENTITY matching, not a rewrite of what the register
 *    prints.
 * 2. **The full ladder, `mel-parent` included.** `emptyDraft` already starts
 *    there; restating it means a draft that came from an older profile and was
 *    then taken through Quick Setup gets the rung too, rather than staying on
 *    the pre-`mel-parent` order it was migrated onto.
 * 3. **Role rules — only the ones a person accepted.** `roleRules` is what the
 *    role-pair step proposed FROM THIS MODEL and a person ticked. There is no
 *    default vocabulary and there must not be: "a VFD hangs off an MCC" is a
 *    claim about a site, and a starter profile that shipped one would put
 *    parentage into a commissioning register that no engineer stated.
 *    Called with no rules, this section is absent from the patch entirely, so
 *    it cannot wipe a role graph that already has rules in it.
 */
export function starterProfile(
  roleRules: ReadonlyArray<{ readonly parentRole: string; readonly childRole: string }> = [],
): WireDraftPatch {
  return {
    identityConfig: {
      tagNormalization: [{ kind: 'trim' }, { kind: 'unicodeFold' }, { kind: 'uppercase' }],
      aliases: [],
      fuzzyMaxDistance: 0,
    },
    ladder: { tiers: [...LADDER_SOURCE_ORDER] },
    ...(roleRules.length === 0
      ? {}
      : {
          roleGraph: {
            rules: roleRules.map((rule) => ({
              parentRole: rule.parentRole,
              childRole: rule.childRole,
            })),
          },
        }),
  };
}
