// ═══ Unified Reprojector ═══
// Pass 2 of 2-pass rendering for ALL projections:
// Resamples an equirectangular texture into the target projection via fullscreen quad.
//
// Pass 1 renders all geometry in equirectangular (north-up, linear interpolation).
// Pass 2 maps screen pixels → inverse projection → lon/lat → equirect texture UV.
//
// Supports: Mercator, Natural Earth, Orthographic, Azimuthal Equidistant,
//           Stereographic, Oblique Mercator

import type { GPUContext } from './gpu'

const REPROJECT_SHADER = /* wgsl */ `
struct Uniforms {
  // Camera center in Mercator meters (for Mercator projection offset)
  center_x: f32,
  center_y: f32,
  // Meters per physical pixel at current zoom
  mpp: f32,
  // Projection type (0=merc, 2=natearth, 3=ortho, 4=azieqd, 5=stereo, 6=oblmerc)
  proj_type: f32,
  // Bearing rotation (screen → map)
  bearing_cos: f32,
  bearing_sin: f32,
  // Physical canvas size
  canvas_w: f32,
  canvas_h: f32,
  // Projection center (degrees) — for center-based projections
  center_lon: f32,
  center_lat: f32,
  // Equirect texture geographic bounds (degrees)
  eq_west: f32,
  eq_east: f32,
  eq_south: f32,
  eq_north: f32,
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
  let x = f32(vid & 1u) * 4.0 - 1.0;
  let y = f32((vid >> 1u) & 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 3.14159265 / 180.0;
const RAD2DEG: f32 = 180.0 / 3.14159265;
const R: f32 = 6378137.0;
const OOB: vec2<f32> = vec2<f32>(999.0, 999.0);

// ═══ Inverse Mercator ═══
fn inv_mercator(mx: f32, my: f32) -> vec2<f32> {
  let lon = (mx / R) * RAD2DEG;
  let lat = (2.0 * atan(exp(my / R)) - PI * 0.5) * RAD2DEG;
  return vec2<f32>(lon, lat);
}

// ═══ Inverse Natural Earth (Newton-Raphson, 5 iterations) ═══
fn inv_natural_earth(px: f32, py: f32) -> vec2<f32> {
  let goal_y = py / R;
  // Initial guess from linear approximation
  var t = goal_y / 1.007226;

  for (var i = 0; i < 5; i++) {
    let t2 = t * t;
    let t4 = t2 * t2;
    let t6 = t2 * t4;
    let t8 = t4 * t4;
    // f(t) = y_val(t) - goal_y
    let y_val = t * (1.007226 + t2 * (0.015085 + t2 * (-0.044475 + 0.028874 * t2 - 0.005916 * t4)));
    let f = y_val - goal_y;
    // f'(t) = dy/dt
    let dy = 1.007226 + 0.045255 * t2 - 0.222375 * t4 + 0.202118 * t6 - 0.053244 * t8;
    if (abs(dy) < 1e-10) { break; }
    t = t - f / dy;
  }

  let t2 = t * t;
  let t4 = t2 * t2;
  let t6 = t2 * t4;
  let x_scale = 0.8707 - 0.131979 * t2 + 0.013791 * t4 - 0.0081435 * t6;
  if (abs(x_scale) < 1e-6) { return OOB; }

  let lon = (px / (x_scale * R)) * RAD2DEG;
  let lat = t * RAD2DEG;
  if (abs(lat) > 90.0 || abs(lon) > 180.0) { return OOB; }
  return vec2<f32>(lon, lat);
}

// ═══ Inverse Orthographic ═══
fn inv_orthographic(px: f32, py: f32, clon: f32, clat: f32) -> vec2<f32> {
  let rho = sqrt(px * px + py * py);
  if (rho > R) { return OOB; }
  let c = asin(rho / R);
  let cos_c = cos(c);
  let sin_c = sin(c);
  let phi0 = clat * DEG2RAD;
  let lam0 = clon * DEG2RAD;
  let sin_p0 = sin(phi0);
  let cos_p0 = cos(phi0);

  var lat: f32;
  var lon: f32;
  if (rho < 0.001) {
    lat = clat; lon = clon;
  } else {
    lat = asin(cos_c * sin_p0 + (py * sin_c * cos_p0) / rho) * RAD2DEG;
    lon = (lam0 + atan2(px * sin_c, rho * cos_p0 * cos_c - py * sin_p0 * sin_c)) * RAD2DEG;
  }
  return vec2<f32>(lon, lat);
}

// ═══ Inverse Azimuthal Equidistant ═══
fn inv_azimuthal_equidistant(px: f32, py: f32, clon: f32, clat: f32) -> vec2<f32> {
  let rho = sqrt(px * px + py * py);
  if (rho < 0.001) { return vec2<f32>(clon, clat); }
  let c = rho / R;
  let cos_c = cos(c);
  let sin_c = sin(c);
  let phi0 = clat * DEG2RAD;
  let lam0 = clon * DEG2RAD;
  let sin_p0 = sin(phi0);
  let cos_p0 = cos(phi0);

  let lat = asin(cos_c * sin_p0 + (py * sin_c * cos_p0) / rho) * RAD2DEG;
  let lon = (lam0 + atan2(px * sin_c, rho * cos_p0 * cos_c - py * sin_p0 * sin_c)) * RAD2DEG;
  return vec2<f32>(lon, lat);
}

// ═══ Inverse Stereographic ═══
fn inv_stereographic(px: f32, py: f32, clon: f32, clat: f32) -> vec2<f32> {
  let rho = sqrt(px * px + py * py);
  if (rho < 0.001) { return vec2<f32>(clon, clat); }
  let c = 2.0 * atan2(rho, 2.0 * R);
  let cos_c = cos(c);
  let sin_c = sin(c);
  let phi0 = clat * DEG2RAD;
  let lam0 = clon * DEG2RAD;
  let sin_p0 = sin(phi0);
  let cos_p0 = cos(phi0);

  let lat = asin(cos_c * sin_p0 + (py * sin_c * cos_p0) / rho) * RAD2DEG;
  let lon = (lam0 + atan2(px * sin_c, rho * cos_p0 * cos_c - py * sin_p0 * sin_c)) * RAD2DEG;
  return vec2<f32>(lon, lat);
}

// ═══ Inverse Oblique Mercator ═══
fn inv_oblique_mercator(px: f32, py: f32, clon: f32, clat: f32) -> vec2<f32> {
  let phi0 = clat * DEG2RAD;
  let lam0 = clon * DEG2RAD;
  let sin_p0 = sin(phi0);
  let cos_p0 = cos(phi0);

  // Undo Mercator on rotated coordinates
  let lam_rot = px / R;
  let phi_shifted = 2.0 * atan(exp(py / R)) - PI / 2.0;
  let phi_rot = phi_shifted + PI / 2.0;

  // Rotate back to geographic
  let sin_pr = sin(phi_rot);
  let cos_pr = cos(phi_rot);
  let sin_lr = sin(lam_rot);
  let cos_lr = cos(lam_rot);

  let lat = asin(clamp(sin_p0 * sin_pr + cos_p0 * cos_pr * cos_lr, -1.0, 1.0)) * RAD2DEG;
  let lon = (lam0 + atan2(cos_pr * sin_lr, sin_p0 * cos_pr * cos_lr - cos_p0 * sin_pr)) * RAD2DEG;
  return vec2<f32>(lon, lat);
}

// ═══ Main Fragment Shader ═══
@fragment
fn fs_reproject(input: VsOut) -> @location(0) vec4<f32> {
  // 1. Screen UV → pixel offset from center (Y-up)
  let px_x = (input.uv.x - 0.5) * u.canvas_w;
  let px_y = (0.5 - input.uv.y) * u.canvas_h;

  // 2. Rotate by bearing (screen space → map space)
  let rot_x = px_x * u.bearing_cos - px_y * u.bearing_sin;
  let rot_y = px_x * u.bearing_sin + px_y * u.bearing_cos;

  // 3. Pixel → projection plane meters
  let proj_x = rot_x * u.mpp;
  let proj_y = rot_y * u.mpp;

  // 4. Inverse projection → lon/lat (degrees)
  var lonlat: vec2<f32>;
  let pt = i32(u.proj_type + 0.5); // round to nearest int
  if (pt == 0) {
    lonlat = inv_mercator(u.center_x + proj_x, u.center_y + proj_y);
  } else if (pt == 2) {
    lonlat = inv_natural_earth(proj_x, proj_y);
  } else if (pt == 3) {
    lonlat = inv_orthographic(proj_x, proj_y, u.center_lon, u.center_lat);
  } else if (pt == 4) {
    lonlat = inv_azimuthal_equidistant(proj_x, proj_y, u.center_lon, u.center_lat);
  } else if (pt == 5) {
    lonlat = inv_stereographic(proj_x, proj_y, u.center_lon, u.center_lat);
  } else if (pt == 6) {
    lonlat = inv_oblique_mercator(proj_x, proj_y, u.center_lon, u.center_lat);
  } else {
    lonlat = OOB;
  }

  // 5. lon/lat → equirect texture UV
  let eq_u = (lonlat.x - u.eq_west) / (u.eq_east - u.eq_west);
  let eq_v = (lonlat.y - u.eq_south) / (u.eq_north - u.eq_south);

  // Sample equirect texture, mask out-of-bounds
  let color = textureSampleLevel(equirect_tex, equirect_sampler, vec2<f32>(eq_u, 1.0 - eq_v), 0.0);
  let bg = vec4<f32>(0.039, 0.039, 0.063, 1.0);
  let oob = eq_u < 0.0 || eq_u > 1.0 || eq_v < 0.0 || eq_v > 1.0 || lonlat.x > 180.0;
  return select(color, bg, oob);
}
`

export class Reprojector {
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
      size: 64, // 16 × f32
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

  /** Render Pass 2: reproject equirectangular texture to target projection on screen */
  render(
    encoder: GPUCommandEncoder,
    screenView: GPUTextureView,
    centerX: number, centerY: number,
    mpp: number, projType: number,
    bearing: number,
    canvasW: number, canvasH: number,
    centerLon: number, centerLat: number,
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
      mpp, projType,
      Math.cos(bearingRad), Math.sin(bearingRad),
      canvasW, canvasH,
      centerLon, centerLat,
      eqWest, eqEast, eqSouth, eqNorth,
      0, 0,
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
