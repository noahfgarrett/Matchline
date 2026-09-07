import { LADDER_SOURCE_ORDER, SOP_DEVICE_CLASSES, type EquipmentClass } from '@matchline/domain';

import type { WireDraftPatch, WireHierarchyLevel } from './schemas.js';

/**
 * The level whose boundary the SSM SOP's approved exception applies to.
 *
 * Matched by id rather than by name, because the name is a label a site may
 * re-type and the id is what `DEFAULT_HIERARCHY_LEVELS` fixes.
 */
export const SSM_DISCIPLINE_LEVEL_ID = 'ssm-discipline';

/**
 * The child classes SSM Discipline stops being a boundary for.
 *
 * SSM-Audit's `parent.cross-discipline` states the rule and its one exception:
 * "A structural child stays inside its parent's discipline. Controls devices
 * nesting under the equipment they serve are the approved exception." This is
 * that list, in the SOP's own class vocabulary — every device the tag pairing
 * places under equipment, plus the two controllers a site nests inside the
 * machine they run.
 */
export const SSM_DISCIPLINE_EXCEPTION_CLASSES: readonly EquipmentClass[] = [
  ...SOP_DEVICE_CLASSES,
  'plc',
  'rio',
];

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
 * Five things, and each is here for a stated reason:
 *
 * 1. **Identity normalization: `trim`, `unicodeFold`, `uppercase`.** A new
 *    draft already carries `unicodeFold` (an en dash is not a different tag).
 *    The other two are the two facts about tags that hold on every site
 *    Matchline has ever seen: `AHU-1 ` is `AHU-1`, and a tag typed `ahu-1` into
 *    a schedule is the same equipment as `AHU-1` in the model. They are
 *    normalization for IDENTITY matching, not a rewrite of what the register
 *    prints.
 * 2. **The full ladder, `mel-parent` and `sop-rule` included.** `emptyDraft`
 *    already starts there; restating it means a draft that came from an older
 *    profile and was then taken through Quick Setup gets both rungs too, rather
 *    than staying on the pre-`mel-parent` order it was migrated onto.
 * 3. **Every SSM SOP rule on.** The SOP is not site vocabulary — it is the
 *    standard the register is audited against, and Matchline already ships the
 *    rulebook that judges it. Building to a standard the gate then checks is a
 *    different thing from guessing at a site: `sopRules` names the rules a site
 *    switched OFF, and a starter profile switches none off.
 * 4. **The discipline boundary's approved exception.** Offered only when the
 *    caller hands over the levels it is amending, because a patch that carried
 *    a whole hierarchy would overwrite levels a person had already edited. The
 *    default preset itself is untouched (RELEASE-1.0-PLAN P0-5 keeps SSM
 *    Discipline non-structural); this is the *other* way to reach the same
 *    place — the level becomes a real boundary, and the controls devices the
 *    SOP places across it are exempt from it by class.
 * 5. **Role rules — only the ones a person accepted.** `roleRules` is what the
 *    role-pair step proposed FROM THIS MODEL and a person ticked. There is no
 *    default vocabulary and there must not be: "a VFD hangs off an MCC" is a
 *    claim about a site, and a starter profile that shipped one would put
 *    parentage into a commissioning register that no engineer stated. Called
 *    with no rules, this section is absent from the patch entirely, so it
 *    cannot wipe a role graph that already has rules in it.
 */
export function starterProfile(
  roleRules: ReadonlyArray<{ readonly parentRole: string; readonly childRole: string }> = [],
  levels?: ReadonlyArray<WireHierarchyLevel>,
): WireDraftPatch {
  return {
    identityConfig: {
      tagNormalization: [{ kind: 'trim' }, { kind: 'unicodeFold' }, { kind: 'uppercase' }],
      aliases: [],
      fuzzyMaxDistance: 0,
    },
    ladder: { tiers: [...LADDER_SOURCE_ORDER] },
    sopRules: { disabledRuleIds: [] },
    ...(levels === undefined ? {} : { hierarchy: { levels: withSopException(levels) } }),
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

/**
 * The site's own levels, with SSM Discipline made a boundary that the SOP's
 * controls devices cross.
 *
 * Every other level is returned untouched, and a stack with no SSM Discipline
 * level is returned unchanged: the exception is an amendment to a level a site
 * has, not a level this function adds.
 *
 * Why a boundary at all, when P0-5 made it `false`? Because the two answers
 * solve the same problem differently and only one of them is a rule. `false`
 * says "a discipline difference never breaks a parent", which lets ANY parent
 * cross it — a pump under a switchboard included. `true` plus the exception
 * says what the SOP says: a discipline difference breaks a parent, unless the
 * child is one of the controls devices the SOP puts under the equipment it
 * serves. The default preset keeps the safe blunt answer; a site that has taken
 * the fast path has said it follows the SOP, so it gets the SOP's own one.
 */
export function withSopException(
  levels: ReadonlyArray<WireHierarchyLevel>,
): WireHierarchyLevel[] {
  return levels.map((level) =>
    level.levelId === SSM_DISCIPLINE_LEVEL_ID
      ? {
          ...level,
          boundary: true,
          boundaryExceptions: { childClasses: [...SSM_DISCIPLINE_EXCEPTION_CLASSES] },
        }
      : { ...level },
  );
}
