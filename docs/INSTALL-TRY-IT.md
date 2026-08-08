# INSTALL — the try-it build

This is how you get Matchline running on your Windows machine and click around in it.
No developer tools required for the install itself.

**Read this first — the build is not code-signed.** Windows will warn you about it, loudly,
and that warning is expected. Signing needs a code-signing certificate bought under a
verified company identity, which does not exist yet (it is on the deferred list in
docs/STATUS.md and an open item in docs/DECISIONS.md). Until it does, every Matchline
build — including this one — trips SmartScreen. Section 3 walks through it.

Nothing in this app phones home. There is no updater, no telemetry, no account, and no
network calls of any kind. Everything it reads and writes is on your machine.

---

## 1. Which file to grab

Two Windows artifacts are produced, both 64-bit (x64):

| File | What it is | When to use it |
|---|---|---|
| `Matchline-0.8.0-Setup-x64.exe` | Installer, 86 MB | Normal use. Adds Start-menu and desktop shortcuts, and an entry in *Apps & features* so it can be uninstalled cleanly. |
| `Matchline-0.8.0-win-x64.zip` | The same app, zipped, no installer, 135 MB | If you want to try it without installing anything, or run it off a USB stick. Unzip anywhere and double-click `Matchline.exe`. |

They are that size because each one carries its own copy of Chromium — that is how every
Electron app ships. The installed app takes about 370 MB on disk.

A Mac build (`Matchline-0.8.0-mac-arm64.zip`, Apple Silicon) is produced too, but it is a
development convenience — Navisworks extraction is Windows-only. It is unsigned and
un-notarised as well, so a Mac that *downloads* it will quarantine it; clear that with
`xattr -dr com.apple.quarantine /path/to/Matchline.app` before opening.

Whoever built it will hand you the file directly. If you built it yourself (section 7),
the artifacts are in `apps\desktop\release\`.

---

## 2. Install it

**Installer route.** Double-click `Matchline-0.8.0-Setup-x64.exe`. Work through the
SmartScreen warning first (section 3), then:

1. The installer asks where to put it. The default is
   `C:\Users\<you>\AppData\Local\Programs\Matchline`.
2. It installs **for your user only** — it never asks for an administrator password and
   never touches `C:\Program Files`. If your IT policy blocks per-machine installs, this
   one still works.
3. It creates a desktop shortcut and a Start-menu entry, both named **Matchline**.

**Zip route.** Right-click the zip → *Extract All* → pick a folder you own (Documents or
Desktop is fine; avoid `C:\Program Files`). Open the extracted folder and run
`Matchline.exe`. The same SmartScreen warning appears the first time.

---

## 3. The "unsigned app" warnings, and how to get past them

You will hit up to two of these. Both are Windows telling you it does not recognise the
publisher — which is correct, because the app is unsigned. Neither means anything is wrong
with the file.

**In the browser, while downloading.** Edge or Chrome may say the file "isn't commonly
downloaded" or "may be dangerous". Click the `...` (or the arrow) next to the download and
choose **Keep** → **Keep anyway** / **Show more** → **Keep anyway**.

**When you run it.** A blue box appears:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting. Running this
> app might put your PC at risk.

There is only a **Don't run** button visible. The one you want is hidden:

1. Click the small **More info** link, in the body of the box, above the button.
2. Two lines appear — `App: Matchline-0.8.0-Setup-x64.exe` and
   `Publisher: Unknown publisher`.
3. A second button appears: **Run anyway**. Click it.

That is the whole workaround. `Unknown publisher` is exactly what an unsigned build shows;
once a certificate is in place it will read as the company name instead, and the blue box
stops appearing.

You should only see this on the very first run of each file. If Windows keeps showing it,
the file is probably still marked as "downloaded from the internet": right-click the file →
*Properties* → tick **Unblock** at the bottom of the General tab → *OK*.

Do not do any of this for a Matchline build that did not come from someone you trust,
straight from the repo. The warning being expected here is not a reason to wave it through
elsewhere.

---

## 4. First run

The app opens on a start screen — *Set up a site in about an hour* — with **Start a new
project** on the left and **Open an existing project** on the right. Nothing exists until
you make a project, and the project file is yours: a single file you can move, copy or back
up.

1. **Create the project.** Type a name (name it after the site), click
   **Choose where to save…**, and pick a folder. You get `<YourSite>.matchline`, one SQLite
   file holding the sources manifest, the site profile, everything the app has learned about
   the site, and every compile it has run.
2. **Give it a model extraction.** Matchline never reads an NWD directly — a separate
   Windows worker walks the model once and writes an *extraction cache*. Two ways to get
   one:
   - **You already have a cache file** (a `<64 hex characters>.sqlite`, e.g. from a previous
     run): on the first wizard screen, drag it onto *Drop files here* or use
     **Choose files…**. The app works out what each file is on its own.
   - **You need to make one**: follow **docs/WINDOWS-RUNBOOK.md** end to end. It builds the
     extractor, runs it against your NWD, and writes the cache to the folder you name with
     `--cache-dir`. Then come back here and drop it in.
3. **Add the spreadsheets** you have — MEL, EasyPower export, cable schedule, PMD, P6 — the
   same way, all at once if you like. Any subset works; each one just makes the picture more
   complete.
4. **Work through the wizard.** Nine screens, in order: sources → model scan → asset
   definition → tag anatomy → system resolver → hierarchy → relationship rules → preview/QA
   → publish.
   Every screen states in plain language what it does and shows an example against your own
   data. Nothing is destructive; you can go back and re-run a compile as often as you like.

If a screen behaves oddly, note the screen number and what you clicked — that is the useful
bug report.

---

## 5. Where your files live

| What | Where | Notes |
|---|---|---|
| Your project | Wherever you saved `<YourSite>.matchline` | The whole project. Back this up. |
| App settings | `C:\Users\<you>\AppData\Roaming\Matchline\app-state.json` | Only the recent-projects list and a "I last saw this file here" index. Safe to delete; you lose nothing but the recents list. |
| Extraction caches | Wherever you pointed `--cache-dir` (the runbook uses `%USERPROFILE%\matchline-proof\cache`) | Written by the extractor, not by the app. Named by content hash. Re-creatable by re-running the extractor. |
| Exports | Wherever you chose in the save dialog | Generated MEL, EXTO, predecessor matrices, revision diffs. |
| The app itself | `C:\Users\<you>\AppData\Local\Programs\Matchline` (installer) or wherever you unzipped it | |

The project file records source *names* and hashes, never folder paths, so a project you
copy to another machine will ask for its source files again rather than pointing at
directories that do not exist there.

---

## 6. Uninstall and clean up

**Installed with the installer:** *Settings* → *Apps* → *Installed apps* → **Matchline** →
*Uninstall*. Or run `Uninstall Matchline.exe` from the install folder. Either removes the
app and its shortcuts.

**Ran from the zip:** delete the folder you unzipped.

Neither touches your data. To remove that too, delete by hand:

- `C:\Users\<you>\AppData\Roaming\Matchline` — the app's settings and recents.
- your `.matchline` project files, wherever you put them.
- your extraction cache folder.

---

## 7. Build it yourself

From a clean machine, with [Node 24+](https://nodejs.org) and Git installed. These commands
are the same on Windows and macOS.

```
git clone https://github.com/noahfgarrett/Matchline.git
cd Matchline
npm ci
npm run postsetup
npm run build:desktop
npm run package:win
```

- `npm ci` installs from the lockfile exactly — no version drift, no surprise upgrades.
- `npm run postsetup` is what actually fetches the Electron binary (~110 MB). Electron 43
  ships no install script of its own, and the repo's supply-chain policy keeps install
  scripts switched off anyway (docs/APP.md), so this step is not optional: skip it and
  nothing can launch.
- `npm run build:desktop` typechecks the whole workspace and builds the main process,
  preload, and renderer into `apps/desktop/dist`.
- `npm run package:win` produces both Windows artifacts into `apps/desktop/release`.
  The first run downloads the Windows Electron runtime (~120 MB) and the NSIS installer
  tooling; after that it is cached and the build takes about two minutes.

`npm run package:mac` builds the macOS zip instead. Both work from either OS — the Windows
build in section 1 was cross-built on a Mac.

To run it from source without packaging: `npm run dev:desktop`.

To check the engine is healthy, run what CI runs — `npm run build && npm run test:workspaces &&
npm run test:integration && (cd packages/legacy-parity && node --test --test-skip-pattern "frozen
SSM Builder|preserves a frozen edge contract|budget" tests/*.test.mjs)`. Plain `npm test` adds the
legacy differential tests, which compare against a frozen SSM Builder checkout at an absolute path
that exists only on the maintainer's machine, plus wall-clock performance budgets; both fail
everywhere else for reasons that are not about your build.

---

## 8. Known rough edges in this build

None of these are bugs to report — they are known, and each has a reason.

- **Unsigned.** Section 3. Waiting on a certificate.
- **Generic app icon.** The app ships with the stock Electron icon because Matchline has no
  artwork yet. It does not affect anything.
- **No auto-update.** By design: there is no update server and the app makes no network
  calls. New versions arrive as a new file, installed over the old one.
- **Windows x64 only.** No 32-bit and no Windows-on-ARM build. The Mac build is
  Apple Silicon only.
