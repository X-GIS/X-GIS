// ═══ @xgis/shader-dsl loads in PLAIN NODE — the #1686 verification, as a runnable gate ═══
//
//     bun run --filter '@xgis/shader-dsl' build && node scripts/shader-dsl-node-smoke.mjs
//
// WHY A SCRIPT AND NOT A VITEST FILE. This asserts a property of the BUILD OUTPUT under
// NODE's own ESM resolver — no vite, no bun, no TypeScript. A vitest test would resolve the
// specifiers through vite's resolver, which follows `./x.js` back to `x.ts` and would pass
// on exactly the input that broke: extensionless specifiers. The gate has to be the real
// resolver, so it is a plain `node` process. It is also build-dependent, and the vitest legs
// run without a build; a test that skipped when dist/ was absent would be vacuously green.
//
// WHAT BROKE (#1686). `tsc` does not rewrite import specifiers. `src/` wrote `from
// './core/ir'`, tsc copied it verbatim into `dist/index.js`, and Node ESM resolves neither
// an extensionless path nor a directory:
//
//     node -e "import('…/shader-dsl/dist/index.js')"
//     → ERR_UNSUPPORTED_DIR_IMPORT  Directory import '…/dist/core/ir' is not supported
//
// Every relative specifier in the package now carries an explicit `.js`, and
// shader-dsl/tsconfig.json is on `moduleResolution: nodenext` so a missing one is TS2835 at
// build time. This script is the end-to-end witness that the two hold together.
//
// WHY IT LIVES AT REPO ROOT: nothing tracked under `shader-dsl/` may name a path outside the
// package (`shader-dsl/src/self-contained.test.ts` — the package is mirrored out by
// `git subtree split`). `scripts/gen-example-registry.ts` is the precedent.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = join(ROOT, 'shader-dsl')
const DIST = join(PKG_DIR, 'dist')
const BUILD_CMD = "bun run --filter '@xgis/shader-dsl' build"

/** Named exports proving a subpath loaded as ITSELF and not as some empty module that
 *  happened to resolve. Keyed by the `exports` key, and every key of `exports` must appear
 *  here or in NOT_BUILT — so a NEW subpath reds this gate instead of sliding in unchecked
 *  (§12: a path-keyed list needs a companion "every key is still accounted for"). */
const WITNESSES = {
  '.': ['emitModule', 'reflect'],
  './dev': ['diagnose', 'dslError'],
  './emit-prod': ['mangleModule', 'minify'],
  './core/ir': ['Builder', 'Let'],
}

/** Subpath → why Node cannot be asked to load it. `./examples` is excluded from the package
 *  tsconfig (examples never reach dist/), so there is no compiled twin to import. Stated
 *  here rather than skipped silently; deleting an entry is how a subpath joins the gate. */
const NOT_BUILT = {
  './examples': 'excluded from tsconfig.json — examples/ is never compiled into dist/',
}

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
  return ok
}

const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
const subpaths = Object.keys(manifest.exports)

// ── the entry map is the authority, and every entry is accounted for ──────────────────────
check(
  subpaths.length >= 4,
  `read ${String(subpaths.length)} subpaths from shader-dsl/package.json "exports" — the ` +
    'manifest reader is broken, so every assertion below is vacuous',
)
for (const sub of subpaths)
  check(
    Object.hasOwn(WITNESSES, sub) !== Object.hasOwn(NOT_BUILT, sub),
    `"exports" publishes ${sub} and this gate accounts for it in neither WITNESSES nor ` +
      'NOT_BUILT (or in both) — name the exports it must expose, or why Node cannot load it',
  )

const built = existsSync(DIST)
if (!built) failures.push(`shader-dsl/dist does not exist. Build it first:\n    ${BUILD_CMD}`)

// ── 1. every built entry point LOADS under Node's own ESM resolver ────────────────────────
// `exports` still points at `./src/*.ts` (flipping it to dist is a separate decision — see
// #1686 step 5 and #1681 increment C), so the dist twin is derived here rather than read.
const distTwin = (target) =>
  join(PKG_DIR, target.replace(/^\.\/src\//, 'dist/').replace(/\.ts$/, '.js'))

if (built)
  for (const sub of subpaths) {
    if (!Object.hasOwn(WITNESSES, sub)) continue // NOT_BUILT, or already reported unaccounted
    const file = distTwin(manifest.exports[sub])
    if (!check(existsSync(file), `${sub} → ${file} was not emitted. Run: ${BUILD_CMD}`)) continue
    try {
      const mod = await import(pathToFileURL(file).href)
      const names = Object.keys(mod)
      check(
        names.length > 0,
        `${sub} loaded but exports nothing — ${file} resolved to an empty module`,
      )
      for (const witness of WITNESSES[sub])
        check(names.includes(witness), `${sub} loaded but does not export '${witness}'`)
      console.log(`  ok  ${sub.padEnd(12)} ${String(names.length).padStart(3)} exports`)
    } catch (error) {
      // ERR_UNSUPPORTED_DIR_IMPORT / ERR_MODULE_NOT_FOUND is the #1686 symptom verbatim.
      failures.push(`${sub} → ${error.code ?? 'threw'}: ${String(error.message).split('\n')[0]}`)
    }
  }

// ── 2. no extensionless relative specifier survived into the emit ─────────────────────────
// The count #1686 opened on: 197 in dist/*.js and 178 in dist/*.d.ts — measured at 234 + 208
// on the tree this landed on. Statement-anchored so a specifier quoted inside one of this
// repo's banner comments is not mistaken for an import.
const SPECIFIER =
  /(?:^|\n)[ \t]*(?:import|export)(?:[ \t]+type)?[ \t]+[^;'"]*?\bfrom[ \t]+'(\.[^']*)'/g

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) yield full
  }
}

// Runs INDEPENDENTLY of arm 1, and reports even when arm 1 is already red: a specifier in a
// type-only `.d.ts` is never loaded at runtime, so arm 1 cannot see it — and roughly half the
// population lives there. Arm 1 names the CAUSE at the first hop that breaks; this one names
// the whole population. Cutting either one alone leaves the other green, which is the point.
if (built) {
  let scanned = 0
  const extensionless = []
  for (const file of walk(DIST)) {
    scanned++
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SPECIFIER))
      if (!match[1].endsWith('.js'))
        extensionless.push(`${file.slice(DIST.length + 1)}: ${match[1]}`)
  }
  const scanOk = check(
    scanned >= 50,
    `scanned ${String(scanned)} emitted files (94 .js + 94 .d.ts today) — the walker is ` +
      'broken, so the specifier assertion below is vacuous',
  )
  const clean = check(
    extensionless.length === 0,
    `${String(extensionless.length)} extensionless relative specifier(s) survived into the ` +
      `emit — Node cannot resolve any of them:\n    ${extensionless.slice(0, 20).join('\n    ')}`,
  )
  if (scanOk && clean)
    console.log(`  ok  scanned ${String(scanned)} emitted files, 0 extensionless specifiers`)
}

if (failures.length > 0) {
  console.error('\nshader-dsl does NOT load in plain Node (#1686):')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nshader-dsl loads in plain Node (#1686).')
