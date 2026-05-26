// Standalone WebGPU pipeline for sprite icons.
//
// Vertex stage: screen-pixel quad → NDC, same convention as the SDF
// text-renderer. Fragment stage: straight texture sample with alpha
// blending for raster sprites; SDF sprites (sdf:true in sprite JSON)
// take an fwidth-based AA path identical to the text renderer and are
// tinted by the per-vertex `icon-color` (Plan §4, iter 138). One
// batch can freely mix raster and SDF quads — the per-vertex `sdf`
// flag selects the path in the fragment shader, so no pipeline split
// or draw-call partitioning is needed.
//
// Coordinate frame: anchor arrives already in physical pixels (the
// caller projects lon/lat → screen px before submitting). The vertex
// stage just converts viewport-px → NDC.

import { SpriteAtlasGPU } from './sprite-atlas-gpu'
import { emitIconWgsl } from '../shader-dsl/icon'
import type { SpriteInfo } from './sprite-atlas-host'

export interface IconDraw {
  /** Anchor in screen pixels (caller-projected). */
  anchorX: number
  anchorY: number
  /** Sprite descriptor from SpriteAtlasHost.get(). */
  sprite: SpriteInfo
  /** icon-size multiplier on the sprite's design size. 1.0 = native
   *  px. Mapbox default is 1.0 with the layer-level icon-size
   *  scaling on top. */
  sizeScale: number
  /** Optional per-icon rotation in radians (icon-rotate). */
  rotateRad?: number
  /** Anchor mode for the quad relative to (anchorX, anchorY):
   *    'center'  → quad centred on anchor (Mapbox default)
   *    'top' / 'bottom' / 'left' / 'right'        → edge-anchored
   *    'top-left' / 'top-right' / 'bottom-left' / 'bottom-right' →
   *                                                  corner-anchored
   *  Each mode offsets the TL corner accordingly. */
  anchor?: IconAnchor
  /** Mapbox `icon-opacity` 0..1 multiplier on fragment alpha. Default
   *  1 (no fade). Packed as a per-vertex attribute; one batch can mix
   *  multiple opacities across icons (different layers / per-feature
   *  expressions). Below 1/255 the fragment alpha drops below 8-bit
   *  precision — callers that filter near-zero icons save vertex
   *  bandwidth. */
  opacity?: number
  /** Mapbox `icon-color` — SDF tint, sRGB 0..1 per channel. Only
   *  applied when the sprite is SDF (`sprite.sdf === true`); raster
   *  sprites ignore it per the Mapbox spec (the bitmap already carries
   *  its own colour). Default white = identity for both paths. */
  tint?: [number, number, number]
}

export type IconAnchor =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

const VERTS_PER_QUAD = 6
// pos.x, pos.y, uv.x, uv.y, opacity, tint.r, tint.g, tint.b, sdf
const FLOATS_PER_VERT = 9
const FLOATS_PER_QUAD = VERTS_PER_QUAD * FLOATS_PER_VERT

// The icon shader (px→NDC quad + SDF/raster textured fragment) is EMITTED from
// the shader DSL: shader-dsl/icon.ts (emitIconWgsl), used at createShaderModule
// below. SDF sprites take an fwidth-based AA path; raster sprites a straight
// sample; the per-vertex `sdf` flag selects the path (one batch can mix both).

export class IconRenderer {
  private readonly device: GPUDevice
  private readonly atlas: SpriteAtlasGPU
  private readonly bgLayout: GPUBindGroupLayout
  private readonly pipeline: GPURenderPipeline
  private readonly uniformBuf: GPUBuffer
  private vertexBuf: GPUBuffer | null = null
  /** Last-frame vertex count. Public for the iter 533 diagnostic
   *  (IconStage.getLastDrawIconCount) — reading "did the screenshot
   *  frame actually submit icons" requires post-prepare visibility
   *  into the renderer's vertex buffer state. */
  vertexCount = 0
  /** Iter 534 — first vertex of the most recent setDraws() call,
   *  stashed for screen-position / UV inspection from the diagnostic
   *  API. Format: [pos_px_x, pos_px_y, u, v, opacity]. Null if no
   *  draw has been recorded yet. */
  firstVertexSample: [number, number, number, number, number] | null = null
  /** Iter 534 — last-known atlas dimensions captured at setDraws()
   *  time. Lets the diagnostic verify UV coords are sensible
   *  (sprite uses x=N/atlasW; if atlasW is 0 or wrong, UV collapses). */
  lastAtlasSize: { width: number; height: number } | null = null
  /** Iter 537 — bbox over ALL vertex positions in the most recent
   *  setDraws(). Lets the diagnostic answer "are all 28 quads at
   *  the same point (sentinel-stacked) or spread across the canvas
   *  as expected for line-placement?". */
  lastVertexBBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null
  /** Iter 538 — viewport dimensions passed to the last draw() call.
   *  If the vertex bbox covers only half the expected screen area,
   *  the smoking gun could be either (a) sparse feature dispatch or
   *  (b) viewport uniform doesn't match canvas physical size. This
   *  captures (b)'s ground truth. */
  lastDrawViewport: { width: number; height: number } | null = null
  /** iter-234 — reusable scratch Float32Array. Per-frame setDraws()
   *  used to allocate `new Float32Array(N × FLOATS_PER_QUAD)` every
   *  call (~24 KB / 500 icons), one of the dominant GC sources on
   *  mobile during dense icon scenes. Now grown-but-never-shrunk;
   *  same buffer reused across frames whose icon count stays
   *  below the high-water mark. */
  private vertexScratch: Float32Array | null = null
  /** iter-234 — 4-float reusable scratch for the per-draw viewport
   *  uniform write (see `draw()`). Constant size, allocated once. */
  private readonly uniformScratch = new Float32Array(4)
  /** iter-234 — gates the vertex bbox computation in setDraws. The
   *  diagnostic is only read by inspector / debug tooling, but the
   *  O(vertexCount) loop fires every frame regardless. Default
   *  false; flip via setBBoxDiagnostic(true) when the inspector
   *  panel actually consumes `lastVertexBBox`. */
  private bboxDiagnosticEnabled = false
  setBBoxDiagnostic(on: boolean): void { this.bboxDiagnosticEnabled = on }
  /** Bind group lazily built once the atlas texture exists, then held
   *  for the life of the renderer. `map.setSpriteUrl` only stores a
   *  URL for the not-yet-built stage — atlas hot-swap is NOT supported
   *  (URL is fixed for the session, see map.ts:setSpriteUrl). The only
   *  null reset lives in `destroy()`. Re-introducing hot-swap requires
   *  also nulling this here so the next render rebuilds against the
   *  new atlas texture. */
  private bindGroup: GPUBindGroup | null = null

  constructor(
    device: GPUDevice, atlas: SpriteAtlasGPU,
    presentationFormat: GPUTextureFormat, sampleCount: number = 1,
  ) {
    this.device = device
    this.atlas = atlas

    this.bgLayout = device.createBindGroupLayout({
      label: 'icon-renderer-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })

    const module = device.createShaderModule({ code: emitIconWgsl(), label: 'icon-shader' })
    this.pipeline = device.createRenderPipeline({
      label: 'icon-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: FLOATS_PER_VERT * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },  // pos_px
            { shaderLocation: 1, offset: 8, format: 'float32x2' },  // uv
            { shaderLocation: 2, offset: 16, format: 'float32' },   // opacity
            { shaderLocation: 3, offset: 20, format: 'float32x3' }, // tint rgb
            { shaderLocation: 4, offset: 32, format: 'float32' },   // sdf flag
          ],
        }],
      },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{
          format: presentationFormat,
          // Non-premultiplied source → standard alpha blend.
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: sampleCount },
    })

    this.uniformBuf = device.createBuffer({
      size: 16, // vec2 viewport + 2 floats pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'icon-uniform',
    })
  }

  /** Rebuild the vertex buffer from the supplied draws. Call once per
   *  frame from the render loop AFTER the atlas host has reached the
   *  loaded state — draws referencing not-yet-loaded sprites would
   *  produce undefined UVs. */
  setDraws(draws: IconDraw[]): void {
    if (draws.length === 0) { this.vertexCount = 0; this.firstVertexSample = null; return }
    const atlasSize = this.atlas.size()
    this.lastAtlasSize = { width: atlasSize.width, height: atlasSize.height }
    if (atlasSize.width === 0) { this.vertexCount = 0; this.firstVertexSample = null; return }

    // iter-234 — scratch-buffer pool. Grow-but-never-shrink; the
    // capacity tracks the high-water mark of icon count over the
    // session, but a frame with fewer icons uses a sub-range of
    // the existing buffer (writeBuffer copies only the prefix
    // we filled). Avoids the per-frame ~24 KB allocation that
    // dominated mobile GC during dense icon scenes.
    const need = draws.length * FLOATS_PER_QUAD
    if (this.vertexScratch === null || this.vertexScratch.length < need) {
      this.vertexScratch = new Float32Array(need)
    }
    const data = this.vertexScratch
    let off = 0

    for (const d of draws) {
      const designW = d.sprite.width / d.sprite.pixelRatio
      const designH = d.sprite.height / d.sprite.pixelRatio
      const drawW = designW * d.sizeScale
      const drawH = designH * d.sizeScale

      // Anchor offset — see IconAnchor docs above. We compute the
      // quad's TL corner relative to (anchorX, anchorY).
      const [ax, ay] = anchorOffset(d.anchor ?? 'center', drawW, drawH)
      const x0Raw = d.anchorX + ax
      const y0Raw = d.anchorY + ay

      // Pixel-snap when not rotated — same reasoning as text-renderer:
      // linear filtering of a sub-pixel quad origin produces fuzzy
      // edges. Rotated quads can't honour the grid.
      const rot = d.rotateRad ?? 0
      const snap = rot === 0
      const x0 = snap ? Math.round(x0Raw) : x0Raw
      const y0 = snap ? Math.round(y0Raw) : y0Raw
      const x1 = x0 + drawW
      const y1 = y0 + drawH

      const u0 = d.sprite.x / atlasSize.width
      const v0 = d.sprite.y / atlasSize.height
      const u1 = (d.sprite.x + d.sprite.width) / atlasSize.width
      const v1 = (d.sprite.y + d.sprite.height) / atlasSize.height

      // Optional rotation around the quad centre.
      let tlx = x0, tly = y0, blx = x0, bly = y1
      let brx = x1, bry = y1, trx = x1, try_ = y0
      if (rot !== 0) {
        const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5
        const c = Math.cos(rot), s = Math.sin(rot)
        const rotate = (x: number, y: number): [number, number] => {
          const dx = x - cx, dy = y - cy
          return [cx + dx * c - dy * s, cy + dx * s + dy * c]
        };
        [tlx, tly] = rotate(x0, y0)
        ;[blx, bly] = rotate(x0, y1)
        ;[brx, bry] = rotate(x1, y1)
        ;[trx, try_] = rotate(x1, y0)
      }

      // Per-icon opacity gets stamped onto every vertex of the quad —
      // the vertex shader passes it through as a varying so the
      // fragment can multiply the texture alpha. Default 1 keeps
      // the existing no-fade behaviour byte-for-byte.
      const op = d.opacity ?? 1
      // icon-color tint. Only meaningful for SDF sprites; raster
      // sprites carry sdf=0 and the fragment shader ignores the tint
      // for them. Default white = identity (matches the prior
      // untinted behaviour byte-for-byte for raster icons).
      const t = d.tint
      const tr = t ? t[0] : 1, tg = t ? t[1] : 1, tb = t ? t[2] : 1
      const sdf = d.sprite.sdf ? 1 : 0
      // Per-vertex: pos.xy, uv.xy, opacity, tint.rgb, sdf (9 floats).
      const W = (o: number, x: number, y: number, uu: number, vv: number): void => {
        data[o] = x; data[o + 1] = y; data[o + 2] = uu; data[o + 3] = vv
        data[o + 4] = op; data[o + 5] = tr; data[o + 6] = tg; data[o + 7] = tb
        data[o + 8] = sdf
      }
      // tri 1: TL, BL, BR
      W(off +  0, tlx, tly, u0, v0)
      W(off +  9, blx, bly, u0, v1)
      W(off + 18, brx, bry, u1, v1)
      // tri 2: TL, BR, TR
      W(off + 27, tlx, tly, u0, v0)
      W(off + 36, brx, bry, u1, v1)
      W(off + 45, trx, try_, u1, v0)
      off += FLOATS_PER_QUAD
    }

    this.vertexCount = draws.length * VERTS_PER_QUAD
    // iter-234 — `data` may be larger than this frame's payload
    // (scratch grow-but-never-shrink). The byte range we actually
    // wrote is `[0, need * 4)`.
    const needBytes = need * 4
    // Iter 534 diagnostic — stash the FIRST vertex (TL of quad 0).
    this.firstVertexSample = need >= 5
      ? [data[0]!, data[1]!, data[2]!, data[3]!, data[4]!]
      : null
    // Iter 537 — bbox over all written vertex positions. iter-234
    // gates the O(vertexCount) loop behind `bboxDiagnosticEnabled`
    // (default off) — runtime perf doesn't pay for an unread
    // diagnostic. Inspector panel flips the flag on when shown.
    if (this.bboxDiagnosticEnabled && need >= 2) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (let i = 0; i < need; i += FLOATS_PER_VERT) {
        const x = data[i]!, y = data[i + 1]!
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      this.lastVertexBBox = { minX, minY, maxX, maxY }
    } else {
      this.lastVertexBBox = null
    }
    // iter-234 — 1.5× growth hysteresis (mirror of the WebGPU
    // arena pattern). Pre-iter-234 each capacity overshoot
    // destroyed + re-created the buffer at exactly the needed
    // size, so a single icon-count jump (e.g. LOD transition)
    // could trigger N back-to-back reallocations. Growing
    // `max(needed, current × 1.5)` keeps the cumulative
    // reallocation count O(log N) instead of O(N).
    if (this.vertexBuf === null || this.vertexBuf.size < needBytes) {
      const prevSize = this.vertexBuf?.size ?? 0
      const grown = Math.max(needBytes, Math.ceil(prevSize * 1.5))
      this.vertexBuf?.destroy()
      this.vertexBuf = this.device.createBuffer({
        size: Math.max(1024, grown),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'icon-vertex',
      })
    }
    // iter-234 — writeBuffer only the filled prefix (`needBytes`),
    // not the whole scratch (which may be larger than this frame's
    // payload).
    this.device.queue.writeBuffer(this.vertexBuf, 0, data.buffer, data.byteOffset, needBytes)
  }

  /** Encode the icon draw call. Returns silently when nothing to draw
   *  or when the atlas hasn't loaded yet. */
  draw(pass: GPURenderPassEncoder, viewport: { width: number; height: number }): void {
    if (this.vertexCount === 0 || this.vertexBuf === null) return
    const tex = this.atlas.ensure()
    if (!tex) return
    if (!this.bindGroup) {
      this.bindGroup = this.device.createBindGroup({
        label: 'icon-bg',
        layout: this.bgLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuf } },
          { binding: 1, resource: tex.createView() },
          { binding: 2, resource: this.atlas.sampler },
        ],
      })
    }
    // iter-234 — reuse a pre-allocated 4-float scratch instead of
    // `new Float32Array([...])` per draw. The 16-byte alloc per
    // frame is dwarfed by the vertex scratch, but eliminating it
    // is free + completes the no-per-frame-alloc invariant.
    const u = this.uniformScratch
    u[0] = viewport.width; u[1] = viewport.height
    this.device.queue.writeBuffer(this.uniformBuf, 0, u.buffer)
    // Iter 538 — capture for the diagnostic.
    this.lastDrawViewport = { width: viewport.width, height: viewport.height }
    pass.setPipeline(this.pipeline)
    pass.setVertexBuffer(0, this.vertexBuf)
    pass.setBindGroup(0, this.bindGroup)
    pass.draw(this.vertexCount, 1, 0, 0)
  }

  destroy(): void {
    this.uniformBuf.destroy()
    this.vertexBuf?.destroy()
    this.bindGroup = null
  }
}

function anchorOffset(anchor: IconAnchor, w: number, h: number): [number, number] {
  switch (anchor) {
    case 'center':       return [-w * 0.5, -h * 0.5]
    case 'top':          return [-w * 0.5, 0]
    case 'bottom':       return [-w * 0.5, -h]
    case 'left':         return [0, -h * 0.5]
    case 'right':        return [-w, -h * 0.5]
    case 'top-left':     return [0, 0]
    case 'top-right':    return [-w, 0]
    case 'bottom-left':  return [0, -h]
    case 'bottom-right': return [-w, -h]
  }
}
