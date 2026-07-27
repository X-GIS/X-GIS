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
  RhiSampler,
  RhiBindGroup,
  RhiRenderPass,
  RhiBuffer,
} from '@xgis/engine'
import { getSampleCount } from '@xgis/engine'
import type { CoverageHandle } from '@xgis/data'
import { coverageMeshNodes } from '@xgis/data'
import { CoverageDraper, COVERAGE_NODE_STRIDE } from './material/coverage-material'
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
  bindGroup: RhiBindGroup
  /** Interleaved [lon, lat, u, v] per drape-mesh NODE, CPU-reprojected through the
   *  cell's own CRS (#1366 INC-3). Replaces the cov_edges/cov_geo lon/lat rectangle,
   *  which could not describe a projected footprint. */
  nodeBuf: RhiBuffer
  ramp: { a: number; b: number }
  /** Layer opacity (0..1) — multiplies output alpha (ramp_params.z). */
  opacity: number
  /** Approximate GPU bytes this region holds — the LRU budget's accounting unit. */
  bytes: number
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

    const bindGroup = draper.bindGroup(
      this.rhi.createView(valueTex),
      this.rhi.createView(validTex),
      this.dataSampler,
      this.rhi.createView(lutTex),
      this.lutSampler,
    )

    // Drape-mesh nodes, reprojected through the cell's OWN CRS on the CPU (#1366 INC-3).
    // For a geographic cell `coverageMeshNodes` runs the identical `mix` arithmetic the
    // shader used to, so the drape is unchanged by construction.
    const nodeBuf = this.uploadNodes(handle)

    this.states.set(region, {
      valueTex,
      validTex,
      lutTex,
      bindGroup,
      nodeBuf,
      ramp: computeRampUniforms(dataMin, dataMax, opts.rangeLo ?? dataMin, opts.rangeHi ?? dataMax),
      opacity: opts.opacity ?? 1,
      // 2 × r16float over the grid + the 256×1 rgba8 LUT + the node buffer.
      bytes: nLon * nLat * 2 * 2 + 256 * 4 + coverageNodeCount() * COVERAGE_NODE_STRIDE,
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
        ramp: s.ramp,
        opacity: s.opacity,
      })
      this._draper.draw(
        rhiPass,
        bytes as BufferSource,
        s.bindGroup,
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

  private uploadR16f(data: Uint16Array, width: number, height: number): RhiTexture {
    const tex = this.rhi.createTexture({
      width,
      height,
      format: 'r16float',
      usage: ['sample', 'copy-dst'],
      label: 'coverage-data',
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
  }
}
