# native — Navisworks extraction

The Windows half of Matchline: a console launcher and a Navisworks plugin that
together turn an NWD into the SQLite metadata cache described in
[`schemas/extraction-cache.sql`](../schemas/extraction-cache.sql). The
architecture and the reasoning behind it live in
[`docs/EXTRACTION.md`](../docs/EXTRACTION.md); this file is the map.

## Layout

| Path                              | Target         | What it is                                                                    |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `navisworks-common/`              | netstandard2.0 | DTOs, the NDJSON protocol (writer + reader), the stdout protocol. No dependencies at all. |
| `navisworks-2025/`                | net48          | The `AddInPlugin` for Navisworks 2025. Only this project touches the Autodesk API. |
| `extractor/`                      | net48 exe      | The launcher: hashing, cache lookup, process control, SQLite writing.          |
| `Matchline.Extraction.sln`        |                | The three above, and only those.                                               |
| `Directory.Build.props`           |                | Shared settings, including `LangVersion 7.3`.                                  |
| `navisworks-stubs/`               | net48          | **Not shipped.** Implementation-free stand-in for `Autodesk.Navisworks.Api`, so the plugin type-checks without a Navisworks install. |
| `smoke/`                          | net8.0 exe     | **Not shipped.** Runs the Autodesk-free half of the pipeline for real on any OS. |

Later version adapters (`navisworks-2024`, `navisworks-2026`) are new projects
alongside `navisworks-2025`, each referencing its own product install. Nothing
in `navisworks-common` may ever reference Autodesk.

Neither `navisworks-stubs/` nor `smoke/` is in the solution, deliberately: a
solution build cannot pull in a fake Autodesk assembly, and the Windows box
never has to restore a net8.0 target. Both are opt-in by name, below.

## Why the plugin streams NDJSON instead of writing SQLite

Two reasons, in order of how much they matter.

**Loading native SQLite inside the Autodesk process is a bad trade.**
`Microsoft.Data.Sqlite` needs a native `e_sqlite3.dll` loaded into whatever
process uses it. Inside Navisworks that means our native library, our assembly
versions, and our failure modes all end up in an AppDomain we do not control and
cannot debug well. A crash there is a Navisworks crash. The plugin instead does
the one thing only it can do — walk the model — and hands the result over as a
text stream.

**Atomic commit needs an owner outside the risky process.** The cache is only
allowed to appear complete or not at all. The launcher writes to
`<sha256>.sqlite.partial`, verifies `meta.object_count` against `COUNT(*)`,
fsyncs, and only then renames. If the plugin dies mid-walk, the stream is
truncated, the terminator record is missing, and no cache is ever created. A
worker failure cannot corrupt anything, which is a Phase 1 exit criterion.

The cost is one extra sequential read/write of the metadata. Revisit only if
real-model timings say it matters.

The stream itself is one JSON object per line, UTF-8, LF endings:

```
{"t":"meta","k":"navisworks_version","v":"..."}
{"t":"model","id":1,"parent":null,"file":"...","name":"...","guid":null}
{"t":"object","id":1,"model":1,"parent":null,"idx":0,"depth":0,...}
{"t":"prop","obj":1,"cat":"Item","cati":"LcOaNode","name":"Name",...}
{"t":"set","id":1,"parent":null,"name":"...","kind":"folder"}
{"t":"member","set":2,"obj":417}
{"t":"warn","sev":"warning","code":"PROPERTY_READ_FAILED","msg":"...","obj":417}
{"t":"end","ok":true,"code":null,"msg":null,"objects":131000,"warnings":2}
```

The `end` record is the completeness sentinel: the launcher refuses to build a
cache from a stream that does not have one. It is also the plugin's only way to
report a fatal error, since a plugin's return value is not reliably visible to
the process that launched Navisworks.

JSON is hand-rolled (`navisworks-common/Json`). That is deliberate: it keeps the
assembly that gets loaded into Navisworks dependency-free, so there is nothing
to collide with a copy Autodesk already loaded.

## Building

The real build is Windows, and the plugin needs a Navisworks install to compile
against. Step-by-step instructions, including deployment and the Phase 1 proof
run, are in [`docs/WINDOWS-RUNBOOK.md`](../docs/WINDOWS-RUNBOOK.md).

```
msbuild native\Matchline.Extraction.sln /t:Restore;Build /p:Configuration=Release
```

Override the Navisworks location with
`/p:NavisworksInstallDir="C:\Program Files\Autodesk\Navisworks Simulate 2025"`.

`Matchline.Extractor` targets `net48` but builds on macOS and Linux too: the
pinned `Microsoft.NETFramework.ReferenceAssemblies` package supplies the
metadata-only reference assemblies that csc needs, so no .NET Framework has to
be installed. Only the *build* is portable; the resulting exe is Windows-only.

## Verifying without Windows

Two opt-in targets, neither in the solution. Both are build/test scaffolding and
neither ever ships.

**Type-check the plugin without Navisworks.** `navisworks-stubs/` declares only
the Autodesk types and members the plugin actually names, all throwing
`NotImplementedException`. The property swaps the Autodesk `Reference` for a
`ProjectReference` and redirects output to `bin/stub-verify/`:

```
dotnet build native/navisworks-2025/Matchline.Extraction.Navisworks2025.csproj -p:UseNavisworksStubs=true
```

A green build means the plugin's C# is valid and internally consistent with the
signatures the stub declares. It does **not** mean those signatures are right —
they were written from the plugin, not from Autodesk.

**Run the Autodesk-free half for real.** `smoke/` compiles the launcher's own
`CacheSchema.cs`, `CacheWriter.cs` and `CacheInspector.cs` (by path, not by
copy) under a runnable TFM, drives a synthetic NDJSON stream through
writer → reader → cache → inspector, and asserts the result. Exit code 0 means
every check passed:

```
dotnet run --project native/smoke/Matchline.Extraction.Smoke.csproj -- /tmp/matchline-smoke
```

Then point the TypeScript reader at the file the C# writer just produced. From
the repo root, after `npm run build --workspace @matchline/model-schema`:

```
node --input-type=module -e "import {openExtractionCache} from '@matchline/model-schema'; const c = openExtractionCache('/tmp/matchline-smoke/synthetic.sqlite'); console.log(c.objectCount(), [...c.walk()].map(o => o.id).join(',')); c.close()"
```

Expect `8 1,2,3,4,5,6,7,8` — the object count and the depth-first walk order the
C# writer laid down, read back by the reader that ships to the app.

## VERIFY-ON-WINDOWS

Every Autodesk API call here was written without a Navisworks install. Uncertain
calls carry a `// VERIFY-ON-WINDOWS:` comment saying whether the stub build pins
its shape or leaves it fully open. The first Windows build is part of the proof,
not a formality — the checklist in the runbook collects every flag.
