# `tests/acceptance-1.0` — the 1.0 acceptance gates

**The files not yet wired into `npm test` are supposed to fail right now.** That
is the whole point of them.

They encode the **target** semantics of `docs/RELEASE-1.0-PLAN.md` — the P0
findings and the hard-gate tracker — against an engine that does not implement
them yet. A red run here is milestone 1 working as designed ("Safety baseline
(branch, baseline counts, failing acceptance tests staged)"). A green run here
is a milestone landing.

## How to run them

```sh
npm run test:acceptance10        # every gate, red ones included
npm run test:acceptance10:green  # only the gates a milestone has closed
```

The whole directory is **not** part of `npm test`: running the red gates there
would turn the repository's baseline red and make every real regression
invisible underneath them. The green list *is* part of `npm test`, which is what
stops a closed gate from quietly re-opening.

## How they get wired in

One area at a time, as its milestone lands. When milestone N is merged and its
file passes in full:

1. Confirm the whole file passes — not "the tests that matter", the file. A
   partially-passing acceptance file is a gate nobody can read.
2. Move that file's run into the main suite by adding its path to
   `test:acceptance10:green` in the root `package.json`, e.g.

   ```json
   "test:acceptance10:green": "node --test tests/acceptance-1.0/multi-model.test.mjs tests/acceptance-1.0/stable-identity.test.mjs tests/acceptance-1.0/manual-parent-boundaries.test.mjs"
   ```

   `test` already runs that script, and `test:acceptance10` stays pointed at the
   whole directory so the remaining gates still have a command of their own.
3. When the last file is wired in, the two scripts describe the same set;
   replace both with `node --test tests/acceptance-1.0/*.test.mjs` under one
   name and delete the other.

   As of milestone 10 all seven files are green and the two scripts *do*
   describe the same set — and they are still kept apart, on purpose. The areas
   listed under "What is *not* covered here" get their own files as their
   milestones come up, and each arrives red. One script would make the next
   staged gate turn `npm test` red the day it is written, which is the exact
   failure the split exists to prevent. Collapse them when the last area has its
   file, not when the last *current* file passes.
4. Update the gate tracker table in `docs/RELEASE-1.0-PLAN.md` in the same
   commit. A gate is closed when a test holds it closed, not when a person
   remembers it.

Do not wire a file in by weakening it. `docs/RELEASE-1.0-PLAN.md`: "Never bless
changed output by editing tests except where the new behavior is explicitly
required above. Never discard provenance or review items to make tests pass."

## The files, and what each one gates

| file | directive | hard gates | milestone that turns it green |
|------|-----------|------------|-------------------------------|
| `multi-model.test.mjs` | P0-1 Multi-model universe | 2, 3, 4 | 2 — Multi-model domain+storage — **green, wired into `npm test`** |
| `stable-identity.test.mjs` | P0-9 Stable asset identity | 12 | 3 — Stable identity — **green, wired into `npm test`** |
| `manual-parent-boundaries.test.mjs` | P0-4 Manual parents honor boundaries | 9, 10 | 4 — Hierarchy+profile semantics — **green, wired into `npm test`** |
| `default-hierarchy.test.mjs` | P0-5 Default hierarchy | 11 | 4 — Hierarchy+profile semantics — **green, wired into `npm test`** |
| `level-key-display.test.mjs` | P0-6 Level key vs display | 8 | 4 — Hierarchy+profile semantics — **green, wired into `npm test`** |
| `profile-v2.test.mjs` | SiteProfileV2 | 13 (partly) | 4 — Hierarchy+profile semantics — **green, wired into `npm test`** |
| `zero-eight-one-migration.test.mjs` | P0-9 + SiteProfileV2, end to end | 13 (in full) | 10 — RC ("the 0.8.1 end-to-end migration test") — **green, wired into `npm test`** |

`support.mjs` is not a test file. It holds the Dragon fixtures and the failure
vocabulary.

## Conventions these files hold themselves to

- **Every failure names its milestone.** `pending(milestone, what)` in
  `support.mjs` builds the message, and every target assertion uses it. A
  failure that only says `undefined !== '001'` is indistinguishable from a
  regression.
- **A missing API fails, it does not crash.** Where a target entry point does
  not exist yet, the call goes through `attempt()` or the field through
  `requirePresent()`, so the result is a named assertion failure rather than a
  `TypeError` from three packages down.
- **Guard tests are labelled.** Several files open with a test that asserts
  current behaviour — that the panel and the RIO really are in different
  systems, that the split caches really do partition the federated one. Those
  pass today and are marked "not a target assertion — a guard". They exist so
  that a target test cannot start passing for the wrong reason.
- **Semantics are pinned, names are not.** Where the plan binds a behaviour but
  names no type (P0-4's "visible review item", P0-9's "orphaned-decision review
  items", P0-6's diff category), the assertion checks that the output *says* the
  right thing and leaves the milestone author to name it. `mentionsAll()` is
  what that looks like. Where the plan does name a shape (`keyAttributeKey`,
  `sourceId`, `formatVersion: 2`), it is pinned exactly.
- **Dragon data only.** Every tag, building, property, workbook row and file
  name here is invented, and the caches are generated at test time from
  `@matchline/model-schema/fixtures/dragon`. No client data, no real Navisworks
  output, nothing derived from either (`docs/EXTRACTION.md`, "Confidentiality").
- **Self-contained fixtures.** `support.mjs` deliberately does not import
  `packages/compiler/test/support.mjs`, even though the two overlap. That file
  is the compiler package's own fixture and milestones 2-4 will edit it; an
  acceptance gate that imported it would change meaning every time a unit test's
  scenario was adjusted.

## What is *not* covered here

This directory holds the six areas milestone 1 stages, plus the migration gate
milestone 10 added. The plan's acceptance areas A–G also include the extraction
service (P0-2), the real Windows proof (P0-3), derived attributes (P0-7), and
source assignments and per-source mappings (P0-8) and distribution. Those get
their own files as their milestones come up; the wiring instructions above apply
unchanged.

Two of those are covered elsewhere rather than here, and deliberately so: the
extraction service is exercised end to end against a protocol-faithful fake
launcher in `apps/desktop/test/extraction-service.test.mjs`, and the real
Windows proof is a runbook plus `scripts/windows-proof/*.mjs`, because no
assertion on this machine can stand in for an Autodesk install.
