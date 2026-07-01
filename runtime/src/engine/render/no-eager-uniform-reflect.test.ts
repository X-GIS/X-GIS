import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// ── Regression gate: the 2026-06-26 map-load crash ──────────────────────────────
//
// polygonUniformBytes() / polygonUniformSlots() / polygonUniformStride() reflect
// the polygon module = a projection EMIT, which THROWS until configureProjections()
// has run (post-GPU-init). A MODULE-LEVEL `const … = polygonUniform…()` or a
// class `static … = polygonUniform…()` evaluates at IMPORT / class-definition time
// — BEFORE configureProjections — so the throw crashed the ENTIRE map init: the page
// hung at "Initializing…", __xgisMap was never created.
//
// It slipped through review + CI: a stale `.vite` cache served the pre-change module
// during local verification, and the SwiftShader/compute CI gates never load the real
// map (the only thing that imports these renderers). This GPU-free source scan is the
// CI gate that catches a re-introduction.
//
// The fix: read the size LAZILY. Allowed = instance field (ctor-time, post-init),
// method / function body (draw-time). Forbidden = module-level const, static field.

// Files under scan live in runtime/src/engine/render OR (once P3-extracted) in
// map/src/render — resolve each against both so the gate follows the content move.
const DIRS = [
  join(process.cwd(), 'runtime/src/engine/render'),
  join(process.cwd(), 'map/src/render'),
]
function readScanned(f: string): string {
  for (const d of DIRS) { const p = join(d, f); if (existsSync(p)) return readFileSync(p, 'utf8') }
  throw new Error(`no-eager scan: ${f} not found in ${DIRS.join(' | ')}`)
}

// Every file that consumes (or defines) a PROJECTION-GATED reflect-uniform helper.
// text/frame/overdraw modules carry NO projection, so reflecting them eagerly is
// SAFE — those files are intentionally NOT scanned.
const FILES = [
  'renderer.ts',
  'vector-tile-renderer.ts',
  'graticule-renderer.ts',
  'bind-group-registry.ts',
  'feature-data-binder.ts',
  'point-renderer.ts',
  'heatmap-renderer.ts',
  'heatmap-uniform-slots.ts',
  'raster-renderer.ts',
  'line-renderer.ts',
  'line-pattern.ts',
  'line-uniform-slots.ts',
]

// Projection-gated reflect helpers (named) + the raw `reflect(build*Module)`
// primitive they wrap. ALL of these emit the projection fns → throw until
// configureProjections() runs. Add a new helper name here when one is created.
const CALLS_REFLECT =
  /\b(polygonUniform(Bytes|Slots|Stride)|pointUniform(Slots|Bytes)|heatmapUniform(Slots|Bytes)|rasterUniform(Slots|Bytes|Stride)|lineLayerUniform(Slots|Bytes|Stride))\s*\(|reflect\s*\(\s*build(Polygon|Point|Line|Raster|Heatmap)\w*Module/

/** A line is EAGER if it calls a reflect helper AND it is a module-level `const`
 *  binding or a `static` class-field initializer (both evaluate at import /
 *  class-definition, before configureProjections()). Instance fields
 *  (`private x = …`), methods and function bodies are draw/ctor-time — allowed. */
function isEager(line: string): boolean {
  if (!CALLS_REFLECT.test(line)) return false
  // Module-level `const` evaluates at import. Checked on the RAW line so it must
  // be at column 0 — an INDENTED `const` is a local inside a function / method
  // body (draw-time), which is the allowed lazy pattern.
  if (/^(export\s+)?const\s+\w/.test(line)) return true
  // `static` class-field initializer evaluates at class-definition (import). It
  // is indented inside the class body, so match on the trimmed line; a local
  // `const` is never `static`, so this never collides with the allowed case.
  if (/^(public\s+|private\s+|protected\s+)?static\s/.test(line.trim())) return true
  return false
}

describe('no eager polygon-uniform reflect at import (map-load crash gate)', () => {
  it('detector flags eager module-const / static, allows lazy local / instance / method', () => {
    // Forbidden (evaluate before configureProjections) — across all gated helpers:
    expect(isEager('const X = polygonUniformBytes()')).toBe(true)
    expect(isEager('export const X = Math.ceil(polygonUniformStride() / 2)')).toBe(true)
    expect(isEager('  private static readonly X = polygonUniformBytes()')).toBe(true)
    expect(isEager('const N = pointUniformSlots().slots')).toBe(true)
    expect(isEager('  static readonly B = heatmapUniformBytes()')).toBe(true)
    expect(isEager('const M = reflect(buildRasterModule())')).toBe(true)
    // Allowed (ctor / draw / function-body time):
    expect(isEager('        const gratData = new ArrayBuffer(polygonUniformBytes())')).toBe(false) // indented local
    expect(isEager('  private buf = new ArrayBuffer(heatmapUniformBytes())')).toBe(false) // instance field
    expect(isEager('  return polygonUniformSlots().slots * 4')).toBe(false) // function body
    expect(isEager('export function pointUniformSlots() {')).toBe(false) // a helper definition
    expect(isEager('  // polygonUniformBytes() must stay lazy')).toBe(false) // comment
    expect(isEager('  this.ring = new UniformRing(d, polygonUniformStride(), 256)')).toBe(false) // ctor stmt
  })

  for (const f of FILES) {
    it(`${f}: no module-const / static-field call to polygonUniform*()`, () => {
      const offenders = readScanned(f)
        .split('\n')
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => isEager(l))
        .map(({ l, n }) => `${f}:${n}: ${l.trim()}`)
      expect(
        offenders,
        'EAGER polygonUniform*() at import/class-definition — evaluates before configureProjections() and crashes map init. Read the size lazily (instance field / method / function body) instead.',
      ).toEqual([])
    })
  }
})
