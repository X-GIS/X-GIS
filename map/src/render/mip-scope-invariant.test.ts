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

  it("every OTHER sampler in #1436's table stays un-mipped, each for its own reason", () => {
    // #1436 listed these as "sites where no call site could ask". Adjudicated one at a time
    // once the vocabulary existed, and the answer for all of them is NO — but for four
    // different reasons, which is why this is a table rather than a blanket rule. Someone
    // "finishing the job" by mipmapping them would be introducing correctness bugs, not
    // completing a feature.
    const cases = [
      {
        file: './material/hillshade-material.ts',
        why:
          'DEM relief computes slope from EIGHT NEIGHBOUR TAPS of a 3x3 (hillshade.ts:176-241, ' +
          'pinned in hillshade-dsl.test.ts). `nearest` is load-bearing: any filtering pre-blends ' +
          'the very texels the derivative is taken between, and a mip chain compounds it. ' +
          'Elevation is also DATA — the coverage rule applies twice over.',
      },
      {
        file: './flow-renderer.ts',
        why:
          'velocity components, sampled for DATA. Averaging u/v across levels fabricates ' +
          'currents the model never produced — the coverage argument verbatim.',
      },
      {
        file: '../color-ramp.ts',
        why:
          'a 256x1 LOOKUP TABLE indexed by a normalised value, not a surface in screen space. ' +
          'It is never minified, so a chain would cost bytes to serve a level nothing selects — ' +
          'and averaging along a ramp blends adjacent colour stops.',
      },
    ] as const
    for (const c of cases) {
      const src = read(c.file)
      for (const [i, d] of descriptors(src).entries())
        expect(d, `${c.file} createTexture #${i + 1}: ${c.why}`).not.toContain('mipLevelCount')
      expect(
        src.includes("mipmap: '") || src.includes('mipmap:'),
        `${c.file} sampler must not ask for a mipmap filter — ${c.why}`,
      ).toBe(false)
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
