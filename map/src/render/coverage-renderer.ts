// ═══ CoverageRenderer — S-100 gridded-coverage GPU arm (#1158 GAP-1 INC-A) ═══
//
// Owns the per-source GPU state for the colour-ramp coverage draw: TWO resident
// r16float data textures (value + validity, A3), the 256×1 rgba8 LUT, the linear-
// clamp samplers, and the bind group — all through the RHI seam (no raw WebGPU in
// @xgis/map). The CPU-resident values stay in the CoverageHandle (@xgis/data), the
// value-readout authority; this renderer only ever holds COLOUR-path state, so a
// device swap re-uploads without touching value correctness (the syncDevice lesson).
//
// Time scrub (setCoverageTime) re-uploads that region's textures — INC-C. The draw is a
// TESSELLATED surface grid over the OUTER cell edges, each vertex projected via the general
// `project()` (coverage-ramp.ts) — projection-general for every flat projection, no baked
// Mercator. render() takes the camera-derived MVP + centre + proj params (the opaque-pass
// arming computes them, mirroring the raster flat path) so this renderer stays
// camera-internals-free and unit-testable. The draper is LAZY (raster's ensureRasterDraper
// pattern): built at first arm with the live MSAA sample count, invalidated by
// rebuildForQuality().
//
// MULTI-REGION (#1333): the resident state is KEYED, so a viewport spanning two NOAA
// operational-forecast domains (Chesapeake + Delaware, say) can draw BOTH in one frame
// instead of hard-swapping one for the other. Every pre-existing caller omits the key and
// lands on DEFAULT_REGION — exactly one entry, replaced on each arm, byte-identical to the
// old single-slot behaviour. Residency is bounded by a GPU byte budget with LRU eviction:
// panning the whole U.S. coast must not accumulate textures forever. Regions are drawn in
// insertion (least-recent-first) order and alpha-blend where their domains overlap, which is
// what adjacent NOAA domains genuinely do — there is no cross-region seam reconciliation
// here, and none is claimed.

import type { GPUContext } from '@xgis/rhi-webgpu'
import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import type {
  RhiDevice,
  RhiTexture,
  RhiTextureView,
  RhiSampler,
  RhiBindGroup,
  RhiRenderPass,
} from '@xgis/engine'
import { getSampleCount } from '@xgis/engine'
import type { CoverageHandle } from '@xgis/data'
import { CoverageDraper } from './material/coverage-material'
import { resolveVectorBands } from '../coverage-vector-bands'
import { packFlowFieldUV } from './flow-field-pack'
import {
  packCoverageValueValid,
  bakeRampLut,
  computeRampUniforms,
  packCoverageUniforms,
} from './material/coverage-material'

interface CoverageState {
  valueTex: RhiTexture
  validTex: RhiTexture
  lutTex: RhiTexture
  /** East/north velocity components, r16float, normalized by `flowScale` — present ONLY for a
   *  VECTOR coverage (S-111 and friends). Null for every scalar coverage: S-102 bathymetry
   *  must allocate nothing here, which is the reuse boundary between the two families. */
  flowU: RhiTexture | null
  flowV: RhiTexture | null
  /** Views over the pair above, minted at upload so the per-frame advection binds rather than
   *  allocates. Null exactly when the textures are. */
  flowUView: RhiTextureView | null
  flowVView: RhiTextureView | null
  /** Peak speed the components were normalized by, in the speed band's own units. 0 when the
   *  field is calm or absent — the flow pass reads this to recover real velocity. */
  flowScale: number
  bindGroup: RhiBindGroup
  /** west/south/east/north outer cell EDGES (degrees) for the draw quad. */
  covEdges: [number, number, number, number]
  /** westLonEdge, northLatEdge, nLon·dLon, nLat·dLat — for the fragment u/v. */
  covGeo: [number, number, number, number]
  ramp: { a: number; b: number }
  /** Layer opacity (0..1) — multiplies output alpha (ramp_params.z). */
  opacity: number
  /** Approximate GPU bytes this region holds — the LRU budget's accounting unit. */
  bytes: number
}

/** One region's velocity field plus the grid geometry the advection needs. Returned as ONE
 *  value so a field and a geometry can never be paired across different regions. */
export interface FlowFieldRegion {
  /** Sampling views, created ONCE at upload. Views, not textures: the advection binds them every
   *  frame, and minting a pair per frame would allocate two GPU objects per frame for handles
   *  that only ever change when the coverage is re-armed. */
  u: RhiTextureView
  v: RhiTextureView
  /** Peak speed the components were normalized by, in the speed band's own units. */
  scale: number
  width: number
  height: number
  /** Grid extent in degrees, [lon, lat]. */
  spanDeg: readonly [number, number]
  /** Latitude at the middle of the cell. */
  midLatDeg: number
}

/** The region key a caller that does not name one lands on. Keeps every pre-multi-region
 *  caller on exactly ONE entry (each arm replaces it), so their behaviour is unchanged. */
export const DEFAULT_REGION = '__default__'

/** Default GPU byte budget for resident coverage regions. A regional S-111 cell is two
 *  r16float textures over the grid (a 596×433 CBOFS cell ≈ 1 MB the pair), so this holds a
 *  comfortable working set of adjacent domains while still bounding a coast-long pan. */
const DEFAULT_BUDGET_BYTES = 64 * 1024 * 1024

export interface CoverageArmOptions {
  ramp: string
  /** Display range [lo, hi]; defaults to the band's data range (a=1, b=0). */
  rangeLo?: number
  rangeHi?: number
  /** Layer opacity paint (0..1); defaults to 1 (opaque). */
  opacity?: number
  bandIndex?: number | string
}

export class CoverageRenderer {
  private readonly rhi: RhiDevice
  private readonly format: string
  private _draper: CoverageDraper | null = null
  private dataSampler: RhiSampler | null = null
  private lutSampler: RhiSampler | null = null
  /** Resident regions, keyed. Map iteration order is insertion order, and `setCoverage`
   *  delete-then-sets, so the FRONT is always the least-recently-armed — the LRU eviction
   *  order, and the draw order. */
  private readonly states = new Map<string, CoverageState>()
  /** Last armed inputs PER REGION, retained so rebuildForQuality() can re-arm each at the
   *  new sample count (the textures + bind group are draper-layout-bound). */
  private readonly arms = new Map<string, { handle: CoverageHandle; opts: CoverageArmOptions }>()
  /** The most recently armed display (ramp/range/opacity) — a single global notion shared by
   *  every region, which is what `displayOpts()` promises its callers. */
  private lastOpts: CoverageArmOptions | null = null
  private readonly budgetBytes: number

  constructor(ctx: GPUContext, opts?: { budgetBytes?: number }) {
    this.rhi = ctx.rhi
    this.format = ctx.format
    this.budgetBytes = Math.max(1, opts?.budgetBytes ?? DEFAULT_BUDGET_BYTES)
  }

  /** Lazily build the draper with the LIVE sample count — mirrors raster's
   *  ensureRasterDraper exactly (min(getSampleCount, maxSampleCount) works for the
   *  WebGPU opaque MSAA target AND the WebGL2 twin screen pass; no backend fork). */
  private ensureDraper(): CoverageDraper {
    return (this._draper ??= new CoverageDraper(
      this.rhi,
      this.format,
      Math.min(getSampleCount(), this.rhi.caps.maxSampleCount),
    ))
  }

  hasCoverage(): boolean {
    return this.states.size > 0
  }

  /** The resident region keys, least-recently-armed first (= the draw order). */
  residentRegions(): string[] {
    return [...this.states.keys()]
  }

  /** The currently-armed display (ramp + range window), or viridis / open range when
   *  nothing is armed yet. `map.setCoverageData` reuses this so an imperative data swap
   *  keeps the drawing layer's display (LAYER paint, #1158 INC-D) without re-reading the
   *  ShowCommand; a later rebuild re-arms from the layer. */
  displayOpts(): { ramp: string; rangeLo?: number; rangeHi?: number; opacity?: number } {
    return {
      ramp: this.lastOpts?.ramp ?? 'viridis',
      rangeLo: this.lastOpts?.rangeLo,
      rangeHi: this.lastOpts?.rangeHi,
      opacity: this.lastOpts?.opacity,
    }
  }

  /** Upload a coverage's value/validity textures + LUT and arm the draw for `region`.
   *  Replaces only THAT region's previous coverage (destroying its textures — no leak);
   *  other resident regions are untouched, so a caller naming distinct keys accumulates a
   *  multi-region mosaic while a caller omitting the key keeps the single-slot behaviour.
   *  Arming refreshes the region's LRU recency and may evict the least-recent OTHER regions
   *  to stay inside the GPU byte budget (never the region just armed). */
  setCoverage(handle: CoverageHandle, opts: CoverageArmOptions, region = DEFAULT_REGION): void {
    this.releaseRegion(region)
    const draper = this.ensureDraper()
    this.dataSampler ??= this.rhi.createSampler({ mag: 'linear', min: 'linear' })
    this.lutSampler ??= this.rhi.createSampler({ mag: 'linear', min: 'linear' })
    const band = handle.band(opts.bandIndex ?? 0)
    const [nLon, nLat] = handle.header.size
    const dataMin = band.header.min
    const dataMax = band.header.max

    const { value, valid } = packCoverageValueValid(band.values, dataMin, dataMax, band.codes)
    const valueTex = this.uploadR16f(value, nLon, nLat)
    const validTex = this.uploadR16f(valid, nLon, nLat)
    const lutTex = this.uploadLut(bakeRampLut(opts.ramp))

    // The VECTOR half, uploaded only when this coverage actually carries a current. The
    // predicate is the shared authority (coverage-vector-bands.ts), the same one the arrow
    // portrayal uses, so the two cannot disagree about whether a field exists — and a scalar
    // coverage allocates nothing at all rather than a pair of zero textures.
    const vec = resolveVectorBands(handle)
    let flowU: RhiTexture | null = null
    let flowV: RhiTexture | null = null
    let flowUView: RhiTextureView | null = null
    let flowVView: RhiTextureView | null = null
    let flowScale = 0
    if (vec) {
      const packed = packFlowFieldUV(vec.speed, vec.direction, vec.speedCodes, vec.directionCodes)
      flowScale = packed.scale
      flowU = this.uploadR16fFrom(packed.u, nLon, nLat, 'coverage-flow-u')
      flowV = this.uploadR16fFrom(packed.v, nLon, nLat, 'coverage-flow-v')
      flowUView = this.rhi.createView(flowU)
      flowVView = this.rhi.createView(flowV)
    }

    const bindGroup = draper.bindGroup(
      this.rhi.createView(valueTex),
      this.rhi.createView(validTex),
      this.dataSampler,
      this.rhi.createView(lutTex),
      this.lutSampler,
    )

    const [originLon, originLat] = handle.header.origin
    const [dLon, dLat] = handle.header.spacing
    const westEdge = originLon - dLon / 2
    const southEdge = originLat - dLat / 2
    const eastEdge = westEdge + nLon * dLon
    const northEdge = southEdge + nLat * dLat

    this.states.set(region, {
      valueTex,
      validTex,
      flowU,
      flowV,
      flowUView,
      flowVView,
      flowScale,
      lutTex,
      bindGroup,
      covEdges: [westEdge, southEdge, eastEdge, northEdge],
      covGeo: [westEdge, northEdge, nLon * dLon, nLat * dLat],
      ramp: computeRampUniforms(dataMin, dataMax, opts.rangeLo ?? dataMin, opts.rangeHi ?? dataMax),
      opacity: opts.opacity ?? 1,
      // 2 × r16float over the grid + the 256×1 rgba8 LUT, plus the vector pair when this
      // coverage carries one. Counting the flow textures matters: they are the SAME size as
      // the value/valid pair, so a vector coverage costs twice a scalar one and the LRU budget
      // would evict far too late if it did not know.
      bytes: nLon * nLat * 2 * (vec ? 4 : 2) + 256 * 4,
    })
    this.arms.set(region, { handle, opts })
    this.lastOpts = opts
    this.evictOverBudget(region)
  }

  /** Drop ONE region (its textures are destroyed). Idempotent — an unknown key is a no-op.
   *  For a caller that tracks its own residency (the viewport mosaic dropping a domain that
   *  left the view) rather than leaving it to the LRU. */
  clearRegion(region: string): void {
    this.releaseRegion(region)
    this.arms.delete(region)
  }

  /** The velocity field a region carries, or null when it is a scalar coverage (S-102
   *  bathymetry) or has not been armed. The flow pass reads this to decide whether it runs at
   *  all — `null` is the answer that keeps a bathymetry style allocating and drawing nothing.
   *
   *  The GEOMETRY rides along rather than living in a second accessor: the advection step needs
   *  the grid's degree span and centre latitude in the same breath as the textures (a degree of
   *  longitude shrinks by cos(lat), so the two uv axes advance at different rates), and a
   *  separate call would be a second chance to pair a field with the wrong region's geometry. */
  flowField(region: string = DEFAULT_REGION): FlowFieldRegion | null {
    const st = this.states.get(region)
    // The VIEWS are the predicate, not the textures — the same one `hasFlowField` asks, so the
    // gate and the supply cannot disagree. (They are set together at upload; asking both would
    // be two chances to answer differently.)
    if (!st || !st.flowUView || !st.flowVView) return null
    const arm = this.arms.get(region)
    if (!arm) return null
    const [w, h] = arm.handle.header.size
    return {
      u: st.flowUView,
      v: st.flowVView,
      scale: st.flowScale,
      width: w,
      height: h,
      // covGeo[2..3] are nLon·dLon / nLat·dLat — the degree span the uv axes cover.
      spanDeg: [st.covGeo[2], st.covGeo[3]],
      // covEdges is [west, south, east, north]; the midpoint of the OUTER edges, which is the
      // latitude the whole cell's longitude foreshortening is approximated at.
      midLatDeg: (st.covEdges[1] + st.covEdges[3]) / 2,
    }
  }

  /** The field the flow layer animates: the FIRST resident region carrying one, in
   *  least-recently-armed order.
   *
   *  ONE region, not all of them. Advection is a RECURSIVE filter over its own grid, so each
   *  region would need its own history pair and its own step — real scope, not a loop here
   *  (#1333 follow-up). Stated rather than left implicit, because the alternative failure is
   *  silent: a mosaic would otherwise animate whichever region happened to be armed last. */
  activeFlowField(): FlowFieldRegion | null {
    for (const region of this.states.keys()) {
      const f = this.flowField(region)
      if (f) return f
    }
    return null
  }

  /** True when ANY resident region carries a velocity field — the `scene.hasFlow` gate and the
   *  render-loop keep-warm, so a map with only scalar coverages never runs the advection pass.
   *  Quantifies over the SAME predicate `activeFlowField` does (asserted by the upload test):
   *  a true here with a null there would spin the on-demand loop on a pass that does nothing. */
  hasFlowField(): boolean {
    for (const st of this.states.values()) if (st.flowUView && st.flowVView) return true
    return false
  }

  /** Disarm every region (scene rebuild with no coverage source). Textures are
   *  destroyed; the draper + samplers stay for a later re-arm. */
  clear(): void {
    for (const key of [...this.states.keys()]) this.releaseRegion(key)
    this.arms.clear()
    this.lastOpts = null
  }

  /** A quality (MSAA) change invalidates the draper pipeline; re-arm EVERY resident region
   *  from its retained handle so each bind group is rebuilt against the new layout. */
  rebuildForQuality(): void {
    const prior = [...this.arms.entries()] // snapshot: setCoverage below mutates `arms`
    for (const key of [...this.states.keys()]) this.releaseRegion(key)
    this._draper = null
    for (const [key, { handle, opts }] of prior) this.setCoverage(handle, opts, key)
  }

  /** Evict least-recently-armed regions until the resident set fits the GPU byte budget.
   *  `keep` (the region just armed) is never evicted — arming a region must always leave it
   *  resident, even if it alone exceeds the budget (a single oversized domain still draws;
   *  the budget bounds ACCUMULATION, it is not a per-region size cap). */
  private evictOverBudget(keep: string): void {
    let total = 0
    for (const s of this.states.values()) total += s.bytes
    if (total <= this.budgetBytes) return
    for (const [key, s] of [...this.states]) {
      if (total <= this.budgetBytes) break
      if (key === keep) continue
      total -= s.bytes
      this.clearRegion(key)
    }
  }

  /** Draw the coverage (flat projections; the globe drape is INC-B step 2). The caller
   *  supplies the camera-derived MVP (camera-at-origin), the camera Mercator centre, and
   *  the projection params — mirroring the raster flat arm. No-op when unarmed. */
  render(
    pass: GPURenderPassEncoder | RhiRenderPass,
    mvp: Float32Array | number[],
    camCenter: [number, number],
    projParams: [number, number, number, number],
  ): void {
    if (this.states.size === 0 || !this._draper) return
    // A WebGl2Device frame (renderFrameViaRhi twin) hands in an RhiRenderPass
    // already; the WebGPU opaque pass hands in a GPURenderPassEncoder that needs
    // wrapping — the ONE backend fork, mirroring raster-renderer.render. Wrapped ONCE,
    // outside the per-region loop.
    const rhiPass =
      this.rhi.backend === 'webgl2'
        ? (pass as RhiRenderPass)
        : wrapWebGpuPass(pass as GPURenderPassEncoder)
    // Least-recently-armed first; overlapping domains alpha-blend in that order.
    for (const s of this.states.values()) {
      const bytes = packCoverageUniforms({
        mvp,
        projParams,
        camCenter,
        covEdges: s.covEdges,
        covGeo: s.covGeo,
        ramp: s.ramp,
        opacity: s.opacity,
      })
      this._draper.draw(rhiPass, bytes as BufferSource, s.bindGroup)
    }
  }

  private uploadR16f(data: Uint16Array, width: number, height: number): RhiTexture {
    return this.uploadR16fFrom(data, width, height, 'coverage-data')
  }

  private uploadR16fFrom(
    data: Uint16Array,
    width: number,
    height: number,
    label: string,
  ): RhiTexture {
    const tex = this.rhi.createTexture({
      width,
      height,
      format: 'r16float',
      usage: ['sample', 'copy-dst'],
      label,
    })
    this.rhi.writeTexture(tex, data as BufferSource, width * 2, width, height)
    return tex
  }

  private uploadLut(rgba: Uint8Array): RhiTexture {
    const tex = this.rhi.createTexture({
      width: 256,
      height: 1,
      format: 'rgba8unorm',
      usage: ['sample', 'copy-dst'],
      label: 'coverage-lut',
    })
    this.rhi.writeTexture(tex, rgba as BufferSource, 256 * 4, 256, 1)
    return tex
  }

  /** Destroy ONE region's GPU textures and drop it from residency. Leaves `arms` alone —
   *  `rebuildForQuality` releases then re-arms from that retained input. */
  private releaseRegion(region: string): void {
    const s = this.states.get(region)
    if (!s) return
    this.rhi.destroyTexture(s.valueTex)
    this.rhi.destroyTexture(s.validTex)
    this.rhi.destroyTexture(s.lutTex)
    // The views die with their textures (RHI has no destroyView — rhi.ts:462).
    if (s.flowU) this.rhi.destroyTexture(s.flowU)
    if (s.flowV) this.rhi.destroyTexture(s.flowV)
    this.states.delete(region)
  }

  dispose(): void {
    for (const key of [...this.states.keys()]) this.releaseRegion(key)
    if (this.dataSampler) this.rhi.destroySampler(this.dataSampler)
    if (this.lutSampler) this.rhi.destroySampler(this.lutSampler)
    this.dataSampler = null
    this.lutSampler = null
    this.arms.clear()
    this.lastOpts = null
  }
}
