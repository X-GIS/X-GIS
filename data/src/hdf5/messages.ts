// ═══ HDF5 subset reader — typed message parsers ═══
//
// Decodes the specific object-header messages the S-100 path needs: dataspace,
// data layout, fill value, filter pipeline, links (compact + symbol-table),
// link/attribute-info (dense-storage detectors), and attributes. Each parser
// seeks to a message body span (from object-header.ts) and returns a typed value;
// out-of-subset constructs throw with the file offset.

import { Cursor, Hdf5Error, UNDEFINED_ADDR, decodeFixedString } from './bytes'
import { parseDatatype, type Datatype } from './datatype'

// ── Dataspace (0x01) → dimension sizes ───────────────────────────────────────
export function parseDataspace(c: Cursor, start: number): number[] {
  c.seek(start)
  const version = c.u8()
  const rank = c.u8()
  c.u8() // flags
  if (version === 1)
    c.skip(1 + 4) // reserved(1) + reserved(4)
  else if (version === 2)
    c.u8() // type (scalar/simple/null)
  else throw new Hdf5Error(`dataspace message version ${version} unsupported`, start)
  const dims: number[] = []
  for (let i = 0; i < rank; i++) dims.push(c.length())
  return dims
}

// ── Data layout (0x08) ───────────────────────────────────────────────────────
export type Layout =
  | { kind: 'contiguous'; address: number; size: number }
  | { kind: 'chunked'; btreeAddress: number; chunkDims: number[]; elementSize: number }

export function parseLayout(c: Cursor, start: number): Layout {
  c.seek(start)
  const version = c.u8()
  if (version === 1 || version === 2) return parseLayoutV1V2(c, start, version)
  if (version === 4)
    throw new Hdf5Error(
      'data layout version 4 (implicit / fixed-array / extensible-array / v2-btree ' +
        'chunk index) — INC-A supports the v1-btree chunk index only',
      start,
    )
  if (version !== 3) throw new Hdf5Error(`data layout version ${version} unsupported`, start)
  const cls = c.u8()
  if (cls === 0)
    throw new Hdf5Error('compact data layout (class 0) — outside the INC-A subset', start)
  if (cls === 1) {
    const address = c.offset()
    const size = c.length()
    return { kind: 'contiguous', address, size }
  }
  if (cls === 2) {
    const rank = c.u8() // includes the trailing element-size dimension
    const btreeAddress = c.offset()
    const dims: number[] = []
    for (let i = 0; i < rank; i++) dims.push(c.u32())
    const elementSize = dims.pop()! // last dim = datatype element size
    return { kind: 'chunked', btreeAddress, chunkDims: dims, elementSize }
  }
  throw new Hdf5Error(`data layout class ${cls} unsupported`, start)
}

function parseLayoutV1V2(c: Cursor, start: number, version: number): Layout {
  // version(1) already read. dimensionality(1), class(1), reserved(1+4)
  const rank = c.u8()
  const cls = c.u8()
  c.skip(1 + 4)
  if (cls === 0)
    throw new Hdf5Error('compact data layout (class 0) — outside the INC-A subset', start)
  const address = c.offset()
  const dims: number[] = []
  for (let i = 0; i < rank; i++) dims.push(c.u32())
  if (cls === 1) {
    // contiguous: dims are the dataset dims; size = product · elementSize (elementSize
    // is not in this message for v1/v2 — the caller derives size from dataspace·dtype).
    void version
    return { kind: 'contiguous', address, size: -1 }
  }
  // chunked v1/v2: dims include the element-size trailing dimension
  const elementSize = dims.pop()!
  return { kind: 'chunked', btreeAddress: address, chunkDims: dims, elementSize }
}

// ── Fill value (0x04 old / 0x05 new) → raw element bytes (null = undefined) ────
export function parseFillValue(c: Cursor, start: number, isOld: boolean): Uint8Array | null {
  c.seek(start)
  if (isOld) {
    const size = c.u32()
    return size > 0 ? c.bytes(size) : null
  }
  const version = c.u8()
  if (version === 1 || version === 2) {
    c.u8() // space allocation time
    c.u8() // fill time
    const defined = c.u8()
    // Size + Fill Value are ALWAYS present for v1; for v2 they are present only when
    // the fill value is defined (HDF5 spec: absent iff Version > 1 AND Defined == 0).
    // The old code dropped a defined v1 fill, so a sparse chunk decoded to 0 instead of
    // the 1e6 nodata sentinel — silent corruption on navigation data (design risk #1).
    if (version === 2 && !defined) return null
    const size = c.u32()
    return size > 0 ? c.bytes(size) : null
  }
  // version 3: flags byte, bit 5 = value defined
  const flags = c.u8()
  if (!(flags & 0x20)) return null
  const size = c.u32()
  return size > 0 ? c.bytes(size) : null
}

// ── Filter pipeline (0x0B) ───────────────────────────────────────────────────
export interface FilterSpec {
  id: number
  clientData: number[]
}
const FILTER_NAME: Record<number, string> = {
  3: 'fletcher32',
  4: 'szip',
  5: 'nbit',
  6: 'scaleoffset',
}
export function parseFilterPipeline(c: Cursor, start: number): FilterSpec[] {
  c.seek(start)
  const version = c.u8()
  const num = c.u8()
  if (version === 1)
    c.skip(2 + 4) // reserved
  else if (version !== 2)
    throw new Hdf5Error(`filter pipeline version ${version} unsupported`, start)
  const filters: FilterSpec[] = []
  for (let i = 0; i < num; i++) {
    const id = c.u16()
    let nameLen = 0
    if (version === 1 || id >= 256) nameLen = c.u16()
    c.u16() // flags
    const numClient = c.u16()
    if (nameLen > 0) {
      const pad = version === 1 ? Math.ceil(nameLen / 8) * 8 : nameLen
      c.skip(pad)
    }
    const clientData: number[] = []
    for (let k = 0; k < numClient; k++) clientData.push(c.u32())
    if (version === 1 && numClient % 2 === 1) c.skip(4) // v1 pads client data to 8-byte multiple
    if (id !== 1 && id !== 2)
      throw new Hdf5Error(
        `filter id ${id} (${FILTER_NAME[id] ?? 'unknown'}) — INC-A supports deflate(1) + shuffle(2) only`,
        start,
      )
    filters.push({ id, clientData })
  }
  return filters
}

// ── Symbol table (0x11) → group b-tree + local heap ──────────────────────────
export interface SymbolTableMsg {
  btreeAddress: number
  localHeapAddress: number
}
export function parseSymbolTable(c: Cursor, start: number): SymbolTableMsg {
  c.seek(start)
  return { btreeAddress: c.offset(), localHeapAddress: c.offset() }
}

// ── Link (0x06) → one compact hard link (name → object header address) ────────
export interface LinkMsg {
  name: string
  targetAddress: number
}
export function parseLink(c: Cursor, start: number): LinkMsg | null {
  c.seek(start)
  const version = c.u8()
  if (version !== 1) throw new Hdf5Error(`link message version ${version} unsupported`, start)
  const flags = c.u8()
  let linkType = 0
  if (flags & 0x08) linkType = c.u8()
  if (flags & 0x04) c.skip(8) // creation order
  if (flags & 0x10) c.u8() // link-name charset
  const lenSize = 1 << (flags & 0x03)
  const nameLen = c.uint(lenSize)
  const name = new TextDecoder().decode(c.bytes(nameLen))
  if (linkType !== 0) {
    // soft / external / user-defined link — carried but unresolved (not in the
    // S-100 grid path); return null so the group walk skips it.
    return null
  }
  const targetAddress = c.offset()
  return { name, targetAddress }
}

// ── Link info (0x02) — detect DENSE link storage (fractal heap) → error ───────
export function parseLinkInfoDenseGuard(c: Cursor, start: number): void {
  c.seek(start)
  c.u8() // version
  const flags = c.u8()
  if (flags & 0x01) c.skip(8) // max creation index
  const fractalHeapAddr = c.offset()
  if (fractalHeapAddr !== UNDEFINED_ADDR)
    throw new Hdf5Error(
      'dense link storage (fractal heap) — INC-A supports symbol-table + compact-link groups only',
      start,
    )
}

// ── Attribute info (0x15) — detect DENSE attribute storage → error ────────────
export function parseAttributeInfoDenseGuard(c: Cursor, start: number): void {
  c.seek(start)
  c.u8() // version
  const flags = c.u8()
  if (flags & 0x01) c.skip(2) // max creation index
  const fractalHeapAddr = c.offset()
  if (fractalHeapAddr !== UNDEFINED_ADDR)
    throw new Hdf5Error(
      'dense attribute storage (fractal heap) — INC-A supports compact attribute messages only',
      start,
    )
}

// ── Attribute (0x0C) → name + decoded scalar/array value ──────────────────────
export interface AttributeMsg {
  name: string
  datatype: Datatype
  dims: number[]
  value: AttrValue
}
export type AttrValue = number | string | number[] | string[]

export function parseAttribute(c: Cursor, start: number): AttributeMsg {
  c.seek(start)
  const version = c.u8()
  let nameSize: number
  let dtSize: number
  let dsSize: number
  let padded: boolean
  if (version === 1) {
    c.u8() // reserved
    nameSize = c.u16()
    dtSize = c.u16()
    dsSize = c.u16()
    padded = true
  } else if (version === 2 || version === 3) {
    // flags bit 0 = shared datatype, bit 1 = shared dataspace: the following field is
    // then a Shared Message reference, not an inline message. Outside the INC-A subset —
    // a loud error (mirrors the object-header FLAG_SHARED rejection) rather than parsing
    // the shared-ref bytes as an inline datatype/dataspace and silently mis-decoding.
    const flags = c.u8()
    if (flags & 0x03)
      throw new Hdf5Error('shared attribute datatype/dataspace — outside the INC-A subset', start)
    nameSize = c.u16()
    dtSize = c.u16()
    dsSize = c.u16()
    if (version === 3) c.u8() // name character-set encoding
    padded = false
  } else {
    throw new Hdf5Error(`attribute message version ${version} unsupported`, start)
  }
  // v1 pads each of name / datatype / dataspace up to an 8-byte multiple; v2/v3
  // pack them. Compute every field START from the sizes (parseDatatype leaves the
  // cursor at the UNPADDED datatype end, so the next field's start must NOT be
  // read off c.pos — that was the alignment bug).
  const pad = (n: number): number => (padded ? Math.ceil(n / 8) * 8 : n)
  const nameStart = c.pos
  const dtStart = nameStart + pad(nameSize)
  const dsStart = dtStart + pad(dtSize)
  const dataStart = dsStart + pad(dsSize)
  const name = decodeFixedString(c.sliceAt(nameStart, nameSize))
  const datatype = parseDatatype(c, dtStart)
  const dims = parseDataspace(c, dsStart)
  c.seek(dataStart)
  const count = dims.reduce((a, b) => a * b, 1)
  const value = decodeAttrValue(c, datatype, count)
  return { name, datatype, dims, value }
}

/** Read one object from a global heap collection ("GCOL") by index — backs the
 *  vlen-string attribute decode (h5py stores `str` attributes as vlen strings). */
function readGlobalHeapObject(c: Cursor, heapAddr: number, index: number): Uint8Array {
  c.seek(heapAddr)
  c.signature('GCOL', 'global heap collection')
  c.u8() // version
  c.skip(3) // reserved
  const collectionSize = c.length()
  const end = heapAddr + collectionSize
  while (c.pos + 8 <= end) {
    const objIndex = c.u16()
    c.u16() // reference count
    c.skip(4) // reserved
    const objSize = c.length()
    if (objIndex === 0) break // free-space terminator
    const dataStart = c.pos
    if (objIndex === index) return c.bytes(objSize)
    c.seek(dataStart + Math.ceil(objSize / 8) * 8)
  }
  throw new Hdf5Error(`global-heap object index ${index} not found`, heapAddr)
}

function decodeAttrValue(c: Cursor, dt: Datatype, count: number): AttrValue {
  const readInt = (size: number, signed: boolean): number => {
    // little-endian (the metadata corpus is LE); bypasses the uint() 0xFF sentinel.
    // Read the resident bytes into a fresh view (offset 0), then advance past them.
    const raw = c.sliceAt(c.pos, size)
    c.skip(size)
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    if (signed) {
      if (size === 1) return dv.getInt8(0)
      if (size === 2) return dv.getInt16(0, true)
      if (size === 4) return dv.getInt32(0, true)
      return dv.getInt32(4, true) * 0x1_0000_0000 + dv.getUint32(0, true)
    }
    if (size === 1) return dv.getUint8(0)
    if (size === 2) return dv.getUint16(0, true)
    if (size === 4) return dv.getUint32(0, true)
    return dv.getUint32(4, true) * 0x1_0000_0000 + dv.getUint32(0, true)
  }
  const one = (): number | string => {
    switch (dt.kind) {
      case 'int':
        // Endianness is recorded structurally but the decode path is LE-only (readInt /
        // c.f32 / c.f64). A big-endian attribute would silently mis-decode (e.g. a wrong
        // gridOriginLongitude → wrong georeferencing), so fail loudly (A1) — the grid
        // band path already rejects big-endian; metadata attributes must too.
        if (!dt.le)
          throw new Hdf5Error('big-endian integer attribute — outside the INC-A subset', c.pos)
        return readInt(dt.size, dt.signed)
      case 'float':
        if (!dt.le)
          throw new Hdf5Error('big-endian float attribute — outside the INC-A subset', c.pos)
        return dt.size === 4 ? c.f32() : c.f64()
      case 'enum':
        if ((dt.base.kind === 'int' || dt.base.kind === 'float') && !dt.base.le)
          throw new Hdf5Error('big-endian enum attribute — outside the INC-A subset', c.pos)
        return readInt(dt.base.size, dt.base.kind === 'int' && dt.base.signed)
      case 'string':
        return decodeFixedString(c.bytes(dt.size))
      case 'vlen': {
        // on-disk element = length(4) + collection address(O) + object index(4)
        const length = c.u32()
        const heapAddr = c.offset()
        const index = c.u32()
        if (!dt.isString)
          throw new Hdf5Error('vlen-sequence attribute unsupported (only vlen string)', c.pos)
        const save = c.pos
        const bytes = readGlobalHeapObject(c, heapAddr, index)
        c.seek(save)
        return decodeFixedString(bytes.subarray(0, length))
      }
      default:
        throw new Hdf5Error(`attribute of ${(dt as Datatype).kind} datatype unsupported`, c.pos)
    }
  }
  if (count <= 1) return one() as number | string
  const arr: (number | string)[] = []
  for (let i = 0; i < count; i++) arr.push(one())
  return (typeof arr[0] === 'string' ? (arr as string[]) : (arr as number[])) as AttrValue
}
