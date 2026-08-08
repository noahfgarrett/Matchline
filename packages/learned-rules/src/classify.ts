/**
 * Applying the learned description table (donor `assignClassifications`).
 *
 * The rule is deliberately literal: the description is normalized, its digit
 * runs are masked, and the resulting pattern is looked up EXACTLY. No fuzzy
 * matching, no nearest-neighbour, no falling back to a different discipline --
 * a class that is guessed is a class that quietly re-parents equipment.
 */
import { classificationKey } from './keys.js';
import { CLASSIFICATION_MIN_CONFIDENCE } from './thresholds.js';
import { descriptionPattern, normalizeText } from './text.js';
import type { ClassificationEntry, ClassificationResult, LearnedRuleSet } from './types.js';

/**
 * Lookup index per rule set. A rule set is an immutable value, so caching by
 * identity is safe, and `proposeNestings` classifies once per asset.
 */
const indexCache = new WeakMap<LearnedRuleSet, ReadonlyMap<string, ClassificationEntry>>();

function indexOf(ruleSet: LearnedRuleSet): ReadonlyMap<string, ClassificationEntry> {
  const cached = indexCache.get(ruleSet);
  if (cached !== undefined) return cached;
  const index = new Map<string, ClassificationEntry>();
  for (const entry of ruleSet.classification) {
    index.set(classificationKey(entry.discipline, entry.pattern), entry);
  }
  indexCache.set(ruleSet, index);
  return index;
}

/**
 * The class a description predicts, or `null` when the table cannot answer at
 * the donor's 0.9 confidence gate.
 *
 * Confidence is the dominant class's share of the training rows behind the
 * pattern -- `topCount / total` in the donor's `lookup`. A pattern that carried
 * one class every time scores 1; a pattern that split nine-to-one scores 0.9
 * and still answers; anything muddier returns `null` and the asset stays
 * unclassified rather than being nudged into a role it may not have.
 *
 * `discipline` is part of the key, exactly as in the donor. Omitting it looks
 * the pattern up under the empty discipline -- what rows with no discipline
 * trained under -- and does not scan the other disciplines.
 */
export function classifyDescription(
  ruleSet: LearnedRuleSet,
  description: string | undefined,
  discipline?: string,
): ClassificationResult | null {
  const pattern = descriptionPattern(description);
  if (pattern === '') return null;
  const entry = indexOf(ruleSet).get(classificationKey(normalizeText(discipline), pattern));
  if (entry === undefined) return null;
  if (entry.confidence < CLASSIFICATION_MIN_CONFIDENCE) return null;
  return { class: entry.class, confidence: entry.confidence };
}
