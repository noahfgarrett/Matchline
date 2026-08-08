import { IPC_CHANNEL_NAMES } from './ipc.js';

import type { MatchlineApi } from './api-types.js';

/**
 * Generates the preload façade from the channel table. Kept free of Electron imports so
 * it can be unit-tested against a fake invoker.
 */

export type IpcInvoker = (channel: string, request: unknown) => Promise<unknown>;

/** `open-file` -> `openFile`. Mirrors the `CamelCase` type in api-types.ts. */
export function toCamelCase(segment: string): string {
  return segment.replace(/-([a-z0-9])/g, (_match: string, character: string): string =>
    character.toUpperCase(),
  );
}

export function createMatchlineApi(invoke: IpcInvoker): MatchlineApi {
  const api: Record<string, Record<string, (request: unknown) => Promise<unknown>>> = {};

  for (const channel of IPC_CHANNEL_NAMES) {
    const separatorIndex = channel.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex === channel.length - 1) {
      throw new Error(`Channel "${channel}" is not in domain:verb form.`);
    }

    const domain = channel.slice(0, separatorIndex);
    const verb = toCamelCase(channel.slice(separatorIndex + 1));

    const methods = api[domain] ?? {};
    methods[verb] = (request: unknown): Promise<unknown> => invoke(channel, request);
    api[domain] = methods;
  }

  // The loop above builds exactly the domain/verb structure MatchlineApi describes; the
  // shape cannot be proven to the compiler because it is assembled from dynamic keys.
  return api as unknown as MatchlineApi;
}
