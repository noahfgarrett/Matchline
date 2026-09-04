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


/**
 * Ways a Site Profile can name something the engine does not have.
 *
 * Each of these is a string a person typed into a closed vocabulary, and each
 * one silently changes where a site's equipment is filed if it is read rather
 * than refused. See `validateProfile` for what each mistake actually does.
 */
export type ProfileConfigReason =
  | {
      readonly kind: 'unknown-ladder-tier';
      /** The path a person can find in the profile, e.g. `ladder.tiers[2]`. */
      readonly field: string;
      readonly value: string;
      readonly allowed: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'unknown-attribute-key';
      readonly field: string;
      readonly value: string;
      readonly allowed: ReadonlyArray<string>;
      readonly levelId: string;
    }
  | {
      readonly kind: 'unknown-missing-value-policy';
      readonly field: string;
      readonly value: string;
      readonly allowed: ReadonlyArray<string>;
      readonly levelId: string;
    }
  | {
      readonly kind: 'unknown-level-sort';
      readonly field: string;
      readonly value: string;
      readonly allowed: ReadonlyArray<string>;
      readonly levelId: string;
    };

/** Thrown by `compileProject` when the profile names something that does not exist. */
export class ProfileConfigError extends Error {
  readonly reason: ProfileConfigReason;

  constructor(reason: ProfileConfigReason) {
    super(describeProfileConfigReason(reason));
    this.name = 'ProfileConfigError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeProfileConfigReason(reason: ProfileConfigReason): string {
  const said = `${reason.field} says '${reason.value}'`;
  const allowed = `the values it may take are ${reason.allowed.join(', ')}`;
  switch (reason.kind) {
    case 'unknown-ladder-tier':
      return (
        `${said}, which is not a ladder rung; a misspelled rung is silently disabled, ` +
        `so the tree loses that evidence with nothing to say why. ${allowed}`
      );
    case 'unknown-attribute-key':
      return (
        `${said}, which is not an attribute any asset carries; level ` +
        `'${reason.levelId}' would find no value on anything and file the whole site ` +
        `under its missing-value policy. ${allowed}`
      );
    case 'unknown-missing-value-policy':
      return (
        `${said}, which is not a missing-value policy; level '${reason.levelId}' ` +
        `would not know what to do with an asset that states no value. ${allowed}`
      );
    case 'unknown-level-sort':
      return (
        `${said}, which is not a sibling order; level '${reason.levelId}' would not ` +
        `know how to order its groups. ${allowed}`
      );
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled ProfileConfigReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}
