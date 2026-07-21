// ═══ HDF5 subset reader — version-1 B-tree (group nodes + raw-data chunk nodes) ═══
//
// The v1 b-tree ("TREE") is the only chunk index in the subset (A1). Two node
// types:
//   • type 0 (group)      — keys are local-heap name offsets; leaves are symbol
//                           table nodes ("SNOD") of entries (name → object header).
//   • type 1 (raw chunk)  — keys carry the chunk's element offsets + byte size +
//                           filter mask; leaves point at the (filtered) chunk bytes.
// Internal nodes (level > 0) recurse into child sub-trees.

import { Cursor, Hdf5Error } from './bytes'

// ── Local heap ("HEAP") — resolves a group b-tree key to a member name ────────
interface LocalHeap {
  dataSegmentAddress: number
}
function parseLocalHeap(c: Cursor, addr: number): LocalHeap {
  c.seek(addr)
  c.signature('HEAP', 'local heap')
  c.u8() // version
  c.skip(3) // reserved
  c.length() // data segment size
  c.length() // free-list head offset
  const dataSegmentAddress = c.offset()
  return { dataSegmentAddress }
}
function heapName(c: Cursor, heap: LocalHeap, nameOffset: number): string {
  c.seek(heap.dataSegmentAddress + nameOffset)
  return c.cstr()
}

// ── Group b-tree (type 0) → { name → object-header address } ──────────────────
export function walkGroupBtree(
  c: Cursor,
  btreeAddress: number,
  localHeapAddress: number,
): Map<string, number> {
  const heap = parseLocalHeap(c, localHeapAddress)
  const out = new Map<string, number>()
  walkGroupNode(c, btreeAddress, heap, out)
  return out
}

function walkGroupNode(c: Cursor, addr: number, heap: LocalHeap, out: Map<string, number>): void {
  c.seek(addr)
  c.signature('TREE', 'group b-tree node')
  const nodeType = c.u8()
  if (nodeType !== 0)
    throw new Hdf5Error(`expected group b-tree node (type 0), got type ${nodeType}`, addr)
  const level = c.u8()
  const entries = c.u16()
  c.offset() // left sibling
  c.offset() // right sibling
  // keys[0], child[0], keys[1], child[1] … child[n-1], keys[n]
  for (let i = 0; i < entries; i++) {
    c.length() // key: local-heap offset of the first name in the subtree (unused)
    const childAddr = c.offset()
    if (level > 0) {
      const save = c.pos
      walkGroupNode(c, childAddr, heap, out)
      c.seek(save)
    } else {
      const save = c.pos
      readSymbolTableNode(c, childAddr, heap, out)
      c.seek(save)
    }
  }
}

function readSymbolTableNode(
  c: Cursor,
  addr: number,
  heap: LocalHeap,
  out: Map<string, number>,
): void {
  c.seek(addr)
  c.signature('SNOD', 'symbol table node')
  c.u8() // version
  c.u8() // reserved
  const numSymbols = c.u16()
  for (let i = 0; i < numSymbols; i++) {
    const nameOffset = c.offset()
    const objectHeaderAddress = c.offset()
    c.u32() // cache type
    c.u32() // reserved
    c.skip(16) // scratch-pad
    const save = c.pos
    out.set(heapName(c, heap, nameOffset), objectHeaderAddress)
    c.seek(save)
  }
}

// ── Raw-data chunk b-tree (type 1) → chunk records ────────────────────────────
export interface ChunkRecord {
  /** Element offset of the chunk's origin, one per dataset dimension (row-major). */
  offsets: number[]
  /** File address of the (possibly filtered) chunk bytes. */
  address: number
  /** Stored byte size of the chunk (post-filter on disk). */
  size: number
  /** Per-chunk filter-skip mask (bit i set ⇒ filter i was NOT applied to this chunk). */
  filterMask: number
}

/** Walk the chunk b-tree at `btreeAddress`. `rank` = the DATASET dimensionality
 *  (the b-tree keys carry rank+1 element offsets — the trailing one is the element
 *  dimension, always 0). */
export function walkChunkBtree(c: Cursor, btreeAddress: number, rank: number): ChunkRecord[] {
  const out: ChunkRecord[] = []
  walkChunkNode(c, btreeAddress, rank, out)
  return out
}

function walkChunkNode(c: Cursor, addr: number, rank: number, out: ChunkRecord[]): void {
  c.seek(addr)
  c.signature('TREE', 'chunk b-tree node')
  const nodeType = c.u8()
  if (nodeType !== 1)
    throw new Hdf5Error(`expected raw-data b-tree node (type 1), got type ${nodeType}`, addr)
  const level = c.u8()
  const entries = c.u16()
  c.offset() // left sibling
  c.offset() // right sibling
  for (let i = 0; i < entries; i++) {
    // key: chunk byte size(4) + filter mask(4) + (rank+1) element offsets (8 B each)
    const size = c.u32()
    const filterMask = c.u32()
    const offsets: number[] = []
    for (let d = 0; d < rank; d++) offsets.push(c.uint(8))
    c.uint(8) // trailing element-dimension offset (always 0)
    const childAddr = c.offset()
    const save = c.pos
    if (level > 0) walkChunkNode(c, childAddr, rank, out)
    else out.push({ offsets, address: childAddr, size, filterMask })
    c.seek(save)
  }
  // one trailing key past the last child (skipped — the loop reads leading keys)
}
