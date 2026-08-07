import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const coreDir = resolve(rootDir, 'src/core')

/** Site vocabulary that must never appear in core/. */
const SITE_TERMS = ['XFM', 'GIS', 'CIM', 'MAH', 'SCR', 'SCC', 'LVS', 'CPS', 'NPS',
  'Equipment_List', 'INSTALL PMD', 'Cable Schedule', '602 Medium Voltage']

/* No exemptions. tags.js carried the last one: cleanRegisterTag hardcoded a
   site term, and it now reads the literal it must preserve from the active
   profile's own Relate rules instead. The exemption-pinning test that guarded
   the list while it was shrinking is gone with it -- an empty list needs no
   guard, because any regression fails the check below directly. */
test('core/ contains no site vocabulary', () => {
  for (const file of readdirSync(coreDir).filter(f => f.endsWith('.js'))) {
    const src = readFileSync(resolve(coreDir, file), 'utf8')
    for (const term of SITE_TERMS) {
      assert.ok(!src.includes(term), `src/core/${file} contains site vocabulary "${term}"`)
    }
  }
})
