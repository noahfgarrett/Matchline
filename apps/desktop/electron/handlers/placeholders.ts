import { IpcHandlerError } from '../ipc/register.js';

import type { IpcResponse } from '../../shared/ipc.js';

/**
 * Channels whose services do not exist yet. They are declared now so the
 * contract and the façade are complete; the handlers fail loudly with
 * `not-implemented` rather than returning a fake success the UI could mistake
 * for real data.
 *
 * `compile:run` lands with the compiler worker supervisor, which wizard screens
 * 6-9 are built on.
 */

function notImplemented(service: string): never {
  throw new IpcHandlerError('not-implemented', `${service} is not wired up yet.`);
}

export async function runCompile(): Promise<IpcResponse<'compile:run'>> {
  return notImplemented('The compile service');
}
