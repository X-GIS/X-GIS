// ═══ #1253 — the LAYER-WIDE translucent-extrude shell: routing + dispatch gate ═══
//
// Issue #1253: #1080's front shell (depth prepass, then depth-`less-equal`
// colour with depth write off) runs per DRAW, and a draw is one TILE. Two
// features in DIFFERENT tiles that overlap on screen therefore each ran their
// own prepass+colour pair and the shared pixel blended TWICE — visible as seam
// darkening on continent-scale extrusions and where neighbouring walls cross on
// the globe limb.
//
// The fix moves the resolution from "within one draw" to "within one layer":
// the bucket scheduler routes a translucent solid extrusion to the shell bucket,
// the shell pass draws its WHOLE tile set into an offscreen colour target with
// blending OFF and the opaque depth loaded (so per pixel only the front-most
// extruded surface across every tile survives), and one fullscreen pass
// composites that target at the layer's fill alpha.
//
// This file is the GPU-free half — the ROUTING decision and the DRAW dispatch it
// selects. The pixel claim (overlap opacity == non-overlap opacity, flat +
// globe) is `playground/e2e/_extrude-overlap-oit-probe.spec.ts`.
//
// FAIL-BEFORE on origin/main:
//   * `const isOitExtrude = false` (bucket-scheduler.ts:352) — the shell bucket
//     is empty for every input, so every routing case here is RED;
//   * `deriveResolveOwner` has no `oit` rung — the msaa resolve-owner case is RED
//     (and on a real msaa>1 frame the composite would be resolved away);
//   * `buildExtrudeMaterial` builds no shell variants and `recordFillDraw` has no
//     `extrudeShell` arm — the dispatch cases are RED.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultRasterShapes } from '@xgis/compiler'
import type { RhiDevice, RhiBuffer } from '@xgis/engine'
import {
  classifyVectorTileShows,
  deriveResolveOwner,
  extrudeFillAlpha,
  type ClassifierInput,
  type ClassifierShowEntry,
  type ClassifierVTSource,
} from './bucket-scheduler'
import type { ShowCommand } from './renderer-types'
import type { ResolvedShow } from './resolved-show'
import {
  buildExtrudeMaterial,
  recordFillDraw,
  type FillRhiState,
  type FillTileBuffers,
} from './material/polygon-fill-material'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = {} as unknown

// ── Fixtures ───────────────────────────────────────────────────────
//
// Minimal, hand-built shows: the classifier reads `paintShapes.common.opacity`
// for the bucket threshold and `resolveShow` reads the rest. The fill colour
// rides `resolvedFillRgba` (the compile-time bake) exactly as a constant-fill
// production show does, so the alpha the predicate sees is the alpha the shell
// composite will multiply by.

interface ShowOpts {
  opacity?: number
  fillAlpha?: number
  extrude?: ShowCommand['extrude']
  stroke?: string | null
  fillPatternUV?: readonly number[] | null
  dataDriven?: boolean
}

function makeShow(o: ShowOpts = {}): ShowCommand {
  const opacity = o.opacity ?? 1
  return {
    targetName: 'src',
    fill: '#334155',
    stroke: o.stroke ?? null,
    visible: true,
    projection: 'mercator',
    resolvedFillRgba: [0.2, 0.25, 0.33, o.fillAlpha ?? 1],
    extrude: o.extrude,
    fillPatternUV: o.fillPatternUV ?? null,
    // `needsFeatureBuffer` is what `variantProducesFill` keys the data-driven
    // arm on; null (the default) is the constant-fill path.
    shaderVariant: o.dataDriven ? { needsFeatureBuffer: true, fillIsDefault: false } : null,
    dashOffsetShape: null,
    paintShapes: {
      fill: { fill: null },
      line: { stroke: null, strokeWidth: { kind: 'constant', value: 1 } },
      circle: { size: null },
      common: { opacity: { kind: 'constant', value: opacity } },
      raster: defaultRasterShapes(),
    },
  } as unknown as ShowCommand
}

const EXTRUDE_CONST = { kind: 'constant', value: 50 } as ShowCommand['extrude']

function classify(shows: ShowCommand[], extrudeShell: boolean) {
  const vtSources = new Map<string, ClassifierVTSource>([
    ['src', { source: {}, renderer: { hasData: () => true } }],
  ])
  const entries: ClassifierShowEntry[] = shows.map((show) => ({
    sourceName: 'src',
    show,
    pipelines: null,
    layout: null,
  }))
  const input: ClassifierInput = {
    vectorTileShows: entries,
    vtSources,
    cameraZoom: 14,
    elapsedMs: 0,
    rendererDefaults: {
      fillPipeline: STUB as GPURenderPipeline,
      linePipeline: STUB as GPURenderPipeline,
      bindGroupLayout: STUB as GPUBindGroupLayout,
    },
    safeMode: false,
    extrudeShell,
  }
  return classifyVectorTileShows(input)
}

describe('#1253 — bucket routing for translucent extrusions', () => {
  it('a TRANSLUCENT solid extrusion routes to the shell bucket, fills off the opaque one', () => {
    const r = classify([makeShow({ extrude: EXTRUDE_CONST, fillAlpha: 0.6 })], true)
    expect(r.oit).toHaveLength(1)
    // It stays in the opaque bucket for its outlines only — 'strokes' is what
    // tells VTR to skip the fill there, so the fill is drawn ONCE, in the shell
    // pass. Without the phase flip the fill would be drawn twice over.
    expect(r.opaque).toHaveLength(1)
    expect(r.opaque[0].fillPhase).toBe('strokes')
  })

  it('an OPAQUE extrusion keeps its opaque-bucket routing, byte-identical', () => {
    const r = classify([makeShow({ extrude: EXTRUDE_CONST, fillAlpha: 1 })], true)
    expect(r.oit).toHaveLength(0)
    expect(r.opaque).toHaveLength(1)
    expect(r.opaque[0].fillPhase).toBe('all')
  })

  it('a translucent NON-extruded fill keeps its opaque-bucket routing', () => {
    const r = classify([makeShow({ fillAlpha: 0.4, opacity: 0.4 })], true)
    expect(r.oit).toHaveLength(0)
    expect(r.opaque[0].fillPhase).toBe('all')
  })

  it('layer OPACITY alone makes an extrusion translucent (not just the fill alpha)', () => {
    const r = classify([makeShow({ extrude: EXTRUDE_CONST, fillAlpha: 1, opacity: 0.5 })], true)
    expect(r.oit).toHaveLength(1)
  })

  it('a translucent extrusion WITH a translucent stroke leaves the opaque bucket entirely', () => {
    // skipOpaque: the fill is the shell pass's, the stroke is the translucent
    // offscreen's, so nothing is left for the opaque bucket to draw.
    const r = classify(
      [makeShow({ extrude: EXTRUDE_CONST, fillAlpha: 0.6, opacity: 0.6, stroke: '#fff' })],
      true,
    )
    expect(r.oit).toHaveLength(1)
    expect(r.translucent).toHaveLength(1)
    expect(r.opaque).toHaveLength(0)
  })

  it('a fill-PATTERN extrusion is excluded — it has no shell pipeline variants', () => {
    // The pattern-extrude Material twin carries only the opaque write/test
    // variants, so routing it to the shell pass would bind a main-target
    // pipeline to the offscreen attachment set. recordFillDraw fail-louds on
    // that; this is the exclusion that keeps it unreachable.
    const r = classify(
      [makeShow({ extrude: EXTRUDE_CONST, fillAlpha: 0.6, fillPatternUV: [0, 0, 1, 1] })],
      true,
    )
    expect(r.oit).toHaveLength(0)
    expect(r.opaque[0].fillPhase).toBe('all')
  })

  it('extrudeShell=false (immediate device / ?debug=overdraw) routes NOTHING to the shell', () => {
    // The distinguishing cut for the gate itself: same show, gate off. A WebGL2
    // device renders no extrusions at all and has no shell compositor; overdraw
    // needs the fills counted in the opaque bucket.
    const r = classify([makeShow({ extrude: EXTRUDE_CONST, fillAlpha: 0.6 })], false)
    expect(r.oit).toHaveLength(0)
    expect(r.opaque[0].fillPhase).toBe('all')
  })

  it('omitting the gate is the pre-#1253 classification (default false)', () => {
    const vtSources = new Map<string, ClassifierVTSource>([
      ['src', { source: {}, renderer: { hasData: () => true } }],
    ])
    const r = classifyVectorTileShows({
      vectorTileShows: [
        {
          sourceName: 'src',
          show: makeShow({ extrude: EXTRUDE_CONST, fillAlpha: 0.6 }),
          pipelines: null,
          layout: null,
        },
      ],
      vtSources,
      cameraZoom: 14,
      elapsedMs: 0,
      rendererDefaults: {
        fillPipeline: STUB as GPURenderPipeline,
        linePipeline: STUB as GPURenderPipeline,
        bindGroupLayout: STUB as GPUBindGroupLayout,
      },
      safeMode: false,
    })
    expect(r.oit).toHaveLength(0)
  })
})

describe('#1253 — extrudeFillAlpha is one authority for routing AND compositing', () => {
  const resolved = (opacity: number, a: number | null): ResolvedShow =>
    ({ opacity, fill: a === null ? null : [0, 0, 0, a] }) as unknown as ResolvedShow

  it('constant fill folds the resolved fill alpha into the layer opacity', () => {
    expect(extrudeFillAlpha(makeShow(), resolved(0.5, 0.8))).toBeCloseTo(0.4, 6)
  })

  it('a data-driven fill computes its colour in-shader, so the layer opacity IS the alpha', () => {
    expect(extrudeFillAlpha(makeShow({ dataDriven: true }), resolved(0.5, 0.8))).toBeCloseTo(0.5, 6)
  })

  it('no resolved fill ⇒ zero, so a fill-less show can never route to the shell', () => {
    expect(extrudeFillAlpha(makeShow(), resolved(1, null))).toBe(0)
  })
})

describe('#1253 — the shell composite joins the msaa resolve-owner chain', () => {
  // The hillshade class of bug, one pass over: the shell composite writes colour
  // AFTER the opaque bucket, so if `opaque` kept the resolve at msaa > 1 the
  // composite would land in samples that were already resolved to the swapchain
  // and every translucent extrusion would silently vanish.
  it('a shell-only frame gives the resolve to the shell composite, not the opaque pass', () => {
    expect(
      deriveResolveOwner({
        hasPoints: false,
        hasHillshade: false,
        hasTranslucent: false,
        hasOit: true,
      }),
    ).toBe('oit')
  })

  it('every LATER colour writer still outranks it', () => {
    const base = { hasPoints: false, hasHillshade: false, hasTranslucent: false, hasOit: true }
    expect(deriveResolveOwner({ ...base, hasTranslucent: true })).toBe('composite')
    expect(deriveResolveOwner({ ...base, hasHillshade: true })).toBe('hillshade')
    expect(deriveResolveOwner({ ...base, hasPoints: true })).toBe('points')
  })

  it('no shell content ⇒ the pre-#1253 answer, unchanged', () => {
    expect(
      deriveResolveOwner({ hasPoints: false, hasHillshade: false, hasTranslucent: false }),
    ).toBe('opaque')
  })
})

// ── The DRAW the routing selects ───────────────────────────────────
//
// Routing to the shell bucket is only half the claim; the other half is that the
// shell phase emits ONE colour-replace draw instead of #1080's prepass+colour
// pair. Cut each mechanism separately (§12: one cut only ever proves one
// message) — the shell arm must emit the shell variant and nothing else, and the
// front-shell arm must be untouched by the new parameter.

interface FakePipe {
  native: { label?: string }
}

function extrudeMaterialWithFakeDevice(): {
  mat: ReturnType<typeof buildExtrudeMaterial>
  labels: string[]
} {
  const labels: string[] = []
  const rhi = {
    createPipeline: (d: { label?: string }): FakePipe => {
      labels.push(d.label ?? '?')
      return { native: { label: d.label } }
    },
  } as unknown as RhiDevice
  const mat = buildExtrudeMaterial({
    rhi,
    shader: 'STUB_WGSL',
    format: 'bgra8unorm',
    sampleCount: 4,
    bindGroupLayout: {} as unknown as GPUBindGroupLayout,
    vertexLayout: {
      arrayStride: 56,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
    } as unknown as GPUVertexBufferLayout,
    pickEnabled: true,
  })
  return { mat, labels }
}

/** Record one extrude fill draw through the real `recordFillDraw` and report the
 *  pipeline LABELS that reached `setPipeline`, in order. The encoder is a fresh
 *  object per call — `wrapWebGpuPassMemoized` keys its wrapper on identity. */
function drawnPipelineLabels(opts: { frontShell: boolean; shell: boolean }): string[] {
  const { mat } = extrudeMaterialWithFakeDevice()
  const write = { label: 'fill-pipeline-extruded' }
  const state: FillRhiState = {
    flat: null,
    ground: null,
    pipes: null,
    perStyle: null,
    perStyleExtrude: null,
    perStyleByLabel: null,
    perStyleExtrudeByLabel: null,
    extrude: { mat, write, test: { label: 'fill-pipeline-extruded-fallback' } },
    pattern: null,
    split: null,
  }
  const seen: string[] = []
  const encoder = {
    setPipeline: (p: { label?: string }) => seen.push(p.label ?? '?'),
    setBindGroup: () => {},
    setVertexBuffer: () => {},
    setIndexBuffer: () => {},
    drawIndexed: () => {},
  } as unknown as GPURenderPassEncoder
  const buf = { native: {} } as unknown as RhiBuffer
  const cached: FillTileBuffers = {
    vertexBuffer: buf,
    polyVertexOffset: 0,
    polyVertexByteLength: 64,
    zBuffer: buf,
    zBufferOffset: 0,
    zBufferByteLength: 16,
    indexBuffer: buf,
    polyIndexOffset: 0,
    polyIndexByteLength: 24,
    indexCount: 6,
  }
  recordFillDraw(
    state,
    encoder,
    write,
    {} as GPUBindGroup,
    0,
    cached,
    /* bindZBuffer */ true,
    opts.frontShell,
    opts.shell,
  )
  return seen
}

describe('#1253 — the shell phase emits ONE colour-replace draw', () => {
  it('extrudeShell ⇒ exactly the shell variant, once (not the prepass+colour pair)', () => {
    expect(drawnPipelineLabels({ frontShell: false, shell: true })).toEqual([
      'fill-extrude-shell-write-rhi',
    ])
  })

  it('#1080 front-shell is untouched: still prepass THEN colour, in that order', () => {
    expect(drawnPipelineLabels({ frontShell: true, shell: false })).toEqual([
      'fill-extrude-depthprepass-write-rhi',
      'fill-extrude-frontshell-write-rhi',
    ])
  })

  it('an opaque extrude draw is still the single base variant', () => {
    expect(drawnPipelineLabels({ frontShell: false, shell: false })).toEqual([
      'fill-extrude-write-rhi',
    ])
  })

  it('the shell variant REPLACES colour — that is what makes overlap idempotent', () => {
    // Blending in the shell target is what would re-introduce the double blend:
    // two tiles covering one pixel would stack, and the composite would then
    // blend the stack. Replace-on-write is order- AND depth-tie-independent.
    const captured: { label?: string; colorTargets: ReadonlyArray<{ blend?: string }> }[] = []
    const rhi = {
      createPipeline: (d: { label?: string; colorTargets: ReadonlyArray<{ blend?: string }> }) => {
        captured.push(d)
        return { native: {} }
      },
    } as unknown as RhiDevice
    buildExtrudeMaterial({
      rhi,
      shader: 'STUB_WGSL',
      format: 'bgra8unorm',
      sampleCount: 4,
      bindGroupLayout: {} as unknown as GPUBindGroupLayout,
      vertexLayout: {
        arrayStride: 56,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
      } as unknown as GPUVertexBufferLayout,
      pickEnabled: true,
    })
    const shell = captured.find((c) => c.label === 'fill-extrude-shell-write-rhi')
    expect(shell, 'no shell variant built').toBeDefined()
    expect(shell!.colorTargets[0]?.blend).toBe('none')
    // …while the front-shell COLOUR variant must keep blending (it composites
    // straight onto the scene). A copy-paste of one into the other is caught here.
    const front = captured.find((c) => c.label === 'fill-extrude-frontshell-write-rhi')
    expect(front!.colorTargets[0]?.blend).toBe('alpha')
  })
})

// ── Link A: the production call site actually opts in ──────────────
//
// The gate defaults FALSE so every existing caller stays byte-identical, which
// means a call site that forgets it leaves the whole fix inert with no other
// symptom (§12: intent in a comment is not wiring).

describe('#1253 — the map wires the gate', () => {
  it('map.ts passes extrudeShell into the classifier', () => {
    const mapSrc = readFileSync(join(HERE, '..', 'map.ts'), 'utf8')
    expect(mapSrc).toContain('extrudeShell:')
    // The gate asks the CAPABILITY (`readsWgsl` — wgsl-for.ts, the one place in
    // map/src that asks which language a device consumes), never the backend's
    // identity and never `executionModel`. The two ratchets that own those
    // questions pin the counts; this pins that the ONE call site still asks the
    // right question rather than re-deriving it from a device's name.
    expect(mapSrc).toContain('readsWgsl(this.ctx.rhi)')
    expect(mapSrc).toContain('isOverdrawActive(this.ctx.rhi.caps)')
  })

  it('the shell pass composites through the shared alpha authority', () => {
    const pass = readFileSync(join(HERE, 'passes', 'oit-pass.ts'), 'utf8')
    expect(pass).toContain('ensureExtrudeShell')
    expect(pass).toContain('extrudeFillAlpha(cs.show, cs.resolvedShow)')
  })
})
