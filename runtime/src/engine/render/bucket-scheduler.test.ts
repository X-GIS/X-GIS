// ═══ Bucket scheduler classifier tests ═══
//
// PR 2 (bucket scheduler refactor) and PR 3 (animation lifecycle)
// both shipped silent classification bugs that the smoke test
// couldn't catch:
//
//   - Bug 2 (`f88413c`): the `inlinePoints` optimization conflated
//     tile points and direct-layer points, dropping the dedicated
//     points pass for any demo with no translucent layers.
//   - Bug 1 (`1317263`): the per-frame metadata for color/width
//     keyframes was read from the wrong property union, so any
//     non-opacity animation froze after one cycle.
//
// Both lived inside `classifyVectorTileShows()` in map.ts, where
// they were unreachable from unit tests because the method was
// private and read instance state. PR C extracted the function
// into a pure module (`bucket-scheduler.ts`) so this test file
// can call it with stub fixtures and lock the contract for every
// bucket combination.

import { describe, expect, it } from 'vitest'
import {
  classifyVectorTileShows,
  groupOpaqueBySource,
  planFrameSchedule,
  type ClassifierInput,
  type ClassifierShowEntry,
  type ClassifierVTSource,
} from './bucket-scheduler'
import type { SceneCommands, PaintShapes, PropertyShape } from '@xgis/compiler'

/** Synthesize a PaintShapes bundle from the legacy flat fields a test
 *  fixture sets. Mirrors what emit-commands.ts does for compiled
 *  programs — keeps test fixtures from having to spell out the typed
 *  shape AND the legacy fallback both. The bucket-scheduler reads
 *  paintShapes.opacity directly (Step 1c migration), so this is what
 *  feeds it. */
function synthesizePaintShapes(show: {
  opacity?: number | null
  zoomOpacityStops?: { zoom: number; value: number }[] | null
  zoomOpacityStopsBase?: number
  timeOpacityStops?: { timeMs: number; value: number }[] | null
  timeOpacityLoop?: boolean
  timeOpacityEasing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
  timeOpacityDelayMs?: number
}): PaintShapes {
  const z = show.zoomOpacityStops ?? null
  const t = show.timeOpacityStops ?? null
  const loop = show.timeOpacityLoop ?? false
  const easing = show.timeOpacityEasing ?? 'linear'
  const delayMs = show.timeOpacityDelayMs ?? 0
  let opacity: PropertyShape<number>
  if (z !== null && t !== null) {
    opacity = {
      kind: 'zoom-time', zoomStops: z, timeStops: t, loop, easing, delayMs,
    }
  } else if (z !== null) {
    opacity = { kind: 'zoom-interpolated', stops: z, base: show.zoomOpacityStopsBase ?? 1 }
  } else if (t !== null) {
    opacity = { kind: 'time-interpolated', stops: t, loop, easing, delayMs }
  } else {
    opacity = { kind: 'constant', value: show.opacity ?? 1 }
  }
  return { fill: null, stroke: null, opacity, strokeWidth: { kind: 'constant', value: 1 }, size: null }
}

// ── Stub helpers ───────────────────────────────────────────────────
//
// The classifier reads from real GPU resources only to plumb them
// through to the output; it never DEREFERENCES them. Empty objects
// satisfy the structural type checks at compile time and never
// trigger any GPU code at runtime. This is the key to fast unit
// tests of the bucket scheduler.

const STUB_GPU = {} as unknown
const stubPipeline = STUB_GPU as GPURenderPipeline
const stubLayout = STUB_GPU as GPUBindGroupLayout

function makeVTSource(hasData = true): ClassifierVTSource {
  return {
    source: {},
    renderer: { hasData: () => hasData },
  }
}

function makeShow(overrides: Partial<SceneCommands['shows'][0]> = {}): SceneCommands['shows'][0] {
  // Minimal valid show. Intentionally conservative — opacity 1,
  // no animation, no zoom interpolation. Tests override exactly
  // the fields they want to exercise.
  const base = {
    targetName: 'src',
    fill: '#334155',
    stroke: null,
    strokeWidth: 1,
    projection: 'mercator',
    visible: true,
    opacity: 1,
    size: null,
    zoomOpacityStops: null,
    zoomSizeStops: null,
    shaderVariant: null,
    filterExpr: null,
    geometryExpr: null,
    sizeUnit: null,
    sizeExpr: null,
    billboard: true,
    shape: null,
    shapeDefs: [],
    timeOpacityStops: null,
    timeFillStops: null,
    timeStrokeStops: null,
    timeStrokeWidthStops: null,
    timeSizeStops: null,
    timeDashOffsetStops: null,
    timeOpacityLoop: false,
    timeOpacityEasing: 'linear' as const,
    timeOpacityDelayMs: 0,
    ...overrides,
  }
  return {
    ...base,
    // Dual-write: bucket-scheduler now reads `paintShapes.opacity`
    // (Step 1c). Mirror the legacy flat fields here so existing
    // tests don't have to spell out the typed shape explicitly.
    paintShapes: synthesizePaintShapes(base),
  } as unknown as SceneCommands['shows'][0]
}

function makeEntry(
  sourceName: string,
  show: SceneCommands['shows'][0],
): ClassifierShowEntry {
  return { sourceName, show, pipelines: null, layout: null }
}

function makeInput(
  vectorTileShows: ClassifierShowEntry[],
  vtSources: Map<string, ClassifierVTSource>,
  options: { cameraZoom?: number; elapsedMs?: number; safeMode?: boolean } = {},
): ClassifierInput {
  return {
    vectorTileShows,
    vtSources,
    cameraZoom: options.cameraZoom ?? 5,
    elapsedMs: options.elapsedMs ?? 0,
    rendererDefaults: {
      fillPipeline: stubPipeline,
      linePipeline: stubPipeline,
      bindGroupLayout: stubLayout,
    },
    safeMode: options.safeMode ?? false,
  }
}

// ──────────────────────────────────────────────────────────────────

describe('classifyVectorTileShows — base cases', () => {
  it('skips entries whose VT source has no data yet', () => {
    const sources = new Map<string, ClassifierVTSource>([
      ['src', makeVTSource(false)],
    ])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({ fill: '#ff0000' }))],
      sources,
    ))
    expect(result.opaque).toHaveLength(0)
    expect(result.translucent).toHaveLength(0)
  })

  it('skips entries with effectively-invisible opacity (< 0.005)', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({ opacity: 0.001 }))],
      sources,
    ))
    expect(result.opaque).toHaveLength(0)
  })

  it('classifies a fully-opaque layer into the opaque bucket only', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({ fill: '#ff0000', stroke: '#00ff00', opacity: 1 }))],
      sources,
    ))
    expect(result.opaque).toHaveLength(1)
    expect(result.translucent).toHaveLength(0)
    expect(result.opaque[0].fillPhase).toBe('all')
    expect(result.opaque[0].isTranslucentStroke).toBe(false)
  })

  it('classifies a translucent-stroke layer into BOTH buckets', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({ fill: '#ff0000', stroke: '#00ff00', opacity: 0.5 }))],
      sources,
    ))
    expect(result.opaque).toHaveLength(1)
    expect(result.translucent).toHaveLength(1)
    expect(result.opaque[0].fillPhase).toBe('fills')
    expect(result.opaque[0].isTranslucentStroke).toBe(true)
    // Same ClassifiedShow object appears in both buckets — bucket 1
    // draws the fill half, bucket 2 the stroke half.
    expect(result.opaque[0]).toBe(result.translucent[0])
  })

  it('does NOT mark as translucent-stroke when opacity is high enough (≥ 0.999)', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({ fill: '#ff0000', stroke: '#00ff00', opacity: 0.9999 }))],
      sources,
    ))
    expect(result.opaque[0].isTranslucentStroke).toBe(false)
  })

  it('does NOT mark as translucent-stroke when there is no stroke', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({ fill: '#ff0000', stroke: null, opacity: 0.3 }))],
      sources,
    ))
    expect(result.opaque[0].isTranslucentStroke).toBe(false)
    expect(result.translucent).toHaveLength(0)
  })

  it('gates shows on Mapbox minzoom (camera.zoom < minzoom → skip)', () => {
    const sources = new Map([['src', makeVTSource()]])
    const show = makeShow({ fill: '#ff0000', minzoom: 10 })
    // Camera at z=5, layer demands z>=10 → skipped.
    const below = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 5 }),
    )
    expect(below.opaque).toHaveLength(0)
    // Camera at z=10 → inside the band (boundary inclusive).
    const at = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 10 }),
    )
    expect(at.opaque).toHaveLength(1)
    // Camera at z=12 → still inside.
    const above = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 12 }),
    )
    expect(above.opaque).toHaveLength(1)
  })

  it('gates shows on Mapbox maxzoom (camera.zoom >= maxzoom → skip; spec is exclusive)', () => {
    const sources = new Map([['src', makeVTSource()]])
    const show = makeShow({ fill: '#ff0000', maxzoom: 9 })
    // Camera at z=8 → inside.
    const below = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 8 }),
    )
    expect(below.opaque).toHaveLength(1)
    // Camera at z=9 → AT maxzoom → skipped (Mapbox uses exclusive bound).
    const at = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 9 }),
    )
    expect(at.opaque).toHaveLength(0)
    // Camera at z=10 → above → skipped.
    const above = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 10 }),
    )
    expect(above.opaque).toHaveLength(0)
  })

  it('respects BOTH minzoom and maxzoom together (country boundaries band)', () => {
    const sources = new Map([['src', makeVTSource()]])
    const show = makeShow({ fill: '#ff0000', minzoom: 4, maxzoom: 9 })
    const inside = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 6 }),
    )
    expect(inside.opaque).toHaveLength(1)
    const justBelow = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 3.99 }),
    )
    expect(justBelow.opaque).toHaveLength(0)
    const atMaxzoom = classifyVectorTileShows(
      makeInput([makeEntry('src', show)], sources, { cameraZoom: 9 }),
    )
    expect(atMaxzoom.opaque).toHaveLength(0)
  })

  it('safeMode disables translucent-stroke classification', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({ fill: '#ff0000', stroke: '#00ff00', opacity: 0.5 }))],
      sources,
      { safeMode: true },
    ))
    expect(result.opaque[0].isTranslucentStroke).toBe(false)
    expect(result.translucent).toHaveLength(0)
  })
})

describe('classifyVectorTileShows — animation resolution (Bug 1 territory)', () => {
  it('composes zoom × time opacity multiplicatively', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({
        opacity: 1,
        zoomOpacityStops: [{ zoom: 0, value: 0.5 }, { zoom: 10, value: 0.5 }],
        timeOpacityStops: [{ timeMs: 0, value: 0.6 }, { timeMs: 1000, value: 0.6 }],
        timeOpacityLoop: true,
        timeOpacityEasing: 'linear',
        timeOpacityDelayMs: 0,
      }))],
      sources,
      { cameraZoom: 5, elapsedMs: 500 },
    ))
    // zoom = 0.5, time = 0.6 → opacity = 0.3
    expect(result.opaque[0].show.opacity).toBeCloseTo(0.3, 6)
  })

  it('resolves animated fill into resolvedFillRgba per frame', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({
        fill: '#ff0000',
        timeFillStops: [
          { timeMs: 0, value: [1, 0, 0, 1] },
          { timeMs: 1000, value: [0, 0, 1, 1] },
        ],
        timeOpacityLoop: true,
      }))],
      sources,
      { elapsedMs: 500 },
    ))
    const rgba = result.opaque[0].show.resolvedFillRgba!
    // Halfway between red [1,0,0,1] and blue [0,0,1,1]
    expect(rgba[0]).toBeCloseTo(0.5, 6)
    expect(rgba[1]).toBeCloseTo(0, 6)
    expect(rgba[2]).toBeCloseTo(0.5, 6)
  })

  it('overrides strokeWidth from timeStrokeWidthStops', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({
        strokeWidth: 2,
        timeStrokeWidthStops: [
          { timeMs: 0, value: 2 },
          { timeMs: 1000, value: 8 },
        ],
        timeOpacityLoop: true,
      }))],
      sources,
      { elapsedMs: 500 },
    ))
    expect(result.opaque[0].show.strokeWidth).toBe(5) // halfway 2→8
  })

  it('overrides dashOffset from timeDashOffsetStops', () => {
    const sources = new Map([['src', makeVTSource()]])
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', makeShow({
        dashOffset: 0,
        timeDashOffsetStops: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 60 },
        ],
        timeOpacityLoop: true,
      }))],
      sources,
      { elapsedMs: 250 },
    ))
    expect(result.opaque[0].show.dashOffset).toBeCloseTo(15, 6)
  })

  it('Bug 1 regression: animated fill keeps cycling past first iteration', () => {
    // Bug 1: color animations froze after one cycle because
    // lifecycle metadata (loop) was read from the wrong union.
    // The classifier itself was always correct; what mattered was
    // the upstream emit-commands fix. This test pins the behavior
    // by sampling at multiple cycle multiples and verifying the
    // resolved color reflects the correct cycle position.
    const sources = new Map([['src', makeVTSource()]])
    const sampleAt = (elapsedMs: number) => {
      const r = classifyVectorTileShows(makeInput(
        [makeEntry('src', makeShow({
          timeFillStops: [
            { timeMs: 0, value: [1, 0, 0, 1] },
            { timeMs: 500, value: [0, 1, 0, 1] },
            { timeMs: 1000, value: [1, 0, 0, 1] },
          ],
          timeOpacityLoop: true,
        }))],
        sources,
        { elapsedMs },
      ))
      return r.opaque[0].show.resolvedFillRgba!
    }
    // t=0, t=500, t=1000 = first cycle: red, green, red
    // t=2500 = third cycle midpoint = green again (proves looping)
    const t0 = sampleAt(0)
    const tMid1 = sampleAt(500)
    const tEnd1 = sampleAt(1000)
    const tMid3 = sampleAt(2500)
    expect(t0[0]).toBeCloseTo(1, 6)    // red
    expect(tMid1[1]).toBeCloseTo(1, 6) // green
    expect(tEnd1[0]).toBeCloseTo(1, 6) // red again (cycle 1 end)
    expect(tMid3[1]).toBeCloseTo(1, 6) // green again (cycle 3 mid) ← this is the loop check
  })

  it('does NOT clone the show object when no animation is attached (zero-alloc fast path)', () => {
    const sources = new Map([['src', makeVTSource()]])
    const baseShow = makeShow({ fill: '#ff0000' })
    const result = classifyVectorTileShows(makeInput(
      [makeEntry('src', baseShow)],
      sources,
    ))
    // Object identity: when no animation/zoom override is needed
    // the classifier must reuse the original show reference to
    // avoid per-frame GC pressure on static layers.
    expect(result.opaque[0].show).toBe(baseShow)
  })
})

describe('groupOpaqueBySource', () => {
  it('groups consecutive same-source shows into one run', () => {
    const sources = new Map([
      ['a', makeVTSource()],
      ['b', makeVTSource()],
    ])
    const r = classifyVectorTileShows(makeInput([
      makeEntry('a', makeShow({ fill: '#111111' })),
      makeEntry('a', makeShow({ fill: '#222222' })),
      makeEntry('b', makeShow({ fill: '#333333' })),
    ], sources))
    const groups = groupOpaqueBySource(r.opaque)
    expect(groups).toHaveLength(2)
    expect(groups[0].sourceName).toBe('a')
    expect(groups[0].shows).toHaveLength(2)
    expect(groups[1].sourceName).toBe('b')
    expect(groups[1].shows).toHaveLength(1)
  })

  it('opens a NEW group when the same source repeats after a different source', () => {
    // Stencil ring state isn't compatible across sources, so a
    // declaration order like A B A produces THREE groups, not two.
    const sources = new Map([
      ['a', makeVTSource()],
      ['b', makeVTSource()],
    ])
    const r = classifyVectorTileShows(makeInput([
      makeEntry('a', makeShow({ fill: '#111111' })),
      makeEntry('b', makeShow({ fill: '#222222' })),
      makeEntry('a', makeShow({ fill: '#333333' })),
    ], sources))
    const groups = groupOpaqueBySource(r.opaque)
    expect(groups).toHaveLength(3)
    expect(groups.map(g => g.sourceName)).toEqual(['a', 'b', 'a'])
  })

  it('returns an empty array when the opaque bucket is empty', () => {
    expect(groupOpaqueBySource([])).toEqual([])
  })
})

describe('planFrameSchedule — bucket flags + resolveOwner', () => {
  // Build a minimal classification result for the plan tests. We
  // only need the array lengths to drive the planner; field contents
  // are irrelevant.
  const FAKE_OPAQUE = { isTranslucentStroke: false } as never
  const FAKE_TRANSLUCENT = { isTranslucentStroke: true } as never

  it('opaque-only: resolveOwner = opaque, no other buckets', () => {
    const plan = planFrameSchedule(
      { opaque: [FAKE_OPAQUE], translucent: [], oit: []  },
      true,  // hasLineRenderer
      false, // hasDirectLayerPoints
    )
    expect(plan.hasTranslucent).toBe(false)
    expect(plan.hasDirectLayerPoints).toBe(false)
    expect(plan.resolveOwner).toBe('opaque')
  })

  it('translucent-only: resolveOwner = composite', () => {
    const plan = planFrameSchedule(
      { opaque: [FAKE_TRANSLUCENT], translucent: [FAKE_TRANSLUCENT], oit: []  },
      true,
      false,
    )
    expect(plan.hasTranslucent).toBe(true)
    expect(plan.resolveOwner).toBe('composite')
  })

  it('translucent without a line renderer falls back to opaque scheduling', () => {
    // hasLineRenderer=false means we can't actually run the
    // offscreen-stroke pass, so even though there are translucent
    // shows in the input the plan must NOT enable bucket 2.
    const plan = planFrameSchedule(
      { opaque: [FAKE_TRANSLUCENT], translucent: [FAKE_TRANSLUCENT], oit: []  },
      false, // hasLineRenderer
      false,
    )
    expect(plan.hasTranslucent).toBe(false)
    expect(plan.resolveOwner).toBe('opaque')
  })

  it('Bug 2 regression: direct-layer points + opaque tile layer schedules a points pass', () => {
    // This is THE EXACT shape of Bug 2: at least one opaque tile
    // show exists AND pointRenderer.hasLayers() is true. The old
    // `inlinePoints = !hasTranslucent` shortcut would have skipped
    // the dedicated points pass, hiding every direct-layer point
    // demo. The fix promotes the scheduler to ALWAYS run bucket 3
    // when direct-layer points exist.
    const plan = planFrameSchedule(
      { opaque: [FAKE_OPAQUE], translucent: [], oit: []  },
      true,
      true, // hasDirectLayerPoints
    )
    expect(plan.hasDirectLayerPoints).toBe(true)
    expect(plan.resolveOwner).toBe('points')
  })

  it('points + translucent: resolveOwner = points (last bucket wins)', () => {
    const plan = planFrameSchedule(
      { opaque: [FAKE_TRANSLUCENT], translucent: [FAKE_TRANSLUCENT], oit: []  },
      true,
      true,
    )
    expect(plan.hasTranslucent).toBe(true)
    expect(plan.hasDirectLayerPoints).toBe(true)
    // Points pass runs after the translucent composite, so it
    // owns the resolveTarget.
    expect(plan.resolveOwner).toBe('points')
  })

  it('points only (no opaque, no translucent): still resolves to points', () => {
    // Pure points-only case (no vector tile shows at all). The
    // bucket scheduler still emits an empty opaque pass to clear
    // the canvas, then the points pass handles the rest.
    const plan = planFrameSchedule(
      { opaque: [], translucent: [], oit: []  },
      true,
      true,
    )
    expect(plan.resolveOwner).toBe('points')
  })
})
