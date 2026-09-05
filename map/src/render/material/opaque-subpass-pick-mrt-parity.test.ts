// ═══ #2319 — drapers drawn INSIDE the opaque sub-pass must match its attachment count ═══
//
// opaque-pass.ts pushes the rg32uint pick attachment onto EVERY opaque sub-pass when
// `isPickEnabled() && ctx.rt.pickTexture`. WebGPU rejects `setPipeline` when the pipeline's
// fragment target list is not layout-compatible with the pass (target count must equal the
// colour-attachment count), and an invalid sub-pass takes the whole frame's basemap with it.
// CoverageDraper (coverage-material.ts) and PointDraper (point-material.ts) both draw there —
// coverage from the last sub-pass (opaque-pass.ts coverageRenderer.render), tile points from
// the show closure (opaque-pass.ts cs.draw → VTR.emitTilePointsRhi → flushTilePointsRhi) —
// and both shipped ONE-target pipelines, so every frame under `?picking=1` was invalid.
//
// GPU-free: the stub device records each pipeline's colour targets; the stub pass records
// every setPipeline; the assertion is `targets === colorAttachments.length` on every draw.
// The two draw sites below select their pipeline exactly as production does, from
// `pickTargetsEnabled(rhi.caps)` — the same authority the pass attaches its pick MRT from.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { QUALITY, pickTargetsEnabled, type RhiDevice } from '@xgis/engine'
import { opaquePass } from '../passes/opaque-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import { CoverageDraper } from './coverage-material'
import { PointDraper, type PointBatch } from './point-material'

interface StubTarget {
  format: string
  blend?: string
  writeMask?: number
}
interface StubPipeline {
  label?: string
  colorTargets: ReadonlyArray<StubTarget>
}
interface CapturedPass {
  desc: { colorAttachments: unknown[] }
  pipelines: StubPipeline[]
}

const orig = QUALITY.picking
afterEach(() => {
  QUALITY.picking = orig
})

function stubRhi(): RhiDevice {
  return {
    backend: 'webgpu',
    caps: { shaderLanguage: 'wgsl', presentablePassMrt: true, maxSampleCount: 4 },
    createBindGroupLayout: () => ({ __layout: true }),
    createPipeline: (d: { label?: string; colorTargets: ReadonlyArray<StubTarget> }) =>
      ({ label: d.label, colorTargets: d.colorTargets }) as StubPipeline,
    createBuffer: () => ({ __buf: true }),
    writeBuffer: () => {},
    destroyBuffer: () => {},
    createBindGroup: () => ({ __bg: true }),
    createSampler: () => ({ __samp: true }),
  } as unknown as RhiDevice
}

function run(opts: { pick: boolean }) {
  const rhi = stubRhi()
  const coverage = new CoverageDraper(rhi, 'bgra8unorm', 4)
  const point = new PointDraper(rhi, 'bgra8unorm', 4, [
    { stride: 96, attributes: [{ location: 0, offset: 0, format: 'float32x4' }] },
  ])
  const buf = {} as PointBatch['vertex']
  const batch: PointBatch = {
    uniform: buf,
    feat: buf,
    shape: buf,
    seg: buf,
    vertex: buf,
    index: buf,
    indexCount: 6,
    variant: 0,
  }

  const captured: CapturedPass[] = []
  const beginRenderPass = vi.fn((desc: CapturedPass['desc']) => {
    const p = {
      desc,
      pipelines: [] as StubPipeline[],
      setPipeline(pl: StubPipeline) {
        p.pipelines.push(pl)
      },
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      draw() {},
      drawIndexed() {},
      end() {},
    }
    captured.push(p)
    return p
  })
  const enc = { beginRenderPass, __rhiEncoder: true }
  const ctx = {
    rhi,
    rhiEncoder: enc,
    rhiScreenView: { __rhiScreenView: true },
    rhiColorView: { __rhiColorView: true },
    rhiStencilView: { __rhiStencilView: true },
    rhiSceneResolveView: { __rhiSceneResolveView: true },
    rhiColorViewScreen: { __rhiColorView: true },
    passScope: (_label: string, fn: () => void) => fn(),
    useResolve: false,
    rt: { pickTexture: opts.pick ? {} : undefined, pickView: opts.pick ? {} : null },
    projection: makeProjectionToken(0, 0, 0),
    camera: { __camera: true },
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
    overdraw: false,
    _elapsedMs: 0,
  } as unknown as FrameContext
  const host = {
    gpuTimer: undefined,
    _rasterShow: undefined,
    _elapsedMs: 0,
    inputs: undefined,
    camera: {
      globeMode: false,
      zoom: 3,
      centerX: 0,
      centerY: 0,
      getViewForProjection: () => ({ matrix: new Float32Array(16), logDepthFc: 1 }),
    },
    pointRenderer: {},
    rasterRenderer: {
      setOpacity: () => undefined,
      setColorAdjust: () => undefined,
      setResampling: () => undefined,
      hasSource: () => false,
    },
    underOccluder: undefined,
    // The coverage draw site: opaque-pass.ts last sub-pass → CoverageRenderer.render →
    // draper.draw(pass, bytes, bg, nodes, idx, pickTargetsEnabled(caps)) (coverage-renderer.ts).
    coverageRenderer: {
      hasCoverage: () => true,
      render: (pass: unknown) =>
        coverage.draw(
          pass as never,
          new Float32Array(32),
          {} as never,
          {} as never,
          {} as never,
          pickTargetsEnabled(rhi.caps),
        ),
    },
    flowRenderer: null,
    renderer: {
      renderToPass: () => undefined,
      renderGraticuleOverlay: () => undefined,
    },
  }
  const scene = {
    opaqueGroups: [
      {
        shows: [
          {
            show: {},
            fillPhase: 'both',
            // The tile-point draw site: cs.draw(subPass, …, host.pointRenderer, …) →
            // VTR.emitTilePointsRhi → PointRenderer.flushTilePointsRhi →
            // refreshTilePointUniformAndDraw → PointDraper.draw (tile-point-draw.ts).
            draw: (pass: unknown) => point.draw(pass as never, batch, pickTargetsEnabled(rhi.caps)),
          },
        ],
      },
    ],
    resolveOwner: 'none',
    hasPoints: false,
    hasOit: false,
  } as unknown as SceneView

  QUALITY.picking = opts.pick
  opaquePass.execute(ctx, scene, host as never)
  return captured
}

describe('#2319 — opaque sub-pass drapers vs the pick MRT attachment', () => {
  it('picking OFF: one attachment, and every pipeline set in the sub-pass has one target', () => {
    const passes = run({ pick: false })
    expect(passes.length).toBe(1)
    const p = passes[0]!
    expect(p.desc.colorAttachments.length).toBe(1)
    expect(p.pipelines.map((pl) => pl.label)).toEqual([
      'sdf-point-pipeline-rhi',
      'coverage-ramp-pipeline-rhi',
    ])
    for (const pl of p.pipelines) expect(pl.colorTargets.length).toBe(1)
  })

  it('picking ON: every pipeline set in the sub-pass carries as many targets as attachments', () => {
    const passes = run({ pick: true })
    expect(passes.length).toBe(1)
    const p = passes[0]!
    expect(p.desc.colorAttachments.length, 'pick MRT attached').toBe(2)
    const mismatched = p.pipelines
      .filter((pl) => pl.colorTargets.length !== p.desc.colorAttachments.length)
      .map(
        (pl) =>
          `${pl.label}: ${pl.colorTargets.length} target(s) vs ${p.desc.colorAttachments.length} attachment(s)`,
      )
    expect(
      mismatched,
      'WebGPU setPipeline validation: fragment target count must equal the pass colour-attachment count',
    ).toEqual([])
  })

  it('the pick twins mask the pick target (#1215 — neither carries a feature id)', () => {
    const passes = run({ pick: true })
    for (const pl of passes[0]!.pipelines) {
      expect(pl.colorTargets[1]?.format, `${pl.label} pick target format`).toBe('rg32uint')
      expect(pl.colorTargets[1]?.writeMask, `${pl.label} pick writeMask`).toBe(0)
      expect(pl.colorTargets[0]?.writeMask, `${pl.label} colour writeMask`).not.toBe(0)
    }
  })

  it('both draw sites select the pipeline from pickTargetsEnabled, not a local copy', () => {
    const coverageSrc = readFileSync(new URL('../coverage-renderer.ts', import.meta.url), 'utf8')
    const tilePointSrc = readFileSync(new URL('../tile-point-draw.ts', import.meta.url), 'utf8')
    expect(coverageSrc).toContain('pickTargetsEnabled(this.rhi.caps)')
    expect(tilePointSrc).toContain('pickTargetsEnabled(deps.rhi.caps)')
  })
})
