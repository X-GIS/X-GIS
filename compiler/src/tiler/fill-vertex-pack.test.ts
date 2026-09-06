// ═══ The fill-vertex kernel, proved byte-for-byte against the two loops it replaced ═══
//
// `packECEFPolygonVertices` (compiler, ground tiles) and `packECEFWithPolarCaps`
// (data, polar caps) each ran their own quantize/interleave loop over the same
// POLYGON_FILL_FORMAT — the polar-cap copy calling itself "mirrors the kernel
// exactly" in its own comment (#2534 audit S15). Both now call `packFillVertices`.
//
// These bytes are read by `vs_main_ecef` on the GPU, so "the tests still pass" is
// the wrong bar: a swapped u16 lane or a shifted f32 slot keeps every existing
// assertion green and moves geometry. So the two RETIRED LOOPS are kept here
// verbatim and the survivor is asserted byte-identical to each — compared through
// a Uint8Array view of the buffer, which sees a lane swap that a float-by-float
// comparison of the f32 view cannot.

import { describe, it, expect } from 'vitest'
import { quantizeAxis } from '@xgis/shared'
import { POLYGON_FILL_FORMAT, field } from './polygon-vertex-format'
import { packFillVertices, type FillVertexInputs } from './fill-vertex-pack'

const FLOATS = POLYGON_FILL_FORMAT.stride / 4
const U16S = POLYGON_FILL_FORMAT.stride / 2
const FID = field(POLYGON_FILL_FORMAT, 'feature_id').offset / 4
const LON = field(POLYGON_FILL_FORMAT, 'abs_lon').offset / 4
const LAT = field(POLYGON_FILL_FORMAT, 'abs_lat').offset / 4
const TRUELAT = field(POLYGON_FILL_FORMAT, 'true_lat').offset / 4

type Packed = { vertices: Float32Array; dequantScale: number; dequantHalf: number }

// ── the retired loops, verbatim ─────────────────────────────────────────────────────────
// Copied from ecef-packing.ts / polar-cap-ecef-pack.ts as they stood at a30cdad0. Do NOT
// refactor these to share anything: being the INDEPENDENT second implementation is their
// whole value. Only the surrounding function signature is new — each body is unchanged.

function retiredGroundTile(
  count: number,
  rx: Float64Array,
  ry: Float64Array,
  rz: Float64Array,
  maxAbs: number,
  localMercX: Float64Array,
  localMercY: Float64Array,
  trueLatDeg: Float64Array,
  fids: Float64Array,
): Packed {
  const halfRange = maxAbs + 1e-6
  const span = 2 * halfRange
  const dequantScale = span / 0xffffffff
  const invSpan = 0xffffffff / span

  const out = new Float32Array(count * FLOATS)
  const u16 = new Uint16Array(out.buffer)
  for (let i = 0; i < count; i++) {
    const [xh, xl] = quantizeAxis(rx[i], halfRange, invSpan)
    const [yh, yl] = quantizeAxis(ry[i], halfRange, invSpan)
    const [zh, zl] = quantizeAxis(rz[i], halfRange, invSpan)
    const u = i * U16S
    u16[u] = xh
    u16[u + 1] = xl
    u16[u + 2] = yh
    u16[u + 3] = yl
    u16[u + 4] = zh
    u16[u + 5] = zl
    const f = i * FLOATS
    out[f + FID] = fids[i]
    out[f + LON] = localMercX[i]
    out[f + LAT] = localMercY[i]
    out[f + TRUELAT] = trueLatDeg[i]
  }
  return { vertices: out, dequantScale, dequantHalf: halfRange }
}

function retiredPolarCap(
  vertexCount: number,
  rx: Float64Array,
  ry: Float64Array,
  rz: Float64Array,
  maxAbs: number,
  localMx: Float64Array,
  localMy: Float64Array,
  trueLat: Float64Array,
): Packed {
  const halfRange = maxAbs + 1e-6
  const span = 2 * halfRange
  const dequantScale = span / 0xffffffff
  const invSpan = 0xffffffff / span

  const out = new Float32Array(vertexCount * FLOATS)
  const u16 = new Uint16Array(out.buffer)
  for (let i = 0; i < vertexCount; i++) {
    const [xh, xl] = quantizeAxis(rx[i], halfRange, invSpan)
    const [yh, yl] = quantizeAxis(ry[i], halfRange, invSpan)
    const [zh, zl] = quantizeAxis(rz[i], halfRange, invSpan)
    const u = i * U16S
    u16[u] = xh
    u16[u + 1] = xl
    u16[u + 2] = yh
    u16[u + 3] = yl
    u16[u + 4] = zh
    u16[u + 5] = zl
    const f = i * FLOATS
    out[f + FID] = 0 // single synthetic feature
    out[f + LON] = localMx[i]
    out[f + LAT] = localMy[i]
    out[f + TRUELAT] = trueLat[i]
  }
  return { vertices: out, dequantScale, dequantHalf: halfRange }
}

// ── inputs ──────────────────────────────────────────────────────────────────────────────
/** A tile's worth of residuals. `spread` scales the ECEF residuals; 0 is the DEGENERATE
 *  zero-extent tile the `1e-6` epsilon exists for (span would be 0, invSpan infinite). */
function tile(count: number, spread: number): Omit<FillVertexInputs, 'fids'> {
  const rx = new Float64Array(count)
  const ry = new Float64Array(count)
  const rz = new Float64Array(count)
  const localMercX = new Float64Array(count)
  const localMercY = new Float64Array(count)
  const trueLatDeg = new Float64Array(count)
  let maxAbs = 0
  for (let i = 0; i < count; i++) {
    // Deliberately asymmetric per axis, so a kernel that swapped x/y/z lanes diverges.
    rx[i] = spread * Math.sin(i * 1.1)
    ry[i] = spread * Math.cos(i * 0.7) * 0.5
    rz[i] = spread * Math.sin(i * 0.3) * -0.25
    localMercX[i] = 1234.5 + i * 7
    localMercY[i] = -987.25 - i * 3
    trueLatDeg[i] = i % 2 === 0 ? 89.9999 : -85.0511287798066
    maxAbs = Math.max(maxAbs, Math.abs(rx[i]), Math.abs(ry[i]), Math.abs(rz[i]))
  }
  return { count, rx, ry, rz, maxAbs, localMercX, localMercY, trueLatDeg }
}

const fidsOf = (count: number): Float64Array =>
  Float64Array.from({ length: count }, (_, i) => i * 3 + 1)

/** Byte view — this is what the GPU reads, and the only comparison a swapped u16 lane
 *  cannot survive. A float-by-float check of the f32 view would miss it entirely. */
const bytes = (p: Packed): Uint8Array => new Uint8Array(p.vertices.buffer)

const CASES: ReadonlyArray<{ name: string; count: number; spread: number }> = [
  { name: 'an ordinary tile', count: 9, spread: 5000 },
  { name: 'a single vertex', count: 1, spread: 1200 },
  { name: 'a DEGENERATE zero-extent tile (every residual 0)', count: 4, spread: 0 },
  { name: 'an extreme half-range', count: 3, spread: 6.371e6 },
  { name: 'a sub-millimetre tile', count: 5, spread: 1e-4 },
]

describe('packFillVertices — byte-identical to the two loops it replaced (audit S15)', () => {
  for (const { name, count, spread } of CASES) {
    it(`equals the retired GROUND-TILE loop on ${name}`, () => {
      const t = tile(count, spread)
      const fids = fidsOf(count)
      const want = retiredGroundTile(
        t.count,
        t.rx,
        t.ry,
        t.rz,
        t.maxAbs,
        t.localMercX,
        t.localMercY,
        t.trueLatDeg,
        fids,
      )
      const got = packFillVertices({ ...t, fids })
      expect(bytes(got)).toEqual(bytes(want))
      expect(Object.is(got.dequantScale, want.dequantScale)).toBe(true)
      expect(Object.is(got.dequantHalf, want.dequantHalf)).toBe(true)
    })

    it(`equals the retired POLAR-CAP loop on ${name}`, () => {
      const t = tile(count, spread)
      const want = retiredPolarCap(
        t.count,
        t.rx,
        t.ry,
        t.rz,
        t.maxAbs,
        t.localMercX,
        t.localMercY,
        t.trueLatDeg,
      )
      const got = packFillVertices({ ...t, fids: null })
      expect(bytes(got)).toEqual(bytes(want))
      expect(Object.is(got.dequantScale, want.dequantScale)).toBe(true)
      expect(Object.is(got.dequantHalf, want.dequantHalf)).toBe(true)
    })
  }

  it('the degenerate tile produces a FINITE dequant scale — the epsilon is load-bearing', () => {
    // maxAbs 0 → span 0 → invSpan = 0xffffffff / 0 = Infinity, and every quantized lane
    // becomes NaN→0. The epsilon is the only thing standing between this case and a tile
    // of garbage, and no other assertion here would name it.
    const p = packFillVertices({ ...tile(4, 0), fids: null })
    expect(Number.isFinite(p.dequantScale)).toBe(true)
    expect(p.dequantScale).toBeGreaterThan(0)
    expect(p.dequantHalf).toBe(1e-6)
  })

  it('fids: null writes 0 into every feature_id slot, and a fids array is honoured', () => {
    // The two callers differ ONLY here, so this is the arm a factory that ignored `fids`
    // would pass anyway if it were asserted with `fids: null` alone.
    const t = tile(4, 3000)
    const synthetic = packFillVertices({ ...t, fids: null })
    const real = packFillVertices({ ...t, fids: fidsOf(4) })
    for (let i = 0; i < 4; i++) {
      expect(synthetic.vertices[i * FLOATS + FID]).toBe(0)
      expect(real.vertices[i * FLOATS + FID]).toBe(i * 3 + 1)
    }
  })

  it('the derived offsets match the format, so a tail change moves them together', () => {
    // The two copies each re-derived these; the point of one home is that this can only
    // be asserted once. stride 28 = 7 f32 = 14 u16, tail at floats 3/4/5/6 — the figure
    // both copies' prose had wrong since #398 appended true_lat.
    expect(POLYGON_FILL_FORMAT.stride).toBe(28)
    expect([FLOATS, U16S]).toEqual([7, 14])
    expect([FID, LON, LAT, TRUELAT]).toEqual([3, 4, 5, 6])
  })
})
