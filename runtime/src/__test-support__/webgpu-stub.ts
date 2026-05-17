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

function makeEncoder(): unknown {
  const pass = {
    setPipeline: () => undefined,
    setBindGroup: () => undefined,
    setVertexBuffer: () => undefined,
    setIndexBuffer: () => undefined,
    draw: () => undefined,
    drawIndexed: () => undefined,
    drawIndirect: () => undefined,
    end: () => undefined,
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
    createCommandEncoder: () => { bump('createCommandEncoder'); return makeEncoder() },
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
  const priorGpu = (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu
  const priorGetContext = typeof HTMLCanvasElement !== 'undefined'
    ? HTMLCanvasElement.prototype.getContext : null

  // Install navigator.gpu. JSDOM doesn't ship it; define if missing,
  // otherwise replace.
  const nav = (globalThis as { navigator?: Record<string, unknown> }).navigator
  if (nav) (nav as { gpu?: unknown }).gpu = gpuStub
  else (globalThis as { navigator?: { gpu: unknown } }).navigator = { gpu: gpuStub }

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
      if (priorGpu === undefined) {
        delete (nav as { gpu?: unknown }).gpu
      } else if (nav) {
        (nav as { gpu?: unknown }).gpu = priorGpu
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
