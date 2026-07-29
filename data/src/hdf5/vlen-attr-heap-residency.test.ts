// ═══ A vlen-string ATTRIBUTE's global heap must be resident before `attrs()` reads it (#1498) ═══
//
// `Hdf5Node.attrs()` is SYNCHRONOUS — a lazy accessor off a parsed node — so it cannot
// `await c.ensure(...)` when a vlen string sends it to a global heap collection. On the buffer
// reader that costs nothing: every byte is resident. On the RANGE reader it is a crash:
//
//   [hdf5 @0x5072f1f] bytes @0x5072f1f not resident — ensure() first
//     at readGlobalHeapObject (messages.ts:295)
//     at parseAttribute       (messages.ts:270)
//     at attrs                (groups.ts:56)
//
// reported from S-111 Live on an 86 MB `lsofs` cell whose heap sits 1.4 MB from the end of the
// file. `parseObjectHeader` now collects those addresses at the async boundary and ensures them.
//
// WHY THIS CLASS WAS INVISIBLE, and why the block size below is the whole test. Every other
// fixture-backed test opens through `openHdf5` (a `BufferReader`), where residency is total and
// no ensure can ever be missing. Only a block-based reader can distinguish "ensured" from
// "present", and only a SMALL block can put the heap outside whatever the metadata already
// pulled in — on a small fixture a 64 KB default block swallows the whole file and the bug hides
// again. So the reader here serves the real fixture in tiny blocks, which is the closest thing
// to an 86 MB cell that fits in a repository.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHdf5, openHdf5Range } from './index'
import { readS102Coverage } from './s102'
import type { ByteReader } from './bytes'

const HERE = dirname(fileURLToPath(import.meta.url))
const fileBytes = (n: string): Uint8Array =>
  new Uint8Array(readFileSync(join(HERE, '__fixtures__', n)))

/** A reader that serves EXACTLY the requested range and records what was asked for — the
 *  in-memory twin of an HTTP range reader, with no over-fetch to hide a missing `ensure`. */
function blockReader(data: Uint8Array): ByteReader & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = []
  return {
    byteLength: data.byteLength,
    reads,
    async read(offset: number, length: number): Promise<Uint8Array> {
      reads.push([offset, length])
      return data.subarray(offset, offset + length)
    },
  }
}

/** The committed real NOAA S-111 cell, read through `readS102Coverage` — the SAME call chain the
 *  live crash reported (`s102.ts` → `attr()` → `attrs()` → the heap). The fixture and the block
 *  size were both found by probing rather than chosen: every other committed fixture, and this
 *  one at 512 B and above, faults the heap in incidentally and cannot fail either way. */
const FIXTURE = 'noaa_s111_cbofs.h5'
const BLOCK = 256

describe('vlen-string attribute heaps are ensured before the sync read (#1498)', () => {
  it('the RANGE path reads the cell, where before it threw at the heap', async () => {
    const data = fileBytes(FIXTURE)
    // Ground truth through the buffer path, where residency is total and the bug cannot exist.
    const want = await readS102Coverage(await openHdf5(data.buffer.slice(0) as ArrayBuffer))
    // Before the fix this threw `[hdf5 @0x2140] bytes @0x2140 not resident — ensure() first`.
    const got = await readS102Coverage(await openHdf5Range(blockReader(data), { blockSize: BLOCK }))

    expect(got.product).toBe(want.product)
    expect(got.numPoints).toEqual(want.numPoints)
    expect(got.gridOrigin).toEqual(want.gridOrigin)
  })

  it('a node whose attributes are never READ still pays only for its header', async () => {
    // The collect pass must not fault the heaps of a node nobody asks about — it runs on the
    // object-header bytes `walk` has already ensured, and ensures a heap only when an ATTRIBUTE
    // message actually points at one. A regression here is a range reader that downloads every
    // heap in the file on open, which is the opposite of what the range path is for.
    const data = fileBytes(FIXTURE)
    const r = blockReader(data)
    await openHdf5Range(r, { blockSize: BLOCK })
    const fetched = r.reads.reduce((a, [, n]) => a + n, 0)
    expect(fetched).toBeLessThan(data.byteLength)
  })

  it('a small block size is what makes this test able to fail at all', async () => {
    // Guards the guard: with a block big enough to swallow the fixture, residency is total and
    // the assertion above passes on the broken code too. If the fixture ever grows past this,
    // the first test stops proving anything and this one says so.
    expect(BLOCK).toBeLessThan(fileBytes(FIXTURE).byteLength)
  })
})
