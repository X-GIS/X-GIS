// ═══ Shader DSL — capability analysis + gate (Codegen/Backends context) ═══
//
// requiredCaps(module) derives the GPU features a module needs; assertCaps gates
// emit on the target backend covering them, failing closed (UnsupportedFeatureError)
// instead of a silent mis-emit. Wired at the top of every emit entry (#9) so the
// fail-closed promise is real, not the GLSL writer's ad-hoc per-construct throws.
// assertBuiltins is its sibling for the target's BUILTIN VOCABULARY (#1672) — same
// place, same voice, per-backend sets.

import { stageOf, type ModuleDecl, type Capability } from '../ir'
import { Capabilities, type Backend, UnsupportedFeatureError } from '../backend'

/** Capability DEPENDENCIES (#1670) — declaring the key implies needing the values, so a
 *  host activating off `reflect().requiredFeatures` gets the whole set rather than the
 *  half the author happened to name.
 *
 *  `float32Blend ⇒ floatRenderTarget` was discovered the expensive way, in this repo's
 *  own WebGL2 device: rhi-webgl2/src/rhi-webgl2.ts ~:668-676 ANDs `EXT_color_buffer_float`
 *  with `EXT_float_blend` before enabling either, because blending INTO a float target
 *  needs that target to be color-renderable first — with only EXT_float_blend the FBO is
 *  INCOMPLETE and every draw raises GL_INVALID_FRAMEBUFFER_OPERATION. Encoding it here
 *  means a module says `enables: ['float32Blend']` and the host still learns it must
 *  activate both. */
const CAP_IMPLIES: Readonly<Partial<Record<Capability, readonly Capability[]>>> = {
  float32Blend: ['floatRenderTarget'],
}

/** The capabilities a module's emit requires. */
export function requiredCaps(m: ModuleDecl): Capability[] {
  const caps = new Set<Capability>()
  for (const b of m.bindings) {
    if (b.space === 'storage') caps.add('storageBuffer')
    if (b.type.kind === 'texture' && b.type.dim === '2d-ms') caps.add('msaaTextureLoad')
  }
  for (const f of m.funcs) {
    // stageOf reads structured `stage` first (#763 S2) — a hand-built
    // `{ stage: 'compute' }` decl without attrs must NOT slip past the gate.
    if (stageOf(f) === 'compute') caps.add('compute')
  }
  // OPT-IN language-feature caps (#628) — f16 / subgroups the author turned on. Folded
  // in here so assertCaps gates them exactly like the derived resource caps (fail-closed
  // on GLSL); the WGSL backend then emits the matching `enable <ext>;` for each.
  for (const c of m.enables ?? []) caps.add(c)
  // Transitive closure over CAP_IMPLIES, to a fixed point. Today's table is depth 1, so
  // one pass would do — written as a loop anyway, because a future row implying a cap
  // that itself implies another must not need this code re-read to stay correct.
  let grew = true
  while (grew) {
    grew = false
    for (const c of [...caps]) {
      for (const dep of CAP_IMPLIES[c] ?? []) {
        if (caps.has(dep)) continue
        caps.add(dep)
        grew = true
      }
    }
  }
  return [...caps]
}

/** Throw UnsupportedFeatureError if `m` names a `@builtin(...)` id the target does
 *  not have (#1672) — the builtin-vocabulary twin of the capability gate above, run
 *  from the same place (lowerForBackend) so BOTH backends share one mechanism with
 *  per-target sets (`Backend.absentBuiltins`). The GLSL writer keeps its own
 *  rejection (builtinIn/builtinOut, whose messages name the missing gl_* mapping)
 *  and declares no set, so this pass is a no-op for it; the WGSL writer had NO such
 *  rejection at all — it spelled `@builtin(point_size)` verbatim and the module died
 *  at naga, far from the author.
 *
 *  STRUCTURED FIELD ONLY (#740 R3): `attr` is the emit SPELLING, the `builtin` field
 *  is the semantic source. Every sot-authored IO (`builtin(name, type)`) and every
 *  builder-made entry param carries it; a hand-built decl literal carrying only
 *  `attr: '@builtin(x)'` is outside that contract and is skipped here (the GLSL
 *  writer's ioAttr keeps a regex fallback for those legacy fixtures — this gate
 *  deliberately does not replicate it, so the structured field stays the one
 *  authority a target-vocabulary decision reads). */
export function assertBuiltins(backend: Backend, m: ModuleDecl): void {
  const absent = backend.absentBuiltins
  if (absent === undefined) return
  const check = (b: string | undefined): void => {
    const why = b === undefined ? undefined : absent.get(b)
    if (why !== undefined) throw new UnsupportedFeatureError(`${backend.id}: @builtin(${b}) ${why}`)
  }
  // Every place a backend can SPELL a builtin attr: an IO struct field, an entry
  // param, and a bare return authored as `retAttr: builtin(name, T)` — the builder
  // preserves that FieldSpec's id as `retBuiltin` (#1672 review finding: it used to
  // be discarded, leaving retAttr the one structured-authoring path this gate missed).
  for (const s of m.structs) for (const sf of s.fields) check(sf.builtin)
  for (const f of m.funcs) {
    for (const p of f.params) check(p.builtin)
    check(f.retBuiltin)
  }
}

/** Throw UnsupportedFeatureError if `backend` cannot cover everything `m` needs. */
export function assertCaps(backend: Backend, m: ModuleDecl): void {
  const req = requiredCaps(m)
  // Coverage is DERIVED from the one authority (#1670) — the backend carries the
  // `capProfile` table and nothing else; a cached `caps` field beside it was a second
  // place the same fact could live. Built once per call, over 9 keys.
  const caps = Capabilities.fromProfile(backend.capProfile)
  if (!caps.covers(req)) {
    const missing = caps.missing(req)
    throw new UnsupportedFeatureError(
      `backend '${backend.id}' cannot emit this module — missing capabilities: ${missing.join(', ')}`,
    )
  }
}
