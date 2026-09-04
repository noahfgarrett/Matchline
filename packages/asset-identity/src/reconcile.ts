/**
 * Moving a ledger forward by one compile (RELEASE-1.0-PLAN P0-9).
 *
 * Pure and total: two calls with the same previous ledger and the same
 * candidates produce a deep-equal result, and no input is rejected. Nothing is
 * ever deleted -- an entry no candidate claimed is kept and flagged, and an
 * entry two candidates claim is split rather than merged.
 *
 * ## What a match is
 *
 * The evidence order in `types.ts`, walked strongest first. A tier matches when
 * the candidate's key at that tier names EXACTLY ONE previous entry: two
 * entries sharing a key means that tier cannot tell them apart, and guessing
 * which one is meant is the merge P0-9 forbids, so the walk falls through to
 * the next tier instead.
 *
 * ## What an id is
 *
 * Permanent, project-scoped and meaningless once minted. A new entry adopts the
 * id the catalog derived for it this compile, which is `tag:<tag>` for an
 * unduplicated tag -- readable at the moment it is minted, and thereafter just a
 * string, because the ledger is what keeps it attached to the equipment when the
 * tag changes. When that id is already taken -- a genuinely new asset tagged the
 * way a renamed one used to be -- the ordinal spelling `asset:<000001>` is used
 * instead, and {@link AssetLedger.nextOrdinal} remembers where to carry on.
 */
import type {
  AssetLedger,
  AssetLedgerEntry,
  LedgerCandidate,
  LedgerEvent,
  LedgerEventKind,
  ReconcileLedgerResult,
  StableKeyTier,
  StableModelObjectIdentity,
} from './types.js';
import { ASSET_LEDGER_FORMAT_VERSION, LEDGER_EVENT_KIND_ORDER, STABLE_KEY_TIER_ORDER } from './types.js';

/** How many digits an ordinal id is padded to. Cosmetic; ids are compared whole. */
const ORDINAL_DIGITS = 6;

/** Which previous entry a candidate claimed, and on what evidence. */
interface CandidateMatch {
  readonly entryAssetId: string;
  readonly tier: StableKeyTier;
  /** Position in {@link STABLE_KEY_TIER_ORDER}; lower is stronger. */
  readonly tierRank: number;
}

function tierRankOf(tier: StableKeyTier): number {
  const rank = STABLE_KEY_TIER_ORDER.indexOf(tier);
  // Unreachable for a tier this build knows. A ledger written by a newer build
  // may carry one this build does not, and ranking it last is the honest
  // reading: evidence we cannot interpret is the weakest evidence there is.
  return rank === -1 ? STABLE_KEY_TIER_ORDER.length : rank;
}

/** UTF-16 code units, so two machines order the same ledger the same way. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Thrown when a ledger announces a format this build cannot read.
 *
 * Refused rather than read on a best-effort basis. A ledger IS the project's
 * asset identity: reading a newer one under this build's assumptions would mint
 * new ids for equipment that already has them and orphan every decision
 * recorded against the old ones -- silently, and irreversibly once saved.
 */
export class AssetLedgerFormatError extends Error {
  readonly formatVersion: number;
  readonly supportedVersion: number;

  constructor(formatVersion: number) {
    super(
      `this asset identity ledger states formatVersion ${String(formatVersion)}, and this ` +
        `build reads version ${String(ASSET_LEDGER_FORMAT_VERSION)}; ` +
        'open the project with a matching version of Matchline rather than recompiling it, ' +
        'because a ledger read under the wrong assumptions mints new ids for equipment that ' +
        'already has them',
    );
    this.name = 'AssetLedgerFormatError';
    this.formatVersion = formatVersion;
    this.supportedVersion = ASSET_LEDGER_FORMAT_VERSION;
  }
}

/**
 * Move a ledger forward.
 *
 * @param previous the ledger the last compile wrote, or `null` for a project
 * that has never been compiled.
 * @param candidates this compile's assets, in catalog order. The order decides
 * only which of several claimants keeps a contested id, and catalog order is
 * itself a function of the project rather than of the caller.
 * @throws AssetLedgerFormatError when `previous` states a `formatVersion` this
 * build does not read.
 */
export function reconcileLedger(
  previous: AssetLedger | null,
  candidates: ReadonlyArray<LedgerCandidate>,
): ReconcileLedgerResult {
  if (previous !== null && previous.formatVersion !== ASSET_LEDGER_FORMAT_VERSION) {
    // The field exists to be checked. It was written on every ledger and read
    // by nobody, which made it a version number that could not stop anything.
    throw new AssetLedgerFormatError(previous.formatVersion);
  }
  const previousEntries = previous?.entries ?? [];

  // --- index the previous ledger, one map per tier --------------------------
  const byTier = new Map<StableKeyTier, Map<string, string[]>>();
  for (const tier of STABLE_KEY_TIER_ORDER) {
    byTier.set(tier, new Map<string, string[]>());
  }
  for (const entry of previousEntries) {
    for (const identity of entry.modelIdentities) {
      const keys = byTier.get(identity.tier);
      if (keys === undefined) {
        continue;
      }
      const claimants = keys.get(identity.stableObjectKey);
      if (claimants === undefined) {
        keys.set(identity.stableObjectKey, [entry.assetId]);
      } else if (!claimants.includes(entry.assetId)) {
        claimants.push(entry.assetId);
      }
    }
  }

  // --- what each candidate claims -------------------------------------------
  const matches: ReadonlyArray<CandidateMatch | null> = candidates.map((candidate) =>
    matchOf(candidate.identities, byTier),
  );

  // --- contested entries: one keeps the id, the rest are new ----------------
  const claimantsOf = new Map<string, number[]>();
  matches.forEach((match, index) => {
    if (match === null) {
      return;
    }
    const bucket = claimantsOf.get(match.entryAssetId);
    if (bucket === undefined) {
      claimantsOf.set(match.entryAssetId, [index]);
    } else {
      bucket.push(index);
    }
  });

  /** Candidate index -> the previous entry it keeps. At most one per entry. */
  const keeperOf = new Map<number, CandidateMatch>();
  /** Previous entry id -> the candidate index that kept it. */
  const keptBy = new Map<string, number>();
  for (const [entryAssetId, indexes] of claimantsOf) {
    const winner = strongestClaimant(indexes, matches);
    const match = matches[winner];
    if (match === undefined || match === null) {
      continue;
    }
    keeperOf.set(winner, match);
    keptBy.set(entryAssetId, winner);
  }

  // --- mint ids for everything that kept nothing ----------------------------
  const taken = new Set<string>(previousEntries.map((entry) => entry.assetId));
  // The ledger arrives from a project file, so the carried ordinal is checked
  // rather than trusted: a `null`, a fraction or a NaN out of a hand-edited or
  // half-written document would otherwise spin the minting loop forever.
  // Restarting at 1 is safe, because every candidate id is checked against
  // `taken` before it is used.
  const carriedOrdinal = previous?.nextOrdinal ?? 1;
  const mint = {
    ordinal: Number.isSafeInteger(carriedOrdinal) && carriedOrdinal > 0 ? carriedOrdinal : 1,
  };
  /** Candidate index -> ledger asset id. Filled for every candidate. */
  const ledgerIdOf = new Map<number, string>();
  candidates.forEach((candidate, index) => {
    const kept = keeperOf.get(index);
    if (kept !== undefined) {
      ledgerIdOf.set(index, kept.entryAssetId);
      return;
    }
    const minted = mintAssetId(candidate.assetId, taken, mint);
    taken.add(minted);
    ledgerIdOf.set(index, minted);
  });

  // --- the new entry list ----------------------------------------------------
  const events: LedgerEvent[] = [];
  const entries: AssetLedgerEntry[] = [];

  for (const entry of previousEntries) {
    const index = keptBy.get(entry.assetId);
    if (index === undefined) {
      entries.push(entry.status === 'disappeared' ? entry : { ...entry, status: 'disappeared' });
      events.push({
        kind: 'disappeared',
        assetId: entry.assetId,
        canonicalTag: entry.currentCanonicalTag,
        detail:
          `no asset in this compile carries the identity of ${describe(entry.assetId, entry.currentCanonicalTag)}; ` +
          'the entry is kept so decisions recorded against it still resolve',
      });
      continue;
    }
    const candidate = candidates[index];
    const match = keeperOf.get(index);
    if (candidate === undefined || match === undefined) {
      continue;
    }
    entries.push(updatedEntry(entry, candidate));
    const event = matchEvent(entry, candidate, match);
    if (event !== null) {
      events.push(event);
    }
  }

  candidates.forEach((candidate, index) => {
    if (keeperOf.has(index)) {
      return;
    }
    const assetId = ledgerIdOf.get(index);
    if (assetId === undefined) {
      return;
    }
    entries.push({
      assetId,
      currentCanonicalTag: candidate.canonicalTag,
      aliases: [],
      modelIdentities: candidate.identities,
      status: 'present',
    });
    events.push({
      kind: 'new-asset',
      assetId,
      canonicalTag: candidate.canonicalTag,
      detail: `${describe(assetId, candidate.canonicalTag)} is new to this project`,
    });
  });

  // --- splits ----------------------------------------------------------------
  for (const [entryAssetId, indexes] of claimantsOf) {
    if (indexes.length < 2) {
      continue;
    }
    const winner = keptBy.get(entryAssetId);
    if (winner === undefined) {
      continue;
    }
    const siblings = indexes
      .filter((index) => index !== winner)
      .map((index) => ledgerIdOf.get(index) ?? '')
      .filter((assetId) => assetId !== '')
      .sort(compareText);
    events.push({
      kind: 'split',
      assetId: entryAssetId,
      canonicalTag: candidates[winner]?.canonicalTag ?? '',
      siblingAssetIds: siblings,
      detail:
        `${String(indexes.length)} assets now carry the identity of ${entryAssetId}; ` +
        `it keeps the id and ${siblings.join(', ')} were minted, because merging them would ` +
        'silently discard one asset',
    });
  }

  events.sort(compareEvents);

  return {
    ledger: { formatVersion: ASSET_LEDGER_FORMAT_VERSION, entries, nextOrdinal: mint.ordinal },
    mapping: mappingOf(candidates, ledgerIdOf),
    events,
  };
}

/** The strongest tier that names exactly one previous entry, or `null`. */
function matchOf(
  identities: ReadonlyArray<StableModelObjectIdentity>,
  byTier: ReadonlyMap<StableKeyTier, ReadonlyMap<string, ReadonlyArray<string>>>,
): CandidateMatch | null {
  for (const tier of STABLE_KEY_TIER_ORDER) {
    const identity = identities.find((entry) => entry.tier === tier);
    if (identity === undefined) {
      continue;
    }
    const claimants = byTier.get(tier)?.get(identity.stableObjectKey) ?? [];
    const only = claimants.length === 1 ? claimants[0] : undefined;
    if (only === undefined) {
      // Nothing here, or more than one thing here. Either way this tier has not
      // identified anything, and a weaker tier is still allowed to try.
      continue;
    }
    return { entryAssetId: only, tier, tierRank: tierRankOf(tier) };
  }
  return null;
}

/** Strongest evidence wins a contested entry; catalog order breaks a tie. */
function strongestClaimant(
  indexes: ReadonlyArray<number>,
  matches: ReadonlyArray<CandidateMatch | null>,
): number {
  let winner = indexes[0] ?? 0;
  let best = matches[winner]?.tierRank ?? STABLE_KEY_TIER_ORDER.length;
  for (const index of indexes) {
    const rank = matches[index]?.tierRank ?? STABLE_KEY_TIER_ORDER.length;
    if (rank < best) {
      winner = index;
      best = rank;
    }
  }
  return winner;
}

/** A previous entry re-stated from the candidate that kept it. */
function updatedEntry(entry: AssetLedgerEntry, candidate: LedgerCandidate): AssetLedgerEntry {
  return {
    assetId: entry.assetId,
    currentCanonicalTag: candidate.canonicalTag,
    aliases: mergedAliases(entry.aliases, entry.currentCanonicalTag, candidate.canonicalTag),
    modelIdentities: candidate.identities,
    status: 'present',
  };
}

/**
 * Every spelling this asset has had, oldest first, minus the one it has now.
 *
 * The current tag is removed rather than kept: an asset re-tagged back to an
 * earlier spelling is not its own alias, and leaving it in would make the
 * identity index answer one tag twice.
 */
function mergedAliases(
  existing: ReadonlyArray<string>,
  previousTag: string,
  currentTag: string,
): ReadonlyArray<string> {
  const aliases: string[] = [];
  for (const alias of existing) {
    if (alias !== '' && alias !== currentTag && !aliases.includes(alias)) {
      aliases.push(alias);
    }
  }
  if (previousTag !== '' && previousTag !== currentTag && !aliases.includes(previousTag)) {
    aliases.push(previousTag);
  }
  return aliases;
}

/** What a re-match is worth reporting as, or `null` when nothing happened. */
function matchEvent(
  entry: AssetLedgerEntry,
  candidate: LedgerCandidate,
  match: CandidateMatch,
): LedgerEvent | null {
  if (match.tier === 'tag') {
    return {
      kind: 'rematched-by-tag',
      assetId: entry.assetId,
      canonicalTag: candidate.canonicalTag,
      tier: match.tier,
      detail:
        `${describe(entry.assetId, candidate.canonicalTag)} was tied to the previous compile by its ` +
        'tag alone: no stable model evidence matched, so this identity is only as good as the tag',
    };
  }
  if (entry.currentCanonicalTag === candidate.canonicalTag) {
    return null;
  }
  return {
    kind: 'tag-changed',
    assetId: entry.assetId,
    canonicalTag: candidate.canonicalTag,
    previousCanonicalTag: entry.currentCanonicalTag,
    tier: match.tier,
    detail:
      `${entry.assetId} is now tagged ${candidate.canonicalTag}, was ${entry.currentCanonicalTag} ` +
      `(matched on ${match.tier}); the old spelling is kept as an alias`,
  };
}

/** `tag:X (MAH001-10-01)`, or just the id when the asset is untagged. */
function describe(assetId: string, canonicalTag: string): string {
  return canonicalTag === '' ? assetId : `${assetId} (${canonicalTag})`;
}

/**
 * The id a new entry takes.
 *
 * The catalog's own id when it is free, so a fresh ledger reads as the compile
 * that made it. An ordinal otherwise -- and the ordinal only ever moves forward,
 * because a reused ordinal is a reused id.
 */
function mintAssetId(
  preferred: string,
  taken: ReadonlySet<string>,
  mint: { ordinal: number },
): string {
  if (preferred !== '' && !taken.has(preferred)) {
    return preferred;
  }
  for (;;) {
    const assetId = `asset:${String(mint.ordinal).padStart(ORDINAL_DIGITS, '0')}`;
    mint.ordinal += 1;
    if (!taken.has(assetId)) {
      return assetId;
    }
  }
}

function mappingOf(
  candidates: ReadonlyArray<LedgerCandidate>,
  ledgerIdOf: ReadonlyMap<number, string>,
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  candidates.forEach((candidate, index) => {
    const assetId = ledgerIdOf.get(index);
    if (assetId !== undefined) {
      mapping.set(candidate.assetId, assetId);
    }
  });
  return mapping;
}

/** Kind order first, then asset id: one total order, independent of the walk. */
function compareEvents(left: LedgerEvent, right: LedgerEvent): number {
  const byKind = eventRank(left.kind) - eventRank(right.kind);
  if (byKind !== 0) {
    return byKind;
  }
  return compareText(left.assetId, right.assetId);
}

function eventRank(kind: LedgerEventKind): number {
  return LEDGER_EVENT_KIND_ORDER.indexOf(kind);
}
