/**
 * Proof 6 of 7: Search Sets (hard gate 16) — resolved, or honestly blocked.
 *
 * CONFIDENTIALITY. Counts and codes only. A search set's name appears in the
 * SEARCH_SET_UNRESOLVED warning inside the cache and is deliberately NOT copied
 * into this summary; only the count is.
 *
 * The gate has exactly one forbidden answer: empty-as-answer
 * (docs/RELEASE-1.0-PLAN.md P0-3). Schema v2 makes the difference expressible —
 * `selection_sets.membership_resolved` — so this script checks that the
 * distinction was actually made and is internally consistent:
 *
 *   resolved with members    the search ran and matched things
 *   resolved with none       the search ran and matched nothing — an answer
 *   unresolved               nobody found out; NO member rows, and a warning
 *
 * A model with no saved searches cannot prove the gate either way. That is
 * recorded as a SKIP, loudly, with `gate16Proven: false` in the artifact: a
 * green job that skipped this must not read as a gate that passed.
 */
import { openExtractionCache } from '@matchline/model-schema';

import { ProofReport, proofSettings, soleCachePath } from './proof-lib.mjs';

const UNRESOLVED_WARNING = 'SEARCH_SET_UNRESOLVED';

const report = new ProofReport('search-sets');
const settings = proofSettings();

let cachePath;
try {
  cachePath = soleCachePath(settings.cacheDir);
} catch (error) {
  report.check('exactly one cache to read', false, error.message);
  report.finish(settings.outDir);
  process.exit();
}

const cache = openExtractionCache(cachePath);
try {
  const flat = [];
  const stack = [...cache.selectionSets()];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    flat.push(node);
    stack.push(...node.children);
  }

  const searches = flat.filter((set) => set.kind === 'search');
  const resolved = searches.filter((set) => set.membershipResolved);
  const unresolved = searches.filter((set) => !set.membershipResolved);
  const resolvedWithMembers = resolved.filter((set) => set.memberObjectIds.length > 0);
  const resolvedEmpty = resolved.filter((set) => set.memberObjectIds.length === 0);
  const unresolvedWarnings = cache
    .warnings()
    .filter((warning) => warning.code === UNRESOLVED_WARNING);

  const schemaVersion = cache.meta().schemaVersion;
  report.check(
    'the cache is schema v2 or later, so it can express the distinction',
    schemaVersion !== '1',
    schemaVersion === '1'
      ? 'a v1 cache cannot say whether a search resolved; re-extract with this build'
      : `schema_version ${schemaVersion}`,
  );

  if (searches.length === 0) {
    report.skip(
      'the model has saved searches to resolve',
      'this model has none, so gate 16 is neither proven nor disproven by this run',
    );
  } else {
    // The whole gate, in one line: every search set is either an answer or an
    // admission. There is no third state, and "empty because nobody asked" is
    // not allowed to look like "empty because nothing matched".
    report.check(
      'every search set is either resolved or flagged unresolved',
      resolved.length + unresolved.length === searches.length,
    );

    report.check(
      'no unresolved set carries member rows',
      unresolved.every((set) => set.memberObjectIds.length === 0),
      'an unresolved set must have no members at all: absent is not empty',
    );

    // An unresolved set that nobody was told about is the silent failure this
    // gate exists to forbid.
    report.check(
      `every unresolved set is named by a ${UNRESOLVED_WARNING} warning`,
      unresolvedWarnings.length >= unresolved.length,
      `${String(unresolved.length)} unresolved set(s), ${String(unresolvedWarnings.length)} warning(s)`,
    );

    // And the converse: a warning with no unresolved set means the two halves
    // of the writer disagree.
    report.check(
      'no unresolved warning without an unresolved set',
      unresolved.length > 0 || unresolvedWarnings.length === 0,
      `${String(unresolvedWarnings.length)} warning(s) but no unresolved set`,
    );

    report.check(
      'a resolved-and-empty search is distinguishable from an unresolved one',
      resolvedEmpty.every((set) => set.membershipResolved) &&
        unresolved.every((set) => !set.membershipResolved),
    );

    if (resolved.length === 0) {
      // Honestly blocked rather than silently wrong: the fallback the plan
      // allows, but it is a finding, not a pass.
      report.check(
        'at least one search set resolved',
        false,
        'no saved search resolved on this machine — the fallback path is in force, ' +
          'gate 16 is blocked rather than met; report the warning messages from the cache',
      );
    }
  }

  report.fact('gate16Proven', searches.length > 0 && resolved.length > 0 && unresolved.length === 0);
  report.fact('schemaVersion', schemaVersion);
  report.fact('searchSets', searches.length);
  report.fact('resolvedWithMembers', resolvedWithMembers.length);
  report.fact('resolvedEmpty', resolvedEmpty.length);
  report.fact('unresolved', unresolved.length);
  report.fact('unresolvedWarnings', unresolvedWarnings.length);
  report.fact(
    'searchMemberRows',
    searches.reduce((total, set) => total + set.memberObjectIds.length, 0),
  );
} finally {
  cache.close();
}

report.finish(settings.outDir);
