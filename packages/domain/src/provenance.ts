/**
 * Where inside a source a value was found.
 *
 * Model objects and spreadsheet rows are not addressable the same way, and
 * flattening both into one string loses the ability to navigate back to the
 * original. A discriminated union keeps each address in its native shape.
 */
export type SourceRef =
  | { readonly kind: 'model-object'; readonly objectId: string }
  | { readonly kind: 'sheet-row'; readonly sheet: string; readonly row: number };

/**
 * The audit trail for a single value: which document said it, where in that
 * document, and which rule turned it into a claim.
 *
 * Every value that reaches the register carries one of these. It is what makes
 * a disagreement between two sources reviewable instead of silent.
 */
export interface Provenance {
  readonly sourceFile: string;
  readonly sourceRef: SourceRef;
  /** Model property name, or spreadsheet column header. */
  readonly propertyOrColumn?: string;
  /** Identifier of the profile rule that produced the claim. */
  readonly rule?: string;
  /**
   * Which rung of the resolution ladder produced the value. Rung 1 is the
   * most direct match; higher rungs are progressively looser fallbacks.
   */
  readonly fallbackRung?: number;
  /** Free-text record of a human override, when a person overruled the rules. */
  readonly manualDecision?: string;
  /** Revision of the input document, so a stale claim can be spotted. */
  readonly inputRevision?: string;
  /** Revision of the rule profile, so a re-compile can be explained. */
  readonly profileRevision?: string;
}
