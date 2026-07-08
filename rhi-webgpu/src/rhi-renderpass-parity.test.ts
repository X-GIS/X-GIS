import { describe, it, expect } from 'vitest'
import { rhiRenderPassToGpu, wrapWebGpuTextureView } from './rhi-webgpu'
import { WebGl2Device } from '@xgis/rhi-webgl2'
import type { RhiTextureView } from '@xgis/rhi'

// P0.3 (engine/content split — RHI contract gap #2) byte-identity gate.
//
// The new offscreen / MRT contract (RhiRenderPassDesc + RhiCommandEncoder.
// beginRenderPass) must map to the SAME GPURenderPassDescriptor the passes/
// bodies hand-build today, so routing the whole passes/ topology through the RHI
// at P1 is byte-for-byte the current raw `encoder.beginRenderPass` path — no
// attachment / load-op / resolve drift. rhiRenderPassToGpu is pure, so this
// asserts the mapping WITHOUT a GPUDevice (exactly like rhi-stencil-parity).
//
// Each case mirrors ONE real pass's inline descriptor (file:line noted). View
// handles are sentinels (wrapWebGpuTextureView over a tag string); the mapper
// unwraps them, so the EXPECTED descriptor carries the same tags — proving the
// view threads to the right slot AND the load/store/clear/resolve map exactly.
// toEqual ignores the mapper's `undefined` fields, so the expected is written as
// the LITERAL raw inline shape (a missing key ≡ an undefined one).

const view = (tag: string): RhiTextureView =>
  wrapWebGpuTextureView(tag as unknown as GPUTextureView)
const COLOR = view('color')
const SCREEN = view('screen')
const PICK = view('pick')
const STENCIL = view('stencil')
const ACCUM = view('accum')
const REVEAL = view('reveal')
const OFF = view('off')

describe('rhiRenderPassToGpu — byte-identity vs the raw passes/ descriptors', () => {
  it('background pass — 1 colour, clear, no resolve, no depth (background-pass.ts:86)', () => {
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [
          { view: COLOR, loadOp: 'clear', storeOp: 'store', clearValue: [0.1, 0.2, 0.3, 1] },
        ],
      }),
    ).toEqual({
      colorAttachments: [
        {
          view: 'color',
          clearValue: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
  })

  it('opaque first sub-pass + pick MRT — depth+stencil clear, no resolve (opaque-pass.ts:98)', () => {
    // isFirst=true, pick enabled, resolveHere=false, persistDepth=true (hasPoints).
    // The raw color[0] carries `resolveTarget: undefined`; the mapper emits the same.
    // timestampWrites (the no-timer frame's `undefined`) is intentionally NOT
    // modelled — profiling threads through the gpuTimer seam at the call-site.
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [
          { view: COLOR, loadOp: 'load', storeOp: 'store' },
          { view: PICK, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        depthStencilAttachment: {
          view: STENCIL,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      }),
    ).toEqual({
      colorAttachments: [
        { view: 'color', resolveTarget: undefined, loadOp: 'load', storeOp: 'store' },
        { view: 'pick', clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: {
        view: 'stencil',
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    })
  })

  it('opaque last sub-pass — resolveTarget set, depth load/discard (opaque-pass.ts:98)', () => {
    // resolveHere=true (resolveOwner==='opaque'), isFirst=false, persistDepth=false.
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [
          { view: COLOR, resolveTarget: SCREEN, loadOp: 'load', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: STENCIL,
          depthClearValue: 1.0,
          depthLoadOp: 'load',
          depthStoreOp: 'discard',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      }),
    ).toEqual({
      colorAttachments: [
        { view: 'color', resolveTarget: 'screen', loadOp: 'load', storeOp: 'store' },
      ],
      depthStencilAttachment: {
        view: 'stencil',
        depthClearValue: 1.0,
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    })
  })

  it('OIT-fill — accum+revealage MRT, depth load/discard with NO clear values (oit-pass.ts:32)', () => {
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [
          { view: ACCUM, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
          { view: REVEAL, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 0, 0] },
        ],
        depthStencilAttachment: {
          view: STENCIL,
          depthLoadOp: 'load',
          depthStoreOp: 'discard',
          stencilLoadOp: 'load',
          stencilStoreOp: 'discard',
        },
      }),
    ).toEqual({
      colorAttachments: [
        {
          view: 'accum',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: 'reveal',
          clearValue: { r: 1, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: 'stencil',
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
        stencilLoadOp: 'load',
        stencilStoreOp: 'discard',
      },
    })
  })

  it('points — 1 colour resolve, depth load + stencil clear (points-pass.ts:25)', () => {
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [
          { view: COLOR, resolveTarget: SCREEN, loadOp: 'load', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: STENCIL,
          depthClearValue: 1.0,
          depthLoadOp: 'load',
          depthStoreOp: 'discard',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      }),
    ).toEqual({
      colorAttachments: [
        { view: 'color', resolveTarget: 'screen', loadOp: 'load', storeOp: 'store' },
      ],
      depthStencilAttachment: {
        view: 'stencil',
        depthClearValue: 1.0,
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    })
  })

  it('label / translucent-comp / oit-compose — 1 colour load, resolveTarget set, no depth (label-pass.ts:1167)', () => {
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [
          { view: COLOR, resolveTarget: SCREEN, loadOp: 'load', storeOp: 'store' },
        ],
      }),
    ).toEqual({
      colorAttachments: [
        { view: 'color', resolveTarget: 'screen', loadOp: 'load', storeOp: 'store' },
      ],
    })
  })

  it('composite without resolve — resolveTarget undefined ≡ omitted (oit-pass.ts:71 / translucent-pass.ts:45)', () => {
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [{ view: COLOR, loadOp: 'load', storeOp: 'store' }],
      }),
    ).toEqual({
      colorAttachments: [{ view: 'color', loadOp: 'load', storeOp: 'store' }],
    })
  })

  it('line offscreen MAX pass — labelled, 1 colour clear, no depth (line-renderer.ts:418)', () => {
    expect(
      rhiRenderPassToGpu({
        label: 'line-translucent-pass',
        colorAttachments: [
          { view: OFF, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      }),
    ).toEqual({
      label: 'line-translucent-pass',
      colorAttachments: [
        { view: 'off', clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
    })
  })

  it('heatmap accum / blur — offscreen r16float clear, no depth (heatmap-pass.ts:62)', () => {
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [
          { view: ACCUM, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      }),
    ).toEqual({
      colorAttachments: [
        {
          view: 'accum',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
  })

  it('heatmap compose — screenView load, no clear, no resolve (heatmap-pass.ts:124)', () => {
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [{ view: SCREEN, loadOp: 'load', storeOp: 'store' }],
      }),
    ).toEqual({
      colorAttachments: [{ view: 'screen', loadOp: 'load', storeOp: 'store' }],
    })
  })

  it('overdraw-compose — screenView clear {0,0,0,1} (overdraw-compose-pass.ts:26)', () => {
    expect(
      rhiRenderPassToGpu({
        colorAttachments: [
          { view: SCREEN, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
      }),
    ).toEqual({
      colorAttachments: [
        {
          view: 'screen',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
  })
})

// ── WebGL2 fail-close (the gap #2 boundary) ───────────────────────────────────
// Slice-1 WebGL2 is screen-pass only; the offscreen / MRT topology + the OIT
// rgba16float accum target are the WebGL2 full-frame phase. Both fail CLOSED so a
// pass can never silently fall back to the screen pass and corrupt the frame.

function fakeGl(): WebGL2RenderingContext {
  return {
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
    TEXTURE_2D: 0x0de1,
    createTexture: () => ({}),
    bindTexture: () => {},
  } as unknown as WebGL2RenderingContext
}

describe('WebGl2Device — RHI gap #2 fail-close', () => {
  it('createCommandEncoder returns a copy-scoped encoder whose beginRenderPass throws (offscreen/MRT deferred to the full-frame phase)', () => {
    // The encoder now EXISTS (the GPUArena compaction/grow path needs
    // copyBufferToBuffer = gl.copyBufferSubData), but the offscreen / MRT render
    // pass is still fail-CLOSED — it can never silently originate on WebGL2.
    const enc = new WebGl2Device(fakeGl()).createCommandEncoder()
    expect(enc).toBeDefined()
    expect(() => enc.beginRenderPass({ colorAttachments: [] })).toThrow(
      /beginRenderPass.*not yet supported|full-frame phase/,
    )
  })

  it('createTexture rgba16float (OIT accum) throws — needs EXT_color_buffer_float', () => {
    expect(() =>
      new WebGl2Device(fakeGl()).createTexture({
        width: 8,
        height: 8,
        format: 'rgba16float',
        usage: ['render'],
      }),
    ).toThrow(/rgba16float.*EXT_color_buffer_float|full-frame phase/)
  })
})
