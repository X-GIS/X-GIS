// ═══ Shader DSL — capability analysis + gate (Codegen/Backends context) ═══
//
// requiredCaps(module) derives the GPU features a module needs; assertCaps gates
// emit on the target backend covering them, failing closed (UnsupportedFeatureError)
// instead of a silent mis-emit. Wired at the top of every emit entry (#9) so the
// fail-closed promise is real, not the GLSL writer's ad-hoc per-construct throws.

import { stageOf, type ModuleDecl, type Capability } from '../ir'
import { type Backend, UnsupportedFeatureError } from '../backend'

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
  return [...caps]
}

/** Throw UnsupportedFeatureError if `backend` cannot cover everything `m` needs. */
export function assertCaps(backend: Backend, m: ModuleDecl): void {
  const req = requiredCaps(m)
  if (!backend.caps.covers(req)) {
    const missing = backend.caps.missing(req)
    throw new UnsupportedFeatureError(
      `backend '${backend.id}' cannot emit this module — missing capabilities: ${missing.join(', ')}`,
    )
  }
}
