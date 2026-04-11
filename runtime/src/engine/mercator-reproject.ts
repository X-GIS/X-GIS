// ═══ Mercator Reprojection ═══
// Pass 2 of 2-pass Mercator rendering:
// Resamples an equirectangular texture into Mercator space via fullscreen quad.
//
// Pass 1 renders all geometry in equirectangular projection (linear, correct interpolation).
// Pass 2 maps equirectangular pixels to Mercator screen positions via fragment shader UV transform.

import type { GPUContext } from './gpu'

const REPROJECT_SHADER = /* wgsl */ `
struct Uniforms {
  // Equirectangular view bounds (degrees)
  view_west: f32,
  view_south: f32,
  view_east: f32,
  view_north: f32,
  // Mercator Y bounds (normalized, for UV mapping)
  merc_y_south: f32,
  merc_y_north: f32,
  _pad0: f32,
  _pad1: f32,
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
  // Fullscreen triangle (covers entire screen with 3 vertices)
  let x = f32(vid & 1u) * 4.0 - 1.0;
  let y = f32((vid >> 1u) & 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

const PI: f32 = 3.14159265;

@fragment
fn fs_reproject(input: VsOut) -> @location(0) vec4<f32> {
  // Screen UV → Mercator Y → inverse Mercator → latitude → equirectangular UV
  let merc_y = mix(u.merc_y_south, u.merc_y_north, 1.0 - input.uv.y);
  let lat_rad = atan(sinh(merc_y));
  let lat_deg = lat_rad * (180.0 / PI);

  // Map latitude to equirectangular texture V coordinate
  let equirect_v = (lat_deg - u.view_south) / (u.view_north - u.view_south);

  // Longitude maps linearly (same in both projections)
  let equirect_u = input.uv.x;

  // Clamp to valid texture range
  if (equirect_v < 0.0 || equirect_v > 1.0) {
    return vec4<f32>(0.039, 0.039, 0.063, 1.0); // background color
  }

  return textureSample(equirect_tex, equirect_sampler, vec2<f32>(equirect_u, 1.0 - equirect_v));
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
      size: 32, // 8 × f32
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
    viewWest: number, viewSouth: number, viewEast: number, viewNorth: number,
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

    // Compute Mercator Y bounds (normalized by Earth radius)
    const DEG2RAD = Math.PI / 180
    const clampS = Math.max(-85.051, viewSouth)
    const clampN = Math.min(85.051, viewNorth)
    const mercYSouth = Math.log(Math.tan(Math.PI / 4 + clampS * DEG2RAD / 2))
    const mercYNorth = Math.log(Math.tan(Math.PI / 4 + clampN * DEG2RAD / 2))

    // Update uniforms
    const data = new Float32Array([
      viewWest, viewSouth, viewEast, viewNorth,
      mercYSouth, mercYNorth, 0, 0,
    ])
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data)

    // Bind group
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.equirectView! },
        { binding: 2, resource: this.sampler },
      ],
    })

    // Render fullscreen quad
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
    pass.draw(3) // fullscreen triangle
    pass.end()
  }
}
