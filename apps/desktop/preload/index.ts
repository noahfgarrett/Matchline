import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { createMatchlineApi } from '../shared/create-api.js';

import type { MatchlineApi, MatchlineFileBridge } from '../shared/api-types.js';

/**
 * The whole preload (APP.md: "typed façade only — no logic, no Node APIs leaked").
 *
 * Bundled to CommonJS by vite.preload.config.ts because a sandboxed preload cannot use
 * ESM or resolve arbitrary modules at runtime. `contextBridge`, `ipcRenderer` and
 * `webUtils` are all on the sandboxed preload's module allowlist; nothing else here is
 * an Electron API.
 */

/**
 * The path behind a dropped `File`.
 *
 * Electron 43 removed the `File.path` augmentation, and `webUtils.getPathForFile` is
 * the replacement — a synchronous lookup that only a preload can perform. It throws
 * when handed something that is not a `File`, and returns `''` for a `File` the page
 * built itself; both come back as `''` so a caller has one thing to check.
 *
 * Handing the renderer a path it did not already have is not a widening: it dropped the
 * file, so it knows what it dropped. Nothing downstream treats the string as an
 * authority — `source:add-dropped` re-screens it in main (electron/services/sources.ts).
 */
const files: MatchlineFileBridge = {
  pathOf(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

const api: MatchlineApi = {
  ...createMatchlineApi((channel: string, request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(channel, request),
  ),
  files,
};

contextBridge.exposeInMainWorld('matchline', api);
