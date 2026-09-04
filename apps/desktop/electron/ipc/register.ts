import {
  IPC_CHANNELS,
  IPC_CHANNEL_NAMES,
  type IpcChannelName,
  type IpcErrorCode,
  type IpcFailure,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from '../../shared/ipc.js';

/**
 * Table-driven `ipcMain.handle` registration (APP.md "IPC contract").
 *
 * Every invoke passes three gates before a handler runs: the sender must be one of ours,
 * the request must satisfy its Zod schema, and the handler's return value must satisfy
 * the response schema. Failures resolve as typed `IpcFailure` envelopes rather than
 * rejecting, so the renderer never has to interpret a stringified Error.
 *
 * Electron types are described structurally so this module — and its tests — never
 * import `electron`.
 */

export interface IpcSenderLike {
  readonly url: string;
}

export interface IpcInvokeEventLike {
  readonly senderFrame: IpcSenderLike | null;
}

export type IpcInvokeListener = (
  event: IpcInvokeEventLike,
  request: unknown,
) => Promise<unknown>;

export interface IpcMainLike {
  handle(channel: string, listener: IpcInvokeListener): void;
}

export type IpcSenderCheck = (event: IpcInvokeEventLike) => boolean;

export type IpcHandlerMap = {
  readonly [TChannel in IpcChannelName]: (
    request: IpcRequest<TChannel>,
  ) => Promise<IpcResponse<TChannel>>;
};

/** Thrown by a handler that wants to pick the failure code the renderer sees. */
export class IpcHandlerError extends Error {
  public readonly code: IpcErrorCode;

  public constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'IpcHandlerError';
    this.code = code;
  }
}

function failure(code: IpcErrorCode, message: string): IpcFailure {
  return { ok: false, error: { code, message } };
}

/** Options for {@link registerIpc}. */
export interface RegisterIpcOptions {
  /**
   * Channels to leave unregistered.
   *
   * The handler map stays total — every channel in the table still has to have
   * a handler written for it, which is the guarantee that makes the table the
   * whole contract — and this decides which of them are actually reachable in
   * this build. It exists for `dev:ping`, an echo channel that has no business
   * answering in a shipped app; an omitted channel has no `ipcMain.handle`
   * registration at all, so an invoke of it rejects rather than being served.
   */
  readonly omit?: ReadonlySet<IpcChannelName>;
}

export function registerIpc(
  ipcMain: IpcMainLike,
  handlers: IpcHandlerMap,
  isTrustedSender: IpcSenderCheck,
  options: RegisterIpcOptions = {},
): void {
  for (const channel of IPC_CHANNEL_NAMES) {
    if (options.omit?.has(channel) === true) {
      continue;
    }
    const declaration = IPC_CHANNELS[channel];
    // The table and the handler map are keyed by the same union, so this pairing is
    // guaranteed by construction; only the dynamic lookup hides that from the compiler.
    const handler = handlers[channel] as (request: unknown) => Promise<unknown>;

    ipcMain.handle(channel, async (event, request): Promise<IpcResult<unknown>> => {
      if (!isTrustedSender(event)) {
        return failure('unauthorized-sender', `Rejected "${channel}" from an unknown frame.`);
      }

      const parsedRequest = declaration.request.safeParse(request);
      if (!parsedRequest.success) {
        return failure(
          'invalid-request',
          `Request for "${channel}" failed validation: ${parsedRequest.error.message}`,
        );
      }

      let result: unknown;
      try {
        result = await handler(parsedRequest.data);
      } catch (error: unknown) {
        if (error instanceof IpcHandlerError) {
          return failure(error.code, error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        return failure('handler-failed', `Handler for "${channel}" threw: ${message}`);
      }

      const parsedResponse = declaration.response.safeParse(result);
      if (!parsedResponse.success) {
        return failure(
          'invalid-response',
          `Response from "${channel}" failed validation: ${parsedResponse.error.message}`,
        );
      }

      return { ok: true, data: parsedResponse.data };
    });
  }
}

/**
 * The scheme-and-authority of a URL, or `null` when it is not a URL at all.
 *
 * Not `URL.origin`: `app://` is not a scheme the URL standard knows, so its
 * origin is the opaque string `"null"` — and comparing opaque origins would
 * make every `app://` URL equal to every other one. `protocol` + `host` is the
 * comparison that actually distinguishes `app://renderer` from
 * `app://renderer-evil`, and it matches `origin` exactly for http(s), where
 * `host` already carries the port.
 *
 * Exported because navigation lockdown in the main process has to answer the
 * same question, and two implementations of "is this ours" is one too many.
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Sender validation (PRODUCT.md §16). A frame is trusted only when it is a frame we
 * loaded ourselves: no null frame, and a URL whose origin is *equal to* one of the
 * app's own.
 *
 * Equality rather than a prefix test, which is what a hostname like
 * `renderer-evil` or a port like `51730` would otherwise walk straight through.
 */
export function createSenderCheck(allowedOrigins: readonly string[]): IpcSenderCheck {
  const origins = new Set<string>();
  for (const candidate of allowedOrigins) {
    const origin = originOf(candidate);
    if (origin !== null) {
      origins.add(origin);
    }
  }

  return (event: IpcInvokeEventLike): boolean => {
    const frame = event.senderFrame;
    if (frame === null) {
      return false;
    }
    const origin = originOf(frame.url);
    return origin !== null && origins.has(origin);
  };
}
