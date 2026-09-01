// ═══ Atmosphere pass wiring (#1258) ═══
//
// shouldRun is `scene.hasAtmosphere` (pinned separately, scene-view.test.ts — the AND of
// the style flag and `camera.globeMode`). This file pins execute(): it draws into the
// SCENE colour attachment (`colorView` — the target `background` just cleared) with
// `loadOp: 'load'` and no resolve, no depth-stencil, and no-ops (encodes nothing) when
// the camera has no usable ray field for this frame, mirroring the harness shape
// `scene-upscale-rhi-wiring.test.ts` uses for the sibling fullscreen pass.

import { describe, it, expect, vi } from 'vitest'
import { uniformBlock } from '@xgis/engine'
import { atmospherePass } from './atmosphere-pass'
import { makeProjectionToken } from '../projection-token'
import { atmosphereU } from '../../shaders/dsl/atmosphere'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

/** A symmetric OpenGL-style perspective projection, column-major, NO view/translation —
 *  a real, non-degenerate camera matrix (same construction atmosphere-uniform.test.ts
 *  verifies against `atmosphereCameraRays` directly). */
function perspectiveOnly(near: number, far: number, f: number): Float32Array {
  // prettier-ignore
  return new Float32Array([
    f, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ])
}

/** An orthographic (affine) matrix — no perspective term, so `atmosphereCameraRays`
 *  returns `null` (no finite eye). Used to pin the "degenerate matrix ⇒ no-op" arm. */
const ORTHOGRAPHIC = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

interface CapturedPass {
  desc: Record<string, unknown>
  ended: boolean
  draws: number[]
}

/** #2052 — the sky sub-block as `_atmosphere` carries it. */
interface HostSky {
  color: [number, number, number, number]
  horizonColor: [number, number, number, number]
  horizonBlend: number
}

function harness(
  opts: {
    atmosphere?: boolean
    globeMode?: boolean
    matrix?: Float32Array
    rawShell?: boolean
    sky?: HostSky
  } = {},
) {
  const captured: CapturedPass[] = []
  const beginRenderPass = vi.fn((desc: Record<string, unknown>) => {
    const p = {
      desc,
      ended: false,
      draws: [] as number[],
      end() {
        p.ended = true
      },
      setPipeline: () => undefined,
      setBindGroup: () => undefined,
      setVertexBuffer: () => undefined,
      draw(count: number) {
        p.draws.push(count)
      },
    }
    captured.push(p as unknown as CapturedPass)
    return p
  })
  const enc = { beginRenderPass, __rhiEncoder: true }
  const colorView = { __rhiColorView: true }
  const ctx = {
    rhiEncoder: opts.rawShell ? null : enc,
    rhiScreenView: opts.rawShell ? null : { __rhiScreenView: true },
    rhiColorView: opts.rawShell ? null : colorView,
    rhiStencilView: opts.rawShell ? null : { __rhiStencilView: true },
    rhiSceneResolveView: opts.rawShell ? null : { __rhiSceneResolveView: true },
    rhiColorViewScreen: opts.rawShell ? null : { __rhiColorViewScreen: true },
    passScope: (_l: string, fn: () => void) => fn(),
    projection: makeProjectionToken(7, 20, 30),
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
    sampleCount: 4,
    useResolve: true,
  } as unknown as FrameContext
  const bindGroups: { entries: { binding: number; resource: unknown }[] }[] = []
  const buffers: { size: number; usage: string }[] = []
  const writes: { buf: unknown; bytes: ArrayBuffer }[] = []
  const rhi = {
    backend: 'webgpu',
    caps: { shaderLanguage: 'wgsl' },
    createBindGroupLayout: () => ({}),
    createPipeline: () => ({}),
    createBindGroup: (_layout: unknown, entries: { binding: number; resource: unknown }[]) => {
      bindGroups.push({ entries })
      return { __bg: true }
    },
    createBuffer: (desc: { size: number; usage: string }) => {
      buffers.push(desc)
      return { __buf: buffers.length }
    },
    writeBuffer: (buf: unknown, _offset: number, bytes: ArrayBuffer) => {
      writes.push({ buf, bytes })
    },
  }
  const matrix = opts.matrix ?? perspectiveOnly(1, 100, 1)
  const host = {
    _atmosphere:
      opts.atmosphere === false
        ? null
        : {
            innerColor: [0.55, 0.75, 1, 0.9],
            outerColor: [0.02, 0.05, 0.12, 0],
            sky: opts.sky ?? null,
          },
    camera: {
      globeMode: opts.globeMode ?? true,
      getViewForProjection: () => ({ matrix, far: 1e7, logDepthFc: 1 }),
    },
    ctx: { rhi, format: 'bgra8unorm' },
  }
  const scene = {} as unknown as SceneView
  return { ctx, host, scene, captured, beginRenderPass, bindGroups, buffers, writes, colorView }
}

describe('atmosphere pass (#1258)', () => {
  it('shouldRun mirrors scene.hasAtmosphere exactly', () => {
    expect(atmospherePass.shouldRun({ hasAtmosphere: false } as never)).toBe(false)
    expect(atmospherePass.shouldRun({ hasAtmosphere: true } as never)).toBe(true)
  })

  it('draws into the scene colour attachment: load (not clear), no resolve, no depth', () => {
    const h = harness()
    atmospherePass.execute(h.ctx, h.scene, h.host as never)
    expect(h.beginRenderPass).toHaveBeenCalledTimes(1)
    const desc = h.captured[0]!.desc
    const colors = desc.colorAttachments as {
      view: unknown
      resolveTarget?: unknown
      loadOp: string
      storeOp: string
    }[]
    expect(colors).toHaveLength(1)
    expect(colors[0]!.view).toBe(h.colorView)
    expect(colors[0]!.loadOp).toBe('load')
    expect(colors[0]!.storeOp).toBe('store')
    expect(colors[0]!.resolveTarget).toBeUndefined()
    expect(desc.depthStencilAttachment).toBeUndefined()
    expect(h.captured[0]!.ended).toBe(true)
    // The fullscreen triangle.
    expect(h.captured[0]!.draws).toEqual([3])
    // The per-frame uniform buffer was written, then bound.
    expect(h.buffers).toHaveLength(1)
    expect(h.writes).toHaveLength(1)
    // The bind group's buffer resource is the SAME object writeBuffer just wrote into —
    // not merely "some buffer exists".
    const entries = h.bindGroups.at(-1)!.entries
    expect(
      entries.some((e) => (e.resource as { buffer?: unknown }).buffer === h.writes[0]!.buf),
    ).toBe(true)
  })

  it('no-ops when the style flag is off, even on a globe camera', () => {
    const h = harness({ atmosphere: false })
    atmospherePass.execute(h.ctx, h.scene, h.host as never)
    expect(h.beginRenderPass).not.toHaveBeenCalled()
  })

  it('no-ops off the 3D globe camera, even with the style flag on (#1258 — not worldBand alone)', () => {
    const h = harness({ globeMode: false })
    atmospherePass.execute(h.ctx, h.scene, h.host as never)
    expect(h.beginRenderPass).not.toHaveBeenCalled()
  })

  it('no-ops on a degenerate (orthographic) camera matrix — no finite ray field this frame', () => {
    const h = harness({ matrix: ORTHOGRAPHIC })
    atmospherePass.execute(h.ctx, h.scene, h.host as never)
    expect(h.beginRenderPass).not.toHaveBeenCalled()
  })
})

// ═══ #2052 T5 Phase 1 — the `sky` root reaches the GPU ═══
//
// The shader gates its whole zenith ramp on `sky_params.y` (see shaders/dsl/atmosphere.ts:
// a BRANCH, so the sky-off frame is bit-identical rather than arithmetically-equal). That
// flag is therefore the wire this phase adds, and it is asserted on the BYTES the pass
// actually uploads — read back at the reflected field offset, not at a hand-counted one, so
// a field reordered in the uniform struct fails here instead of silently mis-binding.
//
// Both arms are cut separately: the ON arm proves the values travel, the OFF arm proves the
// flag is 0 AND that the colour slots are still rewritten (the staging block is one shared
// buffer — an unwritten slot would ship the previous frame's, or another map's, bytes).
describe('atmosphere pass — the MapLibre sky root (#2052)', () => {
  const block = uniformBlock(atmosphereU)
  const readVec4 = (bytes: ArrayBuffer, field: 'sky_color' | 'horizon_color' | 'sky_params') =>
    Array.from(new Float32Array(bytes, block.fieldOffset(field), 4))

  const SKY: HostSky = {
    color: [0.1, 0.2, 0.3, 1],
    horizonColor: [0.9, 0.8, 0.7, 0.6],
    horizonBlend: 0.25,
  }

  it('uploads the authored sky colours and turns the enable flag ON', () => {
    const h = harness({ sky: SKY })
    atmospherePass.execute(h.ctx, h.scene, h.host as never)
    const bytes = h.writes[0]!.bytes
    expect(readVec4(bytes, 'sky_color').map((n) => +n.toFixed(6))).toEqual([0.1, 0.2, 0.3, 1])
    expect(readVec4(bytes, 'horizon_color').map((n) => +n.toFixed(6))).toEqual([0.9, 0.8, 0.7, 0.6])
    expect(readVec4(bytes, 'sky_params').map((n) => +n.toFixed(6))).toEqual([0.25, 1, 0, 0])
  })

  it('with no sky authored the flag is OFF and every colour slot is still rewritten', () => {
    const h = harness()
    atmospherePass.execute(h.ctx, h.scene, h.host as never)
    const bytes = h.writes[0]!.bytes
    expect(readVec4(bytes, 'sky_params')[1], 'the sky ramp must be gated OUT').toBe(0)
    expect(readVec4(bytes, 'sky_color')).toEqual([0, 0, 0, 0])
    expect(readVec4(bytes, 'horizon_color')).toEqual([0, 0, 0, 0])
  })

  it('the sky rides the SAME uniform buffer and pass as the glow — no second draw', () => {
    const h = harness({ sky: SKY })
    atmospherePass.execute(h.ctx, h.scene, h.host as never)
    // The design doc's load-bearing claim: rows 1–3 are one evaluator in ONE pass. A second
    // render pass or a second buffer here would mean the sky had grown its own pipeline.
    expect(h.beginRenderPass).toHaveBeenCalledTimes(1)
    expect(h.buffers).toHaveLength(1)
    expect(h.captured[0]!.draws).toEqual([3])
  })
})
