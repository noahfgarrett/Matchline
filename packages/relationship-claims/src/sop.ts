/**
 * The SSM SOP's nesting and commissioning-logic rules, as claims.
 *
 * Layer 1 vendored SSM-Audit's rulebook and ran it after the compile: it says
 * "this drive is not under the equipment it runs". This file reads the same
 * sentences forwards, so the compile puts the drive there.
 *
 * ## The pairing every rule stands on
 *
 * Noah's directive, verbatim: *"Instruments need to be placed under their
 * respective parents. The UPN will be available within the equipment tag like:
 * MAH101-01 has a VFD101-01 down the line as a child."* So a tag carries two
 * things -- a UPN (`101`) and an instance (`01`) -- and a device carrying the
 * same two as a piece of equipment is a device that belongs to it. That is a
 * fact about the tags a site already writes, not a rule Matchline invented, and
 * it is why these claims can cross a discipline line the model draws: the drive
 * is in the electrical package and the air handler is in the mechanical one,
 * and they are still one machine.
 *
 * ## What this file will not do
 *
 * 1. **It never guesses power.** `logic.driven-electrical-path` and
 *    `logic.control-electrical-path` claim a feed only where connectivity
 *    states one. With no cable schedule they make no claim at all, and the
 *    audit's "no power path" finding stands, which is the honest answer.
 * 2. **It never picks between candidates.** Two pieces of equipment on one
 *    UPN and instance get one claim each, and the ladder's tie rule raises
 *    `ambiguous-parent`. Choosing here would hide the ambiguity.
 * 3. **It never crosses a UPN.** Every rule matches within one UPN. An
 *    instrument with nothing to pair to on its own UPN gets no claim and roots
 *    inside its own system rather than being adopted by another one.
 *
 * Every rule is individually switchable (`SopRulesConfig.disabledRuleIds`), and
 * the whole source is off unless the site's ladder carries the `sop-rule` rung
 * -- `assembleRelationshipClaims` is handed `sopRules` only then.
 */
import {
  isSopDeviceClass,
  isSopEquipmentClass,
  SOP_TAG_PAIR,
  type EquipmentClass,
  type Provenance,
  type RelationshipType,
  type SsmRelationshipClaim,
} from '@matchline/domain';

import { ladderRung } from './mapping.js';
import type { ClaimSubject, FlowEdgeInput } from './types.js';

/** The document every SOP claim addresses. Not a file: a written standard. */
export const SOP_SOURCE_FILE = 'ssm-sop';

/** Joins a UPN and an instance into one group key. */
const KEY_SEPARATOR = ' ';

/** One subject with everything the SOP rules read, all of it stated. */
interface SopSubject {
  readonly assetId: string;
  readonly canonicalTag: string;
  readonly equipmentClass: EquipmentClass;
  readonly upn: string;
  readonly instance: string;
  readonly building: string;
}

/** What the SOP source produced. Neither list is resolved or deduped here. */
export interface SopClaims {
  readonly structural: ReadonlyArray<SsmRelationshipClaim>;
  readonly dependencies: ReadonlyArray<SsmRelationshipClaim>;
}

/** Everything the SOP source reads. */
export interface SopInput {
  readonly subjects: ReadonlyArray<ClaimSubject>;
  /** Connectivity, so the two power-path rules can read a stated feed. */
  readonly flowEdges: ReadonlyArray<FlowEdgeInput>;
  /** Rule ids the site switched off. */
  readonly disabledRuleIds: ReadonlyArray<string>;
}

/** The classes a power feed can come out of. */
const FEEDING_CLASSES: ReadonlyArray<EquipmentClass> = [
  'panel',
  'transformer',
  'vfd',
  'starter',
  'heat-trace-panel',
];

/** The classes `logic.control-electrical-path` is about. */
const POWERED_CONTROL_CLASSES: ReadonlyArray<EquipmentClass> = [
  'plc',
  'rio',
  'lcp',
  'facp',
  'control-equipment',
];

/**
 * One SOP claim's audit trail.
 *
 * `sourceFile` is the standard rather than a document on disk, and
 * `propertyOrColumn` carries the evidence in the words a reviewer asks in:
 * which UPN, which instance, which tag on the other end.
 */
function sopProvenance(ruleId: string, childAssetId: string, evidence: string): Provenance {
  return {
    sourceFile: SOP_SOURCE_FILE,
    sourceRef: { kind: 'model-object', objectId: childAssetId },
    rule: ruleId,
    fallbackRung: ladderRung('sop-rule'),
    propertyOrColumn: evidence,
  };
}

/** A subject with everything stated, or `null`. Nothing is defaulted. */
function sopSubjectOf(subject: ClaimSubject): SopSubject | null {
  const equipmentClass = subject.equipmentClass;
  if (equipmentClass === undefined) {
    return null;
  }
  return {
    assetId: subject.assetId,
    canonicalTag: subject.canonicalTag,
    equipmentClass,
    upn: subject.upn ?? '',
    instance: subject.instance ?? '',
    building: subject.building ?? '',
  };
}

/** Asset ids in code-unit order, so every list this file emits is stable. */
function byAssetIdAscending(left: SopSubject, right: SopSubject): number {
  if (left.assetId < right.assetId) {
    return -1;
  }
  return left.assetId > right.assetId ? 1 : 0;
}

/** Every subject on one key, in asset-id order so claims come out stable. */
function groupBy(
  subjects: ReadonlyArray<SopSubject>,
  keyOf: (subject: SopSubject) => string | null,
): ReadonlyMap<string, ReadonlyArray<SopSubject>> {
  const groups = new Map<string, SopSubject[]>();
  for (const subject of subjects) {
    const key = keyOf(subject);
    if (key === null) {
      continue;
    }
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [subject]);
      continue;
    }
    existing.push(subject);
  }
  for (const list of groups.values()) {
    list.sort(byAssetIdAscending);
  }
  return groups;
}

/**
 * Which equipment a device of this class may pair to, strongest kind first.
 *
 * The SOP's own precedence, stated as data: a drive belongs to the machine it
 * runs and never to the panel that feeds it; a local control panel belongs to
 * the skid it serves; an instrument belongs to whatever equipment is there.
 * An empty list for a class means "this class does not pair" -- `fms-io` has
 * its own rule, which is stricter than the general pairing.
 */
const PAIR_PREFERENCE: Readonly<Record<string, ReadonlyArray<ReadonlyArray<EquipmentClass>>>> =
  Object.freeze({
    vfd: [['driven']],
    starter: [['driven']],
    lcp: [['driven']],
    'control-valve': [['driven'], ['panel', 'transformer', 'plc', 'rio', 'control-equipment']],
    'room-sensor': [['driven'], ['panel', 'transformer', 'plc', 'rio', 'control-equipment']],
    instrument: [['driven'], ['panel', 'transformer', 'plc', 'rio', 'control-equipment']],
    fdu: [
      ['plc', 'rio'],
      ['panel', 'driven', 'transformer', 'control-equipment'],
    ],
    'fms-io': [],
  });

/** Which SOP rule places a device of this class when it pairs by tag. */
const PAIR_RULE: Readonly<Record<string, string>> = Object.freeze({
  vfd: SOP_TAG_PAIR,
  starter: SOP_TAG_PAIR,
  lcp: 'sop.lcp-placement',
  'control-valve': 'sop.control-valve-parent',
  'room-sensor': 'sop.room-sensor-parent',
  instrument: SOP_TAG_PAIR,
  fdu: SOP_TAG_PAIR,
});

/** The classes whose UPN-only fallback `sop.instrument-parent-upn` covers. */
const UPN_FALLBACK_CLASSES: ReadonlyArray<EquipmentClass> = [
  'instrument',
  'control-valve',
  'room-sensor',
  'fdu',
];

/** The equipment classes anything may fall back to, weakest band last. */
const FALLBACK_BANDS: ReadonlyArray<ReadonlyArray<EquipmentClass>> = [
  ['driven'],
  ['panel', 'transformer', 'plc', 'rio', 'control-equipment'],
];

/**
 * The first non-empty band of candidates, by the class's own preference.
 *
 * Bands rather than one flat list, because "a VFD pairs to the driven
 * equipment, not to a panel" is a precedence and not a filter: the panel is
 * still there, it just never wins while a machine is.
 */
function preferred(
  bands: ReadonlyArray<ReadonlyArray<EquipmentClass>>,
  candidates: ReadonlyArray<SopSubject>,
): ReadonlyArray<SopSubject> {
  for (const band of bands) {
    const hits = candidates.filter((candidate) => band.includes(candidate.equipmentClass));
    if (hits.length > 0) {
      return hits;
    }
  }
  return [];
}

/**
 * Turn the SOP into claims.
 *
 * Pure and total: the same subjects always produce the same claims, in
 * asset-id order, and no input is rejected. A subject with no class, no UPN or
 * no instance simply takes part in no rule that needs one.
 */
export function sopClaims(input: SopInput): SopClaims {
  const disabled = new Set(input.disabledRuleIds);
  const on = (ruleId: string): boolean => !disabled.has(ruleId);

  const subjects: SopSubject[] = [];
  for (const subject of input.subjects) {
    const built = sopSubjectOf(subject);
    if (built !== null) {
      subjects.push(built);
    }
  }
  subjects.sort(byAssetIdAscending);

  const structural: SsmRelationshipClaim[] = [];
  const dependencies: SsmRelationshipClaim[] = [];
  if (subjects.length === 0) {
    return { structural, dependencies };
  }

  const byPair = groupBy(subjects, (subject) =>
    subject.upn === '' || subject.instance === ''
      ? null
      : `${subject.upn}${KEY_SEPARATOR}${subject.instance}`,
  );
  const byUpn = groupBy(subjects, (subject) => (subject.upn === '' ? null : subject.upn));
  const byBuilding = groupBy(subjects, (subject) =>
    subject.building === '' ? null : subject.building,
  );
  const byAssetId = new Map(subjects.map((subject) => [subject.assetId, subject] as const));

  /** The equipment sharing one device's UPN and instance, itself excluded. */
  const pairMates = (device: SopSubject): ReadonlyArray<SopSubject> =>
    (byPair.get(`${device.upn}${KEY_SEPARATOR}${device.instance}`) ?? []).filter(
      (candidate) =>
        candidate.assetId !== device.assetId && isSopEquipmentClass(candidate.equipmentClass),
    );

  /** Everything on one UPN of one class, itself excluded. */
  const sameUpn = (
    subject: SopSubject,
    classes: ReadonlyArray<EquipmentClass>,
  ): ReadonlyArray<SopSubject> =>
    (byUpn.get(subject.upn) ?? []).filter(
      (candidate) =>
        candidate.assetId !== subject.assetId && classes.includes(candidate.equipmentClass),
    );

  const addStructural = (
    ruleId: string,
    child: SopSubject,
    parent: SopSubject,
    evidence: string,
  ): void => {
    structural.push({
      subjectAssetId: child.assetId,
      targetAssetId: parent.assetId,
      kind: 'structural-parent',
      relationshipType: 'FAMILY_RELATED',
      source: 'MANUAL',
      rule: ruleId,
      evidenceTier: 1,
      ladderSource: 'sop-rule',
      provenance: sopProvenance(ruleId, child.assetId, evidence),
    });
  };

  const addDependency = (
    ruleId: string,
    dependent: SopSubject,
    upstream: SopSubject,
    relationshipType: RelationshipType,
    evidence: string,
  ): void => {
    dependencies.push({
      subjectAssetId: dependent.assetId,
      targetAssetId: upstream.assetId,
      kind: 'dependency',
      relationshipType,
      source: 'MANUAL',
      rule: ruleId,
      evidenceTier: 1,
      ladderSource: 'sop-rule',
      provenance: sopProvenance(ruleId, dependent.assetId, evidence),
    });
  };

  for (const subject of subjects) {
    /* --- the pairing itself, and the rules that are special cases of it --- */
    if (isSopDeviceClass(subject.equipmentClass) && subject.upn !== '' && subject.instance !== '') {
      const ruleId = PAIR_RULE[subject.equipmentClass];
      const bands = PAIR_PREFERENCE[subject.equipmentClass] ?? [];
      if (ruleId !== undefined && on(ruleId)) {
        for (const parent of preferred(bands, pairMates(subject))) {
          addStructural(
            ruleId,
            subject,
            parent,
            `UPN ${subject.upn}, instance ${subject.instance}: ${parent.canonicalTag}`,
          );
        }
      }
    }

    /* --- an instrument with nothing on its own instance stays on its own UPN --- */
    if (
      UPN_FALLBACK_CLASSES.includes(subject.equipmentClass) &&
      subject.upn !== '' &&
      on('sop.instrument-parent-upn') &&
      pairMates(subject).length === 0
    ) {
      const candidates = sameUpn(subject, [
        'driven',
        'panel',
        'transformer',
        'plc',
        'rio',
        'control-equipment',
      ]);
      for (const parent of preferred(FALLBACK_BANDS, candidates)) {
        addStructural(
          'sop.instrument-parent-upn',
          subject,
          parent,
          `UPN ${subject.upn} in the tag: ${parent.canonicalTag}`,
        );
      }
    }

    /* --- FMS hardwired I/O: under its drive, with the PLC as a dependency --- */
    if (subject.equipmentClass === 'fms-io' && on('sop.fms-io-under-vfd') && subject.upn !== '') {
      if (subject.instance !== '') {
        for (const drive of pairMates(subject).filter(
          (candidate) => candidate.equipmentClass === 'vfd',
        )) {
          addStructural(
            'sop.fms-io-under-vfd',
            subject,
            drive,
            `UPN ${subject.upn}, instance ${subject.instance}: ${drive.canonicalTag}`,
          );
        }
      }
      for (const plc of sameUpn(subject, ['plc'])) {
        addDependency(
          'sop.fms-io-under-vfd',
          subject,
          plc,
          'DEPENDENCY',
          `the controlling PLC on UPN ${subject.upn}`,
        );
      }
    }

    /* --- a VFD lists its panel and its PLC --- */
    if (subject.equipmentClass === 'vfd' && on('sop.vfd-dependencies') && subject.upn !== '') {
      for (const panel of sameUpn(subject, ['panel'])) {
        addDependency(
          'sop.vfd-dependencies',
          subject,
          panel,
          'DEPENDENCY',
          `the electrical panel on UPN ${subject.upn}`,
        );
      }
      for (const plc of sameUpn(subject, ['plc'])) {
        addDependency(
          'sop.vfd-dependencies',
          subject,
          plc,
          'DEPENDENCY',
          `the controlling PLC on UPN ${subject.upn}`,
        );
      }
    }

    /* --- the heat trace chain --- */
    if (on('logic.heat-trace-chain') && subject.upn !== '') {
      if (subject.equipmentClass === 'heat-trace-panel') {
        for (const transformer of sameUpn(subject, ['transformer'])) {
          addStructural(
            'logic.heat-trace-chain',
            subject,
            transformer,
            `the supplying transformer on UPN ${subject.upn}`,
          );
        }
      }
      if (subject.equipmentClass === 'heat-trace-connection') {
        const panels = sameUpn(subject, ['heat-trace-panel']);
        // The panel first, and only the upstream box when there is no panel:
        // the SOP's own order ("its panel or the upstream connection box").
        const anchors = panels.length > 0 ? panels : sameUpn(subject, ['heat-trace-connection']);
        for (const anchor of anchors) {
          addStructural(
            'logic.heat-trace-chain',
            subject,
            anchor,
            `the heat-trace branch on UPN ${subject.upn}: ${anchor.canonicalTag}`,
          );
        }
      }
    }

    /* --- a VESDA depends on the fire alarm panel in its own building --- */
    if (
      subject.equipmentClass === 'vesda' &&
      on('logic.vesda-fire-alarm') &&
      subject.building !== ''
    ) {
      for (const panel of byBuilding.get(subject.building) ?? []) {
        if (panel.equipmentClass !== 'facp') {
          continue;
        }
        addDependency(
          'logic.vesda-fire-alarm',
          subject,
          panel,
          'DEPENDENCY',
          `the fire alarm panel in ${subject.building}`,
        );
      }
    }

    /* --- an RIO depends on its controller --- */
    if (subject.equipmentClass === 'rio' && on('logic.rio-control-path') && subject.upn !== '') {
      const controllers = sameUpn(subject, ['plc']);
      const anchors =
        controllers.length > 0 ? controllers : sameUpn(subject, ['control-equipment']);
      for (const controller of anchors) {
        addDependency(
          'logic.rio-control-path',
          subject,
          controller,
          'DEPENDENCY',
          `the controller on UPN ${subject.upn}`,
        );
      }
    }
  }

  /* --- the two power paths, read from connectivity and never guessed --- */
  for (const edge of input.flowEdges) {
    const upstream = byAssetId.get(edge.fromAssetId);
    const downstream = byAssetId.get(edge.toAssetId);
    if (upstream === undefined || downstream === undefined) {
      continue;
    }
    if (!FEEDING_CLASSES.includes(upstream.equipmentClass)) {
      continue;
    }
    const ruleId =
      downstream.equipmentClass === 'driven'
        ? 'logic.driven-electrical-path'
        : POWERED_CONTROL_CLASSES.includes(downstream.equipmentClass)
          ? 'logic.control-electrical-path'
          : null;
    if (ruleId === null || !on(ruleId)) {
      continue;
    }
    // The edge's own relationship type, so this claim and the flow rung's own
    // dependency collapse to one entry on the resolved node rather than
    // printing the same feeder twice in the Dependencies column.
    addDependency(
      ruleId,
      downstream,
      upstream,
      edge.relationshipType,
      `${upstream.canonicalTag} feeds it, per connectivity`,
    );
  }

  return { structural, dependencies };
}
