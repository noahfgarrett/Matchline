import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RULE_PROFILE_COMPILER_VERSION,
  compareRuleProfileImpact,
  compileRuleProfile,
} from '../src/rules/profile-compiler.js'

const copy = value => JSON.parse(JSON.stringify(value))

function validProfile() {
  return {
    schemaVersion: 3,
    id: 'profile-site-a',
    name: 'Site A',
    basePreset: {
      id: 'eagle',
      version: '1.0.0',
      fingerprint: 'rpc1-eagle',
    },
    attributes: [{ id: 'area', label: 'Area' }],
    anatomies: [{
      id: 'anatomy-equipment',
      name: 'Equipment tags',
      pattern: '^B\\d+-[A-Z]+-\\d+$',
      delimiter: '-',
      segments: [
        { name: 'building', index: 0, identity: false },
        { name: 'role', index: 1, identity: true },
        { name: 'sequence', index: 2, identity: true },
      ],
    }],
    rules: {
      normalize: [{
        id: 'normalize-side',
        name: 'Panel side',
        kind: 'stripSuffix',
        separators: ['-'],
        suffixes: ['A', 'B'],
        stage: 'identity',
        repeat: true,
        enabled: true,
      }],
      classify: [
        {
          id: 'classify-transformer',
          name: 'Transformer',
          kind: 'pattern',
          target: 'equipmentType',
          pattern: '(?:^|-)XFM(?:-|$)',
          value: 'XFM',
          enabled: true,
        },
        {
          id: 'classify-match-key',
          name: 'Last four',
          kind: 'slice',
          target: 'matchKey',
          start: -4,
          minLength: 4,
          enabled: true,
        },
      ],
      relate: [
        {
          id: 'relate-transformer',
          name: 'Transformer lookup',
          kind: 'attributeMatch',
          source: 'mel',
          when: { equipmentType: 'LVS' },
          match: { equipmentType: 'XFM', matchKey: '@matchKey' },
          enabled: true,
        },
        {
          id: 'relate-root',
          name: 'GIS root',
          kind: 'constant',
          pattern: '(?:^|-)GIS(?:-|$)',
          parent: '602 Medium Voltage',
          enabled: true,
        },
      ],
    },
    modes: [
      {
        id: 'electrical-flow',
        name: 'Electrical Flow',
        executor: 'raw',
        rootPolicy: {
          requireRoot: '602 Medium Voltage',
          fallbackParent: '602 Medium Voltage',
        },
        levels: [{ kind: 'flow' }],
      },
      {
        id: 'ssm',
        name: 'SSM Hierarchy',
        executor: 'projected',
        levels: [
          { kind: 'grouping', attribute: 'area', fallback: 'Unassigned Area' },
          { kind: 'grouping', attribute: 'equipmentType', fallback: 'Unassigned Type' },
          { kind: 'flow' },
        ],
      },
    ],
    mappings: {
      easyPower: {
        headerRow: 0,
        fields: { startingSource: 0, loadDescription: 1 },
      },
      mel: {
        headerRow: 1,
        fields: { equipmentTag: 0, building: 1 },
      },
    },
    hierarchy: {
      unassignedBuilding: 'Unassigned Building',
      disciplineFallbacks: { instrument: 'I&C', default: 'Electrical' },
      systemFallbacks: { Electrical: '602 Medium Voltage', default: 'Unassigned System' },
      parentSourcePriority: ['cable', 'mel', 'easyPower', 'pmd'],
      roleParents: { LVS: 'XFM', XFM: 'GIS', GIS: 'SYSTEM' },
      resolutionStrategy: 'source-priority',
      downstreamGapPolicy: 'bridge-review',
      caseVariantPolicy: 'merge',
      duplicateRegisterPolicy: 'prefer-parent',
      cableConflictPolicy: 'first-review',
      duplicateParentReviewPolicy: 'first-review',
      workflow: {
        gisBusCompaction: true,
        cableParentChains: true,
        melUpnParents: true,
        pmdInstrumentAttachment: true,
        enforceSystemRoot: true,
      },
    },
    details: {
      layout: ['equipmentTag', 'equipmentType', 'upn'],
    },
  }
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).reverse()) output[key] = reverseObjectKeys(value[key])
  return output
}

function diagnosticCodes(result) {
  return result.errors.map(diagnostic => diagnostic.code)
}

test('compiles a deeply cloned, explicitly based profile with deterministic metadata', () => {
  const input = validProfile()
  const result = compileRuleProfile(input)

  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.match(result.fingerprint, /^rpc2-[a-f0-9]{16}$/)
  assert.equal(result.compiledProfile.compilation.compilerVersion, RULE_PROFILE_COMPILER_VERSION)
  assert.equal(result.compiledProfile.compilation.fingerprint, result.fingerprint)
  assert.deepEqual(result.basePreset, {
    id: 'eagle',
    version: '1.0.0',
    fingerprint: 'rpc1-eagle',
    strategy: 'materialized',
  })
  assert.deepEqual(result.compiledProfile.basePreset, result.basePreset)
  assert.notStrictEqual(result.compiledProfile, input)
  assert.notStrictEqual(result.compiledProfile.rules, input.rules)
  assert.notStrictEqual(result.compiledProfile.mappings.easyPower.fields, input.mappings.easyPower.fields)
  assert.deepEqual(result.impact.changed, ['mappings', 'identity', 'relationships', 'hierarchy', 'modes', 'details'])

  input.rules.normalize[0].suffixes[0] = 'CHANGED'
  input.details.layout.push('changed')
  assert.deepEqual(result.compiledProfile.rules.normalize[0].suffixes, ['A', 'B'])
  assert.deepEqual(result.compiledProfile.details.layout, ['equipmentTag', 'equipmentType', 'upn'])
})

test('fingerprints are independent of object key insertion order', () => {
  const normal = compileRuleProfile(validProfile())
  const reversed = compileRuleProfile(reverseObjectKeys(validProfile()))
  assert.equal(normal.ok, true)
  assert.equal(reversed.ok, true)
  assert.equal(reversed.fingerprint, normal.fingerprint)
  assert.deepEqual(reversed.sectionFingerprints, normal.sectionFingerprints)
})

test('base preset metadata may be supplied explicitly as a compiler option', () => {
  const profile = validProfile()
  delete profile.basePreset
  const result = compileRuleProfile(profile, {
    basePreset: { id: 'eagle', version: '1.0.0' },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.basePreset, {
    id: 'eagle',
    version: '1.0.0',
    fingerprint: null,
    strategy: 'materialized',
  })
})

test('impact categories isolate the configuration section that changed', () => {
  const baselineResult = compileRuleProfile(validProfile())
  assert.equal(baselineResult.ok, true)
  const baseline = baselineResult.compiledProfile
  const scenarios = {
    mappings(profile) {
      profile.mappings.easyPower.fields.loadDescription = 3
    },
    identity(profile) {
      profile.rules.normalize[0].suffixes.push('OUTPUT')
    },
    relationships(profile) {
      profile.rules.relate[1].parent = '900 Medium Voltage'
    },
    hierarchy(profile) {
      profile.hierarchy.parentSourcePriority = ['mel', 'cable', 'easyPower', 'pmd']
    },
    modes(profile) {
      profile.modes[1].levels[0].fallback = 'Unknown Area'
    },
    details(profile) {
      profile.details.layout.push('provenance')
    },
  }

  for (const [expected, mutate] of Object.entries(scenarios)) {
    const next = validProfile()
    mutate(next)
    const result = compileRuleProfile(next, { previousProfile: baseline })
    assert.equal(result.ok, true, expected)
    assert.equal(result.impact.compared, true, expected)
    assert.deepEqual(result.impact.changed, [expected], expected)
    for (const category of Object.keys(scenarios)) {
      assert.equal(result.impact[category], category === expected, `${expected}: ${category}`)
    }
  }
})

test('a base preset version change conservatively invalidates every impact category', () => {
  const previous = compileRuleProfile(validProfile()).compiledProfile
  const next = validProfile()
  next.basePreset.version = '2.0.0'
  const result = compileRuleProfile(next, { previousProfile: previous })
  assert.equal(result.ok, true)
  assert.deepEqual(result.impact.changed, ['mappings', 'identity', 'relationships', 'hierarchy', 'modes', 'details'])
})

test('compareRuleProfileImpact accepts compiled results or profile objects', () => {
  const first = compileRuleProfile(validProfile())
  const nextProfile = validProfile()
  nextProfile.details.layout.push('description')
  const second = compileRuleProfile(nextProfile)
  assert.deepEqual(compareRuleProfileImpact(first, second), {
    compared: true,
    changed: ['details'],
    mappings: false,
    identity: false,
    relationships: false,
    hierarchy: false,
    modes: false,
    details: true,
  })
})

test('rejects malformed regular expressions everywhere they can execute', async t => {
  const cases = [
    ['anatomy', profile => { profile.anatomies[0].pattern = '[' }, 'anatomies[0].pattern'],
    ['classify', profile => { profile.rules.classify[0].pattern = '(abc' }, 'rules.classify[0].pattern'],
    ['prefix split', profile => {
      profile.rules.relate[0] = {
        id: 'relate-prefix',
        name: 'Prefix',
        kind: 'prefixSplit',
        delimiter: '_',
        pattern: '(mah',
        enabled: true,
      }
    }, 'rules.relate[0].pattern'],
    ['constant', profile => { profile.rules.relate[1].pattern = '*gis' }, 'rules.relate[1].pattern'],
  ]

  for (const [name, mutate, path] of cases) {
    await t.test(name, () => {
      const profile = validProfile()
      mutate(profile)
      const result = compileRuleProfile(profile)
      assert.equal(result.ok, false)
      assert.equal(result.compiledProfile, null)
      assert.equal(result.fingerprint, null)
      assert.equal(result.errors.some(error => error.code === 'regex.invalid' && error.path === path), true)
    })
  }
})

test('rejects duplicate executable ids and unknown operators', async t => {
  await t.test('duplicate ids across rule families', () => {
    const profile = validProfile()
    profile.rules.classify[0].id = profile.rules.normalize[0].id
    const result = compileRuleProfile(profile)
    assert.equal(result.ok, false)
    assert.equal(diagnosticCodes(result).includes('id.duplicate'), true)
    const diagnostic = result.errors.find(error => error.code === 'id.duplicate')
    assert.match(diagnostic.message, /rules\.normalize\[0\]\.id/)
    assert.notEqual(diagnostic.suggestion, '')
  })

  const cases = [
    ['normalize', profile => { profile.rules.normalize[0].kind = 'replaceAnything' }],
    ['classify', profile => { profile.rules.classify[0].kind = 'javascript' }],
    ['relate', profile => { profile.rules.relate[0].kind = 'guessParent' }],
  ]
  for (const [name, mutate] of cases) {
    await t.test(`unknown ${name} operator`, () => {
      const profile = validProfile()
      mutate(profile)
      const result = compileRuleProfile(profile)
      assert.equal(result.ok, false)
      assert.equal(diagnosticCodes(result).includes('rule.operator-unknown'), true)
    })
  }
})

test('mode attributes must be built in or explicitly defined by the profile', () => {
  const unsupported = validProfile()
  unsupported.modes[1].levels[0].attribute = 'processArea'
  const rejected = compileRuleProfile(unsupported)
  assert.equal(rejected.ok, false)
  assert.equal(diagnosticCodes(rejected).includes('mode.attribute-unsupported'), true)

  const declared = validProfile()
  declared.attributes.push({ id: 'processArea', label: 'Process Area' })
  declared.modes[1].levels[0].attribute = 'processArea'
  const accepted = compileRuleProfile(declared)
  assert.equal(accepted.ok, true)

  const classified = validProfile()
  classified.rules.classify.push({
    id: 'classify-process-area',
    name: 'Process area',
    kind: 'pattern',
    target: 'processArea',
    pattern: '^B14-',
    value: 'Area 14',
    enabled: true,
  })
  classified.modes[1].levels[0].attribute = 'processArea'
  assert.equal(compileRuleProfile(classified).ok, true)
})

test('rejects empty or invalid critical configuration instead of filling defaults', async t => {
  const cases = [
    ['profile id', profile => { profile.id = '' }, 'profile.id-required'],
    ['schema version', profile => { delete profile.schemaVersion }, 'profile.schema-version-invalid'],
    ['base preset', profile => { delete profile.basePreset }, 'base-preset.required'],
    ['mappings', profile => { profile.mappings = {} }, 'mappings.required'],
    ['mapping fields', profile => { profile.mappings.mel.fields = {} }, 'mapping.fields-required'],
    ['rules', profile => { profile.rules = { normalize: [], classify: [], relate: [] } }, 'rules.empty'],
    ['rule family', profile => { delete profile.rules.relate }, 'rules.family-required'],
    ['modes', profile => { profile.modes = [] }, 'modes.required'],
    ['details', profile => { profile.details.layout = [] }, 'details.layout-required'],
  ]

  for (const [name, mutate, code] of cases) {
    await t.test(name, () => {
      const profile = validProfile()
      mutate(profile)
      const result = compileRuleProfile(profile)
      assert.equal(result.ok, false)
      assert.equal(result.compiledProfile, null)
      assert.equal(result.fingerprint, null)
      assert.equal(diagnosticCodes(result).includes(code), true)
      assert.equal(result.errors.every(error => error.path && error.message && error.suggestion), true)
    })
  }
})

test('rejects undefined relationship attributes and lookup sources', () => {
  const profile = validProfile()
  profile.rules.relate[0].source = 'unmappedSource'
  profile.rules.relate[0].match.matchKey = '@notDefined'
  const result = compileRuleProfile(profile)
  assert.equal(result.ok, false)
  assert.equal(diagnosticCodes(result).includes('relate.source-unknown'), true)
  assert.equal(diagnosticCodes(result).includes('relate.attribute-unknown'), true)
})

test('accepts well-formed relationship exclusions and rejects malformed ones', () => {
  const absent = validProfile()
  assert.equal(compileRuleProfile(absent).ok, true, 'an absent exclusion list must stay valid')

  const empty = validProfile()
  empty.rules.relate[0].exclusions = []
  assert.equal(compileRuleProfile(empty).ok, true, 'an empty exclusion list is what an untouched proposal carries')

  const named = validProfile()
  named.rules.relate[0].exclusions = ['B14-LVS-0001', 'B14-LVS-0002']
  assert.equal(compileRuleProfile(named).ok, true)

  // Exclusions are checked before applyRelate dispatches on kind, so the
  // compiler validates them for every relate kind, not just attributeMatch.
  const constant = validProfile()
  constant.rules.relate[1].exclusions = 'B14-GIS-01'
  const notAList = compileRuleProfile(constant)
  assert.equal(notAList.ok, false)
  assert.equal(diagnosticCodes(notAList).includes('relate.exclusions-invalid'), true)
  assert.equal(notAList.errors.every(error => error.path && error.message && error.suggestion), true)

  for (const bad of [[''], ['   '], [null], [7]]) {
    const profile = validProfile()
    profile.rules.relate[0].exclusions = bad
    const result = compileRuleProfile(profile)
    assert.equal(result.ok, false, `exclusions ${JSON.stringify(bad)} must be rejected`)
    assert.equal(diagnosticCodes(result).includes('relate.exclusion-invalid'), true)
    assert.equal(result.errors.some(error => error.path === 'rules.relate[0].exclusions[0]'), true)
  }
})

test('rejects malformed, self-parenting, and duplicate manual relationship overrides', () => {
  const malformed = validProfile()
  malformed.overrides = { relationships: [
    { equipment: 'LOAD-1', parent: 'LOAD-1' },
    { equipment: 'LOAD-1', parent: 'PANEL-2' },
    { equipment: '', parent: 'PANEL-3' },
  ] }
  const result = compileRuleProfile(malformed)

  assert.equal(result.ok, false)
  assert.equal(diagnosticCodes(result).includes('override.self-parent'), true)
  assert.equal(diagnosticCodes(result).includes('override.duplicate-equipment'), true)
  assert.equal(diagnosticCodes(result).includes('override.equipment-required'), true)
})

test('rejects non-JSON and circular profile data without throwing', () => {
  const withFunction = validProfile()
  withFunction.details.render = () => 'unsafe'
  const functionResult = compileRuleProfile(withFunction)
  assert.equal(functionResult.ok, false)
  assert.equal(diagnosticCodes(functionResult).includes('profile.non-json-value'), true)

  const circular = validProfile()
  circular.loop = circular
  const circularResult = compileRuleProfile(circular)
  assert.equal(circularResult.ok, false)
  assert.equal(diagnosticCodes(circularResult).includes('profile.circular-reference'), true)
})
