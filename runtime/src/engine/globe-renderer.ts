// ═══ Globe Renderer — 2-Pass: Flat texture → Sphere mesh ═══
//
// Pass 1: 평면 지도 (Equirectangular) → 오프스크린 텍스처
// Pass 2: 구체 메시에 텍스처 매핑 → 화면

import type { GPUContext } from './gpu'
import { generateGlobeMesh, type SphereMesh } from './globe-mesh'

// ═══ Sphere Shader ═══

const GLOBE_SHADER = /* wgsl */ `
struct Uniforms {
  view_proj: mat4x4<f32>,
  model: mat4x4<f32>,
  light_dir: vec4<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var map_texture: texture_2d<f32>;
@group(0) @binding(2) var map_sampler: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
}

@vertex
fn vs_globe(
  @location(0) position: vec3<f32>,
  @location(1) uv: vec2<f32>,
) -> VsOut {
  var out: VsOut;
  let world_pos = u.model * vec4<f32>(position, 1.0);
  out.pos = u.view_proj * world_pos;
  out.uv = uv;
  out.normal = normalize(position); // sphere normal = normalized position
  return out;
}

@fragment
fn fs_globe(input: VsOut) -> @location(0) vec4<f32> {
  let tex_color = textureSample(map_texture, map_sampler, input.uv);

  // If texture is empty/black, show UV debug colors
  let color = select(tex_color, vec4<f32>(input.uv.x, input.uv.y, 0.3, 1.0), tex_color.a < 0.01);

  // Simple diffuse lighting
  let ndotl = max(dot(input.normal, u.light_dir.xyz), 0.15);
  return vec4<f32>(color.rgb * ndotl, 1.0);
}
`

// ═══ Globe Renderer Class ═══

export class GlobeRenderer {
  private device: GPUDevice
  private pipeline: GPURenderPipeline
  private bindGroupLayout: GPUBindGroupLayout
  private uniformBuffer: GPUBuffer
  private sampler: GPUSampler
  private depthTexture: GPUTexture | null = null
  private depthW = 0
  private depthH = 0

  // Sphere mesh
  private vertexBuffer: GPUBuffer
  private indexBuffer: GPUBuffer
  private indexCount: number

  // Flat map texture (rendered in Pass 1)
  flatMapTexture: GPUTexture | null = null
  flatMapView: GPUTextureView | null = null
  readonly flatMapSize = 2048

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.canvasFormat = ctx.format

    const module = ctx.device.createShaderModule({ code: GLOBE_SHADER, label: 'globe-shader' })

    this.bindGroupLayout = ctx.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })

    this.pipeline = ctx.device.createRenderPipeline({
      layout: ctx.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_globe',
        buffers: [{
          arrayStride: 20, // 3 floats pos + 2 floats uv = 5 * 4
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
            { shaderLocation: 1, offset: 12, format: 'float32x2' }, // uv
          ],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs_globe',
        targets: [{ format: ctx.format }],
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      label: 'globe-pipeline',
    })

    this.uniformBuffer = ctx.device.createBuffer({
      size: 192, // 3 * mat4x4 (could be less, padded)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.sampler = ctx.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    })

    // Generate sphere mesh
    const mesh = generateGlobeMesh(80, 160, 1.0)
    this.vertexBuffer = ctx.device.createBuffer({
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    ctx.device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices)

    this.indexBuffer = ctx.device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    ctx.device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices)
    this.indexCount = mesh.indexCount

    // Create flat map render target texture
    this.createFlatMapTexture()
  }

  private canvasFormat: GPUTextureFormat

  private createFlatMapTexture(): void {
    const size = this.flatMapSize
    // Must match canvas format so fill/line pipelines are compatible
    this.flatMapTexture = this.device.createTexture({
      size: { width: size, height: size },
      format: this.canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'flat-map-texture',
    })
    this.flatMapView = this.flatMapTexture.createView()
  }

  /** Get the flat map texture view for Pass 1 rendering */
  getFlatMapTarget(): GPUTextureView {
    return this.flatMapView!
  }

  /** Get the flat map format (matches canvas format for pipeline compatibility) */
  getFlatMapFormat(): GPUTextureFormat {
    return this.canvasFormat
  }

  /** Render the sphere with the flat map texture */
  render(
    encoder: GPUCommandEncoder,
    outputView: GPUTextureView,
    canvasWidth: number,
    canvasHeight: number,
    centerLon: number,
    centerLat: number,
    zoom: number,
  ): void {
    this.ensureDepth(canvasWidth, canvasHeight)

    // Camera: orbit around the sphere
    const distance = 3.0 / Math.pow(2, Math.max(0, zoom - 1))
    const lonRad = centerLon * Math.PI / 180
    const latRad = centerLat * Math.PI / 180

    // Eye position: on the surface looking toward center
    const eyeX = distance * Math.cos(latRad) * Math.sin(lonRad)
    const eyeY = distance * Math.sin(latRad)
    const eyeZ = distance * Math.cos(latRad) * Math.cos(lonRad)

    const viewProj = createViewProjectionMatrix(
      eyeX, eyeY, eyeZ,
      0, 0, 0, // look at origin
      0, 1, 0, // up
      Math.PI / 4, // fov
      canvasWidth / canvasHeight,
      0.01, 100,
    )

    // Model matrix: identity (sphere at origin)
    // prettier-ignore
    const model = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ])

    // Light direction (from camera direction, slightly offset)
    const lightDir = normalize3([eyeX, eyeY + 0.5, eyeZ])

    // Write uniforms
    const data = new ArrayBuffer(192)
    new Float32Array(data, 0, 16).set(viewProj)
    new Float32Array(data, 64, 16).set(model)
    new Float32Array(data, 128, 4).set([lightDir[0], lightDir[1], lightDir[2], 0])
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data)

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.flatMapView! },
        { binding: 2, resource: this.sampler },
      ],
    })

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture!.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 1.0,
      },
    })

    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint32')
    pass.drawIndexed(this.indexCount)
    pass.end()
  }

  private ensureDepth(w: number, h: number): void {
    if (this.depthTexture && this.depthW === w && this.depthH === h) return
    this.depthTexture?.destroy()
    this.depthTexture = this.device.createTexture({
      size: { width: w, height: h },
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.depthW = w
    this.depthH = h
  }
}

// ═══ Math helpers ═══

function createViewProjectionMatrix(
  eyeX: number, eyeY: number, eyeZ: number,
  targetX: number, targetY: number, targetZ: number,
  upX: number, upY: number, upZ: number,
  fov: number, aspect: number, near: number, far: number,
): Float32Array {
  // View matrix (lookAt)
  let fx = targetX - eyeX, fy = targetY - eyeY, fz = targetZ - eyeZ
  let len = Math.sqrt(fx * fx + fy * fy + fz * fz)
  fx /= len; fy /= len; fz /= len

  let sx = fy * upZ - fz * upY, sy = fz * upX - fx * upZ, sz = fx * upY - fy * upX
  len = Math.sqrt(sx * sx + sy * sy + sz * sz)
  sx /= len; sy /= len; sz /= len

  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx

  // Projection matrix (perspective, WebGPU Z [0,1])
  const f = 1 / Math.tan(fov / 2)
  const rangeInv = 1 / (near - far)

  // Combined VP = P * V (column-major)
  // prettier-ignore
  const view = [
    sx,  ux,  -fx, 0,
    sy,  uy,  -fy, 0,
    sz,  uz,  -fz, 0,
    -(sx*eyeX + sy*eyeY + sz*eyeZ),
    -(ux*eyeX + uy*eyeY + uz*eyeZ),
    (fx*eyeX + fy*eyeY + fz*eyeZ),
    1,
  ]

  // prettier-ignore
  const proj = [
    f/aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far*rangeInv, -1,
    0, 0, near*far*rangeInv, 0,
  ]

  // Multiply P * V
  const result = new Float32Array(16)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += proj[k * 4 + r] * view[c * 4 + k]
      }
      result[c * 4 + r] = sum
    }
  }
  return result
}

function normalize3(v: number[]): number[] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  return [v[0] / len, v[1] / len, v[2] / len]
}
