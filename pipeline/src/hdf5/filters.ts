// ═══ HDF5 subset reader — filters (deflate + shuffle) ═══
//
// The only two filters in the subset (A1). deflate (id 1) is RFC1950 zlib — HDF5's
// deflate output carries the zlib header + Adler-32, so the platform
// `DecompressionStream('deflate')` inflates it directly (no bundled inflate). shuffle
// (id 2) is a byte transpose, implemented in-house. Filters were applied forward
// during write; decode reverses them, honouring the per-chunk filter-skip mask.

import { Hdf5Error } from './bytes'
import type { FilterSpec } from './messages'

/** Inflate RFC1950 zlib bytes via the platform DecompressionStream (Node ≥ 18 /
 *  every browser). Async — the reader's chunk path is therefore async. */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  // Feed a fresh ArrayBuffer copy (the stream may retain the view). The write/close
  // rejections are swallowed (.catch) so a corrupt/truncated stream surfaces its error
  // ONLY through the awaited reader.read() below; an UNOBSERVED write/close rejection is
  // an unhandled promise rejection that terminates the Node process (Z_DATA_ERROR) —
  // defeating the loud-BUT-catchable A1 contract. This DecompressionStream drain is a
  // deliberate hand-copy of data/src/coverage/format.ts (the pipeline↔data zero-dep
  // charter forbids importing across the boundary from the reader) — keep both in sync.
  void writer.write(bytes.slice()).catch(() => {})
  void writer.close().catch(() => {})
  const chunks: Uint8Array[] = []
  const reader = ds.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

/** Undo the HDF5 shuffle filter: on write, byte b of every element is grouped
 *  (all byte-0s, then all byte-1s, …); this scatters them back to element-major.
 *  `elementSize` = the shuffle filter's configured datatype size. */
export function unshuffle(bytes: Uint8Array, elementSize: number): Uint8Array {
  if (elementSize <= 1) return bytes
  const n = Math.floor(bytes.length / elementSize) // number of elements
  const out = new Uint8Array(bytes.length)
  // shuffled layout: out[i*S + b] = bytes[b*n + i]
  for (let b = 0; b < elementSize; b++) {
    const base = b * n
    for (let i = 0; i < n; i++) out[i * elementSize + b] = bytes[base + i]!
  }
  // any trailing bytes beyond n·S (never for a full chunk) copy through
  for (let k = n * elementSize; k < bytes.length; k++) out[k] = bytes[k]!
  return out
}

/** Decode one raw chunk: reverse each applied filter (inflate / unshuffle) in
 *  reverse pipeline order, skipping any filter the per-chunk mask marks as not
 *  applied. `filters` is in forward (write) order; `elementSize` feeds shuffle. */
export async function decodeChunk(
  raw: Uint8Array,
  filters: FilterSpec[],
  filterMask: number,
  elementSize: number,
): Promise<Uint8Array> {
  let data = raw
  for (let i = filters.length - 1; i >= 0; i--) {
    if (filterMask & (1 << i)) continue // this filter was skipped for this chunk
    const f = filters[i]!
    if (f.id === 1) data = await inflate(data)
    else if (f.id === 2) data = unshuffle(data, f.clientData[0] || elementSize)
    else throw new Hdf5Error(`unreachable: filter id ${f.id} passed the pipeline gate`)
  }
  return data
}
