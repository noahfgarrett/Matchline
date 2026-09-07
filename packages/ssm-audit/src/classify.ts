/**
 * `@matchline/ssm-audit/classify` — the rulebook's description classifiers, as
 * a typed module the build side can call.
 *
 * ## Why this exists at all
 *
 * The vendored engine recognises a VFD, an RIO, a heat-trace panel and a room
 * sensor from a description, and it does so to REPORT: "this drive is not under
 * the equipment it runs." Layer 3 reads the same sentences forwards — it puts
 * the drive there. To do that it needs the same answer to "what is this?", and
 * an answer that disagreed with the gate's by one word would mean Matchline
 * building a hierarchy its own audit then rejects.
 *
 * The engine's classifiers are not exported (`auditIsVfd` and its fifteen
 * siblings are module-private, and `vendor/` is never edited). So the regexes
 * are restated here — and pinned: `test/classify.test.mjs` extracts each
 * `auditIsX` function's regex literals out of `vendor/audit/engine.js` by name
 * and asserts they equal {@link AUDIT_REGEXPS}, source and flags, in order. A
 * re-vendor that changes a word fails that test rather than quietly splitting
 * the two halves of the SOP apart.
 *
 * ## What is deliberately NOT reproduced
 *
 * `auditIsDrivenEquipment` and `auditIsInstrument` also consult the row's
 * discipline and its other classifiers. The regex halves are reproduced; the
 * discipline half is not, because this module classifies a description and a
 * tag rather than an upload row. {@link isDrivenEquipment} is therefore the
 * engine's predicate with `!auditIsElectrical(row)` left to the caller, which
 * is the honest split: a caller that has a discipline can apply it, and one
 * that does not is not silently told the row is electrical.
 */

// The rulebook's model layer reads a bare `XLSX` global that only a browser
// page sets. Imported for its side effect, first, so nothing downstream can
// touch the vendored graph before the guard is in place.
import '../vendor/xlsx-global.js';

import type { EquipmentClass } from '@matchline/domain';

import { auditNormId } from '../vendor/audit/model.js';

/** Every regex the engine's classifiers test, by the engine's function name. */
export const AUDIT_REGEXPS: Readonly<Record<string, ReadonlyArray<RegExp>>> = Object.freeze({
  auditIsRio: [/REMOTE\s*I\/?O|\bRIO\b/],
  auditIsDriveOrStarter: [/^VARIABLE FREQUENCY DRIVE\b|\bVFD SKID\b|\bMOTOR STARTER\b|^VFD\b/],
  auditIsVfd: [/^VARIABLE FREQUENCY DRIVE\b|^VFD\b|\bVFD SKID\b/],
  auditIsPlc: [/\bPLC\b|PROGRAMMABLE LOGIC CONTROLLER/],
  auditIsPanel: [/\bPANEL\b|SWITCHBOARD|SWITCHGEAR|\bMCC\b|PANELBOARD|DISTRIBUTION BOARD/],
  auditIsController: [
    /I\/?O CLUSTER|IO CLUSTER|REMOTE\s*I\/?O|\bRIO\b|\bPLC\b|PROGRAMMABLE LOGIC CONTROLLER|CONTROL PANEL|FIRE ALARM (?:CONTROL )?PANEL|\bFACP\b|GAS DETECTION PANEL|SECURITY CONTROL PANEL/,
  ],
  auditIsControlEquipment: [/FMS (?:CABINET|CONTROLLER)/],
  auditIsDrivenEquipment: [
    /\bPLC\b|PROGRAMMABLE LOGIC CONTROLLER|CONTROL PANEL|\bVFD SKID\b|^VARIABLE FREQUENCY DRIVE\b|\bMOTOR STARTER\b/,
    /AIR HANDLER|\bMAH\b|\bAHU\b|PUMP|\bFAN\b|\bCHILLER\b|\bCOMPRESSOR\b|\bBLOWER\b|\bSCRUBBER\b|\bBOILER\b|COOLING TOWER|\bMIXER\b/,
  ],
  auditIsTransformer: [/TRANSFORMER/],
  auditIsHeatTracePanel: [/HEAT TRACE PANEL|HEAT TRACING PANEL/],
  auditIsHeatTraceConnection: [/HEAT TRACE POWER CONNECTION/],
  auditIsFdu: [/FIBER OPTIC DISTRIBUTION UNIT|\bFDU\b/],
  auditIsVesda: [/\bVESDA\b|VERY EARLY SMOKE/],
  auditIsFireAlarmPanel: [/FIRE ALARM (?:CONTROL )?PANEL|\bFACP\b/],
  auditIsInstrument: [
    /TRANSMITTER|\bSWITCH\b|SENSOR|INDICAT|ANALYZER|ELEMENT|VALVE|DETECTOR|THERMOSTAT|GAUGE|\bMETER\b|PROBE/,
  ],
  auditIsControlValve: [/CONTROL VALVE|\bTCV\b|\bPCV\b|\bFCV\b|\bLCV\b|\bHCV\b/],
  auditIsRoomSensor: [
    /ROOM (?:TEMPERATURE|HUMIDITY|PRESSURE|SENSOR|TEMP)|SPACE (?:TEMPERATURE|HUMIDITY|SENSOR)|ROOM (?:TEMP |)(?:TRANSMITTER|ELEMENT)/,
  ],
  auditIsLcp: [/LOCAL CONTROL PANEL|\bLCP\b/],
  auditIsFmsIo: [/FMS (?:HARDWIRED |)I\/?O|HARDWIRED I\/?O/],
  auditPolarity: [/elec|life safety|security|fire/i],
});

/**
 * One regex out of {@link AUDIT_REGEXPS}, by name and position.
 *
 * A lookup rather than nineteen module constants, so the pinned table is the
 * one place a regex is written and there is no second copy to drift.
 */
function rx(name: string, index = 0): RegExp {
  const found = AUDIT_REGEXPS[name]?.[index];
  if (found === undefined) {
    // Unreachable: the table above is frozen and every call site names an entry
    // in it. Throwing rather than returning a never-matching regex, because a
    // classifier that silently answered "no" would be a wrong hierarchy.
    throw new Error(`no vendored regex ${name}[${String(index)}]`);
  }
  return found;
}

/**
 * A description in the spelling the rulebook compares.
 *
 * `auditNormId` is the engine's own normalizer — trimmed, whitespace collapsed,
 * uppercased — imported rather than restated, because every regex above is
 * written against its output.
 */
function normalized(value: string): string {
  return auditNormId(value);
}

/** `REMOTE I/O`, `RIO`. */
export function isRio(description: string): boolean {
  return rx('auditIsRio').test(normalized(description));
}

/** A variable frequency drive or a motor starter. */
export function isDriveOrStarter(description: string): boolean {
  return rx('auditIsDriveOrStarter').test(normalized(description));
}

/** A variable frequency drive specifically; a motor starter is not one. */
export function isVfd(description: string): boolean {
  return rx('auditIsVfd').test(normalized(description));
}

/** A programmable logic controller. */
export function isPlc(description: string): boolean {
  return rx('auditIsPlc').test(normalized(description));
}

/** Electrical distribution gear: a panel, an MCC, a switchboard. */
export function isPanel(description: string): boolean {
  return rx('auditIsPanel').test(normalized(description));
}

/** Anything that runs something else: a PLC, an RIO, a control panel, a drive. */
export function isController(description: string): boolean {
  return rx('auditIsController').test(normalized(description)) || isDriveOrStarter(description);
}

/** A controller, or an FMS cabinet/controller. */
export function isControlEquipment(description: string): boolean {
  return isController(description) || rx('auditIsControlEquipment').test(normalized(description));
}

/**
 * Rotating and air-moving equipment: a pump, a fan, an air handler, a chiller.
 *
 * The engine also excludes electrical-discipline rows. That half is the
 * caller's — see the module doc.
 */
export function isDrivenEquipment(description: string): boolean {
  const text = normalized(description);
  return (
    !rx('auditIsDrivenEquipment', 0).test(text) && rx('auditIsDrivenEquipment', 1).test(text)
  );
}

/** A transformer. */
export function isTransformer(description: string): boolean {
  return rx('auditIsTransformer').test(normalized(description));
}

/** A heat-trace panel. */
export function isHeatTracePanel(description: string): boolean {
  return rx('auditIsHeatTracePanel').test(normalized(description));
}

/** A heat-trace power connection box. */
export function isHeatTraceConnection(description: string): boolean {
  return rx('auditIsHeatTraceConnection').test(normalized(description));
}

/** A fibre optic distribution unit. */
export function isFdu(description: string): boolean {
  return rx('auditIsFdu').test(normalized(description));
}

/** A VESDA — very early smoke detection. */
export function isVesda(description: string): boolean {
  return rx('auditIsVesda').test(normalized(description));
}

/** A fire alarm control panel. */
export function isFireAlarmPanel(description: string): boolean {
  return rx('auditIsFireAlarmPanel').test(normalized(description));
}

/**
 * Instrument-like: transmitters, switches, sensors, valves, detectors.
 *
 * Panels and controllers are excluded even when their descriptions mention a
 * switch or a valve, exactly as the engine excludes them.
 */
export function isInstrumentLike(description: string): boolean {
  if (isController(description) || isPanel(description)) {
    return false;
  }
  return rx('auditIsInstrument').test(normalized(description));
}

/** A control valve: `CONTROL VALVE`, `TCV`, `PCV`, `FCV`, `LCV`, `HCV`. */
export function isControlValve(description: string): boolean {
  return rx('auditIsControlValve').test(normalized(description));
}

/** A room or space sensor. */
export function isRoomSensor(description: string): boolean {
  return rx('auditIsRoomSensor').test(normalized(description));
}

/** A local control panel. */
export function isLcp(description: string): boolean {
  return rx('auditIsLcp').test(normalized(description));
}

/** FMS hardwired I/O. */
export function isFmsIo(description: string): boolean {
  return rx('auditIsFmsIo').test(normalized(description));
}

/**
 * Which way work flows in a discipline.
 *
 * `top-down` for electrical, life safety, security and fire — the source feeds
 * the load — and `bottom-up` for everything else, where the hierarchy itself
 * sets the order.
 */
export function polarity(discipline: string): 'top-down' | 'bottom-up' {
  return rx('auditPolarity').test(discipline) ? 'top-down' : 'bottom-up';
}

/**
 * The leading run of letters in a tag, uppercased.
 *
 * `VFD101-01` -> `VFD`, `MCC101` -> `MCC`, `101-A` -> `''`.
 */
function rolePrefixOf(tag: string): string {
  const match = /^[A-Za-z]+/.exec(tag.trim());
  return match === null ? '' : match[0].toUpperCase();
}

/**
 * Every classifier, in the one order that resolves their overlaps.
 *
 * The classifiers are not disjoint — a fire alarm control panel is a panel, a
 * controller and control equipment; a local control panel is all three too —
 * so `equipmentClass` is a first-match walk and the order IS the editorial
 * content. It runs most specific to least: the named devices the SOP has rules
 * about, then the two broad buckets, then driven equipment.
 */
const CLASSIFIERS: ReadonlyArray<readonly [EquipmentClass, (description: string) => boolean]> = [
  ['fms-io', isFmsIo],
  ['vesda', isVesda],
  // Before `panel` and `control-equipment`: an FACP is both, and the SOP has a
  // rule about it as an FACP.
  ['facp', isFireAlarmPanel],
  ['heat-trace-panel', isHeatTracePanel],
  ['heat-trace-connection', isHeatTraceConnection],
  ['transformer', isTransformer],
  // Before `plc`: an RIO's description often names the PLC that runs it.
  ['rio', isRio],
  ['plc', isPlc],
  // Before `panel`: an LCP is a control panel, and the SOP places it as an LCP.
  ['lcp', isLcp],
  ['vfd', isVfd],
  ['starter', isDriveOrStarter],
  ['fdu', isFdu],
  // Before `instrument`: both are instrument-like, and both have their own rule.
  ['control-valve', isControlValve],
  ['room-sensor', isRoomSensor],
  ['panel', (description): boolean => isPanel(description) && !isController(description)],
  ['control-equipment', isControlEquipment],
  ['instrument', isInstrumentLike],
  ['driven', isDrivenEquipment],
];

/**
 * What the SOP calls one piece of equipment.
 *
 * The description decides. When it decides nothing — a model that publishes a
 * type name and no description at all is common — the tag's leading letter run
 * is classified instead, and only then: `VFD101-01` yields `VFD`, which is a
 * word the engine's own `\bVFD\b` already recognises. That is the engine's
 * vocabulary applied to a second string, not a second vocabulary; a site's own
 * role letters (`MAH`, `TIT`, `PT`) are NOT read here, because what `PT` means
 * is a fact about a site and belongs in the role graph a person confirms.
 */
export function equipmentClass(description: string, tag = ''): EquipmentClass {
  for (const [name, predicate] of CLASSIFIERS) {
    if (predicate(description)) {
      return name;
    }
  }
  const prefix = rolePrefixOf(tag);
  if (prefix === '') {
    return 'other';
  }
  for (const [name, predicate] of CLASSIFIERS) {
    if (predicate(prefix)) {
      return name;
    }
  }
  return 'other';
}
