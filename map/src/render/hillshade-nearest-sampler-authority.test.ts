// ═══ The DEM sampler is nearest BY CONSTRUCTION, and `resamplingNearest`
//     reaches no hillshade runtime reader (#2166 L3) ═══
//
// Two facts the `resampling` capability + coverage rows assert about this tree.
// Both are mechanically checkable, and neither was checked — which is how the
// rows drifted into claiming a two-pass upgrade path and byte-parity with
// another engine that nothing here can cash.
//
//  1. HillshadeDraper creates exactly ONE sampler and it is nearest/nearest.
//     The packed-RGB height decode is corrupted by bilinear filtering
//     (shaders/dsl/hillshade.ts), so this is a correctness requirement, not a
//     shortcut. NOTE this is NOT what `resampling` selects, in either engine:
//     MapLibre binds its DEM nearest for both values too and filters the
//     Sobel-derivative output of its prepare pass instead (maplibre-gl 5.24.0,
//     dist/maplibre-gl-dev.js lines 64424 / 64443 / 64453). So a linear DEM
//     sampler is not the `linear` feature — that is a 4-tap blend of the DECODED
//     heights before the Sobel (#2215), and it stays single-pass.
//  2. The compiler DOES build `hillshade-resampling-nearest` end to end — the
//     utility, the binding, the render-node field, and `HillshadeShapes.
//     resamplingNearest` on the emitted ShowCommand — and no hillshade runtime
//     code reads it. The single reader of that field name under map/src is the
//     RASTER one. That is the landed compiler half of a two-half feature; this
//     asserts the second half is genuinely absent, so the row saying so stays
//     true and the day someone wires it, this reddens (correctly).
//
// GPU-free: an RhiDevice stub for (1), a source-tree scan for (2).

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HillshadeDraper } from './material/hillshade-material'

const HERE = dirname(fileURLToPath(import.meta.url))
/** map/src/render → map/src */
const MAP_SRC = join(HERE, '..')

describe('the hillshade DEM sampler (#2166 L3)', () => {
  it('HillshadeDraper creates exactly one sampler, and it is nearest/nearest', () => {
    const samplers: Record<string, unknown>[] = []
    const rhi = {
      createSampler: (d: Record<string, unknown>) => {
        samplers.push(d)
        return { __sampler: samplers.length }
      },
      createBuffer: () => ({ __buffer: true }),
    }
    new HillshadeDraper(rhi as never, 'rgba8unorm', 1)
    expect(
      samplers.length,
      'HillshadeDraper no longer creates exactly one sampler — a second sampler means the DEM ' +
        'filter became selectable, which the `resampling` capability row says it is not',
    ).toBe(1)
    expect(
      samplers[0],
      'the DEM sampler is not nearest/nearest — bilinear filtering over the RGB-packed height ' +
        'corrupts the decode (shaders/dsl/hillshade.ts)',
    ).toEqual({ mag: 'nearest', min: 'nearest' })
  })
})

/** Build artefacts, excluded at ANY depth by basename. */
const SKIP_DIRS = new Set(['node_modules', 'dist'])

/** Excluded by PATH RELATIVE TO map/src, not by basename. `capabilities` is
 *  skipped for the same reason spec-coverage-note-fidelity.test.ts skips its
 *  descriptor dir: those files are the PROSE this gate adjudicates, and the
 *  `resampling` note has to be able to say the field's name to be useful.
 *  Leaving them in would let a note count as its own reader — measured: it did,
 *  the first full sweep after the note was rewritten.
 *
 *  Keyed on the resolved path so a later `map/src/<subsystem>/capabilities/`
 *  holding REAL code cannot silently skip itself out of the scan (#996: a
 *  name-keyed allowlist is how two gates went vacuously green). */
const SKIP_RELATIVE_DIRS = new Set(['capabilities'])

/** Every `.ts` under map/src, excluding tests — the corpus for the reader scan. */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const child = join(dir, e.name)
        const rel = relative(MAP_SRC, child).replace(/\\/g, '/')
        if (!SKIP_DIRS.has(e.name) && !SKIP_RELATIVE_DIRS.has(rel)) walk(child)
        continue
      }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
      out.push(join(dir, e.name))
    }
  }
  walk(MAP_SRC)
  return out
}

describe('`resamplingNearest` has no hillshade runtime reader (#2166 L3)', () => {
  it('the only reader under map/src is the raster one in the opaque pass', () => {
    const readers = sourceFiles()
      .filter((f) => readFileSync(f, 'utf8').includes('resamplingNearest'))
      .map((f) => relative(MAP_SRC, f).replace(/\\/g, '/'))
      .sort()
    // CAUSE first (§12): if the known-positive RASTER reader is gone, the scan
    // itself moved and this gate cannot adjudicate the hillshade half at all.
    // Asserting the array shape first would report THAT as "a hillshade reader
    // appeared" — a red run naming a cause that did not happen.
    expect(
      readers,
      'the scan no longer finds the known RASTER reader (render/passes/opaque-pass.ts) — the ' +
        'corpus walk or that file path changed (an opaque-pass split moves it). This gate ' +
        'cannot say anything about the hillshade half until that is fixed. Readers found: ' +
        readers.join(', '),
    ).toContain('render/passes/opaque-pass.ts')
    // EFFECT second: with the known positive present, any EXTRA reader is a
    // hillshade one.
    expect(
      readers.length,
      'a hillshade reader for `resamplingNearest` appeared. The compiler has always emitted ' +
        'HillshadeShapes.resamplingNearest and the runtime has always dropped it; if that is ' +
        'now wired, update the `resampling` rows (compiler/src/convert/spec-coverage/' +
        'paint-hillshade.ts and map/src/capabilities/hillshade.ts), which both state the ' +
        'opposite. Readers found: ' +
        readers.join(', '),
    ).toBe(1)
  })
})
