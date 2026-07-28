// ═══ Which textures get a mip chain is a DECISION, not a default (#1436) ═══
//
// #1436 gave raster basemap tiles a chain because they are APPEARANCE textures that get
// minified: on a pitched globe the far field is most of the frame, and there a single-level
// bilinear tap averages 4 of the many texels a pixel covers, picking a different 4 next frame.
//
// The same change applied to a DATA texture would be a correctness bug, not a quality win — so
// the exclusion is pinned here rather than left to whoever tidies up next.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** The `createTexture({...})` descriptors in a source file, as text. */
function descriptors(src: string): string[] {
  return src
    .split('createTexture(')
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('})')))
}

describe('mip chains are scoped to appearance textures (#1436)', () => {
  it('the coverage value/validity grid declares NO chain — averaging it fabricates data', () => {
    // The coverage grid is sampled for DATA, not appearance. Averaging four soundings into a
    // parent level invents a depth the survey never recorded, and a shallow hazard averaged with
    // its deeper neighbours reads as navigable water. That is a different KIND of wrong from a
    // shimmering basemap, which is why the feature must not creep here.
    const descs = descriptors(read('./coverage-renderer.ts'))
    expect(descs.length, 'the coverage renderer still creates textures').toBeGreaterThan(0)
    for (const [i, d] of descs.entries()) {
      expect(d, `coverage createTexture #${i + 1} must not request a mip chain`).not.toContain(
        'mipLevelCount',
      )
    }
  })

  it('the raster tile DOES declare one — the gate is non-vacuous', () => {
    // Without this the test above passes just as well against a tree where #1436 was reverted
    // wholesale, which would make it a tripwire for nothing.
    const descs = descriptors(read('./raster-renderer.ts'))
    expect(
      descs.some((d) => d.includes('mipLevelCount')),
      'raster-renderer must still create a chained tile texture',
    ).toBe(true)
  })
})
