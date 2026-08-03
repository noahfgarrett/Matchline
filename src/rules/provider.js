import { createEngine } from './engine.js'
import { makeEagleRuleProfile } from './defaults.js'
import { migrateProfile } from './schema.js'

let activeRuleProfile = null
let cachedEngine = null

function effectiveProfile() {
  /* Profiles are executable documents, not hints. The old provider silently
     substituted the shipped rules whenever a profile's origin lacked a rules
     container; adding one custom rule then disabled the inherited set. Every
     stored profile now materializes its complete rules, so execution is stable
     across app versions and exported profiles are genuinely portable. */
  return migrateProfile(activeRuleProfile || makeEagleRuleProfile())
}

export function setRuleProfile(profile) {
  activeRuleProfile = profile || null
  cachedEngine = null
}

export function invalidateRuleEngine() {
  cachedEngine = null
}

export function ruleEngine() {
  if (!cachedEngine) cachedEngine = createEngine(effectiveProfile())
  return cachedEngine
}
