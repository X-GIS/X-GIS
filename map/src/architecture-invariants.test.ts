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
// What remains are the live locks below (Gates 2, 6, 7, and 8 — added by #1565,
// which locks the CI render paths-filter against the same vacuous-gate failure
// mode this header is otherwise a record of).
// GPU-free; rides the `test (map-*)` CI legs.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
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
