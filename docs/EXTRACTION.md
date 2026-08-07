# EXTRACTION — Navisworks metadata extraction architecture

Phase 1 scope (PRODUCT.md §6, §19). Confirmed platform constraints in DECISIONS.md apply:
licensed Navisworks Manage/Simulate required, .NET Framework 4.8, no NWD forward compatibility.

## Process model

```
Electron main (later)                     Windows, this phase: run by hand
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

## Protocol (launcher stdout, JSON lines)

```
{"type":"progress","stage":"hash|open|walk|convert|finalize","done":123,"total":4096}
{"type":"warning","code":"...","message":"...","objectId":123}
{"type":"result","status":"ok|cache-hit","cachePath":"...","objects":131000,"warnings":2}
{"type":"error","code":"NW_VERSION_TOO_NEW|NW_NOT_INSTALLED|OPEN_FAILED|CANCELLED|...","message":"..."}
```

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

## Multi-version adapters (Phase 7 preview)

`native/navisworks-common` holds everything Autodesk-independent (DTOs, NDJSON protocol,
cache conversion, ordering). Version adapters (`navisworks-2025`, later 2024/2026) contain
only API-touching walk code, each referencing its product's install path. Adapter selection
policy: newest installed Navisworks wins (see DECISIONS.md — no forward compatibility).

## Confidentiality

Real NWDs and caches derived from them are client data: never committed, never named in
code/tests/fixtures. Committed fixtures use the invented **Dragon** site only. The cache
stores file *names*, never directories, to avoid leaking local paths into portable packages.

## Phase 1 validation (Windows, by hand)

The proof run follows [`docs/WINDOWS-RUNBOOK.md`](WINDOWS-RUNBOOK.md): build the solution,
extract a real NWD, verify cache integrity + reuse + cancellation, and report counts and
timings back. The C# code is authored on the Mac without compilation until that run — treat
the first Windows build as part of the proof, not a formality.
