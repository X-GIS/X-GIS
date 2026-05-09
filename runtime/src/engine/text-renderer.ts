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
  /** Optional halo. `width` is in display pixels; `color` is RGBA. */
  halo?: { color: [number, number, number, number]; width: number }
}

const VERTS_PER_GLYPH = 6  // two triangles
const FLOATS_PER_VERT = 4  // posX, posY, uvX, uvY
const FLOATS_PER_GLYPH = VERTS_PER_GLYPH * FLOATS_PER_VERT

const TEXT_SHADER_WGSL = /* wgsl */ `
struct Uniforms {
  viewport: vec2<f32>,
  fill_color: vec4<f32>,
  halo_color: vec4<f32>,
  halo_width: f32,         // 0 = no halo
  edge_softness: f32,      // smoothstep half-width
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
  let soft: f32 = u.edge_softness;

  // Fill mask
  let fill_a: f32 = smoothstep(edge - soft, edge + soft, sdf);

  // Halo: extends halo_width SDF-units inward from the edge. The
  // SDF byte spans +/- 63 units across radius px; we map halo_width
  // (px) -> SDF-unit threshold by reversing that scale at the
  // shader level via a uniform. The renderer pre-multiplies so
  // halo_width here is already in shader-space units.
  if (u.halo_width <= 0.0) {
    return vec4<f32>(u.fill_color.rgb, u.fill_color.a * fill_a);
  }

  let halo_edge: f32 = edge - u.halo_width;
  let halo_a: f32 = smoothstep(halo_edge - soft, halo_edge + soft, sdf);
  // Composite: halo behind, fill in front.
  let halo_rgb = u.halo_color.rgb * (u.halo_color.a * halo_a);
  let fill_rgb = u.fill_color.rgb * (u.fill_color.a * fill_a);
  let fill_w = u.fill_color.a * fill_a;
  let halo_w = u.halo_color.a * halo_a * (1.0 - fill_w);
  return vec4<f32>(fill_rgb + u.halo_color.rgb * halo_w, fill_w + halo_w);
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
      for (const g of d.glyphs) {
        const slotSize = g.slot.size
        const drawW = slotSize * scale
        const drawH = slotSize * scale
        // Glyph centred in slot during rasterisation; quad is also
        // centred horizontally on the pen + offset by glyph centre.
        const x0 = penX + g.bearingX * scale - (drawW - g.width * scale) * 0.5
        const y0 = baseY - g.bearingY * scale - (drawH - g.height * scale) * 0.5
        const x1 = x0 + drawW
        const y1 = y0 + drawH
        const u0 = g.slot.pxX / pageSize
        const v0 = g.slot.pxY / pageSize
        const u1 = (g.slot.pxX + slotSize) / pageSize
        const v1 = (g.slot.pxY + slotSize) / pageSize

        const off = glyphIdx * FLOATS_PER_GLYPH
        // tri 1: TL, BL, BR
        data[off + 0] = x0;  data[off + 1] = y0;  data[off + 2] = u0;  data[off + 3] = v0
        data[off + 4] = x0;  data[off + 5] = y1;  data[off + 6] = u0;  data[off + 7] = v1
        data[off + 8] = x1;  data[off + 9] = y1;  data[off + 10] = u1; data[off + 11] = v1
        // tri 2: TL, BR, TR
        data[off + 12] = x0; data[off + 13] = y0; data[off + 14] = u0; data[off + 15] = v0
        data[off + 16] = x1; data[off + 17] = y1; data[off + 18] = u1; data[off + 19] = v1
        data[off + 20] = x1; data[off + 21] = y0; data[off + 22] = u1; data[off + 23] = v0

        penX += g.advanceWidth * scale
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
    // halo_width is in display px; convert to SDF-unit threshold
    // delta. SDF spans ±63 units across `radius` px (we don't know
    // the host's sdfRadius here without threading it through; for
    // the first pass we use a fixed 6 px rasterisation assumption,
    // matching the GlyphAtlasHost default — the integration layer
    // can override via a separate API if it picks a different
    // radius). 1 px halo ≈ 63/6 = 10.5 SDF units = 10.5/255 ≈ 0.041
    // shader-space units.
    const SDF_UNITS_PER_PX = 63 / 6
    buf[12] = (d.halo.width * SDF_UNITS_PER_PX) / 255
  } else {
    buf[8] = 0; buf[9] = 0; buf[10] = 0; buf[11] = 0
    buf[12] = 0
  }
  // edge_softness — heuristic 1 SDF byte ≈ 1/255
  buf[13] = 4 / 255
  buf[14] = 0; buf[15] = 0
  return buf
}
