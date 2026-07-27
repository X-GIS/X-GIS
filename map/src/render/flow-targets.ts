// ═══ IBFV flow-field ping-pong targets (#1333) ═══
//
// The two textures the flow advection reads from and writes to, alternating each frame
// (design: docs/plans/2026-07-27-grid-vector-field-flow-visualization.md §3.2.1). Mirrors
// HeatmapTargets' lifecycle — lazily allocated, recreated on a size change, self-healing
// across a device swap, destroyed with the map — with three differences that matter:
//
// 1. SIZED TO THE GRID, NOT THE CANVAS. The advection runs in the coverage's own raster, so
//    the history is camera-independent: panning and zooming do not disturb the animation, and
//    no screen→geo inverse is needed anywhere in the recursion. A resize of the WINDOW is
//    therefore NOT a reason to reallocate — only a change of coverage is.
//
// 2. PING-PONG, NOT TWO ROLES. `read` and `write` swap every step, because IBFV is a
//    recursive filter: this frame's output is next frame's history.
//
// 3. A FRESH PAIR MUST BE CLEARED BEFORE IT IS ADVECTED. This is the one correctness trap
//    a non-recursive pass does not have: a newly created texture's contents are undefined,
//    and a recursive filter does not wash that out — it FEEDS ON it, so uninitialized memory
//    would persist in the history indefinitely rather than being overwritten. `needsClear`
//    makes the obligation explicit instead of leaving it to whoever writes the pass.
//
// Built on the RHI seam (createTexture/createView), not the native WebGPU render-target
// path, because the whole coverage family already lives there (coverage-renderer.ts:262) —
// one path serving both backends rather than a native path plus a WebGL2 twin.

import type { RhiDevice, RhiTexture, RhiTextureView, RhiTextureFormat } from '@xgis/engine'

// ── Storage format, and why there are two ────────────────────────────────────────────────
// IBFV carries a scalar noise pattern in [0,1]; colour is applied when the field is DRAWN,
// not while it is advected. So the history needs one channel and modest precision — van Wijk's
// original ran on 8-bit framebuffers.
//
// r16float gives smoother trails (the per-frame decay multiply quantizes less), but rendering
// INTO a half-float attachment on WebGL2 requires EXT_color_buffer_float; without it the FBO
// is INCOMPLETE and every draw raises GL_INVALID_FRAMEBUFFER_OPERATION (rhi-webgl2.ts:628).
// rgba8unorm is core in both backends and needs no extension at all, so it is the floor that
// cannot fail.
//
// The predicate is DELIBERATELY conservative. The only capability the RHI exposes today is
// `caps.floatBlendTargets`, which is `EXT_color_buffer_float && EXT_float_blend`
// (rhi/src/rhi.ts:400) — but IBFV never blends into the target, so it needs only the first.
// Hardware with color-buffer-float and no float-blend therefore takes the 8-bit path
// needlessly. That is the SAFE direction of the error: such a machine still renders, just
// with slightly coarser trails, whereas guessing the other way would break it outright.
// Narrowing this wants a `floatRenderTargets` cap in the RHI; recorded rather than guessed,
// because this environment has no WebGL2 device to verify the narrower predicate against.

/** Preferred storage — smoother trails, needs float render targets. */
export const FLOW_FIELD_FORMAT = 'r16float' as const

/** Universal floor — core in both backends, no extension, cannot fail. */
export const FLOW_FIELD_FORMAT_FALLBACK = 'rgba8unorm' as const

/** Pick the storage format for the advection pair. `floatRenderTargets` should be
 *  `rhi.caps.floatBlendTargets` today (see the note above on why that is conservative). */
export function flowFieldFormat(floatRenderTargets: boolean): RhiTextureFormat {
  return floatRenderTargets ? FLOW_FIELD_FORMAT : FLOW_FIELD_FORMAT_FALLBACK
}

/** Ceiling on either dimension of the working pair. A regional S-100 cell is far under it
 *  (CBOFS is 596×433); a global grid (GFS wind, #1273) would otherwise allocate a pair far
 *  larger than any screen can show. The design names this a bounded local concern rather than
 *  an architectural one — this constant is where it is bounded. */
export const FLOW_MAX_DIM = 2048

/** Owns the advection ping-pong pair. Allocated ONLY when a flow layer exists, so a style
 *  without one allocates nothing and renders byte-identically. */
export class FlowTargets {
  private a: RhiTexture | null = null
  private b: RhiTexture | null = null
  private aView: RhiTextureView | null = null
  private bView: RhiTextureView | null = null
  /** false → `a` is the read side; true → `b` is. Flipped by `swap()`. */
  private flipped = false
  private width = 0
  private height = 0
  private device: RhiDevice | null = null
  private _needsClear = false
  private format: RhiTextureFormat = FLOW_FIELD_FORMAT_FALLBACK

  /** The format the pair was actually allocated with — r16float when the device can render
   *  into one, else the rgba8unorm floor. */
  get storageFormat(): RhiTextureFormat {
    return this.format
  }

  /** Size the pair was last allocated at — the GRID size (capped), not the canvas. */
  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /** The history side: what this step advects FROM. Null before `ensure`. */
  get readView(): RhiTextureView | null {
    return this.flipped ? this.bView : this.aView
  }

  /** The target side: what this step renders INTO. Null before `ensure`. */
  get writeView(): RhiTextureView | null {
    return this.flipped ? this.aView : this.bView
  }

  /** True when the pair was just (re)allocated and still holds undefined contents. The pass
   *  MUST clear both sides before the first advect and then call `markCleared()`; a recursive
   *  filter feeds on its history, so garbage seeded here never washes out. */
  get needsClear(): boolean {
    return this._needsClear
  }

  markCleared(): void {
    this._needsClear = false
  }

  /** Exchange the read and write sides — called once per advection step. */
  swap(): void {
    this.flipped = !this.flipped
  }

  /** Lazily (re)allocate the pair for a grid of `gridW × gridH`, capped at FLOW_MAX_DIM.
   *  No-op when the capped size is unchanged on the same device. Recreates on a coverage
   *  whose grid differs, or on a device swap. */
  ensure(rhi: RhiDevice, gridW: number, gridH: number, floatRenderTargets = false): void {
    const w = Math.max(1, Math.min(gridW, FLOW_MAX_DIM))
    const h = Math.max(1, Math.min(gridH, FLOW_MAX_DIM))
    const fmt = flowFieldFormat(floatRenderTargets)
    if (rhi !== this.device) {
      // A new device — the old textures died with the old one, so drop the handles WITHOUT
      // destroying them (destroying through a dead device is the #737 hazard) and let the
      // allocation below run fresh.
      this.device = rhi
      this.a = this.b = null
      this.aView = this.bView = null
      this.width = this.height = 0
    }
    if (this.a && this.width === w && this.height === h && this.format === fmt) return
    this.releaseTextures()
    this.format = fmt
    this.a = this.make(rhi, w, h, 'flow-field-a')
    this.b = this.make(rhi, w, h, 'flow-field-b')
    this.aView = rhi.createView(this.a)
    this.bView = rhi.createView(this.b)
    this.width = w
    this.height = h
    // Fresh textures hold undefined contents, and the advect step would fold that into the
    // history permanently. Re-arm the obligation on EVERY reallocation, not just the first.
    this._needsClear = true
    this.flipped = false
  }

  /** Drop the pair (scene swap / destroy). Safe to call repeatedly. */
  destroy(): void {
    this.releaseTextures()
    this.device = null
    this.width = this.height = 0
    this._needsClear = false
    this.flipped = false
  }

  private make(rhi: RhiDevice, w: number, h: number, label: string): RhiTexture {
    return rhi.createTexture({
      width: w,
      height: h,
      format: this.format,
      // `render` so a step can draw into it; `sample` so the NEXT step can read it as history.
      // Both sides need both, because they alternate roles every frame.
      usage: ['render', 'sample'],
      label,
    })
  }

  private releaseTextures(): void {
    if (this.a) this.device?.destroyTexture(this.a)
    if (this.b) this.device?.destroyTexture(this.b)
    this.a = this.b = null
    this.aView = this.bView = null
  }
}
