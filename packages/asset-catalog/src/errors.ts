/**
 * Ways a project can address something the model universe does not have.
 *
 * A filter naming a selection set that is in no source is a mistake in the
 * profile, not an empty result: silently returning zero assets would look like
 * "this model has no equipment" instead of "you spelled the set name wrong".
 * The error carries the available names so a caller can show them.
 *
 * Source ids are checked for the same reason: two sources under one id would
 * merge without a word, and every object key in the universe would be
 * ambiguous.
 */
export type AssetCatalogConfigReason =
  | {
      readonly kind: 'unknown-selection-set';
      readonly name: string;
      /** Every set and folder name across every source, deduped, in traversal order. */
      readonly available: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'duplicate-source-id';
      readonly sourceId: string;
    }
  | {
      readonly kind: 'blank-source-id';
    }
  /**
   * A `filename-pattern` assignment rule whose `match` does not carry exactly
   * one `*` (P0-8). Refused rather than run: zero stars makes the rule an exact
   * match in disguise, and two make `$1` ambiguous.
   */
  | {
      readonly kind: 'invalid-assignment-pattern';
      /** Position in the rule list, so a profile author can find the row. */
      readonly ruleIndex: number;
      readonly pattern: string;
    };

/** Thrown by `buildAssetCatalog` when the inputs do not fit the universe. */
export class AssetCatalogConfigError extends Error {
  readonly reason: AssetCatalogConfigReason;

  constructor(reason: AssetCatalogConfigReason) {
    super(describeAssetCatalogConfigReason(reason));
    this.name = 'AssetCatalogConfigError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeAssetCatalogConfigReason(reason: AssetCatalogConfigReason): string {
  switch (reason.kind) {
    case 'unknown-selection-set': {
      const available =
        reason.available.length === 0
          ? 'no source in this project has any selection sets'
          : `available: ${reason.available.join(', ')}`;
      return `selection set '${reason.name}' is in no source of this project (${available})`;
    }
    case 'duplicate-source-id':
      return `two model sources share the id '${reason.sourceId}'; ids identify sources`;
    case 'blank-source-id':
      return 'a model source has a blank id; ids identify sources';
    case 'invalid-assignment-pattern':
      return (
        `assignment rule ${String(reason.ruleIndex)} matches on '${reason.pattern}', ` +
        "which is not a filename pattern: exactly one '*' is required, and it is the capture"
      );
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled AssetCatalogConfigReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}
