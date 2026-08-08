import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { net, protocol } from 'electron';

import { APP_HOST, APP_SCHEME } from './csp.js';

/**
 * Serves the built renderer from `app://renderer/...` instead of `file://`.
 *
 * Two reasons (PRODUCT.md §16): a registered standard scheme gives the document a real,
 * secure origin so `'self'`-style CSP directives actually mean something, and every
 * request is funnelled through one handler that can refuse anything outside the bundle.
 */

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** Must run after `app.whenReady()`. */
export function serveRendererFrom(rendererRoot: string): void {
  const root = path.resolve(rendererRoot);

  protocol.handle(APP_SCHEME, async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.hostname !== APP_HOST) {
      return new Response('Not found', { status: 404 });
    }

    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(root, relativePath === '' ? 'index.html' : relativePath);

    // Refuse anything that escapes the bundle directory (`..`, absolute paths, symlink
    // bait). `root + path.sep` so a sibling directory sharing the prefix cannot pass.
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(target).toString());
  });
}
