// ═══ Baked shaders → the lookup STORE, at device attach (#1679 phase B, increment 4) ═══
//
// The second consumption seam, beside phase A's pool seeding. `seed-hillshade.ts` fills the
// EMIT POOL (a hillshade-shaped cache the draper already asks); this fills the baked-source
// STORE (`store.ts`), which is what the emit seam `wgsl-for.ts` reads when a call site
// passes an id. Two mechanisms because they answer two different questions — the pool
// answers "what are hillshade's bytes for this request", the store answers "does the bake
// carry THIS id" — and phase A's path is deliberately left untouched here.
//
// WHAT IS DOWNLOADED, AND WHAT IS NOT. Exactly one file: the BOOT group of the device's own
// language. The `lazy` group is named by nothing at runtime — not by this module, not by a
// draper — which is what keeps Rollup dropping those two artifacts from the bundle whole,
// and the `hillshade` group is the seeder's. So a WebGL2 boot downloads one GLSL chunk and
// a WebGPU boot one WGSL chunk, and neither pays for the other's language (`readsWgsl` is
// the one place in map/src that asks which language a device consumes).
//
// MERGE, NOT INSTALL. `installBakedSources` REPLACES the store and resets its accounting;
// that is the right shape for a spec, and the wrong one here. Two maps with different
// backends on one page is supported (`map-types.ts`), each boots its own device, and the
// second boot must not evict the first map's sources — which is exactly the contract
// `store.ts`'s header states for `mergeBakedSources` ("a second group, or a second device's
// language, must not evict the first"). Re-installing the same artifact is idempotent: the
// ids are keys in a Map.
//
// NEVER THROWS, NEVER REJECTS — the same posture as `seedBakedShaders`, and for the same
// reason: `bootGpuContext` AWAITS this call, so a chunk that will not load (a 404 on a
// deploy rollover, a CSP refusal, a renamed export after a bad merge) must cost a slower
// first draw and not a dead map. Every id that then falls through runs the very thunk it
// would have run before the seam existed, so the fall-back is bit-identical to the old path.
//
// IMPORT CEILING — `./store` and `./registry` FOR TYPES ONLY, plus the two host seams the
// seeder already uses. A value import of `registry.ts` would drag all 24 dsl emitters into
// the runtime bundle and defeat the bake; Gate 9 of `architecture-invariants.test.ts` is
// what enforces that, and it walks this file too.

import { xlog } from '@xgis/shared'
import { bakedShadersDisabled } from '../../debug-flags'
import { readsWgsl, type ShaderSourceDevice } from '../../render/material/wgsl-for'
import { mergeBakedSources } from './store'
import type { BakedArtifact } from './registry'

/** One warn per process, mirroring `seed-hillshade.ts`'s latch: an unusable bake is a
 *  slower first draw, and a boot must not repeat that line for the page's lifetime. */
let warned = false
function warnOnce(why: string): void {
  if (warned) return
  warned = true
  xlog.warn(
    `[baked-shaders] the boot-group shader artifact could not be installed — ${why}; ` +
      `every keyed call site falls back to its runtime emit`,
  )
}

/** Test-only: reset the warn-once latch between specs. */
export function _resetBakedInstallWarning(): void {
  warned = false
}

/** Import THIS DEVICE's boot-group artifact and merge it into the baked-source store.
 *  Returns how many ids the store now carries from it — 0 when the seam is switched off
 *  (`?nobake=1`) or the chunk could not be loaded.
 *
 *  The BODY GUARD IS NOT ASKED HERE. It is asked per LOOKUP (`store.ts`), which is what
 *  lets a process that flips to another planet and back re-open the bake instead of
 *  closing it for the page's life. So a Moon boot still installs, and every lookup then
 *  reports `closed` — expected, counted apart from the `miss` that is a bug. */
export async function installBakedShaders(rhi: ShaderSourceDevice): Promise<number> {
  if (bakedShadersDisabled()) return 0
  try {
    const artifact: BakedArtifact = readsWgsl(rhi)
      ? (await import('./baked-wgsl-boot.generated')).BAKED_WGSL_BOOT
      : (await import('./baked-glsl-boot.generated')).BAKED_GLSL_BOOT
    mergeBakedSources(artifact)
    return Object.keys(artifact.index).length
  } catch (err) {
    warnOnce(String(err))
    return 0
  }
}
