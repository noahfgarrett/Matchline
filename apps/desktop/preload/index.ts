import { contextBridge, ipcRenderer } from 'electron';

import { createMatchlineApi } from '../shared/create-api.js';

/**
 * The whole preload (APP.md: "typed façade only — no logic, no Node APIs leaked").
 *
 * Bundled to CommonJS by vite.preload.config.ts because a sandboxed preload cannot use
 * ESM or resolve arbitrary modules at runtime.
 */
contextBridge.exposeInMainWorld(
  'matchline',
  createMatchlineApi((channel: string, request: unknown): Promise<unknown> =>
    ipcRenderer.invoke(channel, request),
  ),
);
