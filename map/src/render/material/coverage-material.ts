// ═══ Coverage adapter over the generic Material (#1158 GAP-1 INC-A) ═══
//
// The S-100 colour-ramp arm's GPU material + the pure CPU helpers that feed it:
// the f32→f16 converter, the validity-weighted texture packing (A3), the LUT bake
// (reusing color-ramp's stop math through the RHI seam), and the uniform pack.
// Kept beside the material so the packing/f16/LUT logic is unit-tested WITHOUT a
// GPU (gate 3 — the headed readback — cannot run in this environment).
//
// A3 storage decision (verified): TWO r16float textures (rgba16float is rejected on
// WebGL2; r32float is not filterable). texValue = f16(s·valid), texValid = f16(valid),
// where s ∈ [0,1] is PRE-NORMALIZED CPU-side — storing raw values in f16 is forbidden
// (offset-dependent error); normalized storage bounds the f16 error at 2⁻¹² of range.

import type { RhiDevice, RhiBindGroup, RhiTextureView, RhiSampler } from '@xgis/engine'
import { Material, executeItems, type DrawItem } from '@xgis/engine'
import { emitCoverageWgsl, buildCoverageModule } from '@xgis/map'
import { emitGlslModule } from '@xgis/shader-dsl'
import { QUANT_MAX, NODATA_CODE } from '@xgis/data'
import { interpolateRamp, RAMPS } from '../../color-ramp'

// ── f32 → f16 (IEEE 754 half) with round-to-nearest-even ──────────────────────
const _f = new Float32Array(1)
const _i = new Int32Array(_f.buffer)
/** Convert a float32 to its IEEE-754 half-precision bit pattern (Uint16). Round-
 *  to-nearest so the f16 error is ≤ 2⁻¹² of magnitude (the A3 error budget). */
export function f32ToF16(val: number): number {
  _f[0] = val
  const x = _i[0]!
  const bits = (x >> 16) & 0x8000 // sign
  const e = (x >> 23) & 0xff // biased exponent
  let m = x & 0x7fffff // mantissa
  if (e === 0xff) return bits | (m ? 0x7e00 : 0x7c00) // NaN / Inf
  const en = e - 127 + 15 // rebias to f16
  if (en >= 0x1f) return bits | 0x7c00 // overflow → Inf
  if (en <= 0) {
    if (en < -10) return bits // underflow → signed zero
    m |= 0x800000
    const shift = 14 - en
    const half = m >> shift
    // round-to-nearest-even
    const rem = m & ((1 << shift) - 1)
    const halfway = 1 << (shift - 1)
    let r = half
    if (rem > halfway || (rem === halfway && half & 1)) r++
    return bits | r
  }
  const half = m >> 13
  const rem = m & 0x1fff
  let out = (en << 10) | half
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) out++ // round; carry ripples into exp
  return bits | out
}

const F16_ONE = f32ToF16(1) // 0x3c00
const F16_ZERO = 0

export interface PackedCoverage {
  /** f16(s·valid) per cell — the value texture (r16float). */
  value: Uint16Array
  /** f16(valid ∈ {0,1}) per cell — the validity texture (r16float). */
  valid: Uint16Array
}

/** Pack the two r16float textures (A3). `s` is the PRE-NORMALIZED [0,1] fraction:
 *  from the u16 `codes` EXACTLY (code/65534) when present — avoiding double rounding
 *  — else CPU-normalized (v−dataMin)/(dataMax−dataMin). nodata (NaN / code 0xFFFF)
 *  ⇒ valid 0, value 0 (never a NaN texel or an in-band sentinel). */
export function packCoverageValueValid(
  values: Float32Array,
  dataMin: number,
  dataMax: number,
  codes?: Uint16Array,
): PackedCoverage {
  const n = values.length
  const value = new Uint16Array(n)
  const valid = new Uint16Array(n)
  const range = dataMax - dataMin
  const invRange = range > 0 ? 1 / range : 0
  for (let i = 0; i < n; i++) {
    const v = values[i]!
    const isNodata = Number.isNaN(v) || (codes ? codes[i] === NODATA_CODE : false)
    if (isNodata) {
      value[i] = F16_ZERO
      valid[i] = F16_ZERO
      continue
    }
    let s = codes ? codes[i]! / QUANT_MAX : (v - dataMin) * invRange
    if (s < 0) s = 0
    else if (s > 1) s = 1
    value[i] = f32ToF16(s) // s·valid, valid = 1 here
    valid[i] = F16_ONE
  }
  return { value, valid }
}

/** Ramp uniforms t = clamp(a·s' + b): a=(dataMax−dataMin)/(rangeHi−rangeLo),
 *  b=(dataMin−rangeLo)/(rangeHi−rangeLo). Default range = the data range → a=1,b=0. */
export function computeRampUniforms(
  dataMin: number,
  dataMax: number,
  rangeLo: number,
  rangeHi: number,
): { a: number; b: number } {
  const span = rangeHi - rangeLo
  if (span === 0) return { a: 0, b: 0 }
  return { a: (dataMax - dataMin) / span, b: (dataMin - rangeLo) / span }
}

/** Bake a 256×1 rgba8 LUT for a named ramp (reusing color-ramp's stop math). An unknown
 *  ramp name fails LOUDLY (INC-A charter) — silently substituting a palette would misread
 *  navigation-data depth colours (a typo'd `ramp: "virdis"` must not render as bathymetry). */
export function bakeRampLut(rampName: string): Uint8Array {
  const stops = RAMPS[rampName]
  if (!stops)
    throw new Error(
      `[coverage] unknown ramp "${rampName}" — known ramps: ${Object.keys(RAMPS).join(', ')}`,
    )
  return interpolateRamp(stops, 256)
}

// ── Uniform block (matches the CoverageUniforms DSL struct, 144 B) ────────────
export const COVERAGE_UNIFORM_FLOATS = 36 // 144 bytes / 4
export interface CoverageUniformInput {
  mvp: Float32Array | number[] // 16
  projParams: [number, number, number, number]
  camCenter: [number, number]
  covEdges: [number, number, number, number] // westLon, southLat, eastLon, northLat
  covGeo: [number, number, number, number] // westLon, northLat, nLon·dLon, nLat·dLat
  ramp: { a: number; b: number }
}
export function packCoverageUniforms(u: CoverageUniformInput): Float32Array {
  const out = new Float32Array(COVERAGE_UNIFORM_FLOATS)
  out.set(u.mvp.slice(0, 16), 0)
  out.set(u.projParams, 16)
  out[20] = u.camCenter[0]
  out[21] = u.camCenter[1]
  out.set(u.covEdges, 24)
  out.set(u.covGeo, 28)
  out[32] = u.ramp.a
  out[33] = u.ramp.b
  return out
}

// ── RHI Material adapter ──────────────────────────────────────────────────────
export class CoverageDraper {
  private readonly material: Material

  constructor(
    private readonly rhi: RhiDevice,
    format: string,
    sampleCount: number,
  ) {
    const mod = buildCoverageModule()
    this.material = new Material(rhi, {
      shader: emitCoverageWgsl(),
      vsEntry: 'vs_cov',
      fsEntry: 'fs_cov',
      vsCode: emitGlslModule(mod, 'vertex'),
      fsCode: emitGlslModule(mod, 'fragment'),
      format: format as 'bgra8unorm',
      sampleCount,
      // group 0: uniform + value + valid + sampler + LUT + LUT sampler. Multi-same-
      // kind ⇒ every entry NAMED (WebGL2 binds by name, rhi.ts #783).
      groups: [
        [
          { binding: 0, kind: 'uniform', name: 'CoverageUniforms' },
          { binding: 1, kind: 'texture', name: 'cov_value' },
          { binding: 2, kind: 'texture', name: 'cov_valid' },
          { binding: 3, kind: 'sampler', name: 'cov_sampler' },
          { binding: 4, kind: 'texture', name: 'cov_lut' },
          { binding: 5, kind: 'sampler', name: 'cov_lut_sampler' },
        ],
      ],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      variants: [
        { depthWrite: false, depthCompare: 'always', label: 'coverage-ramp-pipeline-rhi' },
      ],
      globalUniformSize: COVERAGE_UNIFORM_FLOATS * 4,
    })
  }

  /** Build the group-0 bind group for a coverage's resident textures + LUT. */
  bindGroup(
    value: RhiTextureView,
    valid: RhiTextureView,
    dataSampler: RhiSampler,
    lut: RhiTextureView,
    lutSampler: RhiSampler,
  ): RhiBindGroup {
    return this.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { buffer: this.material.globalUniform! } },
      { binding: 1, resource: { view: value } },
      { binding: 2, resource: { view: valid } },
      { binding: 3, resource: { sampler: dataSampler } },
      { binding: 4, resource: { view: lut } },
      { binding: 5, resource: { sampler: lutSampler } },
    ])
  }

  /** Draw the coverage quad (6 verts, procedural — no vertex buffer). */
  draw(
    pass: import('@xgis/engine').RhiRenderPass,
    globalBytes: BufferSource,
    bindGroup: RhiBindGroup,
  ): void {
    this.material.writeGlobal(globalBytes)
    const items: DrawItem[] = [{ variant: 0, bindGroups: [bindGroup], count: 6, indexed: false }]
    executeItems(this.material, pass, items, 0)
  }
}
