// ═══ Baked shaders → the emit pool, at device attach (#1678 phase A of #1484) ═══
//
// The consumption seam. `gpu-boot.ts` calls `seedBakedShaders(ctx.rhi)` the moment a
// device exists; every hillshade permutation the closed set covers is then already in
// the emit pool, so `HillshadeDraper.materialFor` builds its pipeline on the FIRST
// frame it is asked instead of returning null and skipping frames while the optimizer
// fixpoint runs (measured pre-#1405: 2211 ms of main-thread block, ~492 ms after).
//
// ZERO DRAPER CHANGES, on purpose. The draper already asks the pool and already draws
// nothing until the pool answers; the bake is a faster ANSWER, not a second code path.
// A draper that consulted the bake itself would be the second authority for "which
// bytes belong to this request", and the worker / fallback / bake would be three paths
// that must agree instead of one.
//
// PER DEVICE, NOT PER PROCESS. Which artifact is dynamically imported is decided from
// `readsWgsl(rhi)` — a WebGL2 device never downloads the WGSL half and a WebGPU device
// never downloads the GLSL half — and two maps with different backends on one page
// (`map-types.ts` treats that as supported) each seed at their own boot. The dynamic
// import is the precedent `map.ts`'s `_makeWebGl2Device` sets: a boot-time
// `import()` of the half this device actually needs.
//
// The emitter is NOT consulted here, and `emitFor` is deliberately untouched: it runs
// INSIDE the worker (`shader-emit-worker.ts`), so a bake lookup there would drag the
// whole artifact into the worker chunk — where nothing would ever read it, because a
// seeded key never reaches the worker at all.

import { xlog } from '@xgis/shared'
import { bakedShadersDisabled } from '../../debug-flags'
import { readsWgsl, type ShaderSourceDevice } from '../../render/material/wgsl-for'
import { seedShaderSources } from '../emit/shader-emit-pool'
import { bakedAvailableForBody, liveBodyConsts } from './body-guard'
import { HILLSHADE_METHOD_FLAGS, hillshadeGlslId, hillshadeWgslId } from './ids'
import type { BakedArtifact } from './registry'

const PICKS: readonly boolean[] = [false, true]

/** One warn per process for a bake that could not be used. The pool's posture is
 *  resolve-don't-reject (`settleOnMainThread`) and this seam inherits it: an unusable
 *  bake is a slower boot, never a broken one, so it must not throw and must not repeat
 *  itself once per boot for the page's lifetime. Latch pattern: `layer.ts`'s
 *  `_warnedPickingOff`. */
let warned = false
function warnOnce(what: string, why: string): void {
  if (warned) return
  warned = true
  xlog.warn(`[baked-shaders] ${what} — ${why}; falling back to the runtime shader emit`)
}

/** Test-only: reset the warn-once latch between specs (mirrors `_resetListenerWarnings`). */
export function _resetBakedSeedWarning(): void {
  warned = false
}

/** How many pool keys the last `seedBakedShaders` filled, published for the render gate
 *  (0 = the bake did not serve this boot). The gate's two arms are only comparable if it
 *  can prove they DIFFERED in seeding — a hash-equality assertion between two arms that
 *  both emitted at runtime would pass for the wrong reason.
 *
 *  NOT cleared by `map.destroy()`, unlike the map's own window globals: it mirrors the
 *  process-scoped emit pool, whose seeded entries outlive any one map. The decision and
 *  its reasons are pinned in `map/src/destroy-raf-and-globals.test.ts` (section 4). */
function publishSeedCount(n: number): void {
  if (typeof window === 'undefined') return
  // `Object.assign` rather than a `window as unknown as {...}` cast: the cast is the
  // playground's idiom but map/src is under the forced-cast ratchet, and this needs no
  // type hole — the assignment is sound, only the property is undeclared.
  Object.assign(window, { __xgisBakedShaderSeeds: n })
}

/** Seed every hillshade permutation this artifact carries. Returns the number of pool
 *  keys filled — 0 when the body guard closed, or when the artifact does not carry the
 *  hillshade ids (a registry/bake drift; the runtime emit then answers as before).
 *
 *  Pure and synchronous: no device, no dynamic import, no host globals. That is what
 *  lets the seeding gate assert on it directly.
 *
 *  LANGUAGE ASYMMETRY. A GLSL device is seeded `{ vertex, fragment, wgsl: '' }` and a
 *  WGSL device `{ vertex: '', fragment: '', wgsl }`. The empty halves are not a
 *  shortcut — they are the SAME rule `emitFor` already applies in the one direction it
 *  can ("a GLSL-only device never pays for the WGSL"), applied in both: `rhi-webgpu`'s
 *  createPipeline reads `desc.code` and "ignores vsCode/fsCode entirely", `rhi-webgl2`'s
 *  reads `vsCode`/`fsCode` and never touches `desc.code`. Seeding the other language
 *  would mean downloading an artifact no pipeline on this device will ever read. */
export function seedHillshadeFromArtifact(artifact: BakedArtifact, wantWgsl: boolean): number {
  if (!bakedAvailableForBody(artifact.meta)) {
    const live = liveBodyConsts()
    warnOnce(
      'the committed shader bake was skipped',
      `it embeds EARTH_R=${artifact.meta.EARTH_R} / WGS84_A=${artifact.meta.WGS84_A} as literals ` +
        `but this process is configured for EARTH_R=${live.EARTH_R} / WGS84_A=${live.WGS84_A}`,
    )
    return 0
  }
  const sourceOf = (id: string): string | undefined => {
    const hash = artifact.index[id]
    return hash === undefined ? undefined : artifact.contents[hash]
  }

  let seeded = 0
  for (const methodFlag of HILLSHADE_METHOD_FLAGS)
    for (const pick of PICKS) {
      const wgsl = wantWgsl ? sourceOf(hillshadeWgslId(methodFlag, pick)) : ''
      const vertex = wantWgsl ? '' : sourceOf(hillshadeGlslId(methodFlag, pick, 'vertex'))
      const fragment = wantWgsl ? '' : sourceOf(hillshadeGlslId(methodFlag, pick, 'fragment'))
      // A missing id means the registry and the committed artifact have drifted, which
      // `baked-sync.test.ts` fails on. Here it is simply not seeded: the pool emits that
      // permutation the old way rather than the boot dying over a build-time bookkeeping
      // error. Skipped per key, so a partial artifact still serves what it does carry.
      if (wgsl === undefined || vertex === undefined || fragment === undefined) continue
      seedShaderSources({ family: 'hillshade', pick, methodFlag }, { vertex, fragment, wgsl })
      seeded++
    }
  if (seeded === 0)
    warnOnce(
      'the committed shader bake carries no hillshade sources',
      'the registry ids and the artifact index have drifted (see baked-sync.test.ts)',
    )
  return seeded
}

/** Boot entry: import THIS DEVICE's HILLSHADE artifact and seed the pool from it.
 *
 *  ONE FILE, not the whole closed set. The bake is split per (language, group) and the
 *  two `…-rest` files are named by nothing here on purpose: phase A seeds hillshade only,
 *  so importing the rest would make every boot await ~85% of a payload it never reads.
 *  Because no runtime module names them, Rollup drops them from the bundle entirely —
 *  they stay committed and gated as the phase-B payload and the staleness proof.
 *
 *  Never throws and never rejects — a bundle that cannot serve the artifact chunk (a
 *  404 on a deploy rollover, a CSP refusal) must cost a slower first hillshade frame,
 *  not a dead map. Awaited by `bootGpuContext` so the seeds are in place before the
 *  first frame; the import is one module evaluation against `requestDevice()`'s
 *  100-500 ms, and skipping the await would race the very frames this exists to serve. */
export async function seedBakedShaders(rhi: ShaderSourceDevice): Promise<number> {
  if (bakedShadersDisabled()) {
    publishSeedCount(0)
    return 0
  }
  try {
    const wantWgsl = readsWgsl(rhi)
    const artifact = wantWgsl
      ? (await import('./baked-wgsl-hillshade.generated')).BAKED_WGSL_HILLSHADE
      : (await import('./baked-glsl-hillshade.generated')).BAKED_GLSL_HILLSHADE
    const n = seedHillshadeFromArtifact(artifact, wantWgsl)
    publishSeedCount(n)
    return n
  } catch (err) {
    warnOnce('the committed shader bake could not be loaded', String(err))
    publishSeedCount(0)
    return 0
  }
}
