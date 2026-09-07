// #2428 — `categorical()` past the palette length wraps, and now says so.
//
// The wrap is deterministic (`CAT_PALETTE[u32(field) % CAT_PALETTE_SIZE]`,
// shader-gen.ts:287/:406), so the witness needs no fixture hunting: N+1 distinct
// values is the boundary by construction.
//
// The boundary is asserted from `CAT_PALETTE_SIZE` itself, never from a literal
// 20. A test that hard-coded 20 would pin the BUG rather than the behaviour, and
// #2428's preferred remedy — a data-sized palette — would have to delete the
// assertion to pass. Pinning the constant means this file keeps working when the
// palette grows and only stops mattering when the modulo actually goes away.
//
// SINCE #2579 THIS IS THE DENSE PATH'S WARNING. The pigeonhole bound is the true
// and only bound for `deriveSeededCategoryOrder`'s ranks, which is where this
// still fires from (`categorical-dense-index.test.ts` gates that). It was ALSO
// wired to `buildCategoryMap`, whose ids are hashes — where it is blind, because
// a hash collides on the birthday bound long before the count reaches the
// palette length. That producer half is now `warnCategoricalSlotCollisions`, and
// `categorical-hash-collision.test.ts` owns it.

import { describe, it, expect, beforeEach } from 'vitest'
import { CAT_PALETTE_SIZE } from '@xgis/compiler'
import { buildCategoryMap } from './feature-data-pack'
import {
  warnCategoricalPaletteWrap,
  resetCategoricalPaletteWrapWarnings,
} from './category-palette-wrap-warning'

/** N distinct values, deterministic and unrelated to any real field. */
function values(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `cat-${i}`)
}

describe('#2428 — the categorical palette wrap is no longer silent', () => {
  beforeEach(() => resetCategoricalPaletteWrapWarnings())

  it(`warns once past CAT_PALETTE_SIZE (${CAT_PALETTE_SIZE}), naming the field and the count`, () => {
    const msgs: string[] = []
    warnCategoricalPaletteWrap('land_use', CAT_PALETTE_SIZE + 1, (m) => msgs.push(m))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('land_use')
    expect(msgs[0]).toContain(String(CAT_PALETTE_SIZE + 1))
    expect(msgs[0]).toContain(String(CAT_PALETTE_SIZE))
  })

  // THE CONTROL. Without it every assertion above is satisfied by a warner that
  // fires unconditionally — which would be worse than silence, because an author
  // whose 5-category style warns learns to ignore the channel.
  it('stays silent AT the boundary, not just below it', () => {
    const msgs: string[] = []
    warnCategoricalPaletteWrap('class', CAT_PALETTE_SIZE, (m) => msgs.push(m))
    warnCategoricalPaletteWrap('subclass', 1, (m) => msgs.push(m))
    expect(msgs).toEqual([])
  })

  it('latches per field — a second call for the same field is silent, a different field is not', () => {
    const msgs: string[] = []
    const sink = (m: string) => msgs.push(m)
    warnCategoricalPaletteWrap('a', CAT_PALETTE_SIZE + 5, sink)
    warnCategoricalPaletteWrap('a', CAT_PALETTE_SIZE + 5, sink)
    expect(msgs).toHaveLength(1)
    warnCategoricalPaletteWrap('b', CAT_PALETTE_SIZE + 5, sink)
    expect(msgs).toHaveLength(2)
  })

  it('buildCategoryMap without a field name still builds the same map', () => {
    const withName = buildCategoryMap(values(3), 'f')
    resetCategoricalPaletteWrapWarnings()
    const without = buildCategoryMap(values(3))
    expect([...without]).toEqual([...withName])
  })
})

// A SOURCE gate, because the parameter is optional. Both production callers must
// pass the field name; if one silently stops, the warning goes quiet for that
// packer and every behavioural test above still passes — the vacuity shape §12
// warns about. This is the only assertion that can see it.
describe('#2428 — both production packers pass the field name', () => {
  it('feature-data-pack and feature-data-binder both call buildCategoryMap with fieldName', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const dir = fileURLToPath(new URL('.', import.meta.url))
    for (const file of ['feature-data-pack.ts', 'feature-data-binder.ts']) {
      const src = readFileSync(dir + file, 'utf8')
      const calls = [...src.matchAll(/buildCategoryMap\(([^)]*)\)/g)].map((m) => m[1]!)
      const invoking = calls.filter((a) => !a.includes(':')) // skip the declaration
      expect(invoking.length, `${file} should call buildCategoryMap`).toBeGreaterThan(0)
      for (const args of invoking) {
        expect(args, `${file}: buildCategoryMap called without a field name`).toContain('fieldName')
      }
    }
  })
})
