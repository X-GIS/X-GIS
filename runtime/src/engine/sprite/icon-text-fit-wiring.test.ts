// icon-text-fit: paired-bbox → quad dims wiring (GPU-free, fail-before).
//
// #777 cluster I-A stretches a shield/badge sprite to wrap its PAIRED label's
// shaped text bbox. The runtime has two hops, each pinned here:
//
//   A. IconStage.prepare() RESOLVES the fit: it reads the paired text bbox that
//      TextStage laid out this frame (pairKey → getPairFitBoxes, injected here via
//      setPairFitBoxes) and, per fitted axis, sets IconDraw.fit.w/h = bbox + the
//      per-side icon-text-fit-padding (× dpr). Asymmetric padding sets the centre
//      shift dx/dy. Absent fit / unknown pairKey → IconDraw.fit undefined (native).
//   B. IconRenderer.setDraws() APPLIES it: IconDraw.fit.w/h replace the native
//      drawW/drawH BEFORE anchorOffset, so the packed quad the GPU reads has the
//      fitted dimensions; no fit → native sprite dims (byte-identical default).
//
// Fail-before (A): comment out the fit-resolution block in icon-stage.ts prepare()
//   → IconDraw.fit stays undefined → the resolution assertions read undefined.
// Fail-before (B): replace `if (d.fit) { … }` in icon-renderer.ts setDraws with a
//   no-op → the quad packs the native 16-px width/height, not the fitted dims.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext, WebGpuDevice } from '@xgis/rhi-webgpu'
import { IconStage, IconRenderer, type IconDraw, ICON_FORMAT, type SpriteInfo } from '@xgis/map'
import { vertexField } from '@xgis/compiler'

// ── Part A: IconStage fit resolution (Object.create stub — no GPU) ──
//
// Mirrors icon-stage-padding.test.ts: drive the REAL IconStage.prepare() over a
// stub host + a spy renderer that captures the resolved IconDraw list.
type FitPad = [number, number, number, number]
function makeStage(dpr: number): { stage: IconStage; draws: IconDraw[] } {
  const stage = Object.create(IconStage.prototype) as IconStage
  const draws: IconDraw[] = []
  const s = stage as unknown as {
    pending: unknown[]
    _iconDump: null
    _iconDebugHook: null
    dpr: number
    droppedPairKeys: Set<string>
    pairFitBox: Map<string, { w: number; h: number }>
    missingIconNames: Set<string>
    dispatchedIconNames: Set<string>
    host: { get(n: string): unknown; getState(): { status: string } }
    renderer: { setDraws(d: IconDraw[]): void }
  }
  s.pending = []
  s._iconDump = null
  s._iconDebugHook = null
  s.dpr = dpr
  s.droppedPairKeys = new Set()
  s.pairFitBox = new Map()
  s.missingIconNames = new Set()
  s.dispatchedIconNames = new Set()
  // 20×10 design sprite (pixelRatio 1) — deliberately ≠ the injected bbox so a
  // fitted quad's dims can only come from the bbox, never the sprite.
  s.host = {
    get: () => ({ name: 'shield', x: 0, y: 0, width: 20, height: 10, pixelRatio: 1, sdf: false }),
    getState: () => ({ status: 'loaded' }),
  }
  s.renderer = {
    setDraws: (d) => {
      draws.length = 0
      draws.push(...d)
    },
  }
  return { stage, draws }
}

// Resolve one fit icon against an injected paired bbox; return its IconDraw.fit.
function resolveFit(
  bbox: { w: number; h: number } | undefined,
  fit: { mode: 'width' | 'height' | 'both'; pad: FitPad } | undefined,
  dpr = 1,
  pairKey: string | undefined = 'pk',
): IconDraw['fit'] {
  const { stage, draws } = makeStage(dpr)
  if (bbox) stage.setPairFitBoxes(new Map([['pk', bbox]]))
  stage.addIcon(100, 200, 'shield', { pairKey, fit })
  stage.prepare()
  return draws[0]?.fit
}

describe('IconStage resolves icon-text-fit → IconDraw.fit (#777 I-A)', () => {
  it('both: fit.w/h = bbox + padding both axes (dpr 1, symmetric pad)', () => {
    // RED before I-A: prepare() ignored `fit` → IconDraw.fit undefined.
    const f = resolveFit({ w: 40, h: 24 }, { mode: 'both', pad: [3, 3, 3, 3] })
    expect(f).toBeDefined()
    expect(f!.w).toBe(46) // 40 + (left 3 + right 3)
    expect(f!.h).toBe(30) // 24 + (top 3 + bottom 3)
    expect(f!.dx).toBe(0)
    expect(f!.dy).toBe(0)
  })

  it('both: zero padding fits the bbox exactly', () => {
    const f = resolveFit({ w: 40, h: 24 }, { mode: 'both', pad: [0, 0, 0, 0] })
    expect(f!.w).toBe(40)
    expect(f!.h).toBe(24)
  })

  it('width: only the horizontal axis is fitted (h stays native = undefined)', () => {
    const f = resolveFit({ w: 40, h: 24 }, { mode: 'width', pad: [0, 0, 0, 0] })
    expect(f!.w).toBe(40)
    expect(f!.h).toBeUndefined()
  })

  it('height: only the vertical axis is fitted (w stays native = undefined)', () => {
    const f = resolveFit({ w: 40, h: 24 }, { mode: 'height', pad: [0, 0, 0, 0] })
    expect(f!.w).toBeUndefined()
    expect(f!.h).toBe(24)
  })

  it('asymmetric padding shifts the fit-box centre by (right−left)/2, (bottom−top)/2', () => {
    // pad [t,r,b,l] = [0,10,0,0]: box grows only rightward → centre moves +5x.
    const f = resolveFit({ w: 40, h: 24 }, { mode: 'both', pad: [0, 10, 0, 0] })
    expect(f!.w).toBe(50) // 40 + (left 0 + right 10)
    expect(f!.dx).toBe(5) // (right 10 − left 0) / 2
    expect(f!.h).toBe(24) // top 0 + bottom 0
    expect(f!.dy).toBe(0)
  })

  it('padding is CSS-px → scaled by dpr (bbox is already physical px)', () => {
    const f = resolveFit({ w: 40, h: 24 }, { mode: 'both', pad: [1, 1, 1, 1] }, 2)
    expect(f!.w).toBe(44) // 40 + (1 + 1) × dpr 2
    expect(f!.h).toBe(28) // 24 + (1 + 1) × dpr 2
  })

  it('no paired bbox this frame (dropped / absent text) → fit undefined (native)', () => {
    expect(resolveFit(undefined, { mode: 'both', pad: [0, 0, 0, 0] })).toBeUndefined()
  })

  it('unknown pairKey → fit undefined (native)', () => {
    expect(
      resolveFit({ w: 40, h: 24 }, { mode: 'both', pad: [0, 0, 0, 0] }, 1, 'other'),
    ).toBeUndefined()
  })

  it('no fit spec (icon-text-fit none/absent) → fit undefined (byte-identical default)', () => {
    expect(resolveFit({ w: 40, h: 24 }, undefined)).toBeUndefined()
  })
})

// ── Part B: IconRenderer applies IconDraw.fit → packed quad dims (WebGPU stub) ──
//
// Mirrors icon-size-opacity-wiring.test.ts: drive the REAL IconRenderer.setDraws
// against the stub and read the uploaded per-vertex floats. Vertices: v0 = TL,
// v1 = BL, v2 = BR; width = v2.x − v0.x, height = v1.y − v0.y.
const FLOATS_PER_VERT = ICON_FORMAT.stride / 4 // 9
const PX_SLOT = vertexField(ICON_FORMAT, 'pos_px').offset / 4 // 0
const FLOATS_PER_QUAD = FLOATS_PER_VERT * 6 // 54
const VERTEX_BUF_BYTES = 1024
const SPRITE: SpriteInfo = {
  name: 'shield',
  x: 0,
  y: 0,
  width: 16,
  height: 16,
  pixelRatio: 1,
  sdf: false,
}
const DESIGN = SPRITE.width / SPRITE.pixelRatio // 16
const FAKE_ATLAS = { size: () => ({ width: 256, height: 256 }) }

let stub: StubInstallation
beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => stub.uninstall())

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

function capturedQuad(ctx: GPUContext, draw: IconDraw): Float32Array | undefined {
  const renderer = new IconRenderer(
    ctx.device,
    new WebGpuDevice(ctx.device),
    FAKE_ATLAS as never,
    ctx.format,
    1,
  )
  let quad: Float32Array | undefined
  const device = ctx.device as unknown as {
    queue: {
      writeBuffer: (buf: unknown, o: number, d: ArrayBufferView | ArrayBuffer, off?: number) => void
    }
  }
  device.queue.writeBuffer = (buf, _o, data, dataOff): void => {
    if ((buf as { size?: number })?.size !== VERTEX_BUF_BYTES) return
    const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
    const baseOff =
      data instanceof ArrayBuffer ? (dataOff ?? 0) : (data as ArrayBufferView).byteOffset
    quad = new Float32Array(ab, baseOff, FLOATS_PER_QUAD)
  }
  renderer.setDraws([draw])
  return quad
}

const BASE: IconDraw = { anchorX: 100, anchorY: 200, sprite: SPRITE, sizeScale: 1 }
const widthOf = (q: Float32Array): number =>
  q[2 * FLOATS_PER_VERT + PX_SLOT]! - q[0 * FLOATS_PER_VERT + PX_SLOT]!
const heightOf = (q: Float32Array): number =>
  q[1 * FLOATS_PER_VERT + PX_SLOT + 1]! - q[0 * FLOATS_PER_VERT + PX_SLOT + 1]!

describe('IconRenderer stretches the quad to IconDraw.fit (#777 I-A)', () => {
  it('fit both → quad dims = fit.w × fit.h (not the 16px native sprite)', async () => {
    const ctx = await makeCtx()
    const q = capturedQuad(ctx, { ...BASE, fit: { w: 40, h: 24, dx: 0, dy: 0 } })
    expect(q, 'icon vertex buffer should have been written').toBeTruthy()
    expect(widthOf(q!)).toBeCloseTo(40, 6)
    expect(heightOf(q!)).toBeCloseTo(24, 6)
  })

  it('fit width (h undefined) → quad width fitted, height stays native 16', async () => {
    const ctx = await makeCtx()
    const q = capturedQuad(ctx, { ...BASE, fit: { w: 40, dx: 0, dy: 0 } })
    expect(widthOf(q!)).toBeCloseTo(40, 6)
    expect(heightOf(q!)).toBeCloseTo(DESIGN, 6) // 16 — vertical axis untouched
  })

  it('no fit → native sprite dims (byte-identical default)', async () => {
    const ctx = await makeCtx()
    const q = capturedQuad(ctx, { ...BASE })
    expect(widthOf(q!)).toBeCloseTo(DESIGN, 6) // 16
    expect(heightOf(q!)).toBeCloseTo(DESIGN, 6) // 16 — negative control pins the fit dependence
  })

  it('asymmetric dx shifts the quad centre (TL.x moves by dx)', async () => {
    const ctx = await makeCtx()
    const centered = capturedQuad(ctx, { ...BASE, fit: { w: 40, h: 24, dx: 0, dy: 0 } })
    const shifted = capturedQuad(ctx, { ...BASE, fit: { w: 40, h: 24, dx: 5, dy: 0 } })
    const tlx = (q: Float32Array): number => q[0 * FLOATS_PER_VERT + PX_SLOT]!
    expect(tlx(shifted!) - tlx(centered!)).toBeCloseTo(5, 6)
  })
})
