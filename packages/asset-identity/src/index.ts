/**
 * `@matchline/asset-identity` — the asset identity ledger (P0-9).
 *
 * Two entry points and one set of shapes:
 *
 * - {@link stableObjectIdentities} turns one model object's evidence into the
 *   durable keys P0-9's order defines, strongest first.
 * - {@link reconcileLedger} moves a ledger forward by one compile: which ids
 *   survive, which are minted, what changed, and what disappeared.
 *
 * The package reads no cache and knows nothing about a project. Everything it
 * needs arrives as plain data, which is what makes a ledger something the
 * project store can persist and a test can hand-write.
 */
export { stableObjectIdentities } from './keys.js';

export { reconcileLedger } from './reconcile.js';

export {
  ASSET_LEDGER_FORMAT_VERSION,
  EMPTY_ASSET_LEDGER,
  LEDGER_EVENT_KIND_ORDER,
  STABLE_KEY_TIER_ORDER,
} from './types.js';
export type {
  AssetLedger,
  AssetLedgerEntry,
  LedgerCandidate,
  LedgerEntryStatus,
  LedgerEvent,
  LedgerEventKind,
  ModelObjectIdentityEvidence,
  ReconcileLedgerResult,
  StableKeyTier,
  StableModelObjectIdentity,
} from './types.js';
