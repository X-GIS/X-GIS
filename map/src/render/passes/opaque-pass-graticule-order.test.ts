// #970 — graticule overlay draws AFTER the opaque vector-tile fills.
//
// Regression gate for the flat-Mercator graticule depth/occlusion bug. The
// graticule is a lat/lon reference grid that must composite ON TOP of the
// opaque basemap. It USED to draw inside `renderToPass` — which the opaque pass
// runs in its FIRST sub-pass, BEFORE the vector-tile `group.shows` (the opaque
// ocean/land fills). The opaque fills (drawn later, painter's order) then
// painted over the grid: invisible on flat Mercator over opaque fills, and on
// globe only the lines outside the sphere disc survived. Real-GPU (headed
// WebGPU) proof: grat-ON vs grat-OFF over the ocean_land opaque fills changed
// 3 px before the fix, 29,492 px after (== the no-fill coastline control).
//
// The fix moves the graticule to `renderer.renderGraticuleOverlay()`, which the
// opaque pass calls in its LAST sub-pass AFTER that group's shows. This gate
// drives the REAL `opaquePass.execute` against recording stubs and asserts the
// draw ORDER: every opaque `show` draws BEFORE the graticule overlay, and the
// overlay is the LAST draw. The bug is WebGPU-native-only (the graticule never
// draws on the webgl2 / forcegl2 path a SwiftShader pixel gate could read), so
// this GPU-free call-order invariant is the deterministic CI gate.
//
// Fail-before: on unmodified main the opaque pass never calls
// renderGraticuleOverlay (the grid draws inside renderToPass, BEFORE the
// shows), so 'graticule' is absent from the recorded order and every assertion
// below fails.

import { describe, it, expect } from 'vitest'
import { opaquePass } from './opaque-pass'
import { makeProjectionToken } from '../projection-token'

/** Build a stub FrameContext + OpaquePassHost + SceneView that record the draw
 *  order of renderToPass (legacy) / each show / renderGraticuleOverlay. */
function harness(groupCount: number) {
  const order: string[] = []
  const subPass = { end: () => undefined }
  const ctx = {
    encoder: { beginRenderPass: () => subPass },
    passScope: (_label: string, fn: () => void) => fn(),
    colorView: {},
    screenView: {},
    useResolve: false,
    rt: { stencilView: {}, pickTexture: undefined, pickView: undefined },
    projection: makeProjectionToken(0, 0, 0),
    w: 800,
    h: 600,
    dpr: 1,
  }
  const rasterRenderer = {
    setOpacity: () => undefined,
    setColorAdjust: () => undefined,
    setResampling: () => undefined,
    render: () => order.push('raster'),
  }
  const host = {
    gpuTimer: undefined,
    _rasterShow: undefined,
    _elapsedMs: 0,
    camera: {},
    pointRenderer: {},
    rasterRenderer,
    // No coverage armed in this harness → hasCoverage() false short-circuits the
    // coverage draw before the camera/projection checks (#1272).
    coverageRenderer: { hasCoverage: () => false },
    renderer: {
      uniformBuffer: {},
      renderToPass: () => order.push('legacy'),
      renderGraticuleOverlay: () => order.push('graticule'),
    },
  }
  // One ground show per group (extrude absent → non-extruded loop). Its draw
  // closure records 'show' — the opaque content the graticule must land over.
  const opaqueGroups = Array.from({ length: groupCount }, (_v, gi) => ({
    shows: [{ show: {}, fillPhase: 'both', draw: () => order.push(`show${gi}`) }],
  }))
  const scene = { opaqueGroups, resolveOwner: 'none', hasPoints: false, hasOit: false }
  return { order, ctx, host, scene }
}

describe('#970 graticule overlay draws after opaque fills', () => {
  it('single opaque group: graticule draws AFTER the show and is the LAST draw', () => {
    const { order, ctx, host, scene } = harness(1)
    opaquePass.execute(ctx as never, scene as never, host as never)

    expect(order, 'graticule overlay must be drawn').toContain('graticule')
    expect(order, 'opaque show must be drawn').toContain('show0')
    // The overlay composites on top → strictly after the opaque fill.
    expect(order.indexOf('graticule')).toBeGreaterThan(order.indexOf('show0'))
    // …and after the legacy backdrop it replaced the graticule call in.
    expect(order.indexOf('graticule')).toBeGreaterThan(order.indexOf('legacy'))
    // …and it is the final draw of the opaque bucket.
    expect(order[order.length - 1]).toBe('graticule')
  })

  it('multiple opaque groups: graticule drawn ONCE, in the LAST sub-pass after every show', () => {
    const { order, ctx, host, scene } = harness(3)
    opaquePass.execute(ctx as never, scene as never, host as never)

    // Exactly one overlay draw (isLastOpaque gate), not one per group.
    expect(order.filter((o) => o === 'graticule')).toHaveLength(1)
    // It lands after EVERY group's show.
    const gi = order.indexOf('graticule')
    for (let g = 0; g < 3; g++) expect(gi).toBeGreaterThan(order.indexOf(`show${g}`))
    expect(order[order.length - 1]).toBe('graticule')
  })
})
