// ═══════════════════════════════════════════════════════════════════
// Text Renderer (Batch 1c-7)
// ═══════════════════════════════════════════════════════════════════
//
// Standalone WebGPU pipeline for SDF text. Consumes GlyphInfo[] from
// the atlas host plus an anchor (already projected to screen pixels
// by the caller) and emits one textured quad per glyph. Shader does
// SDF threshold + optional halo.
//
// Coordinate frame: screen pixels in, NDC out (vertex stage). The
// caller is responsible for converting (lon, lat) anchors → screen
// px before submitting; this renderer never touches projection.
//
// Single-page atlas only for now — `setAtlas` references page 0.
// Multi-page bind-group permutation lands when an actual map needs
// it (BMP-only Latin maps fit in one page comfortably).

import type { GlyphAtlasGPU } from './sdf/glyph-atlas-gpu'
import { FrameArena } from '@xgis/rhi-webgpu'
import { bumpAlloc } from '../__profile__/alloc-counter'
import type { TextDraw } from './text-renderer-types'
import { codePointIsIdeographic } from './text-wrap'
import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import type { RhiBuffer, RhiBindGroup, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { TextDraper, type TextSlice } from '../render/material/text-material'
import { vertexField } from '@xgis/compiler'
import { TEXT_FORMAT } from './text-vertex-format'
import { toVertexBufferLayout } from '@xgis/rhi-webgpu'

export type { TextDraw } from './text-renderer-types'

const VERTS_PER_GLYPH = 6 // two triangles
// Derived from the single-source TEXT_FORMAT spec so the packer cannot drift
// from the GPUVertexBufferLayout / text `vs` @location.
const FLOATS_PER_VERT = TEXT_FORMAT.stride / 4 // 4 (posX,posY,uvX,uvY)
const TEXT_PX_SLOT = vertexField(TEXT_FORMAT, 'pos_px').offset / 4 // 0 (x,y = 0,1)
const TEXT_UV_SLOT = vertexField(TEXT_FORMAT, 'uv').offset / 4 // 2 (u,v = 2,3)
const FLOATS_PER_GLYPH = VERTS_PER_GLYPH * FLOATS_PER_VERT

// Synthetic-oblique shear for the CJK/Hangul/Kana glyphs of an italic
// label. The italic glyph PBF ("Noto Sans Italic") serves ideographs
// UPRIGHT (Noto has no italic CJK face), so MapLibre slants them ~12°;
// tan(12°) ≈ 0.21. Latin glyphs carry a real italic in their SDF and
// are left untouched (see the ideographic-codepoint gate in setDraws).
const OBLIQUE_TAN = 0.21

/** Uniform buffer slot stride — 256 B safely exceeds every WebGPU
 *  device's minUniformBufferOffsetAlignment (typical = 256, lower
 *  bound = 64). The 64 B uniform pack lives at offset 0 within each
 *  256 B slot; remaining bytes are unused padding. */
const UNIFORM_STRIDE = 256
const UNIFORM_STRIDE_F32 = UNIFORM_STRIDE / 4

export class TextRenderer {
  /** The RHI seam (§4 batch-seam migration). One instance, reused for the text
   *  resources (uniform + vertex buffers + per-page bind groups) and the TextDraper.
   *  On WebGPU `createBuffer === device.createBuffer`, `createBindGroup ===
   *  device.createBindGroup`, `writeBuffer === queue.writeBuffer`, `destroyBuffer ===
   *  GPUBuffer.destroy()`, so the GPU command stream is unchanged. */
  private readonly rhi: RhiDevice
  private readonly atlas: GlyphAtlasGPU
  private readonly device: GPUDevice
  /** Native BGL, created LAZILY (#834 device retirement S6): its only
   *  consumer is TextDraper's WebGPU arm (the gl2 arm builds by-name
   *  entry-array groups) — the constructor must not touch the device. */
  private _bgl: GPUBindGroupLayout | null = null
  private uniformBuf: RhiBuffer
  private uniformBufCapacityBytes: number
  private vertexBuf: RhiBuffer | null = null
  private vertexBufCapacityBytes = 0
  private vertexCount = 0
  /** Per-draw stride into the vertex buffer + uniform slot index.
   *  `page` is the atlas page the slice's glyphs reference; a single
   *  TextDraw can split into multiple slices when its glyphs span
   *  pages (CJK-heavy maps). `dynamicOffset` (bytes) points at this
   *  slice's 64-B uniform pack inside the shared uniform buffer. */
  private drawSlices: Array<{
    first: number
    count: number
    uniforms: Float32Array
    page: number
    dynamicOffset: number
  }> = []
  /** Combined uniforms for all slices, laid out at UNIFORM_STRIDE
   *  intervals. Rebuilt per frame in setDraws; viewport patched in
   *  draw() before the single GPU upload. */
  private allUniforms: Float32Array | null = null
  /** iter-244 (Plan AAA B.2) — per-frame arena for the large vertex
   *  data buffer in `setDraws()`. The previous `new Float32Array(N)`
   *  allocated 100s of KB per frame (totalGlyphs × 12 floats × 4 B).
   *  Arena reuses the same backing ArrayBuffer across frames; only
   *  watermark moves. The view passed to `queue.writeBuffer` is
   *  copied into GPU memory synchronously, so the view's lifetime
   *  ends with setDraws() — safe to invalidate on next setDraws
   *  begin (next frame). */
  private readonly _frameArena = new FrameArena(256 * 1024)
  /** One bind group per atlas page, lazily built. The atlas only
   *  ever GROWS pages (no destroy in-flight), so cached entries stay
   *  valid across frames. Single-page maps populate just index 0
   *  and never see multi-page logic. Invalidated when uniformBuf is
   *  reallocated. */
  private bindGroupsByPage: RhiBindGroup[] = []

  // RHI Material path — the SOLE text draw path (§4 seam: the raw kill-switch
  // branch + the standalone native pipeline were deleted). Same per-slice draws
  // through the seam.
  private _textFmt!: GPUTextureFormat
  private _textSamples!: number
  private _textDraper?: TextDraper
  private ensureTextDraper(): void {
    if (this._textDraper) return
    const vbl = toVertexBufferLayout(TEXT_FORMAT)
    const vertexBuffers = [
      {
        stride: vbl.arrayStride,
        attributes: [...vbl.attributes].map((a) => ({
          location: a.shaderLocation,
          offset: a.offset,
          format: a.format as string,
        })),
      },
    ]
    this._textDraper = new TextDraper(
      this.rhi,
      this._textFmt,
      this._textSamples,
      // TextDraper wraps the native layout ONLY on its WebGPU arm; on webgl2
      // pass an inert placeholder so the lazy bgl() never touches the device
      // (#834 S6 — same pattern as LineRenderer.ensureLineDraper).
      this.rhi.backend === 'webgl2' ? (null as unknown as GPUBindGroupLayout) : this.bgl(),
      vertexBuffers,
    )
  }

  /** Lazy native BGL — see `_bgl`. WebGPU-arm consumers only. */
  private bgl(): GPUBindGroupLayout {
    return (this._bgl ??= this.device.createBindGroupLayout({
      label: 'text-renderer-bgl',
      entries: [
        // hasDynamicOffset lets every draw point at its own UNIFORM_STRIDE
        // slot inside the shared uniform buffer. Without this, all draws
        // share the same offset-0 slot and the LAST queue.writeBuffer
        // before submission "wins" for every draw — labels with multiple
        // distinct fill colors rendered with the last-submitted color
        // (water_name blue overwritten by city black).
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    }))
  }

  constructor(
    device: GPUDevice,
    rhi: RhiDevice,
    atlas: GlyphAtlasGPU,
    presentationFormat: GPUTextureFormat,
    sampleCount: number = 1,
  ) {
    this.rhi = rhi
    this.atlas = atlas
    this.device = device
    this._textFmt = presentationFormat
    this._textSamples = sampleCount

    // Initial capacity covers a single slot — grows on demand in setDraws().
    this.uniformBufCapacityBytes = UNIFORM_STRIDE
    // Uniform — UNIFORM|COPY_DST, byte-identical via bufUsage('uniform', writable:true).
    this.uniformBuf = this.rhi.createBuffer({
      size: this.uniformBufCapacityBytes,
      usage: 'uniform',
      writable: true,
      label: 'text-uniform',
    })
  }

  /** Rebuild the vertex buffer + uniform packs from the supplied
   *  draws. Call once per frame from the render loop AFTER the
   *  atlas's `flush()` (so dirty SDFs are uploaded). */
  setDraws(draws: TextDraw[]): void {
    if (draws.length === 0) {
      this.vertexCount = 0
      this.drawSlices = []
      return
    }

    let totalGlyphs = 0
    for (const d of draws) totalGlyphs += d.glyphs.length
    // iter-244 (Plan AAA B.2) — self-contained arena. Watermark
    // resets at the start of each setDraws call (which fires once
    // per frame). The view passed to `queue.writeBuffer` below is
    // synchronously copied to GPU memory by WebGPU; the view's
    // arena-backed lifetime ends here.
    this._frameArena.beginFrame()
    bumpAlloc('text-renderer.setDraws.data.FrameArena')
    const data = this._frameArena.allocF32(totalGlyphs * FLOATS_PER_GLYPH)
    this.drawSlices = []

    let glyphIdx = 0
    const pageSize = this.atlas.pageCount > 0 ? this.atlas.pageSizePx : 1 // never used when no glyphs, but keeps types happy

    for (const d of draws) {
      let penX = d.anchorX
      const baseY = d.anchorY
      const letterSpacingPx = d.letterSpacingPx ?? 0
      const offsets = d.glyphOffsets
      const perGlyphRot = d.glyphRotations
      const italicOblique = d.italic === true
      // iter-248 — pass arena so each per-draw uniform pack uses
      // the same backing buffer as the iter-244 vertex data.
      const uniforms = packUniforms(d, this._frameArena)
      // Track the page for the current sub-slice. A label spanning
      // pages flushes a slice each time the active page changes;
      // single-page maps emit exactly one slice per draw.
      let sliceFirst = glyphIdx * VERTS_PER_GLYPH
      let slicePage = d.glyphs.length > 0 ? d.glyphs[0]!.slot.page : 0
      let sliceGlyphCount = 0
      const flushSlice = () => {
        if (sliceGlyphCount === 0) return
        this.drawSlices.push({
          first: sliceFirst,
          count: sliceGlyphCount * VERTS_PER_GLYPH,
          uniforms,
          page: slicePage,
          // dynamicOffset assigned in the post-loop assembly so each
          // slice gets its own UNIFORM_STRIDE slot regardless of which
          // draw produced it.
          dynamicOffset: 0,
        })
      }
      // Whole-label rotation around (anchorX, anchorY). Used when
      // glyphRotations isn't set; one trig-pair beats stamping a
      // rotation matrix per quad.
      const rot = d.rotateRad ?? 0
      const cosR = Math.cos(rot),
        sinR = Math.sin(rot)
      const rotateXY = (x: number, y: number): [number, number] => {
        if (rot === 0) return [x, y]
        const dx = x - d.anchorX,
          dy = y - d.anchorY
        return [d.anchorX + dx * cosR - dy * sinR, d.anchorY + dx * sinR + dy * cosR]
      }
      for (let gi = 0; gi < d.glyphs.length; gi++) {
        const g = d.glyphs[gi]!
        // Hard newline (cp 10) is a segment break, NOT a drawable glyph.
        // wrapWithKnuthPlass splits lines on it (text-stage.ts:415) so it
        // sits in NO line range → the composition loop never writes its
        // glyphOffsets slot. Drawing it here would stamp a quad at the
        // stale (unwritten) offset = a ghost glyph at a previous label's
        // position. Skip it so only positioned glyphs reach the buffer.
        if (g.codepoint === 10) continue
        // Page boundary: flush the current slice and start a new one
        // pointing at this glyph's page.
        if (g.slot.page !== slicePage) {
          if (sliceGlyphCount > 0) {
            // Mid-label boundary: close the open slice, start a new one
            // pointing at this glyph's page.
            flushSlice()
            sliceFirst = glyphIdx * VERTS_PER_GLYPH
            sliceGlyphCount = 0
          }
          // Adopt this glyph's page for the (re)opening slice. When
          // sliceGlyphCount === 0 nothing is written yet, so this also
          // corrects a stale seed (slicePage was initialised from
          // glyphs[0], which may be a skipped leading newline on a
          // different page than the first drawable glyph — binding the
          // wrong atlas page → wrong/blank glyph).
          slicePage = g.slot.page
        }
        // Per-glyph slot→display scale. PBF glyphs are baked at their
        // 24-px native reference, local Hangul at the DPR-scaled
        // raster; a bilingual label mixes both in one draw, so the
        // factor is per-glyph (g.rasterFontSize), not per-draw.
        const scale = d.fontSize / (g.rasterFontSize ?? d.rasterFontSize)
        const slotSize = g.slot.size
        const drawW = slotSize * scale
        const drawH = slotSize * scale
        // When per-glyph offsets are supplied, anchor is at
        // (anchorX + dx, anchorY + dy); pen-advance loop is bypassed.
        const baseX = offsets ? d.anchorX + offsets[gi * 2]! : penX
        const baseY2 = offsets ? d.anchorY + offsets[gi * 2 + 1]! : baseY
        // Iter 118: sub-pixel quad positioning matches MapLibre's
        // a_offset/32 sub-pixel-precision vertex offsets. Pre-iter-118
        // pixel-snapped axis-aligned quad TL to fight per-glyph
        // thickness jitter, but that jitter was a symptom of the
        // SDF byte-slope mismatch (iter 114) + halo AA underspread
        // (iter 117). With those upstream issues fixed the snap is no
        // longer needed AND was the dominant remaining contributor to
        // user-reported "Seoul l 너무 얇음" / "Seongnam 가시성 나쁨":
        // integer snap forced each glyph onto the px grid → glyph
        // edges hit systematically-offset alpha samples → narrow
        // strokes (like the lowercase "l" or Hangul vertical jamo
        // strokes) randomly thinned by ~1/2 px depending on quad
        // origin parity.
        const x0 = baseX + g.bearingX * scale - (drawW - g.width * scale) * 0.5
        const y0 = baseY2 - g.bearingY * scale - (drawH - g.height * scale) * 0.5
        const x1 = x0 + drawW
        const y1 = y0 + drawH
        // Synthetic oblique (italic) for CJK/Hangul/Kana glyphs: shear x by
        // each corner's distance above the baseline (baseY2). Latin glyphs
        // get real italic from the font (PBF SDF already slanted); the italic
        // glyph PBF serves CJK UPRIGHT, so MapLibre obliques them — gate on
        // the ideographic codepoint, not the glyph source.
        const shear = italicOblique && codePointIsIdeographic(g.codepoint) ? OBLIQUE_TAN : 0
        const shTop = shear * (baseY2 - y0)
        const shBot = shear * (baseY2 - y1)
        const u0 = g.slot.pxX / pageSize
        const v0 = g.slot.pxY / pageSize
        const u1 = (g.slot.pxX + slotSize) / pageSize
        const v1 = (g.slot.pxY + slotSize) / pageSize
        // 4 quad corners. Rotation strategy:
        //   - Per-glyph (glyphRotations set): rotate each quad
        //     around its OWN centre by the per-glyph radian. Used
        //     for text-along-curve where neighbouring glyphs face
        //     different tangents.
        //   - Whole-label (rotateRad / 0): rotate around the label
        //     anchor — single trig pair, computed above.
        let tlx: number, tly: number, blx: number, bly: number
        let brx: number, bry: number, trx: number, try_: number
        if (perGlyphRot !== undefined) {
          const gRot = perGlyphRot[gi] ?? 0
          const gcx = (x0 + x1) * 0.5 + (shTop + shBot) * 0.5,
            gcy = (y0 + y1) * 0.5
          const c = Math.cos(gRot),
            s = Math.sin(gRot)
          const rotateGlyph = (x: number, y: number): [number, number] => {
            const ddx = x - gcx,
              ddy = y - gcy
            return [gcx + ddx * c - ddy * s, gcy + ddx * s + ddy * c]
          }
          ;[tlx, tly] = rotateGlyph(x0 + shTop, y0)
          ;[blx, bly] = rotateGlyph(x0 + shBot, y1)
          ;[brx, bry] = rotateGlyph(x1 + shBot, y1)
          ;[trx, try_] = rotateGlyph(x1 + shTop, y0)
        } else {
          ;[tlx, tly] = rotateXY(x0 + shTop, y0)
          ;[blx, bly] = rotateXY(x0 + shBot, y1)
          ;[brx, bry] = rotateXY(x1 + shBot, y1)
          ;[trx, try_] = rotateXY(x1 + shTop, y0)
        }

        const off = glyphIdx * FLOATS_PER_GLYPH
        // Write one vertex at quad-corner v using spec-derived slots.
        const W = (v: number, x: number, y: number, uu: number, vv: number): void => {
          const o = off + v * FLOATS_PER_VERT
          data[o + TEXT_PX_SLOT] = x
          data[o + TEXT_PX_SLOT + 1] = y
          data[o + TEXT_UV_SLOT] = uu
          data[o + TEXT_UV_SLOT + 1] = vv
        }
        // tri 1: TL, BL, BR
        W(0, tlx, tly, u0, v0)
        W(1, blx, bly, u0, v1)
        W(2, brx, bry, u1, v1)
        // tri 2: TL, BR, TR
        W(3, tlx, tly, u0, v0)
        W(4, brx, bry, u1, v1)
        W(5, trx, try_, u1, v0)

        if (!offsets) {
          penX += g.advanceWidth * scale
          if (gi < d.glyphs.length - 1) penX += letterSpacingPx
        }
        glyphIdx += 1
        sliceGlyphCount += 1
      }
      flushSlice()
    }

    this.vertexCount = totalGlyphs * VERTS_PER_GLYPH
    // vertexBufCapacityBytes tracks the allocated size (was GPUBuffer.size; an
    // opaque RhiBuffer exposes none). Reallocation condition is byte-identical.
    if (this.vertexBuf === null || this.vertexBufCapacityBytes < data.byteLength) {
      if (this.vertexBuf !== null) this.rhi.destroyBuffer(this.vertexBuf)
      const size = Math.max(1024, data.byteLength)
      // Vertex — VERTEX|COPY_DST, byte-identical via bufUsage('vertex', writable:true).
      this.vertexBuf = this.rhi.createBuffer({
        size,
        usage: 'vertex',
        writable: true,
        label: 'text-vertex',
      })
      this.vertexBufCapacityBytes = size
    }
    // `data` is an arena-backed view; writeBuffer copies its bytes — byte-identical
    // to the prior (data.buffer, data.byteOffset, data.byteLength) sub-range form.
    this.rhi.writeBuffer(this.vertexBuf, 0, data)

    // ── Assemble shared uniform array indexed by dynamic offset ──
    // Pack each slice's 64-byte uniform block into its own UNIFORM_STRIDE
    // slot. Viewport (slots 0,1) is patched in draw() to keep that
    // hot-path branchless w.r.t. resize events.
    const numSlices = this.drawSlices.length
    if (numSlices === 0) {
      this.allUniforms = null
    } else {
      const totalBytes = numSlices * UNIFORM_STRIDE
      if (this.allUniforms === null || this.allUniforms.length < numSlices * UNIFORM_STRIDE_F32) {
        this.allUniforms = new Float32Array(numSlices * UNIFORM_STRIDE_F32)
      }
      for (let i = 0; i < numSlices; i++) {
        const slice = this.drawSlices[i]!
        const base = i * UNIFORM_STRIDE_F32
        // Copy the 16-float uniform pack (64 B) into slot i.
        for (let j = 0; j < UNIFORM_BYTES / 4; j++) {
          this.allUniforms[base + j] = slice.uniforms[j]!
        }
        slice.dynamicOffset = i * UNIFORM_STRIDE
      }
      // Grow uniformBuf if needed; invalidate bind groups since they
      // reference the buffer instance.
      if (totalBytes > this.uniformBufCapacityBytes) {
        this.rhi.destroyBuffer(this.uniformBuf)
        this.uniformBufCapacityBytes = Math.max(totalBytes, this.uniformBufCapacityBytes * 2)
        this.uniformBuf = this.rhi.createBuffer({
          size: this.uniformBufCapacityBytes,
          usage: 'uniform',
          writable: true,
          label: 'text-uniform',
        })
        this.bindGroupsByPage.length = 0
      }
    }
  }

  /** Encode draw commands. `viewport` is in physical pixels. */
  draw(
    pass: GPURenderPassEncoder | RhiRenderPass,
    viewport: { width: number; height: number },
  ): void {
    const _tst = ((globalThis as Record<string, unknown>).__xgisLabelsRhi ??= {}) as Record<
      string,
      number
    >
    _tst.drawCalls = (_tst.drawCalls ?? 0) + 1
    _tst.vertexCount = this.vertexCount
    _tst.drawSlices = this.drawSlices.length
    if (this.vertexCount === 0 || this.vertexBuf === null) return
    if (this.atlas.pageCount === 0) return // no glyphs uploaded yet

    if (this.allUniforms === null) return

    // Patch viewport (slots 0,1) into every slice slot. The remaining
    // 14 floats per slot were filled by setDraws and don't change here.
    const numSlices = this.drawSlices.length
    for (let i = 0; i < numSlices; i++) {
      const base = i * UNIFORM_STRIDE_F32
      this.allUniforms[base + 0] = viewport.width
      this.allUniforms[base + 1] = viewport.height
    }
    // Single GPU upload — covers all slices' uniforms. Critical: prior
    // implementation called writeBuffer per slice at offset 0, but
    // WebGPU executes ALL queued writes before any draw within a
    // submit, so the LAST write would dominate every draw. The subarray
    // bounds the write to the active slices (allUniforms may be larger
    // from a previous frame) — byte-identical to the prior
    // (buffer, byteOffset, numSlices*UNIFORM_STRIDE) sub-range form.
    this.rhi.writeBuffer(
      this.uniformBuf,
      0,
      this.allUniforms.subarray(0, numSlices * UNIFORM_STRIDE_F32),
    )

    // The SDF text draw routes through the RHI Material seam (TextDraper) — the SOLE
    // path. Collect per-slice draw items + issue them via the generic seam.
    const rhiSlices: TextSlice[] = []
    for (const slice of this.drawSlices) {
      const page = this.atlas.getPage(slice.page)
      if (!page) continue // page evicted between flush and draw — skip
      let bg = this.bindGroupsByPage[slice.page]
      if (!bg) {
        // Fully RHI-native since #834 M5 slice 3: the atlas hands back RHI
        // view/sampler handles, and the layout is the TextDraper Material's
        // OWN group 0 (on WebGPU that IS the wrapped bgLayout passed at
        // construction — byte-identical; on WebGl2Device it is the by-name
        // entry-array layout).
        this.ensureTextDraper()
        bg = this.rhi.createBindGroup(this._textDraper!.layoutRhi(), [
          // Use minBindingSize-sized window (64 B) into the shared
          // uniform buffer. The dynamic offset picks which slice's
          // pack is visible to the draw.
          { binding: 0, resource: { buffer: this.uniformBuf, offset: 0, size: UNIFORM_BYTES } },
          { binding: 1, resource: { view: this.atlas.pageView(slice.page)! } },
          { binding: 2, resource: { sampler: this.atlas.sampler } },
        ])
        this.bindGroupsByPage[slice.page] = bg
      }
      rhiSlices.push({
        bg,
        dynamicOffset: slice.dynamicOffset,
        count: slice.count,
        first: slice.first,
      })
    }

    if (rhiSlices.length > 0) {
      this.ensureTextDraper()
      // A WebGl2Device frame hands in an RhiRenderPass already (#834 M5 s3).
      this._textDraper!.draw(
        this.rhi.backend === 'webgl2'
          ? (pass as RhiRenderPass)
          : wrapWebGpuPass(pass as GPURenderPassEncoder),
        this.vertexBuf!,
        rhiSlices,
      )
    }
  }

  destroy(): void {
    this.rhi.destroyBuffer(this.uniformBuf)
    if (this.vertexBuf) this.rhi.destroyBuffer(this.vertexBuf)
    this.bindGroupsByPage.length = 0
  }
}

// ─── Uniform packing ─────────────────────────────────────────────
//
// Layout (std140-friendly, 64 bytes total):
//   vec2 viewport          (8 B,  pad to 16)
//   vec4 fill_color        (16 B)
//   vec4 halo_color        (16 B)
//   f32  halo_width        (4 B)
//   f32  edge_softness     (4 B)
//   f32 _pad0, _pad1       (8 B)
const UNIFORM_BYTES = 64

export function packUniformsForTesting(d: TextDraw): Float32Array {
  return packUniforms(d)
}

// iter-248 (Plan AAA B.2) — optional FrameArena for the 16-float
// uniform pack. setDraws calls this per-draw (~300 / frame on
// Bright z=14); test seam passes undefined to keep the legacy
// fresh-heap allocation path.
function packUniforms(d: TextDraw, arena?: FrameArena): Float32Array {
  const buf =
    arena !== undefined ? arena.allocF32(UNIFORM_BYTES / 4) : new Float32Array(UNIFORM_BYTES / 4)
  // viewport (slots 0,1) — written by draw()
  buf[2] = 0
  buf[3] = 0 // viewport pad
  buf[4] = d.color[0]
  buf[5] = d.color[1]
  buf[6] = d.color[2]
  buf[7] = d.color[3]
  if (d.halo) {
    buf[8] = d.halo.color[0]
    buf[9] = d.halo.color[1]
    buf[10] = d.halo.color[2]
    buf[11] = d.halo.color[3]
    // MapLibre-derived halo math. The previous formula computed
    // halo_width / halo_blur in slot-pixel distance units which
    // produced a halo ~3× narrower and ~5× harder than MapLibre on
    // the same PBF data — visible as "할로 거의 안 보임" on Bright
    // z=4.7 country labels even though halo_color was reaching the
    // shader correctly.
    //
    // MapLibre's symbol_sdf.fragment.glsl normalises halo_width
    // against fontScale_CSS = sizePx_CSS / 24:
    //
    //   halo_edge = (6 - halo_width_CSS / fontScale_CSS) / 8
    //
    // The DPR factors cancel when we substitute *_CSS = *_phys / DPR
    // and sizePx_CSS = d.fontSize / DPR:
    //
    //   halo_width_norm = halo_width_phys × 3 / sizePx_phys
    //                                       └── 24/8 = 3
    //
    // Net effect at Bright z=4.7 country label (size=32 phys,
    // halo_width=2 phys): halo_width_norm 0.061 → 0.188 (3.1× wider),
    // matching MapLibre's render on the same PBF input. halo_blur
    // shares the same px→SDF factor (see the buf[13] note below).
    // The `·3` constant (= ONE_EM/SDF_PX = 24/8) is the MapLibre /
    // PBF / TinySDF convention: 255-per-radius byte slope, edge byte
    // 192. Iter 114 unified computeSDF (local CJK / Hangul / icons)
    // onto this same encoding so a single haloK works for every glyph
    // source. Pre-iter-114 local glyphs used 63-per-`sdfRadius` slope
    // (~4× shallower) which made shader AA cover ~4 px of edge instead
    // of ~1 px — the user-reported Hangul stroke unevenness.
    void d.glyphs // source attribution no longer affects halo math
    const haloK = 3
    // px → normalised-SDF conversion. haloK/fontSize maps one physical
    // pixel of edge distance into the [0,1] SDF byte space for THIS
    // draw's glyph source (PBF 255-per-radius vs computeSDF 63-per-
    // sdfRadius — see haloK above). Both halo_width and halo_blur are
    // distances in that same space, so both scale by the same factor.
    const pxToSdf = haloK / d.fontSize
    buf[12] = d.halo.width * pxToSdf
    // halo_blur was previously normalised with the PBF-only constant
    // `·24/fontSize` plus a baked `+0.105` EDGE_GAMMA term, regardless
    // of glyph source. That left commit #130's source-aware width fix
    // half-applied: locally-rasterised Hangul/CJK labels (4× shallower
    // SDF slope) got a blur ~4× too wide — the user-reported heavy
    // white glow on OFM Bright Korean place labels at z≈5, which also
    // made the dark fill read as too thin against the glow.
    //
    // Now blur uses the same source-aware pxToSdf as width. The 1.19
    // factor is MapLibre's symbol_sdf blur-spread constant (kept so
    // authored-blur magnitude on PBF stays MapLibre-equivalent:
    // 1.19·3 ≈ old 0.149·24). The EDGE_GAMMA base is dropped — the
    // fragment shader already floors halo AA at the fwidth-derived
    // `soft` via `aa_halo = max(u.halo_blur, soft)`, so re-adding a
    // fixed gamma double-counted AA and over-blurred every halo
    // (worst on the shallow local SDF) even when the style authored
    // blur = 0.
    buf[13] = (d.halo.blur ?? 0) * 1.19 * pxToSdf
  } else {
    buf[8] = 0
    buf[9] = 0
    buf[10] = 0
    buf[11] = 0
    buf[12] = 0
    buf[13] = 0
  }
  // Iter 110: font_size_px (physical pixels) drives MapLibre-exact
  // AA half-width in the fragment shader (soft = 2.52 / font_size_px).
  buf[14] = d.fontSize
  buf[15] = 0
  return buf
}
