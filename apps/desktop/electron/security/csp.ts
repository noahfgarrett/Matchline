/**
 * Content Security Policy (PRODUCT.md §16 "Restrictive Content Security Policy",
 * "Local packaged content only").
 *
 * Production renderer content is served from the app's own `app://` origin, so `'self'`
 * is a real origin rather than the opaque origin a `file://` document would have. Nothing
 * remote is reachable: `default-src 'none'` plus per-type allowances for our own bundle.
 */

export const APP_SCHEME = 'app';
export const APP_HOST = 'renderer';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * The shipping policy. No `unsafe-inline`, no `unsafe-eval`, no remote origins.
 * `img-src` allows `data:` so inline SVG/data-URI icons work without a network fetch.
 */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  `script-src ${APP_ORIGIN}`,
  `style-src ${APP_ORIGIN}`,
  `font-src ${APP_ORIGIN}`,
  `img-src ${APP_ORIGIN} data:`,
  `connect-src ${APP_ORIGIN}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Development only. Vite's React Refresh preamble is an inline script and its HMR client
 * opens a websocket, so the dev policy is deliberately looser — it is never used in a
 * packaged build (see `buildCsp`).
 */
export function buildDevelopmentCsp(devServerUrl: string): string {
  const origin = new URL(devServerUrl).origin;
  const websocketOrigin = origin.replace(/^http/, 'ws');

  return [
    "default-src 'none'",
    `script-src ${origin} 'unsafe-inline'`,
    `style-src ${origin} 'unsafe-inline'`,
    `font-src ${origin} data:`,
    `img-src ${origin} data:`,
    `connect-src ${origin} ${websocketOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function buildCsp(devServerUrl: string | undefined): string {
  return devServerUrl === undefined ? PRODUCTION_CSP : buildDevelopmentCsp(devServerUrl);
}
