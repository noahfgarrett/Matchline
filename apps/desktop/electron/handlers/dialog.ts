import { BrowserWindow, dialog } from 'electron';

import type { PathGrants } from '../security/path-grants.js';

import type { IpcRequest, IpcResponse } from '../../shared/ipc.js';

/**
 * File dialogs live in main (PRODUCT.md §16) — the renderer never sees a path it did not
 * receive through this channel.
 *
 * These three handlers are also the only place a path becomes usable: what the
 * user picked is recorded in {@link PathGrants} on the way out, and every
 * path-taking channel checks against that record (security/path-grants.ts). A
 * path the renderer invented is refused rather than opened.
 */
export function createOpenFileHandler(
  getWindow: () => BrowserWindow | null,
  grants: PathGrants,
): (request: IpcRequest<'dialog:open-file'>) => Promise<IpcResponse<'dialog:open-file'>> {
  return async (request): Promise<IpcResponse<'dialog:open-file'>> => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: request.filters.map((filter) => ({
        name: filter.name,
        extensions: [...filter.extensions],
      })),
    };

    // Sheet-style (modal) when we have a window, standalone only if it has gone away.
    const window = getWindow();
    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);

    const selected = result.filePaths[0];
    if (result.canceled || selected === undefined) {
      return { cancelled: true };
    }

    grants.grant(selected);
    return { cancelled: false, path: selected };
  };
}

/** Screen 1 takes several files at once, so the picker has to as well. */
export function createOpenFilesHandler(
  getWindow: () => BrowserWindow | null,
  grants: PathGrants,
): (
  request: IpcRequest<'dialog:open-files'>,
) => Promise<IpcResponse<'dialog:open-files'>> {
  return async (request): Promise<IpcResponse<'dialog:open-files'>> => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: request.filters.map((filter) => ({
        name: filter.name,
        extensions: [...filter.extensions],
      })),
    };

    const window = getWindow();
    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);

    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true };
    }

    grants.grant(...result.filePaths);
    return { cancelled: false, paths: [...result.filePaths] };
  };
}

/** Where a new project file goes. The only channel that names a path to write. */
export function createSaveFileHandler(
  getWindow: () => BrowserWindow | null,
  grants: PathGrants,
): (request: IpcRequest<'dialog:save-file'>) => Promise<IpcResponse<'dialog:save-file'>> {
  return async (request): Promise<IpcResponse<'dialog:save-file'>> => {
    const options: Electron.SaveDialogOptions = {
      defaultPath: request.defaultName,
      // No `showOverwriteConfirmation`: creating a project never overwrites, so
      // an "are you sure you want to replace it?" prompt would be offering
      // something that does not happen. `project:create` checks for an existing
      // file itself and says so in plain language instead.
      properties: ['createDirectory'],
      filters: request.filters.map((filter) => ({
        name: filter.name,
        extensions: [...filter.extensions],
      })),
    };

    const window = getWindow();
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);

    if (result.canceled || result.filePath === undefined || result.filePath === '') {
      return { cancelled: true };
    }

    grants.grant(result.filePath);
    return { cancelled: false, path: result.filePath };
  };
}
