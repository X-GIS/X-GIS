// ═══ #1580 leg B — a replaced host image never re-uploaded ═══
//
// `sync()` skipped any name already in `packed`, so a REPLACED image (same
// name, new source) was never re-uploaded — `get()` kept returning the
// original texels AND the original width/height, contradicting `addImage`'s
// own "Register (or replace)" contract. Fixed with a per-name source-identity
// marker: `addImage` always creates a fresh registry entry object even for a
// replace, so identity doubles as a version check with no new API surface.

import { describe, it, expect } from 'vitest'
import { HostImageRegistry } from './host-image-registry'
import { HostAtlasPacker } from './host-atlas-packer'

function makeImageData(w: number, h: number): ImageData {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData
}

interface UploadCall {
  x: number
  y: number
  w: number
  h: number
}

describe('#1580 leg B — HostAtlasPacker re-uploads a replaced image', () => {
  it('addImage(x, 64) then addImage(x, 128) re-uploads and reports the NEW size', () => {
    const reg = new HostImageRegistry()
    const packer = new HostAtlasPacker(reg)
    const uploads: UploadCall[] = []
    const upload = (_src: unknown, x: number, y: number, w: number, h: number): void => {
      uploads.push({ x, y, w, h })
    }

    reg.addImage('x', makeImageData(64, 64))
    packer.markDirty()
    packer.sync(upload)
    expect(uploads, 'the fresh name uploads once').toHaveLength(1)
    expect(packer.get('x')).toEqual(expect.objectContaining({ width: 64, height: 64 }))

    reg.addImage('x', makeImageData(128, 128))
    packer.markDirty()
    packer.sync(upload)

    expect(uploads, 'the replace must re-upload — this is the bug this test pins').toHaveLength(2)
    expect(packer.get('x'), 'get() must report the NEW size, not the stale one').toEqual(
      expect.objectContaining({ width: 128, height: 128 }),
    )
  })

  it('CONTROL — a fresh name uploads once and is unaffected by the replace logic', () => {
    const reg = new HostImageRegistry()
    const packer = new HostAtlasPacker(reg)
    const uploads: UploadCall[] = []
    const upload = (_src: unknown, x: number, y: number, w: number, h: number): void => {
      uploads.push({ x, y, w, h })
    }

    reg.addImage('y', makeImageData(128, 128))
    packer.markDirty()
    packer.sync(upload)

    expect(uploads).toHaveLength(1)
    expect(packer.get('y')).toEqual(expect.objectContaining({ width: 128, height: 128 }))

    // A second sync() with nothing new must stay a no-op — replace-detection
    // must not make sync() re-upload UNCHANGED entries every call.
    packer.markDirty()
    packer.sync(upload)
    expect(uploads, 'an unchanged entry must not re-upload on every sync()').toHaveLength(1)
  })

  it('reset() clears the replace-tracking too, so a re-add after reset uploads fresh', () => {
    const reg = new HostImageRegistry()
    const packer = new HostAtlasPacker(reg)
    const uploads: UploadCall[] = []
    const upload = (_src: unknown, x: number, y: number, w: number, h: number): void => {
      uploads.push({ x, y, w, h })
    }

    reg.addImage('z', makeImageData(32, 32))
    packer.markDirty()
    packer.sync(upload)
    expect(uploads).toHaveLength(1)

    packer.reset()
    // Same registry entry object (no replace) — but the packer forgot it via
    // reset(), so it must be treated as new again.
    packer.markDirty()
    packer.sync(upload)
    expect(uploads, 'reset() must forget prior packing state entirely').toHaveLength(2)
  })
})
