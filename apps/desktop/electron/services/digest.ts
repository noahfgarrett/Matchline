import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

/**
 * Content hashing, streamed — the one way this app learns what a file is.
 *
 * Its own module rather than a corner of `sources.ts` because three very
 * different callers need it and none of them wants what the rest of that file
 * pulls in: the project session re-proves a reopened project's files, the
 * extraction service hashes a multi-gigabyte NWD before launching Navisworks,
 * and the compile worker proves that the cache it opened by path is the cache
 * the session vouched for. A worker thread importing the whole source-
 * identification module — workbook detection, the project store, the wire
 * schemas — to hash a file would pay for all of it on every compile.
 *
 * There is no synchronous variant, on purpose. The one that existed was called
 * from `ProjectService.open`, which is why opening a project with a 700 MB
 * model in it stopped the window drawing until every byte had been read
 * (RELEASE-1.0-PLAN, "Main process never blocked by hashing"). Opening is
 * asynchronous now and there is nothing left that cannot wait for a promise.
 */

export interface FileDigest {
  readonly sha256: string;
  readonly byteSize: number;
}

/** Bytes read per hashing step. Matches `FileHasher.BufferBytes` in the launcher. */
const HASH_CHUNK_BYTES = 1 << 20;

/**
 * Files below this get no progress events: they are hashed inside one tick of
 * the wizard's own "Reading…" state and a progress bar for them would flicker
 * rather than inform.
 */
const HASH_PROGRESS_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** How much has to be read between progress events on a file large enough to have them. */
const HASH_PROGRESS_INTERVAL_BYTES = 32 * 1024 * 1024;

export type DigestProgress = (bytesDone: number, bytesTotal: number) => void;

/** Thrown when a hash was abandoned because its signal was aborted. */
export class DigestAbortedError extends Error {
  constructor(absolutePath: string) {
    super(`Hashing was cancelled: ${absolutePath}`);
    this.name = 'DigestAbortedError';
  }
}

/**
 * The sha256 of a file, streamed.
 *
 * Never `readFileSync`: a source may be a multi-gigabyte NWD, and reading one
 * into a Buffer to hash it is both a main-process stall and an allocation the
 * size of the model (RELEASE-1.0-PLAN, "Streaming SHA-256, no full-file
 * buffers"). The stream reads a megabyte at a time and the event loop is free
 * between chunks, which is what lets the window keep drawing while a 700 MB
 * model is hashed.
 *
 * Progress is reported for a file big enough for the wait to be noticeable,
 * which is the same reason the launcher's own hash stage reports it.
 *
 * `signal` stops the read where it is. Without it, cancelling a job that is
 * hashing a 40 GB federated model only takes effect when the last byte has been
 * read — the button says the work stopped while the disk says otherwise. The
 * stream is destroyed and the promise rejects with {@link DigestAbortedError},
 * which callers distinguish from a genuine read failure.
 */
export function digestFile(
  absolutePath: string,
  onProgress?: DigestProgress,
  signal?: AbortSignal,
): Promise<FileDigest> {
  const byteSize = statSync(absolutePath).size;
  const reportProgress = onProgress !== undefined && byteSize > HASH_PROGRESS_THRESHOLD_BYTES;

  return new Promise<FileDigest>((resolve, reject): void => {
    // Already aborted before a single byte was read: no stream is opened at
    // all, rather than one opened and torn down on the next tick.
    if (signal?.aborted === true) {
      reject(new DigestAbortedError(absolutePath));
      return;
    }
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath, { highWaterMark: HASH_CHUNK_BYTES });

    // The listener is removed on every exit path: a service that hashes forty
    // files under one controller would otherwise accumulate forty listeners.
    const onAbort = (): void => {
      stream.destroy();
      reject(new DigestAbortedError(absolutePath));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const release = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    let done = 0;
    /** How far along the last progress event was, so they land evenly. */
    let reportedAt = 0;

    if (reportProgress) {
      onProgress(0, byteSize);
    }

    stream.on('data', (chunk: string | Buffer): void => {
      hash.update(chunk);
      done += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (reportProgress && done - reportedAt >= HASH_PROGRESS_INTERVAL_BYTES) {
        reportedAt = done;
        onProgress(done, byteSize);
      }
    });
    stream.on('error', (error: Error): void => {
      release();
      reject(error);
    });
    stream.on('end', (): void => {
      release();
      if (reportProgress) {
        onProgress(done, byteSize);
      }
      resolve({ sha256: hash.digest('hex'), byteSize });
    });
  });
}

/**
 * Runs `work` over `items`, at most `limit` at a time, answering in input order.
 *
 * The bound is the whole point. Re-proving a reopened project means hashing
 * every registered file, and firing forty streams at one disk is slower than
 * four — and on a project holding forty models it is also forty megabyte
 * buffers alive at once. Four is enough to keep a spinning disk and an SSD
 * alike busy while a serial walk would leave both idle between files.
 */
export const DIGEST_CONCURRENCY = 4;

export async function mapBounded<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  work: (item: TItem, index: number) => Promise<TResult>,
): Promise<readonly TResult[]> {
  const results = new Array<TResult>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      // A hole in a sparse array is skipped rather than treated as the end:
      // stopping the lane there would silently drop every item after it.
      if (item === undefined) {
        continue;
      }
      results[index] = await work(item, index);
    }
  };

  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return results;
}
