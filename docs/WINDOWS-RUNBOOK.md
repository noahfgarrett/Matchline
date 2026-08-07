# WINDOWS RUNBOOK — the Phase 1 extraction proof

This is the step-by-step for running the Phase 1 proof on your Windows machine
with Navisworks Manage 2025. Follow it in order. It assumes nothing beyond a
working Windows install and Navisworks.

**Read this first — the code has never been compiled.** All of `native/` was
written on the Mac, which has no .NET SDK and no Navisworks. The first build on
your machine is *part of the proof*, not a formality. Build errors are an
expected outcome, not a sign something went badly wrong. What matters is that
you capture them verbatim so they can be fixed precisely.

**Confidentiality.** The real NWD and everything derived from it are client
data. Never copy the NWD into the repo folder, never commit a cache file, never
paste a real file name, project name, or equipment tag into an issue, a commit
message, or a chat. Everything in this runbook happens *outside* the repo tree:
the model stays where it already lives, and the cache is written under
`%LOCALAPPDATA%`, which is not in the repo and not in git.

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
git checkout feat/phase-1-extraction-foundation
```

---

## 3. Build

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

Check one thing before moving on: **is `e_sqlite3.dll` in
`native\extractor\bin\Release\`** (possibly inside an `x64\` subfolder)? If it
is missing, note that — SQLite will fail at runtime with "Unable to load DLL
'e_sqlite3'".

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

## 6. Run the extraction

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

These map one-to-one onto the Phase 1 exit criteria. Tick each.

### 8.1 The cache appears, named by hash

```
dir "%USERPROFILE%\matchline-proof\cache"
```

Expect exactly one file: 64 hex characters + `.sqlite`. **No `.partial` file
and no `.ndjson.tmp` file may remain.**

- [ ] one `<64 hex>.sqlite`
- [ ] nothing else in the folder

### 8.2 Re-run is a cache hit, and Navisworks never starts

Run the **exact same command** from §6 again. Watch Task Manager while it runs.

```
{"type":"progress","stage":"hash",...}
{"type":"result","status":"cache-hit","cachePath":"...","objects":131000,"warnings":2}
```

- [ ] status is `cache-hit`
- [ ] it finishes in seconds (only the hash is recomputed)
- [ ] **no `Roamer.exe` appears in Task Manager**
- [ ] `objects` matches the first run exactly

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

Every Autodesk API call in `native/navisworks-2025/` is an educated guess. They
are marked in the source with `// VERIFY-ON-WINDOWS:`. You do not need to check
these by reading code — **the build and the run check them for you**. This list
exists so that when something misbehaves, you know what to look at.

Find them all at any time with:

```
findstr /S /N "VERIFY-ON-WINDOWS" native\*.cs native\*.csproj
```

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
  Build result: success / failure
  If failure: full verbatim output, from the msbuild command to the last line.
  e_sqlite3.dll present in extractor bin folder: yes / no

DEPLOY
  Plugins folder that worked: install dir / %APPDATA% / neither
  Command line spelling that worked (§7):

RUN
  Model size (MB):
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
  8.2 re-run is cache-hit and Roamer.exe never starts:  pass / fail
  8.3 cancel leaves no .sqlite, no .partial, no .tmp:   pass / fail
  8.3 exit code was 9:                                  pass / fail
  8.4 declared object_count equals actual:              pass / fail

ANYTHING ELSE
  Warnings that looked alarming (codes and counts, not messages with real names):
  Anything that hung, crashed, or needed a second try:
```

Remember: counts, codes and timings only. No file names, no project names, no
equipment tags, no property values from the real model.
