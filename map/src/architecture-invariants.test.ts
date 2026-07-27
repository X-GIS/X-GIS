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
//     extraction. REVIVED below over the packages that actually hold the branches,
//     with a freshly measured baseline — which had grown from 23 to 27 unnoticed.
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
// What remains are the three live locks below. A RATCHET: the projType numbers are
// high-water marks meant to drop, never rise — when you route a branch through a
// projections-table membership accessor, LOWER the number in the same commit.
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

// ── Gate 4: projType branching confined to projections-table ─────────
// REVIVED (see the header). `projType ===/!==` is a decision the projections table
// owns; every site outside it is a place where a new projection silently does the
// wrong thing. The authority file is EXEMPT; every other occurrence is baselined at
// its 2026-07-27 measurement over the packages that actually hold the branches.
// LOWER a number as branches route through the exported membership accessors
// (isCylindrical / isFlat / isOrtho / …); at 0 the file leaves the table.
const PROJTYPE_SCAN_DIRS = ['map/src', 'data/src', 'geo/src', 'engine/src']
/** The single authority allowed to branch on projType. */
const PROJTYPE_AUTHORITY = 'geo/src/projections-table.ts'
const PROJTYPE_ALLOWLIST: Record<string, number> = {
  'data/src/tile-select.ts': 1,
  'data/src/tiles-sse.ts': 3,
  'map/src/camera/camera.ts': 6,
  'map/src/camera/unproject.ts': 4,
  'map/src/controller.ts': 6,
  'map/src/render/camera-anchor-dsfun.ts': 1,
  'map/src/render/hillshade-renderer.ts': 1,
  'map/src/render/prefetch-scheduler.ts': 1,
  'map/src/render/raster-renderer.ts': 2,
  'map/src/render/under-occluder-renderer.ts': 1,
  'map/src/shaders/dsl/raster.ts': 1,
}

describe('arch ratchet: projType branching confined to projections-table', () => {
  const files = PROJTYPE_SCAN_DIRS.flatMap((d) => walkTs(join(ROOT, d)))
  const countIn = (abs: string): number =>
    (readFileSync(abs, 'utf8').match(/projType\s*[!=]==/g) || []).length

  it('no source file exceeds its allowed projType-comparison count', () => {
    const violations: string[] = []
    for (const f of files) {
      const r = rel(f)
      if (r === PROJTYPE_AUTHORITY) continue
      const count = countIn(f)
      const allowed = PROJTYPE_ALLOWLIST[r] ?? 0
      if (count > allowed) {
        violations.push(
          `${r}: ${count} projType comparisons > allowed ${allowed} — route through the projections-table membership accessors`,
        )
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  // The #996 lesson the header opens with: an allowlist entry pointing at a moved
  // or deleted file makes the gate quietly weaker. Fail loudly instead.
  it('every allowlist entry still names a scanned file at its baselined count', () => {
    const seen = new Set(files.map(rel))
    const stale: string[] = []
    for (const [f, n] of Object.entries(PROJTYPE_ALLOWLIST)) {
      if (!seen.has(f)) {
        stale.push(`${f}: allowlisted at ${n} but the file is not in the scan — delete the entry`)
        continue
      }
      const count = countIn(join(ROOT, f))
      if (count < n)
        stale.push(`${f}: allowlisted at ${n} but now has ${count} — LOWER it to ${count}`)
    }
    expect(stale, stale.join('\n')).toEqual([])
  })
})
