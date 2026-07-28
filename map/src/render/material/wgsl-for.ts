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

/** Does this device consume the WGSL module (rather than the GLSL ES 3.00 twins)? */
const readsWgsl = (rhi: ShaderSourceDevice): boolean => rhi.caps.shaderLanguage === 'wgsl'

/** The slice of the device these helpers read — the capability, nothing else. Narrow on
 *  purpose: a test stub needs only this, and no consumer can reach for `backend`. */
export interface ShaderSourceDevice {
  readonly caps: { readonly shaderLanguage: 'wgsl' | 'glsl-es300' }
}

/** The `MaterialDesc.shader` for a draper that also supplies GLSL twins: the emitted
 *  WGSL on a device that reads WGSL, and nothing at all on one that does not. */
export function wgslFor(rhi: ShaderSourceDevice, emit: () => string): string {
  return readsWgsl(rhi) ? emit() : ''
}

/** The mirror: a `vsCode`/`fsCode` half, emitted only on a device that reads GLSL.
 *  `undefined` is what every MaterialDesc already uses for "this backend has no GLSL". */
export function glslFor(rhi: ShaderSourceDevice, emit: () => string): string | undefined {
  return readsWgsl(rhi) ? undefined : emit()
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
 *  exactly the `{}` those call sites were building by hand. */
export function glslStagesFor(
  rhi: ShaderSourceDevice,
  emit: () => { vertex: string; fragment: string },
): { vsCode?: string; fsCode?: string } {
  if (readsWgsl(rhi)) return {}
  const { vertex, fragment } = emit()
  return { vsCode: vertex, fsCode: fragment }
}
