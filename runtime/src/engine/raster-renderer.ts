// ═══ Raster Tile Renderer — 텍스처 타일을 GPU 투영으로 렌더링 ═══

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import { visibleTiles, tileBounds, tileUrl, loadImageTexture, type TileCoord, type LoadedTile } from '../loader/tiles'

const RASTER_SHADER = /* wgsl */ `
const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 0.01745329;
const EARTH_R: f32 = 6378137.0;

struct Uniforms {
  mvp: mat4x4<f32>,
  proj_params: vec4<f32>,
}

fn proj_mercator(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  let lat = clamp(lat_deg, -85.05, 85.05);
  return vec2<f32>(
    lon_deg * DEG2RAD * EARTH_R,
    log(tan(PI / 4.0 + lat * DEG2RAD / 2.0)) * EARTH_R
  );
}

fn proj_equirectangular(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  return vec2<f32>(lon_deg * DEG2RAD * EARTH_R, lat_deg * DEG2RAD * EARTH_R);
}

fn proj_natural_earth(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  let lat = lat_deg * DEG2RAD;
  let lat2 = lat * lat;
  let lat4 = lat2 * lat2;
  let lat6 = lat2 * lat4;
  let x_scale = 0.8707 - 0.131979 * lat2 + 0.013791 * lat4 - 0.0081435 * lat6;
  let y_val = lat * (1.007226 + lat2 * (0.015085 + lat2 * (-0.044475 + 0.028874 * lat2 - 0.005916 * lat4)));
  return vec2<f32>(lon_deg * DEG2RAD * x_scale * EARTH_R, y_val * EARTH_R);
}

fn proj_orthographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  return vec2<f32>(
    EARTH_R * cos(phi) * sin(lam - l0),
    EARTH_R * (cos(p0) * sin(phi) - sin(p0) * cos(phi) * cos(lam - l0))
  );
}

fn proj_azimuthal_equidistant(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  let cos_c = sin(p0)*sin(phi) + cos(p0)*cos(phi)*cos(lam - l0);
  let c = acos(clamp(cos_c, -1.0, 1.0));
  if (c < 0.0001) { return vec2<f32>(0.0, 0.0); }
  let k = c / sin(c);
  return vec2<f32>(EARTH_R*k*cos(phi)*sin(lam-l0), EARTH_R*k*(cos(p0)*sin(phi)-sin(p0)*cos(phi)*cos(lam-l0)));
}

fn proj_stereographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  let cos_c = sin(p0)*sin(phi) + cos(p0)*cos(phi)*cos(lam-l0);
  if (cos_c < -0.9) { return vec2<f32>(1e15, 1e15); }
  let k = 2.0 / (1.0 + cos_c);
  return vec2<f32>(EARTH_R*k*cos(phi)*sin(lam-l0), EARTH_R*k*(cos(p0)*sin(phi)-sin(p0)*cos(phi)*cos(lam-l0)));
}

fn center_cos_c(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> f32 {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  return sin(p0)*sin(phi) + cos(p0)*cos(phi)*cos(lam - l0);
}

fn proj_oblique_mercator(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  let d_lam = lam - l0;
  let lam_rot = atan2(cos(phi)*sin(d_lam), cos(p0)*sin(phi)-sin(p0)*cos(phi)*cos(d_lam));
  let phi_rot = asin(clamp(sin(p0)*sin(phi)+cos(p0)*cos(phi)*cos(d_lam), -1.0, 1.0));
  let phi_shifted = phi_rot - PI / 2.0;
  let y_lat = clamp(phi_shifted, -1.5, 1.5);
  return vec2<f32>(EARTH_R*lam_rot, EARTH_R*log(tan(PI/4.0+y_lat/2.0)));
}

fn project(lon: f32, lat: f32) -> vec2<f32> {
  let t = u.proj_params.x;
  let clon = u.proj_params.y; let clat = u.proj_params.z;
  if (t < 0.5) { return proj_mercator(lon, lat); }
  else if (t < 1.5) { return proj_equirectangular(lon, lat); }
  else if (t < 2.5) { return proj_natural_earth(lon, lat); }
  else if (t < 3.5) { return proj_orthographic(lon, lat, clon, clat); }
  else if (t < 4.5) { return proj_azimuthal_equidistant(lon, lat, clon, clat); }
  else if (t < 5.5) { return proj_stereographic(lon, lat, clon, clat); }
  else { return proj_oblique_mercator(lon, lat, clon, clat); }
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var tex_sampler: sampler;

struct TileUniforms {
  bounds: vec4<f32>,  // west, south, east, north (degrees)
}
@group(1) @binding(0) var<uniform> tile: TileUniforms;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) vis: f32,
}

@vertex
fn vs_tile(@builtin(vertex_index) vid: u32) -> VsOut {
  // Quad: 2 triangles, 6 vertices
  let u_arr = array<f32, 6>(0, 1, 0, 1, 1, 0);
  let v_arr = array<f32, 6>(0, 0, 1, 0, 1, 1);
  let uu = u_arr[vid];
  let vv = v_arr[vid];

  let lon = mix(tile.bounds.x, tile.bounds.z, uu);
  let lat = mix(tile.bounds.w, tile.bounds.y, vv);  // north to south (top to bottom)

  // RTC: project relative to center
  let projected = project(lon, lat);
  let center_projected = project(u.proj_params.y, u.proj_params.z);
  let rtc = projected - center_projected;

  var out: VsOut;
  out.pos = u.mvp * vec4<f32>(rtc, 0.0, 1.0);
  out.uv = vec2<f32>(uu, vv);

  let t = u.proj_params.x;
  if (t > 2.5 && t < 3.5) { out.vis = center_cos_c(lon, lat, u.proj_params.y, u.proj_params.z); }
  else if (t > 4.5) { out.vis = center_cos_c(lon, lat, u.proj_params.y, u.proj_params.z); }
  else { out.vis = 1.0; }
  return out;
}

@fragment
fn fs_tile(input: VsOut) -> @location(0) vec4<f32> {
  if (input.vis < 0.0) { discard; }
  return textureSample(tex, tex_sampler, input.uv);
}
`

export class RasterRenderer {
  private device: GPUDevice
  private pipeline: GPURenderPipeline
  private globalBindGroupLayout: GPUBindGroupLayout
  private tileBindGroupLayout: GPUBindGroupLayout
  private uniformBuffer: GPUBuffer
  private sampler: GPUSampler

  // Tile cache
  private tileCache = new Map<string, { texture: GPUTexture; bindGroup: GPUBindGroup; tileUniform: GPUBuffer }>()
  private loadingTiles = new Set<string>()

  private urlTemplate = ''

  constructor(ctx: GPUContext) {
    this.device = ctx.device

    const module = ctx.device.createShaderModule({ code: RASTER_SHADER, label: 'raster-shader' })

    this.globalBindGroupLayout = ctx.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })

    this.tileBindGroupLayout = ctx.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    })

    this.pipeline = ctx.device.createRenderPipeline({
      layout: ctx.device.createPipelineLayout({ bindGroupLayouts: [this.globalBindGroupLayout, this.tileBindGroupLayout] }),
      vertex: { module, entryPoint: 'vs_tile' },
      fragment: {
        module, entryPoint: 'fs_tile',
        targets: [{ format: ctx.format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        }}],
      },
      primitive: { topology: 'triangle-list' },
      label: 'raster-pipeline',
    })

    this.uniformBuffer = ctx.device.createBuffer({
      size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'raster-uniforms',
    })

    this.sampler = ctx.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    })
  }

  setUrlTemplate(url: string): void {
    this.urlTemplate = url
  }

  render(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
  ): void {
    if (!this.urlTemplate) return

    const mvp = camera.getRTCMatrix(canvasWidth, canvasHeight)

    // Determine visible tiles
    const { centerX, centerY, zoom } = camera
    // Convert mercator center back to lon/lat for tile calculation
    const centerLon = (centerX / 6378137) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(centerY / 6378137)) - Math.PI / 2) * (180 / Math.PI)

    const tiles = visibleTiles(centerLon, centerLat, zoom, canvasWidth, canvasHeight)

    // Load missing tiles (async)
    for (const coord of tiles) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      if (!this.tileCache.has(key) && !this.loadingTiles.has(key)) {
        this.loadingTiles.add(key)
        const url = tileUrl(this.urlTemplate, coord)
        loadImageTexture(this.device, url).then((texture) => {
          this.loadingTiles.delete(key)
          if (!texture) return

          const bounds = tileBounds(coord)
          const tileUniform = this.device.createBuffer({
            size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
          this.device.queue.writeBuffer(tileUniform, 0, new Float32Array([
            bounds.west, bounds.south, bounds.east, bounds.north,
          ]))

          const bindGroup = this.device.createBindGroup({
            layout: this.tileBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: tileUniform } }],
          })

          this.tileCache.set(key, { texture, bindGroup, tileUniform })
        })
      }
    }

    // Write global uniforms
    const uniformData = new ArrayBuffer(128)
    new Float32Array(uniformData, 0, 16).set(mvp)
    new Float32Array(uniformData, 64, 4).set([projType, projCenterLon, projCenterLat, 0])
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData)

    pass.setPipeline(this.pipeline)

    // Render cached tiles
    for (const coord of tiles) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      const cached = this.tileCache.get(key)
      if (!cached) continue

      const globalBG = this.device.createBindGroup({
        layout: this.globalBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: cached.texture.createView() },
          { binding: 2, resource: this.sampler },
        ],
      })

      pass.setBindGroup(0, globalBG)
      pass.setBindGroup(1, cached.bindGroup)
      pass.draw(6) // quad = 2 triangles
    }
  }
}
