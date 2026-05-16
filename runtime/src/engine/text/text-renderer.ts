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

import type { GlyphInfo } from './sdf/glyph-atlas-host'
import type { GlyphAtlasGPU } from './sdf/glyph-atlas-gpu'

export interface TextDraw {
  /** Anchor in screen pixels — caller projects from (lon, lat). */
  anchorX: number
  anchorY: number
  /** Per-codepoint info from `GlyphAtlasHost.ensureString`. Pen
   *  walks left-to-right starting at anchor. */
  glyphs: GlyphInfo[]
  /** Display size in pixels. Atlas was rasterised at a fixed size;
   *  the shader scales via SDF threshold + quad dimensions. */
  fontSize: number
  /** Atlas rasterisation size (the `fontSize` GlyphAtlasHost was
   *  configured with). Needed at draw time to scale glyph metrics. */
  rasterFontSize: number
  /** RGBA fill colour (0–1 each channel). */
  color: [number, number, number, number]
  /** Optional halo. `width` is in display pixels; `color` is RGBA;
   *  `blur` is the SDF feathering width in display pixels (Mapbox
   *  `text-halo-blur`) — extra smoothstep band on top of the
   *  derivative-AA edge for a soft-glow halo. */
  halo?: { color: [number, number, number, number]; width: number; blur?: number }
  /** Extra pixels between adjacent glyphs (Mapbox text-letter-spacing
   *  in em-units already converted to px by the caller). Applied
   *  AFTER each glyph except the last. */
  letterSpacingPx?: number
  /** Rotation in radians around the (anchorX, anchorY) point.
   *  Mapbox text-rotate is degrees clockwise — caller converts. */
  rotateRad?: number
  /** Optional per-glyph (dx, dy) offsets from (anchorX, anchorY).
   *  When set, the renderer positions each glyph at
   *  (anchorX + offsets[2i], anchorY + offsets[2i+1]) and SKIPS
   *  the pen-advance loop — used by the multiline layout path
   *  in TextStage where line wrapping + justify happens CPU-side
   *  before vertex generation. */
  glyphOffsets?: Float32Array
  /** SDF falloff radius the atlas was rasterised with (px). Used
   *  to convert halo-width-in-px into the SDF byte-space threshold
   *  the shader expects. When unset, falls back to the historical
   *  6-px assumption to preserve old call sites. */
  sdfRadius?: number
  /** Per-glyph rotation (radians, screen-space CW). When set, each
   *  glyph quad rotates around its OWN centre instead of around the
   *  label anchor — required for text-along-curve where neighbouring
   *  glyphs face slightly different tangents. Length must match
   *  glyphs.length; pairs naturally with `glyphOffsets` (which
   *  positions each glyph at its sample point). When set, `rotateRad`
   *  is ignored. */
  glyphRotations?: Float32Array
}

const VERTS_PER_GLYPH = 6  // two triangles
const FLOATS_PER_VERT = 4  // posX, posY, uvX, uvY
const FLOATS_PER_GLYPH = VERTS_PER_GLYPH * FLOATS_PER_VERT

const TEXT_SHADER_WGSL = /* wgsl */ `
struct Uniforms {
  viewport: vec2<f32>,
  fill_color: vec4<f32>,
  halo_color: vec4<f32>,
  halo_width: f32,         // 0 = no halo (SDF-byte units, [0,1])
  halo_blur: f32,          // additional smoothstep half-width for halo
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas_tex: texture_2d<f32>;
@group(0) @binding(2) var atlas_smp: sampler;

struct VsOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex fn vs(
  @location(0) pos_px: vec2<f32>,
  @location(1) uv: vec2<f32>,
) -> VsOut {
  let ndc_x = (pos_px.x / u.viewport.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (pos_px.y / u.viewport.y) * 2.0;
  return VsOut(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0), uv);
}

@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let sdf: f32 = textureSample(atlas_tex, atlas_smp, in.uv).r;
  let edge: f32 = 192.0 / 255.0;

  // Adaptive AA: derive smoothstep half-width from the SDF's
  // screen-space derivative. fwidth() returns |dF/dx|+|dF/dy|, the
  // pixel-rate of change; using 0.7 * fwidth gives a ~1.4 px
  // crossfade band that stays sharp across any display scale —
  // small text, large text, mid-zoom interpolation all alias-free.
  // Floor avoids div-by-zero on perfectly flat samples.
  let soft: f32 = max(0.7 * fwidth(sdf), 1.0 / 255.0);

  // Fill mask
  let fill_a: f32 = smoothstep(edge - soft, edge + soft, sdf);

  // Halo: extends halo_width SDF-byte units outward from the edge.
  // halo_width is pre-converted from px to SDF-byte space by the
  // renderer (which knows the rasterisation sdfRadius).
  if (u.halo_width <= 0.0) {
    return vec4<f32>(u.fill_color.rgb, u.fill_color.a * fill_a);
  }

  // Halo: TWO smoothsteps combined via min() — matches MapLibre's
  // symbol_sdf.fragment.glsl. The previous implementation used a
  // single smoothstep centred on halo_edge, which never produced a
  // solid halo band when (halo_blur + soft) ≥ halo_width / 2 — the
  // typical case for 1px halos on light backgrounds (Positron city
  // labels). Result: halos at <=50% opacity everywhere outside the
  // glyph, visually invisible against near-white tiles.
  //
  // The MapLibre formula:
  //   outer = smoothstep(halo_edge - aa, halo_edge + aa, sdf)  // fade IN
  //   inner = smoothstep(inner_edge_halo - aa,                 // fade OUT
  //                       inner_edge_halo + aa, sdf)
  //   halo  = min(outer, 1 - inner)
  // produces a flat-top "table" — solid 1.0 between the two
  // transitions, feathered edges. inner_edge_halo sits just past the
  // glyph edge so the halo flat-tops up to and including the visible
  // boundary; the (1 - fill_w) composite factor below still masks
  // the portion that overlaps the fill.
  let halo_edge: f32 = edge - u.halo_width;
  // halo_blur is now MapLibre's gamma_halo (already includes the
  // per-DPR EDGE_GAMMA AA constant). Don't add soft on top — that
  // would double-count the AA term and over-blur every halo.
  let aa_halo: f32 = max(u.halo_blur, soft);
  let inner_edge_halo: f32 = edge + aa_halo;
  let outer_a: f32 = smoothstep(halo_edge - aa_halo, halo_edge + aa_halo, sdf);
  let inner_a: f32 = smoothstep(inner_edge_halo - aa_halo, inner_edge_halo + aa_halo, sdf);
  let halo_a: f32 = min(outer_a, 1.0 - inner_a);
  // Composite: halo behind, fill in front. (1 - fill_w) factor lets
  // a partially-transparent text-fill show the halo through it.
  let fill_w = u.fill_color.a * fill_a;
  let halo_w = u.halo_color.a * halo_a * (1.0 - fill_w);
  return vec4<f32>(u.fill_color.rgb * fill_w + u.halo_color.rgb * halo_w, fill_w + halo_w);
}
`

/** Uniform buffer slot stride — 256 B safely exceeds every WebGPU
 *  device's minUniformBufferOffsetAlignment (typical = 256, lower
 *  bound = 64). The 64 B uniform pack lives at offset 0 within each
 *  256 B slot; remaining bytes are unused padding. */
const UNIFORM_STRIDE = 256
const UNIFORM_STRIDE_F32 = UNIFORM_STRIDE / 4

export class TextRenderer {
  private readonly device: GPUDevice
  private readonly atlas: GlyphAtlasGPU
  private readonly bgLayout: GPUBindGroupLayout
  private readonly pipeline: GPURenderPipeline
  private uniformBuf: GPUBuffer
  private uniformBufCapacityBytes: number
  private vertexBuf: GPUBuffer | null = null
  private vertexCount = 0
  /** Per-draw stride into the vertex buffer + uniform slot index.
   *  `page` is the atlas page the slice's glyphs reference; a single
   *  TextDraw can split into multiple slices when its glyphs span
   *  pages (CJK-heavy maps). `dynamicOffset` (bytes) points at this
   *  slice's 64-B uniform pack inside the shared uniform buffer. */
  private drawSlices: Array<{ first: number; count: number; uniforms: Float32Array; page: number; dynamicOffset: number }> = []
  /** Combined uniforms for all slices, laid out at UNIFORM_STRIDE
   *  intervals. Rebuilt per frame in setDraws; viewport patched in
   *  draw() before the single GPU upload. */
  private allUniforms: Float32Array | null = null
  /** One bind group per atlas page, lazily built. The atlas only
   *  ever GROWS pages (no destroy in-flight), so cached entries stay
   *  valid across frames. Single-page maps populate just index 0
   *  and never see multi-page logic. Invalidated when uniformBuf is
   *  reallocated. */
  private bindGroupsByPage: GPUBindGroup[] = []

  constructor(
    device: GPUDevice, atlas: GlyphAtlasGPU, presentationFormat: GPUTextureFormat,
    sampleCount: number = 1,
  ) {
    this.device = device
    this.atlas = atlas

    this.bgLayout = device.createBindGroupLayout({
      label: 'text-renderer-bgl',
      entries: [
        // hasDynamicOffset lets every draw point at its own UNIFORM_STRIDE
        // slot inside the shared uniform buffer. Without this, all draws
        // share the same offset-0 slot and the LAST queue.writeBuffer
        // before submission "wins" for every draw — labels with multiple
        // distinct fill colors rendered with the last-submitted color
        // (water_name blue overwritten by city black).
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })

    const module = device.createShaderModule({ code: TEXT_SHADER_WGSL, label: 'text-shader' })
    this.pipeline = device.createRenderPipeline({
      label: 'text-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: FLOATS_PER_VERT * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },        // pos_px
            { shaderLocation: 1, offset: 8, format: 'float32x2' },        // uv
          ],
        }],
      },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{
          format: presentationFormat,
          // Premultiplied-alpha blend: shader emits `rgb*a, a`, so
          // srcFactor=one (NOT src-alpha — that double-multiplies).
          // Mixing premul output with a non-premul blend was the
          // root cause of dim/washed-out text + wrong halo edges.
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: sampleCount },
    })

    // Initial capacity covers a single slot — grows on demand in setDraws().
    this.uniformBufCapacityBytes = UNIFORM_STRIDE
    this.uniformBuf = device.createBuffer({
      size: this.uniformBufCapacityBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
    const data = new Float32Array(totalGlyphs * FLOATS_PER_GLYPH)
    this.drawSlices = []

    let glyphIdx = 0
    const pageSize = this.atlas.pageCount > 0
      ? this.atlas.getPage(0)!.width
      : 1  // never used when no glyphs, but keeps types happy

    for (const d of draws) {
      let penX = d.anchorX
      const baseY = d.anchorY
      const letterSpacingPx = d.letterSpacingPx ?? 0
      const offsets = d.glyphOffsets
      const perGlyphRot = d.glyphRotations
      const uniforms = packUniforms(d)
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
      const cosR = Math.cos(rot), sinR = Math.sin(rot)
      const rotateXY = (x: number, y: number): [number, number] => {
        if (rot === 0) return [x, y]
        const dx = x - d.anchorX, dy = y - d.anchorY
        return [d.anchorX + dx * cosR - dy * sinR, d.anchorY + dx * sinR + dy * cosR]
      }
      for (let gi = 0; gi < d.glyphs.length; gi++) {
        const g = d.glyphs[gi]!
        // Page boundary: flush the current slice and start a new one
        // pointing at this glyph's page.
        if (g.slot.page !== slicePage && sliceGlyphCount > 0) {
          flushSlice()
          sliceFirst = glyphIdx * VERTS_PER_GLYPH
          slicePage = g.slot.page
          sliceGlyphCount = 0
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
        const x0Raw = baseX + g.bearingX * scale - (drawW - g.width * scale) * 0.5
        const y0Raw = baseY2 - g.bearingY * scale - (drawH - g.height * scale) * 0.5
        // Pixel-snap the quad's TL when axis-aligned. fontSize/rasterFontSize
        // ratios are typically non-integer (e.g. 24/32 = 0.75), and the bearing
        // offsets carry sub-pixel components that propagate into the quad
        // origin. Linear sampling of an SDF whose origin sits at a non-integer
        // physical pixel produces per-glyph thickness jitter — visible as the
        // uneven strokes in MapLibre-demo "Tropic of Capricorn". Snapping only
        // applies when neither whole-label nor per-glyph rotation is active;
        // rotated quads land at arbitrary angles and can't honour the grid.
        const snap = rot === 0 && perGlyphRot === undefined
        const x0 = snap ? Math.round(x0Raw) : x0Raw
        const y0 = snap ? Math.round(y0Raw) : y0Raw
        const x1 = x0 + drawW
        const y1 = y0 + drawH
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
          const gcx = (x0 + x1) * 0.5, gcy = (y0 + y1) * 0.5
          const c = Math.cos(gRot), s = Math.sin(gRot)
          const rotateGlyph = (x: number, y: number): [number, number] => {
            const ddx = x - gcx, ddy = y - gcy
            return [gcx + ddx * c - ddy * s, gcy + ddx * s + ddy * c]
          };
          [tlx, tly] = rotateGlyph(x0, y0)
          ;[blx, bly] = rotateGlyph(x0, y1)
          ;[brx, bry] = rotateGlyph(x1, y1)
          ;[trx, try_] = rotateGlyph(x1, y0)
        } else {
          [tlx, tly] = rotateXY(x0, y0)
          ;[blx, bly] = rotateXY(x0, y1)
          ;[brx, bry] = rotateXY(x1, y1)
          ;[trx, try_] = rotateXY(x1, y0)
        }

        const off = glyphIdx * FLOATS_PER_GLYPH
        // tri 1: TL, BL, BR
        data[off + 0] = tlx; data[off + 1] = tly; data[off + 2] = u0;  data[off + 3] = v0
        data[off + 4] = blx; data[off + 5] = bly; data[off + 6] = u0;  data[off + 7] = v1
        data[off + 8] = brx; data[off + 9] = bry; data[off + 10] = u1; data[off + 11] = v1
        // tri 2: TL, BR, TR
        data[off + 12] = tlx; data[off + 13] = tly; data[off + 14] = u0; data[off + 15] = v0
        data[off + 16] = brx; data[off + 17] = bry; data[off + 18] = u1; data[off + 19] = v1
        data[off + 20] = trx; data[off + 21] = try_; data[off + 22] = u1; data[off + 23] = v0

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
    if (this.vertexBuf === null || this.vertexBuf.size < data.byteLength) {
      if (this.vertexBuf !== null) this.vertexBuf.destroy()
      this.vertexBuf = this.device.createBuffer({
        size: Math.max(1024, data.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'text-vertex',
      })
    }
    this.device.queue.writeBuffer(this.vertexBuf, 0, data.buffer, data.byteOffset, data.byteLength)

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
        this.uniformBuf.destroy()
        this.uniformBufCapacityBytes = Math.max(totalBytes, this.uniformBufCapacityBytes * 2)
        this.uniformBuf = this.device.createBuffer({
          size: this.uniformBufCapacityBytes,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: 'text-uniform',
        })
        this.bindGroupsByPage.length = 0
      }
    }
  }

  /** Encode draw commands. `viewport` is in physical pixels. */
  draw(pass: GPURenderPassEncoder, viewport: { width: number; height: number }): void {
    if (this.vertexCount === 0 || this.vertexBuf === null) return
    if (this.atlas.pageCount === 0) return  // no glyphs uploaded yet

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
    // submit, so the LAST write would dominate every draw.
    this.device.queue.writeBuffer(this.uniformBuf, 0,
      this.allUniforms.buffer, this.allUniforms.byteOffset,
      numSlices * UNIFORM_STRIDE)

    pass.setPipeline(this.pipeline)
    pass.setVertexBuffer(0, this.vertexBuf)

    for (const slice of this.drawSlices) {
      const page = this.atlas.getPage(slice.page)
      if (!page) continue  // page evicted between flush and draw — skip
      let bg = this.bindGroupsByPage[slice.page]
      if (!bg) {
        bg = this.device.createBindGroup({
          label: `text-bg-page-${slice.page}`,
          layout: this.bgLayout,
          entries: [
            // Use minBindingSize-sized window (64 B) into the shared
            // uniform buffer. The dynamic offset picks which slice's
            // pack is visible to the draw.
            { binding: 0, resource: { buffer: this.uniformBuf, offset: 0, size: UNIFORM_BYTES } },
            { binding: 1, resource: page.createView() },
            { binding: 2, resource: this.atlas.sampler },
          ],
        })
        this.bindGroupsByPage[slice.page] = bg
      }
      pass.setBindGroup(0, bg, [slice.dynamicOffset])
      pass.draw(slice.count, 1, slice.first, 0)
    }
  }

  destroy(): void {
    this.uniformBuf.destroy()
    this.vertexBuf?.destroy()
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

function packUniforms(d: TextDraw): Float32Array {
  const buf = new Float32Array(UNIFORM_BYTES / 4)
  // viewport (slots 0,1) — written by draw()
  buf[2] = 0; buf[3] = 0  // viewport pad
  buf[4] = d.color[0]; buf[5] = d.color[1]; buf[6] = d.color[2]; buf[7] = d.color[3]
  if (d.halo) {
    buf[8] = d.halo.color[0]; buf[9] = d.halo.color[1]
    buf[10] = d.halo.color[2]; buf[11] = d.halo.color[3]
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
    // The `·3` constant (= ONE_EM/SDF_PX = 24/8) is correct ONLY for
    // PBF-server SDFs whose byte slope is 255-per-radius (MapLibre
    // SDF_PX=8). computeSDF-rasterised glyphs (CJK / Hangul fallback,
    // icons, any font absent from the glyph server) encode a
    // 63-per-`sdfRadius` slope — ~4.05× shallower — so the SAME `·3`
    // made their halo ~4× too thick (user-reported on Mapbox styles
    // with locally-rasterised Korean place labels). For an all-local
    // draw, normalise with the SDF's own convention:
    // rasterFontSize·63 / (sdfRadius·255). Mixed / any-PBF draws keep
    // `·3` so Latin (PBF) halo stays MapLibre-correct (no regression).
    const sdfRadius = d.sdfRadius ?? 8
    const allLocal = d.glyphs.length > 0 && !d.glyphs.some(g => g.pbf)
    const haloK = allLocal
      ? (d.rasterFontSize * 63) / (sdfRadius * 255)
      : 3
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
    buf[8] = 0; buf[9] = 0; buf[10] = 0; buf[11] = 0
    buf[12] = 0
    buf[13] = 0
  }
  buf[14] = 0; buf[15] = 0
  return buf
}
