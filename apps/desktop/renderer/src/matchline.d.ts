import type { MatchlineApi } from '../../shared/api-types';

declare global {
  interface Window {
    /** Installed by the preload façade. The renderer's only route to the main process. */
    readonly matchline: MatchlineApi;
  }
}

export {};
