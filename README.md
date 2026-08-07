# Matchline

A model-first commissioning compiler.

Matchline takes the documents a project already produces — equipment lists, cable
schedules, power studies, schedules — and compiles them into one reconciled asset
register: every asset with a canonical tag, a resolved parent, a system, and a
record of which source said so and why.

The emphasis is on *model-first*: where a 3D model exists, it is the primary
source of truth, and spreadsheet sources are reconciled against it rather than
the other way around. Every claim an input makes about an asset carries its
provenance, so a disagreement between two sources becomes a reviewable conflict
instead of a silent overwrite.

## Where this came from

This repo is a history-preserving fork of SSManagement 4.2.2. The full donor
tree is preserved at tag `ssmanagement-origin-4.2.2` and still lives, working
and fully tested, in `packages/legacy-parity`. It is the behavioral reference:
as new typed packages take over its responsibilities, the legacy suite is what
proves nothing regressed.

The donor is plain JavaScript with its own build and test scripts. It is
deliberately kept out of the TypeScript build — it is a reference, not a
migration target.

## Layout

| Path                     | What it is                                                                 |
| ------------------------ | -------------------------------------------------------------------------- |
| `packages/domain`        | `@matchline/domain` — the typed core vocabulary: assets, claims, provenance. No dependencies. |
| `packages/legacy-parity` | The SSManagement 4.2.2 donor, unmodified. Plain JS, its own build and tests. |
| `tsconfig.base.json`     | Shared strict TypeScript settings. Every package extends this.              |

`packages/*` and `apps/*` are npm workspaces. New typed packages go in
`packages/`; anything with a user interface goes in `apps/`.

## Requirements

Node 24 or newer. The only dependency in the whole repo is TypeScript, pinned to
an exact version.

## Running it

```sh
npm ci            # install (respects the lockfile exactly)
npm run build     # type-check and emit every TypeScript package
npm test          # typed package tests, then the legacy suite
```

The two test halves can be run on their own:

```sh
npm run test:workspaces   # typed packages only — fast
npm run test:legacy       # the legacy suite — 656 tests, ~30s
```

The legacy package can also be driven directly, which is the better option when
working inside it:

```sh
cd packages/legacy-parity
npm run build   # regenerates the single-file SSManagement.html
npm test
```
