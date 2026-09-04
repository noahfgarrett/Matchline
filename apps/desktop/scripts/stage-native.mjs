import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * `npm run package:win` / `npm run package:mac` — stage the C# extraction
 * launcher and the Navisworks plugin adapters where electron-builder's
 * `extraResources` (apps/desktop/electron-builder.yml) can find them.
 *
 * electron-builder copies files, it does not build them: the launcher and the
 * adapters are `dotnet build` output that has to exist on disk first, at
 * `native/extractor/bin/Release` and `native/navisworks-<year>/bin/Release`
 * respectively (native/README.md, "Building"). This script copies that output
 * — never the whole bin/ tree, which also holds .pdb files and Debug builds —
 * into `apps/desktop/native-stage/`, which electron-builder ships as
 * `resources/extractor` and `resources/plugins`.
 *
 * `--allow-missing` is the Mac cross-packaging escape hatch: this repo has no
 * .NET toolchain on macOS-without-dotnet, so there is nothing to stage. A Mac
 * build produced this way ships without a working launcher on purpose (the app
 * already refuses gracefully — extractor-launcher.ts `resolveExtractorLauncher`
 * — when the exe is not where it expects). Windows CI and the release build
 * never pass the flag: a Windows package that silently shipped no launcher is
 * exactly the bug this script exists to close (docs/AUDIT-2026-09-02-NWD-TO-SSM.md,
 * "B1 — Launcher not shipped").
 */

const ALLOW_MISSING = process.argv.includes('--allow-missing');

const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = path.join(DESKTOP_ROOT, '..', '..');

const EXTRACTOR_SOURCE_DIR = path.join(REPO_ROOT, 'native', 'extractor', 'bin', 'Release');
const EXTRACTOR_STAGE_DIR = path.join(DESKTOP_ROOT, 'native-stage', 'extractor');
const PLUGINS_STAGE_DIR = path.join(DESKTOP_ROOT, 'native-stage', 'plugins');

const EXTRACTOR_EXECUTABLE = 'Matchline.Extractor.exe';
const EXTRACTOR_CONFIG = 'Matchline.Extractor.exe.config';
/** SQLitePCLRaw's native provider, restored under a `runtimes/<rid>/native/` subpath. */
const SQLITE_RUNTIME_RELATIVE = path.join('runtimes', 'win-x64', 'native', 'e_sqlite3.dll');

const ADAPTER_DIR_PATTERN = /^navisworks-\d{4}$/;

function log(message) {
  console.log(`[stage-native] ${message}`);
}

function fail(message) {
  console.error(`[stage-native] ${message}`);
  process.exit(1);
}

function relativeToRepo(target) {
  return path.relative(REPO_ROOT, target);
}

function dllsIn(directory) {
  return readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.dll'))
    .sort();
}

/**
 * Copies the launcher's whole runtime closure: the exe, its .config, every DLL
 * next to it, and the win-x64 native SQLite provider. Returns whether it
 * staged something real.
 */
function stageExtractor() {
  rmSync(EXTRACTOR_STAGE_DIR, { recursive: true, force: true });
  mkdirSync(EXTRACTOR_STAGE_DIR, { recursive: true });

  const exeSource = path.join(EXTRACTOR_SOURCE_DIR, EXTRACTOR_EXECUTABLE);
  const sqliteSource = path.join(EXTRACTOR_SOURCE_DIR, SQLITE_RUNTIME_RELATIVE);

  // Both checked together, before either is required: a `dotnet build` run on
  // this same Mac for native-smoke leaves a real Matchline.Extractor.exe on
  // disk, but built against `runtimes/osx-x64/...` — present but not a
  // Windows launcher. Treating only the exe as the presence signal would pass
  // that half-built tree through --allow-missing's gate and then fail on the
  // sqlite check below anyway; checking both up front makes "no usable
  // Windows build here" one clean skip instead of a confusing failure.
  if (ALLOW_MISSING && (!existsSync(exeSource) || !existsSync(sqliteSource))) {
    log(
      `no usable Windows build under ${relativeToRepo(EXTRACTOR_SOURCE_DIR)} ` +
        '(missing the exe and/or its win-x64 e_sqlite3.dll) — leaving resources/extractor ' +
        'empty (--allow-missing). This package cannot extract models.',
    );
    return false;
  }

  if (!existsSync(exeSource)) {
    fail(
      `${EXTRACTOR_EXECUTABLE} not found at ${relativeToRepo(exeSource)}.\n` +
        '  Build it first: dotnet build native/extractor/Matchline.Extractor.csproj -c Release\n' +
        '  (Mac cross-packaging only: pass --allow-missing to ship without a working launcher.)',
    );
  }

  copyFileSync(exeSource, path.join(EXTRACTOR_STAGE_DIR, EXTRACTOR_EXECUTABLE));

  const configSource = path.join(EXTRACTOR_SOURCE_DIR, EXTRACTOR_CONFIG);
  if (!existsSync(configSource)) {
    fail(`${EXTRACTOR_CONFIG} not found beside the built launcher at ${relativeToRepo(configSource)}.`);
  }
  copyFileSync(configSource, path.join(EXTRACTOR_STAGE_DIR, EXTRACTOR_CONFIG));

  const dlls = dllsIn(EXTRACTOR_SOURCE_DIR);
  if (dlls.length === 0) {
    fail(`No *.dll found beside the built launcher at ${relativeToRepo(EXTRACTOR_SOURCE_DIR)}.`);
  }
  for (const dll of dlls) {
    copyFileSync(path.join(EXTRACTOR_SOURCE_DIR, dll), path.join(EXTRACTOR_STAGE_DIR, dll));
  }

  if (!existsSync(sqliteSource)) {
    fail(
      `e_sqlite3.dll not found at ${relativeToRepo(sqliteSource)}. SQLitePCLRaw did not restore the ` +
        'win-x64 native provider; the launcher cannot open its cache without it.',
    );
  }
  const sqliteDest = path.join(EXTRACTOR_STAGE_DIR, SQLITE_RUNTIME_RELATIVE);
  mkdirSync(path.dirname(sqliteDest), { recursive: true });
  copyFileSync(sqliteSource, sqliteDest);

  log(
    `staged the launcher: exe + config + ${dlls.length} dll(s) + e_sqlite3.dll -> ` +
      `${relativeToRepo(EXTRACTOR_STAGE_DIR)}`,
  );
  return true;
}

/**
 * Copies every built Navisworks adapter's DLLs into its own
 * `native-stage/plugins/navisworks-<year>/` folder — the layout
 * `<install>\Plugins\Matchline.Extraction.Navisworks<year>\` mirrors
 * (native/navisworks-adapter/Matchline.Navisworks.Adapter.props). An adapter
 * that was never built (no Navisworks install to compile against, which is
 * normal on any machine other than the release/proof runner) is skipped
 * rather than failing the package: not every build ships every year's plugin.
 */
function stagePlugins() {
  rmSync(PLUGINS_STAGE_DIR, { recursive: true, force: true });
  mkdirSync(PLUGINS_STAGE_DIR, { recursive: true });

  const nativeDir = path.join(REPO_ROOT, 'native');
  const adapterDirs = readdirSync(nativeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ADAPTER_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  let stagedYears = 0;
  for (const adapterDir of adapterDirs) {
    const releaseDir = path.join(nativeDir, adapterDir, 'bin', 'Release');
    if (!existsSync(releaseDir)) {
      continue;
    }
    const dlls = dllsIn(releaseDir);
    if (dlls.length === 0) {
      continue;
    }
    const dest = path.join(PLUGINS_STAGE_DIR, adapterDir);
    mkdirSync(dest, { recursive: true });
    for (const dll of dlls) {
      copyFileSync(path.join(releaseDir, dll), path.join(dest, dll));
    }
    stagedYears += 1;
    log(`staged ${dlls.length} dll(s) for ${adapterDir} -> ${relativeToRepo(dest)}`);
  }

  if (stagedYears === 0) {
    log('no built Navisworks adapter found under native/navisworks-<year>/bin/Release — resources/plugins is empty.');
  }
}

const stagedExtractor = stageExtractor();
stagePlugins();

if (!stagedExtractor) {
  log('done, without a working launcher (--allow-missing).');
} else {
  log('done.');
}
