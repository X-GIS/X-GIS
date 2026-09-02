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
import type {
  RhiDevice,
  RhiTexture,
  RhiTextureView,
  RhiSampler,
  RhiBindGroup,
  RhiRenderPass,
  RhiBuffer,
} from '@xgis/engine'
import { getSampleCount } from '@xgis/engine'
import type { CoverageHandle } from '@xgis/data'
import { cellUnitsToLonLat, coverageEdges, coverageMeshNodes } from '@xgis/data'
import { CoverageDraper, COVERAGE_NODE_STRIDE } from './material/coverage-material'
import { compileCoverageFilter, type CoverageFilterFn } from '../shaders/dsl/coverage-filter'
import type * as AST from '@xgis/compiler'
import { resolveVectorBands } from '../coverage-vector-bands'
import { packFlowFieldUV } from './flow-field-pack'
import {
  COVERAGE_GRID_N,
  coverageNodeCount,
  coverageGridIndexCount,
} from '../shaders/dsl/coverage-ramp'
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
  /** Interleaved [lon, lat, u, v] per drape-mesh NODE, CPU-reprojected through the
   *  cell's own CRS (#1366 INC-3). Replaces the cov_edges/cov_geo lon/lat rectangle,
   *  which could not describe a projected footprint. */
  nodeBuf: RhiBuffer
  /** East/north velocity components, r16float, normalized by `flowScale` — present ONLY for a
   *  VECTOR coverage (S-111 and friends). Null for every scalar coverage: S-102 bathymetry
   *  must allocate nothing here, which is the reuse boundary between the two families. */
  flowU: RhiTexture | null
  flowV: RhiTexture | null
  /** Views over the pair above, minted at upload so the per-frame advection binds rather than
   *  allocates. Null exactly when the textures are. */
  flowUView: RhiTextureView | null
  flowVView: RhiTextureView | null
  /** f16(1)/f16(0) per cell — real data vs. nodata, the one thing `flowU`/`flowV` cannot say on
   *  their own (#1565). Same lifetime as the pair above: present, and only present, alongside
   *  them. */
  flowValid: RhiTexture | null
  flowValidView: RhiTextureView | null
  /** Peak speed the components were normalized by, in the speed band's own units. 0 when the
   *  field is calm or absent — the flow pass reads this to recover real velocity. */
  flowScale: number
  /** The resident views this region's bind group binds. Held so a group can be rebuilt for a
   *  different flow view without re-uploading anything. */
  views: { value: RhiTextureView; valid: RhiTextureView; lut: RhiTextureView }
  /** Bind groups keyed by the FLOW view they bind at binding 6. The advection pair
   *  ping-pongs, so the correct view alternates every frame and one eager group cannot serve
   *  both; keyed, this settles at two entries (plus the inert one a scalar coverage uses)
   *  instead of minting a GPU object per frame. */
  bindGroups: Map<RhiTextureView, RhiBindGroup>
  // `covEdges` / `covGeo` are GONE (#1366 INC-3): both encoded "the footprint is a
  // rectangle in lon/lat", which a projected (UTM) cell violates. `nodeBuf` above carries
  // the reprojected mesh instead.
  ramp: { a: number; b: number }
  /** Layer opacity (0..1) — multiplies output alpha (ramp_params.z). */
  opacity: number
  /** This region draws the advected field alone, with no colour ramp (see CoverageArmOptions). */
  flowOnly: boolean
  /** Resident, but the drape paints nothing for it (see CoverageArmOptions). */
  hidden: boolean
  /** Where this region sits in the mosaic's RELEVANCE order — lower is more relevant, and wins
   *  an overlap by being drawn LAST (#1602). Supplied by the arm from the `_coverage` Map index,
   *  the same authority `coverageHandleAt` resolves a point query by. */
  priority: number
  /** Which draper draws this region — the compiled `filter:` predicate's key, or '' for an
   *  unfiltered layer (#1437). The predicate is baked into the pipeline, so a region cannot
   *  be drawn by a draper compiled for a different one. */
  filterKey: string
  /** The band's raw value window. `packCoverageValueValid` normalizes values to [0,1], so the
   *  fragment predicate needs (min, span) to test the RAW units the CPU sounding arm uses. */
  data: { min: number; max: number }
  /** Approximate GPU bytes this region holds — the LRU budget's accounting unit. */
  bytes: number
}

/** What the drape needs to show the motion layer: the advected image for THIS frame and how
 *  deeply it modulates the ramp colour. `mix` 0 makes the shader's gain an exact 1.0. */
export interface FlowDrape {
  /** THIS region's advected image, or null when it has none yet (#1499) — an accessor, not one
   *  view: the trail is a recursive filter over the region's OWN grid, so a mosaic's domains each
   *  hold their own history and one image handed to all of them paints one domain's water. */
  viewFor(region: string): RhiTextureView | null
  mix: number
}

/** One region's velocity field plus the grid geometry the advection needs. Returned as ONE
 *  value so a field and a geometry can never be paired across different regions. */
export interface FlowFieldRegion {
  /** Sampling views, created ONCE at upload. Views, not textures: the advection binds them every
   *  frame, and minting a pair per frame would allocate two GPU objects per frame for handles
   *  that only ever change when the coverage is re-armed. */
  u: RhiTextureView
  v: RhiTextureView
  /** f16(1)/f16(0) validity mask over the SAME grid as `u`/`v` — lets a consumer blend across
   *  cells the catalogue actually reports without smearing a nodata neighbour's packed `(0, 0)`
   *  into the mix (#1565). */
  valid: RhiTextureView
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
  /** The layer's `filter:` clause (#1437) — compiled into the fragment stage, so a filtered
   *  drape discards the cells the predicate rejects instead of painting them. Rejected
   *  loudly, never silently, when the predicate is outside the compilable subset: a filter
   *  that draws everything is the exact defect this binding has already had twice. */
  filter?: { ast: unknown } | null
  /** Draw ONLY the advected field, with no colour ramp (#1333). The strict-catalogue case:
   *  `| flow` without a `ramp`, where the motion must be visible but the catalogue arrows
   *  stay the only colour authority. The drape then emits a neutral luminance modulation. */
  flowOnly?: boolean
  /** RESIDENT BUT NOT DRAWN (#1419). The region's textures — the velocity pair above all —
   *  are uploaded and available to everything that reads them, while the drape itself paints
   *  nothing.
   *
   *  This exists because residency and painting are different questions, and welding them
   *  cost the advected arrow field its whole data source: under the `arrows` portrayal the
   *  drape has nothing to add (the moving glyphs ARE the motion layer), and skipping the arm
   *  to express that also skipped the upload — so the velocity textures never existed, the
   *  arrow field could not be built, and the layer rendered NOTHING. Caught by a headless
   *  WebGL2 render, not by 3900 green unit tests. */
  hidden?: boolean
  /** This region's place in the mosaic's RELEVANCE order — lower wins an overlap (#1602).
   *
   *  The catalogue already ranks overlapping cells (`itemsForView`: most overlap, ties toward the
   *  SMALLER bbox, i.e. the higher-resolution local cell) and arms them in that order, so the
   *  region's index in the `_coverage` Map IS its relevance. That is the same index
   *  `coverageHandleAt` resolves a point query by and the advected arrows cull by, which is what
   *  keeps the drape, the arrows and `getCoverage` from naming three different domains for one
   *  patch of water. Single-region callers leave it at 0: with one region there is no tie. */
  priority?: number
}

/** The empty answer from `flowFields()` / the flow pass's own fallback — shared
 *  because the pass declares every frame and a per-frame `new Map()` on every
 *  coverage-less map is pure garbage (#1046 Inc-F2c). Exposed as ReadonlyMap so
 *  sharing cannot become aliasing. */
export const NO_FLOW_FIELDS: ReadonlyMap<string, FlowFieldRegion> = new Map()

export class CoverageRenderer {
  private readonly rhi: RhiDevice
  private readonly format: string
  /** Drapers keyed by compiled-predicate key ('' = unfiltered). The predicate is baked into
   *  the pipeline, so this is the variant cache — and it holds ONE entry for the overwhelming
   *  majority of maps, which declare no coverage filter at all. */
  private readonly drapers = new Map<string, CoverageDraper>()
  private dataSampler: RhiSampler | null = null
  private lutSampler: RhiSampler | null = null
  /** Shared drape-mesh index buffer — topology depends only on COVERAGE_GRID_N, so every
   *  region reuses it. Built on first draw, destroyed with the renderer. */
  private indexBuf: RhiBuffer | null = null
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
  private ensureDraper(filter?: CoverageFilterFn, key = ''): CoverageDraper {
    let d = this.drapers.get(key)
    if (!d) {
      d = new CoverageDraper(
        this.rhi,
        this.format,
        Math.min(getSampleCount(), this.rhi.caps.maxSampleCount),
        filter,
      )
      this.drapers.set(key, d)
    }
    return d
  }

  hasCoverage(): boolean {
    return this.states.size > 0
  }

  /** The resident region keys, least-recently-armed first — the LRU/EVICTION order. NOT the draw
   *  order any more: that is relevance (`drawOrder`, #1602), which recency must not decide. */
  residentRegions(): string[] {
    return [...this.states.keys()]
  }

  /** The currently-armed display (ramp + range window), or viridis / open range when
   *  nothing is armed yet. `map.setCoverageData` reuses this so an imperative data swap
   *  keeps the drawing layer's display (LAYER paint, #1158 INC-D) without re-reading the
   *  ShowCommand; a later rebuild re-arms from the layer. */
  displayOpts(): {
    ramp: string
    rangeLo?: number
    rangeHi?: number
    opacity?: number
    filter?: { ast: unknown } | null
  } {
    return {
      ramp: this.lastOpts?.ramp ?? 'viridis',
      rangeLo: this.lastOpts?.rangeLo,
      rangeHi: this.lastOpts?.rangeHi,
      opacity: this.lastOpts?.opacity,
      // Carried for the same reason ramp/range are: an imperative `setCoverageData` swap
      // re-arms from this, and dropping the filter there would silently un-filter the layer —
      // the defect class #1437 exists to close, arriving through the back door.
      filter: this.lastOpts?.filter,
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
    // Called for its EFFECT, not its value: the draper is lazy and must be built at ARM time
    // with the live MSAA sample count (rebuildForQuality invalidates it). The bind group is
    // no longer built here — it is keyed by the ping-pong flow view and minted on first draw.
    this.dataSampler ??= this.rhi.createSampler({ mag: 'linear', min: 'linear' })
    this.lutSampler ??= this.rhi.createSampler({ mag: 'linear', min: 'linear' })
    const band = handle.band(opts.bandIndex ?? 0)
    const [nLon, nLat] = handle.header.size
    const dataMin = band.header.min
    const dataMax = band.header.max

    // `filter:` → a fragment predicate (#1437). Called for its EFFECT as well as its value:
    // the draper is lazy and must exist at ARM time with the live MSAA sample count
    // (rebuildForQuality clears them), and it is keyed by the predicate, which is baked into
    // the pipeline.
    const filterKey = this.armFilter(opts.filter, band.header.name)

    // #1503 — on a DEPTH band the file's own datum semantics say what "below zero" means:
    // `vertical.sign === 'down'` is positive-down from chart datum, so a negative sample is
    // ABOVE datum — land, not a shallow sounding. Those are excluded here rather than in the
    // style, because `filter:` would fix the ramp alone and leave land in the sounding
    // numerals (a numeral reading `-3.2 m` is not a depth) and in the band statistics.
    //
    // Derived, not hard-coded per product: a coverage with sign 'up', or none, keeps every
    // sample, so a temperature or velocity band that is legitimately negative is untouched.
    const minValid = handle.header.vertical.sign === 'down' ? 0 : undefined
    const { value, valid } = packCoverageValueValid(
      band.values,
      dataMin,
      dataMax,
      band.codes,
      minValid,
    )
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
    let flowValid: RhiTexture | null = null
    let flowValidView: RhiTextureView | null = null
    let flowScale = 0
    if (vec) {
      const packed = packFlowFieldUV(vec.speed, vec.direction, vec.speedCodes, vec.directionCodes)
      flowScale = packed.scale
      flowU = this.uploadR16fFrom(packed.u, nLon, nLat, 'coverage-flow-u')
      flowV = this.uploadR16fFrom(packed.v, nLon, nLat, 'coverage-flow-v')
      flowValid = this.uploadR16fFrom(packed.valid, nLon, nLat, 'coverage-flow-valid')
      flowUView = this.rhi.createView(flowU)
      flowVView = this.rhi.createView(flowV)
      flowValidView = this.rhi.createView(flowValid)
    }

    const views = {
      value: this.rhi.createView(valueTex),
      valid: this.rhi.createView(validTex),
      lut: this.rhi.createView(lutTex),
    }

    // Drape-mesh nodes, reprojected through the cell's OWN CRS on the CPU (#1366 INC-3).
    // For a geographic cell `coverageMeshNodes` runs the identical `mix` arithmetic the
    // shader used to, so the drape is unchanged by construction.
    const nodeBuf = this.uploadNodes(handle)

    this.states.set(region, {
      valueTex,
      validTex,
      flowU,
      flowV,
      flowUView,
      flowVView,
      flowValid,
      flowValidView,
      flowScale,
      lutTex,
      nodeBuf,
      views,
      bindGroups: new Map(),
      ramp: computeRampUniforms(dataMin, dataMax, opts.rangeLo ?? dataMin, opts.rangeHi ?? dataMax),
      opacity: opts.opacity ?? 1,
      flowOnly: opts.flowOnly === true,
      hidden: opts.hidden === true,
      priority: opts.priority ?? 0,
      filterKey,
      data: { min: dataMin, max: dataMax },
      // 2 × r16float over the grid + the 256×1 rgba8 LUT, plus the vector TRIPLE (u, v, valid)
      // when this coverage carries one, plus the drape-mesh node buffer (#1366 INC-3). Counting
      // the flow textures matters: they are the SAME size as the value/valid pair, so a vector
      // coverage costs 2.5× a scalar one (#1565 added the validity mask alongside u/v) and the
      // LRU budget would evict far too late if it did not know. The node term is small but
      // constant per region, so it is counted for the same reason rather than rounded away.
      bytes: nLon * nLat * 2 * (vec ? 5 : 2) + 256 * 4 + coverageNodeCount() * COVERAGE_NODE_STRIDE,
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
    this.onRegionDropped?.(region)
  }

  /** Called after a region is DROPPED — by an explicit `removeCoverageRegion`, or by the LRU
   *  budget under `evictOverBudget`. Set by the map to clear that region's compiled arrows.
   *
   *  The explicit drop already clears them (`dropCoverageRegion`); the LRU one did not, and
   *  that is the gap: zooming out and panning to another domain evicts the far region while
   *  its advected arrow batch stays resident and keeps drawing — a batch whose data is gone
   *  and which accumulates one per eviction (#1419). NOT hooked into `releaseRegion`, which
   *  also fires for a re-arm and for `rebuildForQuality`, where the region is coming straight
   *  back and its glyphs must survive. */
  onRegionDropped: ((region: string) => void) | null = null

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
    if (!st || !st.flowUView || !st.flowVView || !st.flowValidView) return null
    const arm = this.arms.get(region)
    if (!arm) return null
    const [w, h] = arm.handle.header.size
    // MERGE (#1366 INC-3 <- #1333): these came off `covGeo` / `covEdges`, the lon/lat
    // footprint rectangle INC-3 deleted because a projected cell violates it. Derived from
    // the header instead, THROUGH the cell's own CRS — so the numbers stay real degrees
    // whatever the grid's units are. For a geographic cell the transform is the identity and
    // the span is `nLon·dLon` / `nLat·dLat` exactly as before, so no S-111 cell moves.
    const crs = arm.handle.header.crs
    const [westEdge, southEdge, eastEdge, northEdge] = coverageEdges(arm.handle.header)
    const [westLon, southLat] = cellUnitsToLonLat(crs, westEdge, southEdge)
    const [eastLon, northLat] = cellUnitsToLonLat(crs, eastEdge, northEdge)
    return {
      u: st.flowUView,
      v: st.flowVView,
      valid: st.flowValidView,
      scale: st.flowScale,
      width: w,
      height: h,
      // The degree span the uv axes cover.
      spanDeg: [eastLon - westLon, northLat - southLat],
      // Midpoint of the OUTER edges — the latitude the whole cell's longitude foreshortening
      // is approximated at.
      midLatDeg: (southLat + northLat) / 2,
    }
  }

  /** EVERY resident region's velocity field, keyed by region — what the ARROW portrayal binds.
   *
   *  Each domain gets its own advected batch, and an arrow is coloured, turned and scaled every
   *  frame by the water it is standing in. Handing them all the FIRST region's field made a
   *  sibling domain report another domain's current — from frame zero, invisible to any coverage
   *  metric (#1458). */
  flowFields(): ReadonlyMap<string, FlowFieldRegion> {
    // The flow pass declares EVERY frame now, including on maps that will never
    // have a coverage (#1046 Inc-F2c) — so the empty answer must not mint a Map
    // per frame. Returning the shared instance is safe by CONSTRUCTION, not by
    // convention: the return type is ReadonlyMap, so no caller can write to it.
    if (this.states.size === 0) return NO_FLOW_FIELDS
    const out = new Map<string, FlowFieldRegion>()
    for (const region of this.states.keys()) {
      const f = this.flowField(region)
      if (f) out.set(region, f)
    }
    return out
  }

  /** EVERY VISIBLE region's velocity field — what the IBFV TRAIL steps, one stepper per entry
   *  (#1499). The trail is a recursive filter over the region's OWN grid, so a mosaic needs one
   *  history per domain; one pair fed from the first resident region left every other domain's
   *  drape sampling that domain's image, which is #1499's report.
   *
   *  VISIBLE, unlike `flowFields` above: under the `arrows` portrayal every flow region is
   *  resident-but-hidden, so its trail would be advected each frame and drawn by nobody (#1419).
   *  Empty is therefore also the answer that retires every stepper, declared each frame. */
  drapedFlowFields(): ReadonlyMap<string, FlowFieldRegion> {
    // Same no-allocation floor as `flowFields` — the pass declares EVERY frame.
    if (this.states.size === 0) return NO_FLOW_FIELDS
    const out = new Map<string, FlowFieldRegion>()
    for (const [region, st] of this.states) {
      const f = st.hidden ? null : this.flowField(region)
      if (f) out.set(region, f)
    }
    return out
  }

  /** True when ANY resident region carries a velocity field — the `scene.hasFlow` gate and the
   *  render-loop keep-warm, so a map with only scalar coverages never runs the advection pass.
   *  Quantifies over the SAME predicate `flowFields` does (asserted by the upload test): a true
   *  here with an empty map there would spin the on-demand loop on a pass that does nothing. */
  hasFlowField(): boolean {
    for (const st of this.states.values()) if (st.flowUView && st.flowVView) return true
    return false
  }

  /** The draper a region draws through. A region is only ever armed alongside its draper
   *  (`armFilter`), so a miss here means the two went out of step — loud beats a blank layer. */
  private draperFor(s: CoverageState): CoverageDraper {
    const d = this.drapers.get(s.filterKey)
    if (!d) throw new Error(`[coverage] no draper for filter key "${s.filterKey}"`)
    return d
  }

  /** Compile a layer's `filter:` into the fragment predicate and arm the draper that carries
   *  it, returning the key the region draws under ('' when there is no filter).
   *
   *  THROWS on a predicate outside the compilable subset, matching `bakeRampLut`'s
   *  unknown-ramp behaviour and for the same reason: the alternative to a loud failure here
   *  is a drape that paints every cell while the style says otherwise, which is the defect
   *  this binding has now had twice. The message names the band the layer actually drapes, so
   *  the author can see why `.speed` was refused on a `.depth` layer. */
  private armFilter(filter: { ast: unknown } | null | undefined, band: string): string {
    if (!filter?.ast) {
      this.ensureDraper()
      return ''
    }
    const compiled = compileCoverageFilter(filter.ast as AST.Expr)
    if (!compiled.ok) {
      throw new Error(`[coverage] filter: ${compiled.reason} (this layer drapes \`${band}\`)`)
    }
    if (compiled.band !== band) {
      // The drape binds ONE data texture — this layer's band. A predicate over another band
      // is real work (#1437 phase 2), not something to quietly evaluate somewhere else.
      throw new Error(
        `[coverage] filter: reads \`.${compiled.band}\`, but this layer drapes \`${band}\``,
      )
    }
    this.ensureDraper(compiled.decl, compiled.key)
    return compiled.key
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
    for (const d of this.drapers.values()) d.destroy()
    this.drapers.clear()
    for (const [key, { handle, opts }] of prior) this.setCoverage(handle, opts, key)
  }

  /** Evict least-recently-armed regions until the resident set fits the GPU byte budget.
   *  `keep` (the region just armed) is never evicted — arming a region must always leave it
   *  resident, even if it alone exceeds the budget (a single oversized domain still draws;
   *  the budget bounds ACCUMULATION, it is not a per-region size cap). */
  /** The resident regions in DRAW order: least relevant first, so the most relevant paints last
   *  and therefore on top of any overlap (#1602). STATED POLICY: docs/adr/0011.
   *
   *  Entries, not bare states: the drape binds THAT region's own trail (#1499), and the Map key
   *  stays the one authority for the region name — a `region` field would be a second one.
   *
   *  A stable sort on `priority` descending. Stable matters — regions that share a priority (every
   *  single-region caller leaves it at 0) keep their arm order, so nothing about the
   *  one-region case changes. Allocates one array per frame over a handful of regions, which is
   *  the same shape `residentRegions()` already has; the alternative (keeping a second sorted Map
   *  in step with `states` through arm, re-arm and evict) is a second authority to drift. */
  private drawOrder(): [string, CoverageState][] {
    if (this.states.size < 2) return [...this.states]
    return [...this.states].sort((a, b) => b[1].priority - a[1].priority)
  }

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
    pass: RhiRenderPass,
    mvp: Float32Array | number[],
    camCenter: [number, number],
    projParams: [number, number, number, number],
    flow?: FlowDrape | null,
    /** Live camera zoom, for a `zoom`-dependent `filter:` (#1437). The sounding arm already
     *  reads it; leaving the drape blind to it would make one clause mean two things. */
    cameraZoom?: number,
  ): void {
    if (this.states.size === 0 || this.drapers.size === 0) return
    // Both frame shapes hand in an RhiRenderPass (Inc-2d) — the old
    // backend-keyed re-wrap was the 34d4695 double-wrap class.
    const rhiPass = pass
    // MOST RELEVANT LAST, so it lands on top where domains overlap (#1602).
    //
    // This used to walk `states` directly, which is an LRU: `setCoverage` delete-then-sets, so the
    // back is the most recently ARMED region — and with `blend: 'alpha'` the back is what paints
    // over everything. Re-arms fire per region on every forecast tick, so the overlap's winner
    // changed several times a second, picked by recency, and disagreed with the region
    // `getCoverage(id, at)` reports for the same point.
    //
    // Relevance is not invented here. The catalogue ranks overlapping cells by overlap area with
    // ties toward the smaller bbox — the higher-resolution local cell — and arms them in that
    // order, which is exactly what the `priority` index carries. Sorting ASCENDING and drawing in
    // that order puts priority 0 last only if reversed, so the comparator is descending: least
    // relevant first, most relevant last.
    //
    // `states` keeps its LRU untouched — that order is still correct for EVICTION, which wants
    // least-recently-used. One Map served both until the two started wanting opposite directions.
    for (const [region, s] of this.drawOrder()) {
      // Resident for its data, not for its paint (#1419) — the velocity pair is uploaded and
      // the arrow field is built from it, while the drape itself stays out of the frame.
      if (s.hidden) continue
      // The motion layer rides ONLY on a region that carries a velocity field AND has advected
      // an image of its OWN (#1499) — a sibling's trail is never a stand-in. A scalar region (or
      // one whose first step has not run) binds its own value texture as the inert stand-in and
      // gets mix 0, so it draws byte-identically beside an animated neighbour.
      const trail = flow != null && s.flowUView !== null ? flow.viewFor(region) : null
      const flowView = trail ?? s.views.value
      const bytes = packCoverageUniforms({
        mvp,
        projParams,
        camCenter,
        ramp: s.ramp,
        opacity: s.opacity,
        flowMix: trail !== null && flow != null ? flow.mix : 0,
        flowOnly: s.flowOnly,
        data: s.data,
        cameraZoom,
      })
      // MERGE UNION (#1366 INC-3 <- #1333): the indexed node mesh (INC-3) drawn with the
      // flow-keyed bind group (#1333) — the two changes touch different draw arguments.
      // The region's OWN draper: the predicate is baked into the pipeline, so a filtered
      // region and an unfiltered one in the same mosaic are different pipelines — and the
      // bind group must come from the SAME draper, because binding 0 is that draper's global
      // uniform buffer and `draw` writes only its own.
      const draper = this.draperFor(s)
      draper.draw(
        rhiPass,
        bytes as BufferSource,
        this.groupFor(s, flowView, draper),
        s.nodeBuf,
        this.ensureIndexBuf(),
      )
    }
  }

  /** Build + upload this coverage's node buffer: [lon, lat, u, v] per mesh node. The
   *  lon/lat comes from @xgis/data (proj4 lives there); uv is the footprint fraction with
   *  v flipped to the data texture's north-up row order. */
  private uploadNodes(handle: CoverageHandle): RhiBuffer {
    const n = COVERAGE_GRID_N
    const lonLat = coverageMeshNodes(handle.header, n)
    const out = new Float32Array(coverageNodeCount() * 4)
    for (let gy = 0; gy <= n; gy++) {
      for (let gx = 0; gx <= n; gx++) {
        const node = gy * (n + 1) + gx
        out[node * 4] = lonLat[node * 2]!
        out[node * 4 + 1] = lonLat[node * 2 + 1]!
        out[node * 4 + 2] = gx / n
        out[node * 4 + 3] = 1 - gy / n // v01 runs south→north; the data texture is north-up
      }
    }
    const buf = this.rhi.createBuffer({
      size: out.byteLength,
      usage: 'vertex',
      label: 'coverage-nodes',
    })
    this.rhi.writeBuffer(buf, 0, out as BufferSource)
    return buf
  }

  /** The mesh TOPOLOGY is a function of COVERAGE_GRID_N alone, so every region shares one
   *  index buffer — built once, never per arm. uint16 is safe: (N+1)² = 4 225 < 65 536. */
  private ensureIndexBuf(): RhiBuffer {
    if (this.indexBuf) return this.indexBuf
    const n = COVERAGE_GRID_N
    const idx = new Uint16Array(coverageGridIndexCount())
    let w = 0
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const sw = cy * (n + 1) + cx
        const se = sw + 1
        const nw = sw + (n + 1)
        const ne = nw + 1
        // Two triangles per cell, matching the old procedural du/dv winding.
        idx[w++] = sw
        idx[w++] = se
        idx[w++] = nw
        idx[w++] = se
        idx[w++] = ne
        idx[w++] = nw
      }
    }
    this.indexBuf = this.rhi.createBuffer({
      size: idx.byteLength,
      usage: 'index',
      label: 'coverage-mesh-indices',
    })
    this.rhi.writeBuffer(this.indexBuf, 0, idx as BufferSource)
    return this.indexBuf
  }

  /** This region's bind group for `flowView`, memoized. Keyed rather than rebuilt because the
   *  advection pair alternates: two entries for an animated region, one for a scalar one.
   *
   *  `draper` is a PARAMETER, not `ensureDraper()`. It used to be the latter, which was correct
   *  only while there was one draper: once #1437 keyed drapers by predicate, the group bound
   *  the UNFILTERED draper's global uniform buffer (binding 0) while the draw ran the FILTERED
   *  draper's pipeline and wrote the filtered draper's buffer. The shader then read a buffer
   *  nobody had written — `cov_data` all zeros, so every raw value came out 0 and the predicate
   *  discarded the entire drape. Invisible to 4 020 unit tests and a green build; one headless
   *  WebGL2 render showed a black map (CLAUDE.md §5). Passing it in removes the choice. */
  private groupFor(
    s: CoverageState,
    flowView: RhiTextureView,
    draper: CoverageDraper,
  ): RhiBindGroup {
    let bg = s.bindGroups.get(flowView)
    if (!bg) {
      bg = draper.bindGroup(
        s.views.value,
        s.views.valid,
        this.dataSampler!,
        s.views.lut,
        this.lutSampler!,
        flowView,
      )
      s.bindGroups.set(flowView, bg)
    }
    return bg
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
    this.rhi.destroyBuffer(s.nodeBuf)
    // The views die with their textures (RHI has no destroyView — rhi.ts:462), and a bind
    // group holds no ownable GPU resource (same note), so the memo is just dropped.
    s.bindGroups.clear()
    if (s.flowU) this.rhi.destroyTexture(s.flowU)
    if (s.flowV) this.rhi.destroyTexture(s.flowV)
    if (s.flowValid) this.rhi.destroyTexture(s.flowValid)
    this.states.delete(region)
  }

  dispose(): void {
    for (const key of [...this.states.keys()]) this.releaseRegion(key)
    if (this.dataSampler) this.rhi.destroySampler(this.dataSampler)
    if (this.lutSampler) this.rhi.destroySampler(this.lutSampler)
    // The shared mesh-topology index buffer outlives individual regions, so it is freed
    // here rather than in releaseRegion.
    if (this.indexBuf) this.rhi.destroyBuffer(this.indexBuf)
    this.indexBuf = null
    this.dataSampler = null
    this.lutSampler = null
    this.arms.clear()
    this.lastOpts = null
    // #2286 — rebuildForQuality() dropped the drapers; this dispose, the one map
    // teardown reaches, left every one of them alive (releaseRegion never touches them).
    for (const d of this.drapers.values()) d.destroy()
    this.drapers.clear()
  }
}
