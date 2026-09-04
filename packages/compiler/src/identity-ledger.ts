/**
 * The asset identity ledger, spliced into the pipeline (RELEASE-1.0-PLAN P0-9).
 *
 * `@matchline/asset-catalog` derives an id from the model content it read, which
 * is the right answer for one compile and the wrong answer across two: the
 * content it derives the id from includes the tag, and a tag is the field most
 * likely to be corrected. `@matchline/asset-identity` owns the ledger that
 * carries an id across compiles. This file is the adapter between them, and it
 * does three things:
 *
 * 1. turns each catalog asset into a {@link LedgerCandidate} -- the model
 *    evidence the catalog published, plus the profile-mapped stable id the
 *    compiler read through the property-bag seam;
 * 2. rewrites the catalog so every published asset id is the LEDGER id, which
 *    is what every stage below stage 1 then keys on;
 * 3. re-addresses stored decisions -- manual parents, manual system
 *    assignments -- through the ledger, and reports the ones it cannot as
 *    `orphaned-decision` review items rather than dropping them.
 *
 * ## Why the rewrite happens where it happens
 *
 * Exactly once, immediately after the catalog is built and before ANY consumer
 * reads an asset id. `compile.ts` reads the property bags first, positionally,
 * because the stable-id property lives in the bag -- and a positional read keys
 * on nothing. Everything after the splice sees ledger ids only, so there is no
 * stage that has to know both spellings.
 */
import type {
  AttributeResolver,
  DerivedAttributeDefinition,
  ManualRelationshipOverride,
  OrphanedDecisionKind,
  OrphanedDecisionReason,
  OrphanedDecisionReviewItem,
  PossibleRematchReason,
  PossibleRematchReviewItem,
  ReviewItem,
} from '@matchline/domain';
import type { AssetCatalog, ModelAsset } from '@matchline/asset-catalog';
import { uniqueTagAssetId } from '@matchline/asset-catalog';
import { stableObjectIdentities } from '@matchline/asset-identity';
import type {
  AssetLedger,
  AssetLedgerEntry,
  LedgerCandidate,
  ReconcileLedgerResult,
} from '@matchline/asset-identity';
import type { ManualAssignment, ManualAssignments } from '@matchline/system-resolver';

/**
 * One catalog asset as the ledger reads it.
 *
 * `stableIdPropertyValue` is the compiler's contribution: the catalog does not
 * know which property a site nominated as its stable id, because that is a
 * profile question and the catalog is handed only the mapped fields.
 */
export function ledgerCandidateOf(
  asset: ModelAsset,
  stableIdPropertyValue: string | undefined,
): LedgerCandidate {
  const evidence = asset.identityEvidence;
  return {
    assetId: asset.assetId,
    canonicalTag: asset.canonicalTag,
    identities: stableObjectIdentities({
      logicalSourceId: asset.sourceId,
      sourceModelPersistentId: evidence.sourceModelPersistentId,
      authoringId: evidence.authoringId,
      instanceGuid: evidence.instanceGuid,
      structuralPath: evidence.structuralPath,
      className: evidence.className,
      ...(stableIdPropertyValue === undefined ? {} : { stableIdPropertyValue }),
      canonicalTag: asset.canonicalTag,
    }),
  };
}

/**
 * The catalog with every asset id replaced by its ledger id.
 *
 * The review items are rewritten too: `absorbed-tagged-component` names the
 * asset that swallowed the component, and an item pointing at an id no stage
 * below uses would be a flag on nothing. Every other catalog item names tags
 * and objects, which the ledger does not rename.
 *
 * The inclusion impact is untouched -- it is counts, not identities.
 */
export function applyLedgerMapping(
  catalog: AssetCatalog,
  mapping: ReadonlyMap<string, string>,
): AssetCatalog {
  const idOf = (assetId: string): string => mapping.get(assetId) ?? assetId;
  return {
    assets: catalog.assets.map((asset) =>
      asset.assetId === idOf(asset.assetId) ? asset : { ...asset, assetId: idOf(asset.assetId) },
    ),
    reviewItems: catalog.reviewItems.map((item) =>
      item.kind === 'absorbed-tagged-component'
        ? { ...item, absorbingAssetId: idOf(item.absorbingAssetId) }
        : item,
    ),
    impact: catalog.impact,
  };
}

/** What a stored decision's reference turned out to name. */
export type ResolutionStatus = 'resolved' | 'unknown' | 'ambiguous';

export interface DecisionResolution {
  readonly status: ResolutionStatus;
  /** The ledger asset id, when {@link status} is `resolved`. */
  readonly assetId: string;
}

const UNKNOWN: DecisionResolution = { status: 'unknown', assetId: '' };
const AMBIGUOUS: DecisionResolution = { status: 'ambiguous', assetId: '' };

/** Resolves a reference a project recorded onto an asset in THIS compile. */
export type ResolveDecisionRef = (ref: string) => DecisionResolution;

/**
 * How a stored reference is re-addressed, in the order the rules are tried.
 *
 * A project file holds decisions taken against whatever id the compile that
 * showed them published, and older files hold plain tags. All of it has to keep
 * working, so a reference resolves when it is any of:
 *
 * 1. a ledger asset id this compile produced -- the ordinary case from now on;
 * 2. a canonical tag exactly one of this compile's assets carries;
 * 3. `tag:<tag>` -- the id `@matchline/asset-catalog` mints for an unduplicated
 *    tag -- for exactly one of this compile's assets;
 * 4. a tag the ledger knows as a former spelling (an alias) of exactly one
 *    asset present in this compile, in either of the two forms above.
 *
 * A reference that names SEVERAL assets is refused rather than resolved to the
 * first: a duplicated tag is the one case where guessing would silently attach a
 * person's decision to equipment they never looked at. It becomes an
 * `ambiguous-*` orphaned decision, which says so.
 */
export function decisionResolverOf(
  assets: ReadonlyArray<ModelAsset>,
  ledger: AssetLedger,
): ResolveDecisionRef {
  /** Every spelling that reaches an asset -> the asset ids it reaches. */
  const byRef = new Map<string, Set<string>>();
  const register = (ref: string, assetId: string): void => {
    if (ref === '') {
      return;
    }
    const bucket = byRef.get(ref);
    if (bucket === undefined) {
      byRef.set(ref, new Set([assetId]));
    } else {
      bucket.add(assetId);
    }
  };

  const present = new Set<string>();
  for (const asset of assets) {
    present.add(asset.assetId);
  }
  for (const asset of assets) {
    register(asset.assetId, asset.assetId);
    register(asset.canonicalTag, asset.assetId);
    if (asset.canonicalTag !== '') {
      register(uniqueTagAssetId(asset.canonicalTag), asset.assetId);
    }
  }
  for (const entry of ledger.entries) {
    if (!present.has(entry.assetId)) {
      // A disappeared entry keeps its id in the ledger, but there is no asset
      // for a decision to apply to. Registering it would resolve a decision
      // onto nothing, which is worse than reporting it as orphaned.
      continue;
    }
    for (const alias of entry.aliases) {
      register(alias, entry.assetId);
      register(uniqueTagAssetId(alias), entry.assetId);
    }
  }

  return (ref: string): DecisionResolution => {
    const matches = byRef.get(ref);
    if (matches === undefined) {
      return UNKNOWN;
    }
    if (matches.size > 1) {
      return AMBIGUOUS;
    }
    const [assetId] = matches;
    return assetId === undefined ? UNKNOWN : { status: 'resolved', assetId };
  };
}

/**
 * The tag-only re-matches that are worth a person's eye (P0-9).
 *
 * `reconcileLedger` already reports EVERY tag-tier match as a
 * `rematched-by-tag` event, and most of them are ordinary: a model re-exported
 * without the stable evidence it had last time, an object rebuilt in place. An
 * event is the right weight for those — it is a line in the ledger view, not a
 * question.
 *
 * These are the subset where nothing except the string agrees the two are the
 * same thing:
 *
 * - the previous entry's last recorded state was `disappeared`, so the asset
 *   was not in the last compile at all and a tag is the only thread back to it;
 * - the sources it was last read from and the sources it was read from now do
 *   not overlap, so the equipment either moved documents or the number was
 *   reused in another one.
 *
 * Both are exactly what a retired-and-reused tag looks like — and inheriting
 * that entry hands new equipment every manual system, manual parent and review
 * decision the retired unit accumulated. The re-match still happens: refusing
 * it would mint a fresh id and orphan those decisions, which is the failure the
 * ledger exists to prevent. This is how the person who knows the site gets to
 * say it was wrong.
 *
 * `previous` is the ledger the last compile wrote — `null` for a project's
 * first compile, which produces nothing here because there is nothing to have
 * re-matched against.
 */
export function possibleRematches(
  previous: AssetLedger | null,
  result: ReconcileLedgerResult,
): ReadonlyArray<PossibleRematchReviewItem> {
  if (previous === null) {
    return [];
  }
  const before = new Map(previous.entries.map((entry) => [entry.assetId, entry]));
  const after = new Map(result.ledger.entries.map((entry) => [entry.assetId, entry]));

  const items: PossibleRematchReviewItem[] = [];
  for (const event of result.events) {
    if (event.kind !== 'rematched-by-tag') {
      continue;
    }
    const was = before.get(event.assetId);
    const now = after.get(event.assetId);
    if (was === undefined || now === undefined) {
      continue;
    }
    const previousSourceIds = sourceIdsOf(was);
    const sourceIds = sourceIdsOf(now);
    // `disappeared` first: an asset that was not there at all is the stronger
    // statement, and one item per asset beats two rows asking the same question
    // twice.
    const reason: PossibleRematchReason | null =
      was.status === 'disappeared'
        ? 'reappeared'
        : disjoint(previousSourceIds, sourceIds)
          ? 'different-source'
          : null;
    if (reason === null) {
      continue;
    }
    items.push({
      kind: 'possible-rematch',
      assetId: event.assetId,
      canonicalTag: now.currentCanonicalTag,
      reason,
      previousSourceIds,
      sourceIds,
    });
  }
  return items;
}

/** The registered sources one entry's evidence was read from, sorted, deduped. */
function sourceIdsOf(entry: AssetLedgerEntry): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const identity of entry.modelIdentities) {
    if (identity.logicalSourceId !== '') {
      ids.add(identity.logicalSourceId);
    }
  }
  return [...ids].sort();
}

/**
 * Whether two source lists have nothing in common.
 *
 * An empty list on either side is NOT disjoint: an entry carrying no model
 * identities says nothing about where it came from, and inventing a question
 * out of missing evidence would put a row in the queue on every compile of a
 * project whose ledger predates the field.
 */
function disjoint(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  return !left.some((id) => right.includes(id));
}

/** The manual parent decisions that still apply, and the ones that do not. */
export interface ResolvedOverrides {
  readonly overrides: ReadonlyArray<ManualRelationshipOverride>;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
}

/**
 * Manual parent decisions, re-addressed through the ledger.
 *
 * An override that resolves is rewritten to ledger ids and handed to claims
 * assembly as usual. One that does not is left OUT of the assembly input and
 * reported here instead: assembly would have refused it anyway (its `skipped`
 * list, as a `dead-claim-rule`), and that record carries the rung and the two
 * refs but not the note -- the part of a decision that is actually irreplaceable.
 * One item that keeps everything beats two that between them lose the words.
 */
export function resolveManualOverrides(
  overrides: ReadonlyArray<ManualRelationshipOverride>,
  resolve: ResolveDecisionRef,
): ResolvedOverrides {
  const applied: ManualRelationshipOverride[] = [];
  const reviewItems: OrphanedDecisionReviewItem[] = [];

  for (const override of overrides) {
    const child = resolve(override.childAssetId);
    if (child.status !== 'resolved') {
      reviewItems.push(
        orphaned('manual-parent', override, reasonFor('child', child.status), override.note),
      );
      continue;
    }
    if (override.parentAssetId === null) {
      // A make-root names no parent. Nothing to re-address on that side.
      applied.push({
        childAssetId: child.assetId,
        parentAssetId: null,
        ...(override.note === undefined ? {} : { note: override.note }),
      });
      continue;
    }
    const parent = resolve(override.parentAssetId);
    if (parent.status !== 'resolved') {
      reviewItems.push(
        orphaned('manual-parent', override, reasonFor('parent', parent.status), override.note),
      );
      continue;
    }
    applied.push({
      childAssetId: child.assetId,
      parentAssetId: parent.assetId,
      ...(override.note === undefined ? {} : { note: override.note }),
    });
  }

  return { overrides: applied, reviewItems };
}

/** Manual system assignments, re-addressed the same way. */
export interface ResolvedAssignments {
  readonly assignments: ManualAssignments;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
}

/**
 * Manual system assignments, re-addressed through the ledger.
 *
 * The same rule as a parent decision, for the same reason: PRODUCT.md §4.1
 * makes a manual system "always the final word", and a final word addressed to
 * an id nobody uses any more is a decision nobody can see.
 */
export function resolveManualAssignments(
  assignments: ManualAssignments,
  resolve: ResolveDecisionRef,
): ResolvedAssignments {
  const applied = new Map<string, ManualAssignment>();
  const reviewItems: OrphanedDecisionReviewItem[] = [];

  for (const [ref, assignment] of assignments) {
    const subject = resolve(ref);
    if (subject.status !== 'resolved') {
      reviewItems.push({
        kind: 'orphaned-decision',
        decision: 'manual-system',
        childRef: ref,
        parentRef: '',
        reason: reasonFor('child', subject.status),
        ...(assignment.note === undefined ? {} : { note: assignment.note }),
      });
      continue;
    }
    // Last write wins, and two refs reaching one asset is the caller stating
    // the same decision twice rather than a conflict this stage can settle.
    applied.set(subject.assetId, assignment);
  }

  return { assignments: applied, reviewItems };
}

/** The derived registry with every `manual` table re-aimed, and what could not be. */
export interface ResolvedDerivedAssignments {
  readonly definitions: ReadonlyArray<DerivedAttributeDefinition>;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
}

/**
 * Derived-attribute `manual` tables, re-addressed through the ledger (P0-9).
 *
 * The third kind of stored decision, and the one that was missing. A person
 * types an Area or a Turnover Package against an asset by hand; the table is
 * keyed by asset id exactly like a parent decision, and a corrected tag used to
 * mint a new id and leave the assignment pointing at nothing -- silently, and at
 * a value a boundary level may well be comparing.
 *
 * Every other rung is returned untouched: only `manual` names assets, and
 * rebuilding the others would be a chance to drop a rung the union grows later.
 */
export function resolveDerivedAssignments(
  definitions: ReadonlyArray<DerivedAttributeDefinition>,
  resolve: ResolveDecisionRef,
): ResolvedDerivedAssignments {
  const reviewItems: OrphanedDecisionReviewItem[] = [];
  const rekeyed = definitions.map((definition) => ({
    ...definition,
    resolverChain: definition.resolverChain.map((resolver): AttributeResolver => {
      if (resolver.kind !== 'manual') {
        return resolver;
      }
      const assignments = new Map<string, string>();
      for (const [ref, value] of resolver.assignments) {
        const subject = resolve(ref);
        if (subject.status !== 'resolved') {
          reviewItems.push({
            kind: 'orphaned-decision',
            decision: 'derived-attribute',
            childRef: ref,
            parentRef: '',
            // The attribute is part of the identity of the decision: two
            // attributes can hold an unmappable assignment for one asset, and
            // they are two rows to re-aim rather than one.
            field: definition.attributeId,
            reason: reasonFor('child', subject.status),
            note: value,
          });
          continue;
        }
        // First write wins, matching `migrateAttributeResolver`'s own rule: two
        // refs that reach one asset are the same decision stated twice.
        if (!assignments.has(subject.assetId)) {
          assignments.set(subject.assetId, value);
        }
      }
      return { kind: 'manual', assignments };
    }),
  }));

  return { definitions: rekeyed, reviewItems };
}

function orphaned(
  decision: OrphanedDecisionKind,
  override: ManualRelationshipOverride,
  reason: OrphanedDecisionReason,
  note: string | undefined,
): OrphanedDecisionReviewItem {
  return {
    kind: 'orphaned-decision',
    decision,
    childRef: override.childAssetId,
    parentRef: override.parentAssetId ?? '',
    reason,
    ...(note === undefined ? {} : { note }),
  };
}

function reasonFor(end: 'child' | 'parent', status: ResolutionStatus): OrphanedDecisionReason {
  if (status === 'ambiguous') {
    return end === 'child' ? 'ambiguous-child' : 'ambiguous-parent';
  }
  return end === 'child' ? 'unknown-child' : 'unknown-parent';
}
