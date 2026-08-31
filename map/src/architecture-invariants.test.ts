// ═══ Architecture ratchet gates — structural invariants, not behaviour ═══
//
// Descendant of the 2026-06-09 reckoning's Phase-1 gate file, which lived in
// `runtime/src/engine/` and walked `runtime/compiler/blueprint/shared`. It moved
// here when `@xgis/runtime` was dissolved, and the move forced an audit of every
// gate it carried. Two were VACUOUSLY GREEN — the #996 failure mode, a gate whose
// allowlist points at files that no longer exist:
//
//   • Gate 4 (projType branching) keyed its allowlist on `runtime/src/engine/**`
//     paths and scanned a walk that did not include `map/src`. Dead since the P3
//     extraction. Briefly revived HERE (2026-07-27) with a fresh baseline — then
//     FOLDED into `map/src/projtype-confinement-ratchet.test.ts`, the live #1005
//     revival it had duplicated (the CLAUDE.md §12 second-ratchet trap; the two
//     gates already disagreed — this one counted comments, so 2 of its 11 entries
//     were the warning COMMENTS at under-occluder-renderer.ts:203 and
//     shaders/dsl/raster.ts:169, not code). The fold kept the stricter semantics
//     (comment-stripped, strict-equal both directions, union scan) and carried
//     `engine/src` into that ratchet's scan set.
//   • Gate 5 (L0–L4 downward-only layer spine) mapped layers onto the same dead
//     `runtime/src/**` paths, so LAYER_OF returned null for every file in the repo.
//     DROPPED rather than faked: the spine was designed for the pre-extraction tree
//     (docs/research/2026-06-18-runtime-package-redesign.md, itself still marked
//     "DESIGN PROPOSAL — NOT YET IMPLEMENTED"). Reviving it needs a layer charter
//     written for today's `map/src`, which is a design task, not a path rename.
//
// Two more were retired as genuine duplicates, not losses:
//
//   • Gate 1 (compiler must not import the top package) is subsumed by
//     `engine/src/dependency-direction-ratchet.test.ts`, which pins the WHOLE
//     package graph — `compiler: ['shader-dsl', 'shared', 'rhi']` — and fails on
//     any new cross-package edge.
//   • Gate 3 (LOC ceilings) is subsumed by `map/src/loc-ceiling-ratchet.test.ts`,
//     which already carries the compiler/blueprint/shared ceilings this gate used
//     to own (#1005) plus map/engine/geo/data/rhi*. That retires the "two LOC
//     authorities" trap recorded in CLAUDE.md §12.
//
// What remains are the live locks below (Gates 2, 6, 7, 8 — added by #1565, which
// locks the CI render paths-filter against the same vacuous-gate failure mode this
// header is otherwise a record of — and 9, #1678's bundle lock on the baked-shader
// registry).
// GPU-free; rides the `test (map-*)` CI legs.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite' || name === '.tsbuild')
      continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}
function rel(abs: string): string {
  return relative(ROOT, abs).split('\\').join('/')
}

// ── Gate 2: map ↔ render-loop value-import cycle ─────────────────────
describe('arch ratchet: map ↔ render-loop value-import cycle stays broken', () => {
  it('render-loop.ts imports ./map as `import type` only', () => {
    const s = readFileSync(join(ROOT, 'map/src/render-loop.ts'), 'utf8')
    // A VALUE import of ./map re-forms the runtime cycle (map.ts value-imports
    // render-loop.ts). `import type` is erased by tsc, so it does not.
    const valueImport = /^\s*import\s+(?!type\b)[^\n]*from\s+['"]\.\/map['"]/m
    expect(
      valueImport.test(s),
      'render-loop.ts must import ./map with `import type` only (see commit 605479a5) — a value import re-creates the map↔render-loop runtime cycle',
    ).toBe(false)
  })
})

// ── Gate 6: engine content-blindness (@xgis/engine → @xgis/map == 0) ──
// The P3 Phase-2 extraction's TERMINAL invariant + completion lock ("Done =
// Gate-6"): @xgis/engine is a content-blind GPU engine (RHI / GPU / frame-core
// machinery); it must NEVER import @xgis/map (the render CONTENT). Holds by
// construction — engine/src was carved content-free before the @xgis/map content
// landed — so this gate passes today; it LOCKS the invariant so no future edit can
// re-introduce the reverse edge that would make the package graph cyclic.
describe('arch ratchet: Gate-6 — @xgis/engine is content-blind (0 @xgis/map imports)', () => {
  it('engine/src never imports @xgis/map (static value/type OR dynamic import())', () => {
    const re = /(?:from\s+|import\s*\(\s*)['"]@xgis\/map(?:['"/]|$)/m
    const offenders = walkTs(join(ROOT, 'engine/src'))
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(
      offenders,
      `@xgis/engine must be content-blind (Gate-6) — 0 @xgis/map imports; the reverse edge would make the package graph cyclic:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// ── Gate 7: engine is GEO-FREE (#781 — the projection subtree left the engine) ──
// The #781 epic ("the engine is NOT content-blind") moved the Camera cluster to
// @xgis/map (3b), the projection library (projection / projections-table / globe /
// world-scale) to the new @xgis/geo (3c), then dropped the ECEF re-export shim (3d).
// The engine is now projection-free. This LOCKS 3a-3d: geo cannot creep back into
// the content-blind core. @xgis/geo and @xgis/engine are siblings on @xgis/shared,
// so the engine must never import geo (the mirror of Gate-6's engine→map lock).
describe('arch ratchet: Gate-7 — @xgis/engine is geo-free (#781)', () => {
  it('engine/src never imports @xgis/geo (static value/type OR dynamic import())', () => {
    const re = /(?:from\s+|import\s*\(\s*)['"]@xgis\/geo(?:['"/]|$)/m
    const offenders = walkTs(join(ROOT, 'engine/src'))
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(
      offenders,
      `@xgis/engine must be geo-free (#781, Gate-7) — 0 @xgis/geo imports; geo and engine are siblings on @xgis/shared:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('the engine/src/projection subtree is gone (moved to @xgis/geo + @xgis/map)', () => {
    let exists = false
    try {
      statSync(join(ROOT, 'engine/src/projection'))
      exists = true
    } catch {
      /* gone — the intended state */
    }
    expect(
      exists,
      'engine/src/projection/ must not exist — the projection library moved to @xgis/geo (3c), the camera cluster to @xgis/map (3b), and the ecef shim was dropped (3d)',
    ).toBe(false)
  })
})

// ── Gate 8: the CI `render` paths-filter covers every rendering package (#1565) ──
// A package in `code` but not in `render` is CI-dark for pixels: `render-gate` has
// no job-level `if:` (every STEP is `if: needs.changes.outputs.render == 'true'`),
// so a PR touching only that package posts the required check GREEN with zero pixel
// gates run. That is exactly what happened to `rhi-webgpu/**` — the package every
// default-backend boot value-imports (map/src/gpu-boot.ts → initGPUViaProviders /
// backendProviderChain) — while the same workflow ran a SwiftShader-WebGPU raster
// gate against it. The exclusion comment asserted the opposite and nothing checked.
//
// The lock is stated as a DIFFERENCE, not a list: every package glob in `code` must
// be in `render` too, unless it is in EXEMPT below with a written reason. So adding
// a new package to `code` and forgetting `render` goes red naming that package, and
// deleting `rhi-webgpu/**` from `render` goes red naming `rhi-webgpu/**`.
function pathsFilterGlobs(yaml: string, name: string): string[] {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s{12}${name}:\\s*$`).test(l))
  expect(
    start,
    `the \`${name}\` paths-filter block must exist in .github/workflows/test.yml`,
  ).toBeGreaterThanOrEqual(0)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,12}\S/.test(line)) break // next filter name (or dedent) ends the block
    const m = /^\s{14}-\s+'([^']+)'\s*$/.exec(line)
    if (m?.[1] !== undefined) out.push(m[1])
  }
  return out
}

describe('arch ratchet: Gate-8 — the CI `render` filter covers every rendering package (#1565)', () => {
  // Reason required per entry. `rhi` is interfaces-only (erased by tsc, so a change
  // there cannot alter a rendered pixel without also touching an implementor, which
  // IS in `render`); `pipeline` is imported only by the seoul-* demos, never by the
  // `id=minimal` fixtures every render gate boots.
  const EXEMPT: Record<string, string> = {
    'rhi/**': 'interfaces-only → typecheck-covered; no emitted code',
    'pipeline/**': 'imported only by seoul-* demos, never the id=minimal gate fixtures',
    // Added to `code` by #1700, which found it was in NO filter at all: a scripts-only PR
    // set code=false, every leg skipped its steps, and 17 checks posted green in ~4s having
    // run nothing — so the changelog suite and the doc-signature ratchet were CI-dark for
    // changes to themselves. It is exempt from `render` because scripts/ is repo TOOLING
    // (precheck, changelog, gap-matrix, the doc ratchet) that nothing shipped imports —
    // verified: no file under map/, playground/, rhi*/, engine/, compiler/, data/ or site/
    // imports from scripts/, so it is in no bundle and on no render path.
    'scripts/**': 'repo tooling; imported by nothing shipped, so it is on no render path',
    // Added to `code` by #1842 for the same reason #1700 added scripts/**: measured, 5 of
    // the 6 tracked workflows were in NO filter, so `scripts/workflow-validity.test.ts` —
    // the gate that exists because a workflow once shipped unparseable (#1693) — never ran
    // on a PR that edited one. Four rewrites of changelog.yml landed that way in a day.
    // Exempt from `render` because a workflow file is CI configuration: it is in no bundle,
    // nothing imports it, and it cannot alter a rendered pixel. It CAN alter which gates
    // run, which is precisely why it belongs in `code`.
    '.github/workflows/**': 'CI configuration; in no bundle and on no render path',
  }

  it('every package glob in `code` is in `render` too, or exempt with a reason', () => {
    const yaml = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')
    const code = pathsFilterGlobs(yaml, 'code')
    const render = new Set(pathsFilterGlobs(yaml, 'render'))
    // Package globs only — the shared lockfile/manifest/tsconfig entries are not
    // packages and are filtered by both blocks on their own terms.
    const missing = code
      .filter((g) => g.endsWith('/**'))
      .filter((g) => !render.has(g) && EXEMPT[g] === undefined)
    expect(
      missing,
      `these packages fire the \`code\` filter but NOT \`render\`, so a PR touching only them posts render-gate GREEN with zero pixel gates run (#1565):\n${missing.join(
        '\n',
      )}\nAdd each to the \`render\` filter, or to Gate-8's EXEMPT map with the reason it cannot affect a rendered pixel.`,
    ).toEqual([])
  })

  it('rhi-webgpu is in the `render` filter — every default-backend boot imports it', () => {
    const yaml = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')
    // Named explicitly as well as covered by the difference above: this is the
    // instance #1565 was filed on, and the falsified premise ("no SwiftShader spec
    // drives WebGpuDevice") is the kind of claim that gets re-added by a reader who
    // trusts the comment. The boot import is the load-bearing fact.
    const boot = readFileSync(join(ROOT, 'map/src/gpu-boot.ts'), 'utf8')
    expect(
      /from\s+['"]@xgis\/rhi-webgpu['"]/.test(boot),
      'map/src/gpu-boot.ts must value-import @xgis/rhi-webgpu — if this moved, Gate-8 needs re-aiming, not deleting',
    ).toBe(true)
    expect(
      pathsFilterGlobs(yaml, 'render').includes('rhi-webgpu/**'),
      '`rhi-webgpu/**` must be in the CI `render` paths-filter (#1565) — map/src/gpu-boot.ts value-imports it on every default-backend boot, and _polygon-fill-flat-pixel-gate is a SwiftShader-WebGPU RASTER gate',
    ).toBe(true)
  })
})

// ── Gate 9: the baked-shader REGISTRY stays out of the runtime bundle (#1678) ──
// `map/src/shaders/baked/registry.ts` value-imports all 24 dsl emitters — polygon, line,
// point, icon, text, the retained-instance family, the heatmap passes. That whole module
// graph is precisely what the build-time bake exists to keep OUT of the shipped bundle:
// the runtime consume half (`seed-hillshade.ts`) reads STRINGS out of a committed
// artifact and must never reach the generators that produced them.
//
// Today that rests on nothing but comment discipline — three files say "the seeder cannot
// import the registry" and no mechanism enforces it, which is CLAUDE.md §12's "intent in a
// comment is not wiring". One `import { BAKED_SHADER_KEYS } from './registry'` added to the
// seeder for convenience would pull every emitter back in, and the only symptom would be a
// bigger bundle — invisible to tsc, to vitest, and to every render gate.
//
// `import type` is fine and is what the four artifacts, `body-guard.ts` and
// `seed-hillshade.ts` already use: tsc erases it, so it moves no code. The one value
// importer allowed is `bake.ts`, which IS the build-time half (the generator drives it and
// the sync gate imports it; neither is reachable from a boot).
describe('arch ratchet: Gate-9 — only bake.ts value-imports the baked-shader registry (#1678)', () => {
  const REGISTRY = join(ROOT, 'map/src/shaders/baked/registry.ts')
  const ALLOWED = ['map/src/shaders/baked/bake.ts']

  /** Static VALUE imports + dynamic `import()` of `registry.ts`, resolved as specifiers
   *  so a future `../shaders/baked/registry` from elsewhere in map/src is caught too. */
  function valueImportsRegistry(abs: string): boolean {
    const src = readFileSync(abs, 'utf8')
    const specs: string[] = []
    for (const m of src.matchAll(/^[ \t]*import\s+(?!type\b)[\s\S]*?from\s*['"]([^'"]+)['"]/gm))
      specs.push(m[1] as string)
    for (const m of src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1] as string)
    return specs.some((s) => s.startsWith('.') && resolvePath(dirname(abs), s) + '.ts' === REGISTRY)
  }

  it('no non-test module under map/src value-imports shaders/baked/registry.ts', () => {
    const offenders = walkTs(join(ROOT, 'map/src'))
      .filter(valueImportsRegistry)
      .map(rel)
      .filter((f) => !ALLOWED.includes(f))
      .sort()
    expect(
      offenders,
      `these modules VALUE-import the baked-shader registry, which drags all 24 dsl emitters ` +
        `into the runtime bundle and defeats the bake (#1678):\n${offenders.join('\n')}\n` +
        `Use \`import type\` for the artifact/meta shapes, and \`shaders/baked/ids.ts\` (a leaf ` +
        `with no imports) for the id spellings.`,
    ).toEqual([])
  })

  it('the detector is live — bake.ts IS seen as a value importer (#996)', () => {
    // Without this the gate passes identically whether the regex works or matches nothing.
    expect(
      valueImportsRegistry(join(ROOT, 'map/src/shaders/baked/bake.ts')),
      'bake.ts value-imports the registry; a detector that misses it would pass on everything',
    ).toBe(true)
    expect(
      valueImportsRegistry(join(ROOT, 'map/src/shaders/baked/seed-hillshade.ts')),
      'seed-hillshade.ts must import the registry with `import type` only',
    ).toBe(false)
  })
})

// ── Gate 10: every safeFetch caller is a CLASSIFIED async resource (#2160) ──
// Twice in one campaign an async resource landed on a frame the render loop had already
// stopped drawing — #2116 (in-flight glyph PBF ranges) and #2122 (the sprite atlas). Both
// were found by a person noticing the symptom, because nothing enumerates the async
// resource classes.
//
// The invariant is NOT "every resource registers in the keep-warm predicate" — that would
// flag correct code. There are TWO valid mechanisms and a resource needs exactly one:
//
//   (a) hold the loop warm while in flight — a term in `shouldRenderThisFrame` /
//       `keepLoopWarm`, deadline-bounded so a hung host cannot wedge the loop (#2091);
//   (b) `invalidate()` on arrival — re-arm the loop when the resource lands, so no
//       keep-warm window is needed at all (what the coverage source does).
//
// #2116 and #2122 did NEITHER, and that is the whole defect class. `safeFetch`
// (`shared/src/safety.ts`) is the repo's single guarded-fetch entry point, which makes its
// callers a usable census. This gate requires every caller to be registered with the
// mechanism that covers it, and requires the SITE COUNT to match — so a new fetch added to
// an ALREADY-registered file still trips it, which a file-keyed allowlist alone would miss.
//
// Comments are stripped before counting. The header of this file records a sibling gate
// that counted comment text and so carried two warning COMMENTS among its eleven "code"
// entries; several files below say "safeFetch follows manually" in prose.
//
// Honest limit, stated so nobody over-reads a green: this catches a new `safeFetch` caller.
// It does not catch an async resource that never goes through `safeFetch` (a raw `fetch`, a
// worker message, an `ImageBitmap` decode). `safeFetch` is the census because it is already
// the single guarded entry point, not because it is exhaustive.
describe('arch ratchet: Gate-10 — every safeFetch caller is a classified async resource (#2160)', () => {
  /** file → how many `safeFetch(` CALL SITES it has, and what covers them. Classified by
   *  reading each site (#2160 comment 5477030153); the census was fully green when the
   *  gate landed, so its first red is a genuine finding, not known debt. */
  const REGISTRY: Record<string, { sites: number; why: string }> = {
    'data/src/vector-tile-loader.ts': {
      sites: 2,
      why: '(a) VT tiles — source.hasPendingLoads() via the vt-fetch registration (pending-work.ts, #2149)',
    },
    'data/src/tile-select.ts': {
      sites: 1,
      why: '(a) raster image tiles — rasterRenderer.pendingLoadCount() via the raster-fetch registration (#2149)',
    },
    'map/src/text/sdf/pbf/glyph-pbf-cache.ts': {
      sites: 1,
      why: '(a) glyph PBF ranges — textStage.hasPendingGlyphLoads(), map.ts:4449 (#2116)',
    },
    'map/src/sprite/sprite-atlas-host.ts': {
      sites: 2,
      why: '(a) sprite atlas — iconStage.hasPendingAtlasLoad(), map.ts:4460 (#2122)',
    },
    'map/src/source-manager.ts': {
      sites: 2,
      why:
        '(b) then (a): _fetchGeoJSONDoc/_runCustomLoader are pure helpers; the live caller is ' +
        'the refresh: tick (:672) -> setSourceData, which invalidates at :1046. The voided ' +
        're-attach at :1042 is safe ONLY because registerVtSource runs synchronously before ' +
        'the first await (documented :1011-1015) — add an await ahead of it and this becomes ' +
        'a real #2116-shaped bug with the loop idle between the invalidate and the register.',
    },
    'map/src/map.ts': {
      sites: 3,
      why:
        'MIXED. :582 guardedFetch (coverage/S-111) is (b)+(a) since #2129/#2149: arrival still ' +
        'invalidates, and each catalogue cell read now also holds a deadlined pending-work ' +
        'ticket (coverage-source.ts readCatalogueItem → pending-work.ts). ' +
        ':4221 (.xgb scene binary) and :4295 (public loadSource) are ' +
        'not on the frame path: both are awaited by an explicit host load call.',
    },
    'map/src/style-import-resolver.ts': {
      sites: 1,
      why: 'not on the frame path — resolved during style parse, before any frame depends on it',
    },
  }

  /** `safeFetch(` call sites in `src`, comments stripped. Pure so the decoy test below can
   *  feed it a literal instead of hunting for a file with the right shape. */
  function countSafeFetchSites(src: string): number {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    return (stripped.match(/safeFetch\s*\(/g) ?? []).length
  }

  /** rel-path → site count, for every non-test module under map/src + data/src. */
  function census(): Map<string, number> {
    const found = new Map<string, number>()
    for (const dir of ['map/src', 'data/src']) {
      for (const abs of walkTs(join(ROOT, dir))) {
        const n = countSafeFetchSites(readFileSync(abs, 'utf8'))
        if (n > 0) found.set(rel(abs), n)
      }
    }
    return found
  }

  it('every safeFetch caller is registered, with a matching site count', () => {
    const problems: string[] = []
    for (const [file, n] of [...census()].sort()) {
      const entry = REGISTRY[file]
      if (!entry) {
        problems.push(
          `${file}: ${n} safeFetch site(s), UNREGISTERED — say what keeps the loop alive for ` +
            `this resource: (a) a deadline-bounded keep-warm term, or (b) invalidate() on ` +
            `arrival. A resource that does neither lands on a stopped loop and is invisible ` +
            `until the next interaction (#2116, #2122).`,
        )
      } else if (entry.sites !== n) {
        problems.push(
          `${file}: ${n} safeFetch site(s), registered as ${entry.sites} — a site was added or ` +
            `removed. Re-read the new one and confirm it is covered, then update the count. ` +
            `Current entry: ${entry.why}`,
        )
      }
    }
    expect(problems, `unclassified async resources:\n${problems.join('\n\n')}`).toEqual([])
  })

  it('every REGISTRY key still resolves to a real caller (#996 stale-allowlist guard)', () => {
    // Without this the registry rots silently the first time a file moves or a fetch is
    // deleted — the exact way two gates in this file's header went vacuously green.
    const found = census()
    const stale = Object.keys(REGISTRY)
      .filter((f) => !found.has(f))
      .sort()
    expect(
      stale,
      `these REGISTRY keys no longer contain a safeFetch call — the file moved, or the fetch ` +
        `was removed. Delete the entry (or re-key it) so the registry keeps describing the ` +
        `real census:\n${stale.join('\n')}`,
    ).toEqual([])
  })

  it('the detector is live — it counts real calls and ignores commented-out ones', () => {
    // A counter that matched nothing would pass the first test on every file forever.
    expect(
      countSafeFetchSites(
        readFileSync(join(ROOT, 'map/src/text/sdf/pbf/glyph-pbf-cache.ts'), 'utf8'),
      ),
      'glyph-pbf-cache.ts calls safeFetch once (#2116); a detector that misses it greens everything',
    ).toBe(1)
    // Planted decoy: prose and a commented-out call must not count, or the census inflates
    // and a real new fetch hides inside a count that already looked right.
    expect(
      countSafeFetchSites(
        ['// safeFetch(url) — commented out', '/* await safeFetch(u) */', 'const x = 1'].join('\n'),
      ),
      'commented-out calls must not count',
    ).toBe(0)
    expect(countSafeFetchSites('await safeFetch(url, undefined, "x")'), 'a real call counts').toBe(
      1,
    )
  })
})
