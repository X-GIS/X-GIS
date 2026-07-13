// ═══ XGISMapOptions.body — the #798 P2 construction knob ═══
//
// P1 (#951) centralised the CPU Earth constants into the Body authority and
// P3 (#971) added the GPU-const seam (configureBodyConsts), but the authority
// had NO construction-time entry point: configureBody() had zero src callers,
// so a non-Earth map required a manual @xgis/shared call before `new XGISMap`.
// This locks the ctor option: `new XGISMap(canvas, { body: MOON })` must land
// on BOTH halves of the authority — the process-global activeBody() (CPU
// packers) and the GPU ConstDecls (emitted shaders) — before any shader emit.
//
// Headless (mock-canvas ctor pattern from map-epsg-ingest-reprojection.test.ts;
// the ctor needs no GPU — GPU init happens in run()). No Earth literals are
// spelled here: every expectation compares against the Body authority itself,
// so this file can never become a literal-scatter site.

import { describe, it, expect, afterEach } from 'vitest'
import { EARTH, MOON, activeBody, configureBody } from '@xgis/shared'
import type { ConstDecl } from '@xgis/shader-dsl'
import { XGISMap } from './map'
import { configureBodyConsts } from './body-consts'
import { ECEF_CONSTS } from './shaders/dsl/ecef'
import { PROJECTION_CONSTS } from './shaders/dsl/projections'

const mockCanvas = (): HTMLCanvasElement =>
  ({ width: 1200, height: 800 }) as unknown as HTMLCanvasElement

const constOf = (arr: readonly ConstDecl[], name: string): ConstDecl => {
  const c = arr.find((d) => d.name === name)
  if (!c) throw new Error(`missing ConstDecl '${name}'`)
  return c
}
const EARTH_R = constOf(PROJECTION_CONSTS, 'EARTH_R')
const WGS84_A = constOf(ECEF_CONSTS, 'WGS84_A')
const WGS84_E2 = constOf(ECEF_CONSTS, 'WGS84_E2')

// The body state is PROCESS-GLOBAL (globalThis-backed) and the ConstDecls are
// module-level mutables — restore Earth after every test so no ordering leaks.
afterEach(() => {
  configureBody(EARTH)
  configureBodyConsts(EARTH)
})

describe('XGISMapOptions.body (#798 P2)', () => {
  it('default construction keeps EARTH and the shipped GPU literals (byte-identical path)', () => {
    new XGISMap(mockCanvas())
    expect(activeBody()).toBe(EARTH)
    expect(EARTH_R.wgslValue).toBe(EARTH.sphereR)
    expect(WGS84_A.wgslValue).toBe(EARTH.a)
    // PIN #2: the GPU e2 literal deliberately diverges from Body.e2 — the
    // === EARTH guard must RESTORE the shipped literal, never write EARTH.e2.
    expect(WGS84_E2.wgslValue).not.toBe(EARTH.e2)
  })

  it('{ body: MOON } lands on both authority halves before any emit', () => {
    new XGISMap(mockCanvas(), { body: MOON })
    expect(activeBody()).toBe(MOON)
    expect(EARTH_R.wgslValue).toBe(MOON.sphereR)
    expect(EARTH_R.cpuValue).toBe(MOON.sphereR)
    expect(WGS84_A.wgslValue).toBe(MOON.a)
    expect(WGS84_E2.wgslValue).toBe(MOON.e2) // 0 — a perfect sphere
  })

  it('omitting the option keeps a previously configured body (process-global, no silent reset)', () => {
    // Documented semantic: the ctor only OVERRIDES when the option is present;
    // an earlier configureBody() survives, and the const seam re-reads it.
    configureBody(MOON)
    new XGISMap(mockCanvas())
    expect(activeBody()).toBe(MOON)
    expect(EARTH_R.wgslValue).toBe(MOON.sphereR)
  })

  it('a later Earth map restores the shipped GPU literals verbatim (round-trip)', () => {
    new XGISMap(mockCanvas(), { body: MOON })
    const before = { r: EARTH_R.wgslValue, a: WGS84_A.wgslValue, e2: WGS84_E2.wgslValue }
    expect(before.r).toBe(MOON.sphereR) // sanity: Moon actually applied
    new XGISMap(mockCanvas(), { body: EARTH })
    expect(activeBody()).toBe(EARTH)
    expect(EARTH_R.wgslValue).toBe(EARTH.sphereR)
    expect(WGS84_A.wgslValue).toBe(EARTH.a)
    expect(WGS84_E2.wgslValue).not.toBe(EARTH.e2) // the divergent literal, restored
  })
})
