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
// EARTH is byte-identical by construction (issue #798 PIN #2): the GPU Earth e2
// literal (0.0066943799901975955) deliberately DIVERGES from Body.e2 (the CPU
// f·(2−f) value = 0.0066943799901413165), so the === EARTH branch restores the
// shipped GPU literals verbatim rather than overwriting e2 with EARTH.e2. Locked
// by body-consts.test.ts against a golden captured from pre-seam main.
//
// Ordering: call BEFORE the first projection/ecef shader emit — the XGISMap ctor
// calls it right after configureProjections(); shader modules build lazily at GPU
// init, well after. Mirrors configureProjections()'s configure-before-emit rule.

import { EARTH, activeBody, configureBody, type Body } from '@xgis/shared'
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
const WGS84_A_C = findConst(ECEF_CONSTS, 'WGS84_A')
const WGS84_E2_C = findConst(ECEF_CONSTS, 'WGS84_E2')

// Snapshot Earth's shipped GPU literals at module load — pristine, because this
// module is the SOLE mutator and only mutates when called. Captured (never
// re-spelled) so the earth-literal ratchet's single-authority invariant holds:
// only body.ts + the two ConstDecl files spell the numbers.
const EARTH_EARTH_R = EARTH_R_C.wgslValue
const EARTH_WGS84_A = WGS84_A_C.wgslValue
const EARTH_WGS84_E2 = WGS84_E2_C.wgslValue

function setConst(c: ConstDecl, value: number): void {
  const m = c as MutableConst
  m.wgslValue = value
  m.cpuValue = value
}

/** Route the GPU ConstDecls (EARTH_R / WGS84_A / WGS84_E2) through `body`.
 *
 *  EARTH restores the byte-identical shipped literals (the === EARTH guard — the
 *  GPU e2 diverges from Body.e2 and must never be overwritten). A non-Earth body
 *  injects its projection-sphere radius (sphereR), semi-major axis (a), and first
 *  eccentricity² (e2). Idempotent; safe to re-apply on a body switch. */
export function configureBodyConsts(body: Body): void {
  if (body === EARTH) {
    setConst(EARTH_R_C, EARTH_EARTH_R)
    setConst(WGS84_A_C, EARTH_WGS84_A)
    setConst(WGS84_E2_C, EARTH_WGS84_E2)
    return
  }
  setConst(EARTH_R_C, body.sphereR)
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
