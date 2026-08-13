// ═══ Don't emit a shader language the device will never read ═══
//
// Every draper hands `Material` BOTH source languages so one MaterialDesc builds on
// either backend (the #783 dual-source contract). But each device reads exactly one of
// them: `rhi-webgl2`'s createPipeline requires the GLSL `vsCode`/`fsCode` and never
// touches `desc.code` — its own createpipeline-dual-source-guard.test.ts fail-louds on
// a WGSL-only desc, which is the proof that WGSL is dead weight there — and WebGPU is
// the mirror image, ignoring the GLSL halves entirely.
//
// Dead weight is not free. Emitting a language runs the whole shader-dsl pipeline
// (validate → autoVars → lowerModule → fp64Lower → the optimizer FIXPOINT) over the
// module. Measured across the map's draper sites, the discarded WGSL alone is ~768 ms
// of a WebGL2 session — 132 ms for the polygon flat fill, 152 ms for line, 116 ms for
// particle, and so on. It is paid synchronously, on the main thread, at the moment each
// layer first draws.
//
// All three take a THUNK, so the emit does not run before the branch, and all route
// through one `readsWgsl` — deliberately the single place in map/src that asks which
// language a device consumes. Every call site that switched to these DROPPED its own
// backend read rather than adding one (map/src/backend-identity-ratchet.test.ts counts
// them), and `readsWgsl` itself now asks the CAPABILITY rather than the backend's
// identity, which is what the F3–F6 sweep is for: a third backend answers the question
// by populating `caps.shaderLanguage`, not by being added to a `!== 'webgl2'` here.
//
// ── THE BAKED SEAM: an OPTIONAL id beside each thunk (#1679 phase B, increment 3) ──
//
// Each helper takes an optional trailing baked id. Given one, it asks the baked store
// (`shaders/baked/store.ts`) for that id's bytes and runs the thunk only if the store
// does not answer. Given NOTHING it runs the thunk exactly as it did before — the store
// is not consulted at all, so a call site that passes no id is bit-identical to today.
//
// A MISS FALLS THROUGH, and the fall-through is that same path: the same thunk, the same
// emit, the same bytes. An id that is misspelled, uninstalled, or closed by a body flip
// therefore costs a slower first draw and nothing else — it can never change a pixel.
// (Only the store can say which of those three happened, which is why it counts them
// apart: `miss` is the bug, `absent` and `closed` are expected. See its header.)
//
// WHY THE PARAMETER IS OPTIONAL RATHER THAN REQUIRED. A required id would force all ~49
// existing call sites to change in ONE indivisible step — every draper at once, no
// increment landable or revertible on its own, and the whole seam judged by a single
// reviewable commit. Optional lets the closed set opt IN a few sites at a time while the
// open set (a draper whose module is deliberately not baked, or one not keyed yet) opts
// OUT by passing nothing, which is exactly its state today.
//
// The id must come from `shaders/baked/ids.ts` (the grammar's only authority), and from
// the SAME VALUE that drives the emit beside it — `POLY_STROKE` feeds both
// `emitPolygonGlslStages` and `polygonGlslIds`, so an id naming one entry while the thunk
// emits another is unrepresentable rather than merely unlikely. `pick` likewise comes
// from the call site's own argument, NEVER from the `isPickEnabled()` global: the id has
// to describe the bytes this call actually asked for.

import { bakedSource } from '../../shaders/baked/store'

/** Does this device consume the WGSL module (rather than the GLSL ES 3.00 twins)?
 *  Exported for the emit seam, which must decide WHETHER TO ASK for the WGSL before any
 *  string exists — a thunk-taking helper cannot express that. */
export const readsWgsl = (rhi: ShaderSourceDevice): boolean => rhi.caps.shaderLanguage === 'wgsl'

/** The slice of the device these helpers read — the capability, nothing else. Narrow on
 *  purpose: a test stub needs only this, and no consumer can reach for `backend`. */
export interface ShaderSourceDevice {
  readonly caps: { readonly shaderLanguage: 'wgsl' | 'glsl-es300' }
}

/** The `MaterialDesc.shader` for a draper that also supplies GLSL twins: the emitted
 *  WGSL on a device that reads WGSL, and nothing at all on one that does not.
 *
 *  `''` rather than `undefined` on the GLSL device because `MaterialDesc.shader` is
 *  REQUIRED — and it is returned without consulting the store: bytes that will not be
 *  read are not worth a lookup, let alone one the accounting would have to explain. */
export function wgslFor(rhi: ShaderSourceDevice, emit: () => string, id?: string): string {
  if (!readsWgsl(rhi)) return ''
  if (id === undefined) return emit()
  return bakedSource(id) ?? emit()
}

/** The mirror: a `vsCode`/`fsCode` half, emitted only on a device that reads GLSL.
 *  `undefined` is what every MaterialDesc already uses for "this backend has no GLSL". */
export function glslFor(
  rhi: ShaderSourceDevice,
  emit: () => string,
  id?: string,
): string | undefined {
  if (readsWgsl(rhi)) return undefined
  if (id === undefined) return emit()
  return bakedSource(id) ?? emit()
}

/** BOTH GLSL halves at once, as MaterialDesc fields — spread it into the descriptor.
 *
 *  Prefer this over two `glslFor` calls: a family's `…GlslStages` emitter lowers and
 *  optimises the module ONCE for both stages, where two per-stage emitters lower it
 *  twice, and that lowering is the entire cost (`buildPolygonModule` measures 2 ms
 *  against 80 ms for the vertex emit alone).
 *
 *  Returning the fields rather than the strings is what lets a draper drop its own
 *  `const gl2 = rhi.backend === 'webgl2'`: the empty object spreads to nothing, which is
 *  exactly the `{}` those call sites were building by hand.
 *
 *  BOTH-OR-NEITHER on the baked ids: the store serves this pair only when BOTH stages
 *  hit. That is not caution, it is the arithmetic of the shared lowering above — the
 *  thunk emits both stages from ONE lowering, so a half-hit would run it anyway and
 *  save nothing, while handing back a descriptor whose two halves came from different
 *  producers. Both ids are still LOOKED UP on a half-hit rather than short-circuited, so
 *  the store's by-name sets describe what actually happened: both stages were emitted,
 *  and the fall-through stage's counter (miss / absent / closed) says why. The hitting
 *  stage counts as a store hit whose bytes were dropped — the store counts lookups, and
 *  the pair's provenance is what this function owns. */
export function glslStagesFor(
  rhi: ShaderSourceDevice,
  emit: () => { vertex: string; fragment: string },
  ids?: { vertex: string; fragment: string },
): { vsCode?: string; fsCode?: string } {
  if (readsWgsl(rhi)) return {}
  if (ids !== undefined) {
    const bakedVertex = bakedSource(ids.vertex)
    const bakedFragment = bakedSource(ids.fragment)
    if (bakedVertex !== undefined && bakedFragment !== undefined)
      return { vsCode: bakedVertex, fsCode: bakedFragment }
  }
  const { vertex, fragment } = emit()
  return { vsCode: vertex, fsCode: fragment }
}
