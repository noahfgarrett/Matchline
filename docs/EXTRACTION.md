# EXTRACTION — Navisworks metadata extraction architecture

Phase 1 scope (PRODUCT.md §6, §19). Confirmed platform constraints in DECISIONS.md apply:
licensed Navisworks Manage/Simulate required, .NET Framework 4.8, no NWD forward compatibility.

## Process model

```
Electron main: NavisworksExtractionService (apps/desktop)
└── launches → Matchline.Extractor.exe (net48 console, "the launcher")
               ├── sha256(input.nwd) → cache hit? exit early with result
               ├── launches Navisworks -NoGUI -ExecuteAddInPlugin MatchlineExtract ...
               │        └── plugin (net48 DLL) walks the model, streams NDJSON → temp file
               ├── converts NDJSON stream → SQLite cache (Microsoft.Data.Sqlite)
               ├── writes to <sha256>.sqlite.partial, fsync, atomic rename → <sha256>.sqlite
               └── emits JSON-lines progress on stdout; accepts "cancel" line on stdin
```

Design calls, and why:

1. **The plugin never writes SQLite.** Loading native SQLite binaries inside the Navisworks
   plugin AppDomain is fragile and pollutes the Autodesk process. The plugin only streams
   NDJSON records to a temp file; the launcher (our own process) owns the SQLite conversion.
   Cost: one extra sequential read/write of the metadata stream. Revisit only if real-model
   timings demand it.
2. **Atomic cache commit.** All SQLite writing happens against `<sha>.sqlite.partial`; the
   real filename appears only via rename after integrity checks (`meta.object_count` matches).
   A killed/cancelled/crashed extraction leaves no valid-looking cache — worker failure
   cannot corrupt anything (Phase 1 exit criterion).
3. **Worker exits after each extraction** to reclaim Autodesk memory (PRODUCT.md §14).
4. **Cache reuse by content hash.** `%LOCALAPPDATA%\Matchline\cache\models\<sha256>.sqlite`.
   Unchanged NWD → launcher reports `cache-hit` without touching Navisworks.
5. **Determinism.** Objects are recorded in depth-first document order with explicit
   `(parent_id, path_index)`; properties in encounter order per object. Same NWD → same
   cache content (excluding `extracted_at_utc`).

## The extraction service (Electron main)

`apps/desktop/electron/services/extraction-service.ts` is the half of the pipeline that
lives in the app, and it is what makes "drop an NWD" the whole of the user's job
(RELEASE-1.0-PLAN P0-2). Dropping an `.nwd`, `.nwf` or `.nwc` on screen 1 registers a model
source with no cache and queues an extraction for it; the row then carries the job's own
status — `queued`, `hashing`, `opening`, `extracting`, `finalizing`, then `ready`,
`cache-hit`, `cancelled` or `failed` — with a progress fraction where the stage knows its
total, the launcher's `detect` sentence naming the Navisworks that will open the file, any
forwarded warnings, and a Cancel button. When the run finishes the service validates the
cache (it opens, it holds objects, and its `meta.input_sha256` is the file that was
hashed), records the cache's hash against the source and opens it. Nobody names a cache
file, and none has to be produced by hand.

Four rules the service keeps, and why:

- **Serial by default.** One headless Navisworks at a time. Two on a real machine is slower
  than two in sequence and can fail outright, so the rest of the queue says so in the row.
- **Streaming SHA-256 everywhere.** A model may be gigabytes; nothing reads one into a
  buffer to hash it, and the main process keeps drawing while it does.
- **Cache reuse before anything is launched.** The service checks
  `<cache dir>/<sha256>.sqlite` itself, so re-adding an unchanged model never starts
  Navisworks. The launcher checks again on its own, for the same reason, when it is run
  directly.
- **Cancellation is the launcher's own.** A `cancel` line on stdin, which makes the launcher
  kill the Navisworks it started and delete its partials; SIGTERM and then SIGKILL only if
  that is ignored. The service then checks no `.partial` survived, because a killed
  launcher never got to.

Every launcher error code and every service-level failure maps to one plain-language
sentence that names what the user can do, in
`apps/desktop/electron/services/extraction-messages.ts` — one table, so a code cannot reach
a screen without copy. Extraction runs on Windows; on any other machine the queued job fails
immediately with `extraction-unavailable-on-this-platform`, whose sentence says extraction
happens on Windows and that a `.matchline-cache` produced elsewhere can be added instead.

The launcher is reached through an injectable seam
(`ExtractorLauncher = (args, callbacks) => ExtractorChild`), so the whole flow is exercised
on a machine with no Navisworks: `apps/desktop/test/fake-extractor.mjs` is a second
implementation of the launcher's side of the protocol, run as a real child process, writing
a real cache.

## Protocol (launcher stdout, JSON lines)

```
{"type":"progress","stage":"hash|detect|open|walk|convert|finalize","done":123,"total":4096}
{"type":"progress","stage":"detect","done":1,"total":1,"detail":"Navisworks Manage 2025 (C:\\...) will open this file; expecting adapter navisworks-2025."}
{"type":"warning","code":"...","message":"...","objectId":123}
{"type":"result","status":"ok|cache-hit","cachePath":"...","objects":131000,"warnings":2}
{"type":"error","code":"NW_VERSION_TOO_NEW|NW_NOT_INSTALLED|OPEN_FAILED|CANCELLED|...","message":"..."}
```

`detail` is optional and carries a human-readable sentence; only the `detect` stage emits one
today, and a reader must not require it on any stage.

Cancellation: a single `cancel\n` line on launcher stdin → launcher kills the Navisworks
process, deletes partials, exits with `{"type":"error","code":"CANCELLED"}`.

`NW_VERSION_TOO_NEW` is mandatory messaging: an NWD published by a newer Navisworks than the
installed adapter supports must produce this error verbatim-mapped to a plain-language UI
string ("This file needs a newer Navisworks"), never a generic open failure.

## Cache schema

Canonical DDL: [`schemas/extraction-cache.sql`](../schemas/extraction-cache.sql). Version 1.
Writers stamp `meta.schema_version`; readers hard-refuse unknown versions. No geometry beyond
optional bounding boxes (PRODUCT.md §6.4 — no geometry in first production).

## Reading side (`packages/model-schema`)

TypeScript package, zero npm dependencies (`node:sqlite`). Responsibilities:

- Open + validate a cache (schema version, required meta keys, object-count integrity).
- Typed accessors: meta, source-model tree, object tree traversal, per-object properties.
- **Property Catalog** computation (PRODUCT.md §6.5): per `(category, name)` — coverage,
  distinct count, example values, per-source-model consistency. Phase 1 ships the statistics;
  role *suggestions* (tag/building/system heuristics) are Phase 2, where mapping UX lives.
- Deterministic synthetic fixture: the "Dragon" site generator builds a small cache at test
  time (never a committed binary, never real project data).

## Multi-version adapters

`native/navisworks-common` holds everything Autodesk-independent: DTOs, the NDJSON protocol,
cache conversion, ordering, the stream session (header meta, terminator, failure
classification) and the warning policy. `native/navisworks-adapter` holds the single physical
copy of the Autodesk-touching code — document walk, property and variant reads, selection-set
traversal. Each supported year is a project that compiles that shared source into its own
assembly (`Matchline.Extraction.Navisworks2024`, `…2025`, `…2026`) against its own install
path. The only per-year source file is the release year itself, which is what stamps
`meta.adapter_version` (`navisworks-2024` / `navisworks-2025` / `navisworks-2026`). The plugin
id stays `MatchlineExtract.MTCH` for every year: one adapter is deployed per install, so two
ids never meet.

Selection policy: the launcher probes the default install locations, then picks the **newest
installed year that Matchline has an adapter for**, preferring Manage over Simulate at the same
year (DECISIONS.md — an NWD has no forward compatibility). It emits a `detect` progress line
naming the product, year and install folder that will open the file, so a run is never
ambiguous about which version produced the cache. `--navisworks-version <year>` pins a year;
`--navisworks-dir <dir>` pins a folder. "No Navisworks installed" and "Navisworks installed,
but no release Matchline has an adapter for" are different errors, and the second one lists
what it found.

**Verified support.** `SupportedAdapters` in `navisworks-common` is the single source of truth
and the launcher reads it, so what the code claims and what this table says cannot drift:

| Year       | Status                     | What that means                                                                                        |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2025       | `pending-real-proof`       | Compiles. The Windows proof run (WINDOWS-RUNBOOK.md) has not happened, so nothing has been extracted yet. |
| 2024, 2026 | `stub-compiled-unverified` | Type-checks against `navisworks-stubs` only. Never built against, or run on, a real install of that year. |

No year is `verified`. Until one is, the launcher emits an `ADAPTER_UNVERIFIED` warning naming
the status on every run, and Matchline must not advertise that year as supported
(RELEASE-1.0-PLAN.md). Flipping a year to `verified` is one edit in `SupportedAdapters`, taken
with a recorded proof run in hand.

## Confidentiality

Real NWDs and caches derived from them are client data: never committed, never named in
code/tests/fixtures. Committed fixtures use the invented **Dragon** site only. The cache
stores file *names*, never directories, to avoid leaking local paths into portable packages.

## Validation (Windows)

The proof run follows [`docs/WINDOWS-RUNBOOK.md`](WINDOWS-RUNBOOK.md): build the solution,
drop a real NWD on screen 1, and verify cache integrity, reuse and cancellation through the
app — then report counts and timings back. The runbook's manual launcher invocation is kept
as the diagnostic path, for when the app-driven run needs to be taken apart. The C# code was
authored on the Mac without compilation until that run — treat the first Windows build as
part of the proof, not a formality.
