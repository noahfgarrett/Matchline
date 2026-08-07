import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { APP_MODULES } from '../build/manifest.mjs'
import { assertNoDuplicateTopLevelNames, assertStripped, stripEsm, topLevelNames } from '../build/build.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('app modules use only the ESM subset the bundler understands', () => {
  for (const path of APP_MODULES) {
    const src = readFileSync(resolve(rootDir, path), 'utf8')
    assert.doesNotMatch(src, /^export\s+default\b/m, `${path}: export default is not supported`)
    assert.doesNotMatch(src, /^export\s*\{/m, `${path}: export lists are not supported`)
    assert.doesNotMatch(src, /^import\s+\*/m, `${path}: namespace imports are not supported`)
    assert.doesNotMatch(src, /^import\s[^\n]*,\s*$/m, `${path}: multi-line imports are not supported`)
  }
})

/* LOAD-BEARING. The four allowlist assertions above are the weaker guard — they miss
   indented exports, multi-line imports opening with a bare brace, and imports carrying a
   trailing comment. This residual check is what actually catches those, by confirming
   nothing ESM-shaped survives into the bundle. Do not drop it in favour of the allowlist. */
test('stripping ESM leaves no import or export keywords in the bundle', () => {
  for (const path of APP_MODULES) {
    const stripped = stripEsm(readFileSync(resolve(rootDir, path), 'utf8'), path)
    assert.doesNotMatch(stripped, /^\s*import\s/m, `${path}: import survived stripping`)
    assert.doesNotMatch(stripped, /^\s*export\s/m, `${path}: export survived stripping`)
  }
})

test('app modules have balanced backticks', () => {
  for (const path of APP_MODULES) {
    const src = readFileSync(resolve(rootDir, path), 'utf8')
    assert.doesNotThrow(() => stripEsm(src, path), `${path}: stripEsm threw on balanced source`)
  }
})

test('stripEsm throws on unbalanced backticks and names the offending path', () => {
  const unbalanced = 'const template = `unterminated\nconst x = 1\n'
  assert.throws(
    () => stripEsm(unbalanced, 'src/fake-module.js'),
    /src\/fake-module\.js/,
    'stripEsm should throw an error naming the path when backticks do not balance'
  )
})

/* LOAD-BEARING. Token-absence alone (the two tests above) is satisfied by an over-eager
   strip that mangles what remains — e.g. `constAPP_VERSION` or a dropped `const`. Task 7
   APP_VERSION lives in src/update/private-update.js, and the real updater validates
   a downloaded release with a plain substring match on
   `const APP_VERSION = '<version>'`. A whitespace-mangling regression here would pass every
   token-absence check while breaking update downloads silently, on users' machines, with
   nothing failing locally. This test pins the exact output, not just token absence. */
test('stripEsm produces exact expected output for each supported declaration form', () => {
  const cases = [
    ["export const APP_VERSION = '2.1.1'", "const APP_VERSION = '2.1.1'"],
    ['export function foo() {}', 'function foo() {}'],
    ['export async function foo() {}', 'async function foo() {}'],
    ['export let counter = 0', 'let counter = 0'],
    ['export class Widget {}', 'class Widget {}'],
    ["import { a } from './x.js'", ''],
    ['// see import/export docs', '// see import/export docs'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(stripEsm(input, 'x.js'), expected, `stripEsm mishandled: ${input}`)
  }
})

/* LOAD-BEARING. The tests above catch ESM survivors in the modules that exist
   today; this one makes the BUILD itself refuse to write a broken artifact. An
   `export { … }` list survives stripping, and the bundle is a classic script, so
   the result is a SyntaxError that takes down the whole file -- observed as most
   of the suite failing at once with nothing naming the cause. */
test('the build refuses to emit a bundle with surviving ESM syntax', () => {
  for (const survivor of ['export { thing }', 'export default thing', '  export {a, b}', 'import * as ns from "x"']) {
    assert.throws(
      () => assertStripped(`const a = 1\n${survivor}\n`, 'src/fake-module.js'),
      /src\/fake-module\.js:2/,
      `a surviving "${survivor}" must fail the build and name its line`,
    )
  }
  assert.equal(assertStripped('const a = 1\nfunction b() {}\n', 'src/ok.js'), 'const a = 1\nfunction b() {}\n',
    'clean stripped source must pass through untouched')
})

/* LOAD-BEARING. Every module concatenates into ONE scope. Two modules declaring
   the same top-level `function` is not an error anywhere: the bundle silently
   resolves to whichever came last, and callers in the earlier module start
   calling a stranger. Duplicate `const` at least fails the build loudly;
   duplicate `function` fails at runtime, in the bundle only -- ESM tests import
   each module into its own scope and can never see it. This is the only check
   that does. */
test('no two modules declare the same top-level name', () => {
  const modules = APP_MODULES.map(path => ({ path, stripped: stripEsm(readFileSync(resolve(rootDir, path), 'utf8'), path) }))
  assert.doesNotThrow(() => assertNoDuplicateTopLevelNames(modules))
})

test('the duplicate-name guard names both modules and refuses the build', () => {
  assert.throws(
    () => assertNoDuplicateTopLevelNames([
      { path: 'src/a.js', stripped: 'function shared() {}\n' },
      { path: 'src/b.js', stripped: 'function shared() {}\n' },
    ]),
    /shared — declared in src\/a\.js and src\/b\.js/,
  )
  // Indented declarations are inside a function and cannot collide.
  assert.doesNotThrow(() => assertNoDuplicateTopLevelNames([
    { path: 'src/a.js', stripped: 'function outer() {\n  const local = 1\n}\n' },
    { path: 'src/b.js', stripped: 'function other() {\n  const local = 2\n}\n' },
  ]))
  assert.deepEqual([...topLevelNames('function a() {}\nconst b = 1\nlet c = 2\nclass D {}\n  const inner = 3\n')],
    ['a', 'b', 'c', 'D'])
})

test('boot is concatenated last in APP_MODULES', () => {
  assert.equal(APP_MODULES.at(-1), 'src/boot.js', 'boot must be concatenated last')
})
