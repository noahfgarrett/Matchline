import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_MODULES } from './manifest.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(resolve(rootDir, p), 'utf8')

const BANNER = `/* GENERATED FILE — do not edit directly.
   Source lives in src/. Run \`npm run build\` after changing it. */\n`

/**
 * The bundle is one shared scope, so cross-module imports are redundant.
 * Strip them, and drop the `export` keyword from declarations.
 * The accepted source subset will be enforced by tests/source-style.test.mjs.
 *
 * Processed line by line, tracking whether we are inside an unclosed
 * template literal by counting unescaped backticks per line and toggling
 * state; stripping is skipped while inside one. This is not a full JS
 * lexer — it only needs to avoid eating import/export-shaped lines that
 * appear inside template-literal content (e.g. changelog prose).
 *
 * The backtick count includes backticks inside comments, regex literals,
 * and quoted strings — a stray unpaired backtick anywhere in the file
 * desyncs the tracker for everything after it. Rather than try to get
 * smarter about that (still not a lexer), we require backticks to balance
 * across the whole file and throw if they don't, so a desync fails loudly
 * instead of silently corrupting stripped output.
 */
export function stripEsm(source, path = '<unknown>') {
  let inTemplate = false
  const result = source.split('\n').map(line => {
    const wasInTemplate = inTemplate
    // count unescaped backticks to track template-literal state across lines
    const ticks = (line.match(/(?<!\\)`/g) || []).length
    if (ticks % 2 === 1) inTemplate = !inTemplate
    if (wasInTemplate) return line
    return line
      .replace(/^import\s[^\n]*?from\s*['"][^'"]+['"];?[ \t]*$/, '')
      .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/, '')
  }).join('\n')

  if (inTemplate) {
    throw new Error(`unbalanced backticks in ${path} — template-literal tracking is unreliable, so stripping could silently corrupt template content`)
  }

  return result
}

/**
 * Refuse to emit a bundle containing ESM syntax.
 *
 * The concatenated app is a classic script, so a single surviving
 * `import`/`export` is a SyntaxError that takes the entire file down. The build
 * used to write that out happily, and the failure surfaced as most of the test
 * suite going red at once with nothing pointing at the cause. Failing here names
 * the module and the line instead.
 */
export function assertStripped(stripped, path) {
  const lines = stripped.split('\n')
  const at = lines.findIndex(line => /^\s*(?:import|export)\s/.test(line))
  if (at !== -1) {
    throw new Error(`${path}:${at + 1} — ESM syntax survived stripping: ${lines[at].trim()}\n`
      + 'The bundle is a classic script. Use `export function` / `export const` declarations, '
      + 'not export lists, default exports, or namespace imports.')
  }
  return stripped
}

/**
 * Top-level declarations in one stripped module.
 *
 * Line-anchored on purpose: the bundle is a concatenation of modules whose
 * declarations sit at column zero, and this needs to be a reliable scanner, not
 * a parser. Anything indented is inside a function and cannot collide.
 */
export function topLevelNames(stripped) {
  const names = new Set()
  for (const line of stripped.split('\n')) {
    const match = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
      || line.match(/^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/)
    if (match) names.add(match[1])
  }
  return names
}

/**
 * Refuse to emit a bundle where two modules declare the same top-level name.
 *
 * Every module concatenates into ONE scope, so a duplicate `function` silently
 * resolves to whichever came last -- and callers in the earlier module start
 * calling a stranger. Duplicate `const` is a build-time SyntaxError and fails
 * loudly; duplicate `function` fails silently, at runtime, in the bundle only.
 * ESM tests import each module into its own scope and never see it.
 */
/**
 * Every ic('name') must name an icon that exists.
 *
 * ic() falls back to an empty string, so a typo renders a blank 24x24 SVG:
 * correct layout, correct spacing, no glyph. That is close enough to right to
 * survive review -- 'lock' on the locked-profile badge did exactly that.
 */
export function assertKnownIcons(modules, iconSource) {
  const known = new Set()
  const literal = iconSource.match(/export const ICONS = (\{[\s\S]*?\});/)
  if (literal) for (const name of Object.keys(JSON.parse(literal[1]))) known.add(name)
  for (const match of iconSource.matchAll(/ICONS\['([^']+)'\]/g)) known.add(match[1])

  const missing = []
  for (const { path, stripped } of modules) {
    stripped.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(/\bic\(\s*'([^']+)'/g)) {
        if (!known.has(match[1])) missing.push(`${path}:${index + 1} — unknown icon '${match[1]}'`)
      }
    })
  }
  if (missing.length) {
    throw new Error('Unknown icon names (ic() would render an empty SVG):\n  ' + missing.join('\n  '))
  }
  return modules
}

export function assertNoDuplicateTopLevelNames(modules) {
  const owner = new Map()
  const collisions = []
  for (const { path, stripped } of modules) {
    for (const name of topLevelNames(stripped)) {
      if (owner.has(name)) collisions.push(`${name} — declared in ${owner.get(name)} and ${path}`)
      else owner.set(name, path)
    }
  }
  if (collisions.length) {
    throw new Error('duplicate top-level names would collide in the shared bundle scope:\n  '
      + collisions.join('\n  ')
      + '\nThe bundle is one scope. Rename one of each pair.')
  }
  return owner
}

export function buildHtml() {
  const duplicates = APP_MODULES.filter((path, i) => APP_MODULES.indexOf(path) !== i)
  if (duplicates.length > 0) {
    throw new Error(`APP_MODULES contains duplicate entries: ${[...new Set(duplicates)].join(', ')}`)
  }

  const css = read('src/styles/app.css')
  const sheetjs = read('src/vendor/sheetjs.js')
  const fflate = read('src/vendor/fflate.js')
  /* PDF.js is embedded as SOURCE TEXT, not as executed code. The library is an
     ES module and its worker must be constructed from a Blob URL, so both are
     handed to URL.createObjectURL at runtime -- verified working under file://,
     including a real Worker rather than PDF.js's main-thread fallback.

     JSON.stringify handles every JS escape; the only thing it does not escape is
     `</script`, which would close the block early. Neither file contains one
     today, and the replace below means neither ever can. */
  const asScriptString = source => JSON.stringify(source).replace(/<\/script/gi, '<\\/script')
  const pdfjs = `const LEGEND_PDFJS_LIB=${asScriptString(read('src/vendor/legend/pdf.min.mjs'))};\n`
    + `const LEGEND_PDFJS_WORKER=${asScriptString(read('src/vendor/legend/pdf.worker.min.mjs'))};`
  // CHANGELOG is freeform prose (release notes), not code. Inject it verbatim as
  // a data literal, never through stripEsm — a stray unpaired backtick anywhere
  // else in the file would desync stripEsm's template-literal tracker and could
  // silently corrupt or delete changelog content.
  const changelog = read('src/changelog.json').trim()
  const changelogConst = `const CHANGELOG = ${changelog};`
  const modules = APP_MODULES.map(path => ({ path, stripped: assertStripped(stripEsm(read(path), path), path) }))
  assertNoDuplicateTopLevelNames(modules)
  assertKnownIcons(modules, read('src/ui/icons.js'))
  const app = modules.map(({ path, stripped }) => `/* ==== ${path} ==== */\n${stripped}`).join('\n')
  const appWithBanner = BANNER + app

  const html = read('src/index.html')
    .replace('<!--@inject:styles-->', () => css)
    .replace('<!--@inject:vendor:sheetjs-->', () => sheetjs)
    .replace('<!--@inject:vendor:fflate-->', () => fflate)
    .replace('<!--@inject:vendor:pdfjs-->', () => pdfjs)
    .replace('<!--@inject:changelog-->', () => changelogConst)
    .replace('<!--@inject:app-->', () => appWithBanner)

  /* Four blocks since v3.3.0: sheetjs, fflate, the PDF.js source strings, and
     the app. PDF.js earns its own block so the test harness can skip ~1.8 MB it
     never executes -- a dozen VM contexts each parsing it was enough to
     segfault V8 under the full suite's fan-out. */
  const scriptBlockCount = (html.match(/<script>/g) || []).length
  if (scriptBlockCount !== 4) {
    throw new Error(`expected 4 <script> blocks in built output, found ${scriptBlockCount}`)
  }
  if (html.includes('@inject:')) {
    throw new Error('an @inject marker survived the build — a template placeholder was not replaced')
  }
  const injectedLength = css.length + sheetjs.length + fflate.length + pdfjs.length
    + changelogConst.length + appWithBanner.length
  if (html.length < injectedLength) {
    throw new Error(`built output (${html.length} chars) is shorter than the injected sources combined (${injectedLength} chars) — a marker likely swallowed content`)
  }

  return html
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  writeFileSync(resolve(rootDir, 'SSManagement.html'), buildHtml())
  console.log('built SSManagement.html')
}
