// Issue #739 — the line consumer must derive its `mpp` from the single
// effective-mpp authority (camera.effectiveMpp), NOT the uncapped
// WORLD_MERC/TILE_PX/2^zoom.
//
// The PR routes vector-tile-renderer's two line sites (renderLinesRhi + render)
// through camera.effectiveMpp so a constant-width stroke holds its on-screen px
// across the frozen sub-cap band. But the committed tests only exercised the
// AUTHORITY math (merc-z0-view-line-width-freeze calls camera.effectiveMpp
// directly) and the layer-slot PACKER (line-pattern-wiring injects a literal mpp
// into writeLayerSlot) — neither drives VTR's own mpp derivation. So a refactor
// re-inlining the raw 2^zoom mpp at the consumer (the #722-729 render-antipattern
// archetype) would ship the #739 regression with every gate green.
//
// This closes that gap: it drives the REAL VectorTileRenderer.renderLinesRhi with
// a REAL Camera in the sub-cap band (z0 on a tall viewport, where the cap binds)
// and captures the `mpp` argument the renderer hands to writeLayerSlot, asserting
// it is the CAPPED effective mpp, not the raw one. Reverting VTR's
// `camera.effectiveMpp(projType, canvasHeight, dpr)` to the uncapped expression
// makes the captured value raw → this fails. The render() twin (line ~2279) is
// the byte-identical sibling of the renderLinesRhi site under test.
//
// VTR's constructor needs a WebGPU device we can't run in vitest, so we build the
// instance via Object.create + manual field injection — the same escape hatch as
// vtr-continuous-zoom / vtr-pump-prefetch — inject a spy lineRenderer whose
// writeLayerSlot records the mpp and throws a sentinel to short-circuit before
// any GPU draw, and feed an empty tile selection so the straight-line body from
// selection to writeLayerSlot runs with no tiles loaded.

import { describe, expect, it } from 'vitest'
import { Camera } from '../camera'
import { WORLD_MERC, TILE_PX, flatViewHeightCapM } from '@xgis/geo'
import { VectorTileRenderer } from './vector-tile-renderer'
import type { ShowCommand } from './renderer-types'
import type { ResolvedShow } from './resolved-show'
import type { RhiRenderPass } from '@xgis/engine'

// writeLayerSlot positional tail: (color, widthPx, opacity, mpp, cap, join, …) —
// mpp is the 4th argument (index 3).
const MPP_ARG_INDEX = 3

interface Captured {
  mpp?: number
}

/** Object.create a VTR and inject the minimal state renderLinesRhi reads before
 *  the writeLayerSlot call, plus a spy lineRenderer that captures mpp and throws
 *  the returned sentinel to abort the rest of the draw path. */
function makeLineVtr(captured: Captured): { vtr: VectorTileRenderer; sentinel: symbol } {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  const sentinel = Symbol('mpp-captured')
  const set = (k: string, v: unknown) => {
    ;(vtr as unknown as Record<string, unknown>)[k] = v
  }

  set('lineRenderer', {
    writeLayerSlot: (...args: unknown[]): number => {
      captured.mpp = args[MPP_ARG_INDEX] as number
      throw sentinel
    },
    endFrame: () => {},
    resolveShapeId: () => 0,
  })
  // hasData() + getIndex() gate entry; the acquisition loop never runs because
  // the selection returns an empty neededKeys set.
  set('source', {
    hasData: () => true,
    getIndex: () => ({}),
    maxLevel: 0,
    hasTileData: () => false,
    getTileData: () => null,
    hasEntryInIndex: () => false,
    requestTiles: () => {},
  })
  // An empty selection: the body still reaches the mpp derivation + writeLayerSlot
  // with zero tiles to acquire. `tiles: []` satisfies collectTwinFallbacks (#1046),
  // which iterates sel.tiles for fallback-ancestor coverage before writeLayerSlot;
  // an empty array makes it a no-op so this test still reaches the mpp capture.
  set('_selection', { selectForFrame: () => ({ neededKeys: [], worldOffDeg: 0, tiles: [] }) })
  set('_drawStats', {})
  set('currentFrameId', 0)
  set('_dashArrayCache', null)
  // Shadow the prototype helpers that would otherwise touch the absent device.
  set('ensureUniformRing', () => {})
  set('resetUploadFrameCap', () => {})
  set('getOrCreateLayerCache', () => new Map())

  return { vtr, sentinel }
}

const SHOW = { sourceLayer: 'roads' } as unknown as ShowCommand
const RESOLVED_SHOW = {
  layerName: 'roads',
  opacity: 1,
  strokeWidth: 4,
  stroke: [1, 1, 1, 1],
  dashArray: null,
  dashOffset: 0,
} as unknown as ResolvedShow

describe('VectorTileRenderer line mpp — derived from camera.effectiveMpp (#739)', () => {
  it('hands writeLayerSlot the CAPPED effective mpp in the sub-cap band, not the raw 2^zoom mpp', () => {
    // z0 on a tall viewport: z* = log2(1080/512) ≈ 1.08 → z0 is inside the frozen
    // sub-cap band and the flat view-height cap binds (capped < raw).
    const canvasHeight = 1080
    const dpr = 1
    const cam = new Camera(0, 0, 0)
    cam.projType = 0
    cam.bearing = 0
    cam.globeMode = false

    const captured: Captured = {}
    const { vtr, sentinel } = makeLineVtr(captured)

    let caught: unknown
    try {
      vtr.renderLinesRhi(
        {} as unknown as RhiRenderPass,
        cam,
        0, // projType — flat mercator
        0, // projCenterLon
        0, // projCenterLat
        1920, // canvasWidth
        canvasHeight,
        dpr,
        SHOW,
        RESOLVED_SHOW,
      )
    } catch (e) {
      caught = e
    }

    // The spy fired (we reached writeLayerSlot) and short-circuited cleanly.
    expect(caught, 'renderLinesRhi did not reach writeLayerSlot').toBe(sentinel)
    expect(captured.mpp, 'writeLayerSlot received no mpp').toBeTypeOf('number')

    const rawMpp = WORLD_MERC / TILE_PX / Math.pow(2, 0)
    const capped = Math.min(rawMpp, flatViewHeightCapM(0, WORLD_MERC) / (canvasHeight / dpr))
    // Fixture sanity: the cap MUST bind (otherwise capped === raw and the gate is moot).
    expect(capped).toBeLessThan(rawMpp)

    // The consumer passed the CAPPED authority value…
    expect(captured.mpp).toBeCloseTo(capped, 6)
    // …and NOT the uncapped raw mpp (reverting VTR to 2^zoom would pass this).
    expect(captured.mpp).not.toBeCloseTo(rawMpp, 6)
  })
})
