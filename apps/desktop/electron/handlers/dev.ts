import type { IpcRequest, IpcResponse } from '../../shared/ipc.js';

/** Echo. Proves the transport end to end without touching any real service. */
export async function ping(
  request: IpcRequest<'dev:ping'>,
): Promise<IpcResponse<'dev:ping'>> {
  return { message: request.message };
}
