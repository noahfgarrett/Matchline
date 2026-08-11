/**
 * Proof 5 of 7: Selection Sets (hard gate 15).
 *
 * CONFIDENTIALITY. Counts and kinds only — a set's name is a client's name for
 * their own equipment and is never printed.
 *
 * The gate is not "the sets table has rows". It is that a fixed selection's
 * membership actually resolved: `DocumentWalker` matches the items a set lists
 * against the items the tree walk saw, through a `Dictionary<ModelItem, long>`,
 * and that dictionary rests on ModelItem implementing value equality. If it
 * does not, every set comes out with zero members and everything downstream
 * quietly filters to nothing. Members present is the evidence; that is why an
 * explicit set with no members fails here.
 */
import { openExtractionCache } from '@matchline/model-schema';

import { countBy, ProofReport, proofSettings, soleCachePath } from './proof-lib.mjs';

const report = new ProofReport('selection-sets');
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

  const explicit = flat.filter((set) => set.kind === 'selection');
  const folders = flat.filter((set) => set.kind === 'folder');
  const withMembers = flat.filter((set) => set.memberObjectIds.length > 0);

  // A model with no sets cannot prove this gate either way. That is a failure
  // of the proof, not a pass: pick a model that has them.
  report.check(
    'the model has at least one saved set',
    flat.length > 0,
    flat.length > 0 ? null : 'this gate needs a model with saved sets; nothing to verify here',
  );
  report.check(
    'the model has at least one fixed selection set',
    explicit.length > 0,
    explicit.length > 0 ? null : 'no set of kind selection; the gate needs one',
  );
  report.check(
    'at least one set resolved to members',
    withMembers.length > 0,
    withMembers.length > 0
      ? null
      : 'every set is empty — the usual cause is ModelItem not comparing by value, ' +
        'which makes DocumentWalker match nothing',
  );

  // Every fixed selection is by definition resolvable: it is a stored list, not
  // a query. One that came back unresolved means the list itself would not read.
  const unresolvedExplicit = explicit.filter((set) => !set.membershipResolved);
  report.check(
    'every fixed selection resolved',
    unresolvedExplicit.length === 0,
    `${String(unresolvedExplicit.length)} unresolved selection set(s)`,
  );

  const emptyExplicit = explicit.filter(
    (set) => set.membershipResolved && set.memberObjectIds.length === 0,
  );
  report.check(
    'no fixed selection resolved to nothing',
    emptyExplicit.length === 0,
    emptyExplicit.length === 0
      ? null
      : `${String(emptyExplicit.length)} fixed selection(s) resolved to zero members — possible, ` +
        'but far more likely to be the ModelItem equality assumption failing',
  );

  // Members must address objects that exist: a member row pointing at nothing
  // would mean the walk and the sets disagree about the model. Built by
  // streaming rather than by materialising every object first — a real model
  // has hundreds of thousands of them and only the ids are wanted.
  const objectIds = new Set();
  for (const object of cache.allObjects()) {
    objectIds.add(object.id);
  }
  const dangling = flat.reduce(
    (total, set) =>
      total + set.memberObjectIds.filter((objectId) => !objectIds.has(objectId)).length,
    0,
  );
  report.check('every member names an object in the cache', dangling === 0, `${String(dangling)} dangling`);

  const memberCounts = withMembers.map((set) => set.memberObjectIds.length).sort((a, b) => a - b);
  report.fact('sets', flat.length);
  report.fact('byKind', countBy(flat.map((set) => set.kind)));
  report.fact('folders', folders.length);
  report.fact('setsWithMembers', withMembers.length);
  report.fact('memberRows', flat.reduce((total, set) => total + set.memberObjectIds.length, 0));
  report.fact('smallestSetMembers', memberCounts[0] ?? 0);
  report.fact('largestSetMembers', memberCounts[memberCounts.length - 1] ?? 0);
  report.fact(
    'memberUnresolvedWarnings',
    cache.warnings().filter((warning) => warning.code === 'SELECTION_SET_MEMBER_UNRESOLVED').length,
  );
} finally {
  cache.close();
}

report.finish(settings.outDir);
