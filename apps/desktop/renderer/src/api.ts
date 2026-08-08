import type { IpcResult } from '../../shared/ipc';

/**
 * The renderer's one rule for talking to main: unwrap the envelope, or throw
 * the message the main process wrote.
 *
 * `registerIpc` never rejects for a contract failure — it resolves with
 * `ok: false` and a sentence meant for a person. Every screen shows that
 * sentence verbatim rather than inventing its own wording, so the plain-language
 * error text lives in exactly one place: the service that raised it.
 */

export class IpcCallError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'IpcCallError';
    this.code = code;
  }
}

export async function call<TData>(invoke: Promise<IpcResult<TData>>): Promise<TData> {
  let result: IpcResult<TData>;
  try {
    result = await invoke;
  } catch (error: unknown) {
    // invoke itself only rejects when the channel is gone — main torn down
    // mid-call. Nothing the user did, so say so plainly.
    throw new IpcCallError(
      'transport',
      error instanceof Error ? error.message : 'Matchline lost contact with its main process.',
    );
  }

  if (!result.ok) {
    throw new IpcCallError(result.error.code, result.error.message);
  }
  return result.data;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** `0.8734` -> `87%`. Whole percent: a preview is a read, not a measurement. */
export function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** Thousands separators, so 12450 does not read as 1245 at a glance. */
export function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** `262144` -> `256 KB`. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex] ?? 'KB'}`;
}
