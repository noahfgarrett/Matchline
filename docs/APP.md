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

Security defaults are §16 verbatim; deviations require a DECISIONS.md entry.

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
explicit opt-in after an automatic backup copy. The app-state JSON holds only recents
and the sha256→path index.

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
