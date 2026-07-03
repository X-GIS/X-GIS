// Contract test for buildSceneView (render/scene-view.ts). Device-free:
// stubs the host's classify/group methods + renderer presence and the
// FrameContext's RT handle, then pins the has*/resolveOwner derivation.
// Mirrors the inline bucket-scheduler block extracted from
// RenderLoop.render — if a future edit changes WHEN a flag flips, this
// fails before the pixel survey would.

import { describe, it, expect } from 'vitest'
import { buildSceneView } from './scene-view'
import type { ClassifiedShow, OpaqueGroup } from '@xgis/map'
import type { FrameContext } from '@xgis/engine'

// Minimal stand-ins — buildSceneView only reads array length / identity.
const cs = (n: number): ClassifiedShow[] => Array.from({ length: n }, () => ({}) as ClassifiedShow)
const groups = (n: number): OpaqueGroup[] => Array.from({ length: n }, () => ({}) as OpaqueGroup)

interface HostStub {
  opaque: ClassifiedShow[]
  translucent: ClassifiedShow[]
  oit: ClassifiedShow[]
  lineRenderer: unknown
  pointHasLayers: boolean | null // null → pointRenderer is null
}

function makeHost(s: HostStub) {
  return {
    classifyVectorTileShows: () => ({ opaque: s.opaque, translucent: s.translucent, oit: s.oit }),
    groupOpaqueBySource: (o: ClassifiedShow[]) => groups(o.length),
    lineRenderer: s.lineRenderer,
    pointRenderer: s.pointHasLayers === null ? null : { hasLayers: () => s.pointHasLayers },
  } as unknown as Parameters<typeof buildSceneView>[0]
}

function makeCtx(oitTexturesPresent: boolean): FrameContext {
  return {
    rt: {
      oitAccumTexture: oitTexturesPresent ? ({} as GPUTexture) : null,
      oitRevealageTexture: oitTexturesPresent ? ({} as GPUTexture) : null,
    },
  } as unknown as FrameContext
}

describe('buildSceneView', () => {
  it('groups opaque shows by source (length passthrough)', () => {
    const scene = buildSceneView(
      makeHost({
        opaque: cs(3),
        translucent: [],
        oit: [],
        lineRenderer: {},
        pointHasLayers: false,
      }),
      makeCtx(false),
    )
    expect(scene.opaque).toHaveLength(3)
    expect(scene.opaqueGroups).toHaveLength(3)
  })

  it('hasTranslucent requires both translucent shows AND a lineRenderer', () => {
    const withLine = buildSceneView(
      makeHost({
        opaque: [],
        translucent: cs(1),
        oit: [],
        lineRenderer: {},
        pointHasLayers: false,
      }),
      makeCtx(false),
    )
    expect(withLine.hasTranslucent).toBe(true)

    const noLine = buildSceneView(
      makeHost({
        opaque: [],
        translucent: cs(1),
        oit: [],
        lineRenderer: null,
        pointHasLayers: false,
      }),
      makeCtx(false),
    )
    expect(noLine.hasTranslucent).toBe(false)
  })

  it('hasOit is content-based (OIT shows present) — targets are now lazily allocated by the pass', () => {
    // The OIT targets moved to a lazy ensureOit(), so hasOit can no longer
    // depend on the textures already existing (that would always be false on
    // the lazy path). It is now purely `oit.length > 0`, independent of
    // whether the RT handles are populated yet.
    const withShows = buildSceneView(
      makeHost({
        opaque: [],
        translucent: [],
        oit: cs(2),
        lineRenderer: {},
        pointHasLayers: false,
      }),
      makeCtx(false),
    )
    expect(withShows.hasOit).toBe(true)

    const noShows = buildSceneView(
      makeHost({ opaque: [], translucent: [], oit: [], lineRenderer: {}, pointHasLayers: false }),
      makeCtx(false),
    )
    expect(noShows.hasOit).toBe(false)
  })

  it('hasPoints is false when pointRenderer is null', () => {
    const scene = buildSceneView(
      makeHost({ opaque: [], translucent: [], oit: [], lineRenderer: {}, pointHasLayers: null }),
      makeCtx(false),
    )
    expect(scene.hasPoints).toBe(false)
  })

  it('resolveOwner priority: points > composite > opaque', () => {
    const points = buildSceneView(
      makeHost({
        opaque: cs(1),
        translucent: cs(1),
        oit: [],
        lineRenderer: {},
        pointHasLayers: true,
      }),
      makeCtx(false),
    )
    expect(points.resolveOwner).toBe('points')

    const composite = buildSceneView(
      makeHost({
        opaque: cs(1),
        translucent: cs(1),
        oit: [],
        lineRenderer: {},
        pointHasLayers: false,
      }),
      makeCtx(false),
    )
    expect(composite.resolveOwner).toBe('composite')

    const opaque = buildSceneView(
      makeHost({
        opaque: cs(1),
        translucent: [],
        oit: [],
        lineRenderer: {},
        pointHasLayers: false,
      }),
      makeCtx(false),
    )
    expect(opaque.resolveOwner).toBe('opaque')
  })
})
