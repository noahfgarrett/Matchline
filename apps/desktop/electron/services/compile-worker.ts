import { parentPort, workerData } from 'node:worker_threads';

import {
  compileProject,
  type CompileProjectInput,
  type CompileStage,
  type ConnectivityWorkbookInput,
  type MelWorkbookInput,
} from '@matchline/compiler';
import type { AssetLedger } from '@matchline/asset-identity';
import type { ManualRelationshipOverride, SiteProfileV2 } from '@matchline/domain';
import type { LearnedRuleSet } from '@matchline/learned-rules';
import { openExtractionCache, type ExtractionCache } from '@matchline/model-schema';
import type { ManualAssignment, ManualAssignments } from '@matchline/system-resolver';

import { digestFile, mapBounded, DIGEST_CONCURRENCY } from './digest.js';

/**
 * The compile, on a thread of its own (RELEASE-1.0-PLAN, "Performance /
 * isolation": *worker_threads (compiler)*).
 *
 * `compileProject` is one synchronous call that reads every cache in the
 * universe and walks every asset several times. Run on the main loop it stops
 * the window drawing, stops IPC answering and stops the extraction queue
 * pumping for its whole duration — which on a 250k-object project is not a
 * hitch, it is a hang. So it runs here, and main does nothing but wait.
 *
 * ## What crosses the boundary, and why it is what it is
 *
 * **Not the caches.** A compile input holds open {@link ExtractionCache}
 * handles, and those are `node:sqlite` objects: not transferable, not
 * cloneable, and not meaningfully shareable between threads. So the worker is
 * handed *paths* and opens its own handles. The session's handles stay open in
 * main, untouched, and go on serving screens 2 and 3 while the compile runs.
 *
 * **The bytes, once.** A workbook is a `Uint8Array` and clones straight across.
 * The profile, the ledger, the stored overrides and the learned rules are
 * already JSON-safe by contract — the project store round-trips all four
 * through SQLite columns — so they cross as themselves.
 *
 * **The whole compiled project comes back.** Every published stage output, not
 * a digest of it: the workspace pages the tree, the flow, the review queue and
 * the issue lists out of `CompiledProject`, and every export reads it whole.
 * `CompiledProject` is entirely data — plain objects, arrays, `Map`s and one
 * `Uint8Array` — so structured clone carries it losslessly and there is no
 * bespoke serializer here to fall behind the shape it serializes. The compiler
 * test `stages.test.mjs` pins that property so a future stage output that
 * cannot cross the boundary fails there rather than here.
 *
 * ## Proving the cache is the cache
 *
 * A path is not a file. Between the session opening its handle and this thread
 * opening its own, the bytes at that path can be anything, and a compile over a
 * cache the project never approved is exactly what P0-1's recorded hashes exist
 * to prevent. So every cache is re-digested here, on this thread, and a
 * mismatch refuses the compile by name rather than quietly compiling something
 * else. The read is streamed and bounded, and it is off the main loop.
 */

/** One model source, as the worker is told about it. */
export interface CompileWorkerSource {
  readonly sourceId: string;
  /** Where the cache is on this machine. Never shown to the user. */
  readonly cachePath: string;
  /** The sha256 the project recorded for those bytes. Re-proved here. */
  readonly cacheSha256: string;
  readonly displayName: string;
  readonly rawFileName: string;
}

/** Everything one compile needs, in shapes structured clone can carry. */
export interface CompileWorkerRequest {
  readonly sources: readonly CompileWorkerSource[];
  readonly profile: SiteProfileV2;
  readonly connectivityWorkbooks: readonly ConnectivityWorkbookInput[];
  readonly melWorkbook: MelWorkbookInput | null;
  readonly learnedRules: LearnedRuleSet | null;
  readonly manualRelationshipOverrides: readonly ManualRelationshipOverride[];
  /**
   * The project's manual system assignments, as `[assetRef, assignment]` pairs.
   *
   * Pairs rather than the `ManualAssignments` map the compiler takes, for the
   * same reason every other field here is a plain shape: what crosses this
   * boundary is decided in this file, and a list of tuples is unambiguously
   * cloneable where a `Map` relies on structured clone doing the right thing
   * with a type the compiler happens to have chosen.
   *
   * `assetRef` is whatever the project recorded — a ledger asset id, a bare
   * canonical tag, or a `tag:` id from an older build. It is re-addressed
   * through the ledger in `compile.ts`, and one that resolves to nothing
   * becomes an `orphaned-decision` review item rather than being dropped.
   *
   * These rows existed in every project file and reached the compiler from
   * nowhere: PRODUCT.md §4.1 makes a manual system "always the final word", and
   * it was a word nothing said.
   */
  readonly manualSystemAssignments: ReadonlyArray<readonly [string, ManualAssignment]>;
  /**
   * The asset identity ledger the project's last compile wrote, or `null` when
   * it has never been compiled (P0-9).
   *
   * `null` is not a degraded mode: it is a first compile, which mints the ids.
   * What it must never be is "the project has a ledger and we did not read it".
   */
  readonly previousLedger: AssetLedger | null;
}

/** What the worker says while it works, and what it says when it is done. */
export type CompileWorkerMessage =
  | { readonly kind: 'stage'; readonly stage: CompileStage }
  | { readonly kind: 'done'; readonly project: unknown }
  | {
      readonly kind: 'failed';
      readonly reason: string;
      /**
       * The thrown error's `name`, or `''` when there was not one.
       *
       * Carried because the error itself cannot cross the thread boundary: main
       * receives a message, never an `Error`, so `instanceof
       * AssetCatalogConfigError` is not a question it can ask. The engine's
       * config errors are written as clauses meant to be embedded in a
       * sentence, and this is what lets main pick the right sentence to embed
       * them in instead of matching on their wording.
       */
      readonly errorName: string;
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/**
 * Builds the compiler's input from the request and the caches this thread opened.
 *
 * Assembled key by key rather than with spreads and `??`: under
 * `exactOptionalPropertyTypes` an explicit `melWorkbook: undefined` is not the
 * same as an absent key, and `CompileProjectInput` means absent — a present
 * `undefined` would be read as "a workbook was supplied" by anything that
 * checks with `in`.
 */
function buildCompileInput(
  request: CompileWorkerRequest,
  caches: ReadonlyMap<string, ExtractionCache>,
  onStage: (stage: CompileStage) => void,
): CompileProjectInput {
  const sources: CompileProjectInput['sources'] = request.sources.map((source) => {
    const cache = caches.get(source.sourceId);
    if (cache === undefined) {
      // Unreachable: the map is built from this very list a few lines up.
      throw new Error(`No cache was opened for ${source.sourceId}.`);
    }
    return {
      sourceId: source.sourceId,
      cache,
      displayName: source.displayName,
      rawFileName: source.rawFileName,
    };
  });

  const input: {
    sources: CompileProjectInput['sources'];
    profile: SiteProfileV2;
    includePropertyCatalog: boolean;
    onStage: (stage: CompileStage) => void;
    connectivityWorkbooks?: ReadonlyArray<ConnectivityWorkbookInput>;
    melWorkbook?: MelWorkbookInput;
    learnedRules?: LearnedRuleSet;
    manualRelationshipOverrides?: ReadonlyArray<ManualRelationshipOverride>;
    manualSystemAssignments?: ManualAssignments;
    identityLedger?: AssetLedger;
  } = {
    // Every ready model source, not the first one: a project is a universe
    // (P0-1). `compileProject` reorders by `sourceId` itself, so registering
    // them in a different order is the same compile.
    sources,
    profile: request.profile,
    // Screen 2 builds its own catalog from the same caches; a compile paying
    // for a second streaming pass per cache would be work nothing reads.
    includePropertyCatalog: false,
    onStage,
  };

  if (request.connectivityWorkbooks.length > 0) {
    input.connectivityWorkbooks = [...request.connectivityWorkbooks];
  }
  if (request.melWorkbook !== null) {
    input.melWorkbook = request.melWorkbook;
  }
  if (request.learnedRules !== null) {
    input.learnedRules = request.learnedRules;
  }
  if (request.manualRelationshipOverrides.length > 0) {
    input.manualRelationshipOverrides = [...request.manualRelationshipOverrides];
  }
  if (request.manualSystemAssignments.length > 0) {
    input.manualSystemAssignments = new Map(request.manualSystemAssignments);
  }
  if (request.previousLedger !== null) {
    input.identityLedger = request.previousLedger;
  }

  return input;
}

/**
 * Opens every cache, having first proved it is the one the project recorded.
 *
 * Hashed before it is opened, not after: an unreadable file and a file holding
 * the wrong bytes are different failures, and validating the second by opening
 * it would report the first.
 */
async function openCaches(
  sources: readonly CompileWorkerSource[],
): Promise<Map<string, ExtractionCache>> {
  const digests = await mapBounded(sources, DIGEST_CONCURRENCY, async (source) => {
    try {
      return (await digestFile(source.cachePath)).sha256;
    } catch (error: unknown) {
      throw new Error(
        `Matchline could not read the extracted data for ${source.displayName}: ` +
          `${messageOf(error)}. Add the file again on screen 1, or remove the source.`,
      );
    }
  });

  const caches = new Map<string, ExtractionCache>();
  try {
    sources.forEach((source, index): void => {
      if (digests[index] !== source.cacheSha256) {
        throw new Error(
          `The extracted data for ${source.displayName} is not what this project recorded, ` +
            'so compiling would use content nobody approved. Add the file again on screen 1, ' +
            'or remove the source.',
        );
      }
      caches.set(source.sourceId, openExtractionCache(source.cachePath));
    });
  } catch (error: unknown) {
    for (const cache of caches.values()) {
      cache.close();
    }
    throw error;
  }
  return caches;
}

/**
 * One compile, from a request to a message.
 *
 * Free of `parentPort` so the entry point below is four lines of message
 * passing over something that already answers rather than throws: every way a
 * compile can end is a `CompileWorkerMessage`, including the ways that are not
 * the compiler's fault.
 */
async function runCompileRequest(
  request: CompileWorkerRequest,
  onStage: (stage: CompileStage) => void,
): Promise<CompileWorkerMessage> {
  let caches: Map<string, ExtractionCache>;
  try {
    caches = await openCaches(request.sources);
  } catch (error: unknown) {
    return { kind: 'failed', reason: messageOf(error), errorName: nameOf(error) };
  }

  try {
    const project = compileProject(buildCompileInput(request, caches, onStage));
    return { kind: 'done', project };
  } catch (error: unknown) {
    return { kind: 'failed', reason: messageOf(error), errorName: nameOf(error) };
  } finally {
    // The caches are this thread's, and nothing outlives the compile: leaving
    // one open would hold a file handle for as long as the worker lived, and
    // the worker is terminated rather than asked to exit when a compile is
    // cancelled.
    for (const cache of caches.values()) {
      cache.close();
    }
  }
}

/**
 * The one buffer worth transferring out of a finished compile, if it is there.
 *
 * Deliberately narrow. Everything else in a `CompiledProject` is maps, arrays
 * and strings that a structured clone has to walk anyway; the workbook bytes
 * are the single contiguous allocation where transferring saves a real copy.
 * Read defensively because the project crosses this seam as `unknown` — a build
 * that stopped producing bytes must degrade to a plain clone, not throw on the
 * way out.
 */
function transferableBytesOf(message: CompileWorkerMessage): readonly ArrayBuffer[] {
  if (message.kind !== 'done') {
    return [];
  }
  const project = message.project as { generatedMel?: { workbookBytes?: unknown } } | null;
  const bytes = project?.generatedMel?.workbookBytes;
  return bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
}

/* ------------------------------------------------------------ the entry point */

// `null` when this module is loaded on the main thread rather than spawned,
// which is what an `import type` of the shapes above does. Guarded rather than
// assumed, so importing a type can never start a compile.
if (parentPort !== null) {
  const port = parentPort;
  const request = workerData as CompileWorkerRequest;
  void runCompileRequest(request, (stage): void => {
    port.postMessage({ kind: 'stage', stage } satisfies CompileWorkerMessage);
  }).then(
    (message): void => {
      // The generated MEL's bytes are TRANSFERRED rather than copied. They are
      // the one large flat buffer in a compiled project — a megabyte at ten
      // thousand assets — and a structured clone of them is a second megabyte
      // allocated on main's heap for a value this thread is about to discard.
      // Transferring detaches the buffer here, which is safe precisely because
      // this thread's next act is to exit.
      port.postMessage(message, transferableBytesOf(message));
    },
    (error: unknown): void => {
      // `runCompileRequest` answers rather than throws, so this is a bug in it
      // or an out-of-memory. Either way main is owed a sentence, not silence.
      port.postMessage({
        kind: 'failed',
        reason: messageOf(error),
        errorName: nameOf(error),
      } satisfies CompileWorkerMessage);
    },
  );
}
