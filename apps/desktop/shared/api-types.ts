import type {
  IpcChannelName,
  IpcRequest,
  IpcResponse,
  IpcResult,
} from './ipc.js';

/**
 * The renderer-visible shape of `window.matchline`, derived entirely from the channel
 * table. Adding a channel to the table adds a method here; there is nothing to duplicate.
 */

/** `open-file` -> `openFile`. Mirrors `toCamelCase` in create-api.ts. */
type CamelCase<TSegment extends string> = TSegment extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : TSegment;

type DomainOf<TChannel extends string> = TChannel extends `${infer Domain}:${string}`
  ? Domain
  : never;

/** Zero-argument call for void-request channels, one argument otherwise. */
type IpcMethod<TChannel extends IpcChannelName> = void extends IpcRequest<TChannel>
  ? () => Promise<IpcResult<IpcResponse<TChannel>>>
  : (request: IpcRequest<TChannel>) => Promise<IpcResult<IpcResponse<TChannel>>>;

export type MatchlineChannelApi = {
  readonly [TDomain in DomainOf<IpcChannelName>]: {
    readonly [TChannel in IpcChannelName as TChannel extends `${TDomain}:${infer Verb}`
      ? CamelCase<Verb>
      : never]: IpcMethod<TChannel>;
  };
};

/**
 * The one thing on `window.matchline` that is not a channel.
 *
 * Since Electron 43 a `File` no longer carries a `path`, and the only place the
 * path can still be recovered is a preload calling `webUtils.getPathForFile`.
 * That is a synchronous local lookup, not a message to main, so it is not in the
 * channel table — but the renderer still has to reach it through the same
 * façade, because contextIsolation means the façade is the only thing it can
 * reach at all.
 *
 * Returns `''` for anything the OS has no path for — a `File` the page
 * constructed itself, for instance. Callers drop those rather than sending them.
 */
export interface MatchlineFileBridge {
  readonly pathOf: (file: File) => string;
}

export type MatchlineApi = MatchlineChannelApi & {
  readonly files: MatchlineFileBridge;
};
