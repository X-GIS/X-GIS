// ═══ Shader emit worker — the optimizer fixpoint, off the main thread ═══
//
// Thin by design: configure the process-globals the emitters require, then delegate to
// `emitFor` (shader-emit-request.ts), which the main-thread fallback also calls. All the
// intelligence lives there so the two paths cannot drift.
//
// TWO globals must be configured before any emit, and BOTH are per-map runtime state
// rather than constants, so the request carries what it needs:
//
//  • configureProjections(PROJECTIONS) — the emitters throw without it. Constant, so it
//    runs once at module load.
//  • the BODY. `applyBodyOption` rewrites EARTH_R / EARTH_E2 / WGS84_A / WGS84_E2, and
//    those are emitted as LITERALS inside the shader — measured, Earth vs Moon differ:
//    `const float EARTH_R = 6378137.0;` vs `1737400.0`, and the strings differ in length.
//    A worker that assumed Earth would hand a non-Earth map a shader that still compiles
//    and still renders, just against the wrong planet — silent and wrong, the worst
//    failure available here. So the body rides on every request and is applied before
//    the emit (configureBodyConsts is idempotent).

import { configureProjections } from '../dsl/projections'
import { PROJECTIONS } from '@xgis/geo'
import { configureBodyConsts } from '../../body-consts'
import type { Body } from '@xgis/shared'
import { emitFor, type ShaderEmitRequest, type ShaderSources } from './shader-emit-request'

configureProjections(PROJECTIONS)

export interface EmitInMsg {
  readonly taskId: number
  readonly req: ShaderEmitRequest
  readonly wantWgsl: boolean
  readonly body: Body
}
export type EmitOutMsg =
  | { readonly kind: 'sources'; readonly taskId: number; readonly sources: ShaderSources }
  | { readonly kind: 'error'; readonly taskId: number; readonly message: string }

/** The ONE place this module leaves the type system. `self` types as a Window under the
 *  app's DOM lib, not a DedicatedWorkerGlobalScope, so posting needs a cast somewhere;
 *  funnelling both replies through here keeps it to a single documented site instead of
 *  one per post, and gives the reply a checked `EmitOutMsg` type on the way in.
 *  (Same seam and same reason as data/src/workers/geojson-tiling-worker.ts.) */
const post = (msg: EmitOutMsg): void => {
  ;(self as unknown as { postMessage(v: EmitOutMsg): void }).postMessage(msg)
}

self.addEventListener('message', (ev: MessageEvent) => {
  const m = ev.data as EmitInMsg
  try {
    configureBodyConsts(m.body)
    post({ kind: 'sources', taskId: m.taskId, sources: emitFor(m.req, m.wantWgsl) })
  } catch (err) {
    // Reported, never swallowed: a failed emit means the layer never draws, and a silent
    // one would read as "the tiles are still loading" forever.
    post({ kind: 'error', taskId: m.taskId, message: (err as Error)?.stack ?? String(err) })
  }
})
