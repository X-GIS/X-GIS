// ═══ Shader emit — the request shape and the ONE dispatch both sides run ═══
//
// Emitting a shader is pure string work: no DOM, no GPU handle, no canvas. It is also
// the single largest synchronous block a layer's first draw pays — measured at 2211 ms
// for the multidirectional hillshade before #1405, ~492 ms after. That block freezes the
// WHOLE map, basemap included, which is the reported symptom; the relief itself is gated
// by DEM tiles (~131-143 KB each over six slots) that take longer to arrive than the emit
// takes to run, so moving the work OFF the main thread recovers the freeze without
// costing time-to-relief.
//
// This module is the seam's contract. `emitFor` is deliberately the ONLY place a request
// turns into sources, and BOTH the worker and the main-thread fallback call it — a worker
// that emitted through its own copy of this dispatch could drift from the fallback, and
// the drift would be invisible until a browser without workers rendered differently.
//
// Adding a family is a case here plus a key in `shaderRequestKey`; nothing else changes.

import { emitGlslStages } from '@xgis/shader-dsl'
import { buildHillshadeModule, emitHillshadeWgsl } from '../dsl/hillshade'
import { bodyEpochValue } from '../../body-epoch'
import { shipSource } from '../../render/material/wgsl-for'

/** Which shader to emit. Structured-cloneable by construction — it crosses a worker
 *  boundary — so no Nodes, no functions, no class instances. */
export type ShaderEmitRequest = {
  readonly family: 'hillshade'
  /** Pick-pass variant (a second colour target). */
  readonly pick: boolean
  /** hillshadeMethodFlag: 0 standard / 1 basic / 2 combined / 3 igor / 4 multidirectional. */
  readonly methodFlag: number
}

/** What a device needs to build a pipeline. `wgsl` is empty for a request answered on
 *  behalf of a GLSL-only device — see `emitFor`. */
export interface ShaderSources {
  readonly vertex: string
  readonly fragment: string
  readonly wgsl: string
}

/** Cache/dedup key. Must be injective over the request — two requests sharing a key
 *  would serve one's sources for the other.
 *
 *  #1568 — the body epoch is part of the key even though it is not part of the
 *  request. The one family in play declares `consts: [...PROJECTION_CONSTS,
 *  ...ECEF_CONSTS]`, which embed EARTH_R / EARTH_E2 / WGS84_A / WGS84_E2 as EMITTED
 *  LITERALS, so the same `(family, methodFlag, pick)` produces different bytes on
 *  different planets. The off-thread fix already rides the body on each request
 *  (`shader-emit-pool.ts` sends `activeBody()`), and `shader-emit-worker.ts`
 *  documents this exact hazard — "wrong planet, silent and wrong" — but
 *  `requestShaderSources` returns `done.get(key)` BEFORE any request is posted, so
 *  the ridden body only mattered on a miss. Key space is 10 per epoch, so this is
 *  staleness being fixed, not growth being introduced. */
export function shaderRequestKey(r: ShaderEmitRequest): string {
  return `${r.family}:${r.methodFlag}:${r.pick ? 'p' : 'n'}:b${bodyEpochValue()}`
}

/** Turn a request into sources. Pure, and the single authority for both the worker and
 *  the synchronous fallback.
 *
 *  `wantWgsl` is the caller's device capability (RhiCaps.shaderLanguage), not a
 *  preference: a WebGL2 device never reads `RhiPipelineDesc.code`, and emitting it anyway
 *  was 693 ms of that 2211 ms block. It is a REQUEST field rather than a post-filter so
 *  the cost is never paid inside the worker either. */
export function emitFor(req: ShaderEmitRequest, wantWgsl: boolean): ShaderSources {
  const mod = buildHillshadeModule(req.pick, req.methodFlag)
  const glsl = emitGlslStages(mod)
  // Through `shipSource` (#1889) — this pool bypasses the `wgslFor`/`glslStagesFor` seam, and
  // its output is compared BYTE-FOR-BYTE against the baked artifact by `seed-hillshade` and
  // `baked-body-guard`. Those two gates are the reason the transform cannot live only in the
  // bake: they exist to prove a seeded hit and an unseeded miss are interchangeable.
  return {
    vertex: shipSource(glsl.vertex),
    fragment: shipSource(glsl.fragment),
    wgsl: wantWgsl ? shipSource(emitHillshadeWgsl(req.pick, req.methodFlag)) : '',
  }
}
