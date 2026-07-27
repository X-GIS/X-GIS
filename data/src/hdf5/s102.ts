// ═══ S-100 semantic layer over the HDF5 subset reader (S-102 DCF2, INC-A) ═══
//
// Turns a raw HDF5 file into a normalized gridded coverage: locate the DCF2
// feature container (S-102 = BathymetryCoverage), read its grid geometry from the
// feature-instance attributes (case-tolerant per [FR] §7.10), decode the
// compound `values` bands (depth positive-down, uncertainty), and read the S-100
// fill value + band units from the Group_F band table. Values stay SOUTH-ROW-FIRST
// (storage order, as h5py returns them) — `readCoverageFromHdf5` (coverage.ts) owns
// the single north-up flip. Product knowledge lives ONLY here (design §4); @xgis/map
// stays product-blind.

import { Hdf5File, type AttrValue, type ChunkRegion } from './index'
import { Hdf5Error } from './bytes'

export type Product = 's102' | 's104' | 's111' | 'generic'

/** A geographic read window [west, south, east, north] in degrees (EPSG:4326). */
export type Bbox = readonly [number, number, number, number]

/** The sub-region a `bbox` read actually fetched. The returned grid keeps its FULL
 *  geometry (origin/spacing/numPoints are the cell's, never the window's) — only the
 *  cells inside the window carry data; everything else stays the fill value, so a
 *  consumer must treat outside-the-window as nodata, NOT as "no seabed here". */
export interface CoverageWindow {
  /** Row range in STORAGE order (south-row-first), matching `values` dim 0. */
  rowStart: number
  rowCount: number
  /** Column range (west→east), matching `values` dim 1. */
  colStart: number
  colCount: number
  /** Envelope of the fetched cell CENTRES [west, south, east, north] in degrees. */
  bounds: [number, number, number, number]
}

export interface CoverageBand {
  name: string
  unit: string
  /** S-100 fill value (the nodata sentinel stored IN the data). */
  fillValue: number
  /** Grid values in STORAGE order (row-major, south-row-first), length nLon·nLat. */
  values: Float32Array
}

/** The forecast TIME axis of a DCF2 cell (S-111 currents / S-104 water level are
 *  hourly time-series; S-102 bathymetry is static). The instance stores `numGRP`
 *  groups `Group_001…Group_NNN`, each a full grid at its own `timePoint`; the reader
 *  decodes ONE group and reports where it sits on the axis so a caller can step hours. */
export interface CoverageTime {
  /** 0-based index of the group decoded (group N → index N−1). */
  index: number
  /** Total forecast groups in the cell (`numGRP`); 1 for a static S-102 cell. */
  count: number
  /** ISO-8601 valid-time of the decoded group (its `timePoint`), or null if absent. */
  valueISO: string | null
  /** ISO-8601 valid-time of the FIRST group (`dateTimeOfFirstRecord`), or null. */
  firstISO: string | null
  /** Seconds between consecutive groups (`timeRecordInterval`); 0 if single/absent. */
  intervalSeconds: number
}

export interface S100Coverage {
  product: Product
  /** EPSG code of the horizontal CRS (4326 for the geographic S-102 profile). */
  horizontalCRS: number | null
  /** SW cell CENTRE [lon, lat] (registration: point). */
  gridOrigin: [number, number]
  /** [dLon, dLat] cell spacing (degrees for EPSG:4326). */
  gridSpacing: [number, number]
  /** [nLon, nLat] grid size in cells. */
  numPoints: [number, number]
  bands: CoverageBand[]
  vertical: { datumCode: number | null; sign: 'down' | 'up' }
  /** The forecast group decoded + the full time axis it sits on. */
  time: CoverageTime
  /** The sub-region fetched when `bbox` was given; null for a whole-cell read. */
  window: CoverageWindow | null
  /** Attribute-casing / provenance warnings (surfaced to stderr by the CLI). */
  warnings: string[]
}

/** Read the DCF2 gridded coverage from an S-102 (or S-102-shaped) HDF5 file.
 *  `bbox` (degrees, EPSG:4326) restricts the read to the chunks covering that window —
 *  the viewport-streaming path for a large cell (ADR-0010 #1284-4). */
export async function readS102Coverage(
  file: Hdf5File,
  opts?: { group?: number; bbox?: Bbox },
): Promise<S100Coverage> {
  const warnings: string[] = []
  const warn = (m: string): void => {
    warnings.push(m)
  }
  const root = await file.root()
  const product = detectProduct(String(root.attr('productSpecification', warn) ?? ''))
  const horizontalCRS = numAttr(root.attr('horizontalCRS', warn))

  // Locate the DCF2 feature container (BathymetryCoverage) — product-agnostic:
  // the first root-child group whose dataCodingFormat attribute is 2.
  let containerName: string | null = null
  for (const [name] of await root.children()) {
    const node = await file.get(name)
    if (numAttr(node.attr('dataCodingFormat')) === 2) {
      containerName = name
      break
    }
  }
  if (!containerName)
    throw new Hdf5Error('no DCF2 feature container found (S-102 BathymetryCoverage expected)')

  const instancePath = `${containerName}/${containerName}.01`
  const inst = await file.get(instancePath)
  const originLon = reqNum(inst.attr('gridOriginLongitude', warn), 'gridOriginLongitude')
  const originLat = reqNum(inst.attr('gridOriginLatitude', warn), 'gridOriginLatitude')
  const dLon = reqNum(inst.attr('gridSpacingLongitudinal', warn), 'gridSpacingLongitudinal')
  const dLat = reqNum(inst.attr('gridSpacingLatitudinal', warn), 'gridSpacingLatitudinal')
  const nLon = reqNum(inst.attr('numPointsLongitudinal', warn), 'numPointsLongitudinal')
  const nLat = reqNum(inst.attr('numPointsLatitudinal', warn), 'numPointsLatitudinal')

  // Forecast TIME axis: the instance holds `numGRP` groups `Group_001…Group_NNN`, each a
  // full grid at its own `timePoint` (S-111 currents / S-104 water level are hourly time-
  // series; a static S-102 cell has numGRP 1). Decode the requested group (default the
  // first) and report the axis so a caller can step forecast hours. No `warn` on the time
  // attrs — a static S-102 cell legitimately lacks them (absent ≠ mis-cased).
  const numGRP = Math.max(1, Math.trunc(numAttr(inst.attr('numGRP')) ?? 1))
  const group = opts?.group ?? 1
  if (!Number.isInteger(group) || group < 1 || group > numGRP)
    throw new Hdf5Error(`forecast group ${group} out of range [1, ${numGRP}]`)
  const groupName = `Group_${String(group).padStart(3, '0')}`
  const groupNode = await file.get(`${instancePath}/${groupName}`)
  const asISO = (v: AttrValue | undefined): string | null => (v == null ? null : String(v))
  const time: CoverageTime = {
    index: group - 1,
    count: numGRP,
    valueISO: asISO(groupNode.attr('timePoint')),
    firstISO: asISO(inst.attr('dateTimeOfFirstRecord')),
    intervalSeconds: numAttr(inst.attr('timeRecordInterval')) ?? 0,
  }

  // Band table (Group_F/<container>) → fill value + unit per band code. Fixed-length
  // strings only (A1); a vlen band table (real NOAA files) fails loudly here — the
  // grid + geometry are still readable directly (the local real-file differential).
  const bandTable = await readBandTable(file, containerName)

  const valuesPath = `${instancePath}/${groupName}/values`
  const valuesNode = await file.get(valuesPath)
  const info = valuesNode.asDataset()
  if (info.datatype.kind !== 'compound')
    throw new Hdf5Error(`${valuesPath} is not a compound values dataset`)

  // Cross-check the values dataspace dims against the numPoints attributes we trust for
  // grid geometry: storage is row-major [nLat, nLon] (south-row-first). A disagreement
  // (e.g. swapped numPoints that still multiply to the same cell count) would scramble
  // every row through the north-up flip with no length mismatch — a loud error (A1).
  if (info.dims.length !== 2 || info.dims[0] !== nLat || info.dims[1] !== nLon)
    throw new Hdf5Error(
      `values dataspace dims [${info.dims.join(', ')}] disagree with grid attributes ` +
        `[nLat=${nLat}, nLon=${nLon}]`,
    )

  // bbox → the element-index window of the chunks to fetch (ADR-0010 #1284-4). Computed
  // AFTER the dims cross-check so the window can never be derived from geometry the
  // values dataset disagrees with. The returned grid keeps its full size; cells outside
  // the window stay fill (→ NaN downstream), which is what makes this safe to hand to
  // the unchanged renderer.
  const window = opts?.bbox
    ? resolveWindow(opts.bbox, [originLon, originLat], [dLon, dLat], [nLon, nLat])
    : null
  const region: ChunkRegion | undefined = window
    ? { start: [window.rowStart, window.colStart], count: [window.rowCount, window.colCount] }
    : undefined

  const bands: CoverageBand[] = []
  for (const member of info.datatype.members) {
    const decoded = await file.readBand(valuesPath, member.name, region)
    const meta = bandTable.get(member.name.toLowerCase())
    if (!meta)
      warn(
        `band "${member.name}" has no Group_F fill-value entry — nodata defaults to 0, so ` +
          `a 1e6 sentinel would be treated as valid data`,
      )
    const values =
      decoded.values instanceof Float32Array ? decoded.values : Float32Array.from(decoded.values)
    if (window) maskOutsideWindow(values, nLon, nLat, window)
    bands.push({
      name: member.name,
      unit: meta?.unit ?? '',
      fillValue: meta?.fillValue ?? 0,
      values,
    })
  }

  return {
    product,
    horizontalCRS,
    gridOrigin: [originLon, originLat],
    gridSpacing: [dLon, dLat],
    numPoints: [nLon, nLat],
    bands,
    vertical: {
      datumCode: numAttr(root.attr('verticalDatum', warn)),
      // S-102 depth is positive-down; carried verbatim, never silently flipped.
      sign: 'down',
    },
    time,
    window,
    warnings,
  }
}

/** Map a geographic `bbox` onto the cell's element-index window. Registration is POINT
 *  (origin = SW cell CENTRE), so cell i spans ±½ spacing around its centre; the
 *  floor/ceil pair OVER-covers by at most one cell per edge, which is the safe
 *  direction — an over-fetched chunk costs bytes, an under-fetched one loses data.
 *  A bbox that misses the cell entirely is a loud error, not an all-nodata grid. */
function resolveWindow(
  bbox: Bbox,
  origin: readonly [number, number],
  spacing: readonly [number, number],
  size: readonly [number, number],
): CoverageWindow {
  const [west, south, east, north] = bbox
  if (![west, south, east, north].every(Number.isFinite))
    throw new Hdf5Error(`bbox [${bbox.join(', ')}] must be four finite degrees`)
  if (west > east || south > north)
    throw new Hdf5Error(
      `bbox [${bbox.join(', ')}] is inverted — expected [west, south, east, north] ` +
        `(an antimeridian-crossing window needs two reads)`,
    )
  const [dLon, dLat] = spacing
  if (!(dLon > 0) || !(dLat > 0))
    throw new Hdf5Error(`bbox read needs positive grid spacing, got [${dLon}, ${dLat}]`)

  const [nLon, nLat] = size
  const colRaw = spanOf(west, east, origin[0], dLon)
  const rowRaw = spanOf(south, north, origin[1], dLat)
  if (colRaw.hi < 0 || colRaw.lo > nLon - 1 || rowRaw.hi < 0 || rowRaw.lo > nLat - 1)
    throw new Hdf5Error(
      `bbox [${bbox.join(', ')}] does not intersect the cell ` +
        `(origin [${origin.join(', ')}], spacing [${spacing.join(', ')}], size [${nLon}×${nLat}])`,
    )
  const colStart = Math.max(0, colRaw.lo)
  const rowStart = Math.max(0, rowRaw.lo)
  const colCount = Math.min(nLon - 1, colRaw.hi) - colStart + 1
  const rowCount = Math.min(nLat - 1, rowRaw.hi) - rowStart + 1
  return {
    rowStart,
    rowCount,
    colStart,
    colCount,
    bounds: [
      origin[0] + colStart * dLon,
      origin[1] + rowStart * dLat,
      origin[0] + (colStart + colCount - 1) * dLon,
      origin[1] + (rowStart + rowCount - 1) * dLat,
    ],
  }
}

/** Blank every cell OUTSIDE the window to NaN, in place (values are storage order,
 *  south-row-first, dims [nLat, nLon]).
 *
 *  This is load-bearing, not tidiness: a chunk that was never fetched arrives as the
 *  DATASET's HDF5 fill — commonly 0 — which is NOT the S-100 `fillValue` the band table
 *  carries, so the fill→NaN mapping downstream would let it through as a real 0 m
 *  sounding. Marking not-fetched explicitly is the difference between "no data here" and
 *  "a shoal here". Chunks are coarser than the window, so this also discards the slop a
 *  partially-covered chunk brought along, making the contract exact: inside `window` is
 *  fetched, outside is NaN, always. */
function maskOutsideWindow(
  values: Float32Array,
  nLon: number,
  nLat: number,
  w: CoverageWindow,
): void {
  const rowEnd = w.rowStart + w.rowCount
  const colEnd = w.colStart + w.colCount
  for (let r = 0; r < nLat; r++) {
    const base = r * nLon
    if (r < w.rowStart || r >= rowEnd) {
      values.fill(NaN, base, base + nLon)
      continue
    }
    if (w.colStart > 0) values.fill(NaN, base, base + w.colStart)
    if (colEnd < nLon) values.fill(NaN, base + colEnd, base + nLon)
  }
}

/** Unclamped inclusive index span of the cells covering [lo, hi] on one axis. */
function spanOf(lo: number, hi: number, origin: number, step: number): { lo: number; hi: number } {
  return { lo: Math.floor((lo - origin) / step), hi: Math.ceil((hi - origin) / step) }
}

async function readBandTable(
  file: Hdf5File,
  containerName: string,
): Promise<Map<string, { unit: string; fillValue: number }>> {
  const out = new Map<string, { unit: string; fillValue: number }>()
  const rows = await file.readStringTable(`Group_F/${containerName}`)
  for (const row of rows) {
    const code = (row['code'] ?? row['name'] ?? '').toLowerCase()
    if (!code) continue
    out.set(code, {
      unit: row['uom.name'] ?? '',
      fillValue: row['fillValue'] !== undefined ? Number(row['fillValue']) : 0,
    })
  }
  return out
}

function detectProduct(spec: string): Product {
  const s = spec.toUpperCase()
  if (s.includes('S-102')) return 's102'
  if (s.includes('S-104')) return 's104'
  if (s.includes('S-111')) return 's111'
  return 'generic'
}

function numAttr(v: AttrValue | undefined): number | null {
  return typeof v === 'number' ? v : null
}
function reqNum(v: AttrValue | undefined, name: string): number {
  if (typeof v !== 'number') throw new Hdf5Error(`required numeric attribute "${name}" missing`)
  return v
}
