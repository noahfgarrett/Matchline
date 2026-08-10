/**
 * Total orders for every list the compiler emits.
 *
 * Determinism is a locked invariant (ENGINE.md binding rule 3): the same inputs
 * and the same profile must produce an identical snapshot, whatever order the
 * caller happened to hand the subjects and claims over in. Sorting by content
 * rather than by arrival is what buys that, and it is also what makes "keep the
 * lowest" a defined rule when two claims say the same thing.
 */
import { assertNever } from '@matchline/domain';
import type {
  AttributeValue,
  LadderSourceKind,
  ParentLadderConfig,
  ResolvedDependency,
  ReviewItem,
  SourceRef,
  SsmRelationshipClaim,
} from '@matchline/domain';

/**
 * The boundary between the fields of a review key: U+241F SYMBOL FOR UNIT
 * SEPARATOR, written as a code point so nothing invisible sits in this file.
 *
 * Printable on purpose. A review key is not only sorted and deduped in memory:
 * the desktop app stores it in `decisions.review_key` and uses it as the React
 * key of a review row. `node:sqlite` truncates a bound string at the first NUL,
 * so a NUL-joined `system-conflict<NUL>tag:MAH001-10-01<NUL>2` would be
 * *stored* as `system-conflict`, and one decision would decide every system
 * conflict in the project. A C0 control byte fails one layer up for the same
 * kind of reason: an HTML attribute cannot carry one.
 */
const KEY_SEPARATOR = String.fromCodePoint(0x241f);

/** The boundary between the members of a list-valued field. */
const LIST_SEPARATOR = ',';

/**
 * One field of a key, with every structural character escaped.
 *
 * This is what keeps the mapping injective now that the separator is a
 * character a spreadsheet could in principle contain. `%` is escaped first, so
 * a literal `%1F` in a tag encodes as `%251F` and can never be read back as an
 * escaped separator; two items whose fields differ only in where a boundary
 * falls therefore still produce two keys, rather than colliding onto one and
 * silently deduping each other away.
 */
function field(value: string): string {
  return value
    .replaceAll('%', '%25')
    .replaceAll(KEY_SEPARATOR, '%1F')
    .replaceAll(LIST_SEPARATOR, '%2C');
}

/** A list-valued field: every member escaped, then joined. */
function fieldList(values: readonly string[]): string {
  return values.map(field).join(LIST_SEPARATOR);
}

/**
 * One proposed attribute value as a key field.
 *
 * Type-tagged before escaping, because a claim's value is not always a string:
 * without the tag the number `1`, the string `'1'` and the boolean-shaped
 * `'true'` would all flatten onto the same field, and two conflicts a person
 * would settle differently would share a key. `null` is its own tag rather than
 * `string:null`, so a site whose spreadsheet literally says "null" is still a
 * different conflict from one that said nothing.
 */
function valueField(value: AttributeValue): string {
  return value === null ? field('null') : field(`${typeof value}:${String(value)}`);
}

/** Numbers carry no structural character, so they join without escaping. */
function numberList(values: readonly number[]): string {
  return values.map(String).join(LIST_SEPARATOR);
}

/**
 * One `(sourceId, objectIds)` pair of a duplicate-tag item.
 *
 * `:` is escaped on top of the three characters {@link field} handles, so the
 * boundary between the source and its ordinals is the one colon the pair
 * contains however many a site writes into a source id. `field` escapes `%`
 * first, so a literal `%3A` in a source id leaves as `%253A` and can never be
 * read back as the escape this adds.
 */
function sourceObjectField(sourceId: string, objectIds: readonly number[]): string {
  return `${field(sourceId).replaceAll(':', '%3A')}:${numberList(objectIds)}`;
}

/**
 * Joins already-escaped fields onto the item kind.
 *
 * The kind is a literal from a closed set, none of which holds a structural
 * character, so it is the one field that needs no escaping.
 */
function composeKey(kind: ReviewItem['kind'], ...fields: readonly string[]): string {
  return [kind, ...fields].join(KEY_SEPARATOR);
}

/** UTF-16 code-unit order, so ordering never depends on a locale. */
export function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** Absent sorts before present: "nothing was said" is the lower value. */
function compareOptionalText(left: string | undefined, right: string | undefined): number {
  if (left === undefined) {
    return right === undefined ? 0 : -1;
  }
  if (right === undefined) {
    return 1;
  }
  return compareText(left, right);
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (left === undefined) {
    return right === undefined ? 0 : -1;
  }
  if (right === undefined) {
    return 1;
  }
  return left - right;
}

/** Sheet rows by (sheet, row); model objects by object id; kinds by name. */
function compareSourceRef(left: SourceRef, right: SourceRef): number {
  if (left.kind !== right.kind) {
    return compareText(left.kind, right.kind);
  }
  if (left.kind === 'sheet-row' && right.kind === 'sheet-row') {
    const bySheet = compareText(left.sheet, right.sheet);
    return bySheet !== 0 ? bySheet : left.row - right.row;
  }
  if (left.kind === 'model-object' && right.kind === 'model-object') {
    return compareText(left.objectId, right.objectId);
  }
  return 0;
}

/** Where a fact came from, as an ordering: file, then address inside it. */
function compareProvenance(
  left: SsmRelationshipClaim['provenance'],
  right: SsmRelationshipClaim['provenance'],
): number {
  const byFile = compareText(left.sourceFile, right.sourceFile);
  if (byFile !== 0) {
    return byFile;
  }
  const byRef = compareSourceRef(left.sourceRef, right.sourceRef);
  if (byRef !== 0) {
    return byRef;
  }
  const byColumn = compareOptionalText(left.propertyOrColumn, right.propertyOrColumn);
  if (byColumn !== 0) {
    return byColumn;
  }
  const byRule = compareOptionalText(left.rule, right.rule);
  if (byRule !== 0) {
    return byRule;
  }
  const byDecision = compareOptionalText(left.manualDecision, right.manualDecision);
  if (byDecision !== 0) {
    return byDecision;
  }
  return compareOptionalNumber(left.fallbackRung, right.fallbackRung);
}

/**
 * A rung's position in the configured ladder, or one past the end when the site
 * disabled it.
 *
 * A disabled rung sorting last is the honest answer: its claims can never win,
 * so they belong at the bottom of a losing-claims list.
 */
export function tierIndex(ladder: ParentLadderConfig, source: LadderSourceKind): number {
  const index = ladder.tiers.indexOf(source);
  return index === -1 ? ladder.tiers.length : index;
}

/**
 * Claims by child, then by configured ladder rung, then by proposed parent.
 *
 * The rung comes second because within one asset the ladder wants them
 * strongest first; the trailing comparisons exist so two claims that differ only
 * in where they were read still have a defined order.
 */
export function compareClaims(
  ladder: ParentLadderConfig,
  left: SsmRelationshipClaim,
  right: SsmRelationshipClaim,
): number {
  const bySubject = compareText(left.subjectAssetId, right.subjectAssetId);
  if (bySubject !== 0) {
    return bySubject;
  }
  const byRung = tierIndex(ladder, left.ladderSource) - tierIndex(ladder, right.ladderSource);
  if (byRung !== 0) {
    return byRung;
  }
  const bySource = compareText(left.ladderSource, right.ladderSource);
  if (bySource !== 0) {
    return bySource;
  }
  const byTarget = compareText(left.targetAssetId, right.targetAssetId);
  if (byTarget !== 0) {
    return byTarget;
  }
  const byType = compareText(left.relationshipType, right.relationshipType);
  if (byType !== 0) {
    return byType;
  }
  const byProvenance = compareProvenance(left.provenance, right.provenance);
  return byProvenance !== 0 ? byProvenance : compareText(left.rule, right.rule);
}

/** Dependencies by upstream asset, then by what the relation is. */
export function compareDependencies(left: ResolvedDependency, right: ResolvedDependency): number {
  const byParent = compareText(left.parentAssetId, right.parentAssetId);
  if (byParent !== 0) {
    return byParent;
  }
  const byType = compareText(left.relationshipType, right.relationshipType);
  return byType !== 0 ? byType : compareProvenance(left.provenance, right.provenance);
}

/**
 * One review item flattened to a sortable, dedupable, storable string.
 *
 * Every field is escaped and every boundary is one of the two separators above,
 * which is what makes the flattening reversible in principle and collision-free
 * in practice. Two shapes carry a third character, `:`. A `fuzzy-identity`
 * candidate is `<assetId>:<distance>`, and since the distance is a trailing
 * integer the last `:` is the boundary however many colons the asset id itself
 * contains. A `duplicate-model-tag` source is `<sourceId>:<objectIds>` with the
 * colon escaped out of the source id (see {@link sourceObjectField}), because
 * an object list is not a single trailing integer.
 *
 * No `default` branch on purpose: adding a member to `ReviewItem` without adding
 * a case here stops this function compiling, so a new review kind can never
 * silently land in an arbitrary position.
 */
export function reviewKey(item: ReviewItem): string {
  switch (item.kind) {
    case 'system-conflict':
      // The values, not just how many of them there were. A key of
      // (asset, count) makes "001 or 002?" and "007 or 008?" the same key, and
      // the desktop app records decisions against that key -- so a re-compile
      // with different evidence would inherit a decision nobody made about it.
      // Sorted, so the key does not depend on which rung raised its claim
      // first; duplicates kept, because two rungs agreeing on a value is a
      // different conflict from two rungs each naming their own.
      return composeKey(
        item.kind,
        field(item.assetId),
        item.claims
          .map((claim) => valueField(claim.proposedValue))
          .sort(compareText)
          .join(LIST_SEPARATOR),
      );
    case 'duplicate-model-tag':
      // The SOURCES, not the bare ordinals. An object id is an extraction
      // ordinal within one source (P0-1's `ModelObjectKey`), so two sources that
      // each carry an object 3 flatten onto the same key: one project's
      // "MAH001-10-01 on mechanical rev A and rev B" and another's
      // "MAH001-10-01 twice inside one file" would be one decision, and the
      // desktop records decisions against this key.
      //
      // A record written before the universe existed carries no `sources` and
      // is keyed the way it was written -- an absent field is not "one source",
      // and rekeying old items would orphan every decision taken on them.
      return item.sources === undefined
        ? composeKey(item.kind, field(item.canonicalTag), numberList(item.objectIds))
        : composeKey(
            item.kind,
            field(item.canonicalTag),
            item.sources
              .map((source) => sourceObjectField(source.sourceId, source.objectIds))
              .join(LIST_SEPARATOR),
          );
    case 'system-catalog-conflict':
      return composeKey(item.kind, field(item.systemKey), fieldList(item.descriptions));
    case 'fuzzy-identity':
      return composeKey(
        item.kind,
        field(item.evidenceTag),
        item.candidates
          .map((candidate) => `${field(candidate.assetId)}:${String(candidate.distance)}`)
          .join(LIST_SEPARATOR),
      );
    case 'ambiguous-suffix':
      return composeKey(item.kind, field(item.evidenceTag), fieldList(item.candidateAssetIds));
    case 'ambiguous-parent':
      return composeKey(
        item.kind,
        field(item.assetId),
        field(item.ladderSource),
        fieldList(item.candidateParentIds),
      );
    case 'structural-cycle':
      return composeKey(item.kind, fieldList(item.assetIds));
    case 'missing-boundary':
      return composeKey(item.kind, field(item.assetId), field(item.levelId));
    case 'nesting-proposal':
      return composeKey(
        item.kind,
        field(item.assetId),
        field(item.proposedParentId),
        field(item.ruleDetail),
        String(item.confidence),
      );
    case 'dead-claim-rule':
      // Content-complete: the rung, the reason and both spellings. A profile
      // that names two dead parents for one child is two dead rules, and a rule
      // dead for a different reason is a different thing to fix.
      return composeKey(
        item.kind,
        field(item.ladderSource),
        field(item.reason),
        field(item.childRef),
        field(item.parentRef),
      );
    case 'unresolvable-alias':
      return composeKey(item.kind, field(item.evidenceTag), field(item.aliasTarget));
    case 'absorbed-tagged-component':
      return composeKey(
        item.kind,
        field(item.absorbedTag),
        field(item.absorbingAssetId),
        String(item.objectId),
      );
    case 'orphaned-decision':
      // Both spellings and the reason, but not the note: the note is what the
      // person wrote, and two people writing different notes about the same
      // unresolvable pair are still one decision to re-aim.
      return composeKey(
        item.kind,
        field(item.decision),
        field(item.reason),
        field(item.childRef),
        field(item.parentRef),
      );
  }
  return assertNever(item, 'unhandled ReviewItem');
}

/** Review items by kind, then by their content. Stable across shuffled inputs. */
export function compareReviewItems(left: ReviewItem, right: ReviewItem): number {
  return compareText(reviewKey(left), reviewKey(right));
}
