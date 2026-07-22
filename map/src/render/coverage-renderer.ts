// ═══ CoverageRenderer — S-100 gridded-coverage GPU arm (#1158 GAP-1 INC-A) ═══
//
// Owns the per-source GPU state for the colour-ramp coverage draw: TWO resident
// r16float data textures (value + validity, A3), the 256×1 rgba8 LUT, the linear-
// clamp samplers, and the bind group — all through the RHI seam (no raw WebGPU in
// @xgis/map). The CPU-resident values stay in the CoverageHandle (@xgis/data), the
// value-readout authority; this renderer only ever holds COLOUR-path state, so a
// device swap re-uploads without touching value correctness (the syncDevice lesson).
//
// Time scrub (setCoverageTime) re-uploads the ONE resident texture — INC-C. INC-A is
// a single timeslice. The draw is a TESSELLATED surface grid over the OUTER cell edges,
// each vertex projected via the general `project()` (coverage-ramp.ts) — projection-
// general for every flat projection, no baked Mercator. render() takes the
// camera-derived MVP + centre + proj params (the opaque-pass arming computes them,
// mirroring the raster flat path) so this renderer stays camera-internals-free and
// unit-testable. The draper is LAZY (raster's ensureRasterDraper pattern): built at
// first arm with the live MSAA sample count, invalidated by rebuildForQuality().

import type { GPUContext } from '@xgis/rhi-webgpu'
import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import type { RhiDevice, RhiTexture, RhiSampler, RhiBindGroup, RhiRenderPass } from '@xgis/engine'
import { getSampleCount } from '@xgis/engine'
import type { CoverageHandle } from '@xgis/data'
import { CoverageDraper } from './material/coverage-material'
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
  /** west/south/east/north outer cell EDGES (degrees) for the draw quad. */
  covEdges: [number, number, number, number]
  /** westLonEdge, northLatEdge, nLon·dLon, nLat·dLat — for the fragment u/v. */
  covGeo: [number, number, number, number]
  ramp: { a: number; b: number }
  /** Layer opacity (0..1) — multiplies output alpha (ramp_params.z). */
  opacity: number
}

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
  private state: CoverageState | null = null
  /** Last armed inputs, retained so rebuildForQuality() can re-arm at the new
   *  sample count (the textures + bind group are draper-layout-bound). */
  private lastHandle: CoverageHandle | null = null
  private lastOpts: CoverageArmOptions | null = null

  constructor(ctx: GPUContext) {
    this.rhi = ctx.rhi
    this.format = ctx.format
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
    return this.state !== null
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

  /** Upload a coverage's value/validity textures + LUT and arm the draw. Replaces
   *  any previous coverage (destroying its textures — no leak). */
  setCoverage(handle: CoverageHandle, opts: CoverageArmOptions): void {
    this.releaseTextures()
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

    const [originLon, originLat] = handle.header.origin
    const [dLon, dLat] = handle.header.spacing
    const westEdge = originLon - dLon / 2
    const southEdge = originLat - dLat / 2
    const eastEdge = westEdge + nLon * dLon
    const northEdge = southEdge + nLat * dLat

    this.state = {
      valueTex,
      validTex,
      lutTex,
      bindGroup,
      covEdges: [westEdge, southEdge, eastEdge, northEdge],
      covGeo: [westEdge, northEdge, nLon * dLon, nLat * dLat],
      ramp: computeRampUniforms(dataMin, dataMax, opts.rangeLo ?? dataMin, opts.rangeHi ?? dataMax),
      opacity: opts.opacity ?? 1,
    }
    this.lastHandle = handle
    this.lastOpts = opts
  }

  /** Disarm the draw (scene rebuild with no coverage source). Textures are
   *  destroyed; the draper + samplers stay for a later re-arm. */
  clear(): void {
    this.releaseTextures()
    this.lastHandle = null
    this.lastOpts = null
  }

  /** A quality (MSAA) change invalidates the draper pipeline; re-arm from the
   *  retained handle so the bind group is rebuilt against the new layout. */
  rebuildForQuality(): void {
    const handle = this.lastHandle
    const opts = this.lastOpts
    this.releaseTextures()
    this._draper = null
    if (handle && opts) this.setCoverage(handle, opts)
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
    const s = this.state
    if (!s || !this._draper) return
    const bytes = packCoverageUniforms({
      mvp,
      projParams,
      camCenter,
      covEdges: s.covEdges,
      covGeo: s.covGeo,
      ramp: s.ramp,
      opacity: s.opacity,
    })
    // A WebGl2Device frame (renderFrameViaRhi twin) hands in an RhiRenderPass
    // already; the WebGPU opaque pass hands in a GPURenderPassEncoder that needs
    // wrapping — the ONE backend fork, mirroring raster-renderer.render.
    const rhiPass =
      this.rhi.backend === 'webgl2'
        ? (pass as RhiRenderPass)
        : wrapWebGpuPass(pass as GPURenderPassEncoder)
    this._draper.draw(rhiPass, bytes as BufferSource, s.bindGroup)
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

  private releaseTextures(): void {
    if (!this.state) return
    this.rhi.destroyTexture(this.state.valueTex)
    this.rhi.destroyTexture(this.state.validTex)
    this.rhi.destroyTexture(this.state.lutTex)
    this.state = null
  }

  dispose(): void {
    this.releaseTextures()
    if (this.dataSampler) this.rhi.destroySampler(this.dataSampler)
    if (this.lutSampler) this.rhi.destroySampler(this.lutSampler)
    this.dataSampler = null
    this.lutSampler = null
    this.lastHandle = null
    this.lastOpts = null
  }
}
