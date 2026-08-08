// ═══ Every asset a demo references must actually SHIP (#1626) ═══
//
// `pattern-lines.xgis` imported `libs/s100-lines.xgis` — a file that existed
// only on an author's local disk and had never been committed on any branch.
// The demo could not load in ANY fresh checkout, on CI, or on the deployed
// site, and nothing caught it: the render audit that would have (#1625) was
// generating zero tests, and no gate reads what a demo asks for.
//
// This is the always-on catch, and it is deliberately STATIC — the render
// audit is 180 demos at ~10 s each, far outside the render-gate budget, so it
// cannot be the thing that guards this. Reading source text costs milliseconds
// and is exact.
//
// WHY `git ls-files` AND NOT `existsSync`. The failure mode is "present on the
// author's disk, absent from the repo". On the machine where such a file is
// authored it exists, so a filesystem check passes there and fails only for
// everyone else — which is precisely the asymmetry that let #1626 land. Git's
// index is the only oracle that answers the question actually being asked.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const EXAMPLES = resolve(HERE, 'examples')
/** `import` and a source `url:` both resolve against this base at runtime —
 *  the browser requests `/data/<ref>` (verified against the network trace in
 *  #1626), so this is the directory a bare reference must land in. */
const ASSET_ROOT = 'playground/public/data'

/** Bulk Natural Earth extracts and tiler output, kept out of the repo on
 *  purpose (.gitignore:4-8) because they are too large to track. A demo may
 *  reference one; it just will not render in a clean checkout, which the demo
 *  audit reports as a skip rather than a failure. Everything else a demo
 *  names must ship. */
const BULK_ALLOWLIST = /^ne_(?:10m|50m)_[\w-]+\.geojson$|\.xgvt$|\.pmtiles$/

/** Comments may contain prose with `from "…"` in it — strip before matching,
 *  or the extractor invents references nobody wrote. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function xgisFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...xgisFiles(p))
    else if (entry.name.endsWith('.xgis')) out.push(p)
  }
  return out
}

/** Local asset references in one `.xgis` source. External URLs, XYZ templates
 *  and root-absolute paths (served from `public/` directly, not `/data/`) are
 *  not this gate's business. */
function localRefs(src: string): string[] {
  const refs = new Set<string>()
  for (const m of src.matchAll(/\burl\s*:\s*"([^"]+)"/g)) refs.add(m[1]!)
  for (const m of src.matchAll(/\bfrom\s+"([^"]+)"/g)) refs.add(m[1]!)
  for (const m of src.matchAll(/\bimport\s+"([^"]+)"/g)) refs.add(m[1]!)
  return [...refs].filter(
    (r) =>
      !/^(?:https?:|data:|pmtiles:|\/\/)/.test(r) && !r.startsWith('/') && !/\{[zxy]\}/.test(r),
  )
}

const trackedAssets = new Set(
  execFileSync('git', ['ls-files', ASSET_ROOT], { cwd: REPO_ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean),
)

const files = xgisFiles(EXAMPLES)
const references = files.flatMap((f) =>
  localRefs(stripComments(readFileSync(f, 'utf8'))).map((ref) => ({ file: f, ref })),
)

describe('demo asset references resolve to files that actually ship (#1626)', () => {
  // The population guard. #1625 was a 180-demo audit made vacuous by an
  // enumeration that silently returned nothing — a gate that does not prove
  // its own corpus is nonempty is the same bug wearing a different hat.
  it('the corpus is nonempty — examples and their references were actually found', () => {
    expect(files.length, `no .xgis examples under ${EXAMPLES}`).toBeGreaterThan(100)
    expect(
      references.length,
      'no local asset references parsed — did the syntax change?',
    ).toBeGreaterThan(100)
    expect(trackedAssets.size, `git ls-files ${ASSET_ROOT} returned nothing`).toBeGreaterThan(10)
  })

  it('every referenced asset is either tracked in git or a documented bulk extract', () => {
    const missing = references
      .filter(({ ref }) => !trackedAssets.has(`${ASSET_ROOT}/${ref}`) && !BULK_ALLOWLIST.test(ref))
      .map(({ file, ref }) => `${file.slice(REPO_ROOT.length + 1)} → "${ref}"`)
    expect(
      missing,
      `these demos reference assets that are not in the repo and are not bulk data, so they ` +
        `cannot load in a clean checkout (see #1626). Commit the asset under ${ASSET_ROOT}/ and ` +
        `whitelist it in .gitignore, or drop the reference:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  // The library that #1626 was about, pinned by name: a rename or a move that
  // silently drops it again fails HERE with the reason, not as a blank demo.
  it('the s100 line-decoration library ships, and exports what pattern_lines imports', () => {
    const lib = `${ASSET_ROOT}/libs/s100-lines.xgis`
    expect(trackedAssets.has(lib), `${lib} is not tracked — pattern_lines cannot load`).toBe(true)
    const src = readFileSync(join(REPO_ROOT, lib), 'utf8')
    for (const name of ['railway_tie', 'cliff_tooth']) {
      expect(src, `${lib} must declare \`symbol ${name}\``).toMatch(
        new RegExp(`symbol\\s+${name}\\s*\\{`),
      )
    }
  })
})
