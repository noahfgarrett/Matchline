/**
 * Claims assembly (ENGINE.md E3, PRODUCT.md §11.1).
 *
 * Every source that has anything to say about structure says it here, as a
 * claim, with provenance and a ladder rung. Nothing is resolved: two rungs may
 * propose different parents for one asset and both survive, because choosing is
 * the parent ladder's job in `@matchline/ssm-compiler`.
 *
 * Three rules run through the whole file:
 *
 * 1. Nothing is invented. A tag identity could not resolve, or an asset id no
 *    subject carries, produces no claim -- and lands in `skipped` so the dead
 *    rule is visible instead of silent.
 * 2. Proposal-grade learned rules never become claims. They are review items,
 *    full stop (DECISIONS.md #3).
 * 3. Connectivity is always at least a dependency (PRODUCT.md §8.2), and it is
 *    only structure when a family key and a taught role pairing agree with it.
 *
 * The SSM SOP's own rules are one more source among these (`./sop.ts`), on the
 * `sop-rule` rung, and they follow all three: they invent no asset, they never
 * become a proposal, and they claim a power path only where connectivity states
 * one.
 */
import type {
  LadderSourceKind,
  ManualRelationshipOverride,
  NestingProposalReviewItem,
  Provenance,
  RelationshipType,
  RoleGraphConfig,
  SsmRelationshipClaim,
} from '@matchline/domain';

import {
  DEPENDENCY_RULE,
  LADDER_SOURCE_EVIDENCE_TIER,
  LADDER_SOURCE_KIND,
  LADDER_SOURCE_RELATIONSHIP_TYPE,
  LADDER_SOURCE_RULE,
  ladderRung,
} from './mapping.js';
import { compareClaims, compareProposals, compareSkipped, compareText } from './order.js';
import { sopClaims } from './sop.js';
import type {
  AssembleOptions,
  AssembledClaims,
  ClaimSubject,
  DuplicateTagTarget,
  MakeRootDirective,
  ProfileSourceRef,
  ResolveTag,
  SkipReason,
  SkippedClaimInput,
} from './types.js';

/** A family member that actually has the two things family rules read. */
interface FamilyMember {
  readonly assetId: string;
  readonly role: string;
}

/**
 * Profile-borne rules are tables, not documents, so they are addressed as
 * (table name, 1-based entry position). A reviewer chasing a claim lands on the
 * exact rule that made it rather than on "the profile".
 */
const MANUAL_OVERRIDE_TABLE = 'manualOverrides';
const PROFILE_LOOKUP_TABLE = 'profileLookup';
const PRIOR_SSM_TABLE = 'priorSsm';
const LEARNED_RULE_TABLE = 'learnedRules';
const ROLE_GRAPH_TABLE = 'roleGraph';

/** Used when the caller names no profile document. */
export const DEFAULT_PROFILE_SOURCE: ProfileSourceRef = { sourceFile: 'site-profile' };

/** Used when a subject states an explicit parent but carries no provenance. */
export const DEFAULT_MODEL_SOURCE_FILE = 'model';

/** NUL appears in no tag, role or asset id, so composed keys stay unambiguous. */
const KEY_SEPARATOR = '\u0000';

function pairKey(childAssetId: string, parentAssetId: string): string {
  return `${childAssetId}${KEY_SEPARATOR}${parentAssetId}`;
}

function profileProvenance(
  source: ProfileSourceRef,
  sheet: string,
  row: number,
  rule: string,
  fallbackRung: number,
  manualDecision?: string,
): Provenance {
  return {
    sourceFile: source.sourceFile,
    sourceRef: { kind: 'sheet-row', sheet, row },
    rule,
    fallbackRung,
    ...(manualDecision === undefined ? {} : { manualDecision }),
    ...(source.profileRevision === undefined ? {} : { profileRevision: source.profileRevision }),
  };
}

/**
 * One parent proposal.
 *
 * `subjectAssetId` is the child and `targetAssetId` the proposed parent -- the
 * orientation `SsmRelationshipClaim` fixes, stated once here so no rung can
 * quietly reverse it.
 */
function structuralClaim(
  ladderSource: LadderSourceKind,
  childAssetId: string,
  parentAssetId: string,
  provenance: Provenance,
): SsmRelationshipClaim {
  return {
    subjectAssetId: childAssetId,
    targetAssetId: parentAssetId,
    kind: 'structural-parent',
    relationshipType: LADDER_SOURCE_RELATIONSHIP_TYPE[ladderSource],
    source: LADDER_SOURCE_KIND[ladderSource],
    rule: LADDER_SOURCE_RULE[ladderSource],
    evidenceTier: LADDER_SOURCE_EVIDENCE_TIER[ladderSource],
    ladderSource,
    provenance,
  };
}

/**
 * One additive relation, read from the dependent asset's side.
 *
 * The relationship type is preserved from the edge -- a dependency on a feeder
 * still says `POWERS` -- but the kind is fixed to `dependency`, because what a
 * connection *is* and what it is allowed to *do* are separate questions
 * (`relationshipKindOf` answers the first; §8.2 answers the second).
 *
 * `ladderSource` is `flow-family` because the flow rung is where connectivity
 * enters the ladder vocabulary. Dependency claims never compete in the ladder,
 * so the value is a label, not a precedence.
 */
function dependencyClaim(
  dependentAssetId: string,
  upstreamAssetId: string,
  relationshipType: RelationshipType,
  provenance: Provenance,
): SsmRelationshipClaim {
  return {
    subjectAssetId: dependentAssetId,
    targetAssetId: upstreamAssetId,
    kind: 'dependency',
    relationshipType,
    source: LADDER_SOURCE_KIND['flow-family'],
    rule: DEPENDENCY_RULE,
    evidenceTier: LADDER_SOURCE_EVIDENCE_TIER['flow-family'],
    ladderSource: 'flow-family',
    provenance,
  };
}

/** Collects the reasons an input produced nothing. */
class SkipLog {
  private readonly entries: SkippedClaimInput[] = [];

  note(
    ladderSource: LadderSourceKind,
    reason: SkipReason,
    childRef: string,
    parentRef: string | null,
  ): void {
    this.entries.push({ ladderSource, reason, childRef, parentRef });
  }

  sorted(): ReadonlyArray<SkippedClaimInput> {
    return [...this.entries].sort(compareSkipped);
  }
}

/**
 * Both ends must be assets this compile knows about, and they must differ.
 *
 * `childRef`/`parentRef` are the input's own spellings so the skip entry points
 * at what the site wrote, not at what assembly resolved it to.
 */
function pairIsUsable(
  ladderSource: LadderSourceKind,
  childAssetId: string,
  parentAssetId: string,
  childRef: string,
  parentRef: string,
  known: ReadonlySet<string>,
  skips: SkipLog,
): boolean {
  if (!known.has(childAssetId)) {
    skips.note(ladderSource, 'unknown-child-asset', childRef, parentRef);
    return false;
  }
  if (!known.has(parentAssetId)) {
    skips.note(ladderSource, 'unknown-parent-asset', childRef, parentRef);
    return false;
  }
  if (childAssetId === parentAssetId) {
    skips.note(ladderSource, 'self-parent', childRef, parentRef);
    return false;
  }
  return true;
}

/** Whether the bridge refused because the spelling names several assets. */
function isDuplicateTarget(
  resolved: string | null | DuplicateTagTarget,
): resolved is DuplicateTagTarget {
  return typeof resolved === 'object' && resolved !== null;
}

/**
 * One tag through the bridge, with the refusal already logged.
 *
 * The two refusals are different facts and get different reasons: nothing
 * carries this spelling, versus several things do. A caller that flattened them
 * would send a person looking for a typo in a tag that is spelled perfectly
 * and written twice.
 */
function resolveOneTag(
  ladderSource: LadderSourceKind,
  tag: string,
  end: 'child' | 'parent',
  resolveTag: ResolveTag,
  childRef: string,
  parentRef: string,
  skips: SkipLog,
): string | null {
  const resolved = resolveTag(tag);
  if (isDuplicateTarget(resolved)) {
    skips.note(ladderSource, 'duplicate-target', childRef, parentRef);
    return null;
  }
  if (resolved === null) {
    skips.note(
      ladderSource,
      end === 'child' ? 'unresolvable-child-tag' : 'unresolvable-parent-tag',
      childRef,
      parentRef,
    );
    return null;
  }
  return resolved;
}

/** A tag pair resolved through identity, or the reason it could not be. */
function resolvePair(
  ladderSource: LadderSourceKind,
  childTag: string,
  parentTag: string,
  resolveTag: ResolveTag,
  known: ReadonlySet<string>,
  skips: SkipLog,
): { readonly childAssetId: string; readonly parentAssetId: string } | null {
  const childAssetId = resolveOneTag(
    ladderSource,
    childTag,
    'child',
    resolveTag,
    childTag,
    parentTag,
    skips,
  );
  if (childAssetId === null) {
    return null;
  }
  const parentAssetId = resolveOneTag(
    ladderSource,
    parentTag,
    'parent',
    resolveTag,
    childTag,
    parentTag,
    skips,
  );
  if (parentAssetId === null) {
    return null;
  }
  if (!pairIsUsable(ladderSource, childAssetId, parentAssetId, childTag, parentTag, known, skips)) {
    return null;
  }
  return { childAssetId, parentAssetId };
}

/** Taught pairings, as (parentRole, childRole) -> the rule's position in the graph. */
function indexRoleGraph(roleGraph: RoleGraphConfig | undefined): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  roleGraph?.rules.forEach((rule, position) => {
    const key = pairKey(rule.parentRole, rule.childRole);
    if (!index.has(key)) {
      index.set(key, position + 1);
    }
  });
  return index;
}

/**
 * Collapses claims that say the same thing.
 *
 * The key is (child, parent, type, rung): two profile rows stating one pairing
 * are one claim. Sorting first is what makes "keep the first" deterministic --
 * the survivor is the one that sorts lowest, not the one the caller listed
 * first.
 */
function dedupe(claims: ReadonlyArray<SsmRelationshipClaim>): ReadonlyArray<SsmRelationshipClaim> {
  const sorted = [...claims].sort(compareClaims);
  const seen = new Set<string>();
  const kept: SsmRelationshipClaim[] = [];

  for (const claim of sorted) {
    const key = [
      claim.subjectAssetId,
      claim.targetAssetId,
      claim.relationshipType,
      claim.ladderSource,
    ].join(KEY_SEPARATOR);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(claim);
  }

  return kept;
}

/**
 * Turns every source into relationship claims.
 *
 * Assembly only. No claim wins, no boundary is applied, no hierarchy is
 * written: the output is the complete, competing evidence for
 * `@matchline/ssm-compiler` to resolve.
 *
 * @param subjects Every asset in the compile, with the anatomy segments the
 *   rules read. Subjects sharing an asset id collapse to the first.
 * @param opts The rule sources, plus the identity bridge every tag-borne rung
 *   goes through.
 */
export function assembleRelationshipClaims(
  subjects: ReadonlyArray<ClaimSubject>,
  opts: AssembleOptions,
): AssembledClaims {
  const subjectById = new Map<string, ClaimSubject>();
  for (const subject of subjects) {
    if (!subjectById.has(subject.assetId)) {
      subjectById.set(subject.assetId, subject);
    }
  }
  const known: ReadonlySet<string> = new Set(subjectById.keys());
  const profileSource = opts.profileSource ?? DEFAULT_PROFILE_SOURCE;
  const modelSourceFile = opts.modelSourceFile ?? DEFAULT_MODEL_SOURCE_FILE;

  const skips = new SkipLog();
  const structural: SsmRelationshipClaim[] = [];
  const dependencies: SsmRelationshipClaim[] = [];
  const proposals: NestingProposalReviewItem[] = [];
  const makeRoot: MakeRootDirective[] = [];

  // --- Tier 1: manual overrides -------------------------------------------
  (opts.manualOverrides ?? []).forEach((override: ManualRelationshipOverride, position) => {
    const rung = ladderRung('manual');
    const provenance = profileProvenance(
      profileSource,
      MANUAL_OVERRIDE_TABLE,
      position + 1,
      LADDER_SOURCE_RULE.manual,
      rung,
      override.note,
    );

    if (!known.has(override.childAssetId)) {
      skips.note('manual', 'unknown-child-asset', override.childAssetId, override.parentAssetId);
      return;
    }

    if (override.parentAssetId === null) {
      makeRoot.push({
        childAssetId: override.childAssetId,
        provenance,
        ...(override.note === undefined ? {} : { note: override.note }),
      });
      return;
    }

    if (
      !pairIsUsable(
        'manual',
        override.childAssetId,
        override.parentAssetId,
        override.childAssetId,
        override.parentAssetId,
        known,
        skips,
      )
    ) {
      return;
    }
    structural.push(
      structuralClaim('manual', override.childAssetId, override.parentAssetId, provenance),
    );
  });

  // --- Tier 2: explicit model relationship property -------------------------
  for (const subject of [...subjectById.values()].sort((left, right) =>
    compareText(left.assetId, right.assetId),
  )) {
    const parentTag = subject.explicitParentTag;
    if (parentTag === undefined || parentTag === '') {
      continue;
    }
    const rung = ladderRung('explicit-model');
    const parentAssetId = resolveOneTag(
      'explicit-model',
      parentTag,
      'parent',
      opts.resolveTag,
      subject.assetId,
      parentTag,
      skips,
    );
    if (parentAssetId === null) {
      continue;
    }
    if (
      !pairIsUsable(
        'explicit-model',
        subject.assetId,
        parentAssetId,
        subject.assetId,
        parentTag,
        known,
        skips,
      )
    ) {
      continue;
    }

    // The caller's address is kept whole; only the rung is stamped on, because
    // which ladder tier produced the claim is assembly's fact, not the model's.
    const provenance: Provenance =
      subject.explicitParentProvenance === undefined
        ? {
            sourceFile: modelSourceFile,
            sourceRef: { kind: 'model-object', objectId: subject.assetId },
            rule: LADDER_SOURCE_RULE['explicit-model'],
            fallbackRung: rung,
          }
        : { ...subject.explicitParentProvenance, fallbackRung: rung };
    structural.push(structuralClaim('explicit-model', subject.assetId, parentAssetId, provenance));
  }

  // --- Tier 3: the MEL's own System Parent column ---------------------------
  // The donor's primary structural source, read back. One row can name several
  // parents; the first is the nesting and the rest are dependencies, because an
  // asset has one parent and the other statements are still true.
  for (const row of opts.melParents ?? []) {
    const childAssetId = resolveOneTag(
      'mel-parent',
      row.childTag,
      'child',
      opts.resolveTag,
      row.childTag,
      row.parentTags[0] ?? '',
      skips,
    );
    if (childAssetId === null) {
      continue;
    }

    row.parentTags.forEach((parentTag, position) => {
      if (parentTag === '') {
        return;
      }
      const parentAssetId = resolveOneTag(
        'mel-parent',
        parentTag,
        'parent',
        opts.resolveTag,
        row.childTag,
        parentTag,
        skips,
      );
      if (parentAssetId === null) {
        return;
      }
      if (
        !pairIsUsable(
          'mel-parent',
          childAssetId,
          parentAssetId,
          row.childTag,
          parentTag,
          known,
          skips,
        )
      ) {
        return;
      }

      const provenance: Provenance = {
        ...row.provenance,
        rule: LADDER_SOURCE_RULE['mel-parent'],
        fallbackRung: ladderRung('mel-parent'),
      };
      if (position === 0) {
        structural.push(
          structuralClaim('mel-parent', childAssetId, parentAssetId, provenance),
        );
        return;
      }
      // A second System Parent is a real relation that cannot nest: the slot is
      // taken, and dropping the statement would lose what the MEL said.
      dependencies.push(
        dependencyClaim(childAssetId, parentAssetId, 'DEPENDENCY', {
          ...provenance,
          rule: `${LADDER_SOURCE_RULE['mel-parent']}[${String(position)}]`,
        }),
      );
    });
  }

  // --- Tier 4: the SSM SOP's own nesting and commissioning rules ------------
  // Off unless the caller passed `sopRules`, which the compiler does only when
  // the site's ladder carries the `sop-rule` rung. Structural claims would have
  // been filtered by the ladder anyway; the DEPENDENCY claims would not, and a
  // site that never asked for the SOP must not find its register's Dependencies
  // column rewritten by it.
  if (opts.sopRules !== undefined) {
    const sop = sopClaims({
      subjects: [...subjectById.values()],
      flowEdges: opts.flowEdges ?? [],
      disabledRuleIds: opts.sopRules.disabledRuleIds,
    });
    structural.push(...sop.structural);
    dependencies.push(...sop.dependencies);
  }

  // --- Tier 5: explicit accepted profile lookup -----------------------------
  (opts.profileLookup ?? []).forEach((entry, position) => {
    const resolved = resolvePair(
      'profile-lookup',
      entry.childTag,
      entry.parentTag,
      opts.resolveTag,
      known,
      skips,
    );
    if (resolved === null) {
      return;
    }
    structural.push(
      structuralClaim(
        'profile-lookup',
        resolved.childAssetId,
        resolved.parentAssetId,
        profileProvenance(
          profileSource,
          PROFILE_LOOKUP_TABLE,
          position + 1,
          LADDER_SOURCE_RULE['profile-lookup'],
          ladderRung('profile-lookup'),
        ),
      ),
    );
  });

  // --- Tier 6: flow-anchored family, plus every dependency ------------------
  const roleRules = indexRoleGraph(opts.roleGraph);
  const anchoredPairs = new Set<string>();

  for (const edge of opts.flowEdges ?? []) {
    if (
      !pairIsUsable(
        'flow-family',
        edge.toAssetId,
        edge.fromAssetId,
        edge.toAssetId,
        edge.fromAssetId,
        known,
        skips,
      )
    ) {
      continue;
    }

    // Connectivity is always at least a dependency (§8.2). The dependent end is
    // the load, so the edge is recorded from `to`'s side, looking upstream.
    dependencies.push(
      dependencyClaim(edge.toAssetId, edge.fromAssetId, edge.relationshipType, edge.provenance),
    );

    const parent = subjectById.get(edge.fromAssetId);
    const child = subjectById.get(edge.toAssetId);
    if (parent === undefined || child === undefined) {
      continue;
    }
    const family = parent.familyKey;
    if (family === undefined || family === '' || family !== child.familyKey) {
      continue;
    }
    if (parent.role === undefined || child.role === undefined) {
      continue;
    }
    const rulePosition = roleRules.get(pairKey(parent.role, child.role));
    if (rulePosition === undefined) {
      continue;
    }

    anchoredPairs.add(pairKey(child.assetId, parent.assetId));
    structural.push(
      structuralClaim('flow-family', child.assetId, parent.assetId, {
        ...edge.provenance,
        rule: `${parent.role}>${child.role}`,
        fallbackRung: ladderRung('flow-family'),
      }),
    );
  }

  // --- Tier 7: family + role, where flow anchored nothing -------------------
  if (roleRules.size > 0) {
    const families = new Map<string, FamilyMember[]>();
    for (const subject of subjectById.values()) {
      const family = subject.familyKey;
      const role = subject.role;
      if (family === undefined || family === '' || role === undefined) {
        continue;
      }
      const member: FamilyMember = { assetId: subject.assetId, role };
      const members = families.get(family);
      if (members === undefined) {
        families.set(family, [member]);
        continue;
      }
      members.push(member);
    }

    for (const members of families.values()) {
      const ordered = [...members].sort((left, right) => compareText(left.assetId, right.assetId));
      for (const parent of ordered) {
        for (const child of ordered) {
          if (parent.assetId === child.assetId) {
            continue;
          }
          const rulePosition = roleRules.get(pairKey(parent.role, child.role));
          if (rulePosition === undefined) {
            continue;
          }
          // A pairing flow already anchored is the flow rung's claim; repeating
          // it here would double-count one piece of evidence as two rungs.
          if (anchoredPairs.has(pairKey(child.assetId, parent.assetId))) {
            continue;
          }
          // Several parents for one child at this rung all get claims: the
          // ladder is where ambiguity is decided, so pre-filtering here would
          // hide a tie instead of surfacing it.
          structural.push(
            structuralClaim(
              'family-role',
              child.assetId,
              parent.assetId,
              profileProvenance(
                profileSource,
                ROLE_GRAPH_TABLE,
                rulePosition,
                `${parent.role}>${child.role}`,
                ladderRung('family-role'),
              ),
            ),
          );
        }
      }
    }
  }

  // --- Tier 8: learned description rules ------------------------------------
  (opts.learned ?? []).forEach((learned, position) => {
    if (
      !pairIsUsable(
        'learned-description',
        learned.childAssetId,
        learned.parentAssetId,
        learned.childAssetId,
        learned.parentAssetId,
        known,
        skips,
      )
    ) {
      return;
    }

    if (learned.grade === 'proposal') {
      // Never a claim. A rule that has not earned claim grade goes to review
      // and stops there (DECISIONS.md #3).
      proposals.push({
        kind: 'nesting-proposal',
        assetId: learned.childAssetId,
        proposedParentId: learned.parentAssetId,
        ruleDetail: learned.ruleDetail,
        confidence: learned.confidence,
      });
      return;
    }

    structural.push(
      structuralClaim(
        'learned-description',
        learned.childAssetId,
        learned.parentAssetId,
        profileProvenance(
          profileSource,
          LEARNED_RULE_TABLE,
          position + 1,
          learned.ruleDetail,
          ladderRung('learned-description'),
        ),
      ),
    );
  });

  // --- Tier 9: prior accepted SSM examples ----------------------------------
  (opts.priorSsm ?? []).forEach((example, position) => {
    const resolved = resolvePair(
      'prior-ssm',
      example.childTag,
      example.parentTag,
      opts.resolveTag,
      known,
      skips,
    );
    if (resolved === null) {
      return;
    }
    structural.push(
      structuralClaim(
        'prior-ssm',
        resolved.childAssetId,
        resolved.parentAssetId,
        profileProvenance(
          profileSource,
          PRIOR_SSM_TABLE,
          position + 1,
          LADDER_SOURCE_RULE['prior-ssm'],
          ladderRung('prior-ssm'),
        ),
      ),
    );
  });

  const dedupedProposals: NestingProposalReviewItem[] = [];
  const seenProposals = new Set<string>();
  for (const proposal of [...proposals].sort(compareProposals)) {
    const key = [
      proposal.assetId,
      proposal.proposedParentId,
      proposal.ruleDetail,
      String(proposal.confidence),
    ].join(KEY_SEPARATOR);
    if (seenProposals.has(key)) {
      continue;
    }
    seenProposals.add(key);
    dedupedProposals.push(proposal);
  }

  return {
    structural: dedupe(structural),
    dependencies: dedupe(dependencies),
    proposals: dedupedProposals,
    makeRoot: [...makeRoot].sort((left, right) =>
      compareText(left.childAssetId, right.childAssetId),
    ),
    skipped: skips.sorted(),
  };
}
