// ═══ In-house zero-dep HDF5 subset reader — public API (#1158 GAP-1 INC-A) ═══
//
// A pure `DataView` reader for the exact HDF5 subset real S-100 (S-102/104/111)
// files use (design §3.3 / A1) — read IN PLACE in the browser (ADR-0010) via
// `readCoverageFromHdf5` (coverage.ts). Zero-dep by construction so it runs on the
// main thread or a worker unchanged (the `.odb` both-ends discipline).
// NO npm/WASM HDF5, ever; h5py/GDAL are offline ORACLES only. Every out-of-subset
// construct fails LOUDLY with the construct name + file offset — a silent
// mis-parse of navigation-adjacent data is the one unacceptable outcome.

import { Cursor } from './bytes'
import { parseSuperblock, type Superblock } from './superblock'
import { readNode, resolvePath, type Hdf5Node } from './groups'
import { readRawElements, decodeBand, decodeStringTable, type BandValues } from './dataset'

export { Hdf5Error } from './bytes'
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
  readonly superblock: Superblock

  constructor(buf: ArrayBuffer) {
    this.cursor = new Cursor(buf)
    this.superblock = parseSuperblock(this.cursor)
  }

  root(): Hdf5Node {
    return readNode(this.cursor, this.superblock.rootObjectHeaderAddr)
  }

  /** Resolve a "/"-separated path to an object node (group or dataset). */
  get(path: string): Hdf5Node {
    return resolvePath(this.cursor, this.superblock.rootObjectHeaderAddr, path)
  }

  /** Decode a dataset band. `memberName` selects a compound member (e.g. 'depth');
   *  omit it for an atomic dataset. Async — chunked/deflate decode is async. */
  async readBand(path: string, memberName?: string): Promise<DecodedBand> {
    const node = this.get(path)
    const info = node.asDataset()
    const raw = await readRawElements(this.cursor, info)
    return { values: decodeBand(raw, info, memberName), dims: info.dims }
  }

  /** Decode a compound-of-fixed-strings dataset (the Group_F band table) → rows. */
  async readStringTable(path: string): Promise<Record<string, string>[]> {
    const node = this.get(path)
    const info = node.asDataset()
    const raw = await readRawElements(this.cursor, info)
    return decodeStringTable(raw, info)
  }
}

/** Parse an HDF5 file from an ArrayBuffer. Throws `Hdf5Error` on any out-of-subset
 *  construct (naming it + the file offset). */
export function openHdf5(buf: ArrayBuffer): Hdf5File {
  return new Hdf5File(buf)
}
