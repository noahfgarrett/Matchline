import { realpathSync } from 'node:fs';
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
  // Resolved once: on macOS the bundle commonly sits under a symlinked prefix
  // (`/var` -> `/private/var`), so comparing a real path against a non-real root
  // would refuse every legitimate request.
  const realRoot = ((): string => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  })();

  protocol.handle(APP_SCHEME, async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.hostname !== APP_HOST) {
      return new Response('Not found', { status: 404 });
    }

    // A malformed percent-escape (`app://renderer/%zz`) makes decodeURIComponent
    // throw. Refused as a bad request rather than allowed to reject the promise
    // the protocol handler returns.
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const relativePath = decoded.replace(/^\/+/, '');
    const target = path.resolve(root, relativePath === '' ? 'index.html' : relativePath);

    // Refuse anything that escapes the bundle directory (`..`, absolute paths).
    // `root + path.sep` so a sibling directory sharing the prefix cannot pass.
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    // Then the same question again after following symlinks, which the textual
    // check above cannot see: a link inside the bundle pointing anywhere else is
    // exactly how a path that "is" inside it turns out not to be.
    let realTarget: string;
    try {
      realTarget = realpathSync(target);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(realTarget).toString());
  });
}
