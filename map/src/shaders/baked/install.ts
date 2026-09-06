// ═══ Baked shaders → the lookup STORE, at device attach (#1679 phase B, increment 4) ═══
//
// The second consumption seam, beside phase A's pool seeding. `seed-hillshade.ts` fills the
// EMIT POOL (a hillshade-shaped cache the draper already asks); this fills the baked-source
// STORE (`store.ts`), which is what the emit seam `wgsl-for.ts` reads when a call site
// passes an id. Two mechanisms because they answer two different questions — the pool
// answers "what are hillshade's bytes for this request", the store answers "does the bake
// carry THIS id" — and phase A's path is deliberately left untouched here.
//
// WHAT IS DOWNLOADED, AND WHAT IS NOT. At attach, exactly one file: the BOOT group of the
// device's own language. The `lazy` group is fetched by `prefetchLazyShaders` below, and only
// from a REGISTRATION seam (a retained-graphics add, a heatmap layer, a coverage with a
// vector band) — so Rollup keeps it a separate chunk a plain basemap boot never downloads —
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
import { bakedSeamEmitted, bakedSeamServed, bakedStoreStats, mergeBakedSources } from './store'
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

/** Publish a LIVE reader of the store's accounting as `window.__xgisBakedStore()` — the same
 *  shape as `seed-hillshade.ts`'s `__xgisBakedShaderSeeds`, and for the same reader: an e2e
 *  gate. The boot provenance gate (#2499) classifies the BYTES the driver receives, and bytes
 *  carry no provenance — a hit and a miss serve the same text by the seam's own contract
 *  (`wgsl-for.ts`: `bakedSource(id) ?? shipSource(emit())`), so only these counters can say
 *  whether a boot READ its bake (`hits`, `served`) or paid the emit (`misses`, `emitted`).
 *  A function, not a snapshot, so the gate reads the state at the moment it asks. Published
 *  even when `?nobake=1` switches the seam off, so the gate can assert `hits === 0` there.
 *  Process-scoped like the store itself; `map.destroy()` does not clear it (see
 *  `destroy-raf-and-globals.test.ts` section 4 for the rule the two #1678 counters set). */
function publishStoreReader(): void {
  if (typeof window === 'undefined') return
  // `Object.assign` rather than a `window as unknown as {…}` cast — map/src is under the
  // forced-cast ratchet, and the assignment needs no type hole (see `publishSeedCount`).
  Object.assign(window, {
    __xgisBakedStore: () => ({
      ...bakedStoreStats(),
      served: bakedSeamServed(),
      emitted: bakedSeamEmitted(),
    }),
  })
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
  publishStoreReader()
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

/** In-flight/settled lazy install, per process. The artifact is process-scoped state (it
 *  merges into the same store), so a second caller must join the first rather than start a
 *  second import — `addLayer` is called once per heatmap layer, and a style with four of
 *  them must not fetch the chunk four times. */
let _lazyInstall: Promise<number> | null = null

/** Test-only: forget the in-flight lazy install (mirrors `_resetBakedInstallWarning`). */
export function _resetLazyInstall(): void {
  _lazyInstall = null
}

/** START fetching the LAZY group. Fire-and-forget by contract — the caller is a
 *  registration path (`HeatmapRenderer.addLayer`, …), not a draw, and must not become
 *  async for this.
 *
 *  WHY A PREFETCH AND NOT A LOOKUP-TIME LOAD. Every lazy draper is built SYNCHRONOUSLY
 *  (`HeatmapRenderer.drapers()` is a memoised getter fired on the draw path), so a draper
 *  cannot await a chunk. Starting the import at CONSTRUCTION would therefore miss on the
 *  first build — paying the full emit AND the chunk — and only help a rebuild that never
 *  comes. The registration seam is what makes it work: `addLayer` runs strictly before the
 *  first draw (its own comment records the drapers being "built lazily at first draw so
 *  addLayer never touches the stub device"), so the fetch has a real window to land in.
 *
 *  MEASURED (#1679 inc 9): the lazy artifacts are ~4.9 KB / ~4.6 KB gzip and are imported
 *  by nobody today, so Rollup drops them — this ADDS a chunk rather than saving one. What
 *  it buys is the emit that chunk replaces: heatmap's three passes cost 33.9 ms (WGSL) /
 *  38.4 ms (GLSL stages) of SYNCHRONOUS main-thread block, mid-session, at the moment the
 *  first heatmap layer draws. Trading an off-main-thread fetch for a two-frame hitch.
 *
 *  Never throws and never rejects: an unusable lazy chunk costs the emit that was going to
 *  happen anyway. */
export function prefetchLazyShaders(rhi: ShaderSourceDevice): void {
  if (bakedShadersDisabled() || _lazyInstall !== null) return
  _lazyInstall = (async () => {
    try {
      const artifact: BakedArtifact = readsWgsl(rhi)
        ? (await import('./baked-wgsl-lazy.generated')).BAKED_WGSL_LAZY
        : (await import('./baked-glsl-lazy.generated')).BAKED_GLSL_LAZY
      mergeBakedSources(artifact)
      return Object.keys(artifact.index).length
    } catch (err) {
      warnOnce(String(err))
      return 0
    }
  })()
  void _lazyInstall
}
