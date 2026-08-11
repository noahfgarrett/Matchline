/**
 * Proof 2 of 7: read the C#-written cache with the TypeScript reader the app
 * ships.
 *
 * CONFIDENTIALITY. Counts, codes and timings only. Meta values are reported
 * only where they describe Matchline rather than the model: the schema version,
 * the adapter, the extractor. `input_file_name` and `input_sha256` are checked
 * for presence and never printed.
 *
 * The point is that the two halves cannot drift into agreeing only with
 * themselves: `openExtractionCache` validates on open (schema version, required
 * meta keys, declared object count against COUNT(*)), so a handle in hand is
 * already a verdict. Everything after that is counting.
 */
import {
  openExtractionCache,
  REQUIRED_META_KEYS,
  SUPPORTED_SCHEMA_VERSIONS,
} from '@matchline/model-schema';

import { countBy, ProofReport, proofSettings, soleCachePath } from './proof-lib.mjs';

const report = new ProofReport('validate-cache');
const settings = proofSettings();

let cachePath;
try {
  cachePath = soleCachePath(settings.cacheDir);
} catch (error) {
  report.check('exactly one cache to validate', false, error.message);
  report.finish(settings.outDir);
  process.exit();
}

let cache;
const openedAt = Date.now();
try {
  cache = openExtractionCache(cachePath);
} catch (error) {
  // The reason is data, so it can be reported without the message, which may
  // carry the path the reader was pointed at.
  report.check(
    'the cache passes full validation',
    false,
    `refused: ${error?.reason?.kind ?? 'unknown'}`,
  );
  report.finish(settings.outDir);
  process.exit();
}
const openMs = Date.now() - openedAt;

try {
  report.check('the cache passes full validation', true);

  const meta = cache.meta();
  report.check(
    'the schema version is one this reader supports',
    SUPPORTED_SCHEMA_VERSIONS.includes(meta.schemaVersion),
    `schema_version ${meta.schemaVersion}`,
  );
  report.check(
    'every required meta key is present and non-empty',
    REQUIRED_META_KEYS.every((key) => {
      const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = meta[camel];
      return value !== undefined && value !== null && String(value) !== '';
    }),
  );
  report.check('the cache records the bytes it came from', meta.inputSha256.length === 64);
  report.check('the cache records a file name', meta.inputFileName.length > 0);

  // Streamed rather than counted with SQL on purpose: this walks the same
  // reader paths the compiler uses, so a row the reader chokes on fails here
  // rather than during a compile.
  //
  // Tallied as it goes rather than collected: a real model carries upwards of a
  // million property rows and an array of that many strings is a lot of memory
  // to spend on a histogram of a dozen values.
  let propertyCount = 0;
  const valueTypeCounts = new Map();
  const scanStartedAt = Date.now();
  for (const property of cache.allProperties()) {
    propertyCount += 1;
    valueTypeCounts.set(property.valueType, (valueTypeCounts.get(property.valueType) ?? 0) + 1);
  }
  const propertyScanMs = Date.now() - scanStartedAt;

  let walked = 0;
  const walkStartedAt = Date.now();
  for (const _object of cache.walk()) {
    walked += 1;
  }
  const walkMs = Date.now() - walkStartedAt;

  let withBounds = 0;
  for (const object of cache.allObjects()) {
    if (object.bbox !== null) {
      withBounds += 1;
    }
  }

  report.check(
    'the depth-first walk reaches every object',
    walked === cache.objectCount(),
    `walked ${String(walked)} of ${String(cache.objectCount())}`,
  );
  report.check('the model has objects', cache.objectCount() > 0);
  report.check(
    'there are more properties than objects',
    propertyCount > cache.objectCount(),
    `${String(propertyCount)} properties for ${String(cache.objectCount())} objects`,
  );

  const sourceModels = cache.sourceModels();
  const flatSets = [];
  const stack = [...cache.selectionSets()];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    flatSets.push(node);
    stack.push(...node.children);
  }

  const warnings = cache.warnings();

  report.fact('schemaVersion', meta.schemaVersion);
  report.fact('adapterVersion', meta.adapterVersion);
  report.fact('extractorVersion', meta.extractorVersion);
  report.fact('navisworksVersion', meta.navisworksVersion);
  report.fact('objects', cache.objectCount());
  report.fact('properties', propertyCount);
  report.fact('sourceModelRoots', sourceModels.length);
  report.fact('selectionSets', flatSets.length);
  report.fact('selectionSetsByKind', countBy(flatSets.map((set) => set.kind)));
  report.fact(
    'selectionSetMembers',
    flatSets.reduce((total, set) => total + set.memberObjectIds.length, 0),
  );
  report.fact('objectsWithBoundingBox', withBounds);
  report.fact('warnings', warnings.length);
  report.fact('warningsBySeverity', countBy(warnings.map((warning) => warning.severity)));
  report.fact('warningsByCode', countBy(warnings.map((warning) => warning.code)));
  report.fact(
    'propertyValueTypes',
    Object.fromEntries([...valueTypeCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  );
  report.fact('openMs', openMs);
  report.fact('propertyScanMs', propertyScanMs);
  report.fact('walkMs', walkMs);
} finally {
  cache.close();
}

report.finish(settings.outDir);
