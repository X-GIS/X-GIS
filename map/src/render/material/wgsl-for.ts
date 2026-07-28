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
// Both take a THUNK, so the emit does not run before the branch, and both route through
// one `readsWgsl` — deliberately the single place in map/src that asks which language a
// device consumes. Every call site that switches to these DROPS its own backend read
// rather than adding one (map/src/backend-identity-ratchet.test.ts counts them), and
// this is the site that retires the moment RhiCaps grows a shader-language field.

/** Does this device consume the WGSL module (rather than the GLSL ES 3.00 twins)? */
const readsWgsl = (rhi: { readonly backend: string }): boolean => rhi.backend !== 'webgl2'

/** The `MaterialDesc.shader` for a draper that also supplies GLSL twins: the emitted
 *  WGSL on a device that reads WGSL, and nothing at all on one that does not. */
export function wgslFor(rhi: { readonly backend: string }, emit: () => string): string {
  return readsWgsl(rhi) ? emit() : ''
}

/** The mirror: a `vsCode`/`fsCode` half, emitted only on a device that reads GLSL.
 *  `undefined` is what every MaterialDesc already uses for "this backend has no GLSL". */
export function glslFor(rhi: { readonly backend: string }, emit: () => string): string | undefined {
  return readsWgsl(rhi) ? undefined : emit()
}
