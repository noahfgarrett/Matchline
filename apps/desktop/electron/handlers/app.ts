import { app } from 'electron';

import type { IpcResponse } from '../../shared/ipc.js';

export async function getVersion(): Promise<IpcResponse<'app:version'>> {
  return { version: app.getVersion() };
}
