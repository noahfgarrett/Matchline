export const DURABLE_PROFILE_STORAGE_VERSION = 1
export const DEFAULT_DURABLE_PROFILE_STORAGE_KEY = 'ssmanagement.site-profiles.durable.v1'
export const PORTABLE_PROFILE_ENVELOPE_KIND = 'ssmanagement.profile-envelope'

const GENERATION_KIND = 'ssmanagement.profile-generation'
const SLOT_NAMES = Object.freeze(['a', 'b'])

function errorDetails(error) {
  return {
    name: String(error && error.name || 'Error'),
    message: String(error && error.message || error || 'Unknown storage error'),
  }
}

function storageFailureCode(error) {
  const name = String(error && error.name || '')
  const code = Number(error && error.code)
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014) {
    return 'quota_exceeded'
  }
  return 'write_failed'
}

function jsonClone(value) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Value is not JSON-serializable')
  return JSON.parse(serialized)
}

function canonicalStringify(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']'
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function checksumJson(value) {
  const canonical = canonicalStringify(jsonClone(value))
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return 'fnv1a32:' + (hash >>> 0).toString(16).padStart(8, '0')
}

function clockValue(clock) {
  const raw = typeof clock === 'function' ? clock() : clock && typeof clock.now === 'function' ? clock.now() : Date.now()
  const value = raw instanceof Date ? raw.getTime() : Number(raw)
  if (!Number.isFinite(value)) throw new TypeError('Clock must return a finite timestamp')
  return Math.trunc(value)
}

function generationChecksum(record) {
  return checksumJson({
    kind: record.kind,
    version: record.version,
    generation: record.generation,
    writtenAt: record.writtenAt,
    payload: record.payload,
  })
}

function envelopeChecksum(envelope) {
  return checksumJson({
    kind: envelope.kind,
    version: envelope.version,
    exportedAt: envelope.exportedAt,
    payload: envelope.payload,
  })
}

function decodeGeneration(raw) {
  let record
  try {
    record = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: 'invalid_json', message: errorDetails(error).message }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'invalid_record', message: 'Generation must be a JSON object' }
  }
  if (record.kind !== GENERATION_KIND || record.version !== DURABLE_PROFILE_STORAGE_VERSION) {
    return { ok: false, reason: 'unsupported_record', message: 'Generation format or version is not supported' }
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    return { ok: false, reason: 'invalid_generation', message: 'Generation number is invalid' }
  }
  if (!Number.isFinite(record.writtenAt)) {
    return { ok: false, reason: 'invalid_timestamp', message: 'Generation timestamp is invalid' }
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'payload')) {
    return { ok: false, reason: 'missing_payload', message: 'Generation payload is missing' }
  }
  let expected
  try {
    expected = generationChecksum(record)
  } catch (error) {
    return { ok: false, reason: 'invalid_payload', message: errorDetails(error).message }
  }
  if (record.checksum !== expected) {
    return { ok: false, reason: 'checksum_mismatch', message: 'Generation checksum does not match its payload' }
  }
  return { ok: true, record }
}

function inspectSlots(storage, slotKeys) {
  const slots = []
  for (let index = 0; index < slotKeys.length; index++) {
    const key = slotKeys[index]
    let raw
    try {
      raw = storage.getItem(key)
    } catch (error) {
      return { ok: false, code: 'read_failed', error: errorDetails(error), slots }
    }
    if (raw === null) {
      slots.push({ state: 'empty', slot: SLOT_NAMES[index], key, raw: null })
      continue
    }
    const decoded = decodeGeneration(raw)
    if (!decoded.ok) {
      slots.push({
        state: 'corrupt',
        slot: SLOT_NAMES[index],
        key,
        raw,
        reason: decoded.reason,
        message: decoded.message,
      })
      continue
    }
    slots.push({
      state: 'valid',
      slot: SLOT_NAMES[index],
      key,
      raw,
      record: decoded.record,
    })
  }
  return { ok: true, slots }
}

function newestSlot(valid) {
  return [...valid].sort((left, right) => {
    if (right.record.generation !== left.record.generation) return right.record.generation - left.record.generation
    if (right.record.writtenAt !== left.record.writtenAt) return right.record.writtenAt - left.record.writtenAt
    return right.slot.localeCompare(left.slot)
  })[0]
}

function publicCorruption(slot) {
  return {
    slot: slot.slot,
    key: slot.key,
    raw: slot.raw,
    reason: slot.reason,
    message: slot.message,
  }
}

function snapshotFromInspection(inspection) {
  if (!inspection.ok) {
    return {
      ok: false,
      status: 'error',
      code: inspection.code,
      error: inspection.error,
      corrupt: inspection.slots.filter(slot => slot.state === 'corrupt').map(publicCorruption),
    }
  }
  const valid = inspection.slots.filter(slot => slot.state === 'valid')
  const corrupt = inspection.slots.filter(slot => slot.state === 'corrupt').map(publicCorruption)
  if (!valid.length) {
    return {
      ok: false,
      status: corrupt.length ? 'corrupt' : 'empty',
      code: corrupt.length ? 'no_valid_generation' : 'empty',
      corrupt,
    }
  }
  const newest = newestSlot(valid)
  return {
    ok: true,
    status: corrupt.length ? 'degraded' : 'ok',
    value: jsonClone(newest.record.payload),
    generation: newest.record.generation,
    writtenAt: newest.record.writtenAt,
    slot: newest.slot,
    key: newest.key,
    checksum: newest.record.checksum,
    validGenerations: valid.map(slot => ({
      slot: slot.slot,
      key: slot.key,
      generation: slot.record.generation,
      writtenAt: slot.record.writtenAt,
      checksum: slot.record.checksum,
    })),
    corrupt,
  }
}

function rollbackChangedSlot(storage, key, previousRaw) {
  try {
    const currentRaw = storage.getItem(key)
    if (currentRaw === previousRaw) return { ok: true, changed: false }
    if (previousRaw === null) {
      if (typeof storage.removeItem !== 'function') {
        return { ok: false, changed: true, error: { name: 'StorageError', message: 'Storage has no removeItem method' } }
      }
      storage.removeItem(key)
    } else {
      storage.setItem(key, previousRaw)
    }
    const restored = storage.getItem(key) === previousRaw
    return restored
      ? { ok: true, changed: true }
      : { ok: false, changed: true, error: { name: 'StorageError', message: 'Previous generation could not be restored' } }
  } catch (error) {
    return { ok: false, changed: true, error: errorDetails(error) }
  }
}

export function createPortableProfileEnvelope(payload, options = {}) {
  const envelope = {
    kind: PORTABLE_PROFILE_ENVELOPE_KIND,
    version: DURABLE_PROFILE_STORAGE_VERSION,
    exportedAt: clockValue(options.clock),
    payload: jsonClone(payload),
  }
  envelope.checksum = envelopeChecksum(envelope)
  return envelope
}

export function serializePortableProfileEnvelope(payload, options = {}) {
  return JSON.stringify(createPortableProfileEnvelope(payload, options), null, options.pretty === false ? 0 : 2)
}

export function parsePortableProfileEnvelope(input) {
  let envelope
  try {
    envelope = typeof input === 'string' ? JSON.parse(input) : jsonClone(input)
  } catch (error) {
    return { ok: false, code: 'invalid_json', error: errorDetails(error) }
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, code: 'invalid_envelope', message: 'Portable envelope must be a JSON object' }
  }
  if (envelope.kind !== PORTABLE_PROFILE_ENVELOPE_KIND || envelope.version !== DURABLE_PROFILE_STORAGE_VERSION) {
    return { ok: false, code: 'unsupported_envelope', message: 'Portable envelope format or version is not supported' }
  }
  if (!Number.isFinite(envelope.exportedAt) || !Object.prototype.hasOwnProperty.call(envelope, 'payload')) {
    return { ok: false, code: 'invalid_envelope', message: 'Portable envelope metadata is incomplete' }
  }
  let expected
  try {
    expected = envelopeChecksum(envelope)
  } catch (error) {
    return { ok: false, code: 'invalid_payload', error: errorDetails(error) }
  }
  if (envelope.checksum !== expected) {
    return { ok: false, code: 'checksum_mismatch', message: 'Portable envelope checksum does not match its payload' }
  }
  return {
    ok: true,
    envelope,
    value: jsonClone(envelope.payload),
    checksum: envelope.checksum,
    exportedAt: envelope.exportedAt,
  }
}

export function createDurableProfileStorage(options = {}) {
  const config = options && typeof options.getItem === 'function' ? { storage: options } : options
  const baseKey = String(config.key || DEFAULT_DURABLE_PROFILE_STORAGE_KEY)
  const clock = config.clock || Date.now
  const slotKeys = SLOT_NAMES.map(slot => baseKey + '.generation.' + slot)
  let storage = config.storage
  let storageAccessError = null
  if (storage === undefined) {
    try {
      storage = typeof globalThis !== 'undefined' ? globalThis.localStorage : null
    } catch (error) {
      storageAccessError = errorDetails(error)
    }
  }

  function unavailable(operation) {
    if (storageAccessError) return { ok: false, status: 'error', code: operation + '_failed', error: storageAccessError, corrupt: [] }
    if (!storage || typeof storage.getItem !== 'function') {
      return {
        ok: false,
        status: 'error',
        code: 'storage_unavailable',
        error: { name: 'StorageError', message: 'A browser-compatible storage implementation is required' },
        corrupt: [],
      }
    }
    return null
  }

  function inspect() {
    const missing = unavailable('read')
    return missing || inspectSlots(storage, slotKeys)
  }

  function read() {
    const inspection = inspect()
    if (inspection.status === 'error') return inspection
    return snapshotFromInspection(inspection)
  }

  function write(payload) {
    const missing = unavailable('write')
    if (missing) return missing
    if (typeof storage.setItem !== 'function') {
      return {
        ok: false,
        status: 'error',
        code: 'storage_unavailable',
        error: { name: 'StorageError', message: 'Storage has no setItem method' },
        corrupt: [],
      }
    }

    let safePayload
    try {
      safePayload = jsonClone(payload)
    } catch (error) {
      return { ok: false, status: 'error', code: 'serialization_failed', error: errorDetails(error), corrupt: [] }
    }

    const inspection = inspectSlots(storage, slotKeys)
    if (!inspection.ok) return snapshotFromInspection(inspection)
    const corrupt = inspection.slots.filter(slot => slot.state === 'corrupt').map(publicCorruption)
    if (corrupt.length) {
      return {
        ok: false,
        status: 'corrupt',
        code: 'corrupt_generation_present',
        message: 'Corrupt generations must be recovered or explicitly removed before writing',
        corrupt,
      }
    }

    const valid = inspection.slots.filter(slot => slot.state === 'valid')
    const current = valid.length ? newestSlot(valid) : null
    if (current && current.record.generation >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, status: 'error', code: 'generation_overflow', corrupt: [] }
    }
    const target = inspection.slots.find(slot => slot.state === 'empty')
      || [...valid].sort((left, right) => left.record.generation - right.record.generation)[0]
    const generation = (current ? current.record.generation : 0) + 1
    let writtenAt
    try {
      writtenAt = clockValue(clock)
    } catch (error) {
      return { ok: false, status: 'error', code: 'clock_failed', error: errorDetails(error), corrupt: [] }
    }
    const record = {
      kind: GENERATION_KIND,
      version: DURABLE_PROFILE_STORAGE_VERSION,
      generation,
      writtenAt,
      payload: safePayload,
    }
    record.checksum = generationChecksum(record)
    const raw = JSON.stringify(record)
    const previousRaw = target.raw

    try {
      storage.setItem(target.key, raw)
    } catch (error) {
      const rollback = rollbackChangedSlot(storage, target.key, previousRaw)
      return {
        ok: false,
        status: 'error',
        code: storageFailureCode(error),
        error: errorDetails(error),
        rollback,
        corrupt: [],
      }
    }

    let storedRaw
    try {
      storedRaw = storage.getItem(target.key)
    } catch (error) {
      const rollback = rollbackChangedSlot(storage, target.key, previousRaw)
      return {
        ok: false,
        status: 'error',
        code: 'verification_failed',
        error: errorDetails(error),
        rollback,
        corrupt: [],
      }
    }
    const verified = storedRaw === null ? { ok: false, reason: 'missing_after_write' } : decodeGeneration(storedRaw)
    if (!verified.ok || verified.record.generation !== generation || verified.record.checksum !== record.checksum) {
      const rollback = rollbackChangedSlot(storage, target.key, previousRaw)
      return {
        ok: false,
        status: 'error',
        code: 'verification_failed',
        reason: verified.reason || 'unexpected_generation',
        rollback,
        corrupt: storedRaw === null ? [] : [{
          slot: target.slot,
          key: target.key,
          raw: storedRaw,
          reason: verified.reason || 'unexpected_generation',
          message: verified.message || 'Stored generation did not match the attempted write',
        }],
      }
    }
    return {
      ok: true,
      status: 'ok',
      value: jsonClone(verified.record.payload),
      generation,
      writtenAt,
      slot: target.slot,
      key: target.key,
      checksum: record.checksum,
      corrupt: [],
    }
  }

  function exportEnvelope() {
    const snapshot = read()
    if (!snapshot.ok) return snapshot
    try {
      const envelope = createPortableProfileEnvelope(snapshot.value, { clock })
      return {
        ok: true,
        status: snapshot.status,
        envelope,
        json: JSON.stringify(envelope, null, 2),
        sourceGeneration: snapshot.generation,
        sourceChecksum: snapshot.checksum,
        corrupt: snapshot.corrupt,
      }
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        code: 'export_failed',
        error: errorDetails(error),
        corrupt: snapshot.corrupt,
      }
    }
  }

  function importEnvelope(input) {
    const parsed = parsePortableProfileEnvelope(input)
    if (!parsed.ok) return { ...parsed, status: 'error', corrupt: [] }
    const result = write(parsed.value)
    return result.ok
      ? { ...result, imported: true, envelopeChecksum: parsed.checksum }
      : result
  }

  return Object.freeze({
    key: baseKey,
    slotKeys: Object.freeze([...slotKeys]),
    read,
    write,
    exportEnvelope,
    importEnvelope,
  })
}
