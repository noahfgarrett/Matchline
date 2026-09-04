/**
 * One rung of a resolution chain (PRODUCT.md §5.2).
 *
 * Every rung is a pure `(component, subject, context) -> value | nothing`.
 * A rung never sees the rungs after it, and only sees the rungs before it
 * through `joinKey`, which is what makes chain order the whole of the
 * precedence story.
 */
import { assertNever, type Provenance, type SourceKind, type SourceRef } from '@matchline/domain';
import type { SystemComponentConfig } from '@matchline/domain';
import type { AnatomyResult } from '@matchline/tag-anatomy';

import { expandComposite } from './composite.js';
import type { MelRowIndex, MelTagIndex, SystemJoinIndex } from './join.js';
import { COMPONENT_EVIDENCE_TIER } from './tiers.js';
import type {
  ChainName,
  ManualAssignment,
  MelCatalogRow,
  ResolverSubject,
  RungYield,
  SkipReason,
  SystemCatalog,
  SystemComponentKind,
} from './types.js';

/** Provenance needs a document name; an empty one means the caller stated none. */
export const UNSTATED_SOURCE_FILE = '';

/** Sheet rows are 1-based, so 0 means the importer recorded no row number. */
export const UNSTATED_ROW = 0;

export type RungOutcome =
  | ({ readonly ok: true } & RungYield)
  | { readonly ok: false; readonly reason: SkipReason; readonly detail: string };

/** Everything a rung may consult. Assembled once per subject. */
export interface RungContext {
  readonly subject: ResolverSubject;
  /** `applyAnatomy` run once for the subject, or null when none is configured. */
  readonly anatomy: AnatomyResult | null;
  readonly catalog: SystemCatalog | undefined;
  readonly melRows: ReadonlyArray<MelCatalogRow> | undefined;
  readonly manual: ManualAssignment | undefined;
  /**
   * The key a `mel-lookup` on systemKey joins against.
   *
   * In the key chain this is the first value produced by an EARLIER rung --
   * a chain cannot join on a key it has not resolved yet, so a `mel-lookup`
   * by systemKey placed first in the chain always yields nothing. In the
   * description chain it is the already-resolved system key (PRODUCT.md §5.3:
   * "MEL lookup by resolved System Key").
   */
  readonly joinKey: string | null;
  /**
   * The MEL's own keys, normalized the same way `joinKey` was.
   *
   * `joinKey` is post-normalization and the catalog is raw-keyed, so comparing
   * them directly would make a padded `001` unable to find the MEL's `1` --
   * or, worse, find a different system that happens to be spelled `001`.
   */
  readonly joinIndex: SystemJoinIndex;
  /**
   * The MEL rows addressed by the key they state.
   *
   * A key join has to name the row its value came from, and finding that row by
   * scanning `melRows` is a sweep of the whole MEL per subject -- the cost of it
   * grows with the model and the MEL together. The index answers the same
   * question in one lookup.
   */
  readonly melRowIndex: MelRowIndex;
  /**
   * The MEL rows addressed by the equipment tag they state.
   *
   * The other half of the same problem: a tag join used to read every MEL row
   * for every subject, so the work grew with the model and the MEL multiplied
   * together. Built once per compile, and keyed on the tag exactly as written,
   * so the answer is the row the scan would have found.
   */
  readonly melTagIndex: MelTagIndex;
}

/** Which source vocabulary a rung's claim belongs to. */
export function sourceKindOf(kind: SystemComponentKind): SourceKind {
  switch (kind) {
    case 'model-field':
    case 'direct-column':
    case 'tag-segment':
    case 'composite':
      return 'MODEL';
    case 'mel-lookup':
      return 'MEL';
    case 'manual':
      return 'MANUAL';
    default:
      return assertNever(kind, 'unhandled SystemComponentKind');
  }
}

/** Stable identifier of the profile rule that produced a claim. */
export function ruleIdOf(chain: ChainName, rungIndex: number, kind: SystemComponentKind): string {
  return `systemResolver.${chain}[${rungIndex}].${kind}`;
}

function modelRef(subject: ResolverSubject): SourceRef {
  return { kind: 'model-object', objectId: subject.objectId ?? subject.assetId };
}

function rowRef(row: MelCatalogRow | undefined): SourceRef {
  return { kind: 'sheet-row', sheet: row?.sheet ?? '', row: row?.row ?? UNSTATED_ROW };
}

function skip(reason: SkipReason, detail: string): RungOutcome {
  return { ok: false, reason, detail };
}

/** Reads one property, trimmed. Whitespace is never part of an identifier. */
function readProperty(
  subject: ResolverSubject,
  category: string,
  name: string,
): { readonly found: boolean; readonly value: string } {
  const raw = subject.properties.get(category)?.get(name);
  if (raw === undefined) {
    return { found: false, value: '' };
  }
  return { found: true, value: raw.trim() };
}

function evaluateProperty(
  component: Extract<SystemComponentConfig, { kind: 'model-field' | 'direct-column' }>,
  context: RungContext,
  provenanceBase: Omit<Provenance, 'sourceFile' | 'sourceRef' | 'propertyOrColumn'>,
): RungOutcome {
  const { category, name } = component.property;
  const label = `${category} > ${name}`;
  const read = readProperty(context.subject, category, name);
  if (!read.found) {
    return skip('no-value', `${label} is not on ${context.subject.assetId}`);
  }
  if (read.value.length === 0) {
    return skip('blank-value', `${label} is blank on ${context.subject.assetId}`);
  }
  return {
    ok: true,
    rawValue: read.value,
    evidenceTier: COMPONENT_EVIDENCE_TIER[component.kind],
    provenance: {
      sourceFile: context.subject.sourceFile ?? UNSTATED_SOURCE_FILE,
      sourceRef: modelRef(context.subject),
      propertyOrColumn: label,
      ...provenanceBase,
    },
  };
}

function evaluateMelLookup(
  component: Extract<SystemComponentConfig, { kind: 'mel-lookup' }>,
  context: RungContext,
  provenanceBase: Omit<Provenance, 'sourceFile' | 'sourceRef' | 'propertyOrColumn'>,
): RungOutcome {
  const field = component.returnField;
  const label = field === 'systemKey' ? 'System Key' : 'System Description';

  const yieldFrom = (value: string, row: MelCatalogRow | undefined): RungOutcome => ({
    ok: true,
    rawValue: value,
    evidenceTier: COMPONENT_EVIDENCE_TIER['mel-lookup'],
    provenance: {
      sourceFile: row?.sourceFile ?? UNSTATED_SOURCE_FILE,
      sourceRef: rowRef(row),
      propertyOrColumn: label,
      ...provenanceBase,
    },
  });

  if (component.joinBy === 'equipmentTag') {
    if (context.melRows === undefined) {
      return skip('not-configured', 'a tag join needs MEL rows and none were supplied');
    }
    // First row that both matches the tag and actually states the field. The
    // tag comparison is exact: the canonical tag was canonicalized upstream,
    // and a tag that only matches after fuzzing is a data problem to surface.
    // The index holds those rows in workbook order, so this is the row the
    // scan it replaces would have stopped on.
    for (const row of context.melTagIndex.get(context.subject.canonicalTag) ?? []) {
      const value = (field === 'systemKey' ? row.systemKey : row.systemDescription)?.trim() ?? '';
      if (value.length > 0) {
        return yieldFrom(value, row);
      }
    }
    return skip('no-value', `no MEL row states ${label} for tag ${context.subject.canonicalTag}`);
  }

  const { joinKey } = context;
  if (joinKey === null || joinKey.length === 0) {
    return skip('no-join-key', 'no earlier rung resolved a system key to join on');
  }
  if (context.catalog === undefined && context.melRows === undefined) {
    return skip('not-configured', 'a key join needs a system catalog or MEL rows');
  }

  // Both sides of the join go through the profile's normalization, so a padded
  // `001` reaches the MEL's `1` and only the profile's own steps decide it.
  const spellings = context.joinIndex.get(joinKey) ?? [];
  if (spellings.length > 1) {
    // Two systems the MEL states separately, made indistinguishable by the
    // profile's steps. Guessing between them would attach one system's
    // description to the other's assets.
    return skip(
      'ambiguous-join',
      `system ${joinKey} matches ${spellings.length} MEL keys after normalization (${spellings.join(', ')})`,
    );
  }
  const melKey = spellings[0];
  if (melKey === undefined) {
    return skip('no-value', `the MEL states no ${label} for system ${joinKey}`);
  }

  // The catalog is the authority on what the MEL says about a key; the rows are
  // consulted only to recover a row address for provenance. Both are first-seen
  // ordered, so they cannot disagree about the value.
  //
  // A systemKey lookup returns the MEL's own spelling, not the joined key: the
  // claim then records what the MEL actually wrote and the transform trail
  // shows how it became the resolved key (§5.5).
  const group = context.melRowIndex.get(melKey);
  let value = '';
  if (context.catalog !== undefined) {
    const entry = context.catalog.get(melKey);
    if (entry !== undefined) {
      value = field === 'systemKey' ? melKey : (entry.description ?? '');
    }
  } else if (group !== undefined) {
    value = field === 'systemKey' ? melKey : group.firstStatedDescription;
  }

  if (value.length === 0) {
    return skip('no-value', `the MEL states no ${label} for system ${joinKey}`);
  }

  // The row that said it: for a key lookup the first row stating the key at all,
  // for a description lookup the first row stating the key AND this description.
  // A catalog description the rows only state with surrounding whitespace misses
  // here, exactly as comparing it against a trimmed row always did.
  const backingRow = field === 'systemKey' ? group?.firstRow : group?.rowByDescription.get(value);
  return yieldFrom(value, backingRow);
}

/** Evaluates one rung. Returns the value it yielded, or why it yielded none. */
export function evaluateComponent(
  component: SystemComponentConfig,
  chain: ChainName,
  rungIndex: number,
  context: RungContext,
): RungOutcome {
  const provenanceBase = {
    rule: ruleIdOf(chain, rungIndex, component.kind),
    // Provenance counts rungs from 1, most direct first.
    fallbackRung: rungIndex + 1,
  } as const;

  switch (component.kind) {
    case 'model-field':
    case 'direct-column':
      return evaluateProperty(component, context, provenanceBase);

    case 'tag-segment': {
      if (context.anatomy === null) {
        return skip('not-configured', 'no tag anatomy is configured for this site');
      }
      if (!context.anatomy.matched) {
        return skip('no-value', context.anatomy.detail);
      }
      const value = context.anatomy.segments[component.segment]?.trim() ?? '';
      if (value.length === 0) {
        return skip('no-value', `the anatomy extracts no "${component.segment}" segment`);
      }
      return {
        ok: true,
        rawValue: value,
        evidenceTier: COMPONENT_EVIDENCE_TIER['tag-segment'],
        provenance: {
          sourceFile: context.subject.sourceFile ?? UNSTATED_SOURCE_FILE,
          sourceRef: modelRef(context.subject),
          propertyOrColumn: `tag segment "${component.segment}"`,
          ...provenanceBase,
        },
      };
    }

    case 'mel-lookup':
      return evaluateMelLookup(component, context, provenanceBase);

    case 'composite': {
      const expanded = expandComposite(component.template, context.subject, context.anatomy);
      if (!expanded.ok) {
        return skip(expanded.reason, expanded.detail);
      }
      return {
        ok: true,
        rawValue: expanded.value,
        evidenceTier: expanded.evidenceTier,
        provenance: {
          sourceFile: context.subject.sourceFile ?? UNSTATED_SOURCE_FILE,
          sourceRef: modelRef(context.subject),
          propertyOrColumn: `composite ${component.template}`,
          ...provenanceBase,
        },
      };
    }

    case 'manual': {
      if (context.manual === undefined) {
        return skip('no-value', `no manual assignment for ${context.subject.assetId}`);
      }
      const raw = chain === 'keyChain' ? context.manual.systemKey : context.manual.systemDescription;
      const value = raw?.trim() ?? '';
      if (value.length === 0) {
        return skip('no-value', `the manual assignment for ${context.subject.assetId} is empty`);
      }
      const { note } = context.manual;
      return {
        ok: true,
        rawValue: value,
        evidenceTier: COMPONENT_EVIDENCE_TIER.manual,
        provenance: {
          sourceFile: context.subject.sourceFile ?? UNSTATED_SOURCE_FILE,
          sourceRef: modelRef(context.subject),
          ...provenanceBase,
          ...(note === undefined ? {} : { manualDecision: note }),
        },
      };
    }

    default:
      return assertNever(component, 'unhandled SystemComponentConfig');
  }
}
