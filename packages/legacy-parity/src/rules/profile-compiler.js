export const RULE_PROFILE_COMPILER_VERSION = 2

export const RULE_PROFILE_IMPACT_CATEGORIES = Object.freeze([
  'mappings',
  'identity',
  'relationships',
  'hierarchy',
  'modes',
  'details',
])

export const RULE_PROFILE_BUILT_IN_ATTRIBUTES = Object.freeze([
  'building',
  'discipline',
  'system',
  'equipmentType',
  'matchKey',
  'placeholder',
])

const PROFILE_COMPILER_NORMALIZE_KINDS = new Set(['stripSuffix'])
const PROFILE_COMPILER_CLASSIFY_KINDS = new Set(['pattern', 'segment', 'slice'])
const PROFILE_COMPILER_RELATE_KINDS = new Set([
  'fragmentLookup',
  'prefixSplit',
  'attributeMatch',
  'constant',
])
const PROFILE_COMPILER_MODE_EXECUTORS = new Set(['raw', 'projected'])
const PROFILE_COMPILER_LEVEL_KINDS = new Set(['grouping', 'flow'])
const PROFILE_COMPILER_LOOKUP_MODES = new Set(['exact', 'containing'])
const PROFILE_COMPILER_MULTIPLE_POLICIES = new Set(['first', 'review'])
const PROFILE_COMPILER_TAG_SOURCES = new Set(['raw', 'canonical'])
const PROFILE_COMPILER_NORMALIZE_STAGES = new Set(['identity', 'matching'])
const PROFILE_COMPILER_DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function profileCompilerIsRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function profileCompilerText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function profileCompilerDiagnostic(severity, code, path, message, suggestion) {
  return {
    severity,
    code,
    path,
    message,
    suggestion: suggestion || '',
  }
}

function profileCompilerError(errors, code, path, message, suggestion) {
  errors.push(profileCompilerDiagnostic('error', code, path, message, suggestion))
}

function profileCompilerWarning(warnings, code, path, message, suggestion) {
  warnings.push(profileCompilerDiagnostic('warning', code, path, message, suggestion))
}

function profileCompilerClone(value, path, stack, errors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    profileCompilerError(
      errors,
      'profile.non-finite-number',
      path,
      'Profile values must be finite numbers.',
      'Replace NaN or Infinity with a finite number.',
    )
    return null
  }
  if (typeof value !== 'object') {
    profileCompilerError(
      errors,
      'profile.non-json-value',
      path,
      `Profiles cannot contain values of type "${typeof value}".`,
      'Use only JSON-compatible strings, numbers, booleans, null, arrays, and plain objects.',
    )
    return null
  }
  if (stack.has(value)) {
    profileCompilerError(
      errors,
      'profile.circular-reference',
      path,
      'Profiles cannot contain circular references.',
      'Remove the circular reference before compiling the profile.',
    )
    return null
  }
  if (!Array.isArray(value) && !profileCompilerIsRecord(value)) {
    profileCompilerError(
      errors,
      'profile.non-plain-object',
      path,
      'Profiles can contain only arrays and plain objects.',
      'Convert class instances, dates, maps, and sets to JSON-compatible values.',
    )
    return null
  }

  stack.add(value)
  if (Array.isArray(value)) {
    const clone = value.map((item, index) => profileCompilerClone(item, `${path}[${index}]`, stack, errors))
    stack.delete(value)
    return clone
  }

  const clone = {}
  for (const key of Object.keys(value)) {
    const childPath = path === '$' ? key : `${path}.${key}`
    if (PROFILE_COMPILER_DANGEROUS_KEYS.has(key)) {
      profileCompilerError(
        errors,
        'profile.unsafe-key',
        childPath,
        `The key "${key}" is not permitted in a rule profile.`,
        'Rename or remove this key.',
      )
      continue
    }
    clone[key] = profileCompilerClone(value[key], childPath, stack, errors)
  }
  stack.delete(value)
  return clone
}

function profileCompilerStableValue(value) {
  if (Array.isArray(value)) return value.map(profileCompilerStableValue)
  if (!profileCompilerIsRecord(value)) return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = profileCompilerStableValue(value[key])
  return out
}

function profileCompilerStableStringify(value) {
  return JSON.stringify(profileCompilerStableValue(value))
}

function profileCompilerHash(value) {
  const text = profileCompilerStableStringify(value)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
    second ^= second >>> 13
  }
  const left = (first >>> 0).toString(16).padStart(8, '0')
  const right = (second >>> 0).toString(16).padStart(8, '0')
  return `rpc${RULE_PROFILE_COMPILER_VERSION}-${left}${right}`
}

function profileCompilerSemanticProfile(profile) {
  return {
    schemaVersion: profile.schemaVersion,
    basePreset: profile.basePreset,
    attributes: profile.attributes || [],
    anatomies: profile.anatomies,
    rules: profile.rules,
    overrides: profile.overrides || { relationships: [] },
    hierarchy: profile.hierarchy || {},
    modes: profile.modes,
    mappings: profile.mappings,
    details: profile.details,
  }
}

function profileCompilerSection(profile, category) {
  if (category === 'mappings') return profile.mappings
  if (category === 'identity') {
    return {
      attributes: profile.attributes || [],
      anatomies: profile.anatomies,
      normalize: profile.rules && profile.rules.normalize,
      classify: profile.rules && profile.rules.classify,
    }
  }
  if (category === 'relationships') return { rules: profile.rules && profile.rules.relate, overrides: profile.overrides || { relationships: [] } }
  if (category === 'hierarchy') return profile.hierarchy || {}
  if (category === 'modes') return profile.modes
  return profile.details
}

function profileCompilerUnwrapProfile(value) {
  if (!profileCompilerIsRecord(value)) return null
  if (profileCompilerIsRecord(value.compiledProfile)) return value.compiledProfile
  return value
}

export function compareRuleProfileImpact(previousProfile, nextProfile) {
  const previous = profileCompilerUnwrapProfile(previousProfile)
  const next = profileCompilerUnwrapProfile(nextProfile)
  const compared = !!previous
  const impact = { compared, changed: [] }
  const presetChanged = compared && profileCompilerStableStringify(previous.basePreset) !== profileCompilerStableStringify(next && next.basePreset)

  for (const category of RULE_PROFILE_IMPACT_CATEGORIES) {
    const changed = !compared || !next || presetChanged ||
      profileCompilerStableStringify(profileCompilerSection(previous, category)) !==
      profileCompilerStableStringify(profileCompilerSection(next, category))
    impact[category] = changed
    if (changed) impact.changed.push(category)
  }
  return impact
}

function profileCompilerRegisterId(id, path, kind, registry, errors) {
  const normalized = profileCompilerText(id)
  if (!normalized) {
    profileCompilerError(
      errors,
      'id.required',
      `${path}.id`,
      `${kind} needs a stable id.`,
      'Add a non-empty id that is unique across anatomies, rules, and modes.',
    )
    return ''
  }
  if (registry.has(normalized)) {
    const first = registry.get(normalized)
    profileCompilerError(
      errors,
      'id.duplicate',
      `${path}.id`,
      `The id "${normalized}" is already used by ${first.kind} at ${first.path}.`,
      `Rename this ${kind.toLowerCase()} so every executable definition has a unique id.`,
    )
  } else {
    registry.set(normalized, { path: `${path}.id`, kind })
  }
  return normalized
}

function profileCompilerValidateRegex(value, path, errors) {
  const pattern = profileCompilerText(value)
  if (!pattern) {
    profileCompilerError(
      errors,
      'regex.required',
      path,
      'A non-empty regular expression is required.',
      'Enter the tag pattern this definition should match.',
    )
    return false
  }
  try {
    new RegExp(pattern, 'i')
    return true
  } catch (error) {
    profileCompilerError(
      errors,
      'regex.invalid',
      path,
      `The regular expression is malformed: ${error.message}`,
      'Correct the expression before publishing the profile.',
    )
    return false
  }
}

function profileCompilerValidateName(value, path, kind, warnings) {
  if (profileCompilerText(value)) return
  profileCompilerWarning(
    warnings,
    'name.missing',
    `${path}.name`,
    `${kind} has no reader-facing name.`,
    'Add a short name so diagnostics and rule traces are understandable.',
  )
}

function profileCompilerValidateBasePreset(profile, optionPreset, errors) {
  const supplied = profile.basePreset === undefined ? optionPreset : profile.basePreset
  if (!profileCompilerIsRecord(supplied)) {
    profileCompilerError(
      errors,
      'base-preset.required',
      'basePreset',
      'A compiled profile must explicitly identify its base preset.',
      'Set basePreset to an object with non-empty id and version fields.',
    )
    return null
  }
  const id = profileCompilerText(supplied.id)
  const version = profileCompilerText(supplied.version)
  if (!id) {
    profileCompilerError(
      errors,
      'base-preset.id-required',
      'basePreset.id',
      'The base preset id is empty.',
      'Use the stable preset id, for example "eagle".',
    )
  }
  if (!version) {
    profileCompilerError(
      errors,
      'base-preset.version-required',
      'basePreset.version',
      'The base preset version is empty.',
      'Use the exact preset version this profile materialized.',
    )
  }
  const fingerprint = supplied.fingerprint == null ? null : profileCompilerText(supplied.fingerprint)
  if (supplied.fingerprint != null && !fingerprint) {
    profileCompilerError(
      errors,
      'base-preset.fingerprint-invalid',
      'basePreset.fingerprint',
      'The supplied base preset fingerprint is empty.',
      'Remove it or provide the exact fingerprint of the base preset.',
    )
  }
  return {
    id,
    version,
    fingerprint,
    strategy: 'materialized',
  }
}

function profileCompilerValidateMappings(profile, errors, warnings, options) {
  const mappings = profile.mappings
  const sourceIds = new Set(['canonical',...(options&&options.allowUnmapped?['easyPower','cable','mel','pmd']:[])])
  if (!profileCompilerIsRecord(mappings) || !Object.keys(mappings).length) {
    if(options&&options.allowUnmapped){
      profileCompilerWarning(warnings,'mappings.auto-detect','mappings','No confirmed source mappings are stored.','Columns will be auto-detected when workbooks are loaded.')
      return sourceIds
    }
    profileCompilerError(
      errors,
      'mappings.required',
      'mappings',
      'At least one source mapping is required.',
      'Map the identity and relationship columns for at least one imported source.',
    )
    return sourceIds
  }

  for (const [sourceId, mapping] of Object.entries(mappings)) {
    const path = `mappings.${sourceId}`
    if (!profileCompilerText(sourceId)) {
      profileCompilerError(errors, 'mapping.id-required', path, 'A source mapping has an empty id.', 'Name the source mapping.')
      continue
    }
    sourceIds.add(sourceId)
    if (!profileCompilerIsRecord(mapping)) {
      profileCompilerError(
        errors,
        'mapping.invalid',
        path,
        `Mapping "${sourceId}" must be an object.`,
        'Provide a fields object containing semantic field-to-column assignments.',
      )
      continue
    }
    if (mapping.headerRow != null && (!Number.isInteger(mapping.headerRow) || mapping.headerRow < 0)) {
      profileCompilerError(
        errors,
        'mapping.header-row-invalid',
        `${path}.headerRow`,
        'Header row must be a zero-based non-negative integer.',
        'Choose the row containing this source sheet\'s column headers.',
      )
    }
    if (!profileCompilerIsRecord(mapping.fields) || !Object.keys(mapping.fields).length) {
      profileCompilerError(
        errors,
        'mapping.fields-required',
        `${path}.fields`,
        `Mapping "${sourceId}" has no mapped fields.`,
        'Map at least one semantic field before publishing.',
      )
      continue
    }
    const assignedColumns = new Map()
    for (const [fieldId, column] of Object.entries(mapping.fields)) {
      const fieldPath = `${path}.fields.${fieldId}`
      if (!profileCompilerText(fieldId)) {
        profileCompilerError(errors, 'mapping.field-id-required', fieldPath, 'A mapped field has an empty id.', 'Name this semantic field.')
      }
      const numeric = Number.isInteger(column) && column >= 0
      const named = typeof column === 'string' && !!profileCompilerText(column)
      const indexedObject = profileCompilerIsRecord(column) && Number.isInteger(column.index) && column.index >= 0
      const namedObject = profileCompilerIsRecord(column) && !!profileCompilerText(column.header)
      if (!numeric && !named && !indexedObject && !namedObject) {
        profileCompilerError(
          errors,
          'mapping.column-invalid',
          fieldPath,
          `Mapped field "${fieldId}" has an invalid column reference.`,
          'Use a zero-based column index, a header name, or an object with index or header.',
        )
        continue
      }
      const key = numeric ? `index:${column}`
        : named ? `header:${profileCompilerText(column).toLowerCase()}`
          : indexedObject ? `index:${column.index}`
            : `header:${profileCompilerText(column.header).toLowerCase()}`
      if (assignedColumns.has(key)) {
        profileCompilerWarning(
          warnings,
          'mapping.column-reused',
          fieldPath,
          `This column is also mapped to "${assignedColumns.get(key)}".`,
          'Confirm that sharing one source column between these semantic fields is intentional.',
        )
      } else {
        assignedColumns.set(key, fieldId)
      }
    }
  }
  return sourceIds
}

function profileCompilerDeclaredAttributes(profile, options, errors) {
  const declared = new Set(RULE_PROFILE_BUILT_IN_ATTRIBUTES)
  for (const value of options.supportedModeAttributes || []) {
    const id = profileCompilerText(value)
    if (id) declared.add(id)
  }
  if (profile.attributes == null) return declared

  const seen = new Set()
  if (Array.isArray(profile.attributes)) {
    profile.attributes.forEach((definition, index) => {
      const path = `attributes[${index}]`
      const id = typeof definition === 'string' ? profileCompilerText(definition)
        : profileCompilerIsRecord(definition) ? profileCompilerText(definition.id)
          : ''
      if (!id) {
        profileCompilerError(
          errors,
          'attribute.id-required',
          path,
          'Every custom attribute needs a non-empty id.',
          'Add an id such as "area", "package", or "contractor".',
        )
        return
      }
      if (seen.has(id)) {
        profileCompilerError(
          errors,
          'attribute.duplicate',
          path,
          `The attribute "${id}" is declared more than once.`,
          'Keep one definition for each custom attribute.',
        )
      }
      seen.add(id)
      declared.add(id)
    })
    return declared
  }

  if (profileCompilerIsRecord(profile.attributes)) {
    for (const id of Object.keys(profile.attributes)) {
      if (!profileCompilerText(id)) {
        profileCompilerError(errors, 'attribute.id-required', 'attributes', 'A custom attribute has an empty id.', 'Name the custom attribute.')
      } else {
        declared.add(id)
      }
    }
    return declared
  }

  profileCompilerError(
    errors,
    'attributes.invalid',
    'attributes',
    'Custom attributes must be an array or object.',
    'Declare attributes as ids or objects containing an id.',
  )
  return declared
}

function profileCompilerValidateAnatomies(profile, registry, declaredAttributes, errors, warnings) {
  if (!Array.isArray(profile.anatomies)) {
    profileCompilerError(
      errors,
      'anatomies.required',
      'anatomies',
      'The anatomies section must be an array.',
      'Use an empty array when tags intentionally have no segmented anatomy.',
    )
    return
  }

  profile.anatomies.forEach((anatomy, index) => {
    const path = `anatomies[${index}]`
    if (!profileCompilerIsRecord(anatomy)) {
      profileCompilerError(errors, 'anatomy.invalid', path, 'An anatomy must be an object.', 'Replace this entry with a valid anatomy definition.')
      return
    }
    profileCompilerRegisterId(anatomy.id, path, 'Anatomy', registry, errors)
    profileCompilerValidateName(anatomy.name, path, 'Anatomy', warnings)
    profileCompilerValidateRegex(anatomy.pattern, `${path}.pattern`, errors)
    if (anatomy.delimiter != null && !profileCompilerText(anatomy.delimiter)) {
      profileCompilerError(
        errors,
        'anatomy.delimiter-invalid',
        `${path}.delimiter`,
        'An anatomy delimiter cannot be empty.',
        'Provide the character that separates tag segments.',
      )
    }
    if (!Array.isArray(anatomy.segments) || !anatomy.segments.length) {
      profileCompilerError(
        errors,
        'anatomy.segments-required',
        `${path}.segments`,
        'An anatomy needs at least one segment.',
        'Identify and name the meaningful portions of this tag pattern.',
      )
      return
    }
    const names = new Set()
    const indexes = new Set()
    let identityCount = 0
    anatomy.segments.forEach((segment, segmentIndex) => {
      const segmentPath = `${path}.segments[${segmentIndex}]`
      if (!profileCompilerIsRecord(segment)) {
        profileCompilerError(errors, 'anatomy.segment-invalid', segmentPath, 'An anatomy segment must be an object.', 'Define its name and index.')
        return
      }
      const name = profileCompilerText(segment.name)
      if (!name) {
        profileCompilerError(errors, 'anatomy.segment-name-required', `${segmentPath}.name`, 'An anatomy segment needs a name.', 'Name this segment.')
      } else {
        if (names.has(name)) {
          profileCompilerError(
            errors,
            'anatomy.segment-name-duplicate',
            `${segmentPath}.name`,
            `Segment name "${name}" is repeated in this anatomy.`,
            'Use each segment name once per anatomy.',
          )
        }
        names.add(name)
        declaredAttributes.add(name)
      }
      if (!Number.isInteger(segment.index) || segment.index < 0) {
        profileCompilerError(
          errors,
          'anatomy.segment-index-invalid',
          `${segmentPath}.index`,
          'Segment index must be a zero-based non-negative integer.',
          'Select the segment position from the sample tag.',
        )
      } else if (indexes.has(segment.index)) {
        profileCompilerError(
          errors,
          'anatomy.segment-index-duplicate',
          `${segmentPath}.index`,
          `Segment index ${segment.index} is assigned more than once.`,
          'Assign each delimiter position to at most one segment.',
        )
      } else {
        indexes.add(segment.index)
      }
      if (segment.identity !== false) identityCount++
    })
    if (!identityCount) {
      profileCompilerError(
        errors,
        'anatomy.identity-empty',
        `${path}.segments`,
        'This anatomy marks every segment as non-identity.',
        'Keep at least one segment as part of the equipment identity.',
      )
    }
  })
}

function profileCompilerValidateRuleCommon(rule, path, family, registry, errors, warnings) {
  if (!profileCompilerIsRecord(rule)) {
    profileCompilerError(errors, 'rule.invalid', path, `${family} rule must be an object.`, 'Replace this entry with a valid rule definition.')
    return false
  }
  profileCompilerRegisterId(rule.id, path, `${family} rule`, registry, errors)
  profileCompilerValidateName(rule.name, path, `${family} rule`, warnings)
  return true
}

function profileCompilerValidateStringArray(value, path, label, errors) {
  if (!Array.isArray(value) || !value.length) {
    profileCompilerError(errors, 'rule.list-required', path, `${label} must contain at least one value.`, `Add at least one ${label.toLowerCase()} value.`)
    return
  }
  const seen = new Set()
  value.forEach((item, index) => {
    const text = profileCompilerText(item)
    if (!text) {
      profileCompilerError(errors, 'rule.list-value-invalid', `${path}[${index}]`, `${label} cannot contain an empty value.`, 'Remove or replace this value.')
    } else if (seen.has(text.toLowerCase())) {
      profileCompilerError(errors, 'rule.list-value-duplicate', `${path}[${index}]`, `"${text}" is repeated in ${label.toLowerCase()}.`, 'Keep each value once.')
    }
    seen.add(text.toLowerCase())
  })
}

function profileCompilerValidateNormalizeRules(rules, registry, errors, warnings) {
  rules.forEach((rule, index) => {
    const path = `rules.normalize[${index}]`
    if (!profileCompilerValidateRuleCommon(rule, path, 'Normalize', registry, errors, warnings)) return
    if (!PROFILE_COMPILER_NORMALIZE_KINDS.has(rule.kind)) {
      profileCompilerError(
        errors,
        'rule.operator-unknown',
        `${path}.kind`,
        `Normalize operator "${profileCompilerText(rule.kind) || '(empty)'}" is not supported.`,
        `Use one of: ${Array.from(PROFILE_COMPILER_NORMALIZE_KINDS).join(', ')}.`,
      )
      return
    }
    profileCompilerValidateStringArray(rule.separators, `${path}.separators`, 'Separators', errors)
    profileCompilerValidateStringArray(rule.suffixes, `${path}.suffixes`, 'Suffixes', errors)
    if (rule.stage != null && !PROFILE_COMPILER_NORMALIZE_STAGES.has(rule.stage)) {
      profileCompilerError(
        errors,
        'normalize.stage-unknown',
        `${path}.stage`,
        `Normalize stage "${rule.stage}" is not supported.`,
        `Use one of: ${Array.from(PROFILE_COMPILER_NORMALIZE_STAGES).join(', ')}.`,
      )
    }
  })
}

function profileCompilerValidateClassifyRules(rules, registry, declaredAttributes, anatomySegments, errors, warnings) {
  rules.forEach((rule, index) => {
    const path = `rules.classify[${index}]`
    if (!profileCompilerValidateRuleCommon(rule, path, 'Classify', registry, errors, warnings)) return
    const target = profileCompilerText(rule.target)
    if (!target) {
      profileCompilerError(errors, 'classify.target-required', `${path}.target`, 'A Classify rule needs a target attribute.', 'Choose or define the attribute this rule assigns.')
    } else {
      declaredAttributes.add(target)
    }
    if (!PROFILE_COMPILER_CLASSIFY_KINDS.has(rule.kind)) {
      profileCompilerError(
        errors,
        'rule.operator-unknown',
        `${path}.kind`,
        `Classify operator "${profileCompilerText(rule.kind) || '(empty)'}" is not supported.`,
        `Use one of: ${Array.from(PROFILE_COMPILER_CLASSIFY_KINDS).join(', ')}.`,
      )
      return
    }
    if (rule.source != null && !PROFILE_COMPILER_TAG_SOURCES.has(rule.source)) {
      profileCompilerError(
        errors,
        'classify.source-unknown',
        `${path}.source`,
        `Tag source "${rule.source}" is not supported.`,
        `Use one of: ${Array.from(PROFILE_COMPILER_TAG_SOURCES).join(', ')}.`,
      )
    }
    if (rule.kind === 'pattern') {
      profileCompilerValidateRegex(rule.pattern, `${path}.pattern`, errors)
      if (!profileCompilerText(rule.value)) {
        profileCompilerError(errors, 'classify.value-required', `${path}.value`, 'A pattern rule needs a value to assign.', 'Enter the classification value.')
      }
    } else if (rule.kind === 'segment') {
      const segment = profileCompilerText(rule.segment)
      if (!segment) {
        profileCompilerError(errors, 'classify.segment-required', `${path}.segment`, 'A segment rule must name an anatomy segment.', 'Choose one of the defined anatomy segments.')
      } else if (!anatomySegments.has(segment)) {
        profileCompilerError(
          errors,
          'classify.segment-unknown',
          `${path}.segment`,
          `Anatomy segment "${segment}" is not defined.`,
          'Define this segment in an anatomy or correct the segment name.',
        )
      }
    } else {
      if (rule.start != null && !Number.isInteger(rule.start)) {
        profileCompilerError(errors, 'classify.slice-start-invalid', `${path}.start`, 'Slice start must be an integer.', 'Use a positive or negative integer index.')
      }
      if (rule.end != null && !Number.isInteger(rule.end)) {
        profileCompilerError(errors, 'classify.slice-end-invalid', `${path}.end`, 'Slice end must be an integer.', 'Use a positive or negative integer index.')
      }
      if (rule.minLength != null && (!Number.isInteger(rule.minLength) || rule.minLength < 0)) {
        profileCompilerError(errors, 'classify.min-length-invalid', `${path}.minLength`, 'Minimum length must be a non-negative integer.', 'Use zero or a positive integer.')
      }
      if (Number.isInteger(rule.start) && Number.isInteger(rule.end) && rule.start === rule.end) {
        profileCompilerError(errors, 'classify.slice-empty', `${path}.end`, 'Slice start and end select no characters.', 'Choose an end index different from the start index.')
      }
    }
  })
}

function profileCompilerValidateAttributeObject(value, path, declaredAttributes, errors) {
  if (value == null) return
  if (!profileCompilerIsRecord(value)) {
    profileCompilerError(errors, 'relate.guard-invalid', path, 'Relationship guards must be objects.', 'Map attribute ids to expected values.')
    return
  }
  for (const key of Object.keys(value)) {
    if (!declaredAttributes.has(key)) {
      profileCompilerError(
        errors,
        'relate.attribute-unknown',
        `${path}.${key}`,
        `Relationship rule references undefined attribute "${key}".`,
        'Define the attribute or correct its name.',
      )
    }
  }
}

function profileCompilerValidateRelateSource(rule, path, sourceIds, errors, field) {
  const sourceField = field || 'source'
  const source = profileCompilerText(rule[sourceField])
  if (!source) {
    profileCompilerError(errors, 'relate.source-required', `${path}.${sourceField}`, 'This relationship operator needs a lookup source.', 'Choose a configured source mapping.')
  } else if (!sourceIds.has(source)) {
    profileCompilerError(
      errors,
      'relate.source-unknown',
      `${path}.${sourceField}`,
      `Lookup source "${source}" has no source mapping.`,
      'Add the source mapping or choose an existing mapped source.',
    )
  }
}

function profileCompilerValidateParentParts(parts, path, errors) {
  if (!Array.isArray(parts) || !parts.length) {
    profileCompilerError(errors, 'relate.parent-parts-required', path, 'A composed parent needs at least one part.', 'Add literal, column, or extracted parts.')
    return
  }
  parts.forEach((part, index) => {
    const partPath = `${path}[${index}]`
    if (!profileCompilerIsRecord(part) || !new Set(['literal', 'column', 'part']).has(part.kind)) {
      profileCompilerError(errors, 'relate.parent-part-invalid', partPath, 'Parent parts must be literal, column, or part definitions.', 'Choose a supported parent part kind.')
      return
    }
    if (part.kind === 'literal') {
      if (part.text == null || typeof part.text !== 'string') {
        profileCompilerError(errors, 'relate.parent-literal-invalid', `${partPath}.text`, 'A literal parent part needs text.', 'Enter the literal text, including an empty string only when intentional.')
      }
    } else if (!profileCompilerText(part.name)) {
      profileCompilerError(errors, 'relate.parent-part-name-required', `${partPath}.name`, 'A parent part needs a column or extracted-part name.', 'Choose the source value to insert.')
    }
  })
}

function profileCompilerValidateRelateRules(rules, registry, declaredAttributes, sourceIds, errors, warnings) {
  rules.forEach((rule, index) => {
    const path = `rules.relate[${index}]`
    if (!profileCompilerValidateRuleCommon(rule, path, 'Relate', registry, errors, warnings)) return
    if (!PROFILE_COMPILER_RELATE_KINDS.has(rule.kind)) {
      profileCompilerError(
        errors,
        'rule.operator-unknown',
        `${path}.kind`,
        `Relate operator "${profileCompilerText(rule.kind) || '(empty)'}" is not supported.`,
        `Use one of: ${Array.from(PROFILE_COMPILER_RELATE_KINDS).join(', ')}.`,
      )
      return
    }
    if (rule.tagSource != null && !PROFILE_COMPILER_TAG_SOURCES.has(rule.tagSource)) {
      profileCompilerError(
        errors,
        'relate.tag-source-unknown',
        `${path}.tagSource`,
        `Tag source "${rule.tagSource}" is not supported.`,
        `Use one of: ${Array.from(PROFILE_COMPILER_TAG_SOURCES).join(', ')}.`,
      )
    }
    // Kind-agnostic, like the guard it mirrors in applyRelate: exclusions are
    // checked before that function dispatches on kind, so they are validated
    // here rather than inside any one kind's branch. An empty list is legal —
    // it is what a proposal with nothing deselected carries.
    if (rule.exclusions != null) {
      if (!Array.isArray(rule.exclusions)) {
        profileCompilerError(errors, 'relate.exclusions-invalid', `${path}.exclusions`, 'Exclusions must be a list of tags.', 'List the tags this rule must never claim, or remove the field.')
      } else {
        rule.exclusions.forEach((item, itemIndex) => {
          if (!profileCompilerText(item)) {
            profileCompilerError(errors, 'relate.exclusion-invalid', `${path}.exclusions[${itemIndex}]`, 'An excluded tag is empty.', 'Name the tag this rule must never claim, or remove the entry.')
          }
        })
      }
    }

    if (rule.kind === 'fragmentLookup') {
      profileCompilerValidateRelateSource(rule, path, sourceIds, errors)
      profileCompilerValidateStringArray(rule.markers, `${path}.markers`, 'Markers', errors)
      if (rule.mode != null && !PROFILE_COMPILER_LOOKUP_MODES.has(rule.mode)) {
        profileCompilerError(
          errors,
          'relate.lookup-mode-unknown',
          `${path}.mode`,
          `Lookup mode "${rule.mode}" is not supported.`,
          `Use one of: ${Array.from(PROFILE_COMPILER_LOOKUP_MODES).join(', ')}.`,
        )
      }
      if (rule.onMultiple != null && !PROFILE_COMPILER_MULTIPLE_POLICIES.has(rule.onMultiple)) {
        profileCompilerError(
          errors,
          'relate.multiple-policy-unknown',
          `${path}.onMultiple`,
          `Multiple-match policy "${rule.onMultiple}" is not supported.`,
          'Use "first" for legacy row-order behavior or "review" to flag ambiguity.',
        )
      }
      profileCompilerValidateParentParts(rule.parent, `${path}.parent`, errors)
      return
    }
    if (rule.kind === 'prefixSplit') {
      if (!profileCompilerText(rule.delimiter)) {
        profileCompilerError(errors, 'relate.delimiter-required', `${path}.delimiter`, 'A prefix split rule needs a delimiter.', 'Enter the delimiter that ends the parent prefix.')
      }
      profileCompilerValidateRegex(rule.pattern, `${path}.pattern`, errors)
      return
    }
    if (rule.kind === 'constant') {
      profileCompilerValidateRegex(rule.pattern, `${path}.pattern`, errors)
      if (!profileCompilerText(rule.parent)) {
        profileCompilerError(errors, 'relate.parent-required', `${path}.parent`, 'A constant relationship needs a parent tag.', 'Enter the exact parent tag.')
      }
      return
    }

    profileCompilerValidateRelateSource(rule, path, sourceIds, errors)
    profileCompilerValidateAttributeObject(rule.when, `${path}.when`, declaredAttributes, errors)
    profileCompilerValidateAttributeObject(rule.whenParent, `${path}.whenParent`, declaredAttributes, errors)
    if (rule.excludeSelf != null && typeof rule.excludeSelf !== 'boolean') {
      profileCompilerError(errors, 'relate.exclude-self-invalid', `${path}.excludeSelf`, 'Exclude self must be true or false.', 'Choose whether the equipment itself may be a lookup candidate.')
    }
    if (!profileCompilerIsRecord(rule.match) || !Object.keys(rule.match).length) {
      profileCompilerError(errors, 'relate.match-required', `${path}.match`, 'An attribute match rule needs matching criteria.', 'Map lookup attributes to literal or @attribute values.')
    } else {
      for (const [key, value] of Object.entries(rule.match)) {
        if (!profileCompilerText(key)) {
          profileCompilerError(errors, 'relate.match-key-required', `${path}.match`, 'A match criterion has an empty key.', 'Name the lookup attribute.')
        }
        const reference = profileCompilerText(value)
        if (reference.startsWith('@') && !declaredAttributes.has(reference.slice(1))) {
          profileCompilerError(
            errors,
            'relate.attribute-unknown',
            `${path}.match.${key}`,
            `Relationship rule references undefined attribute "${reference.slice(1)}".`,
            'Define the attribute or correct the @reference.',
          )
        }
      }
    }
    if (rule.whenDiffers != null && !declaredAttributes.has(profileCompilerText(rule.whenDiffers))) {
      profileCompilerError(
        errors,
        'relate.attribute-unknown',
        `${path}.whenDiffers`,
        `Relationship rule references undefined attribute "${profileCompilerText(rule.whenDiffers)}".`,
        'Define the attribute or correct its name.',
      )
    }
    if (rule.preferExactTag != null) {
      if (!profileCompilerIsRecord(rule.preferExactTag)) {
        profileCompilerError(errors, 'relate.prefer-exact-invalid', `${path}.preferExactTag`, 'preferExactTag must be an object.', 'Provide an attribute and optional mapped source.')
      } else {
        if (!declaredAttributes.has(profileCompilerText(rule.preferExactTag.attribute))) {
          profileCompilerError(
            errors,
            'relate.attribute-unknown',
            `${path}.preferExactTag.attribute`,
            `Relationship rule references undefined attribute "${profileCompilerText(rule.preferExactTag.attribute)}".`,
            'Define the attribute or correct its name.',
          )
        }
        if (rule.preferExactTag.source != null) {
          profileCompilerValidateRelateSource(rule.preferExactTag, `${path}.preferExactTag`, sourceIds, errors)
        }
      }
    }
  })
}

function profileCompilerValidateRules(profile, registry, declaredAttributes, anatomySegments, sourceIds, errors, warnings) {
  if (!profileCompilerIsRecord(profile.rules)) {
    profileCompilerError(
      errors,
      'rules.required',
      'rules',
      'Rules must be an object containing normalize, classify, and relate arrays.',
      'Materialize all three rule families before compiling the profile.',
    )
    return
  }
  const families = ['normalize', 'classify', 'relate']
  for (const family of Object.keys(profile.rules)) {
    if (!families.includes(family)) {
      profileCompilerError(
        errors,
        'rules.family-unknown',
        `rules.${family}`,
        `Rule family "${family}" is not supported.`,
        `Use one of: ${families.join(', ')}.`,
      )
    }
  }
  for (const family of families) {
    if (!Array.isArray(profile.rules[family])) {
      profileCompilerError(
        errors,
        'rules.family-required',
        `rules.${family}`,
        `Rules must include a ${family} array.`,
        `Use an empty array when this profile intentionally has no ${family} rules.`,
      )
    }
  }
  if (families.some(family => !Array.isArray(profile.rules[family]))) return
  const allRules = families.flatMap(family => profile.rules[family])
  if (!allRules.length) {
    profileCompilerError(
      errors,
      'rules.empty',
      'rules',
      'The profile contains no executable rules.',
      'Materialize the base preset rules or add project-specific rules before publishing.',
    )
  } else if (!allRules.some(rule => profileCompilerIsRecord(rule) && rule.enabled !== false)) {
    profileCompilerError(
      errors,
      'rules.no-enabled',
      'rules',
      'Every rule in the profile is disabled.',
      'Enable the rules that should govern this project.',
    )
  }
  profileCompilerValidateNormalizeRules(profile.rules.normalize, registry, errors, warnings)
  profileCompilerValidateClassifyRules(profile.rules.classify, registry, declaredAttributes, anatomySegments, errors, warnings)
  profileCompilerValidateRelateRules(profile.rules.relate, registry, declaredAttributes, sourceIds, errors, warnings)
}

function profileCompilerValidateModes(profile, registry, declaredAttributes, errors, warnings) {
  if (!Array.isArray(profile.modes) || !profile.modes.length) {
    profileCompilerError(
      errors,
      'modes.required',
      'modes',
      'At least one hierarchy mode is required.',
      'Define the ordered grouping and flow levels users can view and export.',
    )
    return
  }
  let rawCount = 0
  profile.modes.forEach((mode, index) => {
    const path = `modes[${index}]`
    if (!profileCompilerIsRecord(mode)) {
      profileCompilerError(errors, 'mode.invalid', path, 'A hierarchy mode must be an object.', 'Replace this entry with a valid mode.')
      return
    }
    profileCompilerRegisterId(mode.id, path, 'Hierarchy mode', registry, errors)
    if (!profileCompilerText(mode.name)) {
      profileCompilerError(errors, 'mode.name-required', `${path}.name`, 'A hierarchy mode needs a name.', 'Add the label users will see in the mode switcher.')
    }
    if (!PROFILE_COMPILER_MODE_EXECUTORS.has(mode.executor)) {
      profileCompilerError(
        errors,
        'mode.executor-unknown',
        `${path}.executor`,
        `Mode executor "${profileCompilerText(mode.executor) || '(empty)'}" is not supported.`,
        `Use one of: ${Array.from(PROFILE_COMPILER_MODE_EXECUTORS).join(', ')}.`,
      )
    }
    if (mode.executor === 'raw') rawCount++
    if (!Array.isArray(mode.levels) || !mode.levels.length) {
      profileCompilerError(errors, 'mode.levels-required', `${path}.levels`, 'A hierarchy mode needs at least one level.', 'Add a grouping or flow level.')
      return
    }
    let flowCount = 0
    mode.levels.forEach((level, levelIndex) => {
      const levelPath = `${path}.levels[${levelIndex}]`
      if (!profileCompilerIsRecord(level) || !PROFILE_COMPILER_LEVEL_KINDS.has(level.kind)) {
        profileCompilerError(
          errors,
          'mode.level-kind-unknown',
          `${levelPath}.kind`,
          `Mode level kind "${profileCompilerText(level && level.kind) || '(empty)'}" is not supported.`,
          `Use one of: ${Array.from(PROFILE_COMPILER_LEVEL_KINDS).join(', ')}.`,
        )
        return
      }
      if (level.kind === 'flow') {
        flowCount++
        if (levelIndex !== mode.levels.length - 1) {
          profileCompilerError(errors, 'mode.flow-not-last', levelPath, 'A flow level must be the final level.', 'Move the flow level after every grouping level.')
        }
        return
      }
      const attribute = profileCompilerText(level.attribute)
      if (!attribute) {
        profileCompilerError(errors, 'mode.attribute-required', `${levelPath}.attribute`, 'A grouping level needs an attribute.', 'Choose a defined profile attribute.')
      } else if (!declaredAttributes.has(attribute)) {
        profileCompilerError(
          errors,
          'mode.attribute-unsupported',
          `${levelPath}.attribute`,
          `Grouping attribute "${attribute}" is not defined by this profile.`,
          'Declare the attribute, produce it with a Classify rule, or correct the name.',
        )
      }
      if (!profileCompilerText(level.fallback)) {
        profileCompilerError(
          errors,
          'mode.fallback-required',
          `${levelPath}.fallback`,
          `Grouping level "${attribute || levelIndex + 1}" has no explicit fallback label.`,
          'Set the label used when this attribute is missing.',
        )
      }
    })
    if (flowCount > 1) {
      profileCompilerError(errors, 'mode.flow-duplicate', `${path}.levels`, `Mode "${mode.id}" has more than one flow level.`, 'Keep at most one flow level.')
    }
    if (mode.executor === 'raw' && flowCount !== 1) {
      profileCompilerError(errors, 'mode.raw-flow-required', `${path}.levels`, 'A raw hierarchy mode must contain exactly one flow level.', 'Add one final flow level.')
    }
    if (mode.rootPolicy != null && !profileCompilerIsRecord(mode.rootPolicy)) {
      profileCompilerError(errors, 'mode.root-policy-invalid', `${path}.rootPolicy`, 'Root policy must be an object.', 'Provide explicit root-policy fields or remove it.')
    } else if (profileCompilerIsRecord(mode.rootPolicy)) {
      for (const key of ['requireRoot', 'fallbackParent']) {
        if (mode.rootPolicy[key] != null && !profileCompilerText(mode.rootPolicy[key])) {
          profileCompilerError(errors, 'mode.root-policy-value-invalid', `${path}.rootPolicy.${key}`, `${key} cannot be empty when supplied.`, 'Enter the exact root tag or remove this property.')
        }
      }
    }
  })
  if (rawCount > 1) {
    profileCompilerError(
      errors,
      'mode.raw-duplicate',
      'modes',
      'More than one raw hierarchy mode is declared.',
      'Keep one raw mode; use projected modes for alternate organizations.',
    )
  }
}

function profileCompilerValidateDetails(profile, errors) {
  if (!profileCompilerIsRecord(profile.details)) {
    profileCompilerError(
      errors,
      'details.required',
      'details',
      'Details configuration is required.',
      'Provide a non-empty layout for the equipment details panel.',
    )
    return
  }
  if (!Array.isArray(profile.details.layout) || !profile.details.layout.length) {
    profileCompilerError(
      errors,
      'details.layout-required',
      'details.layout',
      'The details panel layout cannot be empty.',
      'Choose at least one field to display.',
    )
    return
  }
  const seen = new Set()
  profile.details.layout.forEach((entry, index) => {
    const id = typeof entry === 'string' ? profileCompilerText(entry)
      : profileCompilerIsRecord(entry) ? profileCompilerText(entry.id)
        : ''
    const path = `details.layout[${index}]`
    if (!id) {
      profileCompilerError(errors, 'details.field-id-required', path, 'Every details layout entry needs a field id.', 'Choose a mapped, computed, or core field.')
    } else if (seen.has(id)) {
      profileCompilerError(errors, 'details.field-duplicate', path, `Details field "${id}" appears more than once.`, 'Keep each details field once.')
    }
    seen.add(id)
  })
}

function profileCompilerValidateOverrides(profile, declaredAttributes, errors) {
  if(profile.overrides==null)return;
  if(!profileCompilerIsRecord(profile.overrides)){
    profileCompilerError(errors,'overrides.invalid','overrides','Manual overrides must be an object.','Remove the invalid value or provide a relationships array.');
    return;
  }
  const relationships=profile.overrides.relationships==null?[]:profile.overrides.relationships;
  if(!Array.isArray(relationships)){
    profileCompilerError(errors,'overrides.relationships-invalid','overrides.relationships','Relationship overrides must be an array.','Provide equipment and parent pairs.');
    return;
  }
  const seen=new Set();
  relationships.forEach((override,index)=>{
    const path=`overrides.relationships[${index}]`;
    if(!profileCompilerIsRecord(override)){
      profileCompilerError(errors,'override.invalid',path,'A relationship override must be an object.','Provide equipment and parent fields.');
      return;
    }
    const equipment=profileCompilerText(override.equipment),parent=profileCompilerText(override.parent),key=equipment.toLowerCase();
    if(!equipment)profileCompilerError(errors,'override.equipment-required',`${path}.equipment`,'A relationship override needs an equipment tag.','Choose the branch being moved.');
    if(!parent)profileCompilerError(errors,'override.parent-required',`${path}.parent`,'A relationship override needs a parent tag.','Choose the destination parent.');
    if(equipment&&parent&&equipment.toLowerCase()===parent.toLowerCase())profileCompilerError(errors,'override.self-parent',path,'Equipment cannot be its own parent.','Choose a different destination parent.');
    if(key&&seen.has(key))profileCompilerError(errors,'override.duplicate-equipment',`${path}.equipment`,`Equipment "${equipment}" has more than one manual override.`,'Keep one destination parent for this equipment.');
    seen.add(key);
  });
  const attributes=profile.overrides.attributes;
  if(attributes==null)return;
  if(!Array.isArray(attributes)){
    profileCompilerError(errors,'overrides.attributes-invalid','overrides.attributes','Grouping overrides must be an array.','Provide equipment tags and attribute values.');
    return;
  }
  const seenAttributes=new Set();
  attributes.forEach((override,index)=>{
    const path=`overrides.attributes[${index}]`;
    if(!profileCompilerIsRecord(override)){
      profileCompilerError(errors,'override.invalid',path,'A grouping override must be an object.','Provide equipment and values fields.');
      return;
    }
    const equipment=profileCompilerText(override.equipment),key=equipment.toLowerCase();
    if(!equipment)profileCompilerError(errors,'override.equipment-required',`${path}.equipment`,'A grouping override needs an equipment tag.','Choose the equipment being regrouped.');
    if(key&&seenAttributes.has(key))profileCompilerError(errors,'override.duplicate-equipment',`${path}.equipment`,`Equipment "${equipment}" has more than one grouping override.`,'Keep one grouping override for this equipment.');
    seenAttributes.add(key);
    if(!profileCompilerIsRecord(override.values)||!Object.keys(override.values).length){
      profileCompilerError(errors,'override.values-required',`${path}.values`,'A grouping override needs at least one attribute value.','Choose a Building, Discipline, System, or other grouping value.');
      return;
    }
    for(const [attribute,value] of Object.entries(override.values)){
      if(!declaredAttributes.has(attribute))profileCompilerError(errors,'override.attribute-unknown',`${path}.values.${attribute}`,`Grouping override references undefined attribute "${attribute}".`,'Choose a defined hierarchy attribute.');
      if(!profileCompilerText(value))profileCompilerError(errors,'override.value-required',`${path}.values.${attribute}`,'Grouping override values cannot be blank.','Enter the destination grouping value.');
    }
  });
}

function profileCompilerEmptyImpact(previousProfile) {
  const impact = { compared: !!profileCompilerUnwrapProfile(previousProfile), changed: [] }
  for (const category of RULE_PROFILE_IMPACT_CATEGORIES) impact[category] = false
  return impact
}

/**
 * Compile a fully materialized rule profile.
 *
 * options.basePreset may supply base metadata when the input profile has none.
 * options.previousProfile enables section-level change impact reporting.
 * options.supportedModeAttributes extends the built-in/custom attribute set.
 */
export function compileRuleProfile(input, options = {}) {
  const errors = []
  const warnings = []
  const clone = profileCompilerClone(input, '$', new Set(), errors)
  const previousProfile = options.previousProfile || options.previousCompiledProfile || null

  if (!profileCompilerIsRecord(clone)) {
    if (!errors.length) {
      profileCompilerError(
        errors,
        'profile.invalid',
        '$',
        'A rule profile must be a plain object.',
        'Provide the complete exported profile object.',
      )
    }
    const diagnostics = { errors, warnings }
    return {
      ok: false,
      compiledProfile: null,
      diagnostics,
      errors,
      warnings,
      basePreset: null,
      fingerprint: null,
      sectionFingerprints: null,
      impact: profileCompilerEmptyImpact(previousProfile),
    }
  }

  if (errors.length) {
    const diagnostics = { errors, warnings }
    return {
      ok: false,
      compiledProfile: null,
      diagnostics,
      errors,
      warnings,
      basePreset: null,
      fingerprint: null,
      sectionFingerprints: null,
      impact: profileCompilerEmptyImpact(previousProfile),
    }
  }

  if (!Number.isInteger(clone.schemaVersion) || clone.schemaVersion < 1) {
    profileCompilerError(
      errors,
      'profile.schema-version-invalid',
      'schemaVersion',
      'Profile schemaVersion must be a positive integer.',
      'Set it to the schema version used to author this complete profile.',
    )
  }
  if (!profileCompilerText(clone.id)) {
    profileCompilerError(errors, 'profile.id-required', 'id', 'The profile needs a stable id.', 'Add a unique profile id.')
  }
  if (!profileCompilerText(clone.name)) {
    profileCompilerError(errors, 'profile.name-required', 'name', 'The profile needs a reader-facing name.', 'Add the site or project profile name.')
  }

  let optionPreset = null
  if (clone.basePreset === undefined && options.basePreset !== undefined) {
    optionPreset = profileCompilerClone(options.basePreset, 'basePreset', new Set(), errors)
  }
  const basePreset = profileCompilerValidateBasePreset(clone, optionPreset, errors)
  if (basePreset) clone.basePreset = basePreset

  const registry = new Map()
  const declaredAttributes = profileCompilerDeclaredAttributes(clone, options, errors)
  const sourceIds = profileCompilerValidateMappings(clone, errors, warnings, options)
  profileCompilerValidateAnatomies(clone, registry, declaredAttributes, errors, warnings)
  const anatomySegments = new Set()
  for (const anatomy of Array.isArray(clone.anatomies) ? clone.anatomies : []) {
    for (const segment of Array.isArray(anatomy && anatomy.segments) ? anatomy.segments : []) {
      const name = profileCompilerText(segment && segment.name)
      if (name) anatomySegments.add(name)
    }
  }
  profileCompilerValidateRules(clone, registry, declaredAttributes, anatomySegments, sourceIds, errors, warnings)
  profileCompilerValidateModes(clone, registry, declaredAttributes, errors, warnings)
  profileCompilerValidateOverrides(clone, declaredAttributes, errors)
  profileCompilerValidateDetails(clone, errors)

  if (!Array.isArray(clone.anatomies) || !clone.anatomies.length) {
    const identityRules = profileCompilerIsRecord(clone.rules) && Array.isArray(clone.rules.normalize)
      ? clone.rules.normalize.filter(rule => rule && rule.enabled !== false && (!rule.stage || rule.stage === 'identity'))
      : []
    if (!identityRules.length) {
      profileCompilerWarning(
        warnings,
        'identity.passthrough',
        'anatomies',
        'No anatomy or identity-stage Normalize rule changes imported tag identity.',
        'Confirm that exact imported tag text is the intended identity key.',
      )
    }
  }

  if (errors.length) {
    const diagnostics = { errors, warnings }
    return {
      ok: false,
      compiledProfile: null,
      diagnostics,
      errors,
      warnings,
      basePreset,
      fingerprint: null,
      sectionFingerprints: null,
      impact: profileCompilerEmptyImpact(previousProfile),
    }
  }

  const semantic = profileCompilerSemanticProfile(clone)
  const sectionFingerprints = {}
  for (const category of RULE_PROFILE_IMPACT_CATEGORIES) {
    sectionFingerprints[category] = profileCompilerHash(profileCompilerSection(clone, category))
  }
  const fingerprint = profileCompilerHash(semantic)
  clone.compilation = {
    compilerVersion: RULE_PROFILE_COMPILER_VERSION,
    fingerprint,
    sectionFingerprints: { ...sectionFingerprints },
  }
  const impact = compareRuleProfileImpact(previousProfile, clone)
  const diagnostics = { errors, warnings }
  return {
    ok: true,
    compiledProfile: clone,
    diagnostics,
    errors,
    warnings,
    basePreset: { ...basePreset },
    fingerprint,
    sectionFingerprints,
    impact,
  }
}
