// ═══ S-100 gridded coverage — CoverageHandle + the coverageFromGrids seam ═══
//
// The CPU-resident render-data for a gridded coverage: a north-up, band-planar
// float grid + geometry (grid origin/spacing/size, vertical-datum code, positive-
// down flag). `coverageFromGrids` builds it DIRECTLY from a reader's grids — the
// reader→renderer seam (ADR-0010). There is NO wire format here: the data is read
// from the standard it already lives in (S-100 HDF5 via `readCoverageFromHdf5`, or
// a COG reader later) IN PLACE; a house `.xgcov` blob was retired (the custom-format
// trap, `site/src/content/blog/2026-07-21-the-custom-format-trap.md`; ADR-0010).
//
// nodata cells decode to NaN — the runtime nodata test is ALWAYS Number.isNaN,
// never a float compare against a sentinel like 1e6 / -9999.

/** u16 GPU-normalization span: codes 0..QUANT_MAX map [min,max]; 0xFFFF is the
 *  reserved nodata code. The coverage material reads these for its (now optional)
 *  code path; kept as the single authority so a GPU packer cannot drift. */
export const QUANT_MAX = 65534 // 0xFFFE — 0xFFFF is the nodata code
export const NODATA_CODE = 0xffff

export type BandKind = 'f32' | 'u16'

export interface CoverageBandHeader {
  name: string
  unit: string
  kind: BandKind
  /** ORIGINAL source fill value (provenance) — runtime uses NaN, not this. */
  nodata: number
  /** Data range over valid cells (drives the GPU normalization uniforms). */
  min: number
  max: number
  /** u16 dequantization: value = offset + code·scale. Absent for f32 bands. */
  scale?: number
  offset?: number
}

export interface CoverageHeader {
  product: 's102' | 's104' | 's111' | 'generic'
  crs: 'EPSG:4326'
  /** SW cell CENTRE [lonDeg, latDeg]; registration is 'point'. */
  origin: [number, number]
  spacing: [number, number]
  /** [nLon, nLat]. */
  size: [number, number]
  registration: 'point'
  bands: CoverageBandHeader[]
  vertical: { datumCode: number | null; datumName?: string; sign: 'down' | 'up' }
  time: null | { count: number; firstIso: string; lastIso: string; intervalSeconds?: number }
  sourceMeta?: Record<string, unknown>
}

/** One band's grid for `coverageFromGrids` — values are NORTH-UP (row 0 = north),
 *  with the SOURCE fill still present at nodata cells (coverageFromGrids maps it to
 *  NaN). `kind` is 'f32' for an in-memory handle (no quantization). */
export interface CoverageBandInput {
  name: string
  unit: string
  kind: BandKind
  /** The source fill value that marks nodata cells in `values`. */
  nodata: number
  /** North-up, row-major, length nLon·nLat. */
  values: Float32Array
}

export interface CoverageInput {
  product: CoverageHeader['product']
  origin: [number, number]
  spacing: [number, number]
  size: [number, number]
  bands: CoverageBandInput[]
  vertical: CoverageHeader['vertical']
  sourceMeta?: Record<string, unknown>
}

// ── Valid range ─────────────────────────────────────────────────────────────
/** min/max over VALID (non-nodata) cells only — the GPU-normalization window. A
 *  degenerate/empty range collapses to [0,0]. */
function validRange(values: Float32Array, nodata: number): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v === nodata || Number.isNaN(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) {
    min = 0
    max = 0
  }
  return { min, max }
}

// ── DecodedBand — one band as the CoverageHandle holds it ─────────────────────
/** One band's grid as the runtime holds it: f32 values with NaN at nodata cells.
 *  `codes` is legacy/optional (a u16-quantized GPU-normalize path); `coverageFromGrids`
 *  never sets it — in-memory handles are f32. North-up, length nLon·nLat. */
export interface DecodedBand {
  header: CoverageBandHeader
  values: Float32Array
  codes?: Uint16Array
}

// ── Grids → CoverageHandle, with NO wire format (ADR-0010) ─────────────────────
/** Build a CoverageHandle DIRECTLY from north-up grids + geometry — the
 *  reader→renderer seam (ADR-0010: read the standard the data is already in; never
 *  transcode it into a house blob). Any reader that yields grids (the HDF5 S-100
 *  reader today via `readCoverageFromHdf5`, a COG reader later) feeds the coverage
 *  renderer through this, so no wire format appears in the chain. nodata cells map to
 *  NaN (the runtime's only nodata test); min/max are computed over valid cells (the
 *  GPU-normalize window). */
export function coverageFromGrids(input: CoverageInput): CoverageHandle {
  const [nLon, nLat] = input.size
  const expected = nLon * nLat
  const bands: DecodedBand[] = []
  for (const band of input.bands) {
    if (band.values.length !== expected)
      throw new Error(
        `[coverage] band "${band.name}" has ${band.values.length} cells, expected ${expected}`,
      )
    const { min, max } = validRange(band.values, band.nodata)
    const values = new Float32Array(band.values.length)
    for (let i = 0; i < band.values.length; i++) {
      const v = band.values[i]!
      values[i] = v === band.nodata || Number.isNaN(v) ? NaN : v
    }
    // In-memory handle holds f32 values directly — no quantization, so no `codes`.
    const header: CoverageBandHeader = {
      name: band.name,
      unit: band.unit,
      kind: 'f32',
      nodata: band.nodata,
      min,
      max,
    }
    bands.push({ header, values })
  }
  const header: CoverageHeader = {
    product: input.product,
    crs: 'EPSG:4326',
    origin: input.origin,
    spacing: input.spacing,
    size: input.size,
    registration: 'point',
    bands: bands.map((b) => b.header),
    vertical: input.vertical,
    time: null,
    ...(input.sourceMeta ? { sourceMeta: input.sourceMeta } : {}),
  }
  return new CoverageHandle(header, bands)
}

// ── CoverageHandle — CPU-resident authority for exact value readout ───────────
export class CoverageHandle {
  constructor(
    readonly header: CoverageHeader,
    readonly bands: DecodedBand[],
  ) {}

  get meta(): CoverageHeader {
    return this.header
  }

  band(nameOrIndex: string | number = 0): DecodedBand {
    const b = typeof nameOrIndex === 'number' ? this.bands[nameOrIndex] : this.bands.find((x) => x.header.name === nameOrIndex)
    if (!b) throw new Error(`[coverage] no band "${nameOrIndex}"`)
    return b
  }

  /** Nearest-cell value at (lonDeg, latDeg) — point registration, NOT bilinear (A5).
   *  Returns null outside the grid bounds, NaN for a nodata cell, else the verbatim
   *  (positive-down for S-102) value. Index math is pinned by the asymmetric-grid
   *  test: north-up storage ⇒ idx = (nLat−1−rowS)·nLon + col. */
  valueAt(lonDeg: number, latDeg: number, bandIndex: string | number = 0): number | null {
    const { origin, spacing, size } = this.header
    const [nLon, nLat] = size
    const col = Math.round((lonDeg - origin[0]) / spacing[0])
    const rowS = Math.round((latDeg - origin[1]) / spacing[1])
    if (col < 0 || col >= nLon || rowS < 0 || rowS >= nLat) return null
    const idx = (nLat - 1 - rowS) * nLon + col
    return this.band(bandIndex).values[idx]!
  }
}

// ── South-first → north-up flip (the converter's single orientation normalize) ─
/** Flip a SOUTH-ROW-FIRST grid (reader storage order, row 0 = south) to the
 *  NORTH-UP order the CoverageHandle holds (row 0 = north). The ONE place orientation
 *  is normalized; the fail-first south-flip gate points at BOTH this and the identity. */
export function southFirstToNorthUp(southFirst: Float32Array, nLon: number, nLat: number): Float32Array {
  const out = new Float32Array(southFirst.length)
  for (let r = 0; r < nLat; r++) {
    const src = r * nLon
    const dst = (nLat - 1 - r) * nLon
    out.set(southFirst.subarray(src, src + nLon), dst)
  }
  return out
}
