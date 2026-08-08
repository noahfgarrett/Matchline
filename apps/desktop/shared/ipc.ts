import { z } from 'zod';

/**
 * The single channel-declaration table (APP.md "IPC contract").
 *
 * Main registers handlers from this table; the preload façade is generated from it. A
 * channel cannot exist without both of its schemas, so there is exactly one place where
 * the wire contract lives.
 *
 * Channel names are `domain:verb`. The façade turns those into
 * `window.matchline.<domain>.<camelCasedVerb>(...)` (APP.md process model).
 */

/** Envelope error codes. Every failure the renderer can observe is one of these. */
export const IPC_ERROR_CODES = [
  'unauthorized-sender',
  'unknown-channel',
  'invalid-request',
  'invalid-response',
  'not-implemented',
  'handler-failed',
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export interface IpcFailure {
  readonly ok: false;
  readonly error: {
    readonly code: IpcErrorCode;
    readonly message: string;
  };
}

export interface IpcSuccess<TData> {
  readonly ok: true;
  readonly data: TData;
}

/**
 * Every channel resolves to this envelope — invoke never rejects for a contract failure,
 * it resolves with `ok: false`. Renderer code discriminates on `ok`.
 */
export type IpcResult<TData> = IpcSuccess<TData> | IpcFailure;

export interface IpcChannelDeclaration<
  TRequest extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
> {
  readonly request: TRequest;
  readonly response: TResponse;
  /**
   * A valid request/response pair. Exists so the contract test can prove both schemas
   * round-trip without hand-maintaining a second fixture file.
   */
  readonly example: {
    readonly request: z.infer<TRequest>;
    readonly response: z.infer<TResponse>;
  };
}

const fileFilterSchema = z.object({
  name: z.string().min(1),
  extensions: z.array(z.string().min(1)).min(1),
});

const openFileResultSchema = z.discriminatedUnion('cancelled', [
  z.object({ cancelled: z.literal(true) }),
  z.object({ cancelled: z.literal(false), path: z.string().min(1) }),
]);

export const IPC_CHANNELS = {
  'app:version': {
    request: z.void(),
    response: z.object({ version: z.string().min(1) }),
    example: {
      request: undefined,
      response: { version: '0.1.0' },
    },
  },

  'dialog:open-file': {
    request: z.object({ filters: z.array(fileFilterSchema).min(1) }),
    response: openFileResultSchema,
    example: {
      request: { filters: [{ name: 'Matchline project', extensions: ['matchline'] }] },
      response: { cancelled: false, path: '/Users/dragon/Dragon.matchline' },
    },
  },

  /** Placeholder until @matchline/project-store is wired in (next round). */
  'project:create': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ projectPath: z.string().min(1) }),
    example: {
      request: { path: '/Users/dragon/Dragon.matchline' },
      response: { projectPath: '/Users/dragon/Dragon.matchline' },
    },
  },

  /** Placeholder until @matchline/project-store is wired in (next round). */
  'project:open': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({
      projectPath: z.string().min(1),
      schemaVersion: z.number().int().nonnegative(),
    }),
    example: {
      request: { path: '/Users/dragon/Dragon.matchline' },
      response: { projectPath: '/Users/dragon/Dragon.matchline', schemaVersion: 1 },
    },
  },

  /** Placeholder until the compile service lands. */
  'compile:run': {
    request: z.object({ projectPath: z.string().min(1) }),
    response: z.object({
      compileId: z.string().min(1),
      assetCount: z.number().int().nonnegative(),
    }),
    example: {
      request: { projectPath: '/Users/dragon/Dragon.matchline' },
      response: { compileId: 'compile-1', assetCount: 0 },
    },
  },

  /** Echo channel. Exists so the transport can be exercised end to end. */
  'dev:ping': {
    request: z.object({ message: z.string() }),
    response: z.object({ message: z.string() }),
    example: {
      request: { message: 'dragon' },
      response: { message: 'dragon' },
    },
  },
} as const satisfies Record<string, IpcChannelDeclaration>;

export type IpcChannelTable = typeof IPC_CHANNELS;
export type IpcChannelName = keyof IpcChannelTable & string;

export type IpcRequest<TChannel extends IpcChannelName> = z.infer<
  IpcChannelTable[TChannel]['request']
>;
export type IpcResponse<TChannel extends IpcChannelName> = z.infer<
  IpcChannelTable[TChannel]['response']
>;

/**
 * Channel names in declaration order. Derived from the table — never hand-written, so a
 * new channel is registered and exposed the moment its schemas exist.
 */
export const IPC_CHANNEL_NAMES: readonly IpcChannelName[] = Object.keys(
  IPC_CHANNELS,
) as IpcChannelName[];
