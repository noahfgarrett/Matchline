/**
 * The System Resolver (PRODUCT.md §5).
 *
 * Ordered chains of components. Every rung that yields produces a claim, the
 * first yielding rung supplies the resolved value, and every losing claim is
 * kept (ENGINE.md semantics rule 2). Disagreement is an output, not an
 * exception: the compile finishes and the ambiguity arrives as a review item.
 *
 * Two things override chain order:
 *
 * 1. A manual assignment wins outright wherever its rung sits, and even when
 *    the profile configured no `manual` rung at all -- the human is the final
 *    authority (PRODUCT.md §4.1). The other claims are still kept.
 * 2. Nothing else. There is no majority vote and no tier tie-break; a profile
 *    that wants precedence has to say `conflictPolicy: 'precedence'` out loud.
 */
import type {
  Provenance,
  ReviewItem,
  SystemComponentConfig,
  SystemConflictStatus,
  SystemResolution,
  SystemResolverConfig,
} from '@matchline/domain';
import { applyAnatomy, type AnatomyResult } from '@matchline/tag-anatomy';

import { evaluateComponent, ruleIdOf, sourceKindOf, type RungContext } from './chain.js';
import { buildMelIndexes, type MelIndexes } from './join.js';
import { buildLabel } from './label.js';
import { normalizeSystemValue } from './normalize.js';
import type {
  ChainName,
  KeyAgreement,
  ManualAssignment,
  ResolveContext,
  ResolveSystemsResult,
  ResolverSubject,
  SkippedRung,
  SubjectResolution,
  SystemClaim,
} from './types.js';

/** How `KeyAgreement` reads in the domain's published vocabulary. */
export const CONFLICT_STATUS_OF = {
  'single-source': 'AGREED',
  agreement: 'AGREED',
  'resolved-by-precedence': 'RESOLVED_BY_TIER',
  'manual-override': 'RESOLVED_BY_TIER',
  conflict: 'CONFLICTING',
  unresolved: 'UNRESOLVED',
} as const satisfies Record<KeyAgreement, SystemConflictStatus>;

const MANUAL_COMPONENT: SystemComponentConfig = { kind: 'manual' };

interface ChainRun {
  readonly claims: ReadonlyArray<SystemClaim>;
  readonly skipped: ReadonlyArray<SkippedRung>;
}

/**
 * Runs one chain end to end.
 *
 * `normalize` is true for the key chain only. Descriptions are display text:
 * padding or upper-casing one would corrupt it to no benefit, and §5.5's
 * safeguards exist for identifiers.
 *
 * When `manual` states a value for this chain's attribute and the configured
 * chain contains no `manual` rung, one is evaluated anyway at the position
 * immediately after the chain, so the human's answer is always a real claim
 * with real provenance rather than a value appearing from nowhere.
 */
function runChain(
  components: ReadonlyArray<SystemComponentConfig>,
  chain: ChainName,
  attribute: 'systemKey' | 'systemDescription',
  config: SystemResolverConfig,
  subject: ResolverSubject,
  anatomy: AnatomyResult | null,
  context: ResolveContext,
  manual: ManualAssignment | undefined,
  seedJoinKey: string | null,
  indexes: MelIndexes,
): ChainRun {
  const claims: SystemClaim[] = [];
  const skipped: SkippedRung[] = [];
  const normalize = attribute === 'systemKey';

  // In the key chain this fills in from the first rung that yields, so a
  // mel-lookup joining by systemKey can only ever see rungs above it. In the
  // description chain it arrives already set to the resolved key.
  let joinKey = seedJoinKey;
  let sawManualRung = false;

  const evaluateAt = (component: SystemComponentConfig, rungIndex: number): void => {
    const rungContext: RungContext = {
      subject,
      anatomy,
      catalog: context.catalog,
      melRows: context.melRows,
      manual,
      joinKey,
      joinIndex: indexes.join,
      melRowIndex: indexes.rows,
      melTagIndex: indexes.byTag,
    };
    const outcome = evaluateComponent(component, chain, rungIndex, rungContext);
    if (!outcome.ok) {
      skipped.push({
        chain,
        rungIndex,
        component: component.kind,
        reason: outcome.reason,
        detail: outcome.detail,
      });
      return;
    }

    const normalized = normalize
      ? normalizeSystemValue(outcome.rawValue, config.normalization)
      : { raw: outcome.rawValue, value: outcome.rawValue, transforms: [] };

    if (normalized.value.length === 0) {
      skipped.push({
        chain,
        rungIndex,
        component: component.kind,
        reason: 'blank-value',
        detail: `"${outcome.rawValue}" normalized to blank`,
      });
      return;
    }

    claims.push({
      subjectAssetId: subject.assetId,
      attribute,
      proposedValue: normalized.value,
      source: sourceKindOf(component.kind),
      rule: ruleIdOf(chain, rungIndex, component.kind),
      evidenceTier: outcome.evidenceTier,
      provenance: outcome.provenance,
      component: component.kind,
      chain,
      rungIndex,
      rawValue: normalized.raw,
      transforms: normalized.transforms,
    });

    if (chain === 'keyChain' && joinKey === null) {
      joinKey = normalized.value;
    }
  };

  components.forEach((component, rungIndex) => {
    if (component.kind === 'manual') {
      sawManualRung = true;
    }
    evaluateAt(component, rungIndex);
  });

  const manualValue =
    (attribute === 'systemKey' ? manual?.systemKey : manual?.systemDescription)?.trim() ?? '';
  if (!sawManualRung && manualValue.length > 0) {
    evaluateAt(MANUAL_COMPONENT, components.length);
  }

  return { claims, skipped };
}

function distinctValues(claims: ReadonlyArray<SystemClaim>): ReadonlyArray<string> {
  const seen: string[] = [];
  for (const claim of claims) {
    if (!seen.includes(claim.proposedValue)) {
      seen.push(claim.proposedValue);
    }
  }
  return seen;
}

function classify(
  claims: ReadonlyArray<SystemClaim>,
  manualClaim: SystemClaim | null,
  policy: SystemResolverConfig['conflictPolicy'],
): KeyAgreement {
  if (claims.length === 0) {
    return 'unresolved';
  }
  if (distinctValues(claims).length === 1) {
    return claims.length === 1 ? 'single-source' : 'agreement';
  }
  if (manualClaim !== null) {
    return 'manual-override';
  }
  return policy === 'precedence' ? 'resolved-by-precedence' : 'conflict';
}

function firstManual(claims: ReadonlyArray<SystemClaim>): SystemClaim | null {
  return claims.find((claim) => claim.component === 'manual') ?? null;
}

/**
 * Resolves one subject. Exported for callers that stream assets one at a time.
 *
 * The MEL indexes are rebuilt per call here; `resolveSystems` builds them once
 * and shares them, which is what keeps a whole-model compile off an O(subjects
 * x MEL rows) path.
 */
export function resolveSubject(
  subject: ResolverSubject,
  config: SystemResolverConfig,
  context: ResolveContext,
): SubjectResolution {
  return resolveSubjectWith(
    subject,
    config,
    context,
    buildMelIndexes(context.catalog, context.melRows, config.normalization),
  );
}

function resolveSubjectWith(
  subject: ResolverSubject,
  config: SystemResolverConfig,
  context: ResolveContext,
  indexes: MelIndexes,
): SubjectResolution {
  const anatomy: AnatomyResult | null =
    context.anatomy === undefined ? null : applyAnatomy(context.anatomy, subject.canonicalTag);
  const manual = context.manual?.get(subject.assetId);

  const keyRun = runChain(
    config.keyChain,
    'keyChain',
    'systemKey',
    config,
    subject,
    anatomy,
    context,
    manual,
    null,
    indexes,
  );

  const manualKeyClaim = firstManual(keyRun.claims);
  const keyClaim = manualKeyClaim ?? keyRun.claims[0] ?? null;
  const agreement = classify(keyRun.claims, manualKeyClaim, config.conflictPolicy);

  // The description chain joins on the key the key chain settled, not on
  // whatever a rung above it happened to see (PRODUCT.md §5.3).
  const descriptionRun = runChain(
    config.descriptionChain,
    'descriptionChain',
    'systemDescription',
    config,
    subject,
    anatomy,
    context,
    manual,
    keyClaim === null ? null : keyClaim.proposedValue,
    indexes,
  );

  const descriptionClaim =
    firstManual(descriptionRun.claims) ?? descriptionRun.claims[0] ?? null;

  const claims = [...keyRun.claims, ...descriptionRun.claims];
  const skippedRungs = [...keyRun.skipped, ...descriptionRun.skipped];
  const reviewItems: ReviewItem[] =
    agreement === 'conflict'
      ? [{ kind: 'system-conflict', assetId: subject.assetId, claims: keyRun.claims }]
      : [];

  if (keyClaim === null) {
    // Nothing yielded a key, so there is no system. Nothing is invented to
    // fill the gap; the description claims, if any, are still kept.
    return {
      resolution: null,
      claims,
      keyClaim: null,
      descriptionClaim,
      agreement: 'unresolved',
      skippedRungs,
      reviewItems,
    };
  }

  const systemKey = keyClaim.proposedValue;
  const systemDescription = descriptionClaim?.proposedValue;
  const systemEvidence: ReadonlyArray<Provenance> = claims.map((claim) => claim.provenance);

  const resolution: SystemResolution = {
    systemKey,
    ...(systemDescription === undefined ? {} : { systemDescription }),
    systemLabel: buildLabel(systemKey, systemDescription, config.labelTemplate),
    systemEvidence,
    systemConfidenceTier: keyClaim.evidenceTier,
    systemConflictStatus: CONFLICT_STATUS_OF[agreement],
  };

  return { resolution, claims, keyClaim, descriptionClaim, agreement, skippedRungs, reviewItems };
}

/**
 * Resolves every subject.
 *
 * Deterministic: subjects are processed in input order, `bySubject` preserves
 * it, and review items come out in the same order. Same subjects plus same
 * profile always produce byte-identical output (ENGINE.md semantics rule 3).
 *
 * A repeated `assetId` overwrites the earlier entry in `bySubject`; asset ids
 * are unique by construction upstream, and inventing a merge rule here would
 * hide the upstream defect.
 */
export function resolveSystems(
  subjects: ReadonlyArray<ResolverSubject>,
  config: SystemResolverConfig,
  context: ResolveContext = {},
): ResolveSystemsResult {
  const bySubject = new Map<string, SubjectResolution>();
  const reviewItems: ReviewItem[] = [];
  const indexes = buildMelIndexes(context.catalog, context.melRows, config.normalization);

  for (const subject of subjects) {
    const resolved = resolveSubjectWith(subject, config, context, indexes);
    bySubject.set(subject.assetId, resolved);
    reviewItems.push(...resolved.reviewItems);
  }

  return { bySubject, reviewItems };
}
