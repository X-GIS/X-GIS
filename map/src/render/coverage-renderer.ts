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
// a single timeslice. The draw quad spans the coverage's OUTER cell edges; the
// fragment inverts Mercator per-pixel (coverage-ramp.ts / A4). render() takes the
// camera-derived MVP + centre + proj params (the map.ts arming computes them, mirroring
// the raster flat path) so this renderer stays camera-internals-free and unit-testable.

import type { RhiDevice, RhiTexture, RhiSampler, RhiBindGroup, RhiRenderPass } from '@xgis/engine'
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
}

export interface CoverageArmOptions {
  ramp: string
  /** Display range [lo, hi]; defaults to the band's data range (a=1, b=0). */
  rangeLo?: number
  rangeHi?: number
  bandIndex?: number | string
}

export class CoverageRenderer {
  private readonly draper: CoverageDraper
  private readonly dataSampler: RhiSampler
  private readonly lutSampler: RhiSampler
  private state: CoverageState | null = null

  constructor(
    private readonly rhi: RhiDevice,
    format: string,
    sampleCount: number,
  ) {
    this.draper = new CoverageDraper(rhi, format, sampleCount)
    // Linear + clamp-to-edge on both (the RHI sampler is clamp by default; linear
    // gives the exact validity-weighted bilinear the fragment divides back out).
    this.dataSampler = rhi.createSampler({ mag: 'linear', min: 'linear' })
    this.lutSampler = rhi.createSampler({ mag: 'linear', min: 'linear' })
  }

  hasCoverage(): boolean {
    return this.state !== null
  }

  /** Upload a coverage's value/validity textures + LUT and arm the draw. Replaces
   *  any previous coverage (destroying its textures — no leak). */
  setCoverage(handle: CoverageHandle, opts: CoverageArmOptions): void {
    this.releaseTextures()
    const band = handle.band(opts.bandIndex ?? 0)
    const [nLon, nLat] = handle.header.size
    const dataMin = band.header.min
    const dataMax = band.header.max

    const { value, valid } = packCoverageValueValid(band.values, dataMin, dataMax, band.codes)
    const valueTex = this.uploadR16f(value, nLon, nLat)
    const validTex = this.uploadR16f(valid, nLon, nLat)
    const lutTex = this.uploadLut(bakeRampLut(opts.ramp))

    const bindGroup = this.draper.bindGroup(
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
    }
  }

  /** Draw the coverage (flat Mercator). The caller supplies the camera-derived
   *  MVP (Mercator-metre, camera-at-origin), the camera Mercator centre, and the
   *  projection params — mirroring the raster flat arm. No-op when unarmed. */
  render(
    pass: RhiRenderPass,
    mvp: Float32Array | number[],
    camCenter: [number, number],
    projParams: [number, number, number, number],
  ): void {
    const s = this.state
    if (!s) return
    const bytes = packCoverageUniforms({
      mvp,
      projParams,
      camCenter,
      covEdges: s.covEdges,
      covGeo: s.covGeo,
      ramp: s.ramp,
    })
    this.draper.draw(pass, bytes as BufferSource, s.bindGroup)
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
    this.rhi.destroySampler(this.dataSampler)
    this.rhi.destroySampler(this.lutSampler)
  }
}
