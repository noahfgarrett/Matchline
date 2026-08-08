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

export type MatchlineApi = {
  readonly [TDomain in DomainOf<IpcChannelName>]: {
    readonly [TChannel in IpcChannelName as TChannel extends `${TDomain}:${infer Verb}`
      ? CamelCase<Verb>
      : never]: IpcMethod<TChannel>;
  };
};
