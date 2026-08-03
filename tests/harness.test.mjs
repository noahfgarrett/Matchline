import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

test('harness loads the app and exposes its scope', async () => {
  const app = await loadApp()
  assert.equal(app.eval('typeof buildHierarchy'), 'function')
  assert.equal(app.eval("cleanTag('MCC-01-A')"), 'MCC-01')
  assert.equal(app.eval('typeof XLSX.utils.book_new'), 'function')
  assert.equal(app.eval('typeof fflate.zipSync'), 'function')
})
