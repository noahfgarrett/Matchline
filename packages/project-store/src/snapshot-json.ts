/**
 * Getting a `ResolvedSnapshot` in and out of a JSON column.
 *
 * A snapshot holds its nodes in a `ReadonlyMap`, and `JSON.stringify` turns a
 * Map into `{}` -- an empty tree that looks perfectly valid. So the project
 * store never serializes a snapshot itself: `saveSnapshot` stores whatever
 * JSON-safe value the caller hands it, verbatim, and these two helpers are the
 * conversion the caller is expected to use.
 *
 * `serializeSnapshot` sorts nodes by `assetId`, so the stored text is the same
 * for any two runs that produced the same nodes, whatever order the compiler
 * inserted them in. `deserializeSnapshot` therefore hands back a Map in
 * assetId order, which is a normalization, not a loss: the Map's *contents*
 * round-trip exactly.
 */
import {
  LADDER_SOURCE_ORDER,
  RELATIONSHIP_TYPES,
  type AttributeClaim,
  type AttributeValue,
  type LadderSourceKind,
  type ParentDecision,
  type ParentDemotion,
  type Provenance,
  type RelationshipClaim,
  type ResolvedAssetNode,
  type ResolvedDependency,
  type ResolvedSnapshot,
  type ReviewItem,
  type SnapshotStats,
  type SourceRef,
  type SsmRelationshipClaim,
} from '@matchline/domain';

import { ProjectStoreError } from './errors.js';
import { SOURCE_KINDS } from './schema.js';
import {
  optionalStringAt,
  requireArrayAt,
  requireIntegerAt,
  requireMemberAt,
  requireNumberAt,
  requireRecordAt,
  requireStringArrayAt,
  requireStringAt,
  type Fail,
} from './validate.js';

const fail: Fail = (field, detail) => {
  throw new ProjectStoreError({ kind: 'invalid-snapshot', field, detail });
};

/**
 * A snapshot in a shape JSON can hold.
 *
 * `nodes` replaces the snapshot's Map, ordered by `assetId`. Nothing else in a
 * `ResolvedSnapshot` needs converting -- review items and stats are already
 * plain data.
 */
export interface SerializedSnapshot {
  readonly nodes: ReadonlyArray<ResolvedAssetNode>;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
  readonly stats: SnapshotStats;
}

const PARENT_STATUSES = [
  'resolved',
  'root',
  'provisional-root',
  'unresolved',
] as const satisfies ReadonlyArray<ParentDecision['status']>;

const RELATIONSHIP_KINDS = ['structural-parent', 'dependency'] as const;

const REVIEW_KINDS = [
  'system-conflict',
  'duplicate-model-tag',
  'system-catalog-conflict',
  'fuzzy-identity',
  'ambiguous-suffix',
  'ambiguous-parent',
  'structural-cycle',
  'missing-boundary',
  'nesting-proposal',
] as const satisfies ReadonlyArray<ReviewItem['kind']>;

function readEvidenceTier(value: unknown, field: string): 1 | 2 | 3 | 4 {
  const tier = requireIntegerAt(value, field, fail);
  if (tier !== 1 && tier !== 2 && tier !== 3 && tier !== 4) {
    return fail(field, `expected an evidence tier 1-4, got ${String(tier)}`);
  }
  return tier;
}

function readAttributeValue(value: unknown, field: string): AttributeValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return requireNumberAt(value, field, fail);
  }
  return fail(field, 'expected a string, number, boolean or null');
}

function readSourceRef(value: unknown, field: string): SourceRef {
  const record = requireRecordAt(value, field, fail);
  const kind = requireMemberAt(
    record['kind'],
    ['model-object', 'sheet-row'] as const,
    `${field}.kind`,
    fail,
  );
  if (kind === 'model-object') {
    return { kind, objectId: requireStringAt(record['objectId'], `${field}.objectId`, fail) };
  }
  return {
    kind,
    sheet: requireStringAt(record['sheet'], `${field}.sheet`, fail),
    row: requireIntegerAt(record['row'], `${field}.row`, fail),
  };
}

function readProvenance(value: unknown, field: string): Provenance {
  const record = requireRecordAt(value, field, fail);
  const provenance: {
    sourceFile: string;
    sourceRef: SourceRef;
    propertyOrColumn?: string;
    rule?: string;
    fallbackRung?: number;
    manualDecision?: string;
    inputRevision?: string;
    profileRevision?: string;
  } = {
    sourceFile: requireStringAt(record['sourceFile'], `${field}.sourceFile`, fail),
    sourceRef: readSourceRef(record['sourceRef'], `${field}.sourceRef`),
  };

  const textFields = [
    'propertyOrColumn',
    'rule',
    'manualDecision',
    'inputRevision',
    'profileRevision',
  ] as const;
  for (const key of textFields) {
    const text = optionalStringAt(record[key], `${field}.${key}`, fail);
    if (text !== undefined) {
      provenance[key] = text;
    }
  }
  if (record['fallbackRung'] !== undefined) {
    provenance.fallbackRung = requireIntegerAt(
      record['fallbackRung'],
      `${field}.fallbackRung`,
      fail,
    );
  }
  return provenance;
}

function readAttributeClaim(value: unknown, field: string): AttributeClaim {
  const record = requireRecordAt(value, field, fail);
  return {
    subjectAssetId: requireStringAt(record['subjectAssetId'], `${field}.subjectAssetId`, fail),
    attribute: requireStringAt(record['attribute'], `${field}.attribute`, fail),
    proposedValue: readAttributeValue(record['proposedValue'], `${field}.proposedValue`),
    source: requireMemberAt(record['source'], SOURCE_KINDS, `${field}.source`, fail),
    rule: requireStringAt(record['rule'], `${field}.rule`, fail),
    evidenceTier: readEvidenceTier(record['evidenceTier'], `${field}.evidenceTier`),
    provenance: readProvenance(record['provenance'], `${field}.provenance`),
  };
}

function readRelationshipClaim(record: Record<string, unknown>, field: string): RelationshipClaim {
  return {
    subjectAssetId: requireStringAt(record['subjectAssetId'], `${field}.subjectAssetId`, fail),
    targetAssetId: requireStringAt(record['targetAssetId'], `${field}.targetAssetId`, fail),
    kind: requireMemberAt(record['kind'], RELATIONSHIP_KINDS, `${field}.kind`, fail),
    relationshipType: requireMemberAt(
      record['relationshipType'],
      RELATIONSHIP_TYPES,
      `${field}.relationshipType`,
      fail,
    ),
    source: requireMemberAt(record['source'], SOURCE_KINDS, `${field}.source`, fail),
    rule: requireStringAt(record['rule'], `${field}.rule`, fail),
    evidenceTier: readEvidenceTier(record['evidenceTier'], `${field}.evidenceTier`),
    provenance: readProvenance(record['provenance'], `${field}.provenance`),
  };
}

function readSsmClaim(value: unknown, field: string): SsmRelationshipClaim {
  const record = requireRecordAt(value, field, fail);
  return {
    ...readRelationshipClaim(record, field),
    ladderSource: requireMemberAt(
      record['ladderSource'],
      LADDER_SOURCE_ORDER,
      `${field}.ladderSource`,
      fail,
    ),
  };
}

function readDemotion(value: unknown, field: string): ParentDemotion {
  const record = requireRecordAt(value, field, fail);
  return {
    parentAssetId: requireStringAt(record['parentAssetId'], `${field}.parentAssetId`, fail),
    boundaryLevelId: requireStringAt(record['boundaryLevelId'], `${field}.boundaryLevelId`, fail),
  };
}

function readParentDecision(value: unknown, field: string): ParentDecision {
  const record = requireRecordAt(value, field, fail);
  const rawParent = record['parentAssetId'];
  const parentAssetId =
    rawParent === null ? null : requireStringAt(rawParent, `${field}.parentAssetId`, fail);
  const rawLadder = record['ladderSource'];
  const ladderSource: LadderSourceKind | null =
    rawLadder === null
      ? null
      : requireMemberAt(rawLadder, LADDER_SOURCE_ORDER, `${field}.ladderSource`, fail);
  const status = requireMemberAt(record['status'], PARENT_STATUSES, `${field}.status`, fail);

  if (status === 'resolved' && parentAssetId === null) {
    fail(`${field}.parentAssetId`, "status 'resolved' requires a parent");
  }
  if (status !== 'resolved' && parentAssetId !== null) {
    fail(`${field}.parentAssetId`, `status '${status}' requires a null parent`);
  }

  const decision: {
    parentAssetId: string | null;
    ladderSource: LadderSourceKind | null;
    status: ParentDecision['status'];
    winningClaim?: SsmRelationshipClaim;
    demotedFrom?: ParentDemotion;
  } = { parentAssetId, ladderSource, status };

  if (record['winningClaim'] !== undefined) {
    decision.winningClaim = readSsmClaim(record['winningClaim'], `${field}.winningClaim`);
  }
  if (record['demotedFrom'] !== undefined) {
    decision.demotedFrom = readDemotion(record['demotedFrom'], `${field}.demotedFrom`);
  }
  return decision;
}

function readDependency(value: unknown, field: string): ResolvedDependency {
  const record = requireRecordAt(value, field, fail);
  return {
    parentAssetId: requireStringAt(record['parentAssetId'], `${field}.parentAssetId`, fail),
    relationshipType: requireMemberAt(
      record['relationshipType'],
      RELATIONSHIP_TYPES,
      `${field}.relationshipType`,
      fail,
    ),
    provenance: readProvenance(record['provenance'], `${field}.provenance`),
  };
}

function readNode(value: unknown, field: string): ResolvedAssetNode {
  const record = requireRecordAt(value, field, fail);
  return {
    assetId: requireStringAt(record['assetId'], `${field}.assetId`, fail),
    parent: readParentDecision(record['parent'], `${field}.parent`),
    dependencies: requireArrayAt(record['dependencies'], `${field}.dependencies`, fail).map(
      (item, index) => readDependency(item, `${field}.dependencies[${index}]`),
    ),
    levelPath: requireArrayAt(record['levelPath'], `${field}.levelPath`, fail).map(
      (item, index) => {
        const level = requireRecordAt(item, `${field}.levelPath[${index}]`, fail);
        return {
          levelId: requireStringAt(
            level['levelId'],
            `${field}.levelPath[${index}].levelId`,
            fail,
          ),
          value: requireStringAt(level['value'], `${field}.levelPath[${index}].value`, fail),
        };
      },
    ),
    losingClaims: requireArrayAt(record['losingClaims'], `${field}.losingClaims`, fail).map(
      (item, index) => readSsmClaim(item, `${field}.losingClaims[${index}]`),
    ),
  };
}

function readReviewItem(value: unknown, field: string): ReviewItem {
  const record = requireRecordAt(value, field, fail);
  const kind = requireMemberAt(record['kind'], REVIEW_KINDS, `${field}.kind`, fail);
  switch (kind) {
    case 'system-conflict':
      return {
        kind,
        assetId: requireStringAt(record['assetId'], `${field}.assetId`, fail),
        claims: requireArrayAt(record['claims'], `${field}.claims`, fail).map((item, index) =>
          readAttributeClaim(item, `${field}.claims[${index}]`),
        ),
      };
    case 'duplicate-model-tag':
      return {
        kind,
        canonicalTag: requireStringAt(record['canonicalTag'], `${field}.canonicalTag`, fail),
        objectIds: requireArrayAt(record['objectIds'], `${field}.objectIds`, fail).map(
          (item, index) => requireIntegerAt(item, `${field}.objectIds[${index}]`, fail),
        ),
      };
    case 'system-catalog-conflict':
      return {
        kind,
        systemKey: requireStringAt(record['systemKey'], `${field}.systemKey`, fail),
        descriptions: requireStringArrayAt(
          record['descriptions'],
          `${field}.descriptions`,
          fail,
        ),
      };
    case 'fuzzy-identity':
      return {
        kind,
        evidenceTag: requireStringAt(record['evidenceTag'], `${field}.evidenceTag`, fail),
        candidates: requireArrayAt(record['candidates'], `${field}.candidates`, fail).map(
          (item, index) => {
            const candidate = requireRecordAt(item, `${field}.candidates[${index}]`, fail);
            return {
              assetId: requireStringAt(
                candidate['assetId'],
                `${field}.candidates[${index}].assetId`,
                fail,
              ),
              distance: requireIntegerAt(
                candidate['distance'],
                `${field}.candidates[${index}].distance`,
                fail,
              ),
            };
          },
        ),
      };
    case 'ambiguous-suffix':
      return {
        kind,
        evidenceTag: requireStringAt(record['evidenceTag'], `${field}.evidenceTag`, fail),
        candidateAssetIds: requireStringArrayAt(
          record['candidateAssetIds'],
          `${field}.candidateAssetIds`,
          fail,
        ),
      };
    case 'ambiguous-parent':
      return {
        kind,
        assetId: requireStringAt(record['assetId'], `${field}.assetId`, fail),
        ladderSource: requireMemberAt(
          record['ladderSource'],
          LADDER_SOURCE_ORDER,
          `${field}.ladderSource`,
          fail,
        ),
        candidateParentIds: requireStringArrayAt(
          record['candidateParentIds'],
          `${field}.candidateParentIds`,
          fail,
        ),
      };
    case 'structural-cycle':
      return {
        kind,
        assetIds: requireStringArrayAt(record['assetIds'], `${field}.assetIds`, fail),
      };
    case 'missing-boundary':
      return {
        kind,
        assetId: requireStringAt(record['assetId'], `${field}.assetId`, fail),
        levelId: requireStringAt(record['levelId'], `${field}.levelId`, fail),
      };
    case 'nesting-proposal':
      return {
        kind,
        assetId: requireStringAt(record['assetId'], `${field}.assetId`, fail),
        proposedParentId: requireStringAt(
          record['proposedParentId'],
          `${field}.proposedParentId`,
          fail,
        ),
        ruleDetail: requireStringAt(record['ruleDetail'], `${field}.ruleDetail`, fail),
        confidence: requireNumberAt(record['confidence'], `${field}.confidence`, fail),
      };
    default: {
      const exhaustive: never = kind;
      return fail(`${field}.kind`, `unhandled review item ${String(exhaustive)}`);
    }
  }
}

function readStats(value: unknown, field: string): SnapshotStats {
  const record = requireRecordAt(value, field, fail);
  const counts = [
    'nodeCount',
    'rootCount',
    'demotedToDependencyCount',
    'unresolvedCount',
    'cycleCount',
    'ambiguousCount',
  ] as const satisfies ReadonlyArray<keyof SnapshotStats>;

  const read = (key: (typeof counts)[number]): number => {
    const count = requireIntegerAt(record[key], `${field}.${key}`, fail);
    if (count < 0) {
      fail(`${field}.${key}`, `expected a non-negative count, got ${String(count)}`);
    }
    return count;
  };

  return {
    nodeCount: read('nodeCount'),
    rootCount: read('rootCount'),
    demotedToDependencyCount: read('demotedToDependencyCount'),
    unresolvedCount: read('unresolvedCount'),
    cycleCount: read('cycleCount'),
    ambiguousCount: read('ambiguousCount'),
  };
}

/**
 * Converts a snapshot into the JSON-safe shape `saveSnapshot` stores.
 *
 * @throws ProjectStoreError `invalid-snapshot` when a Map key disagrees with
 * the `assetId` of the node it holds -- the two are the same identity, and a
 * disagreement would silently change which asset a node describes.
 */
export function serializeSnapshot(snapshot: ResolvedSnapshot): SerializedSnapshot {
  const nodes: ResolvedAssetNode[] = [];
  for (const [assetId, node] of snapshot.nodes) {
    if (assetId !== node.assetId) {
      fail('nodes', `map key '${assetId}' does not match node assetId '${node.assetId}'`);
    }
    nodes.push(node);
  }
  nodes.sort((left, right) => (left.assetId < right.assetId ? -1 : 1));
  return {
    nodes,
    reviewItems: [...snapshot.reviewItems],
    stats: snapshot.stats,
  };
}

/**
 * Validates a parsed JSON value and rebuilds the snapshot, nodes keyed by
 * `assetId` in sorted order.
 *
 * @throws ProjectStoreError `invalid-snapshot`, naming the field that failed.
 */
export function deserializeSnapshot(value: unknown): ResolvedSnapshot {
  const record = requireRecordAt(value, 'snapshot', fail);
  const nodes = new Map<string, ResolvedAssetNode>();
  const parsed = requireArrayAt(record['nodes'], 'snapshot.nodes', fail).map((item, index) =>
    readNode(item, `snapshot.nodes[${index}]`),
  );
  for (const node of [...parsed].sort((left, right) => (left.assetId < right.assetId ? -1 : 1))) {
    if (nodes.has(node.assetId)) {
      fail('snapshot.nodes', `asset '${node.assetId}' appears twice`);
    }
    nodes.set(node.assetId, node);
  }

  return {
    nodes,
    reviewItems: requireArrayAt(record['reviewItems'], 'snapshot.reviewItems', fail).map(
      (item, index) => readReviewItem(item, `snapshot.reviewItems[${index}]`),
    ),
    stats: readStats(record['stats'], 'snapshot.stats'),
  };
}
