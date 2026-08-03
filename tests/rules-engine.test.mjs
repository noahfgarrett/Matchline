import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEngine } from '../src/rules/engine.js'
import { createMemoryLookup } from '../src/rules/lookup.js'

const PROFILE = {
  schemaVersion: 2,
  anatomies: [{
    id: 'a1', name: 'Std', delimiter: '-', pattern: '^B\\d+-',
    segments: [
      { name: 'building', index: 0, identity: true },
      { name: 'type', index: 1, identity: true },
      { name: 'unit', index: 2, identity: true },
      { name: 'side', index: 3, identity: false },
    ],
  }],
  rules: {
    normalize: [{ id: 'sides', kind: 'stripSuffix', separators: ['-'], suffixes: ['A', 'B'], repeat: true, enabled: true }],
    classify: [{ id: 't', kind: 'segment', target: 'equipmentType', segment: 'type', enabled: true }],
    relate: [],
  },
}

test('resolve returns canonical tag, segments, and attributes together', () => {
  const engine = createEngine(PROFILE)
  const r = engine.resolve('B14-LVS-1234-A')
  assert.equal(r.canonical, 'B14-LVS-1234')
  assert.equal(r.segments.type, 'LVS')
  assert.equal(r.attributes.equipmentType, 'LVS')
  assert.equal(r.anatomyId, 'a1')
})

test('a tag matching no anatomy still normalizes and reports unmatched', () => {
  const engine = createEngine(PROFILE)
  const r = engine.resolve('ZZ-9-A')
  assert.equal(r.canonical, 'ZZ-9')
  assert.equal(r.anatomyId, '')
  assert.equal(r.unmatched, true)
})

test('results are memoized per tag', () => {
  const engine = createEngine(PROFILE)
  assert.equal(engine.resolve('B14-LVS-1234-A'), engine.resolve('B14-LVS-1234-A'))
  assert.equal(engine.stats().misses, 1)
  assert.equal(engine.stats().hits, 1)
})

test('memoisation is keyed on the raw tag, so distinct inputs do not collide', () => {
  const engine = createEngine(PROFILE)
  assert.equal(engine.resolve('B14-LVS-1234-A').canonical, 'B14-LVS-1234')
  assert.equal(engine.resolve('B14-LVS-9999-A').canonical, 'B14-LVS-9999')
  assert.equal(engine.stats().misses, 2)
})

test('an empty tag resolves to an empty result without throwing', () => {
  const engine = createEngine(PROFILE)
  const r = engine.resolve('')
  assert.equal(r.canonical, '')
  assert.equal(r.unmatched, true)
})

test('resolving 20,000 tags stays well under a second and memoises repeats', () => {
  const engine = createEngine(PROFILE)
  const tags = Array.from({ length: 20000 }, (_, i) => `B${100 + (i % 40)}-LVS-${1000 + (i % 500)}-A`)
  const started = performance.now()
  for (const tag of tags) engine.resolve(tag)
  const elapsed = performance.now() - started
  const stats = engine.stats()
  // i%40 and i%500 co-vary as i increases, so the (building, unit) pair only
  // repeats once every lcm(40,500) = 1000 iterations, not every 40*500 = 20000
  // and not every 2000 as a naive "40*500/gcd-ish" guess might suggest.
  // gcd(40,500)=20, lcm(40,500)=40*500/20=1000 -- verified independently
  // (a Set over the generated tags has exactly 1000 members). Assert
  // memoisation actually engaged: 1000 distinct tags, the other 19000
  // resolutions are cache hits.
  assert.equal(stats.misses, 1000)
  assert.equal(stats.hits, 19000)
  assert.ok(elapsed < 1000, `resolving 20,000 tags took ${Math.round(elapsed)}ms`)
})

const STAGED_PROFILE = {
  schemaVersion: 2, anatomies: [], rules: {
    normalize: [
      { id: 'sides', kind: 'stripSuffix', separators: ['-'], suffixes: ['A', 'B'], repeat: true, enabled: true, stage: 'identity' },
      { id: 'variant', kind: 'stripSuffix', separators: ['_'], suffixes: ['CPS', 'NPS'], repeat: false, enabled: true, stage: 'matching' },
    ],
    classify: [], relate: [],
  },
}

test('normalizeOnly applies only the rules matching the given stage', () => {
  const engine = createEngine(STAGED_PROFILE)
  assert.equal(engine.normalizeOnly('PNL-1_CPS-A', 'identity'), 'PNL-1_CPS')
  assert.equal(engine.normalizeOnly('PNL-1_CPS-A', 'matching'), 'PNL-1_CPS-A')
})

test('normalizeOnly with no stage applies every rule, same as resolve()', () => {
  const engine = createEngine(STAGED_PROFILE)
  assert.equal(engine.normalizeOnly('PNL-1_CPS-A'), 'PNL-1')
  assert.equal(engine.resolve('PNL-1_CPS-A').canonical, 'PNL-1')
})

test('normalizeOnly does not affect or consult the resolve() memo', () => {
  const engine = createEngine(STAGED_PROFILE)
  engine.normalizeOnly('PNL-1_CPS-A', 'identity')
  engine.normalizeOnly('PNL-1_CPS-A', 'matching')
  engine.normalizeOnly('PNL-1_CPS-A')
  // none of the normalizeOnly calls above touched the resolve() cache
  assert.equal(engine.stats().misses, 0)
  assert.equal(engine.stats().hits, 0)
  engine.resolve('PNL-1_CPS-A')
  assert.equal(engine.stats().misses, 1)
  // a later normalizeOnly call still does not register as a resolve() hit
  engine.normalizeOnly('PNL-1_CPS-A', 'identity')
  assert.equal(engine.stats().hits, 0)
})

test('engine.relate resolves a parent using the profile rules and given sources', () => {
  const profile = {
    schemaVersion: 2, anatomies: [], rules: {
      normalize: [], classify: [],
      relate: [{ id: 'gis', kind: 'constant', enabled: true, pattern: 'GIS', requiresNoParent: true, parent: 'ROOT' }],
    },
  }
  const engine = createEngine(profile)
  const d = engine.relate('B14-GIS-01', '', { sources: { mel: createMemoryLookup([]) } })
  assert.equal(d.status, 'resolved')
  assert.equal(d.parent, 'ROOT')
})

test('engine.relate passes the resolved attributes of both tag and parent into the rules', () => {
  const profile = {
    schemaVersion: 2, anatomies: [], rules: {
      normalize: [],
      classify: [{ id: 'r', kind: 'pattern', target: 'equipmentType', pattern: 'LVS', value: 'LVS', enabled: true }],
      relate: [{ id: 'g', kind: 'attributeMatch', enabled: true, source: 'mel', when: { equipmentType: 'LVS' }, match: { tagKey: 'x' }, ambiguousReason: 'a', emptyReason: 'b' }],
    },
  }
  const engine = createEngine(profile)
  const sources = { mel: createMemoryLookup([]) }
  assert.equal(engine.relate('B14-LVS-1', '', { sources }).status, 'ambiguous')
  assert.equal(engine.relate('B14-XFM-1', '', { sources }).status, 'none')
})
