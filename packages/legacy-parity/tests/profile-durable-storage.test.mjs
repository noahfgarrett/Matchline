import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checksumJson,
  createDurableProfileStorage,
  createPortableProfileEnvelope,
  parsePortableProfileEnvelope,
  serializePortableProfileEnvelope,
} from '../src/profile/durable-storage.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  const calls = []
  return {
    calls,
    getItem(key) {
      calls.push(['get', key])
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      calls.push(['set', key, value])
      values.set(key, String(value))
    },
    removeItem(key) {
      calls.push(['remove', key])
      values.delete(key)
    },
    raw(key) {
      return values.has(key) ? values.get(key) : null
    },
  }
}

test('writes rotate across two checksummed generations and reads the newest valid payload', () => {
  let now = 1000
  const storage = memoryStorage()
  const durable = createDurableProfileStorage({ storage, key: 'profiles', clock: () => now++ })

  assert.deepEqual(durable.slotKeys, ['profiles.generation.a', 'profiles.generation.b'])
  assert.equal(durable.read().status, 'empty')

  assert.equal(durable.write({ activeId: 'a', profiles: [{ id: 'a', revision: 1 }] }).generation, 1)
  assert.equal(durable.write({ activeId: 'a', profiles: [{ id: 'a', revision: 2 }] }).generation, 2)
  const third = durable.write({ activeId: 'b', profiles: [{ id: 'b', revision: 3 }] })
  assert.equal(third.generation, 3)
  assert.equal(third.slot, 'a', 'the oldest valid slot is replaced after both slots are occupied')

  const read = durable.read()
  assert.equal(read.ok, true)
  assert.equal(read.generation, 3)
  assert.deepEqual(read.value, { activeId: 'b', profiles: [{ id: 'b', revision: 3 }] })
  assert.deepEqual(read.validGenerations.map(item => item.generation).sort(), [2, 3])

  for (const key of durable.slotKeys) {
    const record = JSON.parse(storage.raw(key))
    assert.match(record.checksum, /^fnv1a32:[0-9a-f]{8}$/)
  }
})

test('falls back to the newest valid generation and reports a corrupt newer payload verbatim', () => {
  const storage = memoryStorage()
  const durable = createDurableProfileStorage({ storage, key: 'profiles', clock: () => 1000 })
  durable.write({ revision: 1 })
  durable.write({ revision: 2 })

  const corruptRaw = storage.raw(durable.slotKeys[1]).replace('"revision":2', '"revision":200')
  storage.setItem(durable.slotKeys[1], corruptRaw)
  const read = durable.read()

  assert.equal(read.ok, true)
  assert.equal(read.status, 'degraded')
  assert.equal(read.generation, 1)
  assert.deepEqual(read.value, { revision: 1 })
  assert.deepEqual(read.corrupt, [{
    slot: 'b',
    key: durable.slotKeys[1],
    raw: corruptRaw,
    reason: 'checksum_mismatch',
    message: 'Generation checksum does not match its payload',
  }])
})

test('never overwrites corrupt generations and allows exporting the surviving generation for recovery', () => {
  const storage = memoryStorage()
  const durable = createDurableProfileStorage({ storage, key: 'profiles', clock: () => 2000 })
  durable.write({ revision: 1 })
  durable.write({ revision: 2 })
  storage.setItem(durable.slotKeys[1], '{broken json')
  const corruptRaw = storage.raw(durable.slotKeys[1])
  const callsBeforeWrite = storage.calls.length

  const write = durable.write({ revision: 3 })
  assert.equal(write.ok, false)
  assert.equal(write.code, 'corrupt_generation_present')
  assert.equal(storage.raw(durable.slotKeys[1]), corruptRaw)
  assert.equal(storage.calls.slice(callsBeforeWrite).some(call => call[0] === 'set'), false)

  const exported = durable.exportEnvelope()
  assert.equal(exported.ok, true)
  assert.equal(exported.status, 'degraded')
  assert.deepEqual(exported.envelope.payload, { revision: 1 })
  assert.equal(exported.corrupt[0].raw, corruptRaw)
})

test('reports all corrupt payloads when no valid generation remains', () => {
  const storage = memoryStorage({
    'profiles.generation.a': '{bad',
    'profiles.generation.b': '[]',
  })
  const durable = createDurableProfileStorage({ storage, key: 'profiles' })
  const read = durable.read()

  assert.equal(read.ok, false)
  assert.equal(read.status, 'corrupt')
  assert.equal(read.code, 'no_valid_generation')
  assert.deepEqual(read.corrupt.map(item => item.raw), ['{bad', '[]'])
  assert.deepEqual(read.corrupt.map(item => item.reason), ['invalid_json', 'invalid_record'])
})

test('detects quota and generic write failures without losing the last valid generation', () => {
  const quotaStorage = memoryStorage()
  const quotaDurable = createDurableProfileStorage({ storage: quotaStorage, key: 'quota', clock: () => 1 })
  quotaDurable.write({ revision: 1 })
  const originalSet = quotaStorage.setItem.bind(quotaStorage)
  quotaStorage.setItem = (key, value) => {
    if (key.endsWith('.b')) {
      const error = new Error('Storage quota reached')
      error.name = 'QuotaExceededError'
      throw error
    }
    originalSet(key, value)
  }
  const quota = quotaDurable.write({ revision: 2 })
  assert.equal(quota.ok, false)
  assert.equal(quota.code, 'quota_exceeded')
  assert.equal(quotaDurable.read().generation, 1)

  const failingStorage = memoryStorage()
  failingStorage.setItem = () => {
    throw new Error('Storage is disabled')
  }
  const failed = createDurableProfileStorage({ storage: failingStorage, key: 'failed' }).write({ revision: 1 })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'write_failed')
})

test('verifies every write and rolls back a silently corrupted result', () => {
  const storage = memoryStorage()
  const durable = createDurableProfileStorage({ storage, key: 'profiles', clock: () => 1 })
  durable.write({ revision: 1 })
  const originalSet = storage.setItem.bind(storage)
  storage.setItem = (key, value) => {
    originalSet(key, key.endsWith('.b') ? value.replace('"revision":2', '"revision":9') : value)
  }

  const result = durable.write({ revision: 2 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'verification_failed')
  assert.equal(result.reason, 'checksum_mismatch')
  assert.equal(result.rollback.ok, true)
  assert.equal(storage.raw(durable.slotKeys[1]), null)
  assert.deepEqual(durable.read().value, { revision: 1 })
})

test('portable envelopes round-trip across storage instances and reject tampering', () => {
  const sourceStorage = memoryStorage()
  const source = createDurableProfileStorage({ storage: sourceStorage, key: 'source', clock: () => 1234 })
  source.write({ activeId: 'eagle', profiles: [{ id: 'eagle', name: 'Eagle' }] })
  const exported = source.exportEnvelope()

  assert.equal(exported.ok, true)
  assert.equal(parsePortableProfileEnvelope(exported.json).ok, true)

  const destinationStorage = memoryStorage()
  const destination = createDurableProfileStorage({ storage: destinationStorage, key: 'destination', clock: () => 5678 })
  const imported = destination.importEnvelope(exported.json)
  assert.equal(imported.ok, true)
  assert.equal(imported.imported, true)
  assert.deepEqual(destination.read().value, { activeId: 'eagle', profiles: [{ id: 'eagle', name: 'Eagle' }] })

  const tampered = JSON.parse(exported.json)
  tampered.payload.profiles[0].name = 'Changed'
  const before = destination.read()
  const rejected = destination.importEnvelope(tampered)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'checksum_mismatch')
  assert.deepEqual(destination.read().value, before.value, 'a rejected import leaves durable storage untouched')
})

test('standalone envelope helpers are deterministic, synchronous, and clock-injectable', () => {
  assert.equal(checksumJson({ b: 2, a: 1 }), checksumJson({ a: 1, b: 2 }))
  const envelope = createPortableProfileEnvelope({ profile: 'Eagle' }, { clock: () => new Date(4321) })
  assert.equal(envelope.exportedAt, 4321)
  assert.deepEqual(parsePortableProfileEnvelope(envelope).value, { profile: 'Eagle' })
  assert.equal(JSON.parse(serializePortableProfileEnvelope({ profile: 'Eagle' }, { clock: () => 4321 })).checksum, envelope.checksum)
})

test('reports unavailable storage, read failures, and non-serializable payloads without throwing', () => {
  assert.equal(createDurableProfileStorage({ storage: null }).read().code, 'storage_unavailable')

  const readFailure = createDurableProfileStorage({
    storage: {
      getItem() {
        throw new Error('Blocked')
      },
      setItem() {},
      removeItem() {},
    },
  }).read()
  assert.equal(readFailure.code, 'read_failed')

  const circular = {}
  circular.self = circular
  const serialization = createDurableProfileStorage({ storage: memoryStorage() }).write(circular)
  assert.equal(serialization.code, 'serialization_failed')
})
