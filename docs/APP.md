# APP — desktop application architecture

Implements PRODUCT.md §14–§16. Stack per DECISIONS.md #5: Electron, React, TypeScript,
Vite, TanStack Table/Virtual, dnd-kit, Zod — pinned exact. No Zustand (React state until
proven insufficient). SQLite via Node's built-in `node:sqlite` — no driver dependency.

## Process model (PRODUCT.md §16)

```
apps/desktop/electron/   main process (TypeScript → tsc)
  ├── window/lifecycle, file dialogs
  ├── ProjectStore service (node:sqlite — main process only)
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

## IPC contract

One shared module (`apps/desktop/shared/ipc.ts`) declares every channel: name, Zod
request schema, Zod response schema. Main registers from the declaration table; preload
generates the façade from the same table — a channel cannot exist without its schema.
Large payloads (extraction caches, compiled projects) never cross IPC wholesale: the
renderer asks for pages/summaries (TanStack Virtual consumes windowed slices).

## Project file (PRODUCT.md §15)

`ProjectName.matchline` = SQLite. Tables v2: `meta` (schema version, app version,
created/modified), `sources` (manifest + sha256 + role), `profile` (JSON snapshot +
revision), `learned` (learned-rule sets + item-master tables, JSON), `overrides`
(manual system/relationship overrides, JSON rows), `compiles` (history: input hashes,
profile revision, stats JSON incl. generated-MEL assets for diff baselines, timestamp),
`snapshots` (latest resolved snapshot JSON, keyed by compile), `decisions` (review
decisions), `config` (v2: hierarchy, roleGraph, ladder, ssmDisciplineProjection,
parentTagProperty — the whole configuration travels WITH the file). Transactional
writes; schema_version gate like the extraction cache; v1→v2 migration runs only with
explicit opt-in after an automatic backup copy — `project:open` answers an older file with
a `migration-needed` result instead of a project, and the renderer's confirm card sends
`acceptMigration: true` on the second call. The app-state JSON holds only recents and the
sha256→path index. That index is a convenience, never authority: reopening a project
re-digests each file it points at, and one whose bytes no longer match the recorded hash
is shown as `file-changed` (distinct from `file-missing`) and refuses to compile until it
is added again.

Extraction caches stay in `%LOCALAPPDATA%/Matchline/cache/models/` (or the platform
equivalent via app.getPath) — referenced by hash from `sources`, never embedded.

## Install-script policy

The global `~/.npmrc` sets `ignore-scripts=true` (supply-chain rule). After any fresh
`npm ci`/`npm install`, run the root `postsetup` script: `npm rebuild electron esbuild &&
node node_modules/electron/install.js`. (Electron ≥43 has no postinstall script at all —
the explicit `install.js` invocation is what actually fetches the binary; the rebuild half
covers any future dep that reintroduces install scripts. Vite 8 uses rolldown, so esbuild
is not in the tree; the rebuild is a harmless no-op for it.) Never widen this list without
a DECISIONS.md entry.

## UI surface (built across A1 rounds)

Wizard screens 1–9 (PRODUCT.md §7) → project workspace: SSM tree + Electrical Flow views
(virtualized), review queue, Site Profile Studio, exports panel. Drag reparent creates a
persistent ManualRelationshipOverride via IPC (never a tree-local mutation — §11.5).
Plain-language UI text: what it does, an example, when to change it.
