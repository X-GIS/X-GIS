// Gate A (#797 P0) — host image registry round-trip. Device-free: the
// registry never touches a GPUDevice, so `new ImageData(4, 4)` alone
// exercises the full addImage → hasImage → removeImage contract.
//
// node (vitest's default env) has no `ImageData` global, so we install a
// minimal shim (mirroring the WebGPU-global stub pattern in
// map-rebuild-layers.characterization.test.ts). The registry only reads
// `.width` / `.height` and retains the source, so the shim is sufficient.

import { describe, it, expect, beforeAll } from 'vitest'
import { HostImageRegistry } from './host-image-registry'

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  if (g.ImageData === undefined) {
    g.ImageData = class {
      readonly width: number
      readonly height: number
      readonly data: Uint8ClampedArray
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
        this.data = new Uint8ClampedArray(width * height * 4)
      }
    }
  }
})

describe('HostImageRegistry (#797 P0 Gate A)', () => {
  it('round-trips hasImage false → addImage → true → removeImage → false', () => {
    const reg = new HostImageRegistry()
    expect(reg.hasImage('marker')).toBe(false)
    reg.addImage('marker', new ImageData(4, 4))
    expect(reg.hasImage('marker')).toBe(true)
    reg.removeImage('marker')
    expect(reg.hasImage('marker')).toBe(false)
  })

  it('normalises dimensions from the source', () => {
    const reg = new HostImageRegistry()
    reg.addImage('a', new ImageData(12, 7))
    const entry = reg.get('a')
    expect(entry).toBeDefined()
    expect(entry!.w).toBe(12)
    expect(entry!.h).toBe(7)
    expect(entry!.source).toBeInstanceOf(ImageData)
  })

  it('tracks size and iterates entries', () => {
    const reg = new HostImageRegistry()
    expect(reg.size).toBe(0)
    reg.addImage('a', new ImageData(2, 2))
    reg.addImage('b', new ImageData(3, 3))
    expect(reg.size).toBe(2)
    const names = [...reg.entries()].map(([name]) => name).sort()
    expect(names).toEqual(['a', 'b'])
  })

  it('addImage replaces an existing name', () => {
    const reg = new HostImageRegistry()
    reg.addImage('a', new ImageData(2, 2))
    reg.addImage('a', new ImageData(8, 8))
    expect(reg.size).toBe(1)
    expect(reg.get('a')!.w).toBe(8)
  })

  it('rejects an empty name (warn + drop, not stored)', () => {
    const reg = new HostImageRegistry()
    reg.addImage('', new ImageData(4, 4))
    expect(reg.size).toBe(0)
    expect(reg.hasImage('')).toBe(false)
  })

  it('rejects a missing source (warn + drop)', () => {
    const reg = new HostImageRegistry()
    reg.addImage('a', null as unknown as ImageData)
    expect(reg.size).toBe(0)
    expect(reg.hasImage('a')).toBe(false)
  })

  it('removeImage is a metadata drop only (idempotent, no throw on missing)', () => {
    const reg = new HostImageRegistry()
    reg.removeImage('never-added') // no throw
    reg.addImage('a', new ImageData(4, 4))
    reg.removeImage('a')
    reg.removeImage('a') // second remove is a no-op
    expect(reg.hasImage('a')).toBe(false)
  })
})
