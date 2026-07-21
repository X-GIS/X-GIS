// ═══ .xgcov — X-GIS Coverage binary (S-100 gridded coverage payload) ═══
//
// The X-GIS-native artifact the offline `s100-to-xgcov` converter emits and the
// runtime `coverage` source decodes. North-up, band-planar, deflate-compressed
// float/quantized grids + a JSON header carrying the S-100 metadata (grid
// geometry, vertical-datum code, positive-down flag). Encode + decode live TOGETHER
// (the `.odb` "never drift" rule, `pipeline/src/odb/format.ts`), zero-dep by
// construction — DataView + the platform (De)CompressionStream, no bundled zlib.
//
// ── Layout (little-endian; A2) ─────────────────────────────────────────────
//   bytes 0-3   ASCII "XCOV"  (validated as 4 bytes, not a u32 — no endian ambiguity)
//   u16         version = 1   (decoder rejects any other, loudly)
//   u32         headerLen
//   header      UTF-8 JSON (CoverageHeader)
//   blocks      per (timeslice t, band in header order):
//                 u32 compressedLen + zlib-deflate(RFC1950) of the raw grid,
//                 row-major NORTH-UP (row 0 = northernmost, west→east), f32 LE | u16 LE
//
// u16 quantization: min/max over VALID cells only; scale=(max−min)/65534; code =
// clamp(round((v−min)/scale),0,65534); code 0xFFFF reserved = nodata → decodes to NaN.
// f32 nodata: source fill-value cells are rewritten to the canonical quiet NaN
// 0x7FC00000 at encode (byte-stable round-trips); header `nodata` keeps the ORIGINAL
// source fill (provenance only). The runtime nodata test is ALWAYS Number.isNaN —
// never a float compare against 1e6.

const MAGIC = new Uint8Array([0x58, 0x43, 0x4f, 0x56]) // "XCOV"
export const XGCOV_VERSION = 1
/** u16 quantization span: codes 0..QUANT_MAX map [min,max]; 0xFFFF is reserved nodata.
 *  Exported as the single authority so the GPU packer's `code/QUANT_MAX` normalization
 *  and nodata sentinel cannot drift from this codec (map imports these, not literals). */
export const QUANT_MAX = 65534 // 0xFFFE — 0xFFFF is the nodata code
export const NODATA_CODE = 0xffff
/** Canonical quiet NaN (0x7FC00000) so f32 nodata round-trips byte-stable. */
const CANONICAL_NAN_BITS = 0x7fc00000

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

/** One band's grid for encoding — values are NORTH-UP (row 0 = north), with the
 *  SOURCE fill still present at nodata cells (encode rewrites it). */
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

// ── Deflate / inflate via the platform streams (RFC1950 zlib) ─────────────────
// The write/close rejections are swallowed (.catch): a corrupt/truncated block surfaces
// its error only through the awaited drain() below, and an UNOBSERVED write/close
// rejection is an unhandled promise rejection that terminates the Node process
// (Z_DATA_ERROR) instead of throwing catchably. (Same drain hand-copied in
// pipeline/src/hdf5/filters.ts under the pipeline↔data zero-dep charter — keep in sync.)
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate')
  const w = cs.writable.getWriter()
  void w.write(bytes.slice()).catch(() => {})
  void w.close().catch(() => {})
  return await drain(cs.readable)
}
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const w = ds.writable.getWriter()
  void w.write(bytes.slice()).catch(() => {})
  void w.close().catch(() => {})
  return await drain(ds.readable)
}
async function drain(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

// ── Quantization ──────────────────────────────────────────────────────────────
/** min/max over VALID (non-nodata) cells only. A degenerate/empty range collapses
 *  to [v,v] so scale falls back to 1 (never a divide-by-zero). */
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

function quantizeU16(
  values: Float32Array,
  nodata: number,
  min: number,
  max: number,
): { codes: Uint16Array; scale: number } {
  const scale = max === min ? 1 : (max - min) / QUANT_MAX
  const codes = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (v === nodata || Number.isNaN(v)) {
      codes[i] = NODATA_CODE
      continue
    }
    const code = Math.round((v - min) / scale)
    codes[i] = code < 0 ? 0 : code > QUANT_MAX ? QUANT_MAX : code
  }
  return { codes, scale }
}

/** f32 band bytes: rewrite source-fill cells to the canonical quiet NaN. */
function f32Bytes(values: Float32Array, nodata: number): Uint8Array {
  const out = new Float32Array(values.length)
  const bits = new Uint32Array(out.buffer)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (v === nodata || Number.isNaN(v)) bits[i] = CANONICAL_NAN_BITS
    else out[i] = v
  }
  return new Uint8Array(out.buffer)
}

// ── Encode ────────────────────────────────────────────────────────────────────
export async function encodeCoverage(input: CoverageInput): Promise<ArrayBuffer> {
  const [nLon, nLat] = input.size
  const expected = nLon * nLat
  const headerBands: CoverageBandHeader[] = []
  const blocks: Uint8Array[] = []
  for (const band of input.bands) {
    if (band.values.length !== expected)
      throw new Error(`[.xgcov] band "${band.name}" has ${band.values.length} cells, expected ${expected}`)
    const { min, max } = validRange(band.values, band.nodata)
    let raw: Uint8Array
    const bh: CoverageBandHeader = { name: band.name, unit: band.unit, kind: band.kind, nodata: band.nodata, min, max }
    if (band.kind === 'u16') {
      const { codes, scale } = quantizeU16(band.values, band.nodata, min, max)
      bh.scale = scale
      bh.offset = min
      raw = new Uint8Array(codes.buffer)
    } else {
      raw = f32Bytes(band.values, band.nodata)
    }
    headerBands.push(bh)
    blocks.push(await deflate(raw))
  }

  const header: CoverageHeader = {
    product: input.product,
    crs: 'EPSG:4326',
    origin: input.origin,
    spacing: input.spacing,
    size: input.size,
    registration: 'point',
    bands: headerBands,
    vertical: input.vertical,
    time: null,
    ...(input.sourceMeta ? { sourceMeta: input.sourceMeta } : {}),
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))

  let size = 4 + 2 + 4 + headerBytes.length
  for (const b of blocks) size += 4 + b.length
  const buf = new ArrayBuffer(size)
  const view = new DataView(buf)
  const u8 = new Uint8Array(buf)
  let o = 0
  u8.set(MAGIC, o)
  o += 4
  view.setUint16(o, XGCOV_VERSION, true)
  o += 2
  view.setUint32(o, headerBytes.length, true)
  o += 4
  u8.set(headerBytes, o)
  o += headerBytes.length
  for (const b of blocks) {
    view.setUint32(o, b.length, true)
    o += 4
    u8.set(b, o)
    o += b.length
  }
  return buf
}

// ── Decode ────────────────────────────────────────────────────────────────────
/** A decoded band: dequantized f32 values (NaN at nodata) + the raw u16 codes
 *  (u16 bands only) so the GPU packer can derive s = code/65534 EXACTLY. */
export interface DecodedBand {
  header: CoverageBandHeader
  /** Dequantized values, NaN at nodata cells. North-up, length nLon·nLat. */
  values: Float32Array
  /** Raw quantization codes (u16 bands only) for exact GPU normalization. */
  codes?: Uint16Array
}

export async function decodeCoverage(buf: ArrayBuffer): Promise<CoverageHandle> {
  if (buf.byteLength < 10) throw new Error(`[.xgcov] buffer too small (${buf.byteLength} B)`)
  const view = new DataView(buf)
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < 4; i++)
    if (u8[i] !== MAGIC[i])
      throw new Error(
        `[.xgcov] bad magic "${new TextDecoder().decode(u8.subarray(0, 4))}" (expected "XCOV")`,
      )
  const version = view.getUint16(4, true)
  if (version !== XGCOV_VERSION)
    throw new Error(`[.xgcov] unsupported version ${version} (this build reads v${XGCOV_VERSION})`)
  const headerLen = view.getUint32(6, true)
  let o = 10
  if (o + headerLen > buf.byteLength) throw new Error(`[.xgcov] truncated header (${headerLen} B)`)
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(o, o + headerLen))) as CoverageHeader
  o += headerLen

  const [nLon, nLat] = header.size
  const cells = nLon * nLat
  const bands: DecodedBand[] = []
  for (const bh of header.bands) {
    if (o + 4 > buf.byteLength) throw new Error(`[.xgcov] truncated: missing block length for "${bh.name}"`)
    const clen = view.getUint32(o, true)
    o += 4
    if (o + clen > buf.byteLength)
      throw new Error(`[.xgcov] truncated block for "${bh.name}": need ${clen} B, have ${buf.byteLength - o}`)
    const raw = await inflate(u8.subarray(o, o + clen))
    o += clen
    bands.push(decodeBand(bh, raw, cells))
  }
  return new CoverageHandle(header, bands)
}

// ── Grids → CoverageHandle, with NO wire format (ADR-0010) ─────────────────────
/** Build a CoverageHandle DIRECTLY from north-up grids + geometry — the
 *  reader→renderer seam that replaces the `.xgcov` encode→decode round-trip
 *  (ADR-0010: read the standard the data is already in; never transcode it into a
 *  house blob). Any reader that yields grids (the HDF5 S-100 reader today, a COG
 *  reader later) feeds the coverage renderer through this, so `.xgcov` never appears
 *  in the chain. Equivalent to `encodeCoverage` → `decodeCoverage` at kind:'f32'
 *  (the round-trip-equivalence test pins it), minus the deflate/serialize cost.
 *  nodata cells map to NaN (the runtime's only nodata test); min/max are computed
 *  over valid cells (the same GPU-normalize inputs `decodeCoverage` produces). */
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

function decodeBand(bh: CoverageBandHeader, raw: Uint8Array, cells: number): DecodedBand {
  if (bh.kind === 'u16') {
    if (raw.length < cells * 2)
      throw new Error(`[.xgcov] band "${bh.name}" decoded ${raw.length} B, expected ${cells * 2}`)
    const codes = new Uint16Array(cells)
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    for (let i = 0; i < cells; i++) codes[i] = dv.getUint16(i * 2, true)
    const values = new Float32Array(cells)
    const scale = bh.scale ?? 1
    const offset = bh.offset ?? bh.min
    for (let i = 0; i < cells; i++) values[i] = codes[i] === NODATA_CODE ? NaN : offset + codes[i]! * scale
    return { header: bh, values, codes }
  }
  if (raw.length < cells * 4)
    throw new Error(`[.xgcov] band "${bh.name}" decoded ${raw.length} B, expected ${cells * 4}`)
  const values = new Float32Array(cells)
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  for (let i = 0; i < cells; i++) values[i] = dv.getFloat32(i * 4, true)
  return { header: bh, values }
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
    if (!b) throw new Error(`[.xgcov] no band "${nameOrIndex}"`)
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
 *  NORTH-UP order .xgcov stores (row 0 = north). The ONE place orientation is
 *  normalized; the fail-first south-flip gate points at BOTH this and the identity. */
export function southFirstToNorthUp(southFirst: Float32Array, nLon: number, nLat: number): Float32Array {
  const out = new Float32Array(southFirst.length)
  for (let r = 0; r < nLat; r++) {
    const src = r * nLon
    const dst = (nLat - 1 - r) * nLon
    out.set(southFirst.subarray(src, src + nLon), dst)
  }
  return out
}
