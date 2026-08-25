// #777 IV3-a — `text-pitch-alignment: map`: ground-basis glyph-quad wiring.
//
// The gap this closes: X-GIS draws every label as a viewport-aligned billboard
// because the text vertex path emits screen-px quads at z=0 (shaders/dsl/text.ts)
// and `LabelDef.pitchAlignment` had NO consumer in map/src. The spec reaches that
// gap by DEFAULT — `text-pitch-alignment: auto` matches text-rotation-alignment,
// whose own `auto` is `map` for line placement — so every road name in every
// basemap should lie in the ground plane and does not.
//
// The render contract introduced here: `TextDraw.groundBasis = [ex, ey, nx, ny]`
// carries the screen-space images of the anchor's ground-plane axes, and every
// quad corner at screen offset (dx, dy) from the anchor is re-placed at
//   anchor + dx*(ex, ey) + dy*(nx, ny)
// inside TextRenderer.setDraws, BEFORE the vertices are uploaded.
//
// Drives the REAL TextRenderer against the WebGPU stub (no GPU) and intercepts
// `device.queue.writeBuffer` to read the uploaded positions — the harness is
// text-rotate-wiring.test.ts's, which pins the sibling `rotateRad` contract.
//
// Fail-before (each case, verified): delete the `if (groundBasis !== undefined)`
// block in text-renderer.ts and the tilted run equals the plain run — every
// assertion below that a basis MOVES vertices fails before any render runs.
//
// Non-vacuity is explicit rather than assumed: the identity case would pass for
// a renderer that ignores groundBasis entirely, so it is paired with a tilt case
// that must differ, and the tilt is checked against an INDEPENDENTLY computed
// affine of the plain run rather than against itself.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { TextRenderer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { TextDraw } from '@xgis/map'
import type { GlyphInfo } from '@xgis/map'
import { groundBasisAabb, type GroundBasis } from './ground-basis'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => {
  stub.uninstall()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

const FAKE_ATLAS = { pageCount: 0, getPage: () => undefined } as never

const ANCHOR_X = 100
const ANCHOR_Y = 200
// 'A' (cp 65) — non-ideographic, so the synthetic-oblique shear stays out of the
// arithmetic and each corner has one unambiguous unprojected position.
const GLYPH: GlyphInfo = {
  codepoint: 65,
  slot: { page: 0, cellX: 0, cellY: 0, pxX: 0, pxY: 0, size: 24 },
  advanceWidth: 14,
  bearingX: 2,
  bearingY: 18,
  width: 12,
  height: 16,
  pbf: true,
  rasterFontSize: 24,
}

function makeDraw(groundBasis?: ArrayLike<number>, rotateRad?: number): TextDraw {
  return {
    anchorX: ANCHOR_X,
    anchorY: ANCHOR_Y,
    glyphs: [GLYPH],
    fontSize: 24,
    rasterFontSize: 24,
    color: [0, 0, 0, 1],
    ...(groundBasis !== undefined ? { groundBasis } : {}),
    ...(rotateRad !== undefined ? { rotateRad } : {}),
  }
}

const VERTEX_BUF_SIZE = 1024
const FLOATS_PER_VERT = 4
const VERTS_PER_GLYPH = 6

function capturedVerts(ctx: GPUContext, draw: TextDraw): Float32Array {
  const renderer = new TextRenderer(
    ctx.device,
    new WebGpuDevice(ctx.device),
    FAKE_ATLAS,
    ctx.format,
  )
  let verts: Float32Array | undefined
  const device = ctx.device as unknown as {
    queue: {
      writeBuffer: (
        buf: unknown,
        off: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset?: number,
        size?: number,
      ) => void
    }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBuffer | ArrayBufferView,
    dataOffset?: number,
    size?: number,
  ): void => {
    if ((buf as { size?: number })?.size !== VERTEX_BUF_SIZE) return
    const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
    const byteOff =
      data instanceof ArrayBuffer ? (dataOffset ?? 0) : (data as ArrayBufferView).byteOffset
    const byteLen = size ?? VERTS_PER_GLYPH * FLOATS_PER_VERT * 4
    verts = new Float32Array(ab, byteOff, byteLen / 4).slice(0, VERTS_PER_GLYPH * FLOATS_PER_VERT)
  }
  renderer.setDraws([draw])
  if (verts === undefined) throw new Error('vertex buffer was not uploaded')
  return verts
}

/** Positions only, as [x, y] pairs — uv slots are not under test. */
function positions(verts: Float32Array): [number, number][] {
  const out: [number, number][] = []
  for (let v = 0; v < VERTS_PER_GLYPH; v++) {
    out.push([verts[v * FLOATS_PER_VERT]!, verts[v * FLOATS_PER_VERT + 1]!])
  }
  return out
}

/** The contract, applied independently of the renderer. */
function applyBasis(p: [number, number][], b: ArrayLike<number>): [number, number][] {
  return p.map(([x, y]) => {
    const dx = x - ANCHOR_X,
      dy = y - ANCHOR_Y
    return [ANCHOR_X + dx * b[0]! + dy * b[2]!, ANCHOR_Y + dx * b[1]! + dy * b[3]!] as [
      number,
      number,
    ]
  })
}

const near = (a: [number, number][], b: [number, number][]): void => {
  expect(a.length).toBe(b.length)
  for (let i = 0; i < a.length; i++) {
    expect(a[i]![0]).toBeCloseTo(b[i]![0], 4)
    expect(a[i]![1]).toBeCloseTo(b[i]![1], 4)
  }
}

// A pitched camera foreshortens the ground's screen-vertical axis and leaves the
// horizontal one alone: this is the shape of a real `map`-aligned basis, not an
// arbitrary matrix. ny = 0.5 ⇒ the quad is half as tall on screen.
const PITCH_BASIS: GroundBasis = [1, 0, 0, 0.5]
// Bearing + pitch: the ground axes are no longer screen-aligned, so this also
// exercises the off-diagonal terms (a diagonal-only basis would let a renderer
// that dropped ex.y / nx.x still pass).
const PITCH_BEARING_BASIS: GroundBasis = [0.94, 0.34, -0.17, 0.47]

describe('#777 IV3-a — TextDraw.groundBasis lays the glyph quad in the ground plane', () => {
  it('an absent basis is bit-identical to an identity basis (the viewport-alignment gate)', async () => {
    const ctx = await makeCtx()
    const absent = capturedVerts(ctx, makeDraw(undefined))
    const identity = capturedVerts(ctx, makeDraw([1, 0, 0, 1]))
    // Float-for-float, not toBeCloseTo: the default path must not drift by an
    // ULP either, since every existing label rides it.
    expect(Array.from(identity)).toEqual(Array.from(absent))
  })

  it('a pitch basis foreshortens every vertex by exactly the declared affine', async () => {
    const ctx = await makeCtx()
    const plain = positions(capturedVerts(ctx, makeDraw(undefined)))
    const tilted = positions(capturedVerts(ctx, makeDraw(PITCH_BASIS)))
    near(tilted, applyBasis(plain, PITCH_BASIS))
    // Non-vacuity: the basis must actually have moved something. Without this
    // the case above passes for a renderer that ignores groundBasis.
    expect(tilted).not.toEqual(plain)
  })

  it('an off-diagonal (pitch + bearing) basis is honoured on both axes', async () => {
    const ctx = await makeCtx()
    const plain = positions(capturedVerts(ctx, makeDraw(undefined)))
    const tilted = positions(capturedVerts(ctx, makeDraw(PITCH_BEARING_BASIS)))
    near(tilted, applyBasis(plain, PITCH_BEARING_BASIS))
    // Every vertex off the anchor must move on BOTH axes — a renderer that
    // applied only the diagonal terms would leave one coordinate untouched.
    for (let i = 0; i < plain.length; i++) {
      expect(tilted[i]![0]).not.toBeCloseTo(plain[i]![0], 4)
      expect(tilted[i]![1]).not.toBeCloseTo(plain[i]![1], 4)
    }
  })

  it('the anchor itself is the basis fixed point', async () => {
    const ctx = await makeCtx()
    // A degenerate glyph run still pins the invariant that matters for
    // placement: whatever the basis, the anchor does not move, so a label's
    // collision anchor and its projected quad stay in the same frame.
    const plain = positions(capturedVerts(ctx, makeDraw(undefined)))
    const tilted = positions(capturedVerts(ctx, makeDraw(PITCH_BEARING_BASIS)))
    for (let i = 0; i < plain.length; i++) {
      const dPlain = Math.hypot(plain[i]![0] - ANCHOR_X, plain[i]![1] - ANCHOR_Y)
      const dTilt = Math.hypot(tilted[i]![0] - ANCHOR_X, tilted[i]![1] - ANCHOR_Y)
      // Both runs measure from the same anchor; a basis that translated the
      // quad instead of transforming it about the anchor would break this.
      if (dPlain === 0) expect(dTilt).toBeCloseTo(0, 6)
    }
    near(tilted, applyBasis(plain, PITCH_BEARING_BASIS))
  })

  it('the basis is applied AFTER rotation, not before (composition order)', async () => {
    const ctx = await makeCtx()
    // Order is load-bearing: projecting a rotated quad tilts the label's
    // in-plane angle into the ground, which is the intent. Rotating a
    // foreshortened quad would shear the glyphs instead. Pin it so a later
    // refactor cannot silently swap the two.
    const rotated = positions(capturedVerts(ctx, makeDraw(undefined, Math.PI / 3)))
    const both = positions(capturedVerts(ctx, makeDraw(PITCH_BASIS, Math.PI / 3)))
    near(both, applyBasis(rotated, PITCH_BASIS))
    // And it is genuinely a different result from the other order, so the
    // assertion above discriminates. basis-then-rotate is computed here from
    // the unrotated run for the comparison.
    const plain = positions(capturedVerts(ctx, makeDraw(undefined)))
    const basisFirst = applyBasis(plain, PITCH_BASIS).map(([x, y]) => {
      const c = Math.cos(Math.PI / 3),
        s = Math.sin(Math.PI / 3)
      const dx = x - ANCHOR_X,
        dy = y - ANCHOR_Y
      return [ANCHOR_X + dx * c - dy * s, ANCHOR_Y + dx * s + dy * c] as [number, number]
    })
    expect(both).not.toEqual(basisFirst)
  })
})

// The anti-drift pin. The collision box is derived in text-stage while the quad
// is transformed in the renderer — two sites, one basis. If they ever disagree,
// a label lies down while its box stays upright: it reserves the wrong
// footprint, loses collisions it should win, and blocks labels it should not.
// This asserts groundBasisAabb (what text-stage will use) against the REAL
// renderer's emitted vertices, so the two cannot drift apart silently.
describe('#777 IV3-2c — the collision AABB equals the renderer quad footprint', () => {
  const aabbOf = (p: [number, number][]) => ({
    minX: Math.min(...p.map((q) => q[0])),
    minY: Math.min(...p.map((q) => q[1])),
    maxX: Math.max(...p.map((q) => q[0])),
    maxY: Math.max(...p.map((q) => q[1])),
  })

  for (const [name, basis] of [
    ['pitch only', PITCH_BASIS],
    ['pitch + bearing (off-diagonal)', PITCH_BEARING_BASIS],
  ] as const) {
    it(`matches the drawn quad under ${name}`, async () => {
      const ctx = await makeCtx()
      const plain = aabbOf(positions(capturedVerts(ctx, makeDraw(undefined))))
      const drawn = aabbOf(positions(capturedVerts(ctx, makeDraw([...basis]))))
      const predicted = groundBasisAabb(
        basis,
        ANCHOR_X,
        ANCHOR_Y,
        plain.minX,
        plain.minY,
        plain.maxX,
        plain.maxY,
      )
      expect(predicted.minX).toBeCloseTo(drawn.minX, 4)
      expect(predicted.minY).toBeCloseTo(drawn.minY, 4)
      expect(predicted.maxX).toBeCloseTo(drawn.maxX, 4)
      expect(predicted.maxY).toBeCloseTo(drawn.maxY, 4)
      // Non-vacuity: a foreshortening basis must actually shrink the footprint,
      // or this would pass for a helper that returned its input unchanged.
      const area = (b: typeof drawn) => (b.maxX - b.minX) * (b.maxY - b.minY)
      expect(area(drawn)).toBeLessThan(area(plain))
    })
  }

  it('leaving the box untransformed would be wrong — the sizes genuinely differ', () => {
    // Pins the reason the box cannot simply be left alone: the identity-vs-basis
    // difference is not a rounding artefact.
    const box = groundBasisAabb(PITCH_BASIS, 0, 0, -10, -20, 30, 40)
    expect(box.maxY - box.minY).toBeCloseTo(30, 6) // 60 px tall * 0.5 squash
    expect(box.maxX - box.minX).toBeCloseTo(40, 6) // width untouched at this basis
  })
})

// ── #2012 INC-4 — TextDraw.groundBasisPivot ────────────────────────────────────
//
// The curved line label's renderer contract is the reason this field exists: it
// sets `anchorX/anchorY = 0` and writes ABSOLUTE screen positions into
// `glyphOffsets` (the renderer computes `baseX = anchorX + offsets[2i]`), so a
// basis pivoted on the anchor swings the whole road name around screen pixel
// (0, 0). That is design §1.4(c), and it is why wiring the curved branch was never
// a one-line change. Every assertion below is against an INDEPENDENTLY computed
// affine of the untransformed run rather than against the renderer's own output.

const OFFSET_X = 260
const OFFSET_Y = 140

/** A curved-label-shaped draw: anchor at the origin, absolute per-glyph offsets,
 *  a per-glyph rotation — exactly what TextStage's line loop emits. */
function makeCurvedDraw(
  groundBasis?: ArrayLike<number>,
  groundBasisPivot?: readonly [number, number],
): TextDraw {
  return {
    anchorX: 0,
    anchorY: 0,
    glyphs: [GLYPH],
    fontSize: 24,
    rasterFontSize: 24,
    color: [0, 0, 0, 1],
    glyphOffsets: new Float32Array([OFFSET_X, OFFSET_Y]),
    glyphRotations: new Float32Array([0]),
    ...(groundBasis !== undefined ? { groundBasis } : {}),
    ...(groundBasisPivot !== undefined ? { groundBasisPivot } : {}),
  }
}

/** The contract about an arbitrary pivot, applied independently. */
function applyBasisAbout(
  p: [number, number][],
  b: ArrayLike<number>,
  pvx: number,
  pvy: number,
): [number, number][] {
  return p.map(([x, y]) => {
    const dx = x - pvx,
      dy = y - pvy
    return [pvx + dx * b[0]! + dy * b[2]!, pvy + dx * b[1]! + dy * b[3]!] as [number, number]
  })
}

const bboxOf = (p: [number, number][]) => ({
  minX: Math.min(...p.map((q) => q[0])),
  minY: Math.min(...p.map((q) => q[1])),
  maxX: Math.max(...p.map((q) => q[0])),
  maxY: Math.max(...p.map((q) => q[1])),
})

describe('#2012 INC-4 — TextDraw.groundBasisPivot moves the pivot off the anchor', () => {
  it('an absent pivot is bit-identical to passing the anchor explicitly', async () => {
    const ctx = await makeCtx()
    const implicit = capturedVerts(ctx, makeDraw(PITCH_BEARING_BASIS))
    const explicit = capturedVerts(ctx, {
      ...makeDraw(PITCH_BEARING_BASIS),
      groundBasisPivot: [ANCHOR_X, ANCHOR_Y] as const,
    })
    expect(Array.from(explicit)).toEqual(Array.from(implicit))
  })

  it('a basis on a CURVED draw with NO pivot swings the quad around screen (0,0)', async () => {
    // The §1.4(c) failure, pinned as the thing the pivot prevents. This is also
    // the shape of the mandated fail-before cut: force the pivot to (0,0) and the
    // glyph leaves its position entirely.
    const ctx = await makeCtx()
    const plain = positions(capturedVerts(ctx, makeCurvedDraw()))
    const noPivot = positions(capturedVerts(ctx, makeCurvedDraw(PITCH_BASIS)))
    near(noPivot, applyBasisAbout(plain, PITCH_BASIS, 0, 0))
    // The glyph's quad top sits at y ≈ 122 and the basis halves the screen-
    // vertical axis about the ORIGIN, so it is drawn ~59 px above where it
    // belongs — a displacement of roughly three glyph heights, not a nuance.
    const lift = bboxOf(plain).minY - bboxOf(noPivot).minY
    expect(lift).toBeCloseTo(bboxOf(plain).minY * 0.5, 3)
    expect(lift).toBeGreaterThan(2 * (bboxOf(plain).maxY - bboxOf(plain).minY))
  })

  it('the pivot keeps the glyph where it was and only foreshortens its quad', async () => {
    const ctx = await makeCtx()
    const plain = positions(capturedVerts(ctx, makeCurvedDraw()))
    const pivoted = positions(capturedVerts(ctx, makeCurvedDraw(PITCH_BASIS, [OFFSET_X, OFFSET_Y])))
    near(pivoted, applyBasisAbout(plain, PITCH_BASIS, OFFSET_X, OFFSET_Y))
    const a = bboxOf(plain),
      b = bboxOf(pivoted)
    // Centre held (the quad is symmetric about the glyph position under this
    // basis to within the bearing offsets), height halved, width untouched.
    expect(b.maxY - b.minY).toBeCloseTo((a.maxY - a.minY) * 0.5, 3)
    expect(b.maxX - b.minX).toBeCloseTo(a.maxX - a.minX, 3)
    // And it stays put, unlike the pivot-less case above.
    expect(Math.abs((b.minY + b.maxY) / 2 - (a.minY + a.maxY) / 2)).toBeLessThan(6)
  })

  it('carries the off-diagonal terms too (a diagonal-only basis would hide a dropped term)', async () => {
    const ctx = await makeCtx()
    const plain = positions(capturedVerts(ctx, makeCurvedDraw()))
    const pivoted = positions(
      capturedVerts(ctx, makeCurvedDraw(PITCH_BEARING_BASIS, [OFFSET_X, OFFSET_Y])),
    )
    near(pivoted, applyBasisAbout(plain, PITCH_BEARING_BASIS, OFFSET_X, OFFSET_Y))
    // Non-vacuity: the pivoted result must differ from the anchor-pivoted one.
    const anchorPivoted = positions(capturedVerts(ctx, makeCurvedDraw(PITCH_BEARING_BASIS)))
    expect(pivoted[0]![0]).not.toBeCloseTo(anchorPivoted[0]![0], 1)
  })

  it('a pivot without a basis changes nothing (the field is inert on its own)', async () => {
    const ctx = await makeCtx()
    const plain = capturedVerts(ctx, makeCurvedDraw())
    const pivotOnly = capturedVerts(ctx, {
      ...makeCurvedDraw(),
      groundBasisPivot: [OFFSET_X, OFFSET_Y] as const,
    })
    expect(Array.from(pivotOnly)).toEqual(Array.from(plain))
  })
})
