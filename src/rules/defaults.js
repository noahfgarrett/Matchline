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
    { id: 'norm-panel-sides', name: 'Panel side (-A / -B / -P / -S / -OUTPUT)', kind: 'stripSuffix',
      separators: ['-'], suffixes: ['P', 'S', 'A', 'B', 'OUTPUT'], repeat: true, enabled: true,
      stage: 'identity',
      note: 'Two sides of one panel, commissioned whole. Turn this off if your site uses these to mean separate assets. ' +
        'stage "identity" is what cleanTag applies — the panel-side strip is treated as part of a tag\'s identity ' +
        'everywhere, including in display names and register rows.' },
    { id: 'norm-power-variant', name: 'Power variant (_CPS / _NPS)', kind: 'stripSuffix',
      separators: ['_', '-'], suffixes: ['NPS', 'CPS'], repeat: false, enabled: true,
      stage: 'matching',
      note: 'Two supplies of the same equipment. Not part of its identity. stage "matching" is what ' +
        'stripPowerVariant adds on top of cleanTag — used only where two supplies of one asset need to be ' +
        'paired up (MEL lookups, transformer matching), not in the identity a user sees.' },
  )

  // Classify — first match wins per target. GIS/XFM/LVS order is load-bearing.
  rules.classify.push(
    { id: 'role-gis', name: 'GIS', kind: 'pattern', target: 'equipmentType',
      pattern: '(?:^|[-_])GIS', value: 'GIS', enabled: true },
    { id: 'role-xfm', name: 'Transformer', kind: 'pattern', target: 'equipmentType',
      pattern: '(?:^|[-_])XFM', value: 'XFM', enabled: true },
    { id: 'role-lvs', name: 'LV switchgear', kind: 'pattern', target: 'equipmentType',
      pattern: '(?:^|[-_])LV[A-Z0-9]*', value: 'LVS', enabled: true },
    { id: 'topology-gis-token', name: 'GIS topology marker', kind: 'pattern', target: 'gisMarker',
      pattern: '(?:^|[^A-Z])GIS(?:[^A-Z]|$)', value: 'yes', source: 'raw', enabled: true,
      note: 'Identifies GIS hops for the legacy GIS / BUS / GIS re-rooting rule. Keeping this separate ' +
        'from Equipment Type lets a project teach a different GIS marker without hidden text checks.' },
    { id: 'topology-bus-token', name: 'BUS topology marker', kind: 'pattern', target: 'busMarker',
      pattern: '(?:^|[^A-Z])BUS(?:[^A-Z]|$)', value: 'yes', source: 'raw', enabled: true,
      note: 'Identifies BUS hops for the legacy GIS / BUS / GIS re-rooting rule. Clone Eagle and edit ' +
        'this pattern when a site uses a different bus nomenclature.' },
    // Placeholder rules read the RAW tag (source: 'raw'), not the
    // canonical one. isSpareName/isSpaceName/isNote in
    // src/profile/classify.js run on clean(value) with no normalisation
    // applied first — e.g. isNote('NOTE-A') is false, because the '-A'
    // suffix is still there. Classifying the canonical tag instead would
    // strip '-A' before the pattern runs and wrongly call it a note.
    { id: 'ph-spare-sp', name: 'Spare (SP- prefix)', kind: 'pattern', target: 'placeholder',
      pattern: '^sp-', value: 'spare', source: 'raw', enabled: true },
    { id: 'ph-spare-word', name: 'Spare (word)', kind: 'pattern', target: 'placeholder',
      pattern: '^spare(?:[\\s\\-_\\d]|$)', value: 'spare', source: 'raw', enabled: true },
    { id: 'ph-space', name: 'Space', kind: 'pattern', target: 'placeholder',
      pattern: '^space(?:[\\s\\-_\\d]|$)', value: 'space', source: 'raw', enabled: true },
    { id: 'ph-note', name: 'Note', kind: 'pattern', target: 'placeholder',
      pattern: '^note\\s*\\d*$', value: 'note', source: 'raw', enabled: true },
    // minLength mirrors equipmentSuffix's guard (tag.length>=4); lowercase
    // mirrors its .toLowerCase() so the engine's output is directly usable
    // without callers remembering to normalise case themselves.
    { id: 'match-last4', name: 'Match key (last four characters)', kind: 'slice', target: 'matchKey',
      start: -4, minLength: 4, lowercase: true, enabled: true,
      note: 'Used to pair LV switchgear with its transformer.' },
  )

  // Relate — first RESOLVED or AMBIGUOUS rule wins. Order mirrors
  // melSyntheticParent (SCR/SCC before CIM) in src/hierarchy/build.js, and
  // the GIS root is last because it only fires when nothing else placed
  // the tag (requiresNoParent).
  rules.relate.push(
    { id: 'scr-scc-parent', name: 'SCR/SCC parent from the MEL', kind: 'fragmentLookup',
      markers: ['SCR-', 'SCC-'], source: 'mel', mode: 'containing',
      onMultiple: 'first',
      buildingFrom: 'tagBeforeFirst', buildingDelimiter: '-',
      unitFrom: 'fragmentBeforeFirst', unitDelimiter: '_',
      parent: [{ kind: 'part', name: 'building' }, { kind: 'literal', text: '-' }, { kind: 'part', name: 'unit' }],
      enabled: true,
      note: 'Site convention: SCR/SCC gear reports to "<Building>-<unit>", read off the MEL record ' +
        'the SCR-/SCC- fragment is contained in. SCR is tried first; a tag with both markers that fails ' +
        'to match on SCR never tries SCC (reproduces melScrSccParent\'s early return).' },
    { id: 'cim-parent', name: 'CIM parent from the MEL', kind: 'fragmentLookup',
      markers: ['-CIM'], fragmentFrom: 'wholeTag', source: 'mel', mode: 'containing',
      onMultiple: 'first',
      parent: [{ kind: 'column', name: 'Building' }, { kind: 'literal', text: ' - CIM' }],
      enabled: true,
      note: 'Site convention: CIM gear reports to "<Building> - CIM", where Building comes from the ' +
        'matched MEL record\'s Building column. Change the literal if your site names CIM racks differently.' },
    { id: 'mah-parent', name: 'MAH parent from the tag itself', kind: 'prefixSplit',
      delimiter: '_', pattern: '-MAH', tagSource: 'raw', alsoCurrentParent: true, cleanPrefix: true, enabled: true,
      note: 'Site convention: everything before the first "_" is the parent when that prefix contains ' +
        '"-MAH". No MEL lookup needed — the tag carries its own parent. tagSource is "raw" (cleanTag, ' +
        'power variant NOT stripped) because mahClosestParent splits on the tag\'s own "_" before any ' +
        'power-variant handling runs; the canonical tag would already have consumed a trailing "_CPS"/' +
        '"_NPS" as the power variant, erasing the very underscore this rule looks for. cleanPrefix then ' +
        're-strips the panel side from the extracted prefix: without it "B14-MAH-01-A_CPS" would report ' +
        'its parent as "B14-MAH-01-A", a tag no canonical node carries.' },
    { id: 'transformer-match', name: 'LV switchgear to its MEL transformer', kind: 'attributeMatch',
      source: 'mel', when: { equipmentType: 'LVS' }, whenParent: { equipmentType: 'XFM' },
      whenDiffers: 'matchKey',
      match: { equipmentType: 'XFM', matchKey: '@matchKey' },
      preferExactTag: { attribute: 'matchKey' },
      ambiguousReason: 'Multiple MEL transformers share the matching final four characters',
      emptyReason: 'No MEL transformer has matching final four characters',
      enabled: true,
      note: 'Site convention: LV switchgear is fed by the MEL transformer sharing its last four ' +
        'characters. whenDiffers reproduces melTransformerDecision\'s "matched" early-out: if the switchgear ' +
        'and its current parent already share their last four characters, this rule does not fire at all — a ' +
        '`none` decision, which means "keep the current parent" — rather than resolving to the same parent ' +
        'through a lookup. preferExactTag applies an exact-tag heuristic: before ' +
        'reporting several candidates as ambiguous, it tries "<current parent, minus its own last four ' +
        'characters><this equipment\'s last four characters>" as a literal MEL tag; if that composed tag ' +
        'exists and is itself a transformer, it wins even though other transformers share the same suffix.' },
    { id: 'gis-system-root', name: 'GIS system root', kind: 'constant',
      pattern: 'GIS', requiresNoParent: true, parent: '602 Medium Voltage', enabled: true,
      note: 'Site convention: an otherwise-unparented GIS tag roots under "602 Medium Voltage". ' +
        'Rename the parent to match your site\'s medium-voltage system name.' },
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
