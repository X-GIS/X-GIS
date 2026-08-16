// Survey (browser side): every point of a VARIANT FAMILY, compiled and linked on a real
// WebGL2 driver (#1715 Problem A). The unit test beside `linkVariants` drives the
// aggregation with a recorder and cannot reject bad GLSL; this is the half that can.
//
// The axes are the two failure classes the consumer reported finding only at the pixel-test
// stage, because both are per-variant — the combination that selects the axis is the one
// that breaks, and a single-variant gate never selects it:
//
//   sampled   the fragment reads a texture — the "missing sampler precision" failure
//   varying   the vertex→fragment INTERFACE gains a member, and the fragment reads it —
//             the "interface mismatch between a vertex/fragment pair" failure, which a
//             per-stage COMPILE cannot see and only a LINK can
//
// The family is purpose-built rather than lifted from map/: what is under test is the gate
// entry point plus the two classes, and a real map shader would drag its whole build graph
// into a spec that is about neither.

import {
  linkVariants,
  validateVariantsWgsl,
  type VariantLinkResult,
} from '../../shader-dsl/src/core/variant-link'
import { variantFamily } from '../../shader-dsl/src/core/variant-family'
import { builtin, ioStruct, location, resource } from '../../shader-dsl/src/core/sot'
import {
  fn,
  module,
  textureSample,
  u32,
  toF32,
  vec2,
  vec4,
  samplerT,
  texture2dfT,
  u32T,
  vec2fT,
  vec4fT,
} from '../../shader-dsl/src/core/ir'

export interface VariantSurvey {
  readonly keys: readonly string[]
  /** How many of the emitted fragment sources are DISTINCT. A matrix whose variants all
   *  emit the same bytes is one program checked N times; the spec asserts on this so the
   *  gate cannot quietly degrade into that. */
  readonly distinctFragments: number
  readonly rows: readonly VariantLinkResult[]
  readonly renderer: string
}

/** The ONE family both backend surveys drive. Shared rather than duplicated on purpose: two
 *  copies could drift, and a "both backends agree" gate over two different families proves
 *  nothing about either. */
function probeFamily() {
  return variantFamily({
    axes: { sampled: [false, true] as const, varying: [false, true] as const },
    build: ({ sampled, varying }) => {
      const tex = resource('u_tex', texture2dfT, { group: 0, binding: 0 })
      const smp = resource('u_smp', samplerT, { group: 0, binding: 1 })
      const VsOut = varying
        ? ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })
        : ioStruct('VsOut', { pos: builtin('position', vec4fT) })
      // A fullscreen triangle derived from the vertex index — no vertex buffer, the same
      // shape examples/_fullscreen.ts uses.
      const vs = fn(
        'vs',
        { vi: builtin('vertex_index', u32T) },
        ({ vi }) => {
          const x = toF32(vi.bitAnd(u32(1)))
            .mul(4)
            .sub(1)
          const y = toF32(vi.shr(u32(1)))
            .mul(4)
            .sub(1)
          const pos = vec4(x, y, 0, 1)
          return varying
            ? VsOut.construct({ pos, uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
            : VsOut.construct({ pos })
        },
        { stage: 'vertex' },
      )
      const fs = fn(
        'fs',
        { vo: VsOut },
        ({ vo }) => {
          // Reading `vo.uv` is what makes `varying` an INTERFACE change rather than an
          // unused output the linker is free to ignore.
          const uv = varying ? (vo as { uv: ReturnType<typeof vec2> }).uv : vec2(0.5, 0.5)
          return sampled ? textureSample(tex.node, smp.node, uv) : vec4(uv, 0.0, 1.0)
        },
        { stage: 'fragment' },
      )
      return module({
        uses: sampled ? [VsOut, tex, smp] : [VsOut],
        funcs: [vs, fs],
      })
    },
    key: ({ sampled, varying }) => `probe/s=${sampled ? 1 : 0}/v=${varying ? 1 : 0}`,
  })
}

export function surveyVariantLink(): VariantSurvey {
  const family = probeFamily()

  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return { keys: family.keys, distinctFragments: 0, rows: [], renderer: 'NO WEBGL2' }

  return {
    keys: family.keys,
    distinctFragments: new Set(family.emit('glsl-es300', { stage: 'fragment' }).values()).size,
    rows: linkVariants(gl, family),
    renderer: String(gl.getParameter(gl.RENDERER)),
  }
}

// ── The WGSL half of #1715 Problem A ──────────────────────────────────────────
//
// The ask was "the same family proven on BOTH backends from one test". The WebGL2 half is
// above; this is the other, and it validates through the only WGSL front-end that can live
// in this repo: the browser's own Tint, via createShaderModule + getCompilationInfo.
// naga/tint cannot be a shader-dsl dependency — the package's zero-dependency property is
// gated by self-contained.test.ts and #1681 rejected `@webgpu/types` and `semver` on exactly
// that ground — so a browser spec is not a workaround here, it is the only correct place.
//
// This runs headlessly: the container's Chromium enumerates a SwiftShader WebGPU adapter
// (measured: vendor "google", architecture "swiftshader"), and getCompilationInfo reports
// real Tint diagnostics on it. #1715 recorded the opposite — that WGSL validation "cannot be
// verified in an environment with no WebGPU software adapter" — which was wrong on both
// counts: the adapter exists, and _wgsl-compile-gate has been validating map/engine WGSL in
// CI under XGIS_SOFTWARE_GPU=1 all along. What was genuinely missing is per-VARIANT coverage.

export interface WgslVariantSurvey {
  /** Adapter architecture, or 'NONE' — the spec asserts on this so an environment without
   *  WebGPU fails loudly instead of passing on an empty row set. */
  readonly adapter: string
  readonly keys: readonly string[]
  readonly distinctModules: number
  readonly rows: ReadonlyArray<{ key: string; errors: readonly string[] }>
  /** Positive control: a deliberately invalid module compiled through the SAME path. If this
   *  is 0 the validator is reporting nothing and every clean row above is vacuous — the
   *  "assertion that failed either way" trap (CLAUDE.md §12), which for a validator means
   *  proving it can still say no. */
  readonly controlErrors: number
}

export async function surveyVariantWgsl(): Promise<WgslVariantSurvey> {
  const family = probeFamily()
  const sources = family.emit('wgsl')
  const distinctModules = new Set(sources.values()).size

  const nav = navigator as Navigator & { gpu?: GPU }
  const adapter = nav.gpu ? await nav.gpu.requestAdapter() : null
  if (!adapter) {
    return { adapter: 'NONE', keys: family.keys, distinctModules, rows: [], controlErrors: 0 }
  }
  const device = await adapter.requestDevice()
  // Validation errors surface through getCompilationInfo; an uncaptured-error handler would
  // additionally reject the device on the first bad module and take the control arm with it.
  device.pushErrorScope('validation')

  // Enumeration + aggregation come from the PACKAGE (`validateVariantsWgsl`), not from a
  // copy here: it is the WGSL twin of `linkVariants` above, so both backends walk the same
  // family through the same shape, and a consumer of @xgis/shader-dsl gets the entry point
  // this issue asked for rather than one that only exists inside this repo's e2e.
  const validated = await validateVariantsWgsl(device, family)
  const rows = validated.map((r) => ({ key: r.key, errors: r.errors ?? [] }))

  // The positive control goes through the SAME function, with only the SOURCE swapped for
  // one Tint must reject. Reading `getCompilationInfo()` directly here instead would test a
  // path the rows above do not use: every variant is valid, so a `validateVariantsWgsl` that
  // never read the messages would return the same clean rows AND leave a direct control
  // positive — green either way, which is the trap this control exists to close.
  const controlErrors = (
    await validateVariantsWgsl(
      {
        createShaderModule: () =>
          device.createShaderModule({
            code: '@vertex fn vs() -> @builtin(position) vec4f { return notAFunction(1); }',
          }),
      },
      family,
    )
  ).flatMap((r) => r.errors ?? [])
  await device.popErrorScope()

  return {
    adapter: String(adapter.info?.architecture ?? 'unknown'),
    keys: family.keys,
    distinctModules,
    rows,
    controlErrors: controlErrors.length,
  }
}
