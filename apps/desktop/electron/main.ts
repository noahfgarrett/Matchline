import path from 'node:path';

import { BrowserWindow, app, dialog, ipcMain, session, type WebContents } from 'electron';

import { getVersion } from './handlers/app.js';
import { ping } from './handlers/dev.js';
import {
  createOpenFileHandler,
  createOpenFilesHandler,
  createSaveFileHandler,
} from './handlers/dialog.js';
import { createSessionHandlers } from './handlers/session.js';
import {
  createSenderCheck,
  originOf,
  registerIpc,
  type IpcHandlerMap,
} from './ipc/register.js';
import { registerAppScheme, serveRendererFrom } from './security/app-protocol.js';
import { APP_ORIGIN, buildCsp } from './security/csp.js';
import { createPathGrants, type PathGrants } from './security/path-grants.js';
import { createProjectService, type ProjectService } from './services/project-session.js';

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
/** The one origin anything is allowed to load, normalized once. */
const OWN_ORIGIN = originOf(rendererOrigin);

let mainWindow: BrowserWindow | null = null;
let projectService: ProjectService | null = null;
const pathGrants: PathGrants = createPathGrants();

/**
 * Built after `app.whenReady()` because the project service needs the
 * installation's userData directory, which `app` only answers for once it is up.
 */
function buildHandlers(service: ProjectService): IpcHandlerMap {
  return {
    'app:version': getVersion,
    'dialog:open-file': createOpenFileHandler(() => mainWindow, pathGrants),
    'dialog:open-files': createOpenFilesHandler(() => mainWindow, pathGrants),
    'dialog:save-file': createSaveFileHandler(() => mainWindow, pathGrants),
    'dev:ping': ping,
    ...createSessionHandlers(service, pathGrants),
  };
}

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

/** Whether a URL is the app's own renderer, compared by exact origin. */
function isOwnOrigin(url: string): boolean {
  const origin = originOf(url);
  return origin !== null && OWN_ORIGIN !== null && origin === OWN_ORIGIN;
}

/**
 * §16 "no remote content": nothing navigates, embeds or opens outside our own origin.
 *
 * Registered on `web-contents-created` rather than per window, so it also covers
 * contents this file never constructs — a frame, a webview, a devtools-opened
 * target. A lockdown that only holds for windows we remembered to wrap is not a
 * lockdown.
 */
function lockDownNavigation(contents: WebContents): void {
  contents.on('will-navigate', (event, url): void => {
    if (!isOwnOrigin(url)) {
      event.preventDefault();
    }
  });

  contents.on('will-frame-navigate', (event): void => {
    if (!isOwnOrigin(event.url)) {
      event.preventDefault();
    }
  });

  // Nothing in the shell embeds a webview, so every attach is refused outright
  // rather than sanitized into one that might be allowed later.
  contents.on('will-attach-webview', (event): void => {
    event.preventDefault();
  });

  // Nothing in the shell opens a second window yet, so every request is refused.
  contents.setWindowOpenHandler((): { action: 'deny' } => ({ action: 'deny' }));
}

/**
 * Every web permission is denied (PRODUCT.md §2.6, §16).
 *
 * Matchline reads files the user hands it and writes files the user names. It
 * has no use for a camera, a microphone, a location, a notification or clipboard
 * read, so there is no request worth forwarding to the user — a permission
 * prompt in this app would only ever be something going wrong.
 *
 * Both handlers, because they answer different questions: `request` covers the
 * asking, `check` covers `navigator.permissions.query` and the synchronous
 * media checks that never raise a request at all.
 */
function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback): void => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((): boolean => false);
}

/**
 * The spell checker is switched off, and this is a privacy decision rather than
 * a typography one (PRODUCT.md §2.6 "the app makes no network calls").
 *
 * Chromium's spell checker downloads dictionary files from Google's servers on
 * first use. Left on, it would be the one thing in this app that reaches the
 * network — in a tool whose whole promise is that a site's equipment list never
 * leaves the machine.
 */
function disableSpellChecker(): void {
  session.defaultSession.setSpellCheckerEnabled(false);
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
      // See disableSpellChecker: no dictionary downloads, no network.
      spellcheck: false,
    },
  });

  mainWindow = window;

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

/**
 * Releases the project file, whatever else is going wrong.
 *
 * The `.matchline` file is SQLite, and a process that dies holding the handle
 * can leave a lock behind. Called on the way out of an uncaught exception as
 * well as on a normal quit.
 */
function releaseProjectFile(): void {
  try {
    projectService?.close();
  } catch (error: unknown) {
    console.error('[matchline] releasing the project file failed', error);
  }
  projectService = null;
}

/**
 * Process-level failure handling.
 *
 * The two cases are deliberately not symmetric. A rejected promise nobody
 * awaited is logged and nothing else: the app is still running, the user's
 * unsaved wizard answers are still in memory, and throwing them away over a
 * lost promise would be a worse outcome than the bug. An uncaught exception has
 * already unwound whatever was running, so the file handle is released, the
 * user is told rather than left with a window that has quietly stopped
 * answering, and the process exits non-zero.
 */
function installProcessHandlers(): void {
  process.on('unhandledRejection', (reason: unknown): void => {
    console.error('[matchline] unhandled promise rejection', reason);
  });

  process.on('uncaughtException', (error: Error): void => {
    console.error('[matchline] uncaught exception', error);
    releaseProjectFile();
    dialog.showErrorBox(
      'Matchline has to close',
      `Something went wrong that Matchline could not recover from:\n\n${error.message}\n\n` +
        'Your project file has been closed cleanly, so nothing that was saved is lost.',
    );
    app.exit(1);
  });
}

installProcessHandlers();
registerAppScheme();

app.on('web-contents-created', (_event, contents: WebContents): void => {
  lockDownNavigation(contents);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (): void => {
    // A second launch means "show me Matchline". On macOS every window can be
    // closed with the app still running, so there may be nothing to focus.
    if (mainWindow === null) {
      void createMainWindow().catch((error: unknown): void => {
        console.error('[matchline] could not open a window for the second instance', error);
      });
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(
    async (): Promise<void> => {
      applyContentSecurityPolicy();
      denyAllPermissions();
      disableSpellChecker();

      if (devServerUrl === undefined) {
        serveRendererFrom(RENDERER_ROOT);
      }

      projectService = createProjectService({
        userDataDir: app.getPath('userData'),
        appVersion: app.getVersion(),
      });
      registerIpc(ipcMain, buildHandlers(projectService), createSenderCheck([rendererOrigin]));
      await createMainWindow();

      app.on('activate', (): void => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createMainWindow().catch((error: unknown): void => {
            console.error('[matchline] could not reopen the window', error);
          });
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

  // The project file is SQLite; the handle is released deliberately rather than
  // left to process teardown, so a quit mid-write cannot leave a stale lock.
  app.on('will-quit', (): void => {
    releaseProjectFile();
  });
}
