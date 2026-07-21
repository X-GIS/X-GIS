// ═══ Body → GPU-const injection seam (#798 P3) ═══
//
// The shader-dsl ConstDecl arrays PROJECTION_CONSTS (EARTH_R) and ECEF_CONSTS
// (WGS84_A / WGS84_E2) carry Earth's WGS84 numbers as their shipped defaults, so
// an unconfigured process emits byte-identical Earth WGSL. This seam is the GPU
// half of the Body authority (the CPU half is activeBody() in @xgis/shared): it
// routes those GPU consts through the active Body at map construction, so a
// non-Earth body (Moon / Mars) injects its own radius / eccentricity² into every
// emitted shader.
//
// The shader-authoring modules stay body-BLIND — they expose the mutable const
// arrays; this integration layer owns the body→value mapping, exactly as the map
// owns PROJECTIONS and injects it via configureProjections(). (That is why this
// file lives at the map layer, not under shaders/dsl/, which imports nothing from
// @xgis/shared.)
//
// EARTH is byte-identical by construction: the shipped ConstDecl defaults ARE
// Earth's WGS84 numbers (EARTH_R = a = sphereR = 6378137, WGS84_E2 = f·(2−f)), so
// EARTH routes sphereR / a / e2 UNIFORMLY like every other body — no special case.
// #1152 INC-3 un-pinned #798 PIN #2 (the retired divergent GPU e2 literal): the
// GPU e2 now spells the SAME f·(2−f) value EARTH.e2 holds; they are bit-identical
// after Math.fround (the compiled f32 is unchanged), so single-sourcing is a
// zero-delta win, not a regression. Locked by body-consts.test.ts.
//
// Ordering: call BEFORE the first projection/ecef shader emit — the XGISMap ctor
// calls it right after configureProjections(); shader modules build lazily at GPU
// init, well after. Mirrors configureProjections()'s configure-before-emit rule.

import { activeBody, configureBody, type Body } from '@xgis/shared'
import type { ConstDecl } from '@xgis/shader-dsl'
import { ECEF_CONSTS } from './shaders/dsl/ecef'
import { PROJECTION_CONSTS } from './shaders/dsl/projections'

/** wgslValue/cpuValue are `readonly` on ConstDecl; this seam is the sole writer
 *  (same readonly-cast pattern projections.ts uses for allowEarlyReturn). */
type MutableConst = { -readonly [K in keyof ConstDecl]: ConstDecl[K] }

function findConst(arr: readonly ConstDecl[], name: string): ConstDecl {
  const c = arr.find((d) => d.name === name)
  if (!c) throw new Error(`body-consts: missing ConstDecl '${name}'`)
  return c
}

const EARTH_R_C = findConst(PROJECTION_CONSTS, 'EARTH_R')
const EARTH_E2_C = findConst(PROJECTION_CONSTS, 'EARTH_E2')
const WGS84_A_C = findConst(ECEF_CONSTS, 'WGS84_A')
const WGS84_E2_C = findConst(ECEF_CONSTS, 'WGS84_E2')

function setConst(c: ConstDecl, value: number): void {
  const m = c as MutableConst
  m.wgslValue = value
  m.cpuValue = value
}

/** Route the GPU ConstDecls (EARTH_R / EARTH_E2 / WGS84_A / WGS84_E2) through
 *  `body`. EARTH takes the same uniform path as every body — its shipped defaults
 *  ARE Earth's WGS84 numbers, so this is a no-op re-assignment for the default
 *  process (#1152 INC-3 retired the === EARTH special case with #798 PIN #2). A
 *  non-Earth body injects its projection-sphere radius (sphereR), semi-major axis
 *  (a), and first eccentricity² (e2). EARTH_E2 (proj_globe's ellipsoid N term)
 *  and WGS84_E2 (lonlat_to_ecef) are two names for the ONE body.e2 value — the
 *  shipped EARTH_R/WGS84_A two-names-one-value precedent. Idempotent; safe to
 *  re-apply on a body switch. */
export function configureBodyConsts(body: Body): void {
  setConst(EARTH_R_C, body.sphereR)
  setConst(EARTH_E2_C, body.e2)
  setConst(WGS84_A_C, body.a)
  setConst(WGS84_E2_C, body.e2)
}

/** Construction-time body boot — the ONE seam the XGISMap ctor calls (#798 P2+P3).
 *  Applies the optional `{ body }` ctor knob to the process-global authority
 *  (configureBody; an omitted knob preserves a previously configured body), then
 *  routes the GPU ConstDecls through the active body. Must run before the first
 *  shader emit — the same configure-before-emit contract configureProjections()
 *  follows. EARTH default ⟹ byte-identical (see configureBodyConsts). */
export function applyBodyOption(body?: Body): void {
  if (body) configureBody(body)
  configureBodyConsts(activeBody())
}
