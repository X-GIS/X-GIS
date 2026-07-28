// ═══ WebGL2 texture-sampling state, as pure functions (#1436) ═══
//
// Extracted from the device so the two decisions that are easy to get silently wrong are
// testable without a GL context and without WebGl2Device:
//
//   - GL folds "filter WITHIN a level" and "blend BETWEEN levels" into one TEXTURE_MIN_FILTER
//     enum, so a transposed pair is a plausible-looking filter that is wrong in exactly the
//     minification regime mips exist to fix.
//   - Anisotropy is an EXTENSION here (WebGPU has it natively), so "you asked and got nothing"
//     is a real state the caller must be able to observe rather than infer from the platform.
//
// Both are pure: no `this`, no device state, no side effects beyond the one documented
// getExtension call.

import type { RhiFilter } from '@xgis/rhi'

/** The GL min-filter enum for a (within-level, between-level) filter pair.
 *
 *  `mipmap` undefined returns the plain single-level enums, so every pre-#1436 sampler is
 *  byte-identical to before this existed — the property that makes the widening additive rather
 *  than a behaviour change for every texture in the engine. */
export function minFilterEnum(
  gl: WebGL2RenderingContext,
  min: RhiFilter,
  mipmap: RhiFilter | undefined,
): GLenum {
  if (mipmap === undefined) return min === 'linear' ? gl.LINEAR : gl.NEAREST
  if (min === 'linear')
    return mipmap === 'linear' ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST
  return mipmap === 'linear' ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST
}

/** Resolve `EXT_texture_filter_anisotropic` once, with the ceiling the driver will honour.
 *
 *  Presence-checked before `getExtension`, matching this backend's float-extension path:
 *  `getExtension` ENABLES state and is not a pure query, so a context that does not list the
 *  extension must not be asked for it. Returns `{ ext: null, max: 1 }` when absent — `max` of 1
 *  is what makes the degrade READABLE. */
export function resolveAnisotropy(
  gl: WebGL2RenderingContext,
  supported: readonly string[],
): { ext: EXT_texture_filter_anisotropic | null; max: number } {
  const ext = supported.includes('EXT_texture_filter_anisotropic')
    ? gl.getExtension('EXT_texture_filter_anisotropic')
    : null
  return {
    ext,
    max: ext ? ((gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) ?? 1) : 1,
  }
}
