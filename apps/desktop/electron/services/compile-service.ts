import {
  compileProject,
  type CompileProjectInput,
  type CompiledProject,
  type ConnectivityWorkbookInput,
  type MelWorkbookInput,
} from '@matchline/compiler';
import type {
  ManualRelationshipOverride,
  ResolvedAssetNode,
  ReviewItem,
  SiteProfile,
} from '@matchline/domain';
import { reviewItemSummary } from '@matchline/domain';
import {
  sourceStatusOf,
  walkSourceToLoad,
  type FlowNode,
  type FlowVisit,
} from '@matchline/electrical-flow';
import type { LearnedRuleSet } from '@matchline/learned-rules';
import type { GeneratedMelAsset } from '@matchline/mel-export';
import type { ExtractionCache } from '@matchline/model-schema';
import { reviewKey } from '@matchline/ssm-compiler';
import type { HierarchyAssetNode, HierarchyLevelNode } from '@matchline/ssm-compiler';

import type {
  WireCompileIssueKind,
  WireCompileIssueRow,
  WireCompileSummary,
  WireFlowNode,
  WireFlowRoot,
  WireProjectConfig,
  WireReparentPreview,
  WireReviewRow,
  WireTreeNode,
} from '../../shared/schemas.js';

import {
  toDisciplineProjection,
  toHierarchyConfig,
  toLadder,
  toParentTagProperty,
  toRoleGraph,
} from './project-config.js';

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

/**
 * One open model source, as a compile and the wizard's previews both read it.
 *
 * The `sourceId` is the project's own (`deriveSourceId`), never a file name and
 * never a constant: it is the identity every per-source number, duplicate-tag
 * report and untagged asset id is addressed by. The same array feeds the
 * wizard's catalog preview (`project-session.ts`), so the asset ids a person
 * sees on screen 3 are the asset ids the compile produces on screen 8.
 */
export interface CompileSource {
  readonly sourceId: string;
  readonly cache: ExtractionCache;
  readonly displayName: string;
  readonly rawFileName: string;
}

/** Everything a compile needs that the session already holds. */
export interface CompileRequest {
  /** Every ready model source, in `sourceId` order. Never empty. */
  readonly sources: readonly CompileSource[];
  readonly profile: SiteProfile;
  readonly config: WireProjectConfig;
  readonly connectivityWorkbooks: readonly ConnectivityWorkbookInput[];
  readonly melWorkbook: MelWorkbookInput | null;
  readonly learnedRules: LearnedRuleSet | null;
  readonly manualRelationshipOverrides: readonly ManualRelationshipOverride[];
}

/**
 * Builds the compiler's input.
 *
 * Assembled key by key rather than with spreads and `??`: under
 * `exactOptionalPropertyTypes` an explicit `roleGraph: undefined` is not the
 * same as an absent key, and `CompileProjectInput` means absent — a present
 * `undefined` would be read as "a role graph was supplied" by anything that
 * checks with `in`.
 */
export function buildCompileInput(request: CompileRequest): CompileProjectInput {
  const input: {
    sources: CompileProjectInput['sources'];
    profile: SiteProfile;
    hierarchy: CompileProjectInput['hierarchy'];
    includePropertyCatalog: boolean;
    ladder?: NonNullable<CompileProjectInput['ladder']>;
    roleGraph?: NonNullable<CompileProjectInput['roleGraph']>;
    connectivityWorkbooks?: ReadonlyArray<ConnectivityWorkbookInput>;
    melWorkbook?: MelWorkbookInput;
    learnedRules?: LearnedRuleSet;
    manualRelationshipOverrides?: ReadonlyArray<ManualRelationshipOverride>;
    parentTagProperty?: NonNullable<CompileProjectInput['parentTagProperty']>;
    ssmDisciplineProjection?: NonNullable<CompileProjectInput['ssmDisciplineProjection']>;
  } = {
    // Every ready model source, not the first one: a project is a universe
    // (P0-1). `compileProject` reorders by `sourceId` itself, so registering
    // them in a different order is the same compile.
    sources: request.sources.map((source) => ({
      sourceId: source.sourceId,
      cache: source.cache,
      displayName: source.displayName,
      rawFileName: source.rawFileName,
    })),
    profile: request.profile,
    hierarchy: toHierarchyConfig(request.config),
    // Screen 2 builds its own catalog from the same caches; a compile paying
    // for a second streaming pass per cache would be work nothing reads.
    includePropertyCatalog: false,
  };

  const ladder = toLadder(request.config);
  if (ladder !== null) {
    input.ladder = ladder;
  }
  const roleGraph = toRoleGraph(request.config);
  if (roleGraph !== null) {
    input.roleGraph = roleGraph;
  }
  if (request.connectivityWorkbooks.length > 0) {
    input.connectivityWorkbooks = [...request.connectivityWorkbooks];
  }
  if (request.melWorkbook !== null) {
    input.melWorkbook = request.melWorkbook;
  }
  if (request.learnedRules !== null) {
    input.learnedRules = request.learnedRules;
  }
  if (request.manualRelationshipOverrides.length > 0) {
    input.manualRelationshipOverrides = [...request.manualRelationshipOverrides];
  }
  const parentTagProperty = toParentTagProperty(request.config);
  if (parentTagProperty !== null) {
    input.parentTagProperty = parentTagProperty;
  }
  const projection = toDisciplineProjection(request.config);
  if (projection !== null) {
    input.ssmDisciplineProjection = projection;
  }

  return input;
}

export function runCompile(request: CompileRequest): CompiledProject {
  return compileProject(buildCompileInput(request));
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
  readonly project: CompiledProject;
  readonly assets: readonly GeneratedMelAsset[];
  tagOf(assetId: string): string;
  summary(base: CompileSummaryBase): WireCompileSummary;
  treeChildren(nodeKey: string, offset: number, limit: number): Page<WireTreeNode>;
  treeSearch(query: string, limit: number): readonly WireTreeNode[];
  issues(kind: WireCompileIssueKind, offset: number, limit: number): Page<WireCompileIssueRow>;
  flowRoots(offset: number, limit: number): Page<WireFlowRoot>;
  flowWalk(rootNodeId: string, offset: number, limit: number): Page<WireFlowNode>;
  reviewRows(): readonly WireReviewRow[];
  reparentPreview(childAssetId: string, parentAssetId: string | null): WireReparentPreview;
}

/** The facts about a compile that come from the store, not from the engine. */
export interface CompileSummaryBase {
  readonly compileId: number;
  readonly profileRevision: number;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly undecidedReviewItemCount: number;
}

export function createCompileView(
  project: CompiledProject,
  config: WireProjectConfig,
): CompileView {
  const tags = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset.canonicalTag]));
  const assetById = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset]));
  const levelName = new Map(config.hierarchy.levels.map((level) => [level.levelId, level.displayName]));
  const boundaryLevels = new Set(
    config.hierarchy.levels.filter((level) => level.boundary).map((level) => level.levelId),
  );
  const attributeOfLevel = new Map(
    config.hierarchy.levels.map((level) => [level.levelId, level.attributeKey]),
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
    const path: ReadonlyArray<readonly [string, string]> = [
      ...parentPath,
      [node.levelId, node.value] as const,
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
      label: node.value,
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
    summary: reviewItemSummary(item),
    detail: assetIdsOf(item)
      .map(tagOf)
      .filter((tag) => tag !== '')
      .join(', '),
    decision: null,
    decidedAt: '',
    note: '',
  }));

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
    project,
    assets: generatedMelAssets(project),
    tagOf,

    summary(base: CompileSummaryBase): WireCompileSummary {
      const stats = project.stats;
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
     * What a drag would do (PRODUCT.md §11.5, §11.3).
     *
     * This is a *preview* of the boundary fold, not a second implementation of
     * it: the fold itself still runs in the compiler on the next compile, and
     * a manual override deliberately bypasses it. What the sentence has to
     * convey is which of those two is about to happen.
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
        if (childValue === undefined || parentValue === undefined || childValue !== parentValue) {
          return {
            allowed: true,
            explanation:
              `${tagOf(childAssetId)} and ${tagOf(parentAssetId)} differ at ${levelName.get(levelId) ?? levelId}` +
              ` (${childValue ?? 'not stated'} against ${parentValue ?? 'not stated'}). ` +
              'A stated parent is kept across a boundary, so this nests and nothing is demoted — ' +
              'which is exactly what you are overruling.',
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
