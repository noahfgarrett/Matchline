# Matchline

A model-first commissioning compiler. It runs on your machine, on your files, and
sends nothing anywhere.

## What it does

A commissioning site already produces the data it needs: a coordinated Navisworks
model, an equipment list, a cable schedule, a power study, a point master database,
a P6 schedule. They disagree with each other, none of them is complete, and the
work of reconciling them is done by hand every revision.

Matchline compiles them into one asset register: every asset with a canonical tag,
a resolved system, a resolved parent, a list of dependencies, and a record of which
source said so and why. From that register it produces an SSM hierarchy, an
Electrical Flow projection, a generated MEL, EXTO-style workbooks, predecessor
outputs, and a revision diff against the last publication.

*Model-first* is the load-bearing word. Where a 3D model exists it is the equipment
universe and the naming authority; spreadsheets enrich, validate and fill gaps
rather than defining what exists. Every claim an input makes about an asset carries
its provenance, so two sources disagreeing becomes a reviewable conflict instead of
a silent overwrite.

The setup target is that one engineer can configure a new site in about an hour,
and that the next revision of that site is a source swap plus an exception review.

## Local-only, by construction

No model, spreadsheet, profile, project file, extraction result or export leaves
the machine. There is no account, no telemetry, no analytics, no crash reporting
and no cloud component.

This is enforced rather than promised:

- The renderer is sandboxed with `contextIsolation` on, `nodeIntegration` off and a
  strict CSP; it loads no remote content and every web permission is denied.
- Navigation is locked down on `will-navigate`, `will-frame-navigate`,
  `will-attach-webview` and `setWindowOpenHandler`.
- Chromium's spell checker is switched off in `webPreferences` and on the session,
  because it fetches dictionary files from Google on first use — that was the last
  residual network path in the app.
- Extraction runs as a local child process against a local Navisworks install.

The only network function the product will ever have is an optional check for
signed application updates, and it must be disableable and must carry no project
data (PRODUCT.md §2.6, docs/RELEASE-RUNBOOK.md §9). **It is not implemented yet.**
Today's builds make no network calls at all.

## Navisworks support status — nothing is verified yet

Matchline reads a model through an extraction cache written by a Windows-only C#
worker driving a licensed Navisworks install. Freedom has no API and there is no
redistributable NWD engine, so a licensed Simulate or Manage install on the machine
is a hard product requirement.

`native/navisworks-common/Protocol/SupportedAdapters.cs` is the single source of
truth for what may be claimed about a version, and nothing in this repo may claim
more than it does:

| Version | Adapter | Status today | What that means |
| --- | --- | --- | --- |
| 2025 | `navisworks-2025` | `pending-real-proof` | Compiles against the real Autodesk assembly in the self-hosted CI job. The proof run against a real model has **not** been completed. |
| 2024 | `navisworks-2024` | `stub-compiled-unverified` | Type-checks against `native/navisworks-stubs`, a hand-written stand-in. Never run against the real API. Not support — a compile check. |
| 2026 | `navisworks-2026` | `stub-compiled-unverified` | Same. |

No version is in the `verified` state. Moving one there is a deliberate act taken
with a recorded proof run in hand (docs/WINDOWS-RUNBOOK.md, hard gates 14–17 in
docs/RELEASE-1.0-PLAN.md). Until then: 2025 is the version being brought to proof,
and 2024/2026 are unverified.

All three years compile from one shared source tree, `native/navisworks-adapter/`,
into one assembly per year. NWD has no forward compatibility — an adapter built
against year N cannot open a file published by N+1 — so the launcher selects the
newest installed version and says which one will open the file.

## The normal workflow

1. **Start a project.** One `<YourSite>.matchline` file holds the whole project.
2. **Add sources.** Drop model files and workbooks onto screen 1. A project can
   hold many model sources at once — split or federated, several NWD/NWC/NWF, files
   that share a basename — and they form one equipment universe.
3. **Extraction happens automatically on Windows.** See the note below — on Mac, or
   when a cache came from elsewhere, drop the resulting `.matchline-cache` file
   instead.
4. **Work the wizard.** Nine screens: sources → model scan and Property Catalog →
   asset definition → tag anatomy → System Resolver → Hierarchy Composer →
   relationship rules → preview and QA → publish. Each screen says in plain
   language what it does and previews it against your own data.
5. **Compile.** Nothing is destructive; recompiling is cheap and repeatable.
6. **Review.** Conflicts, duplicates, unresolvable identities, cross-boundary
   demotions and orphaned decisions arrive as review items, never as silent fixes.
7. **Export.** Generated MEL, template MEL, MEL comparison, EXTO workbook,
   predecessor matrix, revision diff.

**Dropping a raw `.nwd`/`.nwf`/`.nwc` now extracts it, on Windows.** The app detects
the installed Navisworks that will open the file, runs the extraction in place with
progress and a Cancel button on the row, and the model joins the equipment universe
automatically once it is ready — nobody names a cache file. Mac development has no
Navisworks to drive, so it still works from cache files: drop the `.matchline-cache`
produced by docs/WINDOWS-RUNBOOK.md's launcher, or by a real Windows machine, in the
same way. The service (Milestone 5 of the 1.0 campaign) is built and tested against a
protocol-faithful fake launcher — docs/EXTRACTION.md has the design — and the first
run against real Navisworks hardware is still ahead of it, docs/RELEASE-1.0-PLAN.md's
Milestone 6.

## Layout

`packages/*` and `apps/*` are npm workspaces.

| Path | What it is |
| --- | --- |
| `packages/domain` | Typed core vocabulary: assets, claims, provenance, hierarchy config, the model universe, `SiteProfileV2`, derived attributes. No runtime dependencies. |
| `packages/model-schema` | Extraction-cache reader and Property Catalog. |
| `packages/tag-anatomy` | Profile-taught tag segmentation. |
| `packages/spreadsheet-import` | Workbook reading (vendored donor SheetJS). |
| `packages/asset-catalog` | Model-first asset universe across every model source. |
| `packages/asset-identity` | Stable asset identity and the identity ledger. |
| `packages/system-resolver` | Ordered system-resolution chain and System Catalog. |
| `packages/identity` | Cross-source identity reconciliation tiers. |
| `packages/connectivity-import` | EasyPower, cable schedule and PMD imports. |
| `packages/electrical-flow` | Electrical Flow projection. |
| `packages/relationship-claims` | Parent/dependency claim assembly. |
| `packages/learned-rules` | Description classification training and self-grading. |
| `packages/ssm-compiler` | Parent ladder, boundary fold, hierarchy tree. |
| `packages/compiler` | Orchestrator: sources plus profile in, compiled project out. |
| `packages/scheduling` | P6 import, milestone ladders, predecessor matrix. |
| `packages/mel-export` | Generated MEL, template fill, comparison, revision diff. |
| `packages/exto-export` | EXTO workbook export. |
| `packages/project-store` | The `.matchline` SQLite project file and its migrations. |
| `packages/legacy-parity` | The SSManagement 4.2.2 donor, unmodified. Plain JS, its own build and tests. Behavioral reference, not a migration target. |
| `apps/desktop` | Electron shell, preload façade, React renderer (wizard + workspace). |
| `native/navisworks-common` | Protocol, DTOs, NDJSON, adapter support table. No Autodesk references, ever. |
| `native/navisworks-adapter` | The one copy of the Autodesk-touching source, plus the shared `.props` each year imports. |
| `native/navisworks-2024/2025/2026` | One `.csproj` and one identity constant per year. |
| `native/extractor` | The net48 launcher: hashing, cache lookup, adapter selection, process control, SQLite writing. |
| `native/navisworks-stubs` | Not shipped. Implementation-free stand-in for the Autodesk API so adapters type-check without an install. |
| `native/smoke` | Not shipped. Runs the Autodesk-free half of the pipeline for real on any OS. |
| `schemas/` | The extraction cache DDL, shared with the C# writer. |
| `tests/integration`, `tests/acceptance-1.0` | Cross-package integration tests and the 1.0 hard-gate acceptance tests. |
| `tsconfig.base.json` | Shared strict TypeScript settings. Every package extends it. |

New typed packages go in `packages/`; anything with a user interface goes in
`apps/`.

## Contributor quick start

Node 24 or newer, and Git.

```sh
git clone https://github.com/noahfgarrett/Matchline.git
cd Matchline
npm ci              # install from the lockfile, exactly
npm run postsetup   # fetches the Electron binary — not optional, see below
npm run build       # type-check and emit every TypeScript package
npm test            # everything (see the caveat below)
```

`npm run postsetup` runs `npm rebuild electron esbuild && node
node_modules/electron/install.js`. The global `~/.npmrc` sets
`ignore-scripts=true` as a supply-chain rule, and Electron 43 has no postinstall
script of its own, so the explicit `install.js` call is what actually downloads the
runtime. Skip it and nothing launches.

Dependencies are pinned to exact versions and every addition is a deliberate,
signed-off decision (docs/DECISIONS.md #5). The engine packages depend on nothing
outside the workspace; the desktop app carries Electron, React, Vite, Zod, TanStack
Virtual and dnd-kit; the repo root carries TypeScript and electron-builder. SQLite
comes from Node's built-in `node:sqlite`, with no driver dependency.

### Mac and Windows

Mac is the primary development machine: the React UI, the compiler, the profile
editor, the project store, spreadsheet import/export and every engine test run
against captured extraction fixtures, with no Navisworks anywhere. The C# launcher
and the Autodesk-free half of the extraction pipeline also build and run on macOS
and Linux (`dotnet build native/extractor/...`, `dotnet run --project
native/smoke/...`), and the adapters type-check against `native/navisworks-stubs`.

Windows is required for anything that touches a real model: compiling an adapter
against the real Autodesk assembly, running the extractor, and the proof run.
docs/WINDOWS-RUNBOOK.md is that path. Packaging is not Windows-only — the Windows
installer cross-builds on a Mac.

### Tests

```sh
npm test                  # workspaces → legacy → integration → 1.0 acceptance gates
npm run test:workspaces   # typed packages only — fast
npm run test:legacy       # the donor suite
npm run test:integration  # cross-package pipeline tests
npm run test:acceptance10:green   # the 1.0 gates that are wired to real behaviour
```

`tests/acceptance-1.0/` is deliberately part red: it describes 1.0 milestones, and
each milestone adds its file to `test:acceptance10:green` as it lands. Run
`npm run test:acceptance10` to see the whole set, red files included.

**Plain `npm test` does not pass on a machine that is not the maintainer's.** The
donor suite includes differential tests that compare against a frozen SSM Builder
checkout at an absolute path that exists only on Noah's Mac, plus wall-clock
performance budgets that shared hardware fails for reasons unrelated to the change.
CI excludes both by name. To run what CI runs:

```sh
npm run build && npm run test:workspaces && npm run test:integration \
  && npm run test:acceptance10:green \
  && (cd packages/legacy-parity && node --test \
      --test-skip-pattern "frozen SSM Builder|preserves a frozen edge contract|budget" \
      tests/*.test.mjs)
```

The donor package can also be driven directly, which is the better option when
working inside it:

```sh
cd packages/legacy-parity
npm run build   # regenerates the single-file SSManagement.html
npm test
```

### Packaging

```sh
npm run build:desktop
npm run package:win    # NSIS installer + portable zip → apps/desktop/release
npm run package:mac    # macOS zip
```

Both work from either OS. Every build produced so far is **unsigned**: the
code-signing certificate does not exist yet, so Windows SmartScreen warns about it
(docs/INSTALL-TRY-IT.md §3 walks through that) and macOS quarantines a downloaded
copy. `.github/workflows/ci.yml` packages Windows unsigned on every push as a smoke
test and consumes no signing secrets at all.

### Release

Releases are tag-driven and are documented in **docs/RELEASE-RUNBOOK.md** — the
workflow inventory, the secrets and where each one goes, getting the certificate,
the self-hosted Navisworks runner, the manual offline installer path, and what the
update path must never do. `.github/workflows/release.yml` fails loudly and
immediately when production signing credentials are absent rather than publishing
an unsigned release; there is no unsigned release path on purpose.

## Formats and versions

| Format | Version | Where it is defined |
| --- | --- | --- |
| `.matchline` project file (SQLite) | schema **v7** | `packages/project-store/src/schema.ts`, migrations in `migrations.ts` |
| Site Profile | **`SiteProfileV2`** | `packages/domain/src/profile-v2.ts` |
| Portable profile package | format **v2** | `apps/desktop/electron/services/profile-package.ts` |
| Extraction cache (SQLite) | schema **v1** | `schemas/extraction-cache.sql` |

A project file opened by a newer build is migrated only after explicit
confirmation, and only after an automatic backup copy is written; a version the
build has no migration step for is refused and left exactly as found. A v1 profile
package is migrated on import, never refused.

## No client data, ever

Every fixture, model, tag, description and workbook in this repository is invented.
The fixture site is codenamed **Dragon** and nothing about it is real
(docs/DECISIONS.md #6).

Client models, client registries and client exports are never committed, never
uploaded and never attached to an issue or a CI artifact. The self-hosted
Navisworks proof workflow runs against a model that already sits on the runner's
own disk, and the only artifact it uploads is an anonymized summary — counts and
timings, no tags, no file names, no property values. Dry runs against real
registries happen locally and their outputs stay local.

## Where this came from

This repo is a history-preserving fork of SSManagement 4.2.2. The full donor tree
is preserved at tag `ssmanagement-origin-4.2.2` and still lives, working and fully
tested, in `packages/legacy-parity`. It is the behavioral reference: as typed
packages take over its responsibilities, the donor suite is what proves nothing
regressed. It is deliberately kept out of the TypeScript build.

docs/ORIGIN.md records what was inherited and what was deliberately changed.

## Status

The repository version is 0.8.1 and the work toward 1.0.0 is in progress on a
branch. docs/RELEASE-1.0-PLAN.md holds the directive and the live gate tracker;
docs/STATUS.md holds the build log. Known-open, and stated here so nothing above
reads as a promise: the real Navisworks hardware proof (in-app extraction is built
and tested against a protocol-faithful fake, but has never driven the real
Autodesk API), code signing, the update path, and verification of the 2024/2026
adapters.
