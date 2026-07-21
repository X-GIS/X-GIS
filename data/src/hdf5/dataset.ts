// ═══ HDF5 subset reader — dataset values (contiguous + v1-btree chunked) ═══
//
// Reads a dataset's raw element bytes in STORAGE ORDER (row-major, exactly as
// h5py returns them — the reader has no orientation concept; `readCoverageFromHdf5`
// owns the north-up flip), then decodes a band into a typed array. The three silent-
// corruption hotspots the design flags (§8.1) live here and are each pinned by a
// fixture: partial edge chunks, missing-chunk fill-in, and compound member offsets.

import { Cursor, Hdf5Error, decodeFixedString } from './bytes'
import type { DatasetInfo } from './groups'
import { walkChunkBtree } from './btree-v1'
import { decodeChunk } from './filters'
import type { Datatype } from './datatype'

/** Raw element bytes of a dataset, storage order, one contiguous buffer. */
export async function readRawElements(c: Cursor, info: DatasetInfo): Promise<Uint8Array> {
  const { dims, datatype, layout, fillValue } = info
  const itemSize = datatype.size
  const nElements = dims.reduce((a, b) => a * b, 1)
  const total = nElements * itemSize

  if (layout.kind === 'contiguous') {
    if (layout.address < 0) return fillBuffer(total, itemSize, fillValue) // unallocated → all fill
    const size = layout.size >= 0 ? layout.size : total
    const take = Math.min(size, total)
    await c.ensure(layout.address, take)
    c.seek(layout.address)
    const raw = c.bytes(take)
    if (raw.length === total) return raw
    const out = fillBuffer(total, itemSize, fillValue)
    out.set(raw.subarray(0, total))
    return out
  }

  // chunked — start from a fill-filled buffer so missing chunks read as fill (A1).
  const out = fillBuffer(total, itemSize, fillValue)
  if (layout.btreeAddress < 0) return out
  const chunkDims = layout.chunkDims
  if (chunkDims.length !== dims.length)
    throw new Hdf5Error(
      `chunk rank ${chunkDims.length} ≠ dataset rank ${dims.length}`,
      layout.btreeAddress,
    )
  const records = await walkChunkBtree(c, layout.btreeAddress, dims.length)
  // row-major strides (elements) for the dataset
  const strides = rowMajorStrides(dims)
  const chunkStrides = rowMajorStrides(chunkDims)
  const chunkElems = chunkDims.reduce((a, b) => a * b, 1)
  for (const rec of records) {
    // Fetch ONLY this chunk's bytes (a range reader's selective read; ADR-0010 §4).
    await c.ensure(rec.address, rec.size)
    c.seek(rec.address)
    const rawChunk = c.bytes(rec.size)
    const chunkBytes = await decodeChunk(rawChunk, info.filters, rec.filterMask, itemSize)
    // A chunk stores the FULL (padded) chunk shape; a short decode = a corrupt chunk
    // length. copyChunk would otherwise write a PARTIAL element at the boundary (mixing
    // real + fill bytes into one f32) and silently leave the rest as fill — loud error (A1).
    if (chunkBytes.length < chunkElems * itemSize)
      throw new Hdf5Error(
        `chunk at 0x${rec.address.toString(16)} decoded to ${chunkBytes.length} B, ` +
          `need ${chunkElems * itemSize} (${chunkElems} elems × ${itemSize} B)`,
        rec.address,
      )
    copyChunk(chunkBytes, out, rec.offsets, chunkDims, dims, strides, chunkStrides, itemSize)
  }
  return out
}

function fillBuffer(total: number, itemSize: number, fill: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(total)
  if (fill && fill.length >= itemSize) {
    // repeat the element-sized fill pattern (spec default 0 when undefined → the
    // zero-init above already satisfies it).
    for (let o = 0; o < total; o += itemSize) out.set(fill.subarray(0, itemSize), o)
  }
  return out
}

function rowMajorStrides(dims: number[]): number[] {
  const s = new Array(dims.length).fill(1)
  for (let i = dims.length - 2; i >= 0; i--) s[i] = s[i + 1]! * dims[i + 1]!
  return s
}

/** Copy one chunk's valid (in-bounds) elements into the dataset buffer. Partial
 *  edge chunks store the FULL chunk shape (padded); out-of-range elements are
 *  skipped so the padding never lands in the output. */
function copyChunk(
  chunk: Uint8Array,
  out: Uint8Array,
  origin: number[],
  chunkDims: number[],
  dims: number[],
  strides: number[],
  chunkStrides: number[],
  itemSize: number,
): void {
  const rank = dims.length
  const idx = new Array(rank).fill(0)
  const nChunkElems = chunkDims.reduce((a, b) => a * b, 1)
  for (let ce = 0; ce < nChunkElems; ce++) {
    // multi-index of this chunk element
    let rem = ce
    let inBounds = true
    let outLinear = 0
    for (let d = 0; d < rank; d++) {
      const k = Math.floor(rem / chunkStrides[d]!)
      rem -= k * chunkStrides[d]!
      const g = origin[d]! + k
      if (g >= dims[d]!) {
        inBounds = false
        break
      }
      outLinear += g * strides[d]!
      idx[d] = k
    }
    if (!inBounds) continue
    out.set(chunk.subarray(ce * itemSize, ce * itemSize + itemSize), outLinear * itemSize)
  }
}

// ── Band decoding ─────────────────────────────────────────────────────────────
export type BandValues = Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array

/** Decode a compound member (by name) OR the whole atomic dataset into a typed
 *  array of length product(dims). Member offset is read from the datatype, never
 *  assumed packed. */
export function decodeBand(raw: Uint8Array, info: DatasetInfo, memberName?: string): BandValues {
  const { datatype } = info
  const nElements = raw.length / datatype.size
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  if (datatype.kind === 'vlen')
    throw new Hdf5Error(
      'variable-length (vlen, class 9) grid band — a coverage grid must be a numeric ' +
        'datatype; vlen is outside the INC-A subset',
    )
  if (datatype.kind === 'compound') {
    if (!memberName) throw new Hdf5Error('compound dataset requires a member name to decode a band')
    const member = datatype.members.find((m) => m.name === memberName)
    if (!member)
      throw new Hdf5Error(
        `compound member "${memberName}" not found (have: ${datatype.members.map((m) => m.name).join(', ')})`,
      )
    if (member.type.kind === 'vlen')
      throw new Hdf5Error(
        `compound member "${memberName}" is vlen (class 9) — outside the INC-A subset`,
      )
    return readMember(view, nElements, datatype.size, member.offset, member.type)
  }
  return readMember(view, nElements, datatype.size, 0, datatype)
}

function readMember(
  view: DataView,
  n: number,
  stride: number,
  offset: number,
  dt: Datatype,
): BandValues {
  const base = dt.kind === 'enum' ? dt.base : dt
  // A1 grid-band policy: little-endian + unsigned only. Big-endian / signed grids
  // are hard errors here (metadata attributes may still be signed — that path is
  // separate). neg_bigendian ('>f4') trips the float branch below.
  if (base.kind === 'float') {
    if (!base.le) throw new Hdf5Error('big-endian float grid band — INC-A is little-endian only')
    if (base.size === 4) {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * stride + offset, true)
      return out
    }
    if (base.size === 8) {
      const out = new Float64Array(n)
      for (let i = 0; i < n; i++) out[i] = view.getFloat64(i * stride + offset, true)
      return out
    }
    throw new Hdf5Error(`IEEE float grid band of ${base.size} bytes — INC-A supports f32/f64`)
  }
  if (base.kind === 'int') {
    if (!base.le)
      throw new Hdf5Error('big-endian fixed-point grid band — INC-A is little-endian only')
    if (base.signed)
      throw new Hdf5Error('signed fixed-point grid band — INC-A supports unsigned u8/u16/u32')
    if (base.size === 1) {
      const out = new Uint8Array(n)
      for (let i = 0; i < n; i++) out[i] = view.getUint8(i * stride + offset)
      return out
    }
    if (base.size === 2) {
      const out = new Uint16Array(n)
      for (let i = 0; i < n; i++) out[i] = view.getUint16(i * stride + offset, true)
      return out
    }
    if (base.size === 4) {
      const out = new Uint32Array(n)
      for (let i = 0; i < n; i++) out[i] = view.getUint32(i * stride + offset, true)
      return out
    }
    throw new Hdf5Error(
      `unsigned fixed-point grid band of ${base.size} bytes — INC-A supports u8/u16/u32`,
    )
  }
  throw new Hdf5Error(`cannot decode grid band of ${base.kind} datatype`)
}

/** Decode a compound of FIXED strings (Group_F band table) → rows of string
 *  fields. Used only by the S-102 metadata read; the grid path never hits it. */
export function decodeStringTable(raw: Uint8Array, info: DatasetInfo): Record<string, string>[] {
  const { datatype } = info
  if (datatype.kind !== 'compound') throw new Hdf5Error('string table expected a compound datatype')
  const n = raw.length / datatype.size
  const rows: Record<string, string>[] = []
  for (let i = 0; i < n; i++) {
    const row: Record<string, string> = {}
    for (const m of datatype.members) {
      if (m.type.kind !== 'string')
        throw new Hdf5Error(`Group_F member "${m.name}" is ${m.type.kind}, expected fixed string`)
      const start = i * datatype.size + m.offset
      row[m.name] = decodeFixedString(raw.subarray(start, start + m.type.size))
    }
    rows.push(row)
  }
  return rows
}
