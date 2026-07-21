// ═══ In-house zero-dep HDF5 subset reader — public API (#1158 GAP-1 INC-A) ═══
//
// A pure `DataView` reader for the exact HDF5 subset real S-100 (S-102/104/111)
// files use (design §3.3 / A1) — read IN PLACE in the browser (ADR-0010) via
// `readCoverageFromHdf5` (coverage.ts). Zero-dep by construction so it runs on the
// main thread or a worker unchanged (the `.odb` both-ends discipline).
// NO npm/WASM HDF5, ever; h5py/GDAL are offline ORACLES only. Every out-of-subset
// construct fails LOUDLY with the construct name + file offset — a silent
// mis-parse of navigation-adjacent data is the one unacceptable outcome.

import { Cursor, BufferReader, type ByteReader } from './bytes'
import { RangeReader, type RangeReaderOptions } from './range-reader'
import { parseSuperblock, type Superblock } from './superblock'
import { readNode, resolvePath, type Hdf5Node } from './groups'
import { readRawElements, decodeBand, decodeStringTable, type BandValues } from './dataset'

export { Hdf5Error, BufferReader } from './bytes'
export type { ByteReader } from './bytes'
export { RangeReader } from './range-reader'
export type { RangeReaderOptions } from './range-reader'
export type { Hdf5Node, AttrValue } from './groups'
export type { Datatype } from './datatype'
export type { BandValues } from './dataset'

export interface DecodedBand {
  values: BandValues
  /** Dimension sizes in storage order (row-major), e.g. [nLat, nLon]. */
  dims: number[]
}

export class Hdf5File {
  readonly cursor: Cursor
  /** Set by `init()` (the superblock needs an async `ensure` first). */
  superblock!: Superblock

  constructor(reader: ByteReader) {
    this.cursor = new Cursor(reader)
  }

  /** Ensure the superblock prefix is resident and parse it. Called by the `openHdf5*`
   *  factories; separated so the ctor stays synchronous. */
  async init(): Promise<this> {
    // The superblock sits at byte 0 (or a power-of-2 boundary for userblock'd files —
    // out of subset). One prefix fetch covers the search + the superblock fields.
    await this.cursor.ensure(0, Math.min(8192, this.cursor.byteLength))
    this.superblock = parseSuperblock(this.cursor)
    return this
  }

  async root(): Promise<Hdf5Node> {
    return readNode(this.cursor, this.superblock.rootObjectHeaderAddr)
  }

  /** Resolve a "/"-separated path to an object node (group or dataset). */
  async get(path: string): Promise<Hdf5Node> {
    return resolvePath(this.cursor, this.superblock.rootObjectHeaderAddr, path)
  }

  /** Decode a dataset band. `memberName` selects a compound member (e.g. 'depth');
   *  omit it for an atomic dataset. Async — the b-tree walk + chunk fetch + deflate. */
  async readBand(path: string, memberName?: string): Promise<DecodedBand> {
    const node = await this.get(path)
    const info = node.asDataset()
    const raw = await readRawElements(this.cursor, info)
    return { values: decodeBand(raw, info, memberName), dims: info.dims }
  }

  /** Decode a compound-of-fixed-strings dataset (the Group_F band table) → rows. */
  async readStringTable(path: string): Promise<Record<string, string>[]> {
    const node = await this.get(path)
    const info = node.asDataset()
    const raw = await readRawElements(this.cursor, info)
    return decodeStringTable(raw, info)
  }
}

/** Parse an HDF5 file from a whole in-memory buffer (the local / whole-file path).
 *  Throws `Hdf5Error` on any out-of-subset construct (naming it + the file offset). */
export async function openHdf5(buf: ArrayBuffer | Uint8Array): Promise<Hdf5File> {
  return new Hdf5File(new BufferReader(buf)).init()
}

/** Parse an HDF5 file from an async `ByteReader` — the range-streaming path (ADR-0010
 *  increment 4): metadata + only the chunks a read touches are fetched, not the whole
 *  file. Pass a `RangeReader` (HTTP Range) for a remote cell. */
export async function openHdf5Range(reader: ByteReader): Promise<Hdf5File> {
  return new Hdf5File(reader).init()
}

/** Open a remote HDF5 cell over HTTP range requests — the ergonomic range entry
 *  (`openHdf5Range` + a `RangeReader`). Only the metadata + touched chunks are fetched.
 *  CORS applies: point `url` at your range-capable proxy/mirror, not a CORS-blocked
 *  NOAA bucket (recipes doc). */
export async function openHdf5Url(url: string, opts?: RangeReaderOptions): Promise<Hdf5File> {
  return openHdf5Range(await RangeReader.open(url, opts))
}
