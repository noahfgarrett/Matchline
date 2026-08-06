import { RULES_SCHEMA_VERSION, emptyRuleSet } from './schema.js'

export const EAGLE_PRESET_ID = 'eagle'
export const EAGLE_PRESET_VERSION = 2
export const EAGLE_PROFILE_NAME = 'Eagle - SSM Builder Legacy'

/* The two hierarchies the app shipped with, as data. Reproduces today's output
   exactly: the grouping attributes and their fallback labels are the ones
   groupFor used, and the flow level is the parent chaining `attach` did. */
export function makeExampleModes(){
  return [
    { id:'electrical-flow', name:'Electrical Flow', icon:'zap',
      caption:'Power relationships across disciplines',
      executor:'raw',
      rootPolicy:{ requireRoot:'602 Medium Voltage', fallbackParent:'602 Medium Voltage' },
      levels:[{kind:'flow'}] },
    { id:'ssm', name:'SSM Hierarchy', icon:'folder-tree',
      caption:'Building / Discipline / System organization',
      executor:'projected',
      levels:[
        {kind:'grouping', attribute:'building',   fallback:'Unassigned Building'},
        {kind:'grouping', attribute:'discipline', fallback:'Unassigned Discipline'},
        {kind:'grouping', attribute:'system',     fallback:'Unassigned System'},
        {kind:'flow'},
      ] },
  ];
}

/**
 * The shipped example profile. Encodes the conventions this app used to
 * hardcode, so a new site starts from something that works and edits it,
 * rather than from a blank page.
 *
 * Ordering matters where noted — these mirror first-match-wins behavior
 * in the code they replace.
 */
export function makeEagleRuleProfile() {
  const rules = emptyRuleSet()

  // Normalize — all matching rules apply, in this order.
  //
  // Panel sides run BEFORE the power variant. This mirrors
  // stripPowerVariant(x) in src/hierarchy/build.js, which is
  // cleanTag(x).replace(/[_-](?:NPS|CPS)$/i,''): cleanTag strips the
  // terminal P/S/A/B/OUTPUT suffix as part of cleanTag itself, and only
  // then is the NPS/CPS variant stripped from what's left. Applying the
  // variant strip first (as an earlier draft of this profile did) leaves
  // a tag like 'PNL-1_CPS-A' at 'PNL-1_CPS' instead of 'PNL-1', because
  // the trailing '-A' hides the '_CPS' ending until the side is gone.
  rules.normalize.push(
    { id: 'norm-panel-sides', name: 'Panel side endings are one asset', kind: 'stripSuffix',
      separators: ['-'], suffixes: ['P', 'S', 'A', 'B', 'OUTPUT'], repeat: true, enabled: true,
      stage: 'identity',
      note: 'Tags ending in -A, -B, -P, -S, or -OUTPUT are two halves of the same panel, so the ending is removed and both spellings count as one piece of equipment everywhere. Turn this off if your site uses these endings for genuinely separate assets.' },
    { id: 'norm-power-variant', name: 'Dual power feeds are one asset', kind: 'stripSuffix',
      separators: ['_', '-'], suffixes: ['NPS', 'CPS'], repeat: false, enabled: true,
      stage: 'matching',
      note: 'Tags ending in _CPS or _NPS are the two power supplies of one piece of equipment. The ending is ignored when matching records between documents, but stays visible in the tag itself.' },
  )

  // Classify — first match wins per target. GIS/XFM/LVS order is load-bearing.
  rules.classify.push(
    { id: 'role-gis', name: 'Gas-insulated switchgear (GIS)', kind: 'pattern', target: 'equipmentType',
      pattern: '(?:^|[-_])GIS', value: 'GIS', enabled: true },
    { id: 'role-xfm', name: 'Transformer (XFM)', kind: 'pattern', target: 'equipmentType',
      pattern: '(?:^|[-_])XFM', value: 'XFM', enabled: true },
    { id: 'role-lvs', name: 'Low-voltage switchgear (LVS)', kind: 'pattern', target: 'equipmentType',
      pattern: '(?:^|[-_])LV[A-Z0-9]*', value: 'LVS', enabled: true },
    { id: 'topology-gis-token', name: 'GIS topology marker', kind: 'pattern', target: 'gisMarker',
      pattern: '(?:^|[^A-Z])GIS(?:[^A-Z]|$)', value: 'yes', source: 'raw', enabled: true,
      note: 'Marks a tag as part of the GIS ring so the electrical flow view can re-root GIS-to-GIS runs correctly. Edit the pattern if your site writes GIS differently.' },
    { id: 'topology-bus-token', name: 'BUS topology marker', kind: 'pattern', target: 'busMarker',
      pattern: '(?:^|[^A-Z])BUS(?:[^A-Z]|$)', value: 'yes', source: 'raw', enabled: true,
      note: 'Marks a tag as a bus section between GIS gear so the electrical flow view can re-root those runs correctly. Edit the pattern if your site names bus sections differently.' },
    // Placeholder rules read the RAW tag (source: 'raw'), not the
    // canonical one. isSpareName/isSpaceName/isNote in
    // src/profile/classify.js run on clean(value) with no normalisation
    // applied first — e.g. isNote('NOTE-A') is false, because the '-A'
    // suffix is still there. Classifying the canonical tag instead would
    // strip '-A' before the pattern runs and wrongly call it a note.
    { id: 'ph-spare-sp', name: 'Spare breaker (SP- prefix)', kind: 'pattern', target: 'placeholder',
      pattern: '^sp-', value: 'spare', source: 'raw', enabled: true },
    { id: 'ph-spare-word', name: 'Spare breaker (the word Spare)', kind: 'pattern', target: 'placeholder',
      pattern: '^spare(?:[\\s\\-_\\d]|$)', value: 'spare', source: 'raw', enabled: true },
    { id: 'ph-space', name: 'Empty panel space', kind: 'pattern', target: 'placeholder',
      pattern: '^space(?:[\\s\\-_\\d]|$)', value: 'space', source: 'raw', enabled: true },
    { id: 'ph-note', name: 'Drawing note, not equipment', kind: 'pattern', target: 'placeholder',
      pattern: '^note\\s*\\d*$', value: 'note', source: 'raw', enabled: true },
    // minLength mirrors equipmentSuffix's guard (tag.length>=4); lowercase
    // mirrors its .toLowerCase() so the engine's output is directly usable
    // without callers remembering to normalise case themselves.
    { id: 'match-last4', name: 'Pairing key (last four characters)', kind: 'slice', target: 'matchKey',
      start: -4, minLength: 4, lowercase: true, enabled: true,
      note: 'The last four characters of a tag, used to pair equipment that shares numbering — for example a switchgear with the transformer that feeds it.' },
  )

  // Relate — first RESOLVED or AMBIGUOUS rule wins. Order mirrors
  // melSyntheticParent (SCR/SCC before CIM) in src/hierarchy/build.js, and
  // the GIS root is last because it only fires when nothing else placed
  // the tag (requiresNoParent).
  rules.relate.push(
    { id: 'scr-scc-parent', name: 'SCR / SCC gear reports to its unit', kind: 'fragmentLookup',
      markers: ['SCR-', 'SCC-'], source: 'mel', mode: 'containing',
      onMultiple: 'first',
      buildingFrom: 'tagBeforeFirst', buildingDelimiter: '-',
      unitFrom: 'fragmentBeforeFirst', unitDelimiter: '_',
      parent: [{ kind: 'part', name: 'building' }, { kind: 'literal', text: '-' }, { kind: 'part', name: 'unit' }],
      enabled: true,
      note: 'A tag containing SCR- or SCC- is placed under its unit, named "<Building>-<unit>", found by looking the fragment up in the MEL. SCR is checked before SCC.' },
    { id: 'cim-parent', name: 'CIM gear reports to the building CIM rack', kind: 'fragmentLookup',
      markers: ['-CIM'], fragmentFrom: 'wholeTag', source: 'mel', mode: 'containing',
      onMultiple: 'first',
      parent: [{ kind: 'column', name: 'Building' }, { kind: 'literal', text: ' - CIM' }],
      enabled: true,
      note: 'A tag containing -CIM is placed under "<Building> - CIM", using the Building column of the MEL record it matches. Change the text if your site names CIM racks differently.' },
    { id: 'mah-parent', name: 'MAH equipment carries its parent in the tag', kind: 'prefixSplit',
      delimiter: '_', pattern: '-MAH', tagSource: 'raw', alsoCurrentParent: true, cleanPrefix: true, enabled: true,
      note: 'When a tag contains -MAH, everything before its first underscore names the parent — the tag carries its own placement, no lookup needed. Example: B14-MAH-01_FAN-2 is placed under B14-MAH-01.' },
    { id: 'transformer-match', name: 'Switchgear pairs with its transformer by numbering', kind: 'attributeMatch',
      source: 'mel', when: { equipmentType: 'LVS' }, whenParent: { equipmentType: 'XFM' },
      whenDiffers: 'matchKey',
      match: { equipmentType: 'XFM', matchKey: '@matchKey' },
      preferExactTag: { attribute: 'matchKey' },
      ambiguousReason: 'Multiple MEL transformers share the matching final four characters',
      emptyReason: 'No MEL transformer has matching final four characters',
      enabled: true,
      note: 'Low-voltage switchgear is fed by the transformer that shares the last four characters of its tag, found in the MEL. If the switchgear\'s current parent already shares those characters, nothing changes. When several transformers share the same four characters, the closest exact tag match wins; otherwise the tie is flagged for review.' },
    { id: 'gis-system-root', name: 'Unparented GIS roots under Medium Voltage', kind: 'constant',
      pattern: 'GIS', requiresNoParent: true, parent: '602 Medium Voltage', enabled: true,
      note: 'A GIS tag that nothing else placed sits at the top of "602 Medium Voltage". Rename the parent to match your site\'s medium-voltage system name.' },
  )

  return {
    schemaVersion: RULES_SCHEMA_VERSION,
    name: EAGLE_PROFILE_NAME,
    presetId: EAGLE_PRESET_ID,
    presetVersion: EAGLE_PRESET_VERSION,
    builtIn: true,
    locked: true,
    anatomies: [],
    modes: makeExampleModes(),
    rules,
  }
}

/* Compatibility alias for the P1/P2 equivalence harness. New application code
   should name the preset it is actually requesting. */
export function makeExampleProfile() {
  return makeEagleRuleProfile()
}
