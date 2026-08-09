/**
 * The asset shapes this package prints and learns from.
 *
 * Both are the exporter's own flattened shapes rather than another package's
 * output type, exactly as `@matchline/mel-export`'s `GeneratedMelAsset` is: the
 * EXTO layer stays independent of how the catalog, the resolver and the SSM
 * compiler happen to spell their outputs today, and the coordinator adapts the
 * real producers onto these.
 *
 * Optional members mean "no source stated this". They never reach a cell as the
 * text `'undefined'`; a gap that reads as a fact is the failure mode this whole
 * package is arranged to avoid.
 */

/**
 * What the learned item-master table is queried with.
 *
 * These are precisely the four dimensions the donor's two lookup rungs read
 * (`compiler/itemmasters.js`, `assignItemMasters`) plus the tag used to report
 * the outcome. `systemKey` is Matchline's spelling of the registry's UPN column
 * (PRODUCT.md §2.3, "System Key = UPN").
 */
export interface ItemMasterAsset {
  /** The tag the project should use. Identifies the asset in every outcome. */
  readonly canonicalTag: string;
  /**
   * Discipline after mapping onto the standard set. The donor keyed on the
   * registry's single Discipline column; Matchline keeps nativeDiscipline and
   * ssmDiscipline apart (docs/ENGINE.md, E3 projection) and the registry's
   * column is the SSM one.
   */
  readonly ssmDiscipline?: string;
  /** Registry "Equipment Classification" — the donor's `classification`. */
  readonly equipmentClass?: string;
  /** Registry "UPN". Strings, always — `'001'` is not the number 1 (§5.5). */
  readonly systemKey?: string;
  /** Registry "Equipment Description". Only its first word is ever keyed on. */
  readonly description?: string;
}

/**
 * One compiled asset, flattened to what the Rev21 upload sheet prints.
 *
 * A superset of {@link ItemMasterAsset} so that one value serves both layers:
 * the same asset that was handed to {@link assignItemMaster} is the one whose
 * row carries the answer.
 *
 * `ssmDiscipline` is both an item-master key and the Discipline column, so it is
 * read twice and stated once. `description` is inherited for the item-master
 * layer's sake alone and is deliberately *not* printed — the Rev21 map positions
 * no cell this package fills from it, and inventing one would be a column no
 * template revision asked for.
 */
export interface ExtoAsset extends ItemMasterAsset {
  /**
   * The system's human-facing name. Written to Closest Parent for a root, per
   * the Rev21 convention the donor spells out in `export/xlsx.js`: "a root's
   * Closest Parent is its own System Name".
   */
  readonly systemLabel?: string;
  /** The one structural parent from the SSM projection (PRODUCT.md §11). */
  readonly structuralParentTag?: string;
  /** Additive commissioning dependencies, as tags. Order here does not matter. */
  readonly dependencyTags?: ReadonlyArray<string>;
  /** Item Master Unique Identifier, however the caller settled it. */
  readonly itemMaster?: string;
  /** The L2 milestone label, if the schedule layer resolved one. */
  readonly milestoneLabel?: string;
  /* ---- the positioned generic columns (see `columns.ts`) ---- */
  readonly building?: string;
  readonly level?: string;
  readonly grid?: string;
  /**
   * The work-breakdown code, however the caller settled it — a mapped model
   * property or the learned table in `wbs.ts`. Text, never a number: a code with
   * a leading zero is not the integer that follows it.
   */
  readonly wbs?: string;
  readonly manufacturer?: string;
  readonly modelNumber?: string;
}
