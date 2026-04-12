// ═══ Mercator Reprojection ═══
// Pass 2 of 2-pass Mercator rendering:
// Resamples an equirectangular texture into Mercator space via fullscreen quad.
//
// Pass 1 renders all geometry in equirectangular (north-up, no rotation).
// Pass 2 maps screen pixels → rotate by bearing → Mercator → lon/lat → equirect UV.

import type { GPUContext } from './gpu'

const REPROJECT_SHADER = /* wgsl */ `
struct Uniforms {
  // Camera center in Mercator meters
  center_x: f32,
  center_y: f32,
  // Meters per physical pixel at current zoom
  mpp: f32,
  // Bearing rotation (screen → Mercator)
  bearing_cos: f32,
  bearing_sin: f32,
  // Physical canvas size (pixels)
  canvas_w: f32,
  canvas_h: f32,
  _pad0: f32,
  // Equirect texture geographic bounds (degrees)
  eq_west: f32,
  eq_east: f32,
  eq_south: f32,
  eq_north: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var equirect_tex: texture_2d<f32>;
@group(0) @binding(2) var equirect_sampler: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vid: u32) -> VsOut {
  let x = f32(vid & 1u) * 4.0 - 1.0;
  let y = f32((vid >> 1u) & 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

const PI: f32 = 3.14159265;
const R: f32 = 6378137.0;

@fragment
fn fs_reproject(input: VsOut) -> @location(0) vec4<f32> {
  // 1. Screen UV → pixel offset from center (Y-up)
  let px_x = (input.uv.x - 0.5) * u.canvas_w;
  let px_y = (0.5 - input.uv.y) * u.canvas_h;

  // 2. Rotate by bearing (screen space → Mercator space)
  let rot_x = px_x * u.bearing_cos - px_y * u.bearing_sin;
  let rot_y = px_x * u.bearing_sin + px_y * u.bearing_cos;

  // 3. Pixel offset → Mercator meters → lon/lat (degrees)
  let merc_x = u.center_x + rot_x * u.mpp;
  let merc_y = u.center_y + rot_y * u.mpp;
  let lon = (merc_x / R) * (180.0 / PI);
  let lat = atan(sinh(merc_y / R)) * (180.0 / PI);

  // 4. lon/lat → equirect texture UV
  let eq_u = (lon - u.eq_west) / (u.eq_east - u.eq_west);
  let eq_v = (lat - u.eq_south) / (u.eq_north - u.eq_south);

  // Sample equirect texture, mask out-of-bounds
  let color = textureSampleLevel(equirect_tex, equirect_sampler, vec2<f32>(eq_u, 1.0 - eq_v), 0.0);
  let bg = vec4<f32>(0.039, 0.039, 0.063, 1.0);
  return select(color, bg, eq_u < 0.0 || eq_u > 1.0 || eq_v < 0.0 || eq_v > 1.0);
}
`

export class MercatorReprojector {
  private device: GPUDevice
  private pipeline: GPURenderPipeline | null = null
  private uniformBuffer: GPUBuffer
  private bindGroupLayout: GPUBindGroupLayout
  private sampler: GPUSampler
  private format: GPUTextureFormat

  // Offscreen equirectangular render target
  private equirectTexture: GPUTexture | null = null
  private equirectView: GPUTextureView | null = null
  private equirectWidth = 0
  private equirectHeight = 0

  // Stencil for the equirect pass
  private stencilTexture: GPUTexture | null = null

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.format = ctx.format

    this.bindGroupLayout = ctx.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })

    this.uniformBuffer = ctx.device.createBuffer({
      size: 48, // 12 × f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.sampler = ctx.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
  }

  /** Get or create the equirectangular render target */
  getEquirectTarget(width: number, height: number): { view: GPUTextureView; stencilView: GPUTextureView } {
    if (!this.equirectTexture || this.equirectWidth !== width || this.equirectHeight !== height) {
      this.equirectTexture?.destroy()
      this.stencilTexture?.destroy()

      this.equirectTexture = this.device.createTexture({
        size: { width, height },
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.stencilTexture = this.device.createTexture({
        size: { width, height },
        format: 'stencil8',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })

      this.equirectWidth = width
      this.equirectHeight = height
      this.equirectView = this.equirectTexture.createView()
    }
    return { view: this.equirectView!, stencilView: this.stencilTexture!.createView() }
  }

  /** Render Pass 2: reproject equirectangular texture to Mercator on screen */
  render(
    encoder: GPUCommandEncoder,
    screenView: GPUTextureView,
    centerX: number, centerY: number,
    mpp: number, bearing: number,
    canvasW: number, canvasH: number,
    eqWest: number, eqSouth: number, eqEast: number, eqNorth: number,
  ): void {
    if (!this.equirectTexture) return

    // Lazy pipeline creation
    if (!this.pipeline) {
      const module = this.device.createShaderModule({ code: REPROJECT_SHADER })
      this.pipeline = this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module, entryPoint: 'fs_reproject',
          targets: [{ format: this.format }],
        },
        primitive: { topology: 'triangle-list' },
      })
    }

    const bearingRad = bearing * Math.PI / 180
    const data = new Float32Array([
      centerX, centerY,
      mpp,
      Math.cos(bearingRad), Math.sin(bearingRad),
      canvasW, canvasH,
      0, // pad
      eqWest, eqEast, eqSouth, eqNorth,
    ])
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data)

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.equirectView! },
        { binding: 2, resource: this.sampler },
      ],
    })

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: screenView,
        loadOp: 'clear',
        clearValue: { r: 0.039, g: 0.039, b: 0.063, a: 1 },
        storeOp: 'store',
      }],
    })

    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
  }
}
