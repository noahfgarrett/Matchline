/**
 * `@matchline/ssm-audit/exto` — the approved VF Exto vocabulary, on its own.
 *
 * The package's main entry point is the audit: it pulls in the rulebook's
 * engine, its model layer and the SheetJS shim the model layer reads a global
 * from. A caller that only wants to know whether `101` is an approved UPN has
 * no business loading any of that, and two of them — `@matchline/system-resolver`
 * and `@matchline/compiler` — ask exactly that question on every asset of every
 * compile. This subpath is the seam: one module, importing one vendored file.
 *
 * The values are SSM-Audit's own, vendored byte for byte under
 * `vendor/exto/`; `test/parity.test.mjs` is what holds them there. Nothing is
 * re-spelled here and nothing new is decided here — a rule that needs changing
 * is changed in SSM-Audit and re-vendored.
 *
 * ## Why the exporter cannot use this
 *
 * `@matchline/exto-export` prints the cells this vocabulary judges, and it is
 * the package this one already depends on (`rows.ts` builds the audit's rows
 * through the exporter's own flattening). Importing back the other way would
 * close a cycle, so the exporter takes a canonicaliser as an option and its
 * callers hand it {@link extoRev21Canonical}.
 */
export {
  EXTO_REV21_COLUMNS,
  EXTO_REV21_SCHEMA_ID,
  EXTO_REV21_VOCABULARY,
  extoRev21Canonical,
  extoRev21EffectiveDiscipline,
  extoRev21IsSystemName,
  extoRev21IsUpn,
  extoRev21Norm,
  extoRev21SystemName,
  extoRev21SystemsForUpn,
  extoRev21UpnCandidates,
  extoRev21ValidatePartial,
} from '../vendor/exto/rev21-contract.js';
export type {
  ExtoRev21Column,
  ExtoRev21Issue,
  ExtoRev21SystemNameResult,
  ExtoRev21SystemNameStatus,
} from '../vendor/exto/rev21-contract.js';

export {
  VF_ITEM_MASTERS,
  VF_ITEM_MASTER_NAMES,
  VF_ITEM_MASTER_TEMPLATE_REV,
  vfItemMasterKnown,
} from '../vendor/exto/vf-item-masters.js';
