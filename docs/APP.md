# APP — desktop application architecture

Implements PRODUCT.md §14–§16, as amended by RELEASE-1.0-PLAN.md (see PRODUCT.md §0 for
the as-built deviations). Stack per DECISIONS.md #5: Electron, React, TypeScript, Vite,
TanStack Table/Virtual, dnd-kit, Zod — pinned exact. No Zustand (React state until proven
insufficient). SQLite via Node's built-in `node:sqlite` — no driver dependency.

## Process model (PRODUCT.md §16)

```
apps/desktop/electron/   main process (TypeScript → tsc)
  ├── window/lifecycle, file dialogs
  ├── ProjectStore service (node:sqlite — main process only)
  ├── project session: every open model cache, the draft profile, derived engine state
  ├── compile service (runs @matchline/compiler; worker_threads when slow)
  └── IPC: ipcMain.handle per channel, every payload Zod-validated, sender-checked
apps/desktop/preload/    contextBridge → window.matchline.<domain>.<verb>(...)
  └── typed façade only — no logic, no Node APIs leaked
apps/desktop/renderer/   sandboxed React (Vite)
  └── nodeIntegration false, contextIsolation true, sandbox true, strict CSP,
      no remote content, all data via the preload façade
```

Security defaults are §16 verbatim; deviations require a DECISIONS.md entry. Navigation
lockdown is registered on `app.on('web-contents-created')` — `will-navigate`,
`will-frame-navigate`, `will-attach-webview` and `setWindowOpenHandler` — so it covers
contents the shell never constructs itself; origins are compared for exact equality
(scheme + host), never by prefix. Every web permission is denied outright (request and
check handlers both). The spell checker is switched off in `webPreferences` and on the
session: Chromium fetches dictionary files from Google on first use, which would be the
only network call this app makes (PRODUCT.md §2.6). File paths from the renderer are not
authority either — a path is usable only after a native dialog returned it, or after main
handed it over in the recents list (`electron/security/path-grants.ts`). Drag-and-drop is
the one path that arrives with no grant behind it (a `File` carries no path since Electron
43; the preload recovers it with `webUtils.getPathForFile`), so it gets its own channel:
`source:add-dropped` screens the path in main — regular file, source extension, size cap —
registers it, and mints no grant, so a drop can add a source and nothing else.

## Many model sources, one universe

A project registers a **set** of model sources, not one file, and every one of them with a
readable cache is open at once (RELEASE-1.0-PLAN P0-1). The session keys them by
`sourceId` — the project's own identity for a registered file — rather than by name,
because two consultants really do both ship `Level 1.nwc` and keying on the basename would
silently drop one of them (hard gate 4).

What that buys, and what it costs:

- An **extraction cache handle** belongs to one source. It opens when that source becomes
  ready and closes when the source is removed, replaced with different bytes, or the
  project closes. Reconciliation is per source, so replacing one file never re-opens the
  others' caches.
- The **universe Property Catalog** is a streaming pass over every open cache, built on
  demand and memoized against the exact set of `(sourceId, cache hash)` pairs it was built
  from. Screen 2 pays for it once.
- The **asset catalog** and the **resolver subjects** depend on the draft profile *and* on
  the universe, so they are memoized against both and dropped the moment either changes.
  Serving a stale catalog would be fast and wrong.

Nothing expensive crosses IPC: the caches, the Property Catalog, the asset catalog and the
resolver subjects never leave the main process.

## Extraction

Reading a model needs Navisworks on Windows. The C# launcher and the version adapters, the
cache schema, the NDJSON protocol, cache-hit behaviour and the error vocabulary are all
documented in **docs/EXTRACTION.md**, with the operator path in
**docs/WINDOWS-RUNBOOK.md**; this document does not repeat them. Milestone 5 of the 1.0
campaign (hard gate 1 in RELEASE-1.0-PLAN.md) put the rest of that pipeline in the app:
dropping a `.nwd`/`.nwf`/`.nwc` on Windows registers the source and queues it on
`NavisworksExtractionService` (`apps/desktop/electron/services/extraction-service.ts`), a
serial queue that streams the file's SHA-256 rather than buffering it, detects the
Navisworks install that will open the file, and drives `Matchline.Extractor` through the
same JSON-lines protocol the manual launcher speaks — mirrored in
`extraction-protocol.ts` and reached through the injectable `ExtractorLauncher` seam in
`extractor-launcher.ts`, so the whole flow runs against a protocol-faithful fake with no
Navisworks anywhere. Every launcher error code and service-level failure maps to one
plain-language sentence in `extraction-messages.ts` — a single table, so a code cannot
reach a screen without copy. When a run finishes, the service validates the cache, records
its hash against the source and opens it automatically; nobody names a cache file. A model
source still lands on `.matchline-cache` files where there is no Navisworks to drive — Mac
development, or a cache produced by the manual launcher — and those still just get dropped
in and read.

The service is built and covered by its own suite (`apps/desktop/test/
extraction-service.test.mjs`, 17 tests) against the fake launcher; the real Autodesk path —
running this against an actual Navisworks install — is the Milestone 6 proof in
RELEASE-1.0-PLAN.md and has not happened yet.

## IPC contract

One shared module (`apps/desktop/shared/ipc.ts`) declares every channel: name, Zod
request schema, Zod response schema. Main registers from the declaration table; preload
generates the façade from the same table — a channel cannot exist without its schema. Each
declaration also carries a worked request/response example, and `test/ipc-table.test.mjs`
validates those examples against the schemas, so a documented example that stops being
true fails the build. Large payloads (extraction caches, compiled projects) never cross
IPC wholesale: the renderer asks for pages/summaries (TanStack Virtual consumes windowed
slices).

What the 1.0 campaign changed here is mostly shape rather than surface. One channel is
new — `compile:ledger-events`, one page of what the identity ledger did during a compile
(P0-9). The rest is widening: `source:add`, `source:add-dropped`, `source:list` and
`source:remove` speak `sourceId` and separate `logicalName` from `rawFileName` and the raw
hash from the derived cache hash; `model:scan`, `model:property-page`, `model:class-list`
and `asset:preview` report per-source as well as overall coverage and impact;
`hierarchy:attributes` includes the profile's derived attributes; `config:get`/
`config:update` now carry only the captured EXTO template (see below); and
`profile:sections`, `profile:export` and `profile:import` speak `SiteProfileV2` and
format-v2 packages.

## Project file (PRODUCT.md §15)

`ProjectName.matchline` = SQLite, **schema v6**. Tables:

- `meta` — schema version, app version, name, created/modified.
- `sources` — one row per registered file, keyed by `source_id`: `role`, `logical_name`,
  `raw_file_name`, `raw_sha256`, `raw_byte_size`, `derived_cache_sha256`, `added_at`. No
  absolute paths, so the project stays portable.
- `profile` — append-only `SiteProfileV2` revisions. A site's whole rule set is one
  document: mappings (with per-source overrides and ordered fallback chains), source
  assignment rules, filters, anatomy, resolver, derived attributes, hierarchy levels with
  their key/display/boundary attributes, boundaries, role graph, ladder, discipline
  projection, explicit parent properties, identity normalization and aliases, authority
  rules and profile test examples.
- `learned` — learned-rule sets and item-master/WBS tables (JSON).
- `overrides` — manual system and relationship overrides, keyed by `(kind, asset_key)`.
- `compiles` — history: input hashes, profile revision, stats JSON (including the
  generated-MEL assets a diff baseline needs), timestamps.
- `snapshots` — the latest resolved snapshot, `slot` pinned to 0.
- `ledger` — the asset identity ledger the latest compile wrote, `slot` pinned to 0, so an
  `assetId` outlives the tag it was first derived from and every manual decision recorded
  against that id keeps applying.
- `decisions` — review decisions.
- `config` — **the captured EXTO template, and nothing else.** Everything this table used
  to hold — hierarchy, role graph, ladder, discipline projection, parent-tag property, and
  later the derived attributes and assignment rules — is a decision about how the *site*
  works, and a site's decisions are one document now. They live in the profile. The EXTO
  template stays because it is not a rule: it is the layout of *this* project's own
  registry workbook. The CHECK constraint still admits the older keys so a pre-consolidation
  file can be read; those rows are merged into a new profile revision the first time the
  project is opened and then removed, because a value in two places is a value that can
  disagree with itself.
- `migrations` — what ran, and when.

`profile`, `learned` and `decisions` are append-only: "what did this project believe last
Tuesday" is a question reviewers actually ask.

### Migration chain

Every step is opt-in and preceded by an automatic backup copy. `project:open` answers an
older file with a `migration-needed` result instead of a project, and the renderer's
confirm card sends `acceptMigration: true` on the second call. A version with no step is
refused, and the file is left exactly as found.

- **v1 → v2** — adds `config`, so a project carries its own configuration instead of the
  app's machine-local state file keyed by path.
- **v2 → v3** — widens two CHECK constraints: an `extoTemplate` config section, and `'wbs'`
  as a third `learned.kind`. Both tables are rebuilt and copied row for row.
- **v3 → v4** — source identity. `sources` is re-keyed from `(role, file_name)` to a
  caller-supplied `source_id`, splits `logical_name` from `raw_file_name` and `raw_sha256`
  from `derived_cache_sha256`, and re-keys `compiles.input_hashes_json` to match.
- **v4 → v5** — adds the `ledger` table. Purely additive.
- **v5 → v6** — widens the `config` CHECK by `derivedAttributes` and `sourceAssignmentRules`.
  Nothing is back-filled: a project that configured neither has no row for them.
- **SiteProfileV2** — not a schema step but part of the same opening. A stored v1 profile
  revision is lifted on read, the legacy `config` sections are merged into a new revision
  the first time the project opens, and a v1 profile package is migrated on import rather
  than refused.

Transactional writes throughout; a `schema_version` gate like the extraction cache's.

The app-state JSON holds only recents and the sha256→path index. That index is a
convenience, never authority: reopening a project re-digests each file it points at, and
one whose bytes no longer match the recorded hash is shown as `file-changed` (distinct
from `file-missing`) and refuses to compile until it is added again.

Extraction caches stay in `%LOCALAPPDATA%/Matchline/cache/models/` (or the platform
equivalent via `app.getPath`) — referenced by hash from `sources`, never embedded.

## Install-script policy

The global `~/.npmrc` sets `ignore-scripts=true` (supply-chain rule). After any fresh
`npm ci`/`npm install`, run the root `postsetup` script: `npm rebuild electron esbuild &&
node node_modules/electron/install.js`. (Electron ≥43 has no postinstall script at all —
the explicit `install.js` invocation is what actually fetches the binary; the rebuild half
covers any future dep that reintroduces install scripts. Vite 8 uses rolldown, so esbuild
is not in the tree; the rebuild is a harmless no-op for it.) Never widen this list without
a DECISIONS.md entry.

## UI surface (built across A1 rounds, extended in the 1.0 campaign)

Wizard screens 1–9 (PRODUCT.md §7) → project workspace: SSM tree + Electrical Flow views
(virtualized), review queue, Site Profile Studio, exports panel. Drag reparent creates a
persistent ManualRelationshipOverride via IPC (never a tree-local mutation — §11.5); a
manual parent that crosses an enabled boundary is demoted to a dependency with a review
item, like any other parent. Screen 3 picks the tier-1 stable id property; screen 6
exposes each level's key, display and boundary attributes, with the two optional ones
behind a disclosure that opens when a level uses them; screen 9 shows a "before you
publish" card summarising levels, boundaries, what each boundary compares and the
cross-boundary consequence, and Save revision stays disabled until it is confirmed — once
per publish, reset by every profile edit. Plain-language UI text throughout: what it does,
an example, when to change it.

Still open as of this writing: editors for the property chains, the source assignment
rules and the derived-attribute registry. All three sections travel in the profile and are
honoured by the compiler; screen 3 edits one property per field and the profile keeps the
rest.
