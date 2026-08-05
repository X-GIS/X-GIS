// ═══ #1568 — four module caches must not serve another planet's bytes ═══
//
// The active Body is process-global: `configureBodyConsts` mutates the shared
// ConstDecl objects IN PLACE, and every emit path reads `wgslValue`/`cpuValue` at
// emit time. Four module-scope caches sat in front of those emits and keyed without
// the body, so constructing an Earth map and then a Moon map in the same page — a
// sequence `body-option.test.ts` already treats as supported — served the second map
// the first map's planet in four different ways, with nothing thrown and nothing
// logged.
//
// The fix is ONE authority: a body epoch bumped by `configureBodyConsts`, folded
// into all four keys. These cases are the issue's four falsifiable predictions,
// written so that removing the epoch from any single site turns exactly that case
// red — fixing three of four would still leave a silent wrong-planet frame.
//
// Site A is the worst and is asserted first: it desynchronises CPU from GPU INSIDE
// ONE FRAME (the GPU artifacts cache IS invalidated on a body switch, the CPU memo
// was not), which is this codebase's documented dominant bug archetype.

import { describe, it, expect, afterEach } from 'vitest'
import { EARTH, MOON, configureBody } from '@xgis/shared'
import { configureBodyConsts } from './body-consts'
import { projMercatorCpu } from './shaders/dsl/cpu-projections'
import { generateGraticule } from './graticule'
import { peekShaderSources, requestShaderSources } from './shaders/emit/shader-emit-pool'
import { buildShader } from './render/polygon-shader-cache'

/** Apply a body the way the XGISMap ctor does — configureBody then the const seam
 *  (map.ts calls applyBodyOption, which is exactly this pair). */
function switchBody(body: typeof EARTH): void {
  configureBody(body)
  configureBodyConsts(body)
}

afterEach(() => {
  switchBody(EARTH)
})

describe('#1568 body-blind module caches', () => {
  it('A — the compiled CPU projection module follows the body', () => {
    switchBody(EARTH)
    const earth = projMercatorCpu(0, 45)
    switchBody(MOON)
    const moon = projMercatorCpu(0, 45)
    // Mercator y is metres on the projection sphere, so the ratio is the radius
    // ratio. Before the fix `_M ??=` pinned the module compiled under EARTH — with
    // the constants baked as literals INTO the generated JS — and this returned the
    // identical Earth value forever.
    expect(moon[1]).not.toBe(earth[1])
    expect(moon[1] / earth[1]).toBeCloseTo(MOON.sphereR / EARTH.sphereR, 6)
  })

  it('A — and it comes back on the return trip, so the memo is scoped, not disabled', () => {
    switchBody(EARTH)
    const first = projMercatorCpu(0, 45)
    switchBody(MOON)
    projMercatorCpu(0, 45)
    switchBody(EARTH)
    expect(projMercatorCpu(0, 45)).toEqual(first)
  })

  it('B — the shader emit cache does not serve an Earth hillshade on the Moon', async () => {
    const req = { family: 'hillshade', methodFlag: 4, pick: false } as const
    switchBody(EARTH)
    await requestShaderSources(req, true)
    const earth = peekShaderSources(req)
    expect(earth, 'the Earth emit landed').toBeDefined()
    expect(earth!.vertex).toContain(String(EARTH.sphereR))

    switchBody(MOON)
    // The KEY question: before the fix `requestShaderSources` returned
    // `done.get(key)` before posting anything, so the body it rides on each request
    // only mattered on a miss — and (family, methodFlag, pick) is a hit.
    expect(peekShaderSources(req), 'the Earth entry must not answer for the Moon').toBeUndefined()
    await requestShaderSources(req, true)
    const moon = peekShaderSources(req)
    expect(moon!.vertex).toContain(String(MOON.sphereR))
    expect(moon!.vertex).not.toContain(String(EARTH.sphereR))
  })

  it('C — the optimized polygon WGSL memo does not serve Earth radii on the Moon', () => {
    switchBody(EARTH)
    const earth = buildShader(null)
    expect(earth).toContain(String(EARTH.sphereR))
    switchBody(MOON)
    const moon = buildShader(null)
    expect(moon).not.toBe(earth)
    expect(moon).not.toContain(String(EARTH.sphereR))
  })

  it('D — the graticule buffers are regenerated at the new body-s scale', () => {
    switchBody(EARTH)
    const earth = generateGraticule(9)
    const earthNorm = Math.hypot(earth.vertices[0]!, earth.vertices[1]!, earth.vertices[2]!)
    switchBody(MOON)
    const moon = generateGraticule(9)
    // Same object back = the body-blind key. The vertices are ECEF METRES, so an
    // Earth-baked bucket draws a grid 6378137/1737400 ≈ 3.67x too large.
    expect(moon).not.toBe(earth)
    const moonNorm = Math.hypot(moon.vertices[0]!, moon.vertices[1]!, moon.vertices[2]!)
    // ≈ 0.27, not exactly MOON.sphereR/EARTH.sphereR: `lonLatToECEF` is the
    // ELLIPSOIDAL forward, and this vertex sits at lat -85.05 where Earth's local
    // radius is ~0.3 % below `a` while the Moon (e2 = 0) is a perfect sphere. Two
    // decimals is well inside that and far outside the 1.0 a body-blind cache
    // would return.
    expect(moonNorm / earthNorm).toBeCloseTo(MOON.sphereR / EARTH.sphereR, 2)
  })

  it('D — the stale bucket is DROPPED, not merely re-keyed (the ~4.7 MB retention half)', () => {
    // A cheap bucket: the claim under test is object identity, not size. (The ~4.7
    // MB figure is the z>=9 bucket — ~130k pushes x 9 floats x 4 B — which the case
    // above already exercises once.)
    switchBody(EARTH)
    const earth = generateGraticule(2)
    switchBody(MOON)
    generateGraticule(2)
    switchBody(EARTH)
    // Back on Earth the geometry is right again, but it is a FRESH buffer: the old
    // one was released on the body change rather than kept resident for the page
    // lifetime alongside every other body's copy.
    const again = generateGraticule(2)
    expect(again).not.toBe(earth)
    expect(again.indexCount).toBe(earth.indexCount)
  })
})
