# WINDOWS RUNBOOK — the Phase 1 extraction proof

This is the step-by-step for running the Phase 1 proof on your Windows machine
with Navisworks Manage 2025. Follow it in order. It assumes nothing beyond a
working Windows install and Navisworks.

**The proof drives the app, not the launcher.** Extraction is integrated: you
drop a model on screen 1 and Matchline runs Navisworks for you (§6). Running
`Matchline.Extractor.exe` by hand is kept here as the diagnostic path (§6b),
because when something goes wrong the raw protocol is the fastest way to see it
— but it is not how anyone extracts a model, and the proof does not pass on it
alone.

**Read this first — everything except the Autodesk API is now compiled and
run.** All of `native/` was written on a Mac. It has since been built there with
the .NET SDK, and the half that does not touch Autodesk has been *executed*. The
plugin compiles too, but only against a hand-written stand-in for
`Autodesk.Navisworks.Api`. Your build is still the first one against the real
assembly, and it is still *part of the proof*. Build errors in the plugin remain
an expected outcome; capture them verbatim.

### Status of Mac-side verification (2026-08-08)

Toolchain: **.NET SDK 8.0.423** on macOS (arm64), `dotnet build` /`dotnet run`.
Reference assemblies for `net48` come from the pinned
`Microsoft.NETFramework.ReferenceAssemblies` package, which is why a .NET
Framework target compiles on a machine that has no .NET Framework.

**Compiles clean, zero warnings:**

| Project                                        | Target         | Notes                                    |
| ---------------------------------------------- | -------------- | ---------------------------------------- |
| `Matchline.Extraction.Common`                  | netstandard2.0 | No changes were needed.                  |
| `Matchline.Extractor`                          | net48          | No C# changes were needed. NuGet restored the pinned `Microsoft.Data.Sqlite 8.0.10` / `SQLitePCLRaw.bundle_e_sqlite3 2.1.6`. |
| `Matchline.Extraction.Navisworks2025`          | net48          | Only with `-p:UseNavisworksStubs=true`. One real bug fixed first, below. |

**One real build-blocking bug was found and fixed.**
`native/navisworks-2025/Matchline.Extraction.Navisworks2025.csproj` contained a
`--` inside an XML comment, which is illegal. MSBuild refused to *load* the
project file at all: `error MSB4025`. That is not a C# error and no amount of
reading the C# would have found it — `msbuild native\Matchline.Extraction.sln`
would have failed on your machine before compiling a single line. Fixed.

**Ran for real (not just compiled):**

- **NDJSON round trip — PASSED.** `native/smoke` builds a synthetic stream
  covering embedded quotes, backslashes, tabs, newlines, a control character,
  non-ASCII, empty vs null strings, extreme doubles, and a NaN bounding box;
  writes it with `NdjsonWriter`; reads it back with `NdjsonReader`; and compares
  every field. It also asserts the file is UTF-8 with no BOM, LF-only, and one
  line per record.
- **`CacheWriter` produced a real cache file — PASSED.** The parsed stream was
  replayed through the actual `CacheWriter`, committed (integrity check,
  `.partial` rename and all) and re-opened with the actual `CacheInspector`.
  `PRAGMA foreign_key_check` and `PRAGMA integrity_check` are both clean on the
  committed file. 251 assertions.
- **C# ↔ TypeScript cross-check, against the C#-produced file — PASSED.** Not a
  reconstruction this time: `@matchline/model-schema`'s `openExtractionCache`
  was pointed at the `.sqlite` the C# writer had just produced. 19 assertion
  groups: all nine meta keys, row counts, depth-first `walk()` order, roots and
  children by `path_index`, exact bounding-box values, bbox all-or-none for the
  NaN row, property encounter order, byte-exact hostile property values,
  null-vs-empty `value_text`, the selection-set folder tree with members
  (including a duplicate member collapsing to one row), and warning order and
  severities.
- **C# 7.3 language discipline — clean**, now enforced by the compiler rather
  than by reading: `LangVersion 7.3` in `native/Directory.Build.props` applies to
  every project including the stubs and the smoke harness.

**Two latent issues fixed while in there:**

- `CacheSchema.Ddl` claimed to be a verbatim copy of
  `schemas/extraction-cache.sql` but two SQL comment lines differed (`—`→`--`,
  `§6.4`→`6.4`). It is now byte-identical, and the smoke harness asserts that
  byte-for-byte, so the claim can no longer quietly rot. (Side benefit: it also
  proves the compiler read the repo's UTF-8 sources correctly.)
- `DocumentWalker.EmitObject` emitted its warnings *before* the object record
  they reference, so the stream inserted a `warnings` row pointing at an
  `objects` row that did not exist yet. Harmless today because the cache is
  written with `PRAGMA foreign_keys` at its default of OFF, but it made the
  stream unreplayable against an enforcing database. Warnings raised while
  building an object are now queued and flushed immediately after it.

**What is still unproven.** Everything Autodesk. See §9 for the flag-by-flag
split between "the stub build pinned its shape" and "fully open".

**Confidentiality.** The real NWD and everything derived from it are client
data. Never copy the NWD into the repo folder, never commit a cache file, never
paste a real file name, project name, or equipment tag into an issue, a commit
message, or a chat. Everything in this runbook happens *outside* the repo tree:
the model stays where it already lives, and caches are written under the app's
own folder (`%APPDATA%\Matchline\cache\models`) or wherever `--cache-dir`
says — neither of which is in the repo or in git.

---

## 1. Prerequisites

Install these before starting.

1. **Navisworks Manage 2025** (or Simulate 2025), licensed and activated.
   Freedom will not work — it has no API.
2. **One of these**, for the compiler:
   - Visual Studio 2022 Community — during install tick the **.NET desktop
     development** workload; or
   - Visual Studio 2022 **Build Tools** (no IDE) — tick **.NET desktop build
     tools**.
3. In either installer, under *Individual components*, make sure
   **.NET Framework 4.8 targeting pack** is ticked. Without it the build fails
   immediately with a message about a missing reference assembly for `net48`.
4. **Git for Windows** (any recent version).

NuGet restore needs internet access the first time. After that it works offline.

---

## 2. Get the code

Open a normal (non-admin) **Developer Command Prompt for VS 2022** — search the
Start menu for that exact name. It has `msbuild` on the PATH; a plain command
prompt does not.

```
cd %USERPROFILE%\source
git clone https://github.com/noahfgarrett/Matchline.git
cd Matchline
git checkout main
```

---

## 3. Build

`Matchline.Extraction.Common` (netstandard2.0) and `Matchline.Extractor`
(net48) both build clean on the Mac with zero warnings — see the status note at
the top — so a failure in either is a genuine Windows/toolchain difference and
worth reporting in detail. The plugin has only ever been compiled against the
stub API, so treat it as first-build-on-Windows.

Build the two Autodesk-free projects first — the failures are cheaper to read in
isolation, and if they fail, the problem is your toolchain, not the code:

```
msbuild native\navisworks-common\Matchline.Extraction.Common.csproj /t:Restore;Build /p:Configuration=Release
msbuild native\extractor\Matchline.Extractor.csproj /t:Restore;Build /p:Configuration=Release
```

Then the whole solution:

```
msbuild native\Matchline.Extraction.sln /t:Restore;Build /p:Configuration=Release
```

If Navisworks is installed somewhere other than
`C:\Program Files\Autodesk\Navisworks Manage 2025`, point the build at it:

```
msbuild native\Matchline.Extraction.sln /t:Restore;Build /p:Configuration=Release /p:NavisworksInstallDir="D:\Autodesk\Navisworks Manage 2025"
```

**If the build fails**, copy the *entire* output, from the command you typed to
the last line, into your report. Do not summarise it or retype error numbers —
the exact text is what makes a fix precise. Then stop here; nothing later in
this runbook will work.

**If the build succeeds**, you now have:

- `native\extractor\bin\Release\Matchline.Extractor.exe` — the launcher
- `native\navisworks-2025\bin\Release\Matchline.Extraction.Navisworks2025.dll` — the plugin

Check one thing before moving on: **where did `e_sqlite3.dll` land?**

```
dir /s /b native\extractor\bin\Release\e_sqlite3.dll
```

Reading `SQLitePCLRaw.lib.e_sqlite3`'s own MSBuild targets, it should print
three paths — `runtimes\win-x64\native\`, `runtimes\win-x86\native\` and
`runtimes\win-arm\native\` — and *not* a copy at the output root. (The same
build on macOS produced `runtimes\osx-x64\native\libe_sqlite3.dylib` and nothing
at the root, which matches.) **Report what you actually see.** If the command
prints nothing, say so: SQLite will fail at runtime with "Unable to load DLL
'e_sqlite3'", and the fix is to copy the `win-x64` one to the output root.

---

## 4. Deploy the plugin

Navisworks only loads plugins from a `Plugins` folder, and it insists the
**folder name matches the DLL name**.

Create this folder:

```
"C:\Program Files\Autodesk\Navisworks Manage 2025\Plugins\Matchline.Extraction.Navisworks2025"
```

Creating a folder under `Program Files` needs an **administrator** command
prompt. Copy the whole build output into it:

```
xcopy /Y "%USERPROFILE%\source\Matchline\native\navisworks-2025\bin\Release\*" "C:\Program Files\Autodesk\Navisworks Manage 2025\Plugins\Matchline.Extraction.Navisworks2025\"
```

That folder must end up containing at least:

- `Matchline.Extraction.Navisworks2025.dll`
- `Matchline.Extraction.Common.dll`

**VERIFY** — there is a second candidate location that does not need admin
rights:

```
%APPDATA%\Autodesk Navisworks Manage 2025\Plugins\Matchline.Extraction.Navisworks2025\
```

Documentation disagrees about which of the two Navisworks 2025 actually scans.
Try the install-directory one first. If the plugin is never found (§7 tells you
how that looks), try the `%APPDATA%` one instead, and **report which one
worked** — that answer gets written into the installer design.

---

## 5. Pick a model and a working folder

Keep both outside the repo.

```
mkdir %USERPROFILE%\matchline-proof
```

Use a real project NWD you already have. Note its size in MB — you will report
that alongside the timings. Do not copy it anywhere near the repo folder.

---

## 6. Run the extraction — the normal path, in the app

**This is how extraction is meant to happen, and it is the path the proof must
exercise.** Matchline drives the launcher itself: you drop the model on screen 1
and watch the row. Nobody produces a cache file by hand, and nobody is shown one
(RELEASE-1.0-PLAN P0-2; the architecture is in
[`docs/EXTRACTION.md`](EXTRACTION.md), "The extraction service").

Point the app at the launcher you just built, then start it:

```
cd %USERPROFILE%\source\Matchline
set MATCHLINE_EXTRACTOR_PATH=%USERPROFILE%\source\Matchline\native\extractor\bin\Release\Matchline.Extractor.exe
npm run dev:desktop
```

(A packaged build ships the launcher beside itself and needs no variable. The
variable exists so a machine that has built from source can use what it built.)

Then, in the app:

1. Create a project anywhere outside the repo — `%USERPROFILE%\matchline-proof`
   is a good place.
2. On **screen 1**, drop your NWD on the drop zone. Do not look for a cache
   option; there isn't one, and that is the point.
3. Watch the row. Time it from the drop to `Ready`.

### What good looks like, in the row

The badge moves through these, and every one of them should appear:

| Badge                 | What is happening                                                    |
| --------------------- | -------------------------------------------------------------------- |
| Waiting to extract    | Queued. With one model this is a blink; with several it is the queue. |
| Checking the file     | Streaming SHA-256 of the NWD, with a percentage.                      |
| Opening in Navisworks | Detection, then the headless open. **Record the sentence under the bar** — it names the Navisworks and the adapter that will open the file. |
| Reading the model     | The walk, then the cache write. The record count climbs; there is no percentage, because the walk cannot know its total. |
| Finishing up          | Integrity check and atomic rename.                                    |
| Ready                 | The cache was validated and associated. The row says how many objects and source models came out. |

Also record:

- the `Navisworks version has not been proven against a real install` warning —
  it is expected on this run, and it is what §9 is about;
- that **screen 2 now shows the model** without you having added anything else;
- the time from drop to `Ready`, and the model's size in MB.

Then repeat the checks in §8 — they are written against the launcher's own
output, and §8.1–8.3 have an in-app equivalent noted under each one.

---

## 6b. Run the launcher by hand — the diagnostic path

Use this when something in §6 went wrong and you need to see the raw protocol,
or when you want to test the launcher without the app in the way. It is not how
a user extracts a model.

```
cd %USERPROFILE%\source\Matchline\native\extractor\bin\Release

Matchline.Extractor.exe --input "D:\path\to\your model.nwd" --cache-dir "%USERPROFILE%\matchline-proof\cache"
```

Time it. `powershell -c "Measure-Command { ... }"` works, or just watch the
clock — a rough minute count is fine.

Navisworks will start in the background with no window. On a large model this
can take several minutes with no visible sign of life beyond the progress lines.

### What good output looks like

One JSON object per line on stdout, roughly:

```
{"type":"progress","stage":"hash","done":0,"total":734003200}
{"type":"progress","stage":"hash","done":67108864,"total":734003200}
...
{"type":"progress","stage":"open","done":0,"total":1}
{"type":"progress","stage":"walk","done":48213,"total":0}
{"type":"progress","stage":"walk","done":193044,"total":0}
...
{"type":"progress","stage":"convert","done":25000,"total":0}
...
{"type":"progress","stage":"finalize","done":1,"total":1}
{"type":"result","status":"ok","cachePath":"C:\\Users\\...\\cache\\<64 hex chars>.sqlite","objects":131000,"warnings":2}
```

`"total":0` means "not known yet" — that is expected on the walk and convert
stages, not a bug.

Warning lines may appear between the progress lines. Up to 20 are printed; all
of them are stored in the cache regardless.

### What failure looks like

A single error line, then the process exits:

```
{"type":"error","code":"NW_NOT_INSTALLED","message":"..."}
```

The codes you might see, and what each means:

| Code                  | Meaning                                                      |
| --------------------- | ------------------------------------------------------------ |
| `INVALID_ARGS`        | Command line typo. The message includes usage.               |
| `INPUT_NOT_FOUND`     | The `--input` path does not exist.                           |
| `NW_NOT_INSTALLED`    | No Navisworks found. Pass `--navisworks-dir`.                |
| `NW_VERSION_TOO_NEW`  | The NWD was published by a newer Navisworks than is installed. |
| `OPEN_FAILED`         | Navisworks could not open the file for some other reason.    |
| `EXTRACT_FAILED`      | The plugin did not run, or died partway through.             |
| `CACHE_WRITE_FAILED`  | The stream was complete but the cache failed its checks.     |
| `CANCELLED`           | You sent `cancel`.                                           |

On `EXTRACT_FAILED` the message includes the path of the kept `.ndjson.tmp`
stream file. **Do not delete it** — its size and last few lines are useful
evidence. (It contains model metadata, so it is client data: report its size and
the last line's shape, not its contents.)

---

## 7. If the plugin is never found

Symptom: the run finishes fast with
`{"type":"error","code":"EXTRACT_FAILED","message":"Navisworks produced no extraction stream ..."}`,
and no `.ndjson.tmp` file appears in the cache folder.

Almost always this is the Navisworks command line. The launcher builds it in one
place —  `BuildArguments` in
`native\extractor\NavisworksProcessRunner.cs` — and the comment there lists the
variations to try in order. It currently assumes:

```
Roamer.exe "<model.nwd>" -NoGUI -ExecuteAddInPlugin MatchlineExtract.MTCH "<stream path>" "<model.nwd>"
```

You can test that by hand without rebuilding anything:

```
"C:\Program Files\Autodesk\Navisworks Manage 2025\Roamer.exe" "D:\path\to\your model.nwd" -NoGUI -ExecuteAddInPlugin MatchlineExtract.MTCH "%USERPROFILE%\matchline-proof\hand-test.ndjson" "D:\path\to\your model.nwd"
```

If `hand-test.ndjson` appears, the command line is right and the problem is
elsewhere. If it does not, work through the variations in the comment (drop
`-NoGUI`, move it before the file, put the file last, use `-OpenFile`) and
**report which spelling produced a file**. That one answer unblocks everything.

The other possibility is plugin discovery — try the `%APPDATA%` Plugins folder
from §4.

---

## 8. Verification checklist

These map one-to-one onto the Phase 1 exit criteria. Tick each. Each one is
written against the launcher's raw output (§6b) and carries the in-app
equivalent (§6) beside it — run both where they differ, because the app and the
launcher each own half of the promise.

### 8.1 The cache appears, named by hash

The app writes caches under its own folder:

```
dir "%APPDATA%\Matchline\cache\models"
```

and a by-hand run writes them wherever `--cache-dir` said. Either way, expect
one file per model: 64 hex characters + `.sqlite`. **No `.partial` file and no
`.ndjson.tmp` file may remain.**

- [ ] one `<64 hex>.sqlite` per model extracted
- [ ] nothing else in the folder
- [ ] **in the app**: the source row never named that file, and never had to

### 8.2 Re-run is a cache hit, and Navisworks never starts

Run the **exact same command** from §6b again. Watch Task Manager while it runs.

```
{"type":"progress","stage":"hash",...}
{"type":"result","status":"cache-hit","cachePath":"...","objects":131000,"warnings":2}
```

- [ ] status is `cache-hit`
- [ ] it finishes in seconds (only the hash is recomputed)
- [ ] **no `Roamer.exe` appears in Task Manager**
- [ ] `objects` matches the first run exactly

**In the app**: drop the same NWD on screen 1 a second time. The row should go
straight to **Ready — reused**, say so in words, and Navisworks must not start.
The app checks for the cache before it launches anything, so this one never
reaches the launcher at all.

- [ ] the badge reads `Ready — reused`
- [ ] no `Roamer.exe` appears in Task Manager
- [ ] the object count matches the first run

### 8.3 Cancelling mid-run leaves nothing behind

Delete the cache folder contents, then start a fresh extraction. While the
`walk` progress lines are still scrolling, type:

```
cancel
```

and press Enter into the same window.

Expect:

```
{"type":"error","code":"CANCELLED","message":"Extraction cancelled."}
```

Then check the folder and Task Manager:

- [ ] `Roamer.exe` is gone from Task Manager
- [ ] the cache folder contains **no** `.sqlite` file
- [ ] the cache folder contains **no** `.partial` file
- [ ] the cache folder contains **no** `.ndjson.tmp` file
- [ ] `echo %ERRORLEVEL%` prints `9`

If Navisworks lingers, note how long — that tells us whether a harder kill is
needed.

**In the app**: start a fresh extraction and press **Cancel** on the row while
it reads the model. The app sends the same `cancel` line, and escalates to
SIGTERM and then SIGKILL only if the launcher ignores it.

- [ ] the badge becomes `Cancelled` and the source stays in the list
- [ ] the row says how to run it again, in plain language
- [ ] `Roamer.exe` is gone from Task Manager
- [ ] the cache folder holds no `.sqlite`, `.partial` or `.ndjson.tmp` for it
- [ ] dropping the model again starts a fresh extraction that completes

### 8.4 Spot-check the cache contents

Get `sqlite3.exe` from <https://sqlite.org/download.html> ("Precompiled Binaries
for Windows", the `sqlite-tools-win-x64` zip). Unzip it anywhere and run:

```
sqlite3 "%USERPROFILE%\matchline-proof\cache\<the hash>.sqlite"
```

Then paste these one at a time:

```sql
SELECT key, value FROM meta ORDER BY key;

SELECT COUNT(*) FROM objects;
SELECT COUNT(*) FROM properties;
SELECT COUNT(*) FROM source_models;
SELECT COUNT(*) FROM selection_sets;
SELECT COUNT(*) FROM selection_set_members;
SELECT COUNT(*) FROM warnings;

-- integrity: these two must be equal
SELECT (SELECT value FROM meta WHERE key='object_count') AS declared,
       (SELECT COUNT(*) FROM objects)                    AS actual;

-- shape check: a handful of the most common property names
SELECT category, name, COUNT(*) AS n
FROM properties GROUP BY category, name ORDER BY n DESC LIMIT 15;

-- did bounding boxes come through at all?
SELECT COUNT(*) FROM objects WHERE bbox_min_x IS NOT NULL;

-- what kinds of value did we see?
SELECT value_type, COUNT(*) FROM properties GROUP BY value_type ORDER BY 2 DESC;

-- what went wrong, if anything
SELECT severity, code, COUNT(*) FROM warnings GROUP BY severity, code;

.quit
```

- [ ] `declared` equals `actual`
- [ ] `meta` has all nine required keys, none blank
- [ ] `objects` count is in the ballpark you expect for that model
- [ ] `properties` count is comfortably larger than `objects`
- [ ] `value_type` shows a spread of names, not everything landing on one

Sanity-check a couple of the property names against what Navisworks shows in its
own Properties panel for an item you know. They should read the same.

---

## 9. The VERIFY-ON-WINDOWS checklist

Every Autodesk API call in `native/navisworks-2025/` is still an educated guess.
They are marked in the source with `// VERIFY-ON-WINDOWS:`. You do not need to
check these by reading code — **the build and the run check them for you**. This
list exists so that when something misbehaves, you know what to look at.

**Status: 20 signature-pinned against stubs, 9 fully open.**

The plugin now compiles, but against `native/navisworks-stubs` — a hand-written,
implementation-free `Autodesk.Navisworks.Api` whose signatures were derived from
*this code*, not from Autodesk. Read that honestly: it proves the plugin's C# is
valid and internally consistent, and it forced every assumption to be written
down as an explicit signature. It proves nothing about whether those signatures
match the real assembly. A member name that is wrong is still wrong; it will
still fail on your build.

Each flag in the source now says which kind it is:

- **"shape pinned by the stub build"** — the member's arity and types are fixed
  by how the plugin uses them, so if the real API differs you get a *compile
  error*, which is the cheap failure. 20 flags.
- **"FULLY OPEN"** — the compiler cannot see it at all: reflection, runtime
  string matching, process behaviour, install layout, or a semantic claim (like
  "this collection yields document order") that has no type to check. These fail
  *silently at runtime*, which is the expensive failure. 9 flags.

The 9 fully open ones, and what each looks like when wrong:

| Flag                                                        | Fails as                                            |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `ModelItem` value equality (`DocumentWalker`)                | `selection_set_members` empty. **This one matters.** |
| Model GUID member name, read reflectively                    | `source_models.guid` all null. Cosmetic.            |
| `Application.Version`, read reflectively                     | `meta.navisworks_version` reads `unknown`. Cosmetic. |
| `VariantDataType` spelling (string switch, `VariantFormatter`) | Everything lands in one `value_type`.             |
| `AddInLocation.None` — whether it exists at all              | Plugin shows in the ribbon. Cosmetic.               |
| Command-line id format `name.developerId`                    | Plugin never runs. §7.                              |
| Developer id `MTCH` needing Autodesk registration            | Plugin never runs. §7.                              |
| Navisworks install discovery / `Roamer.exe` command line     | `NW_NOT_INSTALLED` or `EXTRACT_FAILED`. §7.         |
| Too-new-NWD message wording (`FailureClassifier`)            | `OPEN_FAILED` instead of `NW_VERSION_TOO_NEW`.      |

Three more are semantic riders on otherwise-pinned flags, and are worth knowing
because they compile either way:

- `ModelItem.Children` yielding *document* order — `path_index` is meaningless
  if it does not.
- `SelectionSet` **not** deriving from `GroupItem` — the walker's
  `child as GroupItem` null check depends on it, and would recurse into a
  selection set if it is wrong.
- Which of `DisplayName` / `Name` (on `ModelItem`, `PropertyCategory`,
  `DataProperty`) is the display form. Both are strings, so a swap is invisible
  to the compiler and shows up as internal names in the UI.

Find every flag at any time with:

```
findstr /S /N "VERIFY-ON-WINDOWS" native\*.cs native\*.csproj
```

To reproduce the stub compile on any machine with the .NET SDK (this does *not*
need Navisworks, and never runs):

```
dotnet build native\navisworks-2025\Matchline.Extraction.Navisworks2025.csproj -p:UseNavisworksStubs=true
```

The stub project is deliberately **not** in `Matchline.Extraction.sln`, so the
normal solution build cannot reach it, and the stub build writes to
`bin\stub-verify\` so its output can never be mistaken for the DLL §4 deploys.

Grouped by what would go wrong:

**Build fails → a member name is wrong.** These are all one-line fixes:

| Where                    | Assumed API                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- |
| `MatchlineExtractAddIn`  | `[Plugin(name, developerId, ...)]`, `[AddInPlugin(AddInLocation.AddIn)]`, `Document.TryOpenFile(string)`, `Document.FileName` |
| `DocumentWalker`         | `Document.Models` of `Model`, `Model.RootItem`, `Model.FileName`, `ModelItem.Children`, `.DisplayName`, `.ClassDisplayName`, `.ClassName`, `.InstanceGuid`, `.HasGeometry`, `.BoundingBox()`, `.PropertyCategories` |
| `DocumentWalker`         | `PropertyCategory.DisplayName` / `.Name` / `.Properties`, `DataProperty.DisplayName` / `.Name` / `.Value` |
| `DocumentWalker`         | `Document.SelectionSets.RootItem`, `GroupItem.Children`, `SelectionSet.HasExplicitModelItems`, `.ExplicitModelItems` |
| `VariantFormatter`       | `VariantData.DataType` plus `ToDisplayString` / `ToIdentifierString` / `ToInt32` / `ToDouble` / `ToDoubleLength` / `ToDoubleAngle` / `ToDoubleArea` / `ToDoubleVolume` / `ToBoolean` / `ToDateTime` / `ToNamedConstant` |

**Build succeeds, nothing extracts → discovery or command line.** §4 and §7.
Also: the developer id `MTCH` may need to be one Autodesk recognises.

**Extraction works but data looks wrong:**

- `guid` column empty in `source_models` → the reflective lookup for the model
  GUID found nothing. Report it; it is cosmetic in Phase 1.
- `navisworks_version` reads `unknown` in `meta` → the reflective
  `Application.Version` lookup found nothing. Also cosmetic; report the real
  member name if you can see it in the object browser.
- `selection_set_members` is empty while `selection_sets` is not → `ModelItem`
  does not compare the way the walker assumes. **This one matters** — report it.
- Everything in `value_type` reads the same → the `VariantDataType` names in
  `VariantFormatter` do not match the real ones. Report the distinct values from
  the query in §8.4.
- Zero rows with a bounding box → `HasGeometry` or `BoundingBox()` behaved
  differently. Cosmetic in Phase 1.

**The too-new-file message.** If you happen to have an NWD published by
Navisworks 2026, run it through and confirm you get `NW_VERSION_TOO_NEW` rather
than `OPEN_FAILED`. If you get `OPEN_FAILED`, **paste the verbatim message** —
the wording goes into `FailureClassifier` so the mapping is exact rather than
guessed. If you have no such file, say so; this stays open.

---

## 10. What to report back

Copy this template and fill it in.

```
BUILD
  Visual Studio / Build Tools version:
  Navisworks product and version (Help > About):
  Build result, Common + Extractor (these build clean on macOS): success / failure
  Build result, plugin against the REAL Autodesk assembly: success / failure
  If failure: full verbatim output, from the msbuild command to the last line.
    Every compile error here is a VERIFY-ON-WINDOWS flag coming due; the error
    text names the member, which is exactly what is needed to correct both the
    plugin and native/navisworks-stubs.
  e_sqlite3.dll: paste the output of the `dir /s /b` from §3

DEPLOY
  Plugins folder that worked: install dir / %APPDATA% / neither
  Command line spelling that worked (§7):

RUN — IN THE APP (§6, the normal path)
  Model size (MB):
  Wall-clock time, drop to Ready:
  Every badge you saw, in order:
  The detect sentence under the bar, verbatim (it names the Navisworks + adapter):
  Warnings shown on the row (codes only):
  Object and source-model counts the row reported when it went Ready:
  Did screen 2 show the model without you adding anything else? yes / no
  Anything the row said that was confusing or wrong:

RUN — BY HAND (§6b, the diagnostic path)
  Wall-clock time, first run:
  Wall-clock time, cache-hit run:
  Peak memory of Roamer.exe during the walk (Task Manager), rough:
  Final cache file size (MB):

COUNTS (from §8.4)
  objects:
  properties:
  source_models:
  selection_sets:
  selection_set_members:
  warnings:
  declared vs actual object_count: equal / NOT equal
  objects with a bounding box:
  distinct value_type values and counts:
  warnings grouped by severity+code:

CHECKLIST
  8.1 cache named by hash, nothing else in the folder:  pass / fail
  8.1 the app never named a cache file to you:          pass / fail
  8.2 re-run is cache-hit and Roamer.exe never starts:  pass / fail
  8.2 second drop in the app read "Ready — reused":     pass / fail
  8.3 cancel leaves no .sqlite, no .partial, no .tmp:   pass / fail
  8.3 exit code was 9:                                  pass / fail
  8.3 Cancel in the app left the source registered:     pass / fail
  8.4 declared object_count equals actual:              pass / fail

ANYTHING ELSE
  Warnings that looked alarming (codes and counts, not messages with real names):
  Anything that hung, crashed, or needed a second try:
```

Remember: counts, codes and timings only. No file names, no project names, no
equipment tags, no property values from the real model.
