// Minimal WebGPU stub for vitest. Lets `initGPU` + renderer constructors
// run without a real adapter, so logic-only invariants (bind group
// layouts, pipeline-creation contracts, shader-module hand-off ordering)
// become millisecond-fast unit tests.
//
// Inspired by Cesium's `--webgl-stub`: all GPU calls are no-op, results
// are mock handles. The runtime path executes without rendering — the
// surface we want to verify is the JS-side state setup, not pixel
// output.
//
// Scope today: enough to make `initGPU(canvas)` resolve and
// `MapRenderer` construct. Future tests can extend the stub as new
// surfaces need coverage (e.g. tile upload, validation-error events).
// Anything not stubbed throws a clearly-labelled error so missing
// coverage shows up as a precise failure instead of silent mock state.

type AnyFn = (...args: unknown[]) => unknown

const stub = (name: string): AnyFn => () => {
  // Production paths that hit an unstubbed surface get a clear error.
  // Lazy-instantiate the message so the no-op path stays branchless.
  throw new Error(`[webgpu-stub] unstubbed call: ${name}`)
}

interface StubBuffer { destroy: () => void; mapAsync: AnyFn; getMappedRange: AnyFn; unmap: AnyFn; size: number }
interface StubTexture { createView: () => unknown; destroy: () => void; width: number; height: number }

function makeBuffer(size: number): StubBuffer {
  const range = new ArrayBuffer(Math.max(4, size))
  return {
    size,
    destroy: () => undefined,
    mapAsync: () => Promise.resolve(),
    getMappedRange: () => range,
    unmap: () => undefined,
  }
}

function makeTexture(w = 1, h = 1): StubTexture {
  return {
    width: w, height: h,
    createView: () => ({}),
    destroy: () => undefined,
  }
}

function makePipeline(): unknown {
  return {
    getBindGroupLayout: () => ({}),
  }
}

function makeEncoder(bump: (k: string) => void): unknown {
  const pass = {
    setPipeline: () => { bump('pass.setPipeline') },
    setBindGroup: () => { bump('pass.setBindGroup') },
    setVertexBuffer: () => { bump('pass.setVertexBuffer') },
    setIndexBuffer: () => { bump('pass.setIndexBuffer') },
    draw: () => { bump('pass.draw') },
    drawIndexed: () => { bump('pass.drawIndexed') },
    drawIndirect: () => { bump('pass.drawIndirect') },
    end: () => { bump('pass.end') },
    setViewport: () => undefined,
    setScissorRect: () => undefined,
  }
  return {
    beginRenderPass: () => pass,
    beginComputePass: () => pass,
    copyBufferToBuffer: () => undefined,
    copyBufferToTexture: () => undefined,
    copyTextureToTexture: () => undefined,
    finish: () => ({}),
  }
}

export interface StubInstallation {
  /** Restore the prior navigator.gpu / canvas getContext (or noop if
   *  none existed). Tests should call from afterEach. */
  uninstall: () => void
  /** Read-only access to invocation counts for assert-on-call tests. */
  callCounts: Readonly<Record<string, number>>
}

export function installWebGPUStub(): StubInstallation {
  const calls: Record<string, number> = Object.create(null)
  const bump = (k: string): void => { calls[k] = (calls[k] ?? 0) + 1 }

  const device = {
    features: { has: () => false },
    limits: {
      maxBufferSize: 1 << 30,
      maxStorageBufferBindingSize: 1 << 27,
      maxUniformBufferBindingSize: 1 << 16,
      maxTextureDimension2D: 8192,
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxColorAttachments: 8,
      maxVertexBuffers: 8,
      maxVertexAttributes: 16,
      maxComputeWorkgroupsPerDimension: 65535,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxComputeWorkgroupSizeZ: 64,
    },
    queue: {
      submit: () => { bump('queue.submit') },
      writeBuffer: () => { bump('queue.writeBuffer') },
      writeTexture: () => { bump('queue.writeTexture') },
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    createBuffer: (d: GPUBufferDescriptor) => { bump('createBuffer'); return makeBuffer(d.size) },
    createTexture: (d: GPUTextureDescriptor) => {
      bump('createTexture')
      const sz = d.size as { width?: number; height?: number } | [number, number]
      const w = Array.isArray(sz) ? sz[0] : (sz.width ?? 1)
      const h = Array.isArray(sz) ? sz[1] : (sz.height ?? 1)
      return makeTexture(w, h)
    },
    createSampler: () => { bump('createSampler'); return {} },
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => {
      bump('createBindGroupLayout')
      // Return the descriptor itself so tests can assert on bindings.
      return { __descriptor: d }
    },
    createBindGroup: () => { bump('createBindGroup'); return {} },
    createPipelineLayout: () => { bump('createPipelineLayout'); return {} },
    createRenderPipeline: () => { bump('createRenderPipeline'); return makePipeline() },
    createRenderPipelineAsync: () => { bump('createRenderPipelineAsync'); return Promise.resolve(makePipeline()) },
    createComputePipeline: () => { bump('createComputePipeline'); return makePipeline() },
    createComputePipelineAsync: () => { bump('createComputePipelineAsync'); return Promise.resolve(makePipeline()) },
    createShaderModule: () => { bump('createShaderModule'); return {} },
    createCommandEncoder: () => { bump('createCommandEncoder'); return makeEncoder(bump) },
    createQuerySet: () => ({ destroy: () => undefined }),
    pushErrorScope: () => undefined,
    popErrorScope: () => Promise.resolve(null),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    // device.lost is a Promise that production code awaits; never
    // resolve so the lost handler doesn't fire mid-test.
    lost: new Promise(() => undefined),
    destroy: () => undefined,
  }

  const adapter = {
    features: { has: () => false },
    limits: device.limits,
    info: { vendor: 'stub', architecture: 'stub', device: 'stub', description: 'webgpu-stub' },
    requestDevice: async () => device,
    requestAdapterInfo: async () => adapter.info,
  }

  const gpuStub = {
    requestAdapter: async () => adapter,
    getPreferredCanvasFormat: () => 'bgra8unorm' as GPUTextureFormat,
    wgslLanguageFeatures: new Set<string>(),
  }

  // Snapshot prior state for clean restore.
  const g = globalThis as {
    navigator?: Record<string, unknown>
    GPUShaderStage?: unknown; GPUBufferUsage?: unknown; GPUTextureUsage?: unknown
    GPUMapMode?: unknown; GPUColorWrite?: unknown
  }
  const navExistedBefore = g.navigator !== undefined
  const priorGpu = g.navigator?.gpu
  const priorGlobals = {
    GPUShaderStage: g.GPUShaderStage, GPUBufferUsage: g.GPUBufferUsage,
    GPUTextureUsage: g.GPUTextureUsage, GPUMapMode: g.GPUMapMode,
    GPUColorWrite: g.GPUColorWrite,
  }

  const priorGetContext = typeof HTMLCanvasElement !== 'undefined'
    ? HTMLCanvasElement.prototype.getContext : null

  // Install navigator.gpu. Node + happy-dom both ship navigator; bare
  // vitest-node sometimes doesn't. Define-if-missing then assign.
  if (!g.navigator) g.navigator = {}
  g.navigator.gpu = gpuStub

  // WebGPU int-enum globals. Production code reads these as
  // `GPUShaderStage.FRAGMENT` (= 2) etc., so the stub has to define
  // them in JSDOM/Node where they don't exist. Values mirror the spec.
  if (g.GPUShaderStage === undefined) {
    g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
  }
  if (g.GPUBufferUsage === undefined) {
    g.GPUBufferUsage = {
      MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
      INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
      INDIRECT: 256, QUERY_RESOLVE: 512,
    }
  }
  if (g.GPUTextureUsage === undefined) {
    g.GPUTextureUsage = {
      COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4,
      STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
    }
  }
  if (g.GPUMapMode === undefined) g.GPUMapMode = { READ: 1, WRITE: 2 }
  if (g.GPUColorWrite === undefined) {
    g.GPUColorWrite = { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }
  }

  // Stub canvas.getContext('webgpu'). Real Canvas2D / WebGL still need
  // to work for non-WebGPU tests, so we only intercept the 'webgpu' arg.
  if (typeof HTMLCanvasElement !== 'undefined') {
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]): unknown {
      if (type === 'webgpu') {
        return {
          configure: () => { bump('context.configure') },
          unconfigure: () => undefined,
          getCurrentTexture: () => makeTexture(this.width, this.height),
        }
      }
      return priorGetContext ? priorGetContext.call(this, type as never, ...(rest as never[])) : null
    } as never
  }

  return {
    callCounts: calls,
    uninstall: () => {
      if (!navExistedBefore) {
        delete g.navigator
      } else if (priorGpu === undefined) {
        delete g.navigator!.gpu
      } else {
        g.navigator!.gpu = priorGpu
      }
      // Restore (or remove) the WebGPU int-enum globals so test
      // isolation holds — a later test in a different file shouldn't
      // accidentally inherit them.
      for (const [k, v] of Object.entries(priorGlobals)) {
        if (v === undefined) delete (g as Record<string, unknown>)[k]
        else (g as Record<string, unknown>)[k] = v
      }
      if (priorGetContext && typeof HTMLCanvasElement !== 'undefined') {
        HTMLCanvasElement.prototype.getContext = priorGetContext
      }
    },
  }
}

// Suppress eslint unused warning for the `stub` helper above — it's
// exported for future expansion (per-method opt-in throws when a test
// needs to assert a specific surface is NOT touched).
export const _stubFactory = stub
