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

  // Halo blur: extra smoothstep half-width past the AA-derivative
  // band. Mapbox `text-halo-blur` is in display pixels; we feed it
  // in as SDF-byte units (renderer pre-multiplies). Adding to soft
  // widens the smoothstep transition without shifting the centre,
  // producing the classic soft-glow halo that sharp halos lack.
  let halo_soft: f32 = soft + u.halo_blur;
  let halo_edge: f32 = edge - u.halo_width;
  let halo_a: f32 = smoothstep(halo_edge - halo_soft, halo_edge + halo_soft, sdf);
  // Composite: halo behind, fill in front.
  let fill_w = u.fill_color.a * fill_a;
  let halo_w = u.halo_color.a * halo_a * (1.0 - fill_w);
  return vec4<f32>(u.fill_color.rgb * fill_w + u.halo_color.rgb * halo_w, fill_w + halo_w);
}
`

export class TextRenderer {
  private readonly device: GPUDevice
  private readonly atlas: GlyphAtlasGPU
  private readonly bgLayout: GPUBindGroupLayout
  private readonly pipeline: GPURenderPipeline
  private readonly uniformBuf: GPUBuffer
  private vertexBuf: GPUBuffer | null = null
  private vertexCount = 0
  /** Per-draw stride into the vertex buffer + uniform overrides. */
  private drawSlices: Array<{ first: number; count: number; uniforms: Float32Array }> = []
  /** Current bind group; rebuilt whenever the atlas page-0 texture
   *  is allocated or the uniform buffer is recreated. */
  private bindGroup: GPUBindGroup | null = null
  private lastAtlasPage: GPUTexture | null = null

  constructor(
    device: GPUDevice, atlas: GlyphAtlasGPU, presentationFormat: GPUTextureFormat,
    sampleCount: number = 1,
  ) {
    this.device = device
    this.atlas = atlas

    this.bgLayout = device.createBindGroupLayout({
      label: 'text-renderer-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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

    this.uniformBuf = device.createBuffer({
      size: UNIFORM_BYTES,
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
      const sliceFirst = glyphIdx * VERTS_PER_GLYPH
      const scale = d.fontSize / d.rasterFontSize
      let penX = d.anchorX
      const baseY = d.anchorY
      const letterSpacingPx = d.letterSpacingPx ?? 0
      const offsets = d.glyphOffsets
      // Rotation around (anchorX, anchorY). Computing once per draw
      // beats stamping out a rotation matrix per quad.
      const rot = d.rotateRad ?? 0
      const cosR = Math.cos(rot), sinR = Math.sin(rot)
      const rotateXY = (x: number, y: number): [number, number] => {
        if (rot === 0) return [x, y]
        const dx = x - d.anchorX, dy = y - d.anchorY
        return [d.anchorX + dx * cosR - dy * sinR, d.anchorY + dx * sinR + dy * cosR]
      }
      for (let gi = 0; gi < d.glyphs.length; gi++) {
        const g = d.glyphs[gi]!
        const slotSize = g.slot.size
        const drawW = slotSize * scale
        const drawH = slotSize * scale
        // When per-glyph offsets are supplied, anchor is at
        // (anchorX + dx, anchorY + dy); pen-advance loop is bypassed.
        const baseX = offsets ? d.anchorX + offsets[gi * 2]! : penX
        const baseY2 = offsets ? d.anchorY + offsets[gi * 2 + 1]! : baseY
        const x0 = baseX + g.bearingX * scale - (drawW - g.width * scale) * 0.5
        const y0 = baseY2 - g.bearingY * scale - (drawH - g.height * scale) * 0.5
        const x1 = x0 + drawW
        const y1 = y0 + drawH
        const u0 = g.slot.pxX / pageSize
        const v0 = g.slot.pxY / pageSize
        const u1 = (g.slot.pxX + slotSize) / pageSize
        const v1 = (g.slot.pxY + slotSize) / pageSize
        // 4 quad corners — rotate each around the anchor point.
        const [tlx, tly] = rotateXY(x0, y0)
        const [blx, bly] = rotateXY(x0, y1)
        const [brx, bry] = rotateXY(x1, y1)
        const [trx, try_] = rotateXY(x1, y0)

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
      }
      const uniforms = packUniforms(d)
      this.drawSlices.push({
        first: sliceFirst,
        count: d.glyphs.length * VERTS_PER_GLYPH,
        uniforms,
      })
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
  }

  /** Encode draw commands. `viewport` is in physical pixels. */
  draw(pass: GPURenderPassEncoder, viewport: { width: number; height: number }): void {
    if (this.vertexCount === 0 || this.vertexBuf === null) return
    const page = this.atlas.getPage(0)
    if (!page) return  // no glyphs uploaded yet

    if (page !== this.lastAtlasPage) {
      this.bindGroup = this.device.createBindGroup({
        label: 'text-bg',
        layout: this.bgLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuf } },
          { binding: 1, resource: page.createView() },
          { binding: 2, resource: this.atlas.sampler },
        ],
      })
      this.lastAtlasPage = page
    }

    pass.setPipeline(this.pipeline)
    pass.setVertexBuffer(0, this.vertexBuf)
    pass.setBindGroup(0, this.bindGroup!)

    for (const slice of this.drawSlices) {
      // viewport goes in front of fill/halo so the same uniform
      // layout serves all per-draw permutations.
      slice.uniforms[0] = viewport.width
      slice.uniforms[1] = viewport.height
      this.device.queue.writeBuffer(this.uniformBuf, 0, slice.uniforms.buffer,
        slice.uniforms.byteOffset, slice.uniforms.byteLength)
      pass.draw(slice.count, 1, slice.first, 0)
    }
  }

  destroy(): void {
    this.uniformBuf.destroy()
    this.vertexBuf?.destroy()
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

function packUniforms(d: TextDraw): Float32Array {
  const buf = new Float32Array(UNIFORM_BYTES / 4)
  // viewport (slots 0,1) — written by draw()
  buf[2] = 0; buf[3] = 0  // viewport pad
  buf[4] = d.color[0]; buf[5] = d.color[1]; buf[6] = d.color[2]; buf[7] = d.color[3]
  if (d.halo) {
    buf[8] = d.halo.color[0]; buf[9] = d.halo.color[1]
    buf[10] = d.halo.color[2]; buf[11] = d.halo.color[3]
    // halo_width is in display px; convert to SDF-byte-space threshold.
    // The SDF packs ±63 byte-units across the rasterisation `sdfRadius`
    // pixels (see distance-transform.ts). So 1 px halo ≈ 63/sdfRadius
    // byte-units; divide by 255 for the [0,1] threshold the shader
    // smoothsteps. sdfRadius is plumbed in by TextStage; legacy callers
    // who don't set it fall back to 6 (the historical default).
    const sdfRadius = d.sdfRadius ?? 6
    const SDF_UNITS_PER_PX = 63 / sdfRadius
    buf[12] = (d.halo.width * SDF_UNITS_PER_PX) / 255
    // halo_blur shares the same px → SDF-byte → [0,1] conversion
    // as halo_width — both measure in the SDF's distance scale.
    buf[13] = ((d.halo.blur ?? 0) * SDF_UNITS_PER_PX) / 255
  } else {
    buf[8] = 0; buf[9] = 0; buf[10] = 0; buf[11] = 0
    buf[12] = 0
    buf[13] = 0
  }
  buf[14] = 0; buf[15] = 0
  return buf
}
