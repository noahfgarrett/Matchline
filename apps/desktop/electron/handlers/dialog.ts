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
