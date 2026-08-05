import { createEngine } from './engine.js'
import { makeEagleRuleProfile } from './defaults.js'
import { migrateProfile } from './schema.js'

let activeRuleProfile = null
let cachedEngine = null
/* Bumped whenever the active engine can change, so tag-level memo caches
   (cleanTag, cleanRegisterTag) know their entries are stale. */
let engineGeneration = 0

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
  engineGeneration++
}

export function invalidateRuleEngine() {
  cachedEngine = null
  engineGeneration++
}

export function ruleEngineGeneration() {
  return engineGeneration
}

export function ruleEngine() {
  if (!cachedEngine) cachedEngine = createEngine(effectiveProfile())
  return cachedEngine
}
