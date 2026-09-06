// ═══ Inc 9: the lazy group is fetched at REGISTRATION, not at construction (#1679) ═══
//
// The last increment, and the only one whose mechanism is a matter of TIMING rather than
// of keys. Three facts make it so:
//
//   * every lazy draper is built SYNCHRONOUSLY — `HeatmapRenderer.drapers()` is a memoised
//     getter fired on the draw path — so a draper cannot await a chunk;
//   * `prefetchLazyShaders` is an async dynamic import;
//   * the expensive event is the FIRST build (heatmap's three passes cost 33.9 ms of WGSL
//     emit / 38.4 ms of GLSL-stage emit, measured — a two-frame hitch, mid-session).
//
// So starting the import at construction would miss on exactly the build that matters,
// pay the full emit AND the chunk, and only help a rebuild that never comes. The whole
// design rests on the fetch starting at a point strictly BEFORE the first draw, which is
// `addLayer`. That is the property this file exists to hold: a future refactor that moves
// the call "closer to where it is used" would silently turn the increment into a no-op
// with every other gate still green.
//
// WHY THE BYTES ARE NOT THE POINT. The lazy artifacts were imported by nobody before this
// increment, so Rollup dropped them and they cost ZERO shipped bytes. Keying them ADDS a
// chunk (measured from the real playground build: 4,313 B gzip GLSL, 3,985 B WGSL, against
// the boot chunks' 58,066 B / 38,128 B). The increment buys main-thread time, not bytes,
// and any future note claiming it "saves" bytes has the direction backwards.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAMILY_GROUPS, simpleGlslId, simpleWgslId, type SimpleFamily } from './ids'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAP_SRC = join(HERE, '..', '..')
const read = (rel: string): string => readFileSync(join(MAP_SRC, rel), 'utf8')

function artifactIds(file: string): ReadonlySet<string> {
  const src = readFileSync(join(HERE, file), 'utf8')
  const block = /index:\s*\{(.*?)\n\s{2}\}/s.exec(src)
  if (block === null) return new Set()
  return new Set([...block[1].matchAll(/'([^']+)':/g)].map((m) => m[1]))
}
const GLSL_LAZY = artifactIds('baked-glsl-lazy.generated.ts')
const WGSL_LAZY = artifactIds('baked-wgsl-lazy.generated.ts')
const GLSL_BOOT = artifactIds('baked-glsl-boot.generated.ts')

/** The lazy families keyed by this increment, and the file that keys them. */
const KEYED_LAZY: Readonly<Record<string, string>> = {
  'heatmap-accum': 'render/material/heatmap-material.ts',
  'heatmap-blur': 'render/material/heatmap-material.ts',
  'heatmap-compose': 'render/material/heatmap-material.ts',
  // #2499 step 3 — prefetched by CoverageRenderer.setCoverage when a vector band is armed.
  'flow-advect': 'render/material/flow-advect-material.ts',
}

describe('#1679 inc 9 — reader sanity', () => {
  it('both lazy artifacts yielded an id index, and it is not the boot one', () => {
    expect(
      GLSL_LAZY.size,
      'no ids parsed out of baked-glsl-lazy.generated.ts — the `index:` reader is broken, ' +
        'not the artifact; every membership assertion below would then read as missing',
    ).toBeGreaterThanOrEqual(6)
    expect(WGSL_LAZY.size, 'same, for the WGSL lazy artifact').toBeGreaterThanOrEqual(4)
    // Guard against the reader silently pointing at the wrong file: the boot artifact is
    // much larger, so an accidental swap would still look "non-empty" without this.
    expect(
      GLSL_LAZY.size < GLSL_BOOT.size,
      'the lazy index is not smaller than the boot index — the reader is probably pointed ' +
        'at the wrong artifact, which would make every arm below test the wrong file',
    ).toBe(true)
  })
})

describe('#1679 inc 9 — the prefetch fires at REGISTRATION, not at construction', () => {
  const renderer = () => read('render/heatmap-renderer.ts')

  it('heatmap-renderer.ts calls prefetchLazyShaders at all', () => {
    expect(
      renderer(),
      'HeatmapRenderer no longer starts the lazy fetch. Its three passes then emit at ' +
        'runtime on the first heatmap draw — 33.9 ms (WGSL) / 38.4 ms (GLSL stages) of ' +
        'synchronous main-thread block, measured — while the chunk that would have served ' +
        'them is still shipped and simply never fetched.',
    ).toContain('prefetchLazyShaders(this.rhi)')
  })

  it('the call is NOT inside drapers() — that is the draw path and cannot await', () => {
    const src = renderer()
    const start = src.indexOf('private drapers()')
    expect(start, 'drapers() not found — this arm cannot judge placement').toBeGreaterThan(0)
    // The getter body, up to the next method at the same indentation.
    const end = src.indexOf('\n  }', start)
    const body = src.slice(start, end)
    expect(
      body.includes('prefetchLazyShaders'),
      'the lazy fetch was moved INTO drapers(). That getter is memoised and fired on the ' +
        'DRAW path, so the import cannot be awaited: the first build — the only expensive ' +
        'one — falls through to the emit anyway, and now pays for a chunk too. The call ' +
        'belongs in addLayer, which runs strictly before the first draw.',
    ).toBe(false)
  })

  it('the call sits inside addLayer, after its empty-layer return', () => {
    const src = renderer()
    const addLayer = src.indexOf('  addLayer(')
    const call = src.indexOf('prefetchLazyShaders(this.rhi)')
    const drapers = src.indexOf('private drapers()')
    expect(addLayer, 'addLayer not found').toBeGreaterThan(0)
    expect(
      call > addLayer && call < drapers,
      `prefetchLazyShaders is not inside addLayer (addLayer@${addLayer}, call@${call}, ` +
        `drapers@${drapers}). addLayer is the registration seam — the last point that is ` +
        `provably before the first draw.`,
    ).toBe(true)
    const emptyReturn = src.indexOf('if (points.length === 0) return')
    expect(
      call > emptyReturn,
      'the fetch runs BEFORE the empty-layer return, so a heatmap layer with no points — ' +
        'one that never draws and never builds a draper — still pulls a chunk it will ' +
        'never read.',
    ).toBe(true)
  })

  it('the install is joined, not restarted, on a second call', () => {
    const src = read('shaders/baked/install.ts')
    expect(
      src,
      'prefetchLazyShaders no longer memoises its in-flight promise. addLayer is called ' +
        'once PER LAYER, so a style with four heatmap layers would start four imports of ' +
        'the same chunk.',
    ).toContain('_lazyInstall')
    expect(
      /if \(bakedShadersDisabled\(\) \|\| _lazyInstall !== null\) return/.test(src),
      'the early return no longer guards on an in-flight install — the join is what makes ' +
        'a per-layer call site safe.',
    ).toBe(true)
  })
})

describe('#1679 inc 9 — the keyed lazy families resolve in the LAZY artifact', () => {
  for (const [family, file] of Object.entries(KEYED_LAZY)) {
    it(`${family} is keyed and its ids live in the lazy group`, () => {
      const f = family as SimpleFamily
      expect(
        FAMILY_GROUPS[f],
        `'${family}' is keyed by ${file} but its download group is not 'lazy' — the ` +
          `prefetch installs the lazy artifact, so a family that moved groups would be ` +
          `fetched by nothing and miss on every lookup.`,
      ).toBe('lazy')
      expect(read(file), `${file} does not key ${family}`).toContain(`simpleWgslId('${family}')`)
      expect(
        WGSL_LAZY.has(simpleWgslId(f)),
        `${simpleWgslId(f)} is absent from baked-wgsl-lazy.generated.ts`,
      ).toBe(true)
      for (const stage of ['vertex', 'fragment'] as const)
        expect(
          GLSL_LAZY.has(simpleGlslId(f, stage)),
          `${simpleGlslId(f, stage)} is absent from baked-glsl-lazy.generated.ts — the ` +
            `prefetch would fetch a chunk that does not contain what the call site asks for.`,
        ).toBe(true)
    })
  }
})
