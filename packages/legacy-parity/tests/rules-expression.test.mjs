import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateExpression, expressionPreview } from '../src/rules/expression.js'

const CONTEXT = { segments: { building: 'B14', unit: '1234' }, lookup: { UPN: 'UPN-9', System: 'LV Dist' } }

test('a literal-only expression returns its text', () => {
  assert.equal(evaluateExpression([{ kind: 'literal', text: ' - CIM' }], CONTEXT), ' - CIM')
})

test('segment parts resolve from the anatomy segments', () => {
  const expr = [{ kind: 'segment', name: 'building' }, { kind: 'literal', text: '-' }, { kind: 'segment', name: 'unit' }]
  assert.equal(evaluateExpression(expr, CONTEXT), 'B14-1234')
})

test('lookup parts resolve from looked-up columns', () => {
  const expr = [{ kind: 'lookup', column: 'UPN' }, { kind: 'literal', text: ' ' }, { kind: 'lookup', column: 'System' }]
  assert.equal(evaluateExpression(expr, CONTEXT), 'UPN-9 LV Dist')
})

test('an unresolved part yields the empty string, and the whole expression resolves to empty', () => {
  const expr = [{ kind: 'segment', name: 'missing' }, { kind: 'literal', text: '-X' }]
  assert.equal(evaluateExpression(expr, CONTEXT), '')
})

test('expressionPreview renders the read-only brace form', () => {
  const expr = [{ kind: 'lookup', column: 'UPN' }, { kind: 'literal', text: ' ' }, { kind: 'segment', name: 'unit' }]
  assert.equal(expressionPreview(expr), '{UPN} {@unit}')
})
