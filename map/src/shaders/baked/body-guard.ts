// ═══ Baked shaders — is this bake valid for the body the process is on? (#1678) ═══
//
// Every baked source embeds the four body-routed GPU consts as EMITTED LITERALS
// (`const float EARTH_R = 6378137.0;` on Earth, `1737400.0` on the Moon), so an
// artifact is only correct for the body it was produced under. A wrong-planet shader
// still compiles and still renders — silent and wrong, the worst failure available
// here — which is exactly why the artifact stamps those four values into its `meta`
// and why nothing may be seeded without comparing them to the live ones first.
//
// COMPARE VALUES, NEVER THE BODY'S NAME. `makeBody('earth-wgs84', 1737400, 0)` is a
// legal Body: a name check would wave it through and serve Earth's bytes for a
// Moon-sized planet. `body-consts.ts` (`setConst`, the ONE writer) is what mutates the
// ConstDecls, so reading them back is reading the same authority the emitters read.
//
// NOT compared here: the artifact's `projectionFingerprint`. It fingerprints the
// host-injected projection graph through its EMITTED WGSL, and computing it would run
// the projection emit — the work the bake exists to avoid — on every boot. That axis is
// a build-time constant (`configureProjections(PROJECTIONS)`, one table) and is gated
// where it costs nothing, in `baked-sync.test.ts`'s meta gate.
//
// Memoised on the body epoch (#1568), which `configureBodyConsts` bumps: the four
// reads are cheap but the guard sits on the boot path and is asked once per language
// artifact. The memo keys on the epoch AND the meta object, because two artifacts can
// be asked in one epoch — an epoch-only memo would answer for whichever was asked
// first.

import { bodyEpochValue } from '../../body-epoch'
import { ECEF_CONSTS } from '../dsl/ecef'
import { PROJECTION_CONSTS } from '../dsl/projections'
import type { BakedMeta } from './registry'

/** The four body-routed GPU consts, live. Deliberately re-derived here rather than
 *  imported from `registry.ts`: that module imports every dsl emitter, and the guard
 *  runs on the boot path of the runtime bundle. */
export interface LiveBodyConsts {
  readonly EARTH_R: number
  readonly EARTH_E2: number
  readonly WGS84_A: number
  readonly WGS84_E2: number
}

function constValue(arr: readonly { name: string; wgslValue: number }[], name: string): number {
  const c = arr.find((d) => d.name === name)
  if (!c) throw new Error(`baked body-guard: missing ConstDecl '${name}'`)
  return c.wgslValue
}

/** What the emitters would embed RIGHT NOW. */
export function liveBodyConsts(): LiveBodyConsts {
  return {
    EARTH_R: constValue(PROJECTION_CONSTS, 'EARTH_R'),
    EARTH_E2: constValue(PROJECTION_CONSTS, 'EARTH_E2'),
    WGS84_A: constValue(ECEF_CONSTS, 'WGS84_A'),
    WGS84_E2: constValue(ECEF_CONSTS, 'WGS84_E2'),
  }
}

let memo: { epoch: number; meta: BakedMeta; ok: boolean } | null = null

/** May this artifact's sources be served to the process as it is configured now?
 *  False whenever ANY of the four consts differs — the caller must then skip the bake
 *  entirely and let the runtime emit answer, which reads the same live ConstDecls. */
export function bakedAvailableForBody(meta: BakedMeta): boolean {
  const epoch = bodyEpochValue()
  if (memo !== null && memo.epoch === epoch && memo.meta === meta) return memo.ok
  const live = liveBodyConsts()
  const ok =
    live.EARTH_R === meta.EARTH_R &&
    live.EARTH_E2 === meta.EARTH_E2 &&
    live.WGS84_A === meta.WGS84_A &&
    live.WGS84_E2 === meta.WGS84_E2
  memo = { epoch, meta, ok }
  return ok
}

/** Test-only: drop the memo. The body is process-global and so is this cache, so a
 *  suite that flips bodies must be able to prove the guard re-derives rather than
 *  replays (`_resetShaderEmitCache` exists for the same reason). */
export function _resetBakedBodyGuardMemo(): void {
  memo = null
}
