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

export function registerIpc(
  ipcMain: IpcMainLike,
  handlers: IpcHandlerMap,
  isTrustedSender: IpcSenderCheck,
): void {
  for (const channel of IPC_CHANNEL_NAMES) {
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
 * Sender validation (PRODUCT.md §16). A frame is trusted only when it is a frame we
 * loaded ourselves: no null frame, and a URL under one of the app's own origins.
 */
export function createSenderCheck(allowedOrigins: readonly string[]): IpcSenderCheck {
  const origins = allowedOrigins.filter((origin: string): boolean => origin.length > 0);

  return (event: IpcInvokeEventLike): boolean => {
    const frame = event.senderFrame;
    if (frame === null) {
      return false;
    }
    return origins.some((origin: string): boolean => frame.url.startsWith(origin));
  };
}
