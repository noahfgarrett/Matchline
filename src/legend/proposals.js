import { clean } from '../core/text.js'
import { legendNormalizeCode, legendRuleId } from './model.js'
import { legendEmptyCorpus } from './corpus.js'

/* ---- rule proposals ----
   Knowledge becomes ordinary profile rules here -- the same anatomy, Normalize,
   Classify, and Relate structures the engine already executes. No dictionary
   runtime, no new operator, no second class of rule the engineer cannot edit.

   Two rules govern everything below.

   PREFER ONE ANATOMY AND A GENERIC SEGMENT RULE over one pattern rule per
   abbreviation. A legend with sixty codes otherwise produces sixty rules, and a
   profile nobody can read is a profile nobody can correct.

   ESCAPE EVERY CHARACTER THAT CAME FROM THE DOCUMENT. Legend text contains
   parentheses, dots, slashes, and plus signs. Interpolated raw into a pattern,
   `A/B (typ.)` compiles into something that matches far more than it should. */

export const LEGEND_RISK_LEVELS = Object.freeze(['low', 'medium', 'high'])

/** Attributes a legend may classify into without declaring a custom attribute. */
export const LEGEND_CLASSIFY_TARGETS = Object.freeze([
  'building', 'discipline', 'system', 'equipmentType', 'matchKey',
  'placeholder', 'gisMarker', 'busMarker',
])

const LEGEND_RISK_BY_FAMILY = Object.freeze({
  anatomy: 'medium',
  classify: 'low',
  normalize: 'high',
  relate: 'high',
})

/** Escape text taken from a document so it can appear inside a pattern. */
export function legendEscapeRegex(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function legendSegmentName(attribute) {
  return clean(attribute) || 'segment'
}

/** Rule ids present in the base preset, so inherited fallbacks can be told apart. */
export function legendBaseRuleIds(baseProfile) {
  const ids = new Set()
  for (const anatomy of (baseProfile && baseProfile.anatomies) || []) if (anatomy && anatomy.id) ids.add(anatomy.id)
  const rules = (baseProfile && baseProfile.rules) || {}
  for (const family of ['normalize', 'classify', 'relate']) {
    for (const rule of rules[family] || []) if (rule && rule.id) ids.add(rule.id)
  }
  return ids
}

/**
 * Where a proposed rule should sit.
 *
 * Classify is first-match-wins per target and Relate is first-resolved-wins, so
 * position decides whether a rule does anything at all. A legend rule belongs
 * ahead of the inherited fallback for its target -- that is the point of
 * teaching the app the site's own convention -- but behind anything the
 * engineer authored themselves, which must never be displaced silently. With no
 * inherited rule to get in front of, it appends and displaces nothing.
 */
export function legendInsertIndex(rules, target, baseIds) {
  const list = rules || []
  const scope = clean(target)
  for (let index = 0; index < list.length; index++) {
    const rule = list[index]
    if (!rule) continue
    if (scope && clean(rule.target) !== scope) continue
    if (baseIds && baseIds.has(rule.id)) return index
  }
  return list.length
}

function legendCodesFor(entries) {
  const codes = []
  const seen = new Set()
  for (const entry of entries) {
    const code = legendNormalizeCode(entry.code)
    if (!code || seen.has(code)) continue
    seen.add(code)
    codes.push({ code, meaning: entry.meaning, entryId: entry.id })
  }
  return codes
}

/**
 * The delimiter-and-index position every one of these codes occupies in the
 * corpus, or null when they do not agree.
 *
 * Agreement is the whole justification for a single generic rule: if every code
 * the legend defines sits at segment 1 of a hyphen-delimited tag, one rule
 * reading segment 1 covers all of them and will keep covering codes the legend
 * never mentioned.
 */
export function legendConsistentSegment(codes, corpus) {
  if (!codes.length || !corpus || !corpus.size) return null
  for (const delimiter of ['-', '_', '.', '/']) {
    for (let index = 0; index < 5; index++) {
      let supported = 0
      for (const { code } of codes) if (corpus.segmentMatches(delimiter, index, code).size) supported++
      if (supported >= 2 && supported >= Math.ceil(codes.length * 0.6)) {
        return { delimiter, index, supported, total: codes.length }
      }
    }
  }
  return null
}

function legendConfidence(parts) {
  const total = parts.reduce((sum, part) => sum + part.delta, 0)
  return { confidence: Math.min(1, Math.max(0, total)), confidenceReasons: parts }
}

function legendProposal(input) {
  const family = input.family
  const risk = input.risk || LEGEND_RISK_BY_FAMILY[family] || 'high'
  return {
    id: input.id,
    family,
    target: clean(input.target),
    rule: input.rule,
    entryIds: input.entryIds || [],
    kind: input.kind || family,
    title: input.title,
    risk,
    /* Ids of proposals this one cannot work without. A Classify `segment` rule
       names an anatomy segment, and the compiler rejects it outright when that
       segment is undefined -- so simulating it alone, without the anatomy from
       the same batch, reports "does not pass profile validation" for a rule
       that is perfectly valid in the batch it belongs to. */
    dependsOn: input.dependsOn || [],
    insertIndex: input.insertIndex == null ? 0 : input.insertIndex,
    confidence: input.confidence,
    confidenceReasons: input.confidenceReasons,
    unverified: !!input.unverified,
    duplicateOf: input.duplicateOf || '',
    matches: input.matches || 0,
    preselected: false,
    blockedReason: '',
  }
}

/* ---- anatomy ---- */

function legendAnatomyProposal(entries, profile, corpus) {
  const segments = new Map()
  const used = []
  let delimiter = '-'
  for (const entry of entries) {
    const detail = entry.detail || {}
    if (detail.form === 'anatomy') {
      delimiter = detail.delimiter || delimiter
      for (const segment of detail.segments || []) segments.set(segment.index, segment.attribute)
      used.push(entry.id)
    } else if (detail.form === 'segment') {
      delimiter = detail.delimiter || delimiter
      segments.set(detail.index, detail.attribute)
      used.push(entry.id)
    }
  }
  if (!segments.size) return null

  const ordered = [...segments.entries()].sort((left, right) => left[0] - right[0])
  const parts = ordered.map(([, attribute]) => `[^${legendEscapeRegex(delimiter)}]+`)
  const rule = {
    id: '',
    name: 'Site tag anatomy',
    /* Anchored and bounded. An unanchored pattern would select this anatomy for
       any tag merely containing a delimiter, and selecting the wrong anatomy
       silently rewrites the canonical identity of every such tag. */
    pattern: `^${parts.join(legendEscapeRegex(delimiter))}(?:${legendEscapeRegex(delimiter)}.*)?$`,
    delimiter,
    segments: ordered.map(([index, attribute]) => ({ name: legendSegmentName(attribute), index, identity: true })),
  }
  rule.id = legendRuleId('anatomy', '', { pattern: rule.pattern, delimiter, segments: rule.segments })

  const existing = ((profile && profile.anatomies) || []).find(item => item && item.pattern === rule.pattern && item.delimiter === delimiter)
  const support = corpus && corpus.size
    ? [...corpus.byNormalized.keys()].filter(key => new RegExp(rule.pattern, 'i').test(key)).length
    : 0
  const { confidence, confidenceReasons } = legendConfidence([
    { label: 'Stated explicitly in the document', delta: 0.6 },
    { label: `${rule.segments.length} segments named`, delta: Math.min(0.2, rule.segments.length * 0.07) },
    corpus && corpus.size
      ? { label: `${support} of ${corpus.distinct} project tags fit the pattern`, delta: support ? Math.min(0.2, support / Math.max(1, corpus.distinct) * 0.2) : -0.4 }
      : { label: 'No project tags loaded to confirm the shape', delta: -0.25 },
  ])

  return legendProposal({
    id: rule.id, family: 'anatomy', target: '', rule, entryIds: used,
    title: `Tag anatomy: ${rule.segments.map(segment => segment.name).join(delimiter)}`,
    insertIndex: ((profile && profile.anatomies) || []).length,
    confidence, confidenceReasons,
    unverified: !(corpus && corpus.size),
    duplicateOf: existing ? existing.id : '',
    matches: support,
  })
}

/* ---- classify ---- */

function legendClassifyProposals(entries, profile, corpus, anatomyProposal, baseIds) {
  const proposals = []
  const byTarget = new Map()
  for (const entry of entries) {
    const target = clean(entry.targetHint)
    if (!target || !LEGEND_CLASSIFY_TARGETS.includes(target)) continue
    if (entry.unresolved) continue
    if (!byTarget.has(target)) byTarget.set(target, [])
    byTarget.get(target).push(entry)
  }

  const anatomies = [...((profile && profile.anatomies) || [])]
  if (anatomyProposal) anatomies.push(anatomyProposal.rule)

  for (const [target, group] of byTarget) {
    const codes = legendCodesFor(group)
    if (!codes.length) continue
    const segmentName = legendSegmentName(target)
    const anatomy = anatomies.find(item => (item.segments || []).some(segment => segment.name === segmentName))
    const existing = ((profile && profile.rules && profile.rules.classify) || [])
    const insertIndex = legendInsertIndex(existing, target, baseIds)

    if (anatomy) {
      /* ONE rule for the whole block. It reads whatever the segment holds, so
         it also covers codes this legend never listed -- which is what makes it
         worth preferring over a rule per code. */
      const rule = {
        id: '', name: `${target} from tag segment`, kind: 'segment',
        segment: segmentName, target, enabled: true,
      }
      rule.id = legendRuleId('classify', target, { kind: 'segment', segment: segmentName, target })
      const duplicate = existing.find(item => item && item.kind === 'segment' && item.segment === segmentName && clean(item.target) === target)
      const supported = corpus && corpus.size
        ? codes.filter(({ code }) => anatomy.segments.some(segment =>
          segment.name === segmentName && corpus.segmentMatches(anatomy.delimiter || '-', segment.index, code).size)).length
        : 0
      const { confidence, confidenceReasons } = legendConfidence([
        { label: `${codes.length} codes listed under a "${target}" heading`, delta: 0.55 },
        { label: 'Covered by a named anatomy segment', delta: 0.2 },
        corpus && corpus.size
          ? { label: `${supported} of ${codes.length} codes found in project tags`, delta: supported ? Math.min(0.25, supported / codes.length * 0.25) : -0.5 }
          : { label: 'No project tags loaded to confirm', delta: -0.3 },
      ])
      const fromProposedAnatomy = !!(anatomyProposal && anatomyProposal.rule === anatomy)
      proposals.push(legendProposal({
        id: rule.id, family: 'classify', target, rule, entryIds: group.map(entry => entry.id),
        title: `Classify ${target} from the ${segmentName} segment`,
        dependsOn: fromProposedAnatomy ? [anatomyProposal.id] : [],
        insertIndex, confidence, confidenceReasons,
        unverified: !(corpus && corpus.size),
        duplicateOf: duplicate ? duplicate.id : '',
        matches: supported,
      })
      )
      continue
    }

    /* No anatomy names this target, so fall back to bounded per-code rules --
       and only for codes the corpus actually contains. The compiler requires a
       Classify `segment` rule to name a defined anatomy segment, so without one
       the only bounded options are slice and pattern. */
    const position = legendConsistentSegment(codes, corpus)
    for (const { code, meaning, entryId } of codes) {
      const supportSet = position
        ? corpus.segmentMatches(position.delimiter, position.index, code)
        : (corpus && corpus.size ? corpus.prefixMatches(code) : new Set())
      const support = supportSet.size
      if (corpus && corpus.size && !support) continue
      const pattern = position
        ? `(^|${legendEscapeRegex(position.delimiter)})${legendEscapeRegex(code)}(${legendEscapeRegex(position.delimiter)}|$)`
        : `^${legendEscapeRegex(code)}(${legendEscapeRegex('-')}|$)`
      const rule = {
        id: '', name: `${code} is ${target}`, kind: 'pattern',
        pattern, value: code, target, enabled: true,
      }
      rule.id = legendRuleId('classify', target, { kind: 'pattern', pattern, value: code, target })
      const duplicate = existing.find(item => item && item.kind === 'pattern' && item.pattern === pattern && clean(item.target) === target)
      const { confidence, confidenceReasons } = legendConfidence([
        { label: `Defined in the document as "${meaning}"`, delta: 0.5 },
        position ? { label: `Consistently at segment ${position.index + 1}`, delta: 0.2 } : { label: 'No consistent tag position found', delta: -0.1 },
        corpus && corpus.size
          ? { label: `${support} project tags carry this code`, delta: Math.min(0.3, support * 0.05) }
          : { label: 'No project tags loaded to confirm', delta: -0.3 },
      ])
      proposals.push(legendProposal({
        id: rule.id, family: 'classify', target, rule, entryIds: [entryId],
        title: `Classify ${code} as ${target}`,
        insertIndex, confidence, confidenceReasons,
        unverified: !(corpus && corpus.size),
        duplicateOf: duplicate ? duplicate.id : '',
        matches: support,
      }))
    }
  }
  return proposals
}

/**
 * "Characters 1 through 3 indicate Building" becomes a Classify slice rule.
 *
 * A character range is a positional claim about the tag, not a code list, so it
 * needs no abbreviations to back it and produces one rule that covers every tag
 * long enough to have those characters. It is NOT an anatomy: an anatomy
 * restructures identity, while a slice only reads.
 */
function legendSliceProposals(entries, profile, corpus, baseIds) {
  const proposals = []
  const existing = (profile && profile.rules && profile.rules.classify) || []
  for (const entry of entries) {
    const detail = entry.detail || {}
    if (detail.form !== 'slice') continue
    const target = clean(detail.attribute)
    if (!target || !LEGEND_CLASSIFY_TARGETS.includes(target)) continue
    const rule = {
      id: '', name: `${target} from characters ${detail.start + 1}-${detail.end}`, kind: 'slice',
      start: detail.start, end: detail.end, minLength: detail.end, target, enabled: true,
    }
    rule.id = legendRuleId('classify', target, { kind: 'slice', start: detail.start, end: detail.end, target })
    const duplicate = existing.find(item => item && item.kind === 'slice'
      && item.start === detail.start && item.end === detail.end && clean(item.target) === target)
    const covered = corpus && corpus.size
      ? [...corpus.byNormalized.keys()].filter(key => key.length >= detail.end).length
      : 0
    const { confidence, confidenceReasons } = legendConfidence([
      { label: 'Stated explicitly as a character range', delta: 0.6 },
      corpus && corpus.size
        ? { label: `${covered} of ${corpus.distinct} project tags are long enough`, delta: covered ? Math.min(0.3, covered / Math.max(1, corpus.distinct) * 0.3) : -0.5 }
        : { label: 'No project tags loaded to confirm', delta: -0.3 },
    ])
    proposals.push(legendProposal({
      id: rule.id, family: 'classify', target, rule, entryIds: [entry.id],
      /* A slice feeding matchKey participates in parent matching, so a wrong
         one re-parents equipment rather than just mislabelling it. */
      risk: target === 'matchKey' ? 'medium' : 'low',
      title: `Classify ${target} from characters ${detail.start + 1}-${detail.end}`,
      insertIndex: legendInsertIndex(existing, target, baseIds),
      confidence, confidenceReasons,
      unverified: !(corpus && corpus.size),
      duplicateOf: duplicate ? duplicate.id : '',
      matches: covered,
    }))
  }
  return proposals
}

/* ---- normalize ---- */

function legendNormalizeProposals(entries, profile, corpus, baseIds) {
  const proposals = []
  for (const entry of entries) {
    const detail = entry.detail || {}
    if (detail.form !== 'stripSuffix' || !Array.isArray(detail.suffixes) || !detail.suffixes.length) continue
    const suffixes = detail.suffixes.map(value => clean(value)).filter(Boolean)
    if (!suffixes.length) continue
    const rule = {
      id: '', name: `Strip ${suffixes.join(' / ')} from identity`, kind: 'stripSuffix',
      suffixes, separators: ['-'], stage: 'identity', enabled: true,
    }
    rule.id = legendRuleId('normalize', 'identity', { kind: 'stripSuffix', suffixes, separators: ['-'], stage: 'identity' })
    const existing = (profile && profile.rules && profile.rules.normalize) || []
    const duplicate = existing.find(item => item && item.kind === 'stripSuffix'
      && JSON.stringify((item.suffixes || []).map(clean).sort()) === JSON.stringify([...suffixes].sort()))
    const affected = corpus && corpus.size
      ? [...corpus.byNormalized.keys()].filter(key => suffixes.some(suffix => key.toUpperCase().endsWith('-' + suffix.toUpperCase()))).length
      : 0
    const { confidence, confidenceReasons } = legendConfidence([
      { label: 'Stated explicitly as not part of identity', delta: 0.6 },
      corpus && corpus.size
        ? { label: `${affected} project tags end with one of these suffixes`, delta: affected ? Math.min(0.25, affected * 0.03) : -0.45 }
        : { label: 'No project tags loaded to confirm', delta: -0.3 },
    ])
    proposals.push(legendProposal({
      id: rule.id, family: 'normalize', target: 'identity', rule, entryIds: [entry.id],
      /* High risk regardless of confidence: this changes canonical identity, so
         two tags that were separate equipment records become one. Reading the
         sentence correctly and it being safe to act on are different questions. */
      risk: 'high',
      title: `Strip ${suffixes.join(' / ')} from tag identity`,
      insertIndex: legendInsertIndex(existing, '', baseIds),
      confidence, confidenceReasons,
      unverified: !(corpus && corpus.size),
      duplicateOf: duplicate ? duplicate.id : '',
      matches: affected,
    }))
  }
  return proposals
}

/* ---- relate ---- */

function legendRelateProposals(entries, profile, corpus, baseIds) {
  const proposals = []
  const existing = (profile && profile.rules && profile.rules.relate) || []
  for (const entry of entries) {
    const detail = entry.detail || {}
    let rule = null
    let title = ''
    if (detail.form === 'prefixSplit') {
      const delimiter = detail.delimiter
      rule = {
        id: '', name: `Parent is the text before the first ${delimiter}`, kind: 'prefixSplit',
        delimiter, pattern: '.+', cleanPrefix: true, tagSource: 'raw', enabled: true,
      }
      rule.id = legendRuleId('relate', '', { kind: 'prefixSplit', delimiter, pattern: '.+', cleanPrefix: true, tagSource: 'raw' })
      title = `Parent from the text before the first "${delimiter}"`
    } else if (detail.form === 'attributeMatch') {
      rule = {
        id: '', name: `${detail.childType} to matching ${detail.parentType}`, kind: 'attributeMatch',
        source: 'canonical',
        when: { equipmentType: detail.childType },
        match: { equipmentType: detail.parentType, [detail.matchOn]: '@' + detail.matchOn },
        excludeSelf: true,
        ambiguousReason: `Multiple ${detail.parentType} tags share this equipment's ${detail.matchOn}`,
        emptyReason: `No ${detail.parentType} tag shares this equipment's ${detail.matchOn}`,
        enabled: true,
      }
      rule.id = legendRuleId('relate', '', { kind: 'attributeMatch', when: rule.when, match: rule.match, source: 'canonical' })
      title = `Parent ${detail.childType} to the ${detail.parentType} with the same ${detail.matchOn}`
    } else if (detail.form === 'constant') {
      rule = {
        id: '', name: `Unparented ${detail.equipmentType} below ${detail.parent}`, kind: 'constant',
        pattern: `(^|-)${legendEscapeRegex(detail.equipmentType)}(-|$)`,
        parent: detail.parent, requiresNoParent: true, enabled: true,
      }
      rule.id = legendRuleId('relate', '', { kind: 'constant', pattern: rule.pattern, parent: detail.parent, requiresNoParent: true })
      title = `Place unparented ${detail.equipmentType} below ${detail.parent}`
    }
    if (!rule) continue

    const duplicate = existing.find(item => item && item.kind === rule.kind
      && JSON.stringify(item.when || {}) === JSON.stringify(rule.when || {})
      && clean(item.pattern) === clean(rule.pattern)
      && clean(item.parent) === clean(rule.parent))
    const { confidence, confidenceReasons } = legendConfidence([
      { label: 'Explicit parent language in the document', delta: 0.55 },
      corpus && corpus.size
        ? { label: `${corpus.distinct} project tags available to check against`, delta: 0.15 }
        : { label: 'No project tags loaded — parents cannot be simulated', delta: -0.4 },
    ])
    proposals.push(legendProposal({
      id: rule.id, family: 'relate', target: '', rule, entryIds: [entry.id],
      /* Always high risk. A relationship rule restructures the tree, and a
         wrong one can introduce a cycle or silently re-parent a whole branch. */
      risk: 'high',
      title,
      insertIndex: legendInsertIndex(existing, '', baseIds),
      confidence, confidenceReasons,
      unverified: !(corpus && corpus.size),
      duplicateOf: duplicate ? duplicate.id : '',
      matches: 0,
    }))
  }
  return proposals
}

/**
 * Turn knowledge into proposals against one candidate profile.
 *
 * `reference-only` entries never reach here, and neither do entries the parser
 * marked unresolved -- a code the document defines two different ways has no
 * single correct rule, and picking one would bury a real drafting inconsistency
 * behind something that looks authoritative.
 */
export function legendBuildProposals(entries, profile, corpus, options) {
  const list = (entries || []).filter(entry => entry && entry.kind !== 'reference-only')
  const workingCorpus = corpus || legendEmptyCorpus()
  const baseIds = (options && options.baseRuleIds) || new Set()

  const anatomyEntries = list.filter(entry => entry.kind === 'tag-anatomy')
  const anatomy = legendAnatomyProposal(anatomyEntries, profile, workingCorpus)

  const proposals = []
  if (anatomy) proposals.push(anatomy)
  proposals.push(...legendClassifyProposals(
    list.filter(entry => entry.kind === 'abbreviation' || entry.kind === 'code-list' || entry.kind === 'classification'),
    profile, workingCorpus, anatomy, baseIds,
  ))
  proposals.push(...legendSliceProposals(anatomyEntries, profile, workingCorpus, baseIds))
  proposals.push(...legendNormalizeProposals(list.filter(entry => entry.kind === 'normalization'), profile, workingCorpus, baseIds))
  proposals.push(...legendRelateProposals(
    list.filter(entry => entry.kind === 'relationship' || entry.kind === 'hierarchy-root'),
    profile, workingCorpus, baseIds,
  ))

  /* Semantic duplicates collapse rather than stacking: re-analyzing the same
     page must merge provenance, not add a second identical rule. */
  const byId = new Map()
  for (const proposal of proposals) {
    const found = byId.get(proposal.id)
    if (!found) { byId.set(proposal.id, proposal); continue }
    found.entryIds = [...new Set([...found.entryIds, ...proposal.entryIds])]
  }
  return [...byId.values()]
}

/**
 * Whether a proposal may be selected for the user rather than by them.
 *
 * Every condition must hold. High risk disqualifies outright, however
 * confident the reading: confidence is about whether we understood the
 * document, and risk is about what happens if we did not.
 */
export function legendPreselect(proposal, context) {
  const corpusLoaded = !!(context && context.corpusLoaded)
  const compiles = !(context && context.compiles === false)
  const effective = context && context.effectiveMatches != null ? context.effectiveMatches : proposal.matches
  const conflicts = (context && context.conflicts) || 0
  const collisions = (context && context.collisions) || 0
  const shadowed = !!(context && context.fullyShadowed)

  if (proposal.risk === 'high') return { preselected: false, blockedReason: 'High-risk change — review before selecting' }
  if (proposal.duplicateOf) return { preselected: false, blockedReason: 'Already covered by an existing rule' }
  if (!corpusLoaded) return { preselected: false, blockedReason: 'Unverified — no project tag data is loaded' }
  if (!compiles) return { preselected: false, blockedReason: 'Does not pass profile validation' }
  if (proposal.confidence < 0.8) return { preselected: false, blockedReason: 'Confidence is below the automatic threshold' }
  /* Shadowing is checked before the zero-match case because both produce zero
     effective matches, and "shadowed by <rule>" tells the user something they
     can act on -- reorder it -- while "matches nothing" would send them looking
     for a fault in a rule that is perfectly correct. */
  if (shadowed) return { preselected: false, blockedReason: 'Fully shadowed by an earlier rule' }
  if (!effective) return { preselected: false, blockedReason: 'Matches no project tag at this position' }
  if (conflicts) return { preselected: false, blockedReason: `Conflicts with ${conflicts} existing assignment${conflicts === 1 ? '' : 's'}` }
  if (collisions) return { preselected: false, blockedReason: `Introduces ${collisions} identity collision${collisions === 1 ? '' : 's'}` }
  return { preselected: true, blockedReason: '' }
}
