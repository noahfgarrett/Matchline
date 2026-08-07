/** Every way one asset can be related to another. */
export type RelationshipType =
  | 'POWERS'
  | 'WIRED_TO'
  | 'CONTROLS'
  | 'SERVES'
  | 'EXPLICIT_PARENT'
  | 'FAMILY_RELATED'
  | 'STRUCTURAL_PARENT_CANDIDATE'
  | 'DEPENDENCY';

/** Every `RelationshipType`, for callers that need to walk the union at runtime. */
export const RELATIONSHIP_TYPES = [
  'POWERS',
  'WIRED_TO',
  'CONTROLS',
  'SERVES',
  'EXPLICIT_PARENT',
  'FAMILY_RELATED',
  'STRUCTURAL_PARENT_CANDIDATE',
  'DEPENDENCY',
] as const satisfies ReadonlyArray<RelationshipType>;

/**
 * Compile-time completeness guard. Adding a member to `RelationshipType`
 * without adding it to `RELATIONSHIP_TYPES` resolves this to `false` and the
 * assignment below stops compiling.
 */
type EveryRelationshipTypeListed =
  Exclude<RelationshipType, (typeof RELATIONSHIP_TYPES)[number]> extends never ? true : false;

const RELATIONSHIP_TYPES_ARE_COMPLETE: EveryRelationshipTypeListed = true;
void RELATIONSHIP_TYPES_ARE_COMPLETE;

/**
 * What a relationship is allowed to do to the register.
 *
 * `structural-parent` relations can nest one asset under another in the
 * hierarchy. `dependency` relations only order work; they never re-parent.
 * Keeping these apart is what stops a control signal from rewriting the
 * physical tree.
 */
export type RelationshipKind = 'structural-parent' | 'dependency';

/**
 * Narrow to `never` in the default branch of a switch so that adding a case to
 * a union turns every unhandled switch into a compile error.
 */
export function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

/** Which relationships may nest, and which may only sequence. */
export function relationshipKindOf(type: RelationshipType): RelationshipKind {
  switch (type) {
    case 'POWERS':
    case 'WIRED_TO':
    case 'EXPLICIT_PARENT':
    case 'FAMILY_RELATED':
    case 'STRUCTURAL_PARENT_CANDIDATE':
      return 'structural-parent';
    case 'CONTROLS':
    case 'SERVES':
    case 'DEPENDENCY':
      return 'dependency';
    default:
      return assertNever(type, 'unhandled RelationshipType');
  }
}
