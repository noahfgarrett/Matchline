import { IpcHandlerError } from '../ipc/register.js';

import type { IpcResponse } from '../../shared/ipc.js';

/**
 * Channels whose services do not exist yet. They are declared now so the contract and the
 * façade are complete; the handlers fail loudly with `not-implemented` rather than
 * returning a fake success the UI could mistake for real data.
 *
 * `project:*` is wired to @matchline/project-store next round; `compile:run` follows the
 * compiler worker supervisor.
 */

function notImplemented(service: string): never {
  throw new IpcHandlerError('not-implemented', `${service} is not wired up yet.`);
}

export async function createProject(): Promise<IpcResponse<'project:create'>> {
  return notImplemented('ProjectStore.create');
}

export async function openProject(): Promise<IpcResponse<'project:open'>> {
  return notImplemented('ProjectStore.open');
}

export async function runCompile(): Promise<IpcResponse<'compile:run'>> {
  return notImplemented('The compile service');
}
