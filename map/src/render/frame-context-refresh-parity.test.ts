// ═══ The reused FrameContext refreshes EVERY field the builder sets (#1046 Inc-F) ═══
//
// RenderLoop allocates one FrameContext on the first frame and mutates it in place
// forever after (allocation-paranoid, render-loop.ts). That makes the two population
// sites TWO AUTHORITIES over one object: a field the builder sets and the reuse branch
// forgets is frozen at frame 1's value, silently, for the life of the map.
//
// `rhi` was exactly that. `map.run()` re-boots swap `host.ctx` wholesale, so after a
// backend live-swap the context still answered the DEAD device's caps — and the frame
// wiring reads those caps to size MSAA (`maxSampleCount`) and to decide whether a
// continuous pick target exists (`presentablePassMrt`). A stale `true` puts a second
// colour attachment on a WebGL2 screen pass, which fail-louds every frame; a stale
// `false` drops WebGPU's pick attachment and picking dies silently. One missing line.
//
// This gate compares the two sites' KEY SETS in the source, so the next forgotten
// field fails here rather than after a live-swap on someone's machine. Fields whose
// values are computed deeper in the frame are declared below with their reason — the
// list is the exemption, and it must stay short and justified.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'render-loop.ts'),
  'utf8',
)

/** Exempt, each with the site that actually owns it:
 *  • w / h / dpr are CONSTRUCTOR ARGS, not context fields — they seed `scene`/`screen`
 *    (makeFrameContext), which `setFrameTargets(ctx, w, h, dpr, sceneScale)` re-derives
 *    every frame for BOTH branches (render-loop.ts, right below the fork);
 *  • the rest are computed deeper in the frame by `wireFrameColour`, which owns the
 *    MSAA / render-target derivation and repopulates them per frame either way. */
const DERIVED_LATER = new Set([
  'w',
  'h',
  'dpr',
  'useResolve',
  'sampleCount',
  'rhiColorView',
  'rhiStencilView',
  'rhiSceneResolveView',
  'rhiColorViewScreen',
  'rhiSceneColorSampleView',
])

/** Keys of the `makeFrameContext({ ... })` object literal. */
function builderKeys(): Set<string> {
  const at = SRC.indexOf('makeFrameContext({')
  expect(at, 'the builder call site still exists').toBeGreaterThan(-1)
  const body = SRC.slice(at, SRC.indexOf('})', at))
  return new Set([...body.matchAll(/^\s{8}(\w+)[,:]/gm)].map((m) => m[1]!))
}

/** Keys the reuse branch assigns onto the retained context (`c.<key> = …`), plus the
 *  projection token, which is repopulated in place by its own helper rather than
 *  reassigned (allocation-paranoid — the token identity must NOT change). */
function reuseKeys(): Set<string> {
  const at = SRC.indexOf('const c = this._ctx')
  expect(at, 'the reuse branch still exists').toBeGreaterThan(-1)
  const body = SRC.slice(at, SRC.indexOf('const ctx = this._ctx', at))
  const keys = new Set([...body.matchAll(/^\s+c\.(\w+)\s*=/gm)].map((m) => m[1]!))
  if (/setProjectionToken\(\s*c\.projection/.test(body)) keys.add('projection')
  return keys
}

describe('FrameContext population parity: builder vs reuse (#1046 Inc-F)', () => {
  it('both extractors find real, non-trivial key sets (not vacuous — #996)', () => {
    // A regex that silently stops matching would make the comparison below pass by
    // comparing two empty sets, which is the failure mode this repo has paid for.
    expect(builderKeys().size).toBeGreaterThanOrEqual(8)
    expect(reuseKeys().size).toBeGreaterThanOrEqual(8)
    expect(builderKeys().has('rhi')).toBe(true)
    expect(reuseKeys().has('rhi')).toBe(true)
  })

  it('every builder field is refreshed by the reuse branch (or declared derived-later)', () => {
    const missing = [...builderKeys()].filter((k) => !reuseKeys().has(k) && !DERIVED_LATER.has(k))
    expect(
      missing,
      `render-loop.ts builds the FrameContext once and reuses it: these fields are set on ` +
        `the first frame and never refreshed, so they answer frame 1 forever (the stale-device ` +
        `class — a swapped backend keeps the dead device's caps). Assign them in the reuse ` +
        `branch, or add them to DERIVED_LATER with the site that owns them.`,
    ).toEqual([])
  })
})
