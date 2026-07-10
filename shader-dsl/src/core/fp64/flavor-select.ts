// ═══ Shader DSL — df64 flavor recommendation (device → 'float' | 'integer') ═══
//
// The integer df64 flavor (df64-int.ts) exists because Apple's Metal shader
// compiler reassociates the float EFT error terms at ANY large-magnitude
// cancellation — proven on-device (probe history, PR #924–#932): every float
// barrier collapses on Apple while the integer lowering passes 9/9. Elsewhere
// the guarded float flavor is correct on the real chains and cheaper, so:
//
//   Apple GPU (Metal underneath — WebGPU or WebGL2-via-ANGLE-Metal) → 'integer'
//   everything else                                                 → 'float'
//
// ANGLE-D3D11 note: FXC also folds deep SYNTHETIC df64 composition trees, but
// the production chains hold under the float flavor's renorm there, and FXC's
// compile cost on the fully-inlined integer bodies can TDR — so D3D11 stays
// 'float' deliberately (documented residual risk on adversarial deep trees).
//
// The DSL cannot see a GPU — it is a standalone library. Consumers collect the
// signals (a WebGPU adapter's `info`, a WebGL2 UNMASKED_RENDERER string, a
// user-agent) with whatever they have and pass them here; any single Apple
// signal selects the integer flavor. All signals optional — no signals means
// 'float' (the default, byte-identical lowering).

import type { Fp64Flavor } from '../passes/fp64-lower'

export interface Fp64FlavorSignals {
  /** `GPUAdapter.info` (or any {vendor, architecture} shaped object). Apple
   *  reports vendor 'apple' (architecture like 'apple' / 'metal-3'). */
  readonly adapterInfo?: { readonly vendor?: string; readonly architecture?: string } | null
  /** The WebGL `UNMASKED_RENDERER_WEBGL` (or RENDERER) string. Apple devices
   *  read like 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified
   *  Version)' or 'Apple GPU'. */
  readonly rendererString?: string | null
  /** `navigator.userAgent` — the fallback when the GPU strings are masked
   *  (iOS Safari always runs Metal underneath). */
  readonly userAgent?: string | null
}

/** True when any signal identifies an Apple GPU / Metal-backed context. */
export function isAppleGpu(s: Fp64FlavorSignals): boolean {
  const vendor = s.adapterInfo?.vendor ?? ''
  const arch = s.adapterInfo?.architecture ?? ''
  if (/apple/i.test(vendor) || /^apple|metal/i.test(arch)) return true
  const r = s.rendererString ?? ''
  if (/apple|metal/i.test(r)) return true
  const ua = s.userAgent ?? ''
  // Any WebKit-on-Apple UA (iPhone/iPad/Mac) — Metal is the only GPU API there.
  if (/\b(iPhone|iPad|Macintosh)\b/.test(ua) && /AppleWebKit/.test(ua)) return true
  return false
}

/** The df64 lowering flavor this device needs for CORRECT results: 'integer'
 *  on Apple/Metal (where the float EFTs are reassociated away), 'float'
 *  everywhere else. Pass the result as `EmitOptions.fp64Flavor`. */
export function recommendFp64Flavor(s: Fp64FlavorSignals): Fp64Flavor {
  return isAppleGpu(s) ? 'integer' : 'float'
}
