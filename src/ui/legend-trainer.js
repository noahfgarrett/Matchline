import { $, $$, clean, esc, KEYSEP } from '../core/text.js'
import { S, fileById } from '../state.js'
import { ic } from './icons.js'
import { toast } from './progress.js'
import { PROFILE_STORE, activeProfile, normalizeProfile, persistProfiles, profileClone, profileCore, profileId, profileKindForKey } from '../profile/schema.js'
import { clearLegendProvenance, legendRuleExecutionHash, normalizeLegendTraining } from '../profile/legend.js'
import { emptyLegendTraining } from '../rules/schema.js'
import { legendCancellation, legendExtractPages, legendPageFromRows, legendPageFromText, legendScorePage } from '../legend/extract.js'
import { legendPdfAdapter, legendPdfAvailable, legendPdfRelease, legendPdfRenderPage } from '../legend/pdf.js'
import { legendParsePages, legendSampleTags, legendSections, legendSplitInline } from '../legend/parser.js'
import { legendMakeEntry } from '../legend/model.js'
import { legendBaseRuleIds, legendBuildProposals } from '../legend/proposals.js'
import { legendBuildCorpus, legendEmptyCorpus, legendSliceCoverage } from '../legend/corpus.js'
import { legendLassoLines, legendLassoRect, legendLassoRegion, legendRectHeight, legendRectWidth } from '../legend/lasso.js'
import { legendApplyToDraft, legendBatchImpact, legendEvaluate, legendPrerequisites, legendProposalImpact } from '../legend/impact.js'
import { getAoa } from '../io/workbook.js'
import { allKeys, go } from './screens.js'

/* ---- Legend Trainer ----
   The wizard that replaces the one-click profile copy, and the Studio
   workspace that reuses the same machinery for an existing profile.

   TRANSIENT STATE LIVES HERE, in a module-owned object, and deliberately NOT on
   S.profileDraft. Raw files, page objects, canvases, blob URLs, and worker
   handles must never reach a persisted profile, and profileClone is
   JSON.parse(JSON.stringify(...)) -- it would either throw on them or silently
   flatten them into junk. Keeping them unreachable from the draft makes that
   boundary structural rather than a rule someone has to remember. */

export const LEGEND_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv,.txt'
export const LEGEND_WIZARD_STEPS = Object.freeze([
  ['profile', 'Profile', 'tag'],
  ['legend', 'Design Legend', 'upload'],
  ['knowledge', 'Extracted Knowledge', 'list-tree'],
  ['create', 'Create', 'circle-check'],
])

function emptyLegendSession() {
  return {
    open: false, mode: 'wizard', step: 'profile',
    baseProfileId: '', name: '', siteCode: '', description: '',
    sources: [], pasted: '',
    entries: [], ignored: new Set(),
    sections: [], sampleTags: [],
    binding: { sample: '', start: null, end: null, sectionId: '', target: '' },
    bindings: [],
    lasso: {
      open: false, sourceId: '', page: 1, pageCount: 0,
      width: 0, height: 0, tokens: [], canvas: null,
      from: null, to: null, preview: null, busy: false, error: '',
    },
    proposals: [], selected: new Set(), impacts: new Map(),
    corpus: null, baseline: null, candidate: null,
    busy: false, error: '', notice: '', cancellation: null,
    blobUrls: [], workers: [],
  }
}

export let legendSession = emptyLegendSession()

/**
 * Release everything transient. Called on close, cancel, and before a new
 * session -- a legend package can hold tens of megabytes of page bitmaps, and
 * an OCR worker that is never terminated keeps its WASM heap alive for the rest
 * of the session.
 */
export function legendSessionRelease() {
  if (legendSession.cancellation) legendSession.cancellation.cancel()
  for (const url of legendSession.blobUrls) {
    try { URL.revokeObjectURL(url) } catch (_) { /* already revoked */ }
  }
  for (const worker of legendSession.workers) {
    try { if (worker && typeof worker.terminate === 'function') worker.terminate() } catch (_) { /* already gone */ }
  }
  for (const source of legendSession.sources) {
    source.file = null
    source.pages = null
    source.bytes = null
  }
  legendPdfRelease()
  legendSession = emptyLegendSession()
}

export function legendSourceKind(name) {
  const ext = clean(name).toLowerCase().split('.').pop()
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'spreadsheet'
  return 'text'
}

/** Cheap, stable fingerprint so the same document is recognised on re-upload. */
export function legendFingerprint(name, size) {
  const text = clean(name).toLowerCase() + ':' + (Number(size) || 0)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  return 'fp-' + (hash >>> 0).toString(16)
}

/* ---- adapters ----
   Spreadsheet and text need nothing beyond what the bundle already carries.
   PDF text extraction is vendored (src/legend/pdf.js). Image-only pages need
   OCR, which this build does not carry, so they report that plainly rather
   than failing somewhere deeper. */

async function legendSpreadsheetAdapter(source) {
  const buffer = await source.file.arrayBuffer()
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' })
  return workbook.SheetNames.map((name, index) => {
    const aoa = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' })
    return legendPageFromRows(aoa, { page: index + 1 })
  })
}

async function legendTextAdapter(source) {
  const text = source.text != null ? source.text : await source.file.text()
  return [legendPageFromText(text, { page: 1 })]
}

export function legendAdapters() {
  return { spreadsheet: legendSpreadsheetAdapter, text: legendTextAdapter, pdf: legendPdfAdapter }
}

/* ---- corpus from the sheets already loaded ---- */

export function legendLoadedSheets() {
  const sheets = []
  for (const key of allKeys()) {
    const [fid, sheet] = key.split(KEYSEP)
    /* Per sheet, because getAoa throws on a workbook that never parsed. One
       unreadable tab must cost its own rows and nothing else -- unguarded, it
       propagates out of legendRefreshCorpus and takes down
       openCreateProfileWizard, so the plus button simply stops working with
       nothing on screen to say why. */
    let record = null
    try { record = S.aoaCache.get(key) || getAoa(key) } catch (_) { continue }
    if (!record || !Array.isArray(record.aoa) || !record.aoa.length) continue
    sheets.push({
      fileId: fid, sheet, aoa: record.aoa,
      sourceKind: profileKindForKey(key, record.aoa),
      overrides: S.override[key] || null,
    })
  }
  return sheets
}

export function legendRefreshCorpus(profile) {
  const sheets = legendLoadedSheets()
  legendSession.corpus = sheets.length ? legendBuildCorpus(sheets, profile) : legendEmptyCorpus()
  legendSession.baseline = legendEvaluate(profile, legendSession.corpus)
  return legendSession.corpus
}

/* ---- analysis ---- */

export async function legendAnalyzeSources(profile) {
  legendSession.busy = true
  legendSession.error = ''
  legendSession.cancellation = legendCancellation()
  const entries = []
  const sections = []
  const sampleTags = []
  try {
    for (const source of legendSession.sources) {
      const result = await legendExtractPages(source, {
        adapters: legendAdapters(), cancellation: legendSession.cancellation,
      })
      if (!result.ok) {
        legendSession.error = result.message
        if (result.code === 'cancelled') return { ok: false, code: 'cancelled' }
        continue
      }
      source.pageCount = result.pages.length
      source.extractorVersion = result.extractorVersion
      source.ocrUsed = result.ocrUsed
      source.scores = result.pages.map(page => legendScorePage(page))
      entries.push(...legendParsePages(result.pages, { sourceId: source.id }))
      /* Sections and sample tags are what the anatomy binder offers to pick
         between. Collected here, while the pages are still in hand, for the
         same reason the entries are -- and into LOCALS for the same reason too:
         analysis re-runs whenever a source is added, so pushing straight into
         the session would duplicate every section on the second pass and leave
         a half-filled list behind on a cancelled one.

         The id is namespaced by source because legendSections numbers from 1 on
         every call, so two sources would otherwise both claim `section-1` and a
         binding could resolve to the wrong one. */
      sections.push(...legendSections(result.pages).map(section => ({
        ...section, id: source.id + '/' + section.id, sourceId: source.id,
      })))
      sampleTags.push(...legendSampleTags(result.pages).map(tag => ({ ...tag, sourceId: source.id })))
      /* Page objects are released as soon as their knowledge has been
         extracted. Nothing downstream needs them, and holding them is how a
         forty-page package stays resident for the whole session. */
      source.pages = null
    }
  } catch (error) {
    legendSession.error = clean(error && error.message) || 'Could not read that document.'
    return { ok: false, code: 'failed' }
  } finally {
    legendSession.busy = false
    legendSession.cancellation = null
  }
  legendSession.entries = entries
  legendSession.sections = sections
  legendSession.sampleTags = sampleTags
  legendRebuildProposals(profile)
  return { ok: true, entries: entries.length }
}

/** Entries the user has not ignored, and which are not merely reference. */
export function legendActiveEntries() {
  return legendSession.entries.filter(entry => !legendSession.ignored.has(entry.id))
}

export function legendRebuildProposals(profile) {
  const corpus = legendSession.corpus || legendRefreshCorpus(profile)
  /* Bound segments travel the same path as a written statement -- same slice
     rule, same risk, same impact preview -- so a manual binding is never a
     special case downstream. */
  legendSession.proposals = legendBuildProposals([...legendActiveEntries(), ...legendBindingEntries()], profile, corpus, {
    baseRuleIds: legendBaseRuleIds(profile.basePreset ? activeProfile() : profile),
  })
  legendSession.impacts = new Map()
  legendSession.selected = new Set()
  /* One baseline for the whole batch. Re-deriving it per proposal is the
     mistake the Visual Trainer already paid for once. */
  const baseline = legendSession.baseline || legendEvaluate(profile, corpus)
  for (const proposal of legendSession.proposals) {
    const impact = legendProposalImpact(profile, proposal, corpus, baseline, { hasHierarchy: !!S.roots.length, proposals: legendSession.proposals })
    legendSession.impacts.set(proposal.id, impact)
    if (impact.preselected) legendSession.selected.add(proposal.id)
  }
  return legendSession.proposals
}

/* ---- persisted knowledge ---- */

export function legendSourceRecords() {
  return legendSession.sources.map(source => ({
    id: source.id, name: source.name, fingerprint: source.fingerprint, kind: source.kind,
    pageCount: source.pageCount || 0, selectedPages: source.selectedPages || [],
    analyzedAt: source.analyzedAt || '', extractorVersion: String(source.extractorVersion || ''),
    ocrUsed: !!source.ocrUsed,
  }))
}

export function legendPendingRecords() {
  const accepted = new Set()
  for (const id of legendSession.selected) {
    const proposal = legendSession.proposals.find(item => item.id === id)
    for (const entryId of (proposal && proposal.entryIds) || []) accepted.add(entryId)
  }
  return legendActiveEntries()
    .filter(entry => !accepted.has(entry.id))
    .map(entry => ({
      id: entry.id, sourceId: entry.sourceId, page: entry.page, kind: entry.kind,
      code: entry.code, meaning: entry.meaning, targetHint: entry.targetHint,
      confidence: entry.parserConfidence, evidenceSummary: entry.evidenceSummary,
      semanticHash: entry.semanticHash,
    }))
}

/** Provenance for the rules a batch just contributed, keyed by rule id. */
export function legendOriginRecords(proposals, acceptedAt) {
  const origins = {}
  for (const proposal of proposals) {
    const entry = legendSession.entries.find(item => proposal.entryIds.includes(item.id))
    origins[proposal.rule.id] = {
      sourceId: (entry && entry.sourceId) || '',
      page: (entry && entry.page) || 0,
      entryIds: proposal.entryIds,
      generatedExecutionHash: legendRuleExecutionHash(proposal.rule),
      acceptedAt,
    }
  }
  return origins
}

/**
 * Fold a selected batch into a draft: rules at their simulated positions,
 * provenance alongside, pending knowledge retained.
 *
 * Returns a new draft rather than assigning one. Publication stays exactly
 * where it has always been -- behind Save & apply.
 */
export function legendApplySelectionTo(draft) {
  const selected = legendSession.proposals.filter(proposal => legendSession.selected.has(proposal.id))
  const result = legendApplyToDraft(draft, selected, legendSession.proposals)
  if (!result.ok) return result
  const now = new Date().toISOString()
  const legend = result.draft.legendTraining && typeof result.draft.legendTraining === 'object'
    ? result.draft.legendTraining : emptyLegendTraining()
  result.draft.legendTraining = normalizeLegendTraining({
    ...legend,
    sources: [...(legend.sources || []), ...legendSourceRecords()],
    pendingEntries: [...(legend.pendingEntries || []), ...legendPendingRecords()],
    ruleOrigins: { ...(legend.ruleOrigins || {}), ...legendOriginRecords(selected, now) },
    dismissedEntryHashes: [
      ...(legend.dismissedEntryHashes || []),
      ...legendSession.entries.filter(entry => legendSession.ignored.has(entry.id)).map(entry => entry.semanticHash),
    ],
  })
  return result
}

/* ---- wizard lifecycle ---- */

export function openCreateProfileWizard() {
  legendSessionRelease()
  const base = activeProfile()
  legendSession.open = true
  legendSession.mode = 'wizard'
  legendSession.step = 'profile'
  legendSession.baseProfileId = base.id
  legendSession.name = base.locked ? 'New Site Profile' : base.name + ' Copy'
  legendSession.siteCode = base.locked ? '' : clean(base.siteCode)
  legendSession.description = ''
  legendSession.candidate = legendCandidateFromBase()
  legendRefreshCorpus(legendSession.candidate)
  go('legendWizard')
}

/**
 * The profile the wizard is building, held only in the session.
 *
 * PROFILE_STORE is not touched until Create Profile is pressed, so cancelling
 * at any step -- or an extraction that fails halfway -- leaves the stored
 * profiles exactly as they were.
 */
export function legendCandidateFromBase() {
  const base = PROFILE_STORE.profiles.find(profile => profile.id === legendSession.baseProfileId) || activeProfile()
  return normalizeProfile(clearLegendProvenance({
    ...profileCore(base),
    id: profileId(),
    name: clean(legendSession.name) || 'New Site Profile',
    siteCode: clean(legendSession.siteCode),
    description: clean(legendSession.description),
    /* An editable clone, always. Creating from Eagle must never produce another
       locked profile, and a new profile inherits no revision history. */
    builtIn: false, locked: false, revision: 1,
    publishedAt: new Date().toISOString(), history: [],
  }))
}

export function closeLegendWizard(confirmDiscard) {
  if (confirmDiscard && legendSession.entries.length && !confirm('Discard this profile and the extracted knowledge?')) return
  legendSessionRelease()
  go('upload')
}

export function legendWizardCanAdvance() {
  if (legendSession.step === 'profile') return !!clean(legendSession.name)
  return true
}

export function legendWizardGo(step) {
  legendSession.step = step
  renderLegendWizard()
}

export async function legendWizardNext() {
  const order = LEGEND_WIZARD_STEPS.map(([id]) => id)
  const at = order.indexOf(legendSession.step)
  if (legendSession.step === 'profile') {
    if (!clean(legendSession.name)) { toast('Profile name is required'); return }
    legendSession.candidate = legendCandidateFromBase()
    legendRefreshCorpus(legendSession.candidate)
  }
  if (legendSession.step === 'legend' && legendSession.sources.length) {
    renderLegendWizard()
    const result = await legendAnalyzeSources(legendSession.candidate)
    if (!result.ok && result.code === 'cancelled') { renderLegendWizard(); return }
  }
  legendWizardGo(order[Math.min(order.length - 1, at + 1)])
}

export function legendWizardBack() {
  const order = LEGEND_WIZARD_STEPS.map(([id]) => id)
  legendWizardGo(order[Math.max(0, order.indexOf(legendSession.step) - 1)])
}

/**
 * The single transactional commit. Everything before this point is session
 * state; this is the only place PROFILE_STORE changes.
 */
export function legendWizardCreate() {
  const draft = legendCandidateFromBase()
  let created = draft
  if (legendSession.selected.size) {
    const result = legendApplySelectionTo(draft)
    if (!result.ok) { toast(result.message); return }
    created = result.draft
  } else {
    created.legendTraining = normalizeLegendTraining({
      sources: legendSourceRecords(),
      pendingEntries: legendPendingRecords(),
      ruleOrigins: {},
      dismissedEntryHashes: legendSession.entries.filter(entry => legendSession.ignored.has(entry.id)).map(entry => entry.semanticHash),
    })
  }
  const accepted = legendSession.selected.size
  PROFILE_STORE.profiles.push(created)
  PROFILE_STORE.activeId = created.id
  persistProfiles()
  legendSessionRelease()
  /* Accepted proposals arrive as UNPUBLISHED draft changes. The engineer still
     presses Save & apply, which is the only action that publishes anything. */
  S.profileDraft = profileClone(created)
  S.profileDirty = accepted > 0
  S.profileUi.section = 'overview'
  go('profile')
  toast(accepted ? `Profile created with ${accepted} rule${accepted === 1 ? '' : 's'} in the draft` : 'Profile created')
}

/* ---- rendering ---- */

function legendStepNav() {
  const order = LEGEND_WIZARD_STEPS.map(([id]) => id)
  const at = order.indexOf(legendSession.step)
  return LEGEND_WIZARD_STEPS.map(([id, label, icon], index) => {
    const state = index < at ? 'done' : index === at ? 'on' : ''
    return `<button class="legend-step ${state}" data-legend-step="${id}" type="button" role="tab" aria-selected="${index === at}">
      <span class="legend-step-num">${index < at ? ic('check') : index + 1}</span>${ic(icon)}${esc(label)}</button>`
  }).join('')
}

function legendConfidenceBadge(value) {
  const percent = Math.round((Number(value) || 0) * 100)
  const tone = percent >= 80 ? 'ok' : percent >= 55 ? 'warn' : 'low'
  return `<span class="legend-confidence ${tone}">${percent}%</span>`
}

function legendRiskBadge(risk) {
  return `<span class="legend-risk ${esc(risk)}">${esc(risk)} risk</span>`
}

function legendSourceName(sourceId) {
  const source = legendSession.sources.find(item => item.id === sourceId)
  return source ? source.name : 'Document'
}

/** Every string below comes from an uploaded document, so all of it is escaped. */
function legendEntryRow(entry) {
  const ignored = legendSession.ignored.has(entry.id)
  return `<div class="legend-entry ${ignored ? 'ignored' : ''}" data-legend-entry="${esc(entry.id)}">
    <div class="legend-entry-main">
      <div class="legend-entry-head">
        <input class="profile-input legend-code" data-legend-code="${esc(entry.id)}" value="${esc(entry.code)}" aria-label="Code" ${ignored ? 'disabled' : ''}>
        <input class="profile-input legend-meaning" data-legend-meaning="${esc(entry.id)}" value="${esc(entry.meaning)}" aria-label="Meaning" ${ignored ? 'disabled' : ''}>
        <select class="profile-select legend-target" data-legend-target="${esc(entry.id)}" aria-label="Category" ${ignored ? 'disabled' : ''}>
          <option value="">Choose a category…</option>
          ${['building', 'discipline', 'system', 'equipmentType', 'matchKey', 'placeholder']
            .map(target => `<option value="${target}" ${entry.targetHint === target ? 'selected' : ''}>${target}</option>`).join('')}
        </select>
      </div>
      <div class="legend-entry-meta">
        ${legendConfidenceBadge(entry.parserConfidence)}
        <span class="legend-kind">${esc(entry.kind)}</span>
        <span>${esc(legendSourceName(entry.sourceId))}${entry.page ? ' · p. ' + entry.page : ''}</span>
        <span>${esc(entry.extractionMethod || 'text')}</span>
        ${entry.unresolved ? `<span class="legend-flag warn">${ic('triangle-alert')}Defined ${entry.conflicts.length} ways</span>` : ''}
      </div>
      <div class="legend-evidence">${esc(entry.evidenceSummary)}</div>
    </div>
    <button class="btn ghost sm" data-legend-ignore="${esc(entry.id)}" type="button">${ignored ? 'Restore' : 'Ignore'}</button>
  </div>`
}

function legendProposalRow(proposal) {
  const impact = legendSession.impacts.get(proposal.id) || {}
  const checked = legendSession.selected.has(proposal.id)
  const shadow = (impact.shadowedBy || [])[0]
  return `<div class="legend-proposal ${checked ? 'on' : ''}">
    <label class="legend-proposal-pick">
      <input type="checkbox" data-legend-pick="${esc(proposal.id)}" ${checked ? 'checked' : ''} ${impact.compiles === false ? 'disabled' : ''}>
      <span class="legend-proposal-title">${esc(proposal.title)}</span>
    </label>
    <div class="legend-proposal-meta">
      ${legendConfidenceBadge(proposal.confidence)}${legendRiskBadge(proposal.risk)}
      <span class="legend-family">${esc(proposal.family)}</span>
      ${proposal.unverified ? `<span class="legend-flag warn">${ic('triangle-alert')}Unverified — no project tag data is loaded</span>` : ''}
      ${proposal.duplicateOf ? `<span class="legend-flag">${ic('check')}Already covered</span>` : ''}
    </div>
    <div class="legend-proposal-impact">
      <b>${impact.structuralMatches || 0}</b> structural matches ·
      <b>${impact.effectiveMatches || 0}</b> effective changes
      ${shadow ? ` · shadowed by ${esc(shadow.name)}` : ''}
      ${impact.identityCollisions ? ` · <span class="legend-flag warn">${impact.identityCollisions} identity collision${impact.identityCollisions === 1 ? '' : 's'}</span>` : ''}
      ${(impact.conflicts || []).length ? ` · <span class="legend-flag warn">${impact.conflicts.length} conflicting value${impact.conflicts.length === 1 ? '' : 's'}</span>` : ''}
    </div>
    ${impact.parentImpact && impact.parentImpact.applicable && !impact.parentImpact.verified
      ? `<div class="legend-proposal-note">${ic('triangle-alert')}${esc(impact.parentImpact.reason)}</div>` : ''}
    ${impact.blockedReason ? `<div class="legend-proposal-note">${esc(impact.blockedReason)}</div>` : ''}
    <details class="legend-why"><summary>Why this confidence</summary><ul>
      ${(proposal.confidenceReasons || []).map(reason =>
        `<li>${esc(reason.label)} <span class="${reason.delta < 0 ? 'down' : 'up'}">${reason.delta < 0 ? '' : '+'}${Math.round(reason.delta * 100)}</span></li>`).join('')}
    </ul>
    <div class="legend-position">Insert at position ${proposal.insertIndex + 1} of ${esc(proposal.family)}
      <button class="btn-link" data-legend-move-up="${esc(proposal.id)}" type="button">earlier</button> ·
      <button class="btn-link" data-legend-move-down="${esc(proposal.id)}" type="button">later</button></div>
    </details>
  </div>`
}

export function legendSourceList() {
  if (!legendSession.sources.length) return `<div class="profile-empty">${ic('upload')}<div>No legend documents added yet</div></div>`
  return legendSession.sources.map(source => `<div class="profile-list-row">
    <div class="profile-list-main">
      <div class="profile-list-title">${esc(source.name)}</div>
      <div class="profile-list-sub">${esc(source.kind)}${source.pageCount ? ' · ' + source.pageCount + ' page' + (source.pageCount === 1 ? '' : 's') : ''}</div>
    </div>
    <button class="profile-icon-btn icon-btn" data-legend-remove="${esc(source.id)}" type="button" aria-label="Remove ${esc(source.name)}">${ic('x')}</button>
  </div>`).join('')
}

function legendKnowledgeGroups() {
  const entries = legendSession.entries
  const confident = entries.filter(entry => entry.kind !== 'reference-only' && entry.parserConfidence >= 0.7 && !entry.unresolved)
  const review = entries.filter(entry => entry.kind !== 'reference-only' && (entry.parserConfidence < 0.7 || entry.unresolved))
  const reference = entries.filter(entry => entry.kind === 'reference-only')
  return { confident, review, reference }
}

export function renderLegendWizardBody() {
  if (legendSession.step === 'profile') {
    return `<section class="profile-section">
      <div class="profile-section-head">${ic('tag')}<div><h2>Profile</h2><p>Name the site and choose what to build from.</p></div></div>
      <div class="profile-band"><div class="profile-band-body profile-fields">
        <div class="profile-field wide"><label for="legendBase">Base profile</label>
          <select class="profile-select" id="legendBase">${PROFILE_STORE.profiles.map(profile =>
            `<option value="${esc(profile.id)}" ${profile.id === legendSession.baseProfileId ? 'selected' : ''}>${esc(profile.name)}${profile.locked ? ' · built-in' : ''}</option>`).join('')}</select></div>
        <div class="profile-field wide"><label for="legendName">Profile name</label>
          <input class="profile-input" id="legendName" value="${esc(legendSession.name)}"></div>
        <div class="profile-field wide"><label for="legendSite">Site code</label>
          <input class="profile-input" id="legendSite" value="${esc(legendSession.siteCode)}"></div>
        <div class="profile-field wide"><label for="legendDescription">Description</label>
          <textarea class="profile-textarea" id="legendDescription">${esc(legendSession.description)}</textarea></div>
      </div></div>
      <div class="note info wide">${ic('info')}Creating from a locked profile makes a fully editable clone. Nothing is saved until you press Create Profile.</div>
    </section>`
  }

  if (legendSession.step === 'legend') {
    return `<section class="profile-section">
      <div class="profile-section-head">${ic('upload')}<div><h2>Design legend</h2><p>Optional. Add the legend, abbreviations, tag-identification, or general-notes pages.</p></div></div>
      <div class="profile-grid">
        <div class="profile-band">
          <div class="profile-band-head">${ic('file-text')}Documents <span class="spacer"></span>
            <button class="btn sm" id="legendAddFile" type="button">${ic('upload')}Add files</button>
            <input id="legendFileInput" type="file" accept="${LEGEND_ACCEPT}" multiple hidden></div>
          <div class="profile-band-body">${legendSourceList()}
            <p class="profile-hint">${legendPdfAvailable() ? 'PDF, spreadsheet, CSV, and text are read here on this machine. Scanned pages with no text layer need OCR, which is not included in this build.' : 'Spreadsheet, CSV, and text are read here on this machine.'}</p>
          </div>
        </div>
        <div class="profile-band">
          <div class="profile-band-head">${ic('list-tree')}Or paste the text</div>
          <div class="profile-band-body">
            <textarea class="profile-textarea legend-paste" id="legendPaste" placeholder="AAA = Air Handling Assembly">${esc(legendSession.pasted)}</textarea>
            <button class="btn sm" id="legendUsePaste" type="button">${ic('check')}Use this text</button>
          </div>
        </div>
      </div>
      ${legendSession.error ? `<div class="note warn wide">${ic('triangle-alert')}${esc(legendSession.error)}</div>` : ''}
      ${legendSession.busy ? `<div class="note info wide">${ic('rotate-ccw')}Reading documents…
        <button class="btn sm" id="legendCancelScan" type="button">Cancel</button></div>` : ''}
    </section>`
  }

  if (legendSession.step === 'knowledge') {
    const { confident, review, reference } = legendKnowledgeGroups()
    if (!legendSession.entries.length) {
      return `<section class="profile-section"><div class="profile-empty">${ic('list-tree')}
        <div>No knowledge was extracted${legendSession.sources.length ? ' from those documents' : ' — no legend was added'}.</div></div></section>`
    }
    const group = (title, list, hint) => `<div class="profile-band">
      <div class="profile-band-head">${ic('list-tree')}${esc(title)} <span class="spacer"></span><span class="profile-rev">${list.length}</span></div>
      <div class="profile-band-body">${hint ? `<p class="profile-hint">${esc(hint)}</p>` : ''}
        ${list.length ? list.map(legendEntryRow).join('') : '<div class="profile-empty">Nothing here</div>'}</div></div>`
    return `<section class="profile-section">
      <div class="profile-section-head">${ic('list-tree')}<div><h2>Extracted knowledge</h2>
        <p>Everything the document said, before any rule exists. Edit or ignore anything.</p></div></div>
      ${group('Understood', confident)}
      ${group('Needs review', review, 'Low confidence or defined more than one way. Nothing here is hidden — confirm or correct it before it becomes a rule.')}
      ${group('Reference only', reference, 'Kept for context. These do not match a supported rule pattern and will not generate anything.')}
    </section>`
  }

  const impact = legendBatchImpact(
    legendSession.candidate,
    legendSession.proposals.filter(proposal => legendSession.selected.has(proposal.id)),
    legendSession.corpus, legendSession.baseline, { hasHierarchy: !!S.roots.length, proposals: legendSession.proposals })
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('circle-check')}<div><h2>Create</h2><p>Review what will be created. Nothing is saved until you press Create Profile.</p></div></div>
    <div class="profile-kpis">
      <div class="profile-kpi"><b>${legendSession.sources.length}</b><span>Legend documents</span></div>
      <div class="profile-kpi"><b>${legendActiveEntries().length}</b><span>Knowledge entries</span></div>
      <div class="profile-kpi"><b>${legendSession.selected.size}</b><span>Rules selected</span></div>
      <div class="profile-kpi"><b>${legendSession.corpus ? legendSession.corpus.distinct : 0}</b><span>Project tags checked</span></div>
    </div>
    ${legendSession.corpus && legendSession.corpus.size ? '' :
      `<div class="note warn wide">${ic('triangle-alert')}No project tag data is loaded, so nothing could be verified against real tags. Proposals stay unselected until you validate them.</div>`}
    <div class="profile-band" style="margin-top:14px">
      <div class="profile-band-head">${ic('sliders-horizontal')}Proposed rules <span class="spacer"></span><span class="profile-rev">${legendSession.proposals.length}</span></div>
      <div class="profile-band-body" id="legendProposalList">
        ${legendSession.proposals.length ? legendSession.proposals.map(legendProposalRow).join('')
          : '<div class="profile-empty">No rules were proposed</div>'}
      </div>
    </div>
    ${legendSession.selected.size ? `<div class="profile-band" style="margin-top:14px">
      <div class="profile-band-head">${ic('git-branch')}Combined effect</div>
      <div class="profile-band-body"><ul class="legend-summary">
        <li><b>${impact.identityChangeCount || 0}</b> tags whose identity changes</li>
        <li><b>${(impact.canonicalMerges || []).length}</b> canonical merges</li>
        <li><b>${impact.classificationsAdded || 0}</b> classifications added</li>
        <li><b>${impact.classificationsChanged || 0}</b> classifications changed</li>
        <li><b>${(impact.unreachableRules || []).length}</b> rules unreachable at their position</li>
      </ul>
      ${impact.compiles ? '' : `<div class="note warn wide">${ic('triangle-alert')}This selection does not validate: ${esc((impact.validationErrors[0] || {}).message || '')}</div>`}
      </div></div>` : ''}
  </section>`
}

export function renderLegendWizard() {
  $('#view').innerHTML = `<section class="profile-shell legend-shell">
    <header class="profile-head">
      <div class="profile-head-main"><h2 class="profile-title">Create Site Profile</h2>
        <div class="profile-sub">Nothing is saved until you press Create Profile</div></div>
      <button class="btn sm" id="legendBack" ${legendSession.step === 'profile' ? 'disabled' : ''}>${ic('arrow-left')}Back</button>
      ${legendSession.step === 'create'
        ? `<button class="btn primary sm" id="legendCreate">${ic('check')}Create Profile</button>`
        : `<button class="btn primary sm" id="legendNext" ${legendWizardCanAdvance() ? '' : 'disabled'}>${legendSession.step === 'legend' && !legendSession.sources.length ? 'Skip' : 'Continue'}${ic('chevron-right')}</button>`}
      <button class="profile-icon-btn icon-btn" id="legendClose" type="button" title="Cancel" aria-label="Cancel profile creation">${ic('x')}</button>
    </header>
    <nav class="profile-tabs legend-steps" role="tablist" aria-label="Create profile steps">${legendStepNav()}</nav>
    <main class="profile-body" id="legendSection" role="tabpanel">${renderLegendWizardBody()}</main>
  </section>`
  wireLegendWizard()
}

/* ---- wiring ---- */

function legendBindEntryEditing() {
  $$('[data-legend-ignore]').forEach(button => button.onclick = () => {
    const id = button.dataset.legendIgnore
    if (legendSession.ignored.has(id)) legendSession.ignored.delete(id)
    else legendSession.ignored.add(id)
    legendRebuildProposals(legendSession.candidate)
    renderLegendWizard()
  })
  const edit = (selector, field) => $$(selector).forEach(input => input.onchange = () => {
    const entry = legendSession.entries.find(item => item.id === input.dataset[field.dataset])
    if (!entry) return
    entry[field.key] = clean(input.value)
    legendRebuildProposals(legendSession.candidate)
  })
  edit('[data-legend-code]', { dataset: 'legendCode', key: 'code' })
  edit('[data-legend-meaning]', { dataset: 'legendMeaning', key: 'meaning' })
  edit('[data-legend-target]', { dataset: 'legendTarget', key: 'targetHint' })
}

function legendBindProposalPicking() {
  $$('[data-legend-pick]').forEach(box => box.onchange = () => {
    const id = box.dataset.legendPick
    const proposal = legendSession.proposals.find(item => item.id === id)
    if (box.checked) {
      legendSession.selected.add(id)
      /* A rule that names an anatomy segment cannot be applied without that
         anatomy, so selecting it selects what it needs rather than failing
         validation later and blaming the user's choice. */
      for (const dependency of legendPrerequisites(proposal, legendSession.proposals)) legendSession.selected.add(dependency.id)
    } else {
      legendSession.selected.delete(id)
      /* And deselecting an anatomy releases whatever depended on it, so the
         selection never holds a rule that is now unapplicable. */
      for (const item of legendSession.proposals) {
        if (legendPrerequisites(item, legendSession.proposals).some(dependency => dependency.id === id)) legendSession.selected.delete(item.id)
      }
    }
    /* Only the summary depends on the selection, so the long proposal list is
       left alone and keeps its scroll position. */
    renderLegendWizard()
  })
  const move = (selector, delta) => $$(selector).forEach(button => button.onclick = () => {
    const proposal = legendSession.proposals.find(item => item.id === button.dataset.legendMoveUp || item.id === button.dataset.legendMoveDown)
    if (!proposal) return
    proposal.insertIndex = Math.max(0, proposal.insertIndex + delta)
    const impact = legendProposalImpact(legendSession.candidate, proposal, legendSession.corpus, legendSession.baseline, { hasHierarchy: !!S.roots.length, proposals: legendSession.proposals })
    legendSession.impacts.set(proposal.id, impact)
    renderLegendWizard()
  })
  move('[data-legend-move-up]', -1)
  move('[data-legend-move-down]', 1)
}

export function wireLegendWizard() {
  const scroll = $('#legendSection')
  const top = scroll ? scroll.scrollTop : 0

  const close = $('#legendClose'); if (close) close.onclick = () => closeLegendWizard(true)
  const back = $('#legendBack'); if (back) back.onclick = legendWizardBack
  const next = $('#legendNext'); if (next) next.onclick = () => { legendWizardNext() }
  const create = $('#legendCreate'); if (create) create.onclick = legendWizardCreate
  $$('[data-legend-step]').forEach(button => button.onclick = () => legendWizardGo(button.dataset.legendStep))

  const base = $('#legendBase'); if (base) base.onchange = () => { legendSession.baseProfileId = base.value }
  const name = $('#legendName'); if (name) name.oninput = () => { legendSession.name = name.value; const button = $('#legendNext'); if (button) button.disabled = !clean(name.value) }
  const site = $('#legendSite'); if (site) site.oninput = () => { legendSession.siteCode = site.value }
  const description = $('#legendDescription'); if (description) description.oninput = () => { legendSession.description = description.value }

  const add = $('#legendAddFile'); const input = $('#legendFileInput')
  if (add && input) { add.onclick = () => input.click(); input.onchange = () => { legendAddFiles([...input.files]); input.value = '' } }
  const paste = $('#legendPaste'); if (paste) paste.oninput = () => { legendSession.pasted = paste.value }
  const usePaste = $('#legendUsePaste'); if (usePaste) usePaste.onclick = () => legendAddPastedText()
  const cancel = $('#legendCancelScan'); if (cancel) cancel.onclick = () => { if (legendSession.cancellation) legendSession.cancellation.cancel() }
  $$('[data-legend-remove]').forEach(button => button.onclick = () => {
    legendSession.sources = legendSession.sources.filter(source => source.id !== button.dataset.legendRemove)
    renderLegendWizard()
  })

  legendBindEntryEditing()
  legendBindProposalPicking()
  if (scroll && top) scroll.scrollTop = top
}

export function legendAddFiles(files) {
  for (const file of files || []) {
    legendSession.sources.push({
      id: 'source-' + legendFingerprint(file.name, file.size),
      name: file.name, kind: legendSourceKind(file.name),
      fingerprint: legendFingerprint(file.name, file.size),
      file, pages: null, pageCount: 0, selectedPages: [],
      analyzedAt: new Date().toISOString(), extractorVersion: 1, ocrUsed: false,
    })
  }
  renderLegendWizard()
}

export function legendAddPastedText() {
  const text = clean(legendSession.pasted)
  if (!text) { toast('Paste the legend text first'); return }
  legendSession.sources.push({
    id: 'source-' + legendFingerprint('pasted-text', text.length),
    name: 'Pasted text', kind: 'text', fingerprint: legendFingerprint('pasted-text', text.length),
    file: null, text, pages: null, pageCount: 1, selectedPages: [1],
    analyzedAt: new Date().toISOString(), extractorVersion: 1, ocrUsed: false,
  })
  legendSession.pasted = ''
  renderLegendWizard()
}

/* ---- Site Profile Studio tab ----
   The same extraction, interpretation, proposal, and impact components the
   wizard uses, pointed at an existing profile instead of a new one. */

export function legendTrainerRuleRows(draft) {
  const legend = draft.legendTraining || emptyLegendTraining()
  const origins = Object.entries(legend.ruleOrigins || {})
  if (!origins.length) return `<div class="profile-empty">No rules on this profile came from a legend</div>`
  return origins.map(([ruleId, origin]) => {
    const rule = legendFindDraftRule(draft, ruleId)
    const source = (legend.sources || []).find(item => item.id === origin.sourceId)
    const edited = rule && origin.generatedExecutionHash
      && legendRuleExecutionHash(rule) !== origin.generatedExecutionHash
    return `<div class="profile-list-row">
      <div class="profile-list-main">
        <div class="profile-list-title">${esc((rule && rule.name) || ruleId)}</div>
        <div class="profile-list-sub">
          <span class="legend-origin ${edited ? 'edited' : ''}">${ic('file-text')}Legend · ${esc((source && source.name) || 'document')}${origin.page ? ' · p. ' + origin.page : ''}${edited ? ' · edited' : ''}</span>
        </div>
      </div>
    </div>`
  }).join('')
}

function legendFindDraftRule(draft, ruleId) {
  for (const anatomy of draft.anatomies || []) if (anatomy && anatomy.id === ruleId) return anatomy
  for (const family of ['normalize', 'classify', 'relate']) {
    for (const rule of (draft.rules && draft.rules[family]) || []) if (rule && rule.id === ruleId) return rule
  }
  return null
}

export function renderLegendTrainerTab(draft) {
  const legend = draft.legendTraining || emptyLegendTraining()
  const active = legendSession.open && legendSession.mode === 'studio'
  /* Reported from the loaded SHEETS, not from the session corpus. The session
     is released once a wizard finishes, so reading its corpus told a user with
     spreadsheets open that no project data was loaded. */
  const sheetsLoaded = allKeys().length
  const corpusSize = legendSession.corpus ? legendSession.corpus.distinct : 0
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('file-text')}<div><h2>Legend Trainer</h2>
      <p>Read a design legend, abbreviations page, or tag-identification sheet and turn it into editable rules.</p></div></div>
    ${draft.locked ? `<div class="note info wide">${ic('info')}Eagle is locked. You can analyse a document and preview every proposal here; applying them creates an editable clone.</div>` : ''}
    <div class="profile-grid">
      <div class="profile-band">
        <div class="profile-band-head">${ic('upload')}Legend sources <span class="spacer"></span>
          <button class="btn sm" id="legendStudioAdd" type="button">${ic('upload')}Add a document</button>
          <input id="legendStudioFile" type="file" accept="${LEGEND_ACCEPT}" multiple hidden></div>
        <div class="profile-band-body">
          ${active && legendSession.sources.length ? legendSourceList()
            : (legend.sources || []).length
              ? (legend.sources || []).map(source => `<div class="profile-list-row"><div class="profile-list-main">
                  <div class="profile-list-title">${esc(source.name)}</div>
                  <div class="profile-list-sub">${esc(source.kind)}${source.pageCount ? ' · ' + source.pageCount + ' pages' : ''}${source.ocrUsed ? ' · OCR' : ''}</div>
                </div></div>`).join('')
              : `<div class="profile-empty">${ic('upload')}<div>No legend has been analysed for this profile</div></div>`}
          <div class="profile-actions" style="margin-top:12px">
            <button class="btn sm" id="legendStudioValidate" type="button">${ic('circle-check')}Validate against project data</button>
            <span class="profile-hint">${corpusSize ? corpusSize + ' project tags checked'
              : sheetsLoaded ? `${sheetsLoaded} sheet${sheetsLoaded === 1 ? '' : 's'} loaded — validate to check proposals against them`
                : 'No project tag data is loaded'}</span>
          </div>
        </div>
      </div>
      <div class="profile-band">
        <div class="profile-band-head">${ic('list-tree')}Pending knowledge <span class="spacer"></span><span class="profile-rev">${(legend.pendingEntries || []).length}</span></div>
        <div class="profile-band-body">
          ${(legend.pendingEntries || []).length
            ? (legend.pendingEntries || []).map(entry => `<div class="profile-list-row">
                <div class="profile-list-main">
                  <div class="profile-list-title">${esc(entry.code || entry.kind)}</div>
                  <div class="profile-list-sub">${esc(entry.meaning)}${entry.targetHint ? ' · ' + esc(entry.targetHint) : ''}</div>
                </div>
                <button class="btn ghost sm" data-legend-dismiss="${esc(entry.id)}" type="button">Dismiss</button>
              </div>`).join('')
            : '<div class="profile-empty">Nothing pending</div>'}
          ${(legend.dismissedEntryHashes || []).length
            ? `<div class="profile-actions" style="margin-top:12px">
                <button class="btn ghost sm" id="legendStudioRestore" type="button">${ic('rotate-ccw')}Restore ${(legend.dismissedEntryHashes || []).length} dismissed</button></div>` : ''}
        </div>
      </div>
    </div>
    ${renderLegendAnatomyBinder()}
    ${renderLegendLassoOverlay()}
    ${active && legendSession.proposals.length ? `<div class="profile-band" style="margin-top:14px">
      <div class="profile-band-head">${ic('sliders-horizontal')}Proposed rules <span class="spacer"></span><span class="profile-rev">${legendSession.proposals.length}</span></div>
      <div class="profile-band-body" id="legendStudioProposals">${legendSession.proposals.map(legendProposalRow).join('')}</div>
      <div class="visual-proposal-actions">
        <button class="btn primary sm" id="legendStudioApply" ${legendSession.selected.size ? '' : 'disabled'}>
          ${ic('check')}${draft.locked ? 'Clone Eagle and apply to draft' : 'Apply to draft'}</button>
        <button class="btn ghost sm" id="legendStudioDiscard" type="button">Discard</button>
      </div>
    </div>` : ''}
    <div class="profile-band" style="margin-top:14px">
      <div class="profile-band-head">${ic('file-text')}Rules from a legend <span class="spacer"></span><span class="profile-rev">${Object.keys(legend.ruleOrigins || {}).length}</span></div>
      <div class="profile-band-body">${legendTrainerRuleRows(draft)}</div>
    </div>
    ${legendSession.error ? `<div class="note warn wide">${ic('triangle-alert')}${esc(legendSession.error)}</div>` : ''}
  </section>`
}

export function wireLegendTrainerTab() {
  const draft = S.profileDraft
  const add = $('#legendStudioAdd'); const input = $('#legendStudioFile')
  if (add && input) {
    add.onclick = () => input.click()
    input.onchange = async () => {
      if (!legendSession.open || legendSession.mode !== 'studio') {
        legendSessionRelease()
        legendSession.open = true
        legendSession.mode = 'studio'
        legendSession.candidate = draft
        legendRefreshCorpus(draft)
      }
      for (const file of [...input.files]) {
        legendSession.sources.push({
          id: 'source-' + legendFingerprint(file.name, file.size),
          name: file.name, kind: legendSourceKind(file.name),
          fingerprint: legendFingerprint(file.name, file.size),
          file, pages: null, pageCount: 0, selectedPages: [],
          analyzedAt: new Date().toISOString(), extractorVersion: 1, ocrUsed: false,
        })
      }
      input.value = ''
      await legendAnalyzeSources(draft)
      renderProfile()
    }
  }

  const validate = $('#legendStudioValidate')
  if (validate) validate.onclick = () => {
    legendSession.candidate = draft
    legendRefreshCorpus(draft)
    if (legendSession.entries.length) legendRebuildProposals(draft)
    toast(legendSession.corpus.size ? `Validated against ${legendSession.corpus.distinct} project tags` : 'No project tag data is loaded')
    renderProfile()
  }

  const apply = $('#legendStudioApply')
  if (apply) apply.onclick = () => {
    /* Eagle is never modified. Applying from the locked profile clones it
       first, exactly as the Visual Trainer does. */
    if (S.profileDraft.locked) duplicateProfile()
    const result = legendApplySelectionTo(S.profileDraft)
    if (!result.ok) { toast(result.message); return }
    S.profileDraft = result.draft
    markProfileDirty()
    const applied = result.applied
    legendSessionRelease()
    renderProfile()
    toast(`${applied} rule${applied === 1 ? '' : 's'} added to the profile draft`)
  }

  const discard = $('#legendStudioDiscard')
  if (discard) discard.onclick = () => { legendSessionRelease(); renderProfile() }

  $$('[data-legend-dismiss]').forEach(button => button.onclick = () => {
    const legend = S.profileDraft.legendTraining || emptyLegendTraining()
    const entry = (legend.pendingEntries || []).find(item => item.id === button.dataset.legendDismiss)
    if (!entry) return
    legend.pendingEntries = legend.pendingEntries.filter(item => item.id !== entry.id)
    legend.dismissedEntryHashes = [...new Set([...(legend.dismissedEntryHashes || []), entry.semanticHash])]
    S.profileDraft.legendTraining = normalizeLegendTraining(legend)
    markProfileDirty(); renderProfile()
  })

  const restore = $('#legendStudioRestore')
  if (restore) restore.onclick = () => {
    S.profileDraft.legendTraining = normalizeLegendTraining({ ...S.profileDraft.legendTraining, dismissedEntryHashes: [] })
    markProfileDirty(); renderProfile()
  }

  legendBindProposalPicking()
  wireLegendAnatomyBinder(draft)
  wireLegendLassoOverlay()
}

/* ---- tag anatomy binder ----
   A numbering sheet binds a character position to a value list with a drawn
   leader line. That geometry is not in the text layer and differs every
   package, so the machine finds the sections and the sample tags and a person
   makes the binding -- which they can do at a glance and no heuristic can.

   The output is an ordinary Classify `slice` rule. Positions also sidestep a
   real limit: anatomy is delimiter-based, and a tag like `3AABXXYY` has no
   delimiters to split on. */

export const LEGEND_BIND_TARGETS = Object.freeze([
  'building', 'discipline', 'system', 'equipmentType', 'matchKey', 'placeholder',
])

export function legendBindingSample() {
  const chosen = clean(legendSession.binding.sample)
  if (chosen) return chosen
  return clean(legendSession.sampleTags[0] && legendSession.sampleTags[0].text)
}

/** The character range currently selected, normalised low-to-high. */
export function legendBindingRange() {
  const { start, end } = legendSession.binding
  if (start == null) return null
  const from = Math.min(start, end == null ? start : end)
  const to = Math.max(start, end == null ? start : end)
  return { start: from, end: to + 1 }
}

export function legendBindingSection() {
  return legendSession.sections.find(section => section.id === legendSession.binding.sectionId) || null
}

/**
 * Commit the current selection as a segment.
 *
 * Produces a tag-anatomy entry in the `slice` form the proposal generator
 * already understands, so a bound segment travels the same path as one read
 * from a written statement -- same rule, same risk, same impact preview.
 */
export function legendCommitBinding(profile) {
  const range = legendBindingRange()
  const sample = legendBindingSample()
  const target = clean(legendSession.binding.target)
  if (!sample || !range) { toast('Select the characters this segment covers'); return null }
  if (!target) { toast('Choose what this segment means'); return null }
  const section = legendBindingSection()
  const binding = {
    id: 'bind-' + range.start + '-' + range.end + '-' + target,
    sample, start: range.start, end: range.end, target,
    sectionId: section ? section.id : '',
    sectionTitle: section ? section.title : '',
    values: section ? section.values.slice(0, 200) : [],
  }
  legendSession.bindings = legendSession.bindings.filter(item => item.id !== binding.id).concat(binding)
  legendSession.binding = { sample, start: null, end: null, sectionId: '', target: '' }
  legendRebuildProposals(profile)
  return binding
}

export function legendRemoveBinding(id, profile) {
  legendSession.bindings = legendSession.bindings.filter(item => item.id !== id)
  legendRebuildProposals(profile)
}

/** Committed bindings as tag-anatomy entries, for the proposal generator. */
export function legendBindingEntries() {
  return legendSession.bindings.map(binding => legendMakeEntry({
    kind: 'tag-anatomy',
    sourceId: binding.sectionId ? (legendBindingSectionSource(binding.sectionId) || '') : '',
    meaning: `Characters ${binding.start + 1}-${binding.end} of ${binding.sample} indicate ${binding.target}`,
    statement: binding.sectionTitle,
    parserConfidence: 1,
    evidenceSummary: binding.sectionTitle
      ? `${binding.sectionTitle} ${binding.values.slice(0, 6).map(value => value.code).join(', ')}`
      : binding.sample,
    detail: { form: 'slice', start: binding.start, end: binding.end, attribute: binding.target },
  }))
}

function legendBindingSectionSource(sectionId) {
  const section = legendSession.sections.find(item => item.id === sectionId)
  return section ? section.sourceId : ''
}

function legendCoverageFor(binding) {
  if (!legendSession.corpus || !legendSession.corpus.size) return null
  return legendSliceCoverage(legendSession.corpus, binding.start, binding.end, binding.values)
}

function legendCharStrip(sample) {
  const range = legendBindingRange()
  return [...sample].map((char, index) => {
    const on = range && index >= range.start && index < range.end
    return `<button class="char-btn ${on ? 'on' : ''}" data-legend-char="${index}" data-pos="${index + 1}" type="button" title="Character ${index + 1}">${esc(char === ' ' ? '·' : char)}</button>`
  }).join('')
}

function legendCoverageMarkup(coverage) {
  if (!coverage) return `<p class="profile-hint">Load project spreadsheets to check this segment against real tags.</p>`
  const list = (items, className) => items.slice(0, 8)
    .map(item => `<span class="legend-value ${className}">${esc(item.value)}<i>${item.count}</i></span>`).join('')
  return `<div class="legend-coverage">
    <div class="legend-coverage-head"><b>${coverage.tagsMatched}</b> tags · <b>${coverage.distinct}</b> distinct values${coverage.tooShort ? ` · ${coverage.tooShort} too short` : ''}</div>
    ${coverage.documented.length ? `<div class="legend-value-row"><span class="legend-value-label">In the legend</span>${list(coverage.documented, 'ok')}</div>` : ''}
    ${coverage.undocumented.length ? `<div class="legend-value-row"><span class="legend-value-label">Not in the legend</span>${list(coverage.undocumented, 'warn')}</div>` : ''}
    ${coverage.unused.length ? `<div class="legend-value-row"><span class="legend-value-label">Never used</span>${coverage.unused.slice(0, 8).map(code => `<span class="legend-value muted">${esc(code)}</span>`).join('')}</div>` : ''}
  </div>`
}

export function renderLegendAnatomyBinder() {
  /* A PDF alone is enough to show this. When the parser found nothing at all is
     exactly when the user most needs to point at the page themselves. */
  const pdfSources = legendSession.sources.filter(source => source.kind === 'pdf' && source.file)
  if (!legendSession.sections.length && !legendSession.sampleTags.length && !legendSession.bindings.length && !pdfSources.length) return ''
  const sample = legendBindingSample()
  const range = legendBindingRange()
  const selected = range && sample ? sample.slice(range.start, range.end) : ''
  const activeSection = legendBindingSection()

  return `<div class="profile-band" style="margin-top:14px">
    <div class="profile-band-head">${ic('tag')}Tag anatomy <span class="spacer"></span><span class="profile-rev">${legendSession.bindings.length}</span></div>
    <div class="profile-band-body">
      <p class="profile-hint">A numbering sheet points a character position at a value list with a drawn line, which does not survive text extraction. Select the characters, then pick the list that explains them.</p>
      ${pdfSources.length ? `<div class="profile-actions" style="margin:0 0 12px">
        <button class="btn sm" id="legendLassoLaunch" type="button" data-legend-lasso-source="${esc(pdfSources[0].id)}">${ic('crop')}Select from the page</button>
        <span class="profile-hint" style="margin:0">Missing a list, or the wrong one? Draw a box around it instead.</span>
      </div>` : ''}

      <div class="profile-field wide"><label for="legendBindSample">Sample tag</label>
        <div class="legend-sample-row">
          <select class="profile-select" id="legendBindSample">
            ${legendSession.sampleTags.map(tag => `<option value="${esc(tag.text)}" ${tag.text === sample ? 'selected' : ''}>${esc(tag.text)} · p. ${tag.page}</option>`).join('')}
            <option value="" ${legendSession.sampleTags.some(tag => tag.text === sample) ? '' : 'selected'}>Type one…</option>
          </select>
          <input class="profile-input" id="legendBindSampleText" value="${esc(sample)}" placeholder="e.g. ZZ9-QQQ-0001" aria-label="Sample tag">
        </div>
      </div>

      ${sample ? `<div class="char-strip">${legendCharStrip(sample)}</div>` : '<div class="profile-empty">Add a sample tag to begin</div>'}
      ${range ? `<p class="profile-hint">Characters <b>${range.start + 1}-${range.end}</b> → <code>${esc(selected)}</code></p>` : ''}

      <div class="profile-field wide"><label>Value list</label>
        <div class="legend-section-list">
          ${legendSession.sections.length ? legendSession.sections.map(section => `
            <button class="legend-section ${section.id === legendSession.binding.sectionId ? 'on' : ''}" data-legend-section="${esc(section.id)}" type="button">
              <span class="legend-section-title">${esc(section.title || 'Untitled block')}</span>
              <span class="legend-section-sub">p. ${section.page} · ${section.values.length} value${section.values.length === 1 ? '' : 's'}</span>
              <span class="legend-section-values">${section.values.slice(0, 6).map(value => esc(value.code)).join(' · ')}${section.values.length > 6 ? ' …' : ''}</span>
            </button>`).join('')
            : '<div class="profile-empty">No value lists were found in this document</div>'}
        </div>
      </div>
      ${activeSection ? `<details class="legend-why"><summary>${esc(activeSection.title || 'Untitled block')} — ${activeSection.values.length} values</summary><ul>
        ${activeSection.values.slice(0, 40).map(value => `<li><code>${esc(value.code)}</code> ${esc(value.meaning)}</li>`).join('')}
      </ul></details>` : ''}

      <div class="profile-field wide"><label for="legendBindTarget">This segment means</label>
        <select class="profile-select" id="legendBindTarget">
          <option value="">Choose…</option>
          ${LEGEND_BIND_TARGETS.map(target => `<option value="${target}" ${legendSession.binding.target === target ? 'selected' : ''}>${target}</option>`).join('')}
        </select>
      </div>

      <div class="profile-actions"><button class="btn primary sm" id="legendBindAdd" type="button">${ic('plus')}Add segment</button></div>

      ${legendSession.bindings.length ? `<div class="profile-list" style="margin-top:12px">
        ${legendSession.bindings.map(binding => {
          const coverage = legendCoverageFor(binding)
          return `<div class="profile-list-row">
            <div class="profile-list-main">
              <div class="profile-list-title"><code>${esc(binding.sample.slice(binding.start, binding.end))}</code> → ${esc(binding.target)}</div>
              <div class="profile-list-sub">Characters ${binding.start + 1}-${binding.end}${binding.sectionTitle ? ' · ' + esc(binding.sectionTitle) : ''}</div>
              ${legendCoverageMarkup(coverage)}
            </div>
            <button class="profile-icon-btn icon-btn" data-legend-unbind="${esc(binding.id)}" type="button" aria-label="Remove segment">${ic('x')}</button>
          </div>`
        }).join('')}
      </div>` : ''}
    </div>
  </div>`
}

export function wireLegendAnatomyBinder(profile) {
  $$('[data-legend-char]').forEach(button => button.onclick = () => {
    const index = Number(button.dataset.legendChar)
    const binding = legendSession.binding
    if (binding.start == null || binding.end != null) { binding.start = index; binding.end = null }
    else binding.end = index
    legendSession.binding.sample = legendBindingSample()
    renderProfile()
  })
  const select = $('#legendBindSample')
  if (select) select.onchange = () => {
    legendSession.binding.sample = select.value
    legendSession.binding.start = null; legendSession.binding.end = null
    renderProfile()
  }
  const text = $('#legendBindSampleText')
  if (text) text.onchange = () => {
    legendSession.binding.sample = clean(text.value)
    legendSession.binding.start = null; legendSession.binding.end = null
    renderProfile()
  }
  $$('[data-legend-section]').forEach(button => button.onclick = () => {
    legendSession.binding.sectionId = legendSession.binding.sectionId === button.dataset.legendSection ? '' : button.dataset.legendSection
    renderProfile()
  })
  const target = $('#legendBindTarget')
  if (target) target.onchange = () => { legendSession.binding.target = target.value }
  const add = $('#legendBindAdd')
  if (add) add.onclick = () => { if (legendCommitBinding(profile)) { toast('Segment added'); renderProfile() } }
  const launch = $('#legendLassoLaunch')
  if (launch) launch.onclick = () => legendLassoOpen(launch.dataset.legendLassoSource, 1)
  $('[data-legend-unbind]').forEach(button => button.onclick = () => {
    legendRemoveBinding(button.dataset.legendUnbind, profile); renderProfile()
  })
}

/* ---- lasso region selection ----
   The binder offers what the parser found. This offers what it did not: the
   page as drawn, and a box the user drags around the region they mean.

   Nothing is rasterised until this opens, and only the one page being looked at
   is. The tokens come back from the same render call as the image, in the same
   upright space, so a pointer position maps to a token box as a plain fraction
   of the element -- which is what makes the mapping survive any CSS size, any
   zoom, and any device pixel ratio. */

/** Minimum drag, in points, before a selection is taken seriously. */
export const LEGEND_LASSO_MIN_DRAG = 6

/** Render a page and hold it for selection. */
export async function legendLassoOpen(sourceId, pageNumber) {
  const source = legendSession.sources.find(item => item.id === sourceId)
  const lasso = legendSession.lasso
  lasso.open = true
  lasso.sourceId = sourceId
  lasso.error = ''
  lasso.busy = true
  lasso.from = null; lasso.to = null; lasso.preview = null
  renderProfile()
  try {
    if (!source || !source.file) throw new Error('That document is no longer loaded. Re-add it to select a region.')
    if (source.kind !== 'pdf') throw new Error('Only PDF pages can be shown. Use the lists above for a spreadsheet or pasted text.')
    const buffer = await source.file.arrayBuffer()
    const rendered = await legendPdfRenderPage(new Uint8Array(buffer), pageNumber, {})
    lasso.canvas = rendered.canvas
    lasso.page = rendered.page
    lasso.pageCount = rendered.pageCount
    lasso.width = rendered.width
    lasso.height = rendered.height
    lasso.tokens = rendered.tokens
  } catch (error) {
    lasso.error = clean(error && error.message) || 'That page could not be shown.'
    lasso.canvas = null
    lasso.tokens = []
  } finally {
    lasso.busy = false
    renderProfile()
  }
}

/** Drop the bitmap and the page's tokens -- both are only worth holding while open. */
export function legendLassoClose() {
  legendSession.lasso = emptyLegendSession().lasso
  renderProfile()
}

/** A pointer event to a point in the page's own coordinate space. */
export function legendLassoPoint(event, element) {
  const box = element.getBoundingClientRect()
  const lasso = legendSession.lasso
  if (!box.width || !box.height) return { x: 0, y: 0 }
  return {
    x: ((event.clientX - box.left) / box.width) * lasso.width,
    y: ((event.clientY - box.top) / box.height) * lasso.height,
  }
}

/** The current drag as a rect, or null when there is not one worth using. */
export function legendLassoCurrentRect() {
  const { from, to } = legendSession.lasso
  if (!from || !to) return null
  const rect = legendLassoRect(from, to)
  if (legendRectWidth(rect) < LEGEND_LASSO_MIN_DRAG || legendRectHeight(rect) < LEGEND_LASSO_MIN_DRAG) return null
  return rect
}

/** Reconstruct whatever is currently selected, so the user sees it before committing. */
export function legendLassoBuildPreview() {
  const lasso = legendSession.lasso
  const rect = legendLassoCurrentRect()
  if (!rect) { lasso.preview = null; return null }
  const region = legendLassoRegion(lasso.tokens, rect, { page: lasso.page, pageWidth: lasso.width })
  lasso.preview = {
    rect,
    tokenCount: region.tokenCount,
    lines: legendLassoLines(region),
    sections: legendSections([region]),
    sampleTags: legendSampleTags([region]),
  }
  return lasso.preview
}

/**
 * Take the selection as one or more value lists.
 *
 * The section is pushed onto the same list the binder already reads, so a
 * lassoed block and a parsed one are indistinguishable from that point on.
 */
export function legendLassoUseAsSection() {
  const preview = legendSession.lasso.preview
  if (!preview || !preview.sections.length) { toast('Nothing in that selection reads as a value list'); return 0 }
  const sourceId = legendSession.lasso.sourceId
  /* Same title, same values, same page is the same list. Dragging a box twice
     over one block is an easy thing to do, and two identical entries in the
     picker are indistinguishable -- the user cannot tell which one to bind. */
  const signature = section => [section.page, section.title, ...section.values.map(value => value.code + '=' + value.meaning)].join(' ')
  const existing = new Set(legendSession.sections.map(signature))
  let added = 0
  let duplicates = 0
  for (const section of preview.sections) {
    if (existing.has(signature({ ...section, page: legendSession.lasso.page }))) { duplicates++; continue }
    legendSession.sections.push({
      ...section,
      id: sourceId + '/lasso-' + legendSession.sections.length + '-' + added,
      sourceId, page: legendSession.lasso.page, lassoed: true,
    })
    added++
  }
  if (!added) { toast(duplicates ? 'That list is already in the picker' : 'Nothing in that selection reads as a value list'); return 0 }
  toast(added === 1 ? 'Value list added' : added + ' value lists added')
  return added
}

/**
 * The tag inside a selection.
 *
 * Never the lines joined together. A sample tag is ONE string whose character
 * positions get bound to meanings, and a legend prints its sample inside a
 * worked example -- `ZZ9-QQQ-4321 = Building-Equipment Type-Unit`. Joining the
 * selection would make that 43-character sentence the "tag", and every position
 * counted along it would be meaningless. The code side of a definition is the
 * tag; the explanation after the separator is not.
 */
export function legendLassoSampleText(preview) {
  const detected = clean(preview.sampleTags[0] && preview.sampleTags[0].text)
  if (detected) return detected
  for (const line of preview.lines) {
    const inline = legendSplitInline(line)
    if (inline && /\d/.test(inline.code)) return inline.code
  }
  return clean(preview.lines[0] || '')
}

/** Take the selection as a sample tag. */
export function legendLassoUseAsSample() {
  const preview = legendSession.lasso.preview
  if (!preview) { toast('Drag a box around the tag first'); return '' }
  const text = legendLassoSampleText(preview)
  if (!text) { toast('That selection has no text in it'); return '' }
  if (!legendSession.sampleTags.some(tag => tag.text === text)) {
    legendSession.sampleTags.push({ text, page: legendSession.lasso.page, sourceId: legendSession.lasso.sourceId, lassoed: true })
  }
  legendSession.binding.sample = text
  legendSession.binding.start = null
  legendSession.binding.end = null
  toast('Sample tag set')
  return text
}

function legendLassoRectStyle(rect) {
  const lasso = legendSession.lasso
  if (!rect || !lasso.width || !lasso.height) return 'display:none'
  return `left:${(rect.x0 / lasso.width) * 100}%;top:${(rect.y0 / lasso.height) * 100}%;`
    + `width:${(legendRectWidth(rect) / lasso.width) * 100}%;height:${(legendRectHeight(rect) / lasso.height) * 100}%`
}

export function renderLegendLassoOverlay() {
  const lasso = legendSession.lasso
  if (!lasso.open) return ''
  const preview = lasso.preview
  const pdfSources = legendSession.sources.filter(source => source.kind === 'pdf')

  return `<div class="legend-lasso-back" id="legendLassoBack" role="dialog" aria-modal="true" aria-label="Select a region of the page">
    <div class="legend-lasso-card">
      <div class="legend-lasso-head">
        <div class="legend-lasso-title">
          <b>Select a region</b>
          <span class="legend-lasso-sub">Drag a box around a value list or a sample tag.</span>
        </div>
        <div class="legend-lasso-nav">
          ${pdfSources.length > 1 ? `<select class="profile-select sm" id="legendLassoSource">
            ${pdfSources.map(source => `<option value="${esc(source.id)}" ${source.id === lasso.sourceId ? 'selected' : ''}>${esc(source.name || 'Document')}</option>`).join('')}
          </select>` : ''}
          <button class="btn sm" id="legendLassoPrev" type="button" aria-label="Previous page" ${lasso.page <= 1 || lasso.busy ? 'disabled' : ''}>${ic('chevron-left')}</button>
          <span class="legend-lasso-page">${lasso.busy ? '…' : `${lasso.page} / ${lasso.pageCount || '?'}`}</span>
          <button class="btn sm" id="legendLassoNext" type="button" aria-label="Next page" ${(lasso.pageCount && lasso.page >= lasso.pageCount) || lasso.busy ? 'disabled' : ''}>${ic('chevron-right')}</button>
          <button class="btn sm" id="legendLassoClose" type="button" aria-label="Close">${ic('x')}</button>
        </div>
      </div>

      ${lasso.error ? `<div class="legend-lasso-error">${esc(lasso.error)}</div>` : ''}
      <div class="legend-lasso-stage ${lasso.busy ? 'busy' : ''}" id="legendLassoStage">
        ${lasso.busy ? '<div class="legend-lasso-loading">Rendering page…</div>' : ''}
        <!-- The marquee is positioned against this frame, NOT the stage. Absolute
             percentages resolve against the containing block's padding box, so
             anchoring to the padded, scrolling stage put the box up to 17px away
             from the region it claims to describe. The frame shrink-wraps the
             canvas, which makes the percentages exact. -->
        <div class="legend-lasso-frame" id="legendLassoFrame">
          <div class="legend-lasso-rect" id="legendLassoRect" style="${preview ? legendLassoRectStyle(preview.rect) : 'display:none'}"></div>
        </div>
      </div>

      <div class="legend-lasso-foot">
        ${preview ? `<div class="legend-lasso-preview">
          <div class="legend-lasso-count">${preview.tokenCount} token${preview.tokenCount === 1 ? '' : 's'}${preview.sections.length ? ` · ${preview.sections.length} value list${preview.sections.length === 1 ? '' : 's'}` : ''}</div>
          <div class="legend-lasso-lines">${preview.lines.slice(0, 6).map(line => `<span>${esc(line)}</span>`).join('')}${preview.lines.length > 6 ? `<span class="muted">+${preview.lines.length - 6} more</span>` : ''}</div>
        </div>` : '<div class="legend-lasso-preview muted">Nothing selected yet.</div>'}
        <div class="legend-lasso-actions">
          <button class="btn sm" id="legendLassoAsSample" type="button" ${preview ? '' : 'disabled'}>Use as sample tag</button>
          <button class="btn primary sm" id="legendLassoAsSection" type="button" ${preview && preview.sections.length ? '' : 'disabled'}>${ic('plus')}Use as value list</button>
        </div>
      </div>
    </div>
  </div>`
}

export function wireLegendLassoOverlay() {
  const lasso = legendSession.lasso
  if (!lasso.open) return
  const frame = $('#legendLassoFrame')
  const marquee = $('#legendLassoRect')

  /* The canvas is held in session state and re-appended on every render. It
     cannot live in the markup -- innerHTML would discard the bitmap and force
     a re-render of the page on every keystroke elsewhere in the tab. */
  if (frame && lasso.canvas) frame.insertBefore(lasso.canvas, frame.firstChild)

  const close = $('#legendLassoClose')
  if (close) close.onclick = () => legendLassoClose()
  const back = $('#legendLassoBack')
  if (back) back.onclick = event => { if (event.target === back) legendLassoClose() }

  const prev = $('#legendLassoPrev')
  if (prev) prev.onclick = () => legendLassoOpen(lasso.sourceId, lasso.page - 1)
  const next = $('#legendLassoNext')
  if (next) next.onclick = () => legendLassoOpen(lasso.sourceId, lasso.page + 1)
  const picker = $('#legendLassoSource')
  if (picker) picker.onchange = () => legendLassoOpen(picker.value, 1)

  const asSection = $('#legendLassoAsSection')
  if (asSection) asSection.onclick = () => { if (legendLassoUseAsSection()) { legendRebuildProposals(S.profileDraft); renderProfile() } }
  const asSample = $('#legendLassoAsSample')
  if (asSample) asSample.onclick = () => { if (legendLassoUseAsSample()) renderProfile() }

  if (!frame || !lasso.canvas) return
  /* The drag updates the marquee's style DIRECTLY and re-renders only on
     release. Re-rendering per pointermove would rebuild the tab, and with it
     the canvas, dozens of times a second. */
  frame.onpointerdown = event => {
    if (event.button !== 0) return
    lasso.from = legendLassoPoint(event, frame)
    lasso.to = null
    lasso.preview = null
    if (marquee) marquee.style.cssText = 'display:none'
    try { frame.setPointerCapture(event.pointerId) } catch (_) { /* not captureable */ }
    event.preventDefault()
  }
  frame.onpointermove = event => {
    if (!lasso.from) return
    lasso.to = legendLassoPoint(event, frame)
    const rect = legendLassoRect(lasso.from, lasso.to)
    if (marquee) marquee.style.cssText = legendLassoRectStyle(rect)
  }
  frame.onpointerup = event => {
    if (!lasso.from) return
    lasso.to = legendLassoPoint(event, frame)
    try { frame.releasePointerCapture(event.pointerId) } catch (_) { /* never captured */ }
    legendLassoBuildPreview()
    if (!lasso.preview) { lasso.from = null; lasso.to = null }
    renderProfile()
  }
}
