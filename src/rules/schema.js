import { clean } from '../core/text.js'

export const RULES_SCHEMA_VERSION = 3

/**
 * The first version that carried rule containers. Below it, a profile predates
 * the rules engine entirely and its original payload is worth retaining so the
 * upgrade can be rolled back; at or above it, every later migration is purely
 * additive and there is nothing to roll back to.
 *
 * Kept separate from RULES_SCHEMA_VERSION deliberately. Tying the migratedFrom
 * capture to "not the current version" would mean every stored v2 profile got a
 * complete second copy of itself the moment v3 shipped -- doubling every user's
 * stored payload to retain a snapshot that differs only by an empty container.
 */
export const PRE_RULES_SCHEMA_VERSION = 2

/** The three rule families. Order within each array is significant. */
export function emptyRuleSet() {
  return { normalize: [], classify: [], relate: [] }
}

/**
 * Compact, reviewed knowledge extracted from a design legend. Deliberately
 * additive and deliberately small: no raw document bytes, no page text, no OCR
 * output -- only what a human already saw and approved. See
 * src/profile/legend.js for the caps that keep it that way.
 */
export function emptyLegendTraining() {
  return { version: 1, sources: [], pendingEntries: [], ruleOrigins: {}, dismissedEntryHashes: [] }
}

/**
 * Upgrade a stored profile to v2. Additive only: v1 fields are preserved
 * untouched and the new containers start empty, so a migrated profile
 * behaves exactly as it did before until someone authors rules.
 *
 * Runs its repairs unconditionally rather than early-returning on a matching
 * schemaVersion, so a hand-edited or truncated import that claims to be v2
 * but carries no rule containers still gets them. The containers are rebuilt
 * from whatever was there, so this stays idempotent.
 *
 * migratedFrom is the PRE-v2 payload and is captured exactly once. It used to
 * be re-wrapped on every call, which nested it one level deeper each time a
 * profile was saved -- publishProfileDraft normalises a draft that is itself
 * already normalised -- growing the stored payload without bound until
 * localStorage threw and persistProfiles silently downgraded to session
 * storage, losing the profile on close.
 */
export function migrateProfile(raw) {
  const profile = raw && typeof raw === 'object' ? { ...raw } : {}
  if ((Number(profile.schemaVersion) || 0) < PRE_RULES_SCHEMA_VERSION && !profile.migratedFrom) {
    profile.migratedFrom = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : {}
  }
  profile.schemaVersion = RULES_SCHEMA_VERSION
  profile.anatomies = Array.isArray(profile.anatomies) ? profile.anatomies : []
  const rules = profile.rules && typeof profile.rules === 'object' ? profile.rules : {}
  profile.rules = {
    normalize: Array.isArray(rules.normalize) ? rules.normalize : [],
    classify: Array.isArray(rules.classify) ? rules.classify : [],
    relate: Array.isArray(rules.relate) ? rules.relate : [],
  }
  profile.hierarchy = profile.hierarchy && typeof profile.hierarchy === 'object' ? profile.hierarchy : {}
  /* Structural repair only, matching the containers above -- caps, record
     validation, and size limits belong to normalizeLegendTraining, which runs
     from normalizeProfile. Keeping this dependency-free means migrateProfile
     stays importable on its own. */
  const legend = profile.legendTraining && typeof profile.legendTraining === 'object' ? profile.legendTraining : {}
  const origins = legend.ruleOrigins
  profile.legendTraining = {
    version: 1,
    sources: Array.isArray(legend.sources) ? legend.sources : [],
    pendingEntries: Array.isArray(legend.pendingEntries) ? legend.pendingEntries : [],
    ruleOrigins: origins && typeof origins === 'object' && !Array.isArray(origins) ? origins : {},
    dismissedEntryHashes: Array.isArray(legend.dismissedEntryHashes) ? legend.dismissedEntryHashes : [],
  }
  return profile
}

/** A rule is enabled unless explicitly disabled, and must carry an id. */
export function isRuleEnabled(rule) {
  return !!rule && rule.enabled !== false && !!clean(rule.id)
}
