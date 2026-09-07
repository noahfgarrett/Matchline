import { Worker } from 'node:worker_threads';

import type { CompileStage, CompiledProject } from '@matchline/compiler';
import type { ResolvedAssetNode, ResolvedSnapshot, ReviewItem } from '@matchline/domain';
import { reviewItemSummary } from '@matchline/domain';
import type { LedgerEvent } from '@matchline/asset-identity';
import {
  sourceStatusOf,
  walkSourceToLoad,
  type FlowNode,
  type FlowVisit,
} from '@matchline/electrical-flow';
import type { GeneratedMelAsset } from '@matchline/mel-export';
import { hierarchyTree, reviewKey } from '@matchline/ssm-compiler';
import type { HierarchyAssetNode, HierarchyLevelNode } from '@matchline/ssm-compiler';

import type { CompileWorkerMessage, CompileWorkerRequest } from './compile-worker.js';

import type {
  WireCompileIssueKind,
  WireCompileIssueRow,
  WireCompileSummary,
  WireFlowNode,
  WireFlowRoot,
  WireHierarchyConfig,
  WireLedgerEvent,
  WireReparentPreview,
  WireReviewRow,
  WireSsmAuditRule,
  WireTreeNode,
} from '../../shared/schemas.js';

/**
 * Screen 8 and the workspace: one compile, and every paged view over it.
 *
 * The compiled project is large — an asset catalog, a flow graph, a snapshot,
 * a generated MEL and a review queue — and it never crosses IPC (APP.md "IPC
 * contract"). It stays here, indexed once, and the renderer asks for the rows
 * it is about to paint.
 *
 * Nothing in this file decides anything about a site. Every number is read off
 * `CompiledProject`; where two engine counts are combined (cycles), the row
 * badges say which is which.
 */

/* ======================================================== running a compile */

/** What one compile ended up being. */
export type CompileOutcome =
  | { readonly kind: 'done'; readonly project: CompiledProject }
  /** The worker was terminated. Nothing was written, nothing was kept. */
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'failed';
      readonly reason: string;
      /** The thrown error's `name`, or `''`. See `CompileWorkerMessage`. */
      readonly errorName: string;
    };

/** A compile in flight: something to await, and the one way to stop it. */
export interface CompileRun {
  readonly finished: Promise<CompileOutcome>;
  /**
   * Terminates the worker.
   *
   * Immediate and unconditional — there is no cooperative checkpoint to ask a
   * synchronous pipeline to stop at, and inventing one would put a cancellation
   * test inside every stage of the engine. Terminating is safe precisely
   * because the worker owns nothing durable: it opened its own read-only cache
   * handles and the project store is never touched until the compile has
   * returned to main (see `project-session.ts`, `compileNow`).
   *
   * Calling it after the run has finished does nothing.
   */
  cancel(): void;
}

/**
 * Where the compile worker's built module is.
 *
 * Resolved against this module rather than the app root, so it is the same
 * expression in `dist/electron/services` under a packaged app, under `electron
 * .`, and under a test running the built output directly.
 */
const WORKER_URL = new URL('./compile-worker.js', import.meta.url);

/**
 * Starts a compile on a worker thread and hands back a way to wait for it and a
 * way to stop it.
 *
 * Never throws, and never rejects: every way a compile can end — a refusal from
 * the engine, a cache that is not what the project recorded, a worker that
 * died, a cancellation — arrives as a {@link CompileOutcome}, because the
 * caller has one job with all four of them, which is to put a sentence on
 * screen 8.
 *
 * The request is the worker's own shape (`CompileWorkerRequest`): paths rather
 * than cache handles, bytes rather than files. What can cross a thread boundary
 * is decided in one place, and it is the file the worker is in.
 */
export function startCompile(
  request: CompileWorkerRequest,
  onStage: (stage: CompileStage) => void,
): CompileRun {
  let settle: (outcome: CompileOutcome) => void = (): void => {};
  const finished = new Promise<CompileOutcome>((resolve): void => {
    settle = resolve;
  });

  let done = false;
  let cancelled = false;
  /** The outcome the worker reported, held until its `exit` confirms it is gone. */
  let reported: CompileOutcome | null = null;

  const worker = new Worker(WORKER_URL, { workerData: request });

  const finish = (outcome: CompileOutcome): void => {
    if (done) {
      return;
    }
    done = true;
    settle(outcome);
  };

  worker.on('message', (message: CompileWorkerMessage): void => {
    switch (message.kind) {
      case 'stage':
        // Dropped once cancelled: a stage line arriving after the user pressed
        // Stop would redraw progress for work nobody is waiting for.
        if (!cancelled) {
          onStage(message.stage);
        }
        return;
      case 'done':
        reported = { kind: 'done', project: message.project as CompiledProject };
        return;
      case 'failed':
        reported = { kind: 'failed', reason: message.reason, errorName: message.errorName };
        return;
      default: {
        const exhaustive: never = message;
        throw new Error(`Unhandled compile worker message: ${JSON.stringify(exhaustive)}`);
      }
    }
  });

  worker.on('error', (error: Error): void => {
    // A throw the worker could not answer for itself: a module that would not
    // load, an out-of-memory. `exit` still follows.
    reported = { kind: 'failed', reason: error.message, errorName: error.name };
  });

  worker.on('exit', (code: number): void => {
    if (cancelled) {
      finish({ kind: 'cancelled' });
      return;
    }
    if (reported !== null) {
      finish(reported);
      return;
    }
    finish({
      kind: 'failed',
      errorName: '',
      reason:
        `The compile stopped without saying why (worker exit code ${String(code)}). ` +
        'Nothing was written to the project.',
    });
  });

  return {
    finished,
    cancel(): void {
      if (done || cancelled) {
        return;
      }
      cancelled = true;
      void worker.terminate();
    },
  };
}

/* =============================================== the generated-MEL adapter */

/**
 * `CompiledProject` -> the flattened asset shape `@matchline/mel-export` and
 * `@matchline/exto-export` both read.
 *
 * `@matchline/compiler` publishes the finished rows, not this intermediate, so
 * a caller that wants the site-template, comparison or revision-diff layers has
 * to adapt the project's own public fields. This is that adapter, and it is the
 * value stored per compile so a later revision diff has something to diff
 * against (see `project-session.ts` for where it is persisted).
 */
export function generatedMelAssets(project: CompiledProject): readonly GeneratedMelAsset[] {
  const tagOf = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset.canonicalTag]));
  const subjectOf = new Map(project.compileSubjects.map((subject) => [subject.assetId, subject]));

  return project.catalog.assets.map((asset): GeneratedMelAsset => {
    const resolution = project.systems.bySubject.get(asset.assetId)?.resolution ?? null;
    const node = project.snapshot.nodes.get(asset.assetId);
    const ssmDiscipline = subjectOf.get(asset.assetId)?.attributes.get('ssmDiscipline');
    const parentAssetId =
      node !== undefined && node.parent.status === 'resolved' ? node.parent.parentAssetId : null;
    const parentTag = parentAssetId === null ? undefined : tagOf.get(parentAssetId);
    const dependencyTags = [
      ...new Set(
        (node?.dependencies ?? [])
          .map((dependency): string | undefined => tagOf.get(dependency.parentAssetId))
          .filter((tag): tag is string => tag !== undefined),
      ),
    ];

    const built: {
      canonicalTag: string;
      stableAssetId: string;
      description?: string;
      equipmentType?: string;
      building?: string;
      nativeDiscipline?: string;
      ssmDiscipline?: string;
      system?: NonNullable<GeneratedMelAsset['system']>;
      systemParentTag?: string;
      dependencyTags?: ReadonlyArray<string>;
      modelObjectIds?: ReadonlyArray<number>;
      inclusionStatus: string;
      parentEvidence?: string;
    } = {
      canonicalTag: asset.canonicalTag,
      // The ledger id, carried rather than printed (see `GeneratedMelAsset`).
      // Two things need it and neither can work without it: a revision diff
      // pairs rows by identity instead of by spelling, so a corrected tag
      // reports as a changed tag rather than as a removal and an addition; and
      // a reopened project joins these stored rows onto the stored snapshot,
      // which is keyed by asset id and by nothing else.
      stableAssetId: asset.assetId,
      modelObjectIds: asset.objectIds,
      inclusionStatus: asset.status,
    };

    if (asset.description !== undefined) {
      built.description = asset.description;
    }
    if (asset.equipmentType !== undefined) {
      built.equipmentType = asset.equipmentType;
    }
    if (asset.building !== undefined) {
      built.building = asset.building;
    }
    if (asset.nativeDiscipline !== undefined) {
      built.nativeDiscipline = asset.nativeDiscipline;
    }
    if (ssmDiscipline !== undefined) {
      built.ssmDiscipline = ssmDiscipline;
    }
    if (resolution !== null) {
      built.system = resolution;
    }
    if (parentTag !== undefined) {
      built.systemParentTag = parentTag;
    }
    if (dependencyTags.length > 0) {
      built.dependencyTags = dependencyTags;
    }
    if (node?.parent.ladderSource != null) {
      built.parentEvidence = node.parent.ladderSource;
    }
    return built;
  });
}

/* ==================================================== indexing one compile */

/** Every asset id a review item names, so a tree row can carry a flag count. */
function assetIdsOf(item: ReviewItem): readonly string[] {
  switch (item.kind) {
    case 'system-conflict':
    case 'ambiguous-parent':
    case 'missing-boundary':
      return [item.assetId];
    case 'nesting-proposal':
      return [item.assetId, item.proposedParentId];
    // Both ends carry the flag: the child is where the decision was made, and
    // the parent is where a reviewer looking for their missing child looks
    // (P0-4).
    case 'manual-boundary-demotion':
      return [item.assetId, item.parentAssetId];
    case 'ambiguous-suffix':
      return item.candidateAssetIds;
    case 'fuzzy-identity':
      return item.candidates.map((candidate) => candidate.assetId);
    case 'structural-cycle':
      return item.assetIds;
    case 'absorbed-tagged-component':
      // The absorbed object is no longer an asset, so the only row that can
      // carry this flag is the one that swallowed it.
      return [item.absorbingAssetId];
    // The asset that inherited the id is in this compile and is exactly the row
    // a reviewer wants to look at: "is this the same unit the decisions were
    // recorded against, or a tag somebody reused?" (P0-9).
    case 'possible-rematch':
      return [item.assetId];
    // Both ends, when the finding has two: the flagged row is where the fix
    // goes, and the parent or dependency it names is where a reviewer looks to
    // decide whether it is the finding or the relationship that is wrong. An
    // aggregate note carries neither -- it is about a rule, not a row.
    case 'ssm-audit':
      return [item.assetId, item.relatedAssetId].filter((assetId) => assetId !== '');
    // A counted item is about a level, a rung or a resolver chain rather than
    // about one asset. Its examples name assets, but flagging ten tree rows out
    // of forty thousand would be arbitrary -- the row to work is the item.
    case 'missing-boundary-level':
    case 'boundary-demotion':
    case 'unresolved-system':
    case 'duplicate-model-tag':
    case 'system-catalog-conflict':
    // These three name tags and rules rather than assets: a dead claim rule and
    // an unresolvable alias are both about a spelling no asset answers to, so
    // there is no tree row to hang a flag on.
    case 'dead-claim-rule':
    case 'unresolvable-alias':
    // An orphaned decision is one whose asset id no longer resolves (P0-9); by
    // definition there is no row to flag, which is exactly the problem it
    // reports.
    case 'orphaned-decision':
      return [];
    default: {
      const exhaustive: never = item;
      throw new Error(`Unhandled review item: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The engine's `reviewKey`, as the app stores and displays it.
 *
 * A pass-through, and deliberately still a function. `@matchline/ssm-compiler`
 * used to join a key's fields with NUL, which is fine for sorting and deduping
 * in memory and is fine nowhere else: `node:sqlite` truncates a bound string at
 * the first NUL, so every `system-conflict` item would be stored under the key
 * `system-conflict` and a decision recorded against one would appear against
 * all of them. An HTML attribute cannot carry a NUL either. The app escaped its
 * way around both; the engine now joins with U+241F and escapes its own fields,
 * so there is nothing left here to undo.
 *
 * This stays as the one named seam between an engine key and a stored key. The
 * app uses it on the wire, in `decisions.review_key` and as the React key of a
 * review row, so if the engine ever picks a character storage cannot hold
 * again, this is the single place that has to learn about it.
 * `review-key.test.mjs` in `@matchline/ssm-compiler` is what holds the engine
 * to its side of that bargain.
 */
export function storableReviewKey(item: ReviewItem): string {
  return reviewKey(item);
}

/** A tree row's children, already built. `''` keys the top of the tree. */
interface TreeBucket {
  readonly rows: readonly WireTreeNode[];
}

export interface Page<TRow> {
  readonly total: number;
  readonly rows: readonly TRow[];
}

function page<TRow>(rows: readonly TRow[], offset: number, limit: number): Page<TRow> {
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

/**
 * One compile, plus every index the workspace reads it through.
 *
 * Built once per compile. Rebuilding is correct but slow; serving a stale index
 * would be fast and wrong, so the session drops the whole view when it
 * recompiles rather than patching it.
 */
export interface CompileView {
  /**
   * Which of the two views this is.
   *
   * `compiled` is the whole thing: a `CompiledProject` in memory and every
   * index over it. `restored` is what a reopened project can rebuild from what
   * it stored — the resolved snapshot, the register that compile produced and
   * the identity ledger — and nothing else. Everything a restored view cannot
   * answer says so rather than answering with an empty list, which is why this
   * discriminant exists at all: a workspace that showed "0 flow nodes" for a
   * projection nobody stored would be stating a fact about the site.
   */
  readonly kind: 'compiled' | 'restored';
  /** `null` on a restored view: the project itself is not on file. */
  readonly project: CompiledProject | null;
  /** The level stack this view is indexed against. */
  readonly hierarchy: WireHierarchyConfig;
  readonly assets: readonly GeneratedMelAsset[];
  tagOf(assetId: string): string;
  /**
   * Whether this compile has an asset with that id.
   *
   * The one question a durable write has to be able to ask before it happens:
   * an override addresses assets by id, outlives every compile, and one naming
   * an id nothing has resolves to no claim, no review item and no error.
   */
  hasAsset(assetId: string): boolean;
  summary(base: CompileSummaryBase): WireCompileSummary;
  treeChildren(nodeKey: string, offset: number, limit: number): Page<WireTreeNode>;
  treeSearch(query: string, limit: number): readonly WireTreeNode[];
  issues(kind: WireCompileIssueKind, offset: number, limit: number): Page<WireCompileIssueRow>;
  ledgerEvents(offset: number, limit: number): Page<WireLedgerEvent>;
  flowRoots(offset: number, limit: number): Page<WireFlowRoot>;
  flowWalk(rootNodeId: string, offset: number, limit: number): Page<WireFlowNode>;
  reviewRows(): readonly WireReviewRow[];
  reparentPreview(childAssetId: string, parentAssetId: string | null): WireReparentPreview;
}

/** The facts about a compile that come from the store, not from the engine. */
export interface CompileSummaryBase {
  /** `null` for a compile from an unsaved draft: no row was written for it. */
  readonly compileId: number | null;
  /** `null` on the same terms: there is no revision for it to point at. */
  readonly profileRevision: number | null;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly undecidedReviewItemCount: number;
}

export function createCompileView(
  project: CompiledProject,
  hierarchy: WireHierarchyConfig,
): CompileView {
  const tags = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset.canonicalTag]));
  const assetById = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset]));
  const levelName = new Map(hierarchy.levels.map((level) => [level.levelId, level.displayName]));
  const boundaryLevels = new Set(
    hierarchy.levels.filter((level) => level.boundary).map((level) => level.levelId),
  );
  // What a boundary compares, which is the key unless the level names another
  // attribute for it (P0-6) — never the display attribute, or a re-worded
  // system would read as a crossing.
  const attributeOfLevel = new Map(
    hierarchy.levels.map((level) => [
      level.levelId,
      level.boundaryAttributeKey ?? level.attributeKey,
    ]),
  );
  const subjectOf = new Map(project.compileSubjects.map((subject) => [subject.assetId, subject]));

  const tagOf = (assetId: string): string => tags.get(assetId) ?? assetId;

  /* -------------------------------------------------------- review flags */

  const flagsByAsset = new Map<string, number>();
  for (const item of project.reviewItems) {
    for (const assetId of assetIdsOf(item)) {
      flagsByAsset.set(assetId, (flagsByAsset.get(assetId) ?? 0) + 1);
    }
  }

  /* ----------------------------------------------------------- the tree */

  const buckets = new Map<string, TreeBucket>();

  const assetRow = (node: HierarchyAssetNode): WireTreeNode => {
    const resolved = project.snapshot.nodes.get(node.assetId);
    const asset = assetById.get(node.assetId);
    return {
      nodeKey: `asset:${node.assetId}`,
      kind: 'asset',
      label: tagOf(node.assetId),
      detail: asset?.description ?? '',
      childCount: node.children.length,
      assetId: node.assetId,
      dependencyCount: node.dependencies.length,
      reviewFlagCount: flagsByAsset.get(node.assetId) ?? 0,
      parentStatus: node.status,
      overridden: resolved?.parent.ladderSource === 'manual',
      demoted: resolved?.parent.demotedFrom !== undefined,
    };
  };

  const indexAsset = (node: HierarchyAssetNode): void => {
    buckets.set(`asset:${node.assetId}`, { rows: node.children.map(assetRow) });
    for (const child of node.children) {
      indexAsset(child);
    }
  };

  /** Level nodes are addressed by their whole path, so a key survives a reorder. */
  const levelKey = (path: ReadonlyArray<readonly [string, string]>): string =>
    `level:${JSON.stringify(path)}`;

  const indexLevel = (
    node: HierarchyLevelNode,
    parentPath: ReadonlyArray<readonly [string, string]>,
  ): WireTreeNode => {
    // Addressed by key, never by label: a re-worded system must not orphan the
    // row a person had expanded (P0-6).
    const path: ReadonlyArray<readonly [string, string]> = [
      ...parentPath,
      [node.levelId, node.key] as const,
    ];
    const key = levelKey(path);
    const rows = [
      ...node.levels.map((child): WireTreeNode => indexLevel(child, path)),
      ...node.assets.map(assetRow),
    ];
    for (const asset of node.assets) {
      indexAsset(asset);
    }
    buckets.set(key, { rows });

    let flags = 0;
    for (const row of rows) {
      flags += row.reviewFlagCount;
    }

    return {
      nodeKey: key,
      kind: 'level',
      label: node.label,
      detail: levelName.get(node.levelId) ?? node.levelId,
      childCount: rows.length,
      assetId: '',
      dependencyCount: 0,
      reviewFlagCount: flags,
      parentStatus: '',
      overridden: false,
      demoted: false,
    };
  };

  const rootRows: WireTreeNode[] = [
    ...project.tree.levels.map((level): WireTreeNode => indexLevel(level, [])),
    ...project.tree.assets.map(assetRow),
  ];
  for (const asset of project.tree.assets) {
    indexAsset(asset);
  }
  buckets.set('', { rows: rootRows });

  /** Every asset row, flattened, for search. Built once because search is common. */
  const allAssetRows: WireTreeNode[] = [];
  for (const bucket of buckets.values()) {
    for (const row of bucket.rows) {
      if (row.kind === 'asset') {
        allAssetRows.push(row);
      }
    }
  }
  allAssetRows.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));

  /* ------------------------------------------------------------ the flow */

  const walkCache = new Map<string, readonly WireFlowNode[]>();

  const flowRow = (visit: FlowVisit): WireFlowNode => {
    const node: FlowNode = visit.node;
    const edge =
      visit.viaEdgeId === undefined
        ? undefined
        : project.flow.edges.find((candidate) => candidate.edgeId === visit.viaEdgeId);
    return {
      nodeId: node.nodeId,
      tag: node.tag,
      matchStatus: node.matchStatus,
      depth: visit.depth,
      viaCable: edge?.via ?? '',
      description: node.enrichment?.description ?? '',
      systemLabel: node.enrichment?.systemLabel ?? node.enrichment?.systemKey ?? '',
      building: node.enrichment?.building ?? '',
      pmdInstruments: [
        ...new Set(visit.pmdRelations.map((relation) => project.flow.nodes.get(relation.nodeId)?.tag ?? relation.nodeId)),
      ].sort(),
      feedCount: node.feeds.length,
      fedByCount: node.fedBy.length,
      multiFed: node.fedBy.length > 1,
    };
  };

  const walk = (rootNodeId: string): readonly WireFlowNode[] => {
    const cached = walkCache.get(rootNodeId);
    if (cached !== undefined) {
      return cached;
    }
    const rows = [...walkSourceToLoad(project.flow, rootNodeId)].map(flowRow);
    walkCache.set(rootNodeId, rows);
    return rows;
  };

  /**
   * Every root, plus any node no root reaches.
   *
   * `ElectricalFlow.roots` is "feeds something, fed by nothing", so a node
   * inside a ring feed and a node with no edges at all are both absent from it.
   * Both are real records that §9.3 says stay visible, so they head their own
   * subtree here rather than disappearing from the view.
   */
  const roots: WireFlowRoot[] = [];
  const covered = new Set<string>();
  for (const rootNodeId of project.flow.roots) {
    const rows = walk(rootNodeId);
    for (const row of rows) {
      covered.add(row.nodeId);
    }
    const node = project.flow.nodes.get(rootNodeId);
    roots.push({
      nodeId: rootNodeId,
      tag: node?.tag ?? rootNodeId,
      matchStatus: node?.matchStatus ?? 'flow-only',
      reachableCount: rows.length,
    });
  }
  for (const [nodeId, node] of project.flow.nodes) {
    if (covered.has(nodeId)) {
      continue;
    }
    const rows = walk(nodeId);
    for (const row of rows) {
      covered.add(row.nodeId);
    }
    roots.push({
      nodeId,
      tag: node.tag,
      matchStatus: node.matchStatus,
      reachableCount: rows.length,
    });
  }

  /* ---------------------------------------------------------- the review */

  const reviewRows: WireReviewRow[] = project.reviewItems.map((item): WireReviewRow => ({
    reviewKey: storableReviewKey(item),
    kind: item.kind,
    // Only the SSM Audit grades what it found. Every other kind is a decision
    // the fold refused to make, which has no severity to report.
    severity: item.kind === 'ssm-audit' ? item.severity : '',
    summary: reviewItemSummary(item),
    detail: assetIdsOf(item)
      .map(tagOf)
      .filter((tag) => tag !== '')
      .join(', '),
    // The rulebook's own sentence, carried through untouched.
    statement: item.kind === 'ssm-audit' ? item.statement : '',
    decision: null,
    decidedAt: '',
    note: '',
  }));

  /* --------------------------------------------------------- the identity log */

  /**
   * What the ledger did this compile, as rows (P0-9).
   *
   * Read straight off `CompiledProject.identityLedgerEvents`, in the order the
   * engine reported them (by kind, then by asset id). The tag on the row is the
   * event's own, not a lookup: a `disappeared` event is about an asset this
   * compile has no catalog entry for, so asking the tag index would print an
   * asset id where the tag belongs.
   */
  const ledgerEventRows: WireLedgerEvent[] = project.identityLedgerEvents.map(
    (event: LedgerEvent): WireLedgerEvent => ({
      kind: event.kind,
      assetId: event.assetId,
      tag: event.canonicalTag,
      previousTag: event.previousCanonicalTag ?? '',
      tier: event.tier ?? '',
      detail: event.detail,
    }),
  );

  const ledgerEventCounts = new Map<LedgerEvent['kind'], number>();
  for (const event of project.identityLedgerEvents) {
    ledgerEventCounts.set(event.kind, (ledgerEventCounts.get(event.kind) ?? 0) + 1);
  }
  const ledgerCount = (kind: LedgerEvent['kind']): number => ledgerEventCounts.get(kind) ?? 0;

  /* ---------------------------------------------------------- the issues */

  const missingSystemAssets = project.catalog.assets.filter(
    (asset) => project.systems.bySubject.get(asset.assetId)?.resolution == null,
  );

  const demotedNodes: Array<readonly [string, ResolvedAssetNode]> = [];
  const unresolvedNodes: Array<readonly [string, ResolvedAssetNode]> = [];
  for (const [assetId, node] of project.snapshot.nodes) {
    if (node.parent.demotedFrom !== undefined) {
      demotedNodes.push([assetId, node]);
    }
    if (node.parent.status === 'unresolved') {
      unresolvedNodes.push([assetId, node]);
    }
  }

  const itemsOfKind = (kind: ReviewItem['kind']): readonly ReviewItem[] =>
    project.reviewItems.filter((item) => item.kind === kind);

  const rowsFor = (kind: WireCompileIssueKind): readonly WireCompileIssueRow[] => {
    switch (kind) {
      case 'assets':
        return project.catalog.assets.map((asset): WireCompileIssueRow => ({
          id: asset.assetId,
          title: asset.canonicalTag === '' ? asset.assetId : asset.canonicalTag,
          detail: asset.description ?? '',
          badge: asset.status,
        }));

      case 'flow-nodes':
        return [...project.flow.nodes.values()].map((node): WireCompileIssueRow => ({
          id: node.nodeId,
          title: node.tag,
          detail:
            node.enrichment?.description ??
            `${String(node.fedBy.length)} in, ${String(node.feeds.length)} out`,
          badge: sourceStatusOf(node.matchStatus),
        }));

      case 'demotions':
        return demotedNodes.map(([assetId, node]): WireCompileIssueRow => {
          const demotion = node.parent.demotedFrom;
          const levelId = demotion?.boundaryLevelId ?? '';
          return {
            id: assetId,
            title: tagOf(assetId),
            detail:
              demotion === undefined
                ? ''
                : `${tagOf(demotion.parentAssetId)} became a dependency: ` +
                  `${levelName.get(levelId) ?? levelId} differs.`,
            badge: levelName.get(levelId) ?? levelId,
          };
        });

      case 'duplicate-tags':
        return itemsOfKind('duplicate-model-tag').map((item): WireCompileIssueRow => ({
          id: storableReviewKey(item),
          title: item.kind === 'duplicate-model-tag' ? item.canonicalTag : '',
          detail: reviewItemSummary(item),
          badge: 'duplicate',
        }));

      case 'ambiguous-parents':
        return itemsOfKind('ambiguous-parent').map((item): WireCompileIssueRow => ({
          id: storableReviewKey(item),
          title: item.kind === 'ambiguous-parent' ? tagOf(item.assetId) : '',
          detail:
            item.kind === 'ambiguous-parent'
              ? `${item.candidateParentIds.map(tagOf).join(' or ')} — the ${item.ladderSource} rung tied, and nothing weaker was consulted.`
              : '',
          badge: item.kind === 'ambiguous-parent' ? item.ladderSource : '',
        }));

      case 'cycles': {
        // Two engines report loops: the SSM compiler breaks a structural cycle
        // into a review item, and the flow projection keeps a ring feed and
        // reports it as an anomaly. Both belong in front of a reviewer, and the
        // badge says which is which rather than merging them into one number.
        const structural = itemsOfKind('structural-cycle').map((item): WireCompileIssueRow => ({
          id: storableReviewKey(item),
          title: item.kind === 'structural-cycle' ? item.assetIds.map(tagOf).join(' → ') : '',
          detail: 'Assets that ended up parenting each other. Nothing was snapped automatically.',
          badge: 'hierarchy',
        }));
        const electrical = project.flow.flowAnomalies
          .filter((anomaly) => anomaly.kind === 'cycle')
          .map((anomaly, index): WireCompileIssueRow => ({
            id: `flow-cycle-${String(index)}`,
            title:
              anomaly.kind === 'cycle'
                ? anomaly.path
                    .map((nodeId) => project.flow.nodes.get(nodeId)?.tag ?? nodeId)
                    .join(' → ')
                : '',
            detail: 'A ring feed. The edges are kept — an alternate feed is a real arrangement.',
            badge: 'electrical',
          }));
        return [...structural, ...electrical];
      }

      case 'missing-systems':
        return missingSystemAssets.map((asset): WireCompileIssueRow => ({
          id: asset.assetId,
          title: asset.canonicalTag === '' ? asset.assetId : asset.canonicalTag,
          detail: 'No resolver rung produced a system key for this asset.',
          badge: 'unresolved',
        }));

      case 'system-conflicts':
        return itemsOfKind('system-conflict').map((item): WireCompileIssueRow => ({
          id: storableReviewKey(item),
          title: item.kind === 'system-conflict' ? tagOf(item.assetId) : '',
          detail:
            item.kind === 'system-conflict'
              ? item.claims
                  .map((claim) => `${String(claim.proposedValue ?? '—')} (${claim.rule})`)
                  .join(' vs ')
              : '',
          badge: 'conflict',
        }));

      case 'unresolved-parents':
        return unresolvedNodes.map(([assetId]): WireCompileIssueRow => ({
          id: assetId,
          title: tagOf(assetId),
          detail: 'No structural decision could be made. A review item says why.',
          badge: 'unresolved',
        }));

      case 'review-items':
        return reviewRows.map((row): WireCompileIssueRow => ({
          id: row.reviewKey,
          title: row.summary,
          detail: row.detail,
          badge: row.kind,
        }));

      default: {
        const exhaustive: never = kind;
        throw new Error(`Unhandled issue kind: ${String(exhaustive)}`);
      }
    }
  };

  /* -------------------------------------------------------------- the API */

  return {
    kind: 'compiled',
    project,
    hierarchy,
    assets: generatedMelAssets(project),
    tagOf,

    hasAsset(assetId: string): boolean {
      return assetById.has(assetId);
    },

    summary(base: CompileSummaryBase): WireCompileSummary {
      const stats = project.stats;
      const completeness = project.completeness;
      const audit = project.ssmAudit;
      return {
        compileId: base.compileId,
        profileRevision: base.profileRevision,
        finishedAt: base.finishedAt,
        durationMs: base.durationMs,

        assetCount: stats.assetCount,
        duplicateTagCount: stats.duplicateTagCount,
        resolvedSystemCount: stats.resolvedSystemCount,
        missingSystemCount: missingSystemAssets.length,
        systemConflictCount: stats.systemConflictCount,

        flowNodeCount: stats.flow.nodeCount,
        modelConfirmedCount: stats.flow.modelConfirmedCount,
        flowOnlyCount: stats.flow.flowOnlyCount,
        pmdOnlyCount: stats.flow.pmdOnlyCount,
        multiFeedNodeCount: stats.flow.multiFeedNodeCount,

        rootCount: stats.snapshot.rootCount,
        demotionCount: stats.snapshot.demotedToDependencyCount,
        ambiguousParentCount: stats.snapshot.ambiguousCount,
        cycleCount: stats.snapshot.cycleCount + stats.flow.cycleCount,
        unresolvedParentCount: stats.snapshot.unresolvedCount,

        learnedProposalCount: stats.learnedProposalCount,
        skippedClaimInputCount: stats.skippedClaimInputCount,
        generatedMelRowCount: stats.generatedMelRowCount,
        reviewItemCount: stats.reviewItemCount,
        undecidedReviewItemCount: base.undecidedReviewItemCount,

        ledgerNewAssetCount: ledgerCount('new-asset'),
        ledgerTagChangedCount: ledgerCount('tag-changed'),
        ledgerRematchedByTagCount: ledgerCount('rematched-by-tag'),
        ledgerSplitCount: ledgerCount('split'),
        ledgerDisappearedCount: ledgerCount('disappeared'),
        orphanedDecisionCount: project.reviewItems.filter(
          (item) => item.kind === 'orphaned-decision',
        ).length,

        // Read straight off the engine's own report: this view counts nothing
        // of its own, so the numbers a screen prints and the numbers the fold
        // decided cannot drift apart.
        completeness: {
          assetCount: completeness.assetCount,
          assetsNested: completeness.assetsNested,
          assetsRooted: completeness.assetsRooted,
          assetsWithNoParentCandidate: completeness.assetsWithNoParentCandidate,
          assetsWithoutSystem: completeness.assetsWithoutSystem,
          levels: completeness.levels.map((level) => ({ ...level })),
          demotionsPerLevel: completeness.demotionsPerLevel.map((entry) => ({ ...entry })),
          unresolvedSystemBySkipReason: completeness.unresolvedSystemBySkipReason.map(
            (group) => ({ skipReasons: [...group.skipReasons], assetCount: group.assetCount }),
          ),
          melRowsDropped: completeness.melRowsDropped,
        },

        // Read straight off the gate's own report for the same reason: the
        // counts a screen prints and the counts the rulebook produced cannot
        // drift apart if only one of them exists.
        ssmAudit: {
          rowCount: audit.rowCount,
          checksRun: audit.checksRun,
          findingCount: audit.findings.length,
          blockerCount: audit.bySeverity.blocker,
          errorCount: audit.bySeverity.error,
          warningCount: audit.bySeverity.warning,
          infoCount: audit.bySeverity.info,
          rules: audit.rulesEnabled.map((rule): WireSsmAuditRule => ({
            ruleId: rule.ruleId,
            title: rule.title,
            statement: rule.statement,
            source: rule.source,
            category: rule.category,
            confidence: rule.confidence,
            enabled: rule.enabled,
            findingCount: rule.findingCount,
            severity: rule.severity ?? '',
          })),
        },
      };
    },

    treeChildren(nodeKey: string, offset: number, limit: number): Page<WireTreeNode> {
      return page(buckets.get(nodeKey)?.rows ?? [], offset, limit);
    },

    treeSearch(query: string, limit: number): readonly WireTreeNode[] {
      const needle = query.trim().toLowerCase();
      if (needle === '') {
        return [];
      }
      const hits: WireTreeNode[] = [];
      for (const row of allAssetRows) {
        if (row.label.toLowerCase().includes(needle)) {
          hits.push(row);
          if (hits.length === limit) {
            break;
          }
        }
      }
      return hits;
    },

    issues(kind, offset, limit): Page<WireCompileIssueRow> {
      return page(rowsFor(kind), offset, limit);
    },

    ledgerEvents(offset: number, limit: number): Page<WireLedgerEvent> {
      return page(ledgerEventRows, offset, limit);
    },

    flowRoots(offset: number, limit: number): Page<WireFlowRoot> {
      return page(roots, offset, limit);
    },

    flowWalk(rootNodeId: string, offset: number, limit: number): Page<WireFlowNode> {
      return page(walk(rootNodeId), offset, limit);
    },

    reviewRows(): readonly WireReviewRow[] {
      return reviewRows;
    },

    /**
     * What a drag would do (PRODUCT.md §11.5, §11.3, P0-4).
     *
     * This is a *preview* of the boundary fold, not a second implementation of
     * it: the fold itself runs in the compiler on the next compile. What the
     * sentence has to convey is what that compile will decide — and since P0-4
     * a manual parent across an enabled boundary is not kept. The drag is still
     * allowed, because the override is worth recording and the dependency it
     * produces is a real relationship; what it is not is a nesting, and saying
     * so before the write is the whole point of a preview.
     */
    reparentPreview(childAssetId: string, parentAssetId: string | null): WireReparentPreview {
      if (!project.snapshot.nodes.has(childAssetId)) {
        return {
          allowed: false,
          explanation: 'That asset is not in this compile. Recompile and try again.',
          boundaryLevelId: '',
          wouldDemote: false,
        };
      }
      if (parentAssetId === null) {
        return {
          allowed: true,
          explanation: `${tagOf(childAssetId)} becomes a root of its own grouping. A stated root is kept, never re-derived.`,
          boundaryLevelId: '',
          wouldDemote: false,
        };
      }
      if (parentAssetId === childAssetId) {
        return {
          allowed: false,
          explanation: 'An asset cannot be its own parent.',
          boundaryLevelId: '',
          wouldDemote: false,
        };
      }
      if (!project.snapshot.nodes.has(parentAssetId)) {
        return {
          allowed: false,
          explanation: 'That parent is not in this compile. Recompile and try again.',
          boundaryLevelId: '',
          wouldDemote: false,
        };
      }

      // A cycle is the one thing a manual override cannot buy its way out of.
      let ancestor: string | null = parentAssetId;
      const guard = new Set<string>();
      while (ancestor !== null && !guard.has(ancestor)) {
        if (ancestor === childAssetId) {
          return {
            allowed: false,
            explanation: `${tagOf(parentAssetId)} already sits under ${tagOf(childAssetId)}, so this would make a loop.`,
            boundaryLevelId: '',
            wouldDemote: false,
          };
        }
        guard.add(ancestor);
        const node: ResolvedAssetNode | undefined = project.snapshot.nodes.get(ancestor);
        ancestor = node?.parent.status === 'resolved' ? node.parent.parentAssetId : null;
      }

      const childAttributes = subjectOf.get(childAssetId)?.attributes;
      const parentAttributes = subjectOf.get(parentAssetId)?.attributes;
      for (const levelId of boundaryLevels) {
        const attributeKey = attributeOfLevel.get(levelId) ?? levelId;
        const childValue = childAttributes?.get(attributeKey);
        const parentValue = parentAttributes?.get(attributeKey);
        if (childValue === undefined || parentValue === undefined) {
          return {
            allowed: true,
            explanation:
              `${levelName.get(levelId) ?? levelId} is not stated for ` +
              `${childValue === undefined ? tagOf(childAssetId) : tagOf(parentAssetId)}, so this ` +
              `boundary cannot be checked. ${tagOf(childAssetId)} will not nest until somebody ` +
              'states it — the override is recorded, and the compile raises a review item.',
            boundaryLevelId: levelId,
            wouldDemote: true,
          };
        }
        if (childValue !== parentValue) {
          return {
            allowed: true,
            explanation:
              `${tagOf(childAssetId)} and ${tagOf(parentAssetId)} differ at ${levelName.get(levelId) ?? levelId}` +
              ` (${childValue} against ${parentValue}), and that boundary is enabled. ` +
              `${tagOf(parentAssetId)} becomes a dependency of ${tagOf(childAssetId)} rather than ` +
              'its parent, and the crossing is explained in Review.',
            boundaryLevelId: levelId,
            wouldDemote: true,
          };
        }
      }

      return {
        allowed: true,
        explanation: `${tagOf(childAssetId)} and ${tagOf(parentAssetId)} agree on every boundary, so this nests cleanly.`,
        boundaryLevelId: '',
        wouldDemote: false,
      };
    },
  };
}

/* ================================================ the view a reopen rebuilds */

/** What the project file holds about its last compile, read back on open. */
export interface RestoredCompileInput {
  readonly compileId: number;
  /** When that compile finished, from the compile row. */
  readonly finishedAt: string;
  /** The resolved snapshot, exactly as `saveSnapshot` stored it. */
  readonly snapshot: ResolvedSnapshot;
  /** The register that compile produced, from `compile_assets`. */
  readonly assets: readonly GeneratedMelAsset[];
  /** The level stack the project is configured with now. */
  readonly hierarchy: WireHierarchyConfig;
}

/**
 * The sentence every view a reopened project cannot serve answers with.
 *
 * One wording, in one place, because the fix is always the same and a person
 * meeting three different phrasings of it would reasonably think they were
 * three different problems.
 */
function restoredRefusal(what: string): Error {
  return new Error(
    `This project is showing the compile it had on file when it was opened, and ${what} ` +
      'is not stored with it. Run Compile on screen 8 to rebuild it.',
  );
}

/**
 * The last compile, rebuilt from what the project file actually keeps (audit
 * "High — reopening a project discards the compile").
 *
 * `adopt()` used to start every session with no view at all, so the workspace
 * button, every workspace channel and every export threw until a full recompile
 * had run — multi-minute on a large site, every morning, to look at something
 * the project had already computed and written down.
 *
 * ## What can be rebuilt, and what cannot
 *
 * Three things are on file: the resolved snapshot (every asset's structural
 * parent, its dependencies and the review items the fold raised), the register
 * that compile produced, and the identity ledger. So the hierarchy of assets,
 * the tag search, the review queue and the register-shaped exports come back
 * whole.
 *
 * Nothing else does. The electrical projection, the property-derived previews,
 * the per-level grouping and the screen-8 checklist are all computed from the
 * model caches during a compile and none of them is written to the project
 * file. This view therefore refuses them by name rather than answering with an
 * empty list — "no flow nodes" is a statement about the site, and this view is
 * in no position to make one.
 *
 * ## Why there are no level rows
 *
 * A level node groups assets by an attribute value that only exists inside a
 * compile. The tree here is the asset nesting alone, which is the half the
 * snapshot recorded; the workspace says which compile it is showing and that a
 * recompile refreshes it, so the missing grouping is visible rather than
 * silently different.
 *
 * @returns `null` when the stored rows cannot be joined to the stored snapshot
 * — a compile recorded before the register carried `stableAssetId`. The caller
 * treats that exactly as "nothing has been compiled yet", which is what the
 * project did for every compile before this existed.
 */
export function createRestoredCompileView(input: RestoredCompileInput): CompileView | null {
  const assetById = new Map<string, GeneratedMelAsset>();
  for (const asset of input.assets) {
    if (asset.stableAssetId !== undefined) {
      assetById.set(asset.stableAssetId, asset);
    }
  }
  if (assetById.size === 0) {
    return null;
  }

  const tagOf = (assetId: string): string => assetById.get(assetId)?.canonicalTag ?? assetId;

  const flagsByAsset = new Map<string, number>();
  for (const item of input.snapshot.reviewItems) {
    for (const assetId of assetIdsOf(item)) {
      flagsByAsset.set(assetId, (flagsByAsset.get(assetId) ?? 0) + 1);
    }
  }

  /**
   * The projected level tree, rebuilt by the engine that built it the first
   * time.
   *
   * `hierarchyTree` groups by each asset's `levelPath`, which the snapshot
   * records per node — so the grouping this returns is the grouping that
   * compile produced, not an approximation of it. Its `subjects` argument is
   * read for the asset universe and its ordering and for nothing else (see
   * `tree.ts`), which is why an attribute-free subject per stored node is a
   * complete input here and would not be anywhere else.
   */
  const tree = hierarchyTree(
    input.snapshot,
    {
      // Rebuilt field by field rather than passed through: the wire shape
      // spells an unset display or boundary attribute as an absent key, and
      // under `exactOptionalPropertyTypes` an explicit `undefined` is not the
      // same thing as the engine's optional.
      levels: input.hierarchy.levels.map((level) => {
        const built: {
          levelId: string;
          displayName: string;
          attributeKey: string;
          displayAttributeKey?: string;
          boundaryAttributeKey?: string;
          boundary: boolean;
          missingValuePolicy: (typeof level)['missingValuePolicy'];
          sort: (typeof level)['sort'];
        } = {
          levelId: level.levelId,
          displayName: level.displayName,
          attributeKey: level.attributeKey,
          boundary: level.boundary,
          missingValuePolicy: level.missingValuePolicy,
          sort: level.sort,
        };
        if (level.displayAttributeKey !== undefined) {
          built.displayAttributeKey = level.displayAttributeKey;
        }
        if (level.boundaryAttributeKey !== undefined) {
          built.boundaryAttributeKey = level.boundaryAttributeKey;
        }
        return built;
      }),
    },
    [...input.snapshot.nodes.keys()].map((assetId) => ({
      assetId,
      attributes: new Map<string, string>(),
    })),
  );

  const levelName = new Map(input.hierarchy.levels.map((level) => [level.levelId, level.displayName]));
  const buckets = new Map<string, readonly WireTreeNode[]>();

  const assetRow = (node: HierarchyAssetNode): WireTreeNode => {
    const resolved = input.snapshot.nodes.get(node.assetId);
    return {
      nodeKey: `asset:${node.assetId}`,
      kind: 'asset',
      label: tagOf(node.assetId),
      detail: assetById.get(node.assetId)?.description ?? '',
      childCount: node.children.length,
      assetId: node.assetId,
      dependencyCount: node.dependencies.length,
      reviewFlagCount: flagsByAsset.get(node.assetId) ?? 0,
      parentStatus: node.status,
      overridden: resolved?.parent.ladderSource === 'manual',
      demoted: resolved?.parent.demotedFrom !== undefined,
    };
  };

  const indexAsset = (node: HierarchyAssetNode): void => {
    buckets.set(`asset:${node.assetId}`, node.children.map(assetRow));
    for (const child of node.children) {
      indexAsset(child);
    }
  };

  const indexLevel = (
    node: HierarchyLevelNode,
    parentPath: ReadonlyArray<readonly [string, string]>,
  ): WireTreeNode => {
    const path: ReadonlyArray<readonly [string, string]> = [
      ...parentPath,
      [node.levelId, node.key] as const,
    ];
    const key = `level:${JSON.stringify(path)}`;
    const rows = [
      ...node.levels.map((child): WireTreeNode => indexLevel(child, path)),
      ...node.assets.map(assetRow),
    ];
    for (const asset of node.assets) {
      indexAsset(asset);
    }
    buckets.set(key, rows);

    let flags = 0;
    for (const row of rows) {
      flags += row.reviewFlagCount;
    }
    return {
      nodeKey: key,
      kind: 'level',
      label: node.label,
      detail: levelName.get(node.levelId) ?? node.levelId,
      childCount: rows.length,
      assetId: '',
      dependencyCount: 0,
      reviewFlagCount: flags,
      parentStatus: '',
      overridden: false,
      demoted: false,
    };
  };

  buckets.set('', [
    ...tree.levels.map((level): WireTreeNode => indexLevel(level, [])),
    ...tree.assets.map(assetRow),
  ]);
  for (const asset of tree.assets) {
    indexAsset(asset);
  }

  const allAssetRows: WireTreeNode[] = [];
  for (const rows of buckets.values()) {
    for (const row of rows) {
      if (row.kind === 'asset') {
        allAssetRows.push(row);
      }
    }
  }
  allAssetRows.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));

  const reviewRows: WireReviewRow[] = input.snapshot.reviewItems.map((item): WireReviewRow => ({
    reviewKey: storableReviewKey(item),
    kind: item.kind,
    // A restored compile carries the snapshot's own items, which the fold
    // raised; the audit is not one of them, so there is no severity to report.
    severity: item.kind === 'ssm-audit' ? item.severity : '',
    summary: reviewItemSummary(item),
    detail: assetIdsOf(item)
      .map(tagOf)
      .filter((tag) => tag !== '')
      .join(', '),
    // The rulebook's own sentence, carried through untouched.
    statement: item.kind === 'ssm-audit' ? item.statement : '',
    decision: null,
    decidedAt: '',
    note: '',
  }));

  return {
    kind: 'restored',
    project: null,
    hierarchy: input.hierarchy,
    assets: input.assets,
    tagOf,

    hasAsset(assetId: string): boolean {
      return input.snapshot.nodes.has(assetId);
    },

    summary(): WireCompileSummary {
      // Never reached: a restored view is reported as `restored`, never as
      // `done`, so no screen ever has a summary to draw from it.
      throw restoredRefusal('the compile checklist');
    },

    treeChildren(nodeKey: string, offset: number, limit: number): Page<WireTreeNode> {
      return page(buckets.get(nodeKey) ?? [], offset, limit);
    },

    treeSearch(query: string, limit: number): readonly WireTreeNode[] {
      const needle = query.trim().toLowerCase();
      if (needle === '') {
        return [];
      }
      const hits: WireTreeNode[] = [];
      for (const row of allAssetRows) {
        if (row.label.toLowerCase().includes(needle)) {
          hits.push(row);
          if (hits.length === limit) {
            break;
          }
        }
      }
      return hits;
    },

    issues(): Page<WireCompileIssueRow> {
      throw restoredRefusal('the screen-8 checklist');
    },

    ledgerEvents(): Page<WireLedgerEvent> {
      throw restoredRefusal('the identity log for that compile');
    },

    flowRoots(): Page<WireFlowRoot> {
      throw restoredRefusal('the electrical projection');
    },

    flowWalk(): Page<WireFlowNode> {
      throw restoredRefusal('the electrical projection');
    },

    reviewRows(): readonly WireReviewRow[] {
      return reviewRows;
    },

    reparentPreview(): WireReparentPreview {
      return {
        allowed: false,
        explanation:
          'Matchline cannot say what this move would do without the compile behind it: the ' +
          'boundary values it would compare are read from the model, and this project is ' +
          'showing the compile it had on file when it was opened. Run Compile on screen 8 first.',
        boundaryLevelId: '',
        wouldDemote: false,
      };
    },
  };
}
