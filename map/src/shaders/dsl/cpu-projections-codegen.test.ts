// ═══ cpu-projections js-codegen — differential + microbench (#1162) ═══
//
// GATE A1 (keystone): for EVERY fn in the real PROJECTION_MODULE, the js-source
// backend (compileModuleJs) is BIT-IDENTICAL to the tree-walk interpreter
// (compileModule) over randomized (seeded, deterministic) + boundary inputs
// (poles ±90, dateline ±180, equator, mercator limit ±85.051129, every projType
// 0..7). Object.is per element — same f64 op tree ⇒ bit-equal; any epsilon means
// the codegen diverged. This is what licenses cpu-projections.ts to prefer the
// js backend in production (the ~40 %-of-frame interpreter share, #1162).
//
// GATE A2: microbench (logged) — N=100k calls of the representative scalar
// projection forwards (proj_mercator + the `project` dispatcher), interpreter vs
// codegen. The tile-selection 9-point probes + label anchors are these calls.

import { describe, it, expect } from 'vitest'
import { compileModule, compileModuleJs } from '@xgis/shader-dsl'
import type { ShaderType } from '@xgis/shader-dsl'
import { getPROJECTION_MODULE } from './projections'

// ── seeded RNG ──
function mulberry32(seed: number): () => number {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Projection-relevant scalar boundaries (poles, dateline, equator, mercator
// clamp, mid-lat) + a broad numeric spread.
const LON = [0, 180, -180, 90, -90, 45, -45, 179.999, -179.999, 1e-6, 200, -200]
const LAT = [0, 90, -90, 85.051129, -85.051129, 60, -60, 45, 89.9, -89.9, 1e-6]
const GENERIC = [0, 1, -1, 0.5, -0.5, 2, -2, Math.PI, -Math.PI, 1e-7, 1e7, 100, 0.25]

function pick(arr: number[], rng: () => number): number {
  return arr[Math.floor(rng() * arr.length)]!
}

// One arg value for a param, shaped by its type + a projType cycle so the
// dispatch ladders exercise every projection arm.
function genArg(
  t: ShaderType,
  name: string,
  rng: () => number,
  projType: number,
  boundary: boolean,
): number | number[] {
  if (t.kind === 'vec' || t.kind === 'vec64') {
    // proj_params = (projType, clon, clat, 0) — feed the cycling projType +
    // centre lon/lat so `project` / `needs_backface_cull` hit each arm.
    if (name === 'proj_params' && t.n === 4) return [projType, pick(LON, rng), pick(LAT, rng), 0]
    if (name === 'globe_eye' && t.n === 4) {
      // (normalize(eye).xyz, EARTH_R/|eye|) — plausible shape; bit-identity
      // holds for any value, this just keeps the globe arm realistic.
      const v = [rng() - 0.5, rng() - 0.5, rng() - 0.5]
      const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
      return [v[0]! / l, v[1]! / l, v[2]! / l, rng()]
    }
    return Array.from({ length: t.n }, () => (boundary ? pick(GENERIC, rng) : (rng() - 0.5) * 400))
  }
  // scalar
  if (/lon/i.test(name)) return boundary ? pick(LON, rng) : (rng() - 0.5) * 400
  if (/lat|phi/i.test(name)) return boundary ? pick(LAT, rng) : (rng() - 0.5) * 200
  return boundary ? pick(GENERIC, rng) : (rng() - 0.5) * 400
}

function clone<T>(v: T): T {
  return Array.isArray(v) ? (v.map((x) => clone(x)) as unknown as T) : v
}

function bitEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!bitEqual(a[i], b[i])) return false
    return true
  }
  return Object.is(a, b)
}

describe('cpu-projections — js-codegen bit-identical to interpreter (GATE A1)', () => {
  const m = getPROJECTION_MODULE()
  const jsMod = compileModuleJs(m)
  const interpMod = compileModule(m)

  it('every projection fn is Object.is-equal over projType sweep + boundary + seeded-random inputs', () => {
    const PER_FN = 800
    let fnCount = 0
    let inputCount = 0
    const divergences: string[] = []

    for (const f of m.funcs) {
      fnCount++
      const jsFn = jsMod.fns[f.name]!
      const interpFn = interpMod.fns[f.name]!
      const seed = f.name
        .split('')
        .reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 0x9e3779b9)
      const rng = mulberry32(seed)
      for (let k = 0; k < PER_FN; k++) {
        const boundary = k < PER_FN / 2
        const projType = k % 8 // cycle 0..7 so proj_params.x covers every arm
        const args = f.params.map((p) => genArg(p.type, p.name, rng, projType, boundary))
        const a = jsFn(...(clone(args) as never[]))
        const b = interpFn(...(clone(args) as never[]))
        inputCount++
        if (!bitEqual(a, b)) {
          divergences.push(
            `${f.name}(${JSON.stringify(args)}): js=${JSON.stringify(a)} interp=${JSON.stringify(b)}`,
          )
          if (divergences.length > 15) break
        }
      }
      if (divergences.length > 15) break
    }

    console.log(
      `[GATE A1] PROJECTION_MODULE: ${fnCount} fns × ${PER_FN} inputs = ${inputCount} exact-equality checks`,
    )
    expect(divergences).toEqual([])
    expect(fnCount).toBe(m.funcs.length)
  })

  it('exposes the same fn set + CpuModule shape as the interpreter', () => {
    expect(Object.keys(jsMod.fns).sort()).toEqual(Object.keys(interpMod.fns).sort())
    expect(typeof jsMod.setBinding).toBe('function')
  })
})

describe('cpu-projections — microbench (GATE A2, logged not asserted)', () => {
  it('N=100k calls: interpreter vs codegen for proj_mercator + project', () => {
    const m = getPROJECTION_MODULE()
    const js = compileModuleJs(m).fns
    const interp = compileModule(m).fns
    const N = 100_000

    const bench = (
      label: string,
      jsFn: (...a: never[]) => unknown,
      iFn: (...a: never[]) => unknown,
      mkArgs: (i: number) => unknown[],
    ) => {
      for (let i = 0; i < 3000; i++) {
        jsFn(...(mkArgs(i) as never[]))
        iFn(...(mkArgs(i) as never[]))
      }
      const t0 = performance.now()
      for (let i = 0; i < N; i++) iFn(...(mkArgs(i) as never[]))
      const tI = performance.now() - t0
      const t1 = performance.now()
      for (let i = 0; i < N; i++) jsFn(...(mkArgs(i) as never[]))
      const tC = performance.now() - t1

      console.log(
        `[GATE A2] ${label} ×${N}: interpreter ${tI.toFixed(1)}ms · codegen ${tC.toFixed(1)}ms · speedup ${(tI / tC).toFixed(2)}×`,
      )
      return tC
    }

    // proj_mercator(lon, lat) — the pure scalar forward.
    const tMerc = bench('proj_mercator', js.proj_mercator!, interp.proj_mercator!, (i) => [
      (i % 360) - 180,
      ((i * 7) % 170) - 85,
    ])
    // project(lon, lat, proj_params) — the dispatch ladder (mercator arm).
    const tProj = bench('project', js.project!, interp.project!, (i) => [
      (i % 360) - 180,
      ((i * 7) % 170) - 85,
      [0, 0, 0, 0],
    ])
    expect(tMerc).toBeGreaterThan(0)
    expect(tProj).toBeGreaterThan(0)
  })
})
