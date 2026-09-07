/**
 * The SSM SOP nesting and commissioning-logic rules, as a catalogue.
 *
 * Layer 1 vendored SSM-Audit's rulebook and ran it as a post-compile gate: it
 * says a drive is not under the equipment it runs. This is the other half --
 * the same sentences read forwards, as build rules, so the compile puts the
 * drive there in the first place instead of reporting that nobody did.
 *
 * Each id mirrors the rulebook's own (`sop.vfd-dependencies` here is the rule
 * that satisfies `sop.vfd-dependencies` there), because a site reading its
 * review queue should not have to learn two names for one sentence. The
 * exception is {@link SOP_TAG_PAIR}, which has no rulebook counterpart: it is
 * the mechanism the other rules stand on rather than a rule the audit checks.
 *
 * Types and text only. `@matchline/relationship-claims` is what turns these
 * into claims, and it is the only place the logic lives.
 */

/**
 * The pairing itself: a device whose tag carries a UPN and an instance nests
 * under the equipment carrying the same two.
 *
 * Noah's directive, in one id: "The UPN will be available within the equipment
 * tag like: MAH101-01 has a VFD101-01 down the line as a child."
 */
export const SOP_TAG_PAIR = 'sop.tag-pair';

/** Every SOP build rule's id, in the order a screen lists them. */
export const SOP_RULE_IDS = [
  SOP_TAG_PAIR,
  'sop.vfd-dependencies',
  'sop.fms-io-under-vfd',
  'sop.lcp-placement',
  'sop.control-valve-parent',
  'sop.room-sensor-parent',
  'sop.instrument-parent-upn',
  'logic.heat-trace-chain',
  'logic.vesda-fire-alarm',
  'logic.rio-control-path',
  'logic.driven-electrical-path',
  'logic.control-electrical-path',
] as const;

/** One SOP build rule's id. */
export type SopRuleId = (typeof SOP_RULE_IDS)[number];

/** What one rule does, in the words a review screen shows. */
export interface SopRuleDescriptor {
  readonly ruleId: SopRuleId;
  /** Whether the rule proposes a parent or an ordering relation. */
  readonly effect: 'structural' | 'dependency';
  readonly title: string;
  /** What the rule makes true, for an engineer reading it cold. */
  readonly statement: string;
}

/**
 * Every rule, with the sentence it enforces.
 *
 * Frozen and exported as data rather than as a switch, for the same reason the
 * rulebook's own table is: a person arguing about what a rule does should be
 * able to read one list.
 */
export const SOP_RULES: ReadonlyArray<SopRuleDescriptor> = Object.freeze([
  Object.freeze({
    ruleId: SOP_TAG_PAIR,
    effect: 'structural',
    title: 'Device under the equipment its tag names',
    statement:
      'A device whose tag carries a UPN and an instance nests under the equipment carrying the same UPN and instance — MAH101-01 is where VFD101-01 belongs.',
  }),
  Object.freeze({
    ruleId: 'sop.vfd-dependencies',
    effect: 'dependency',
    title: 'VFD depends on its panel and its PLC',
    statement:
      'Per the SOP a VFD lists its electrical panel and its PLC as dependencies. Taken from connectivity where a cable schedule states it, and otherwise from the panel and PLC on the same UPN.',
  }),
  Object.freeze({
    ruleId: 'sop.fms-io-under-vfd',
    effect: 'structural',
    title: 'FMS hardwired I/O under its VFD',
    statement:
      'FMS hardwired I/O for a drive nests under that VFD, with the controlling PLC as a dependency.',
  }),
  Object.freeze({
    ruleId: 'sop.lcp-placement',
    effect: 'structural',
    title: 'Local control panel with its equipment',
    statement:
      'A local control panel nests under the skid or driven equipment it serves, in its own UPN — never under equipment in another UPN.',
  }),
  Object.freeze({
    ruleId: 'sop.control-valve-parent',
    effect: 'structural',
    title: 'Control valve under its equipment',
    statement: 'A control valve nests under the equipment it serves, not under the System Name.',
  }),
  Object.freeze({
    ruleId: 'sop.room-sensor-parent',
    effect: 'structural',
    title: 'Room sensor under the equipment it controls',
    statement:
      'A room sensor nests under the equipment it controls — the air handler serving the room — not under the room or area.',
  }),
  Object.freeze({
    ruleId: 'sop.instrument-parent-upn',
    effect: 'structural',
    title: 'Instrument inside the UPN in its tag',
    statement:
      'An instrument with no equipment on its own UPN and instance falls back to equipment on its own UPN, and never crosses into another UPN. With no equipment there at all it roots inside its own UPN.',
  }),
  Object.freeze({
    ruleId: 'logic.heat-trace-chain',
    effect: 'structural',
    title: 'Heat trace chain',
    statement:
      'A heat-trace panel sits under its transformer; a heat-trace connection box sits under its panel or the upstream connection box.',
  }),
  Object.freeze({
    ruleId: 'logic.vesda-fire-alarm',
    effect: 'dependency',
    title: 'VESDA depends on its fire alarm panel',
    statement: 'A VESDA system lists the fire alarm panel in its own building as a dependency.',
  }),
  Object.freeze({
    ruleId: 'logic.rio-control-path',
    effect: 'dependency',
    title: 'RIO depends on its controller',
    statement:
      'A remote I/O drop lists the PLC or I/O cluster on its own UPN as a dependency.',
  }),
  Object.freeze({
    ruleId: 'logic.driven-electrical-path',
    effect: 'dependency',
    title: 'Driven equipment depends on its feed',
    statement:
      'Pumps, fans and air handlers list the electrical gear that powers them — read from connectivity, never guessed. With no cable schedule the rule makes no claim.',
  }),
  Object.freeze({
    ruleId: 'logic.control-electrical-path',
    effect: 'dependency',
    title: 'Control equipment depends on its feed',
    statement:
      'Control panels and RIOs list the supply that powers them — read from connectivity, never guessed. With no cable schedule the rule makes no claim.',
  }),
]);

/**
 * What a site has said about the SOP build rules.
 *
 * One field, deliberately: the rules are the SOP, so a site does not get to
 * reword one or add one. What it gets to say is "not here" -- a site whose
 * drives genuinely do not nest under their equipment switches the pairing off
 * rather than reviewing forty thousand claims it disagrees with.
 */
export interface SopRulesConfig {
  /** Rule ids whose claims this site does not want. Unknown ids are ignored. */
  readonly disabledRuleIds: ReadonlyArray<string>;
}
