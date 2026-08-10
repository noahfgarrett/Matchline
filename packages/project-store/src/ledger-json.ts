/**
 * Getting an `AssetLedger` back out of a JSON column (P0-9, schema v5).
 *
 * Unlike a `ResolvedSnapshot` there is nothing to serialize: `AssetLedger` is
 * plain JSON by construction -- no `Map`, no `Set`, no `undefined` -- which is
 * exactly so the project store can hold it verbatim. `saveLedger` therefore
 * takes the value as it stands and `canonicalJson` writes it.
 *
 * Reading it back is a different matter. The ledger is the thing that decides
 * which asset a stored decision belongs to, so a ledger this build cannot fully
 * understand must be refused rather than half-read: an entry with a missing
 * `assetId`, or two entries claiming one id, would silently re-address somebody's
 * manual parent onto the wrong piece of equipment. Every field is checked, and
 * the caller is handed a value it can rely on or an error.
 */
import {
  ASSET_LEDGER_FORMAT_VERSION,
  STABLE_KEY_TIER_ORDER,
  type AssetLedger,
  type AssetLedgerEntry,
  type StableModelObjectIdentity,
} from '@matchline/asset-identity';

import { ProjectStoreError } from './errors.js';
import {
  requireArrayAt,
  requireFilledStringAt,
  requireIntegerAt,
  requireMemberAt,
  requireRecordAt,
  requireStringAt,
  requireStringArrayAt,
  type Fail,
} from './validate.js';

const fail: Fail = (field, detail) => {
  throw new ProjectStoreError({ kind: 'invalid-ledger', field, detail });
};

/** Every {@link AssetLedgerEntry.status}, for validating a stored row. */
const ENTRY_STATUSES = ['present', 'disappeared'] as const satisfies ReadonlyArray<
  AssetLedgerEntry['status']
>;

function readIdentity(value: unknown, field: string): StableModelObjectIdentity {
  const record = requireRecordAt(value, field, fail);
  return {
    logicalSourceId: requireFilledStringAt(
      record['logicalSourceId'],
      `${field}.logicalSourceId`,
      fail,
    ),
    stableObjectKey: requireFilledStringAt(
      record['stableObjectKey'],
      `${field}.stableObjectKey`,
      fail,
    ),
    tier: requireMemberAt(record['tier'], STABLE_KEY_TIER_ORDER, `${field}.tier`, fail),
  };
}

function readEntry(value: unknown, field: string): AssetLedgerEntry {
  const record = requireRecordAt(value, field, fail);
  return {
    assetId: requireFilledStringAt(record['assetId'], `${field}.assetId`, fail),
    // An untagged asset has `''` here, which is a stated answer rather than a
    // gap -- so this is the one string field that may be empty.
    currentCanonicalTag: requireStringAt(
      record['currentCanonicalTag'],
      `${field}.currentCanonicalTag`,
      fail,
    ),
    aliases: requireStringArrayAt(record['aliases'], `${field}.aliases`, fail),
    modelIdentities: requireArrayAt(
      record['modelIdentities'],
      `${field}.modelIdentities`,
      fail,
    ).map((identity, index) => readIdentity(identity, `${field}.modelIdentities[${index}]`)),
    status: requireMemberAt(record['status'], ENTRY_STATUSES, `${field}.status`, fail),
  };
}

/**
 * A stored ledger, validated.
 *
 * The version check is first and is a refusal, not a repair: a ledger written in
 * a shape this build does not know is not something to guess at, because every
 * asset id in the project is addressed through it.
 *
 * @throws ProjectStoreError `invalid-ledger` naming the first field that failed.
 */
export function deserializeLedger(value: unknown): AssetLedger {
  const record = requireRecordAt(value, 'ledger', fail);

  const formatVersion = requireIntegerAt(record['formatVersion'], 'ledger.formatVersion', fail);
  if (formatVersion !== ASSET_LEDGER_FORMAT_VERSION) {
    return fail(
      'ledger.formatVersion',
      `expected ${String(ASSET_LEDGER_FORMAT_VERSION)}, got ${String(formatVersion)}`,
    );
  }

  const entries = requireArrayAt(record['entries'], 'ledger.entries', fail).map((entry, index) =>
    readEntry(entry, `ledger.entries[${index}]`),
  );

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.assetId)) {
      // Two entries under one id would make every lookup through the ledger
      // answer with whichever one happened to be indexed last.
      return fail('ledger.entries', `asset id '${entry.assetId}' appears twice`);
    }
    seen.add(entry.assetId);
  }

  const nextOrdinal = requireIntegerAt(record['nextOrdinal'], 'ledger.nextOrdinal', fail);
  if (nextOrdinal < 1) {
    return fail('ledger.nextOrdinal', `expected a positive integer, got ${String(nextOrdinal)}`);
  }

  return { formatVersion: ASSET_LEDGER_FORMAT_VERSION, entries, nextOrdinal };
}
