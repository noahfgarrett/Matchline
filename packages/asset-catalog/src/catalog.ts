/**
 * Asset candidate filtering (PRODUCT.md §6.6): one extraction cache plus one
 * Site Profile in, the model-first asset universe out.
 *
 * Model-first means the universe comes only from the cache (ENGINE.md E1 rule
 * 1). Nothing here invents a field, merges a duplicate, or normalizes a value
 * beyond stripping the whitespace an extractor left on it -- aliases and case
 * folding are identity work and belong to E2. Everything a filter removed is
 * counted, because the setup wizard has to show the inclusion impact before a
 * profile is saved.
 */
import type {
  AssetFilterConfig,
  DuplicateModelTagReviewItem,
  PropertyMappings,
  PropertyRef,
  ReviewItem,
} from '@matchline/domain';
import type { ExtractionCache, ModelObject, SelectionSetNode } from '@matchline/model-schema';

import { AssetCatalogConfigError } from './errors.js';
import { isTagAccepted } from './patterns.js';
import {
  FILTER_STAGES,
  type AssetFieldProvenance,
  type FilterStageImpact,
  type FilterStageName,
  type InclusionImpact,
  type ModelAsset,
  type ModelAssetProvenance,
  type ModelAssetStatus,
} from './types.js';

/** What one cache and one profile say about the model side of a project. */
export interface AssetCatalog {
  readonly assets: ReadonlyArray<ModelAsset>;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
  readonly impact: InclusionImpact;
}

/** Which mapped role a value plays. Recorded in `Provenance.rule`. */
type MappedField =
  | 'equipmentTag'
  | 'description'
  | 'equipmentType'
  | 'building'
  | 'nativeDiscipline'
  | 'wbs'
  | 'itemMaster'
  | 'equipmentClassification';

/** The roles read from the asset as a whole. The tag is read from the owner. */
type OptionalField = Exclude<MappedField, 'equipmentTag'>;

/** The optional fields an asset may carry, all of them plain text. */
type OptionalFieldValues = Partial<Record<OptionalField, string>>;

/** Provenance is filled in field by field, then handed out under the readonly type. */
type MutableAssetProvenance = {
  -readonly [Field in keyof ModelAssetProvenance]: ModelAssetProvenance[Field];
};

/**
 * NUL separator: no Navisworks category or property name contains one, so two
 * distinct `(category, name)` pairs can never collide into one key.
 */
function propertyKey(ref: PropertyRef): string {
  return `${ref.category}\u0000${ref.name}`;
}

/**
 * Makes a tag safe to put in front of the `#<objectId>` a duplicate id ends
 * with.
 *
 * `%` goes first so the escape is injective: without it `X#` and `X%23` would
 * both become `X%23`, and a tag containing a literal `#` could spell another
 * asset's id exactly.
 */
function escapeTagForId(tag: string): string {
  return tag.replaceAll('%', '%25').replaceAll('#', '%23');
}

/**
 * A blank value is not a value: extractors write empty strings where a
 * property exists but says nothing, and a tag of spaces is not a tag.
 * Trimming is the only normalization this package performs.
 */
function meaningful(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Every source model in the forest, flattened to `id -> file_name`. */
function sourceModelFileNames(cache: ExtractionCache): ReadonlyMap<number, string | null> {
  const fileNames = new Map<number, string | null>();
  const stack = [...cache.sourceModels()].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (fileNames.has(node.id)) {
      continue;
    }
    fileNames.set(node.id, node.fileName);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return fileNames;
}

/** Selection sets flattened depth-first, folders included. */
function flattenSelectionSets(cache: ExtractionCache): readonly SelectionSetNode[] {
  const flat: SelectionSetNode[] = [];
  const stack = [...cache.selectionSets()].reverse();
  const seen = new Set<number>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    flat.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return flat;
}

/**
 * The objects the named sets cover.
 *
 * A folder carries no members of its own, so naming one means its contents:
 * the members of the named node and of everything beneath it. Reading a folder
 * as empty would silently filter a whole project away.
 *
 * @throws AssetCatalogConfigError when a name is not in the cache.
 */
function selectionSetMembers(
  cache: ExtractionCache,
  names: ReadonlyArray<string>,
): ReadonlySet<number> {
  const byName = new Map<string, SelectionSetNode[]>();
  for (const node of flattenSelectionSets(cache)) {
    const bucket = byName.get(node.name);
    if (bucket === undefined) {
      byName.set(node.name, [node]);
    } else {
      bucket.push(node);
    }
  }

  const members = new Set<number>();
  for (const name of names) {
    const matches = byName.get(name);
    if (matches === undefined) {
      throw new AssetCatalogConfigError({
        kind: 'unknown-selection-set',
        name,
        available: [...byName.keys()],
      });
    }
    // Several sets may share a name; naming it means all of them.
    for (const match of matches) {
      const stack: SelectionSetNode[] = [match];
      const seen = new Set<number>();
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined || seen.has(node.id)) {
          continue;
        }
        seen.add(node.id);
        for (const objectId of node.memberObjectIds) {
          members.add(objectId);
        }
        for (const child of node.children) {
          stack.push(child);
        }
      }
    }
  }
  return members;
}

/**
 * The mapped property values of the objects still in the running, read in one
 * streaming pass rather than one query per object.
 *
 * First non-blank reading wins: an object can carry the same property twice
 * (the Dragon fixture does), and the first one is the one the extractor met
 * first, which is stable across runs.
 */
function readMappedValues(
  cache: ExtractionCache,
  refs: ReadonlyMap<string, PropertyRef>,
  wanted: ReadonlySet<number>,
): ReadonlyMap<number, ReadonlyMap<string, string>> {
  const values = new Map<number, Map<string, string>>();
  if (refs.size === 0 || wanted.size === 0) {
    return values;
  }
  for (const property of cache.allProperties()) {
    if (!wanted.has(property.objectId)) {
      continue;
    }
    const key = propertyKey(property);
    if (!refs.has(key)) {
      continue;
    }
    const value = meaningful(property.valueText);
    if (value === null) {
      continue;
    }
    let bucket = values.get(property.objectId);
    if (bucket === undefined) {
      bucket = new Map<string, string>();
      values.set(property.objectId, bucket);
    }
    if (!bucket.has(key)) {
      bucket.set(key, value);
    }
  }
  return values;
}

/** The nearest ancestor that is itself a candidate, or `null`. */
function nearestCandidateAncestor(
  object: ModelObject,
  objects: ReadonlyMap<number, ModelObject>,
  candidateIds: ReadonlySet<number>,
): number | null {
  const seen = new Set<number>([object.id]);
  let parentId = object.parentId;
  while (parentId !== null) {
    // Extraction ordinals rule cycles out, but refusing to revisit keeps a
    // corrupt cache from hanging the compile.
    if (seen.has(parentId)) {
      return null;
    }
    seen.add(parentId);
    if (candidateIds.has(parentId)) {
      return parentId;
    }
    const parent = objects.get(parentId);
    if (parent === undefined) {
      // A parent id pointing at a row that is not there ends the chain.
      return null;
    }
    parentId = parent.parentId;
  }
  return null;
}

/**
 * Component collapse: which candidate each candidate belongs to.
 *
 * A candidate is absorbed by its nearest *surviving* candidate ancestor, so a
 * chain A > B > C collapses all the way into A. A class listed in
 * `separatelyCommissionableClasses` is never absorbed -- it stays its own
 * asset, and can still absorb its own descendants.
 *
 * The answer is a function of the tree, not of the walk, so visiting order
 * does not change it.
 */
function resolveOwners(
  candidates: readonly ModelObject[],
  candidateIds: ReadonlySet<number>,
  objects: ReadonlyMap<number, ModelObject>,
  separatelyCommissionable: ReadonlySet<string>,
): ReadonlyMap<number, number> {
  const owners = new Map<number, number>();
  const escapes = (object: ModelObject): boolean =>
    object.className !== null && separatelyCommissionable.has(object.className);

  for (const candidate of candidates) {
    if (owners.has(candidate.id)) {
      continue;
    }
    // Walked iteratively: model trees are deep enough that recursing once per
    // ancestor is a stack overflow waiting to happen.
    const chain: number[] = [];
    let node: ModelObject = candidate;
    let owner = candidate.id;
    for (;;) {
      const memo = owners.get(node.id);
      if (memo !== undefined) {
        owner = memo;
        break;
      }
      chain.push(node.id);
      if (escapes(node)) {
        owner = node.id;
        break;
      }
      const ancestorId = nearestCandidateAncestor(node, objects, candidateIds);
      const ancestor = ancestorId === null ? undefined : objects.get(ancestorId);
      if (ancestor === undefined) {
        owner = node.id;
        break;
      }
      node = ancestor;
    }
    // Everything on the path shares the owner the path ended at.
    for (const id of chain) {
      owners.set(id, owner);
    }
  }
  return owners;
}

interface FieldRead {
  readonly value: string;
  readonly objectId: number;
}

/** The first of an asset's objects carrying `ref`, in `objectIds` order. */
function readField(
  objectIds: readonly number[],
  ref: PropertyRef,
  values: ReadonlyMap<number, ReadonlyMap<string, string>>,
): FieldRead | null {
  const key = propertyKey(ref);
  for (const objectId of objectIds) {
    const value = values.get(objectId)?.get(key);
    if (value !== undefined) {
      return { value, objectId };
    }
  }
  return null;
}

/** One tag that collapse took out of circulation, and the object that carried it. */
interface AbsorbedTag {
  readonly objectId: number;
  readonly tag: string;
}

/** One draft asset, before duplicate status and ids are decided. */
interface AssetDraft {
  readonly object: ModelObject;
  readonly objectIds: readonly number[];
  readonly canonicalTag: string;
  /** Absorbed components that carried a tag of their own, in `objectIds` order. */
  readonly absorbedTagged: ReadonlyArray<AbsorbedTag>;
}

/**
 * Builds the model-first asset universe.
 *
 * Filters run in the order PRODUCT.md §6.6 lists them and `FILTER_STAGES`
 * fixes: source models, classes, selection sets, tag presence, tag patterns.
 * That order is observable -- `impact.candidatesAfterEachFilter` reports what
 * each stage removed -- so it is part of the contract, not an implementation
 * detail.
 *
 * @throws AssetCatalogConfigError when `filters.selectionSetNames` names a set
 * the cache does not contain.
 */
export function buildAssetCatalog(
  cache: ExtractionCache,
  mappings: PropertyMappings,
  filters: AssetFilterConfig,
): AssetCatalog {
  const objects = new Map<number, ModelObject>();
  const ordered: ModelObject[] = [];
  for (const object of cache.allObjects()) {
    objects.set(object.id, object);
    ordered.push(object);
  }

  const fileNames = sourceModelFileNames(cache);
  const inputFileName = cache.meta().inputFileName;
  const sourceFileOf = (objectId: number): string => {
    const sourceModelId = objects.get(objectId)?.sourceModelId ?? null;
    const fileName = sourceModelId === null ? null : (fileNames.get(sourceModelId) ?? null);
    // A cache whose source models have no file names still has to name a
    // document; the extracted file is the honest fallback.
    return fileName ?? inputFileName;
  };

  const stages: FilterStageImpact[] = [];
  const record = (stage: FilterStageName, inCount: number, outCount: number): void => {
    stages.push({ stage, inCount, droppedCount: inCount - outCount });
  };

  // --- stage 1: source model files -------------------------------------------
  let survivors: readonly ModelObject[] = ordered;
  const includedFiles = filters.includedSourceModelFiles ?? [];
  if (includedFiles.length > 0) {
    const wantedFiles = new Set(includedFiles);
    const next = survivors.filter((object) => {
      if (object.sourceModelId === null) {
        // Nothing to match on: an object the cache does not attribute to a
        // source model cannot satisfy a source-model include.
        return false;
      }
      const fileName = fileNames.get(object.sourceModelId) ?? null;
      return fileName !== null && wantedFiles.has(fileName);
    });
    record(FILTER_STAGES[0], survivors.length, next.length);
    survivors = next;
  } else {
    record(FILTER_STAGES[0], survivors.length, survivors.length);
  }

  // --- stage 2: classes (an exclusion always wins) ---------------------------
  const includedClasses = new Set(filters.includedClasses ?? []);
  const excludedClasses = new Set(filters.excludedClasses ?? []);
  if (includedClasses.size > 0 || excludedClasses.size > 0) {
    const next = survivors.filter((object) => {
      const className = object.className;
      if (className !== null && excludedClasses.has(className)) {
        return false;
      }
      if (includedClasses.size === 0) {
        return true;
      }
      // A class restriction cannot be satisfied by an object with no class.
      return className !== null && includedClasses.has(className);
    });
    record(FILTER_STAGES[1], survivors.length, next.length);
    survivors = next;
  } else {
    record(FILTER_STAGES[1], survivors.length, survivors.length);
  }

  // --- stage 3: selection sets ------------------------------------------------
  const setNames = filters.selectionSetNames ?? [];
  if (setNames.length > 0) {
    const members = selectionSetMembers(cache, setNames);
    const next = survivors.filter((object) => members.has(object.id));
    record(FILTER_STAGES[2], survivors.length, next.length);
    survivors = next;
  } else {
    record(FILTER_STAGES[2], survivors.length, survivors.length);
  }

  // Properties are read only for what survived the structural filters, which
  // is what keeps a 131k-object model from becoming 131k property reads.
  const refs = new Map<string, PropertyRef>();
  const addRef = (ref: PropertyRef | undefined): void => {
    if (ref !== undefined) {
      refs.set(propertyKey(ref), ref);
    }
  };
  addRef(mappings.equipmentTag);
  addRef(mappings.description);
  addRef(mappings.equipmentType);
  addRef(mappings.building);
  addRef(mappings.nativeDiscipline);
  addRef(mappings.wbs);
  addRef(mappings.itemMaster);
  addRef(mappings.equipmentClassification);
  const values = readMappedValues(cache, refs, new Set(survivors.map((object) => object.id)));

  const tagKey = propertyKey(mappings.equipmentTag);
  const tagOf = (objectId: number): string | null => values.get(objectId)?.get(tagKey) ?? null;

  // --- stage 4: tag presence --------------------------------------------------
  let untaggedDroppedCount = 0;
  if (filters.requireTagProperty) {
    const next = survivors.filter((object) => tagOf(object.id) !== null);
    untaggedDroppedCount = survivors.length - next.length;
    record(FILTER_STAGES[3], survivors.length, next.length);
    survivors = next;
  } else {
    record(FILTER_STAGES[3], survivors.length, survivors.length);
  }

  // --- stage 5: accepted tag patterns -----------------------------------------
  const patterns = filters.acceptedTagPatterns ?? [];
  if (patterns.length > 0) {
    const next = survivors.filter((object) => {
      const tag = tagOf(object.id);
      // An untagged object only reaches here with `requireTagProperty: false`.
      // Patterns describe tag shapes and have nothing to say about an object
      // with no tag; judging it here would collapse the two settings into one.
      return tag === null || isTagAccepted(tag, patterns);
    });
    record(FILTER_STAGES[4], survivors.length, next.length);
    survivors = next;
  } else {
    record(FILTER_STAGES[4], survivors.length, survivors.length);
  }

  // --- component collapse ------------------------------------------------------
  const candidates = survivors;
  const candidateIds = new Set(candidates.map((object) => object.id));
  const owners = filters.collapseComponents
    ? resolveOwners(
        candidates,
        candidateIds,
        objects,
        new Set(filters.separatelyCommissionableClasses ?? []),
      )
    : new Map<number, number>();

  const absorbed = new Map<number, number[]>();
  const representatives: ModelObject[] = [];
  let collapsedCount = 0;
  for (const candidate of candidates) {
    const ownerId = owners.get(candidate.id) ?? candidate.id;
    if (ownerId === candidate.id) {
      representatives.push(candidate);
      continue;
    }
    collapsedCount += 1;
    const bucket = absorbed.get(ownerId);
    if (bucket === undefined) {
      absorbed.set(ownerId, [candidate.id]);
    } else {
      bucket.push(candidate.id);
    }
  }

  // --- assets -------------------------------------------------------------------
  const drafts: readonly AssetDraft[] = representatives.map((object) => {
    const absorbedIds = [...(absorbed.get(object.id) ?? [])].sort((left, right) => left - right);
    // The tag names the asset, and an absorbed component is a part of the
    // asset rather than the asset itself: its tag never renames the whole.
    const canonicalTag = tagOf(object.id) ?? '';
    return {
      object,
      objectIds: [object.id, ...absorbedIds],
      canonicalTag,
      // Tags collapse took out of circulation: they named a component and now
      // name nothing. A component repeating its owner's own tag is not one of
      // them -- that spelling still reaches this asset, at the exact tier.
      absorbedTagged: absorbedIds
        .map((objectId) => ({ objectId, tag: tagOf(objectId) ?? '' }))
        .filter((entry) => entry.tag.length > 0 && entry.tag !== canonicalTag),
    };
  });

  const tagCounts = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.canonicalTag.length > 0) {
      tagCounts.set(draft.canonicalTag, (tagCounts.get(draft.canonicalTag) ?? 0) + 1);
    }
  }

  const optionalFields: ReadonlyArray<readonly [OptionalField, PropertyRef | undefined]> = [
    ['description', mappings.description],
    ['equipmentType', mappings.equipmentType],
    ['building', mappings.building],
    ['nativeDiscipline', mappings.nativeDiscipline],
    ['wbs', mappings.wbs],
    ['itemMaster', mappings.itemMaster],
    ['equipmentClassification', mappings.equipmentClassification],
  ];

  const assets: readonly ModelAsset[] = drafts.map((draft) => {
    const { object, objectIds, canonicalTag } = draft;
    const isDuplicate = (tagCounts.get(canonicalTag) ?? 0) > 1;
    const status: ModelAssetStatus = isDuplicate ? 'DUPLICATE_MODEL_TAG' : 'MODEL_CONFIRMED';

    // Untagged is only reachable with `requireTagProperty: false`; the cache
    // ordinal is the only content-derived identity such an object has.
    const escapedTag = escapeTagForId(canonicalTag);
    const assetId =
      canonicalTag.length === 0
        ? `object:${object.id}`
        : isDuplicate
          ? `tag:${escapedTag}#${object.id}`
          : `tag:${escapedTag}`;

    const fields: OptionalFieldValues = {};
    const provenance: MutableAssetProvenance = {};

    if (canonicalTag.length > 0) {
      provenance.canonicalTag = provenanceOf(
        { value: canonicalTag, objectId: object.id },
        mappings.equipmentTag,
        'equipmentTag',
        sourceFileOf,
      );
    }
    for (const [field, ref] of optionalFields) {
      if (ref === undefined) {
        continue;
      }
      const read = readField(objectIds, ref, values);
      if (read === null) {
        // Never invented: an unmapped or absent property leaves the field off
        // the asset entirely rather than defaulting it.
        continue;
      }
      fields[field] = read.value;
      provenance[field] = provenanceOf(read, ref, field, sourceFileOf);
    }

    const asset: ModelAsset = {
      assetId,
      canonicalTag,
      ...fields,
      status,
      objectIds,
      absorbedTags: draft.absorbedTagged.map((entry) => entry.tag),
      sourceModelId: object.sourceModelId,
      provenance,
    };
    return asset;
  });

  const duplicateObjectIds = new Map<string, number[]>();
  for (const draft of drafts) {
    if ((tagCounts.get(draft.canonicalTag) ?? 0) > 1) {
      const bucket = duplicateObjectIds.get(draft.canonicalTag);
      if (bucket === undefined) {
        duplicateObjectIds.set(draft.canonicalTag, [draft.object.id]);
      } else {
        bucket.push(draft.object.id);
      }
    }
  }

  // Sorted by tag so two runs list the same review items in the same order.
  const duplicateItems: readonly DuplicateModelTagReviewItem[] = [...duplicateObjectIds.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([canonicalTag, objectIds]): DuplicateModelTagReviewItem => ({
        kind: 'duplicate-model-tag',
        canonicalTag,
        objectIds,
      }),
    );

  // Collapse removed these tags from circulation. Left unsaid, evidence
  // spelled with one of them would quietly suffix-match the absorbing asset,
  // which is a decision only the site can make (or unmake, by listing the
  // class as separately commissionable).
  //
  // Also sorted by tag, then by object, so the order is a property of the
  // model rather than of the walk.
  const absorbedItems = drafts
    .flatMap((draft, position) =>
      draft.absorbedTagged.map((entry) => ({
        kind: 'absorbed-tagged-component' as const,
        absorbedTag: entry.tag,
        absorbingAssetId: assets[position]?.assetId ?? '',
        objectId: entry.objectId,
      })),
    )
    .sort((left, right) => {
      if (left.absorbedTag !== right.absorbedTag) {
        return left.absorbedTag < right.absorbedTag ? -1 : 1;
      }
      return left.objectId - right.objectId;
    });

  const reviewItems: readonly ReviewItem[] = [...duplicateItems, ...absorbedItems];

  const impact: InclusionImpact = {
    totalObjects: cache.objectCount(),
    candidatesAfterEachFilter: stages,
    collapsedCount,
    finalAssetCount: assets.length,
    duplicateTagCount: duplicateItems.length,
    untaggedDroppedCount,
  };

  return { assets, reviewItems, impact };
}

function provenanceOf(
  read: FieldRead,
  ref: PropertyRef,
  field: MappedField,
  sourceFileOf: (objectId: number) => string,
): AssetFieldProvenance {
  return {
    sourceFile: sourceFileOf(read.objectId),
    sourceRef: { kind: 'model-object', objectId: String(read.objectId) },
    propertyOrColumn: `${ref.category} > ${ref.name}`,
    rule: `asset-catalog:${field}`,
    property: ref,
    objectId: read.objectId,
  };
}
