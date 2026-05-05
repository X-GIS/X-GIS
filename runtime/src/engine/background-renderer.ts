// Earth-surface fill pre-pass.
//
// Replaces the prior tile-based / quad-mesh implementations after they
// kept colliding with the depth+stencil bookkeeping (background and
// the first user layer z-fighting under log-depth at high pitch).
// This renderer:
//
//   • Draws ONE clip-space fullscreen quad in the SAME render pass as
//     the rest of the opaque content, but FIRST — before raster, before
//     MapRenderer.renderToPass, before any vector-tile show.
//   • Uses depthCompare='always' + depthWriteEnabled=false so it neither
//     blocks nor influences the depth buffer. Subsequent draws behave
//     exactly as if the canvas had been cleared to bgFillRgba.
//   • Uses stencilCompare='always' + writeMask=0 so it doesn't poison
//     the stencil that primary tile draws rely on.
//
// Trade-off: in non-Mercator projections this paints "space" outside
// the globe with the bg color. Mapbox's globe renderer handles this
// with a sphere proxy, but for the projections currently shipped
// (Mercator + the 2D variants we support today) the projected earth
// surface fills the viewport and the quad result is visually identical
// to a clearValue. Globe-style projections can layer their own sphere
// proxy on top of this when added.
//
// Depth/stencil format is hard-coded to 'depth24plus-stencil8' to
// match the rest of the pipeline (gpu-shared.STENCIL_WRITE/TEST).

import type { GPUContext } from './gpu'
import { isPickEnabled, getSampleCount } from './gpu'

const BG_SHADER = /* wgsl */ `
struct U { color: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  __PICK_FIELD__
}

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> VOut {
  // Two triangles, six clip-space verts — a fullscreen quad without
  // a vertex buffer. Index sequence: bottom-left, bottom-right,
  // top-left, top-left, bottom-right, top-right.
  var p = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  var out: VOut;
  out.pos = vec4<f32>(p[idx], 0.0, 1.0);
  return out;
}

struct FOut {
  @location(0) color: vec4<f32>,
  __PICK_OUT_FIELD__
}

@fragment
fn fs(in: VOut) -> FOut {
  var out: FOut;
  out.color = u.color;
  __PICK_WRITE__
  return out;
}
`

export class BackgroundRenderer {
  private device: GPUDevice
  private bgPipeline: GPURenderPipeline | null = null
  private bgUniformBuffer: GPUBuffer
  private bgBindGroup: GPUBindGroup | null = null
  private bgBindGroupLayout: GPUBindGroupLayout
  private fillRgba: [number, number, number, number] | null = null
  private uploadedRgba: [number, number, number, number] = [0, 0, 0, 0]
  private format: GPUTextureFormat
  private uniformData = new Float32Array(4)

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.format = ctx.format
    this.bgBindGroupLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
      label: 'bg-bgl',
    })
    this.bgUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'bg-uniform',
    })
    this.bgBindGroup = this.device.createBindGroup({
      layout: this.bgBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.bgUniformBuffer } }],
      label: 'bg-bg',
    })
  }

  /** Set the earth-surface fill color. Pass null to disable rendering
   *  (canvas clearValue then dominates). Caller writes
   *  `[r, g, b, a]` in 0..1 floats. */
  setFill(rgba: [number, number, number, number] | null): void {
    this.fillRgba = rgba
  }

  hasFill(): boolean {
    return this.fillRgba !== null
  }

  /** Lazy build — pipeline depends on isPickEnabled / getSampleCount,
   *  which can flip at runtime via setQuality. Call rebuild() when
   *  those change. */
  private buildPipeline(): GPURenderPipeline {
    const pickEnabled = isPickEnabled()
    const code = BG_SHADER
      .replace(/__PICK_FIELD__/g, pickEnabled ? '@location(0) @interpolate(flat) _pad: u32,' : '')
      .replace(/__PICK_OUT_FIELD__/g, pickEnabled ? '@location(1) pick: vec2<u32>,' : '')
      .replace(/__PICK_WRITE__/g, pickEnabled ? 'out.pick = vec2<u32>(0u, 0u);' : '')
    const module = this.device.createShaderModule({ code, label: 'bg-shader' })
    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bgBindGroupLayout],
        label: 'bg-pl',
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        // No alpha blend — opaque fill, replaces the existing color
        // attachment contents. This is intentional: bg is the first
        // draw in the opaque pass; nothing should be UNDER it.
        targets: pickEnabled
          ? [{ format: this.format }, { format: 'rg32uint' as GPUTextureFormat, writeMask: 0 }]
          : [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
      // depth-test ALWAYS + write OFF: never block, never claim depth.
      // Subsequent draws compare against the cleared depth (1.0) as if
      // bg had never run.
      // stencil ALWAYS / writeMask 0: don't disturb the stencil bookkeeping
      // primary/fallback paths rely on.
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthCompare: 'always',
        depthWriteEnabled: false,
        stencilFront: { compare: 'always', passOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'keep' },
        stencilWriteMask: 0x00,
        stencilReadMask: 0x00,
      },
      multisample: { count: getSampleCount() },
      label: 'bg-pipeline',
    })
  }

  /** Rebuild pipeline (call from setQuality reroll). */
  rebuildForQuality(): void {
    this.bgPipeline = null
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.fillRgba) return
    if (!this.bgPipeline) this.bgPipeline = this.buildPipeline()
    // Skip writeBuffer when color hasn't changed since last render.
    if (
      this.fillRgba[0] !== this.uploadedRgba[0] ||
      this.fillRgba[1] !== this.uploadedRgba[1] ||
      this.fillRgba[2] !== this.uploadedRgba[2] ||
      this.fillRgba[3] !== this.uploadedRgba[3]
    ) {
      this.uniformData[0] = this.fillRgba[0]
      this.uniformData[1] = this.fillRgba[1]
      this.uniformData[2] = this.fillRgba[2]
      this.uniformData[3] = this.fillRgba[3]
      this.device.queue.writeBuffer(this.bgUniformBuffer, 0, this.uniformData)
      this.uploadedRgba[0] = this.fillRgba[0]
      this.uploadedRgba[1] = this.fillRgba[1]
      this.uploadedRgba[2] = this.fillRgba[2]
      this.uploadedRgba[3] = this.fillRgba[3]
    }
    pass.setPipeline(this.bgPipeline)
    pass.setBindGroup(0, this.bgBindGroup!)
    pass.draw(6)
  }
}
