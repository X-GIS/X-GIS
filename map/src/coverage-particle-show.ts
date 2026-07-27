// Coverage particle-flow show → GraphicsManager.add({type:'particle-flow'}) — the ENGINE-side
// generator that turns a gridded S-100 surface vector-field coverage (S-111 currents today; any
// future speed+direction grid — GFS wind #1273 — reuses this unchanged) into an ANIMATED
// particle-flow field: a second, MOVING reading of the SAME grid the (optional) static arrow
// field draws (coverage-arrow-show.ts) — "one field, two representations"
// (docs/plans/2026-07-14-particle-flow-design.md §1.3), generalised from that design's per-gu
// field to a per-grid-cell one. Reuses the EXISTING generic particle-flow retained primitive
// (#826) verbatim through the public `GraphicsManager.add()` host API — zero new shader, packer,
// or graphics-manager.ts code; a coverage cell is just another `D` datum for
// `ParticleFlowDrawSpec<D>`, exactly like a Seoul gu.
//
// Lifecycle: unlike the compiled-arrow path (a specialised flat-array batch list the graphics
// manager owns and clears via `clearCompiledArrows()`), a particle-flow batch is a NORMAL host
// `DrawHandle` — the caller (map.ts) owns it and must `.remove()` it before re-adding on a
// coverage data/time swap. This module only builds the spec and calls `add()`; it never manages
// the handle's lifetime.

import type { CoverageHandle } from '@xgis/data'
import type { ShowCommand } from './render/renderer-types'
import type { GraphicsManager } from './graphics/graphics-manager'
import type { DrawHandle } from './graphics/graphics-types'
import { bandedRampColor } from './color-ramp'
import { s111HasArrow, S111_SPEED_RAMP } from './render/s111-portrayal'

/** The slice of XGISMap the coverage-particle build reads. */
export interface CoverageParticleShowHost {
  graphics: GraphicsManager
}

/** Metres per degree of latitude (WGS84 mean) — the grid-cell → jitter-radius conversion. */
const M_PER_DEG_LAT = 111320
/** Target total particle pool for a coverage field — the design ceiling (§2.3), requested in
 *  full: a regional S-111 grid (tens of thousands of water cells) reads as sparse dots at the
 *  Seoul-tuned default (4,096 spread over 25 cells), not a flow. */
const COVERAGE_PARTICLE_COUNT = 16384

interface FieldCell {
  lon: number
  lat: number
  bearingDeg: number
  speed: number
  rgb: readonly [number, number, number]
}

/** Build the animated particle-flow field for a coverage layer carrying `| particles`. One
 *  "cell" datum per valid (finite speed > 0, finite direction) grid cell — the SAME drawable
 *  filter as the static arrow field (coverage-arrow-show.ts), so the two representations never
 *  disagree about which cells carry current. Density is volume-allocated (RAW speed) by the
 *  particle packer itself (design §2.3) with NO per-cell floor — the Seoul-tuned default floor
 *  (8/cell) would demand `8 × cellCount` particles just to seed every cell once, blowing past
 *  the pool on a grid with tens of thousands of cells. Returns the `DrawHandle` (null when
 *  nothing is drawable) — the CALLER owns removing it on the next data/time swap. */
export function addCoverageParticleShowLayer(
  host: CoverageParticleShowHost,
  show: ShowCommand,
  handle: CoverageHandle,
): DrawHandle<unknown> | null {
  const bands = handle.bands
  const speedBand = bands.find((b) => b.header.name === 'surfaceCurrentSpeed') ?? bands[0]
  const dirBand = bands.find((b) => b.header.name === 'surfaceCurrentDirection') ?? bands[1]
  if (!speedBand || !dirBand) return null

  const [nLon, nLat] = handle.header.size
  const [originLon, originLat] = handle.header.origin // SW cell CENTRE (point registration)
  const [dLon, dLat] = handle.header.spacing
  const rampName = show.ramp ?? S111_SPEED_RAMP
  const speed = speedBand.values
  const dir = dirBand.values

  const cells: FieldCell[] = []
  for (let i = 0; i < speed.length; i++) {
    const s = speed[i]!
    const d = dir[i]!
    if (!s111HasArrow(s) || !Number.isFinite(d)) continue
    const row = Math.floor(i / nLon) // north-up storage: row 0 = northernmost
    const col = i - row * nLon
    const rgb = bandedRampColor(rampName, s) ??
      bandedRampColor(S111_SPEED_RAMP, s) ?? [255, 255, 255]
    cells.push({
      lon: originLon + col * dLon,
      lat: originLat + (nLat - 1 - row) * dLat,
      bearingDeg: d,
      speed: s,
      rgb,
    })
  }
  if (cells.length === 0) return null

  // Jitter radius bounded by the grid's OWN cell spacing (40% of the smaller dimension), so a
  // particle's seed stays within its home cell — unlike Seoul's km-scale gu polygons, an S-111
  // cell can be sub-km, and the design's flat 1200 m default would routinely overshoot into a
  // neighbouring (possibly land, possibly differently-flowing) cell. `originLat` is a
  // representative latitude for the lon→metres factor across one regional grid.
  const latRad = (originLat * Math.PI) / 180
  const cellWidthM = Math.abs(dLon) * M_PER_DEG_LAT * Math.cos(latRad)
  const cellHeightM = Math.abs(dLat) * M_PER_DEG_LAT
  const seedRadiusMeters = Math.max(1, Math.min(cellWidthM, cellHeightM) * 0.4)

  return host.graphics.add<FieldCell>({
    type: 'particle-flow',
    data: cells,
    getPosition: (c) => [c.lon, c.lat],
    getBearing: (c) => c.bearingDeg,
    getVolume: (c) => c.speed, // RAW speed — the honest density signal (design §5-Q3)
    getColor: (c) => [c.rgb[0] / 255, c.rgb[1] / 255, c.rgb[2] / 255, 1],
    particleCount: COVERAGE_PARTICLE_COUNT,
    maxParticles: COVERAGE_PARTICLE_COUNT,
    minPerCell: 0,
    seedRadiusMeters,
  })
}
