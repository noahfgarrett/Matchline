/**
 * What kind of thing a piece of equipment is, in the SSM SOP's own vocabulary.
 *
 * The SOP does not nest by discipline or by system alone: it nests by what a
 * device *is*. A drive goes under the equipment it runs, a heat-trace panel
 * goes under its transformer, an instrument goes under the equipment it
 * serves. So the rules need a word for "this row is a VFD" that is stable
 * enough to key a rule table on.
 *
 * The words are the SSM-Audit rulebook's own classifiers, one member per
 * `auditIsX` predicate the vendored engine carries plus the two the engine
 * expresses as regexes inside a larger rule (`fms-io`) or as the absence of
 * every other one (`other`). `@matchline/ssm-audit`'s `classify` module is
 * what decides which member a description falls into, and its regexes are
 * pinned to the engine's by test. Nothing here classifies anything; this is
 * only the vocabulary, so that a Site Profile, a hierarchy level's boundary
 * exception and a compile subject can all name a class without depending on
 * the rulebook package.
 */

/** One SOP equipment class. `other` is "none of the rulebook's classifiers hit". */
export type EquipmentClass =
  | 'vfd'
  | 'starter'
  | 'plc'
  | 'rio'
  | 'panel'
  | 'transformer'
  | 'heat-trace-panel'
  | 'heat-trace-connection'
  | 'lcp'
  | 'control-valve'
  | 'room-sensor'
  | 'instrument'
  | 'fms-io'
  | 'fdu'
  | 'vesda'
  | 'facp'
  | 'driven'
  | 'control-equipment'
  | 'other';

/** Every {@link EquipmentClass}, for callers that walk the union at runtime. */
export const EQUIPMENT_CLASSES = [
  'vfd',
  'starter',
  'plc',
  'rio',
  'panel',
  'transformer',
  'heat-trace-panel',
  'heat-trace-connection',
  'lcp',
  'control-valve',
  'room-sensor',
  'instrument',
  'fms-io',
  'fdu',
  'vesda',
  'facp',
  'driven',
  'control-equipment',
  'other',
] as const satisfies ReadonlyArray<EquipmentClass>;

/**
 * Compile-time completeness guard. A member added to {@link EquipmentClass}
 * without being added to {@link EQUIPMENT_CLASSES} resolves this to `false` and
 * the assignment below stops compiling.
 */
type EveryEquipmentClassListed =
  Exclude<EquipmentClass, (typeof EQUIPMENT_CLASSES)[number]> extends never ? true : false;

const EQUIPMENT_CLASSES_ARE_COMPLETE: EveryEquipmentClassListed = true;
void EQUIPMENT_CLASSES_ARE_COMPLETE;

/**
 * The classes that nest under something else by tag pairing (Noah's directive).
 *
 * "Instruments need to be placed under their respective parents. The UPN will
 * be available within the equipment tag like: MAH101-01 has a VFD101-01 down
 * the line as a child." These are the classes on the child side of that
 * sentence: a device carries the UPN and instance of the equipment it serves,
 * and the SOP rules look for that equipment rather than for a model nesting.
 */
export const SOP_DEVICE_CLASSES = [
  'vfd',
  'starter',
  'lcp',
  'control-valve',
  'room-sensor',
  'instrument',
  'fdu',
  'fms-io',
] as const satisfies ReadonlyArray<EquipmentClass>;

/**
 * The classes a device may pair to.
 *
 * Deliberately narrower than "everything else": a device pairs to equipment,
 * and a VESDA, an FACP or a heat-trace connection box is not equipment a drive
 * or a transmitter hangs off. Precedence *within* this list is the pairing
 * rule's own (a VFD pairs to the driven equipment, not to a panel).
 */
export const SOP_EQUIPMENT_CLASSES = [
  'driven',
  'panel',
  'transformer',
  'plc',
  'rio',
  'control-equipment',
] as const satisfies ReadonlyArray<EquipmentClass>;

/** Whether a class is on the child side of a tag pairing. */
export function isSopDeviceClass(value: EquipmentClass): boolean {
  return (SOP_DEVICE_CLASSES as ReadonlyArray<EquipmentClass>).includes(value);
}

/** Whether a class is on the parent side of a tag pairing. */
export function isSopEquipmentClass(value: EquipmentClass): boolean {
  return (SOP_EQUIPMENT_CLASSES as ReadonlyArray<EquipmentClass>).includes(value);
}
