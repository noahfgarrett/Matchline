import { BrowserWindow, dialog } from 'electron';

import type { IpcRequest, IpcResponse } from '../../shared/ipc.js';

/**
 * File dialogs live in main (PRODUCT.md §16) — the renderer never sees a path it did not
 * receive through this channel.
 */
export function createOpenFileHandler(
  getWindow: () => BrowserWindow | null,
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

    return { cancelled: false, path: selected };
  };
}

/** Screen 1 takes several files at once, so the picker has to as well. */
export function createOpenFilesHandler(
  getWindow: () => BrowserWindow | null,
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

    return { cancelled: false, paths: [...result.filePaths] };
  };
}

/** Where a new project file goes. The only channel that names a path to write. */
export function createSaveFileHandler(
  getWindow: () => BrowserWindow | null,
): (request: IpcRequest<'dialog:save-file'>) => Promise<IpcResponse<'dialog:save-file'>> {
  return async (request): Promise<IpcResponse<'dialog:save-file'>> => {
    const options: Electron.SaveDialogOptions = {
      defaultPath: request.defaultName,
      // The project file is created by ProjectStore, which refuses to overwrite;
      // the dialog's own overwrite prompt would promise something we do not do.
      properties: ['createDirectory', 'showOverwriteConfirmation'],
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

    return { cancelled: false, path: result.filePath };
  };
}
