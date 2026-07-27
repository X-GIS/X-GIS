// ═══ S-100 vector-field coverage interpolation ═══
//
// Blends two forecast-hour CoverageHandles of the SAME gridded vector field (S-111
// surfaceCurrentSpeed/Direction today; any future speed+direction S-100 grid — GFS wind #1273
// — reuses this unchanged) at a fractional time `t ∈ [0,1]`, producing a synthetic intermediate
// CoverageHandle. Every EXISTING consumer (the coverage fill renderer, the arrow/particle field
// generators) reads it exactly like a real decoded hour — zero coupling, no consumer-side
// branching for "is this interpolated" (ADR-0010's reader→renderer seam: this is just another
// CoverageInput → CoverageHandle build via coverageFromGrids).
//
// Interpolates the VECTOR COMPONENTS (east/north), not speed and direction independently — a
// naive `lerp(dirA, dirB, t)` gets the 360°/0° wraparound wrong (350° → 10° would sweep the
// LONG way through 180° instead of the 20° short way through 0°) and is undefined when either
// side is calm (speed 0 has no meaningful direction). Component interpolation is exact for a
// PIECEWISE-CONSTANT-VELOCITY assumption between the two hours (the same assumption a linear
// speed/direction blend would make, just expressed in a frame where "blend" is well-defined
// everywhere) and degrades gracefully to a pure magnitude fade when one side is calm.

import { coverageFromGrids, CoverageHandle, type CoverageBandInput } from './format'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** Blend `speedBand`/`directionBand` of two SAME-GEOMETRY coverage handles at `t` (0 = `a`,
 *  1 = `b`); every other band copies through from `a` unchanged. A cell that is nodata/NaN in
 *  EITHER source at EITHER band stays nodata in the result — interpolating a real value against
 *  "no data" would fabricate a reading neither forecast made. Throws if the grids' geometry
 *  (size/origin/spacing) disagrees — the two hours must be the SAME cell's grid, not a mosaic
 *  swap mid-blend (callers should not interpolate across a region change). */
export function interpolateVectorCoverage(
  a: CoverageHandle,
  b: CoverageHandle,
  t: number,
  opts: { speedBand?: string; directionBand?: string } = {},
): CoverageHandle {
  const speedName = opts.speedBand ?? 'surfaceCurrentSpeed'
  const dirName = opts.directionBand ?? 'surfaceCurrentDirection'
  const [nLon, nLat] = a.header.size
  if (b.header.size[0] !== nLon || b.header.size[1] !== nLat)
    throw new Error('[coverage] interpolateVectorCoverage: grid size mismatch between a and b')
  if (a.header.origin[0] !== b.header.origin[0] || a.header.origin[1] !== b.header.origin[1])
    throw new Error('[coverage] interpolateVectorCoverage: grid origin mismatch between a and b')

  const speedA = a.band(speedName)
  const dirA = a.band(dirName)
  const speedB = b.band(speedName)
  const dirB = b.band(dirName)
  const n = nLon * nLat
  const outSpeed = new Float32Array(n)
  const outDir = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const sA = speedA.values[i]!
    const dA = dirA.values[i]!
    const sB = speedB.values[i]!
    const dB = dirB.values[i]!
    if (Number.isNaN(sA) || Number.isNaN(dA) || Number.isNaN(sB) || Number.isNaN(dB)) {
      outSpeed[i] = NaN
      outDir[i] = NaN
      continue
    }
    const fxA = sA * Math.sin(dA * DEG2RAD)
    const fyA = sA * Math.cos(dA * DEG2RAD)
    const fxB = sB * Math.sin(dB * DEG2RAD)
    const fyB = sB * Math.cos(dB * DEG2RAD)
    const fx = fxA + (fxB - fxA) * t
    const fy = fyA + (fyB - fyA) * t
    outSpeed[i] = Math.hypot(fx, fy)
    const deg = Math.atan2(fx, fy) * RAD2DEG
    outDir[i] = deg < 0 ? deg + 360 : deg
  }

  const bands: CoverageBandInput[] = a.bands.map((band) => {
    if (band.header.name === speedName)
      return { name: speedName, unit: speedA.header.unit, kind: 'f32', nodata: NaN, values: outSpeed }
    if (band.header.name === dirName)
      return { name: dirName, unit: dirA.header.unit, kind: 'f32', nodata: NaN, values: outDir }
    return { name: band.header.name, unit: band.header.unit, kind: 'f32', nodata: NaN, values: band.values }
  })
  return coverageFromGrids({
    product: a.header.product,
    origin: a.header.origin,
    spacing: a.header.spacing,
    size: a.header.size,
    vertical: a.header.vertical,
    bands,
  })
}
