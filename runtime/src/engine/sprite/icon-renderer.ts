// Standalone WebGPU pipeline for sprite icons.
//
// Vertex stage: screen-pixel quad → NDC, same convention as the SDF
// text-renderer. Fragment stage: straight texture sample with alpha
// blending. SDF icons (sdf:true in sprite JSON) get the same fwidth-
// based AA shader path as text — but only the bitmap path is wired
// up here. SDF tinting via icon-color lands in a follow-up commit
// (Phase B). Today's pipeline handles non-SDF (raster) sprites only,
// which covers ~90 % of icons in Mapbox / MapLibre / OFM styles.
//
// Coordinate frame: anchor arrives already in physical pixels (the
// caller projects lon/lat → screen px before submitting). The vertex
// stage just converts viewport-px → NDC.

import { SpriteAtlasGPU } from './sprite-atlas-gpu'
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
}

export type IconAnchor =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

const VERTS_PER_QUAD = 6
const FLOATS_PER_VERT = 4   // pos.x, pos.y, uv.x, uv.y
const FLOATS_PER_QUAD = VERTS_PER_QUAD * FLOATS_PER_VERT

const ICON_SHADER_WGSL = /* wgsl */ `
struct Uniforms { viewport: vec2<f32>, _pad0: f32, _pad1: f32 }

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas_tex: texture_2d<f32>;
@group(0) @binding(2) var atlas_smp: sampler;

struct VsOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex fn vs(@location(0) pos_px: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut {
  let ndc_x = (pos_px.x / u.viewport.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (pos_px.y / u.viewport.y) * 2.0;
  return VsOut(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0), uv);
}

@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(atlas_tex, atlas_smp, in.uv);
  // PNG is non-premultiplied; the blend state below uses src-alpha
  // accordingly so we don't need to premultiply in the shader.
  return c;
}
`

export class IconRenderer {
  private readonly device: GPUDevice
  private readonly atlas: SpriteAtlasGPU
  private readonly bgLayout: GPUBindGroupLayout
  private readonly pipeline: GPURenderPipeline
  private readonly uniformBuf: GPUBuffer
  private vertexBuf: GPUBuffer | null = null
  private vertexCount = 0
  /** Bind group lazily built once the atlas texture exists. Reset to
   *  null when the atlas changes (rare — only on a fresh setSpriteUrl). */
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

    const module = device.createShaderModule({ code: ICON_SHADER_WGSL, label: 'icon-shader' })
    this.pipeline = device.createRenderPipeline({
      label: 'icon-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bgLayout] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: FLOATS_PER_VERT * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // pos_px
            { shaderLocation: 1, offset: 8, format: 'float32x2' }, // uv
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
    if (draws.length === 0) { this.vertexCount = 0; return }
    const atlasSize = this.atlas.size()
    if (atlasSize.width === 0) { this.vertexCount = 0; return }

    const data = new Float32Array(draws.length * FLOATS_PER_QUAD)
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

      // tri 1: TL, BL, BR
      data[off + 0] = tlx; data[off + 1] = tly; data[off + 2] = u0;  data[off + 3] = v0
      data[off + 4] = blx; data[off + 5] = bly; data[off + 6] = u0;  data[off + 7] = v1
      data[off + 8] = brx; data[off + 9] = bry; data[off + 10] = u1; data[off + 11] = v1
      // tri 2: TL, BR, TR
      data[off + 12] = tlx; data[off + 13] = tly; data[off + 14] = u0; data[off + 15] = v0
      data[off + 16] = brx; data[off + 17] = bry; data[off + 18] = u1; data[off + 19] = v1
      data[off + 20] = trx; data[off + 21] = try_; data[off + 22] = u1; data[off + 23] = v0
      off += FLOATS_PER_QUAD
    }

    this.vertexCount = draws.length * VERTS_PER_QUAD
    if (this.vertexBuf === null || this.vertexBuf.size < data.byteLength) {
      this.vertexBuf?.destroy()
      this.vertexBuf = this.device.createBuffer({
        size: Math.max(1024, data.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'icon-vertex',
      })
    }
    this.device.queue.writeBuffer(this.vertexBuf, 0, data.buffer, data.byteOffset, data.byteLength)
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
    const uniforms = new Float32Array([viewport.width, viewport.height, 0, 0])
    this.device.queue.writeBuffer(this.uniformBuf, 0, uniforms.buffer)
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
