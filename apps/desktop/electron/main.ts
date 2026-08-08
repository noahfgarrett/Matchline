import path from 'node:path';

import { BrowserWindow, app, ipcMain, session } from 'electron';

import { getVersion } from './handlers/app.js';
import { ping } from './handlers/dev.js';
import { createOpenFileHandler } from './handlers/dialog.js';
import { createProject, openProject, runCompile } from './handlers/placeholders.js';
import { createSenderCheck, registerIpc, type IpcHandlerMap } from './ipc/register.js';
import { registerAppScheme, serveRendererFrom } from './security/app-protocol.js';
import { APP_ORIGIN, buildCsp } from './security/csp.js';

/**
 * Matchline main process (APP.md process model, PRODUCT.md §16).
 *
 * Dev loads the Vite server named by MATCHLINE_DEV_SERVER_URL; every other run serves the
 * built bundle from the app:// scheme. There is no other way to get content into a window.
 */

const DIST_ROOT = path.join(import.meta.dirname, '..');
const PRELOAD_PATH = path.join(DIST_ROOT, 'preload.cjs');
const RENDERER_ROOT = path.join(DIST_ROOT, 'renderer');

const devServerUrl: string | undefined = process.env['MATCHLINE_DEV_SERVER_URL'];
const rendererOrigin = devServerUrl === undefined ? APP_ORIGIN : new URL(devServerUrl).origin;

let mainWindow: BrowserWindow | null = null;

const handlers: IpcHandlerMap = {
  'app:version': getVersion,
  'dialog:open-file': createOpenFileHandler(() => mainWindow),
  'project:create': createProject,
  'project:open': openProject,
  'compile:run': runCompile,
  'dev:ping': ping,
};

/** Send the CSP as a header rather than a meta tag so it also covers dev-server responses. */
function applyContentSecurityPolicy(): void {
  const policy = buildCsp(devServerUrl);

  session.defaultSession.webRequest.onHeadersReceived((details, callback): void => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

/** §16 "no remote content": nothing navigates or opens outside our own origin. */
function lockDownNavigation(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url): void => {
    if (!url.startsWith(rendererOrigin)) {
      event.preventDefault();
    }
  });

  // Nothing in the shell opens a second window yet, so every request is refused.
  window.webContents.setWindowOpenHandler((): { action: 'deny' } => ({ action: 'deny' }));
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#14161a',
    title: 'Matchline',
    webPreferences: {
      preload: PRELOAD_PATH,
      // PRODUCT.md §16, verbatim. Changing any of these needs a DECISIONS.md entry.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow = window;
  lockDownNavigation(window);

  window.once('ready-to-show', (): void => {
    window.show();
  });

  window.on('closed', (): void => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (devServerUrl === undefined) {
    await window.loadURL(`${APP_ORIGIN}/index.html`);
  } else {
    await window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: 'detach' });
  }
}

registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (): void => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(
    async (): Promise<void> => {
      applyContentSecurityPolicy();

      if (devServerUrl === undefined) {
        serveRendererFrom(RENDERER_ROOT);
      }

      registerIpc(ipcMain, handlers, createSenderCheck([rendererOrigin]));
      await createMainWindow();

      app.on('activate', (): void => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createMainWindow();
        }
      });
    },
    (error: unknown): void => {
      console.error('[matchline] startup failed', error);
      app.quit();
    },
  );

  app.on('window-all-closed', (): void => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
