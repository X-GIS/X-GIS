// ═══ S-100 semantic layer over the HDF5 subset reader (S-102 DCF2, INC-A) ═══
//
// Turns a raw HDF5 file into a normalized gridded coverage: locate the DCF2
// feature container (S-102 = BathymetryCoverage), read its grid geometry from the
// feature-instance attributes (case-tolerant per [FR] §7.10), decode the
// compound `values` bands (depth positive-down, uncertainty), and read the S-100
// fill value + band units from the Group_F band table. Values stay SOUTH-ROW-FIRST
// (storage order, as h5py returns them) — the converter owns the single north-up
// flip. Product knowledge lives ONLY here (design §4); @xgis/map stays product-blind.

import { Hdf5File, type AttrValue } from './index'
import { Hdf5Error } from './bytes'

export type Product = 's102' | 's104' | 's111' | 'generic'

export interface CoverageBand {
  name: string
  unit: string
  /** S-100 fill value (the nodata sentinel stored IN the data). */
  fillValue: number
  /** Grid values in STORAGE order (row-major, south-row-first), length nLon·nLat. */
  values: Float32Array
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
  /** Attribute-casing / provenance warnings (surfaced to stderr by the CLI). */
  warnings: string[]
}

/** Read the DCF2 gridded coverage from an S-102 (or S-102-shaped) HDF5 file. */
export async function readS102Coverage(file: Hdf5File): Promise<S100Coverage> {
  const warnings: string[] = []
  const warn = (m: string): void => {
    warnings.push(m)
  }
  const root = file.root()
  const product = detectProduct(String(root.attr('productSpecification', warn) ?? ''))
  const horizontalCRS = numAttr(root.attr('horizontalCRS', warn))

  // Locate the DCF2 feature container (BathymetryCoverage) — product-agnostic:
  // the first root-child group whose dataCodingFormat attribute is 2.
  let containerName: string | null = null
  for (const [name] of root.children()) {
    const node = file.get(name)
    if (numAttr(node.attr('dataCodingFormat')) === 2) {
      containerName = name
      break
    }
  }
  if (!containerName)
    throw new Hdf5Error('no DCF2 feature container found (S-102 BathymetryCoverage expected)')

  const instancePath = `${containerName}/${containerName}.01`
  const inst = file.get(instancePath)
  const originLon = reqNum(inst.attr('gridOriginLongitude', warn), 'gridOriginLongitude')
  const originLat = reqNum(inst.attr('gridOriginLatitude', warn), 'gridOriginLatitude')
  const dLon = reqNum(inst.attr('gridSpacingLongitudinal', warn), 'gridSpacingLongitudinal')
  const dLat = reqNum(inst.attr('gridSpacingLatitudinal', warn), 'gridSpacingLatitudinal')
  const nLon = reqNum(inst.attr('numPointsLongitudinal', warn), 'numPointsLongitudinal')
  const nLat = reqNum(inst.attr('numPointsLatitudinal', warn), 'numPointsLatitudinal')

  // Band table (Group_F/<container>) → fill value + unit per band code. Fixed-length
  // strings only (A1); a vlen band table (real NOAA files) fails loudly here — the
  // grid + geometry are still readable directly (the local real-file differential).
  const bandTable = await readBandTable(file, containerName)

  const valuesPath = `${instancePath}/Group_001/values`
  const valuesNode = file.get(valuesPath)
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

  const bands: CoverageBand[] = []
  for (const member of info.datatype.members) {
    const decoded = await file.readBand(valuesPath, member.name)
    const meta = bandTable.get(member.name.toLowerCase())
    if (!meta)
      warn(
        `band "${member.name}" has no Group_F fill-value entry — nodata defaults to 0, so ` +
          `a 1e6 sentinel would be treated as valid data`,
      )
    if (decoded.values instanceof Float64Array || decoded.values instanceof Float32Array) {
      bands.push({
        name: member.name,
        unit: meta?.unit ?? '',
        fillValue: meta?.fillValue ?? 0,
        values:
          decoded.values instanceof Float32Array
            ? decoded.values
            : Float32Array.from(decoded.values),
      })
    } else {
      bands.push({
        name: member.name,
        unit: meta?.unit ?? '',
        fillValue: meta?.fillValue ?? 0,
        values: Float32Array.from(decoded.values),
      })
    }
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
    warnings,
  }
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
