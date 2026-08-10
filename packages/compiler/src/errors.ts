/**
 * Ways a project's derived-attribute registry can be malformed (P0-7).
 *
 * Every one of these is refused rather than resolved. A derived attribute is
 * addressable by a hierarchy level exactly like a built-in, so a definition that
 * shadowed `systemKey`, or two definitions answering to one id, would silently
 * change where equipment is filed -- and the person who typed it would have no
 * way to see that it had happened.
 */
export type DerivedAttributeConfigReason =
  | {
      readonly kind: 'invalid-attribute-id';
      readonly attributeId: string;
      /** Position in `derivedAttributes`, so the row is findable. */
      readonly definitionIndex: number;
    }
  | {
      readonly kind: 'duplicate-attribute-id';
      readonly attributeId: string;
      readonly definitionIndex: number;
    }
  | {
      readonly kind: 'built-in-attribute-id';
      readonly attributeId: string;
      readonly definitionIndex: number;
    };

/** Thrown by `compileProject` when the derived-attribute registry is malformed. */
export class DerivedAttributeConfigError extends Error {
  readonly reason: DerivedAttributeConfigReason;

  constructor(reason: DerivedAttributeConfigReason) {
    super(describeDerivedAttributeConfigReason(reason));
    this.name = 'DerivedAttributeConfigError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeDerivedAttributeConfigReason(
  reason: DerivedAttributeConfigReason,
): string {
  const at = `derivedAttributes[${String(reason.definitionIndex)}]`;
  switch (reason.kind) {
    case 'invalid-attribute-id':
      return (
        `${at} has the id '${reason.attributeId}', which is not kebab-case; ` +
        'an attribute id is lowercase words joined by single hyphens'
      );
    case 'duplicate-attribute-id':
      return (
        `${at} repeats the attribute id '${reason.attributeId}'; ` +
        'two definitions under one id would make which one a level reads unanswerable'
      );
    case 'built-in-attribute-id':
      return (
        `${at} defines '${reason.attributeId}', which is a built-in attribute; ` +
        'shadowing one would change where equipment is filed without saying so'
      );
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled DerivedAttributeConfigReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}
