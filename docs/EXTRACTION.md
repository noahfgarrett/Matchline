# EXTRACTION — Navisworks metadata extraction architecture

Phase 1 scope (PRODUCT.md §6, §19). Confirmed platform constraints in DECISIONS.md apply:
licensed Navisworks Manage/Simulate required, .NET Framework 4.8, no NWD forward compatibility.

## Process model

```
Electron main: NavisworksExtractionService (apps/desktop)
└── launches → Matchline.Extractor.exe (net48 console, "the launcher")
               ├── sha256(input.nwd), or --input-sha256 from the caller
               │        → cache hit? exit early with result
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
   Unchanged NWD → launcher reports `cache-hit` without touching Navisworks. The hash is
   computed once per file, not once per process: see `--input-sha256` below.
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
- **Streaming SHA-256 everywhere, and once.** A model may be gigabytes; nothing reads one
  into a buffer to hash it, and the main process keeps drawing while it does. The service
  streams the hash when the file is registered and then passes it on the launcher's command
  line (`--input-sha256`), so the same bytes are not read a second time by the launcher to
  reach the same answer. That is safe here because the two reads would be of the same file:
  a source whose bytes have changed since it was registered is `file-changed` and is not
  extracted or compiled from until it is added again, which re-digests it.
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

## The command line

```
Matchline.Extractor --input <file.nwd> [--cache-dir <dir>] [--navisworks-dir <dir>]
                    [--navisworks-version <year>] [--input-sha256 <hex>]
                    [--stall-timeout-seconds <n>]
```

`--input` is the only required argument. `--navisworks-dir` and `--navisworks-version` both
pin the install to use and are refused together, because a caller that passed both meant one
of them and the launcher cannot know which.

`--input-sha256` is the input's SHA-256, already computed by the caller: 64 hex digits, case
folded, anything else refused at parse time with `INVALID_ARGS`. When it is supplied the
launcher **does not read the file to hash it** — it reports the `hash` stage as complete with
the file's real size and goes straight to the cache-hit check. The value is **trusted**, not
verified: verifying it would be the read the flag exists to avoid. It is what the cache is
filed under and what the cache records as `meta.input_sha256`, so a caller that supplies a
hash of different bytes gets a cache under a name nothing will find again. Pass it only when
you hashed the very bytes the run will open.

Absent, the launcher hashes the input itself, exactly as it always did — which is what a
person running it by hand from a shell gets, and what docs/WINDOWS-RUNBOOK.md's manual
invocation exercises.

`--stall-timeout-seconds` is how long Navisworks may write nothing before it is killed and
the run fails with `NW_STALLED`. Default 900 (fifteen minutes); `0` waits forever. "Writing
nothing" means the NDJSON stream has not grown and no plugin-side progress record has
arrived — the two things the launcher can see from outside the Navisworks process. It is
not "no CPU" and not "no window": a Navisworks sitting on a modal dialog is perfectly busy,
and that dialog is the commonest reason a headless run goes quiet. The desktop app passes
this flag explicitly, with the same default, and warns in the row after ten minutes of
silence — earlier than the kill on purpose, so the user gets the chance to decide before
the launcher does.

## Protocol (launcher stdout, JSON lines)

```
{"type":"progress","stage":"hash|detect|open|sets|walk|convert|finalize","done":123,"total":4096}
{"type":"progress","stage":"detect","done":1,"total":1,"detail":"Navisworks Manage 2025 (C:\\...) will open this file; expecting adapter navisworks-2025."}
{"type":"warning","code":"...","message":"...","objectId":123}
{"type":"result","status":"ok|cache-hit","cachePath":"...","objects":131000,"warnings":2}
{"type":"error","code":"NW_VERSION_TOO_NEW|NW_NOT_INSTALLED|OPEN_FAILED|CANCELLED|...","message":"..."}
```

`detail` is optional and carries a human-readable sentence; only the `detect` stage emits one
today, and a reader must not require it on any stage.

`sets` is saved-set resolution, between the open and the walk. Every set is resolved BEFORE the
tree walk starts, so the walk can write each item's membership row as it reaches that item —
which is what keeps the plugin from holding a live handle on every object in the model until
the last set is done. It is its own stage because resolving one saved search runs that search
over the whole document: a set-heavy model sits there for minutes before a single object
record is written, and without a line of its own the run looks like an open that never
finished. Unlike the walk and the convert it knows its total, because the set tree is counted
before the first one is resolved.

### Error codes

| Code | Exit | What it means |
| ---- | ---- | ------------- |
| `NW_VERSION_TOO_NEW` | 5 | Published by a newer Navisworks than the installed adapter. Mandatory messaging (below). |
| `NW_NOT_INSTALLED` | 4 | No licensed Manage/Simulate found, or none with an adapter. |
| `OPEN_FAILED` | 6 | Navisworks could not open the file, for any other reason. |
| `EXTRACT_FAILED` | 7 | The stream started and did not finish. |
| `NW_STALLED` | 10 | Navisworks wrote nothing for `--stall-timeout-seconds` and was killed. Nearly always a hidden dialog. |
| `PLUGIN_NOT_DEPLOYED` | 11 | Pre-flight: the adapter DLL is not in either Plugins root for the chosen install. Navisworks is never started. |
| `PLUGIN_NOT_FOUND` | 12 | Navisworks ran and exited without the plugin creating the stream at all. |
| `SOURCE_MODEL_MISSING` | 13 | The document opened without one or more of the files it references. The stream is complete and correct and describes less than the input does, so no cache is committed. |
| `CACHE_WRITE_FAILED` | 8 | The stream was complete and the cache could not be written or verified — SQLite errors included. |
| `INPUT_NOT_FOUND` | 3 | The input was gone by the time the run reached it. |
| `INVALID_ARGS` | 2 | A wrong command line. |
| `CANCELLED` | 9 | A `cancel` line on stdin, or — when stdin was redirected — its EOF, which is a parent that has died. |
| `INTERNAL` | 1 | Anything else. |

Every one of these has a plain-language sentence naming an action in
`apps/desktop/electron/services/extraction-messages.ts`, and a test refuses to let a code
exist without one.

### Ending the run

The launcher stops waiting on Roamer for one of four reasons, and they are different facts:

1. Roamer exits by itself.
2. The **terminator record** appears in the stream. The extraction is then complete whatever
   Roamer does next, so it gets a 30-second grace period to close on its own and is killed
   after that. A GUI executable that will not exit is not a reason to hold the queue behind a
   cache that is already written.
3. The stream stops growing for `--stall-timeout-seconds` → `NW_STALLED`.
4. A cancel arrives → `CANCELLED`.

The Navisworks process is assigned to a Windows **Job Object** with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` immediately after it starts, so a launcher that is
terminated outright — which runs no cleanup at all — cannot leave a headless Navisworks
holding a licence. A machine where the job cannot be created still extracts; it emits a
`JOB_OBJECT_UNAVAILABLE` warning and loses only the backstop.

Roamer is also given `-log "<cacheDir>\<sha>.roamer.log"` (VERIFY-ON-WINDOWS: the switch is
assumed, and dropping it is the first thing to try if Roamer refuses the command line). It is
Navisworks's own diagnostic log and the only channel that can say anything about a run that
produced no stream, so it is deleted on success and kept — and named in the error detail — on
failure.

Before Navisworks is started at all, the launcher checks that the adapter DLL is deployed:
`<install>\Plugins\Matchline.Extraction.Navisworks<year>\Matchline.Extraction.Navisworks<year>.dll`,
or the same path under the per-user root
`%APPDATA%\Autodesk Navisworks <Product> <year>\Plugins\`. Either is accepted; which one
Navisworks actually scans is what the proof run settles. An install whose year cannot be read
(only reachable through `--navisworks-dir`) skips the check rather than failing it.

The `hash` stage is always announced, whether the launcher computed the hash or was given
one: with `--input-sha256` it is a single line already at `done == total`, and without it the
line opens at `done: 0` and is repeated as the read progresses. A reader must not infer from
one `hash` line that a run stalled, and must not require more than one.

Cancellation: a single `cancel\n` line on launcher stdin → launcher kills the Navisworks
process, deletes partials, exits with `{"type":"error","code":"CANCELLED"}`.

`NW_VERSION_TOO_NEW` is mandatory messaging: an NWD published by a newer Navisworks than the
installed adapter supports must produce this error verbatim-mapped to a plain-language UI
string ("This file needs a newer Navisworks"), never a generic open failure.

## NWF inputs

An NWF holds a **list of references**, not a model, and that changes two things.

**It is never served from cache without being opened again.** Its bytes can be identical while
the models behind them have moved, been replaced or gone missing, so the content hash addresses
the wrong thing. The launcher skips its pre-run cache-hit check for a `.nwf`
(`ExtractionRunner.IsReferencingInput`) and so does the desktop service
(`isReferencingInput` in `extraction-protocol.ts`) — both, because skipping it in one place
would leave the other serving the stale answer. The cache is still **filed** under the input
hash, because that is what the caller asked about.

**A document that opened without one of its models is a failure, not a smaller success.** The
plugin cannot report this to the launcher any other way — the launcher has no way to open an
NWF without the Navisworks it is starting — so it writes one `ref` record per
`Document.Models` entry before anything else:

```
{"t":"ref","sfile":"B14-Electrical.nwc","loaded":true}
```

A reference counts as **not loaded** only when its model's root item has no children AND its
source file is not on disk. Either alone is ordinary (an appended file may legitimately be
empty; a file loaded from a path that has since moved is still loaded), and a check that
cannot be made answers "loaded" — this decides whether a whole extraction is thrown away, so
it never guesses towards failure. Each one that did not load also produces an
**error-severity** `SOURCE_MODEL_MISSING` warning naming the file.

The launcher collects every error-severity warning as it converts the stream and refuses to
commit the cache when there is one, failing `SOURCE_MODEL_MISSING`. Nothing else catches this:
the walk did not fail, so the terminator says `ok` and every integrity check the cache runs
against itself passes — on a document with a whole discipline absent. The `ref` records
themselves are not a cache table; what reaches the cache is the warning.

## Cache schema

Canonical DDL: [`schemas/extraction-cache.sql`](../schemas/extraction-cache.sql). **Version 3.**
Writers stamp `meta.schema_version`; readers hard-refuse unknown versions and
`packages/model-schema` still opens v1 and v2. No geometry beyond optional bounding boxes
(PRODUCT.md §6.4 — no geometry in first production).

- **v1** — the original shape.
- **v2** — `selection_sets.membership_resolved`: a set that resolved to nothing is a different
  row from a set nobody managed to resolve. A v1 row is read as resolved for `folder` and
  `selection` and unresolved for `search`, which is what a v1 writer actually meant.
- **v3 — persistent per-object identity.** `objects` gains `authoring_id_kind` (which
  well-known property pair produced `authoring_id`: `revit-element-id`, `revit-unique-id`,
  `ifc-global-id`, `dwg-handle`), `structural_key` (a lowercase SHA-256 over the ancestor chain
  of `(class_name, display_name, path_index)` from the source model's root, chained through the
  parent's digest so inserting a sibling changes that sibling and every one after it and
  nothing before it), and `flags` (a bitfield: 1 hidden, 2 layer, 4 insert, 8 composite,
  16 collection, 32 has-model). `source_models` gains `source_file_name` (`Model.SourceFileName`,
  name only) and `source_guid`. `selection_sets` gains `guid` (`SavedItem.Guid`, which survives
  a rename). `meta` gains two OPTIONAL keys, `units` and `ui_language` — optional because every
  cache written by an older adapter lacks them, and `ui_language` matters because Navisworks
  localises property and category display names.

The reader chooses its column list from the declared version rather than probing the table:
a v1/v2 file would fail a v3 query outright, and a file declaring v3 without the columns is
corrupt and should say so. On a v1/v2 cache the v3 columns read as `null` — including `flags`,
which is `null` rather than "nothing is set", because an older writer never looked.

`authoring_id_kind` is part of the identity rather than a label on it: a Revit ElementId and an
AutoCAD handle can be the same digits and name different objects, so `@matchline/asset-identity`
keys the authoring-id tier on the pair. `structural_key` is its own evidence tier, below the
child-index `structural` path (it folds display names in, so a renamed level breaks it) and
above `tag`.

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

**Adapter status — none verified yet.** `SupportedAdapters` in `navisworks-common` is the single source of truth
and the launcher reads it, so what the code claims and what this table says cannot drift:

| Year             | Status                     | What that means                                                                                          |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| 2024, 2025, 2026 | `stub-compiled-unverified` | Type-checks against `navisworks-stubs` only. Never built against, or run on, a real install of any year. |

2025 was labelled `pending-real-proof` until that state was read back against its own
definition — "compiles against the real Autodesk assembly" — which has never happened here.
The label was corrected rather than the definition.

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
authored on the Mac and compiles cleanly there (SDK 8 cross-targeting, WINDOWS-RUNBOOK.md
"Status of Mac-side verification") — but only against `native/navisworks-stubs`, a
hand-written stand-in for the real Autodesk assembly. Treat the first build against the
genuine `Autodesk.Navisworks.Api` on Windows as part of the proof, not a formality.
