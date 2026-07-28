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

import type { RhiDevice, RhiBindGroup, RhiTextureView, RhiSampler, RhiBuffer } from '@xgis/engine'
import { Material, executeItems, type DrawItem } from '@xgis/engine'
import {
  emitCoverageWgsl,
  buildCoverageModule,
  coverageGridIndexCount,
} from '../../shaders/dsl/coverage-ramp'
import type { CoverageFilterFn } from '../../shaders/dsl/coverage-filter'

/** Interleaved node vertex: [lon, lat, u, v] — 4 × f32. */
export const COVERAGE_NODE_STRIDE = 16
import { emitGlslModule } from '@xgis/shader-dsl'
import { QUANT_MAX, NODATA_CODE } from '@xgis/data'
import { interpolateRamp, interpolateBandedRamp, RAMPS, BANDED_RAMPS } from '../../color-ramp'

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
  // Banded palettes (S-100 portrayal: constant colour per value band, hard edges) bake a
  // STEPPED LUT; the interpolated RAMPS bake a gradient. Same 256×1 rgba8 output either way.
  const banded = BANDED_RAMPS[rampName]
  if (banded) return interpolateBandedRamp(banded, 256)
  const stops = RAMPS[rampName]
  if (!stops)
    throw new Error(
      `[coverage] unknown ramp "${rampName}" — known ramps: ` +
        `${[...Object.keys(RAMPS), ...Object.keys(BANDED_RAMPS)].join(', ')}`,
    )
  return interpolateRamp(stops, 256)
}

// ── Uniform block (matches the CoverageUniforms DSL struct, 144 B) ────────────
// 28 floats / 112 bytes. Was 36: `cov_edges` + `cov_geo` are gone (#1366 INC-3) — both
// encoded "the footprint is a rectangle in lon/lat", which a projected (UTM) cell
// violates. Node lon/lat is a vertex attribute now and uv a varying, so neither field
// has anywhere left to be re-introduced from.
// 32 floats / 128 bytes since #1437 added `cov_data` (dataMin, span, zoom) — the raw-unit
// mapping the fragment `filter:` predicate tests against. Present whether or not a layer
// declares a filter: a std140 block's layout is fixed by its qualifier, not by which members
// are read, so one layout beats two that must be kept in step.
export const COVERAGE_UNIFORM_FLOATS = 32 // 128 bytes / 4
export interface CoverageUniformInput {
  mvp: Float32Array | number[] // 16
  projParams: [number, number, number, number]
  camCenter: [number, number]
  ramp: { a: number; b: number }
  /** Layer opacity paint (0..1) — packed into ramp_params.z, multiplies output alpha. */
  opacity: number
  /** IBFV modulation depth (#1333) — packed into ramp_params.w. 0 (the default) makes the
   *  shader's gain an EXACT 1.0, so a coverage with no flow field draws byte-identically. */
  flowMix?: number
  /** Draw the advected field alone — no ramp colour (#1333). Packed into cam_center.z as a
   *  0/1 flag; see the shader for why the ramp tap still happens and is simply not used. */
  flowOnly?: boolean
  /** The band's raw value window, so the fragment `filter:` predicate can undo the [0,1]
   *  normalization the A3 packing applies and test RAW units — the same quantity the CPU
   *  sounding arm evaluates the identical predicate on (#1437). Absent ⇒ (0, 0), which is
   *  never read: a drape with no filter emits no call site at all. */
  data?: { min: number; max: number }
  /** Live camera zoom, so a `zoom`-dependent filter reads the same value on the drape that it
   *  already reads on the sounding arm. */
  cameraZoom?: number
}
export function packCoverageUniforms(u: CoverageUniformInput): Float32Array {
  const out = new Float32Array(COVERAGE_UNIFORM_FLOATS)
  out.set(u.mvp.slice(0, 16), 0)
  out.set(u.projParams, 16)
  out[20] = u.camCenter[0]
  out[21] = u.camCenter[1]
  // MERGE UNION (#1366 INC-3 <- #1333): INC-3 deleted `cov_edges` / `cov_geo` (the lon/lat
  // footprint rectangle a projected cell violates), which slid `ramp_params` from 32 down to
  // 24; #1333 added the flow-modulation depth as its `.w` and the flow-only flag in
  // cam_center.z. All three survive — the compacted block AND both new fields. The struct in
  // shaders/dsl/coverage-ramp.ts is the authority for these offsets, and
  // COVERAGE_UNIFORM_FLOATS (28) is asserted against it.
  out[22] = u.flowOnly ? 1 : 0 // cam_center.z — the flow-only flag
  out[24] = u.ramp.a
  out[25] = u.ramp.b
  out[26] = u.opacity // ramp_params.z
  out[27] = u.flowMix ?? 0 // ramp_params.w
  // cov_data (#1437) — x=dataMin, y=span, so the fragment recovers raw units as
  // `min + s'·span`. A zero span leaves every cell at dataMin, which is the honest reading of
  // a constant grid rather than a divide-by-zero dressed up as a filter result.
  out[28] = u.data?.min ?? 0
  out[29] = u.data ? u.data.max - u.data.min : 0
  out[30] = u.cameraZoom ?? 0 // cov_data.z
  return out
}

// ── RHI Material adapter ──────────────────────────────────────────────────────
export class CoverageDraper {
  private readonly material: Material

  constructor(
    private readonly rhi: RhiDevice,
    format: string,
    sampleCount: number,
    /** The layer's compiled `filter:` predicate, spliced into the fragment stage (#1437).
     *  A draper is built PER PREDICATE — the caller keys its cache on
     *  `CoverageFilterProgram.key` — because the predicate is baked into the pipeline. */
    filter?: CoverageFilterFn,
  ) {
    const mod = buildCoverageModule(filter)
    this.material = new Material(rhi, {
      shader: emitCoverageWgsl(filter),
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
          { binding: 6, kind: 'texture', name: 'cov_flow' },
        ],
      ],
      // One interleaved node buffer: [lon, lat, u, v] per mesh node. Indexed, so each
      // node is stored once even though up to 6 triangles reference it (#1366 INC-3).
      vertexBuffers: [
        {
          stride: COVERAGE_NODE_STRIDE,
          attributes: [
            { location: 0, offset: 0, format: 'float32x2' }, // node_lonlat
            { location: 1, offset: 8, format: 'float32x2' }, // node_uv
          ],
        },
      ],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      variants: [
        { depthWrite: false, depthCompare: 'always', label: 'coverage-ramp-pipeline-rhi' },
      ],
      globalUniformSize: COVERAGE_UNIFORM_FLOATS * 4,
    })
  }

  /** Build the group-0 bind group for a coverage's resident textures + LUT.
   *
   *  `flow` is the advected IBFV image for THIS frame. Both backends require every declared
   *  binding to be filled, so a coverage with no flow layer passes an inert stand-in (the
   *  caller hands its own value texture) — safe because `flowMix` is 0 there and the shader
   *  multiplies the tap out exactly. It is a parameter rather than a resident field because
   *  the flow pair PING-PONGS: the correct view alternates every frame. */
  bindGroup(
    value: RhiTextureView,
    valid: RhiTextureView,
    dataSampler: RhiSampler,
    lut: RhiTextureView,
    lutSampler: RhiSampler,
    flow: RhiTextureView,
  ): RhiBindGroup {
    return this.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { buffer: this.material.globalUniform! } },
      { binding: 1, resource: { view: value } },
      { binding: 2, resource: { view: valid } },
      { binding: 3, resource: { sampler: dataSampler } },
      { binding: 4, resource: { view: lut } },
      { binding: 5, resource: { sampler: lutSampler } },
      { binding: 6, resource: { view: flow } },
    ])
  }

  /** Draw the coverage surface grid (N×N cells · 6 verts, procedural — no vertex
   *  buffer; the tessellation is what makes the drape projection-general, #1158). */
  draw(
    pass: import('@xgis/engine').RhiRenderPass,
    globalBytes: BufferSource,
    bindGroup: RhiBindGroup,
    nodes: RhiBuffer,
    indices: RhiBuffer,
  ): void {
    this.material.writeGlobal(globalBytes)
    const items: DrawItem[] = [
      {
        variant: 0,
        bindGroups: [bindGroup],
        vertex: nodes,
        index: { buffer: indices, format: 'uint16' },
        count: coverageGridIndexCount(),
        indexed: true,
      },
    ]
    executeItems(this.material, pass, items, 0)
  }
}
