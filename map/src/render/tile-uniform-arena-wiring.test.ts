// ═══ #2042 INC-2 — VTR ↔ TileUniformArena wiring gate (source scan) ═══
//
// The arena's guarantees hold only while VTR keeps all five wiring points:
// slot establishment on the unclipped per-tile path, release on the store's
// eviction hook, wholesale drop beside resetForReupload, flush beside the
// ring flush, teardown in destroy. tsc proves each CALL compiles, not that
// it is still CALLED — a refactor that drops one leaves slots leaking (or
// stale) with no compile error. Same static-scan discipline as
// vector-tile-renderer-uniform-completeness.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'vector-tile-renderer.ts'), 'utf8')

describe('VTR wires TileUniformArena at all five lifecycle points (#2042 INC-2)', () => {
  it('slots are established on the per-tile path, gated to UNCLIPPED draws', () => {
    const calls = [...src.matchAll(/_tileUniforms\.ensureSlot\(/g)]
    expect(calls.length, 'exactly one establishment site (the main per-tile walk)').toBe(1)
    // The guard must precede the call: clip-fallback draws (visibleKey ≥ 0)
    // have per-descendant clip_bounds and MUST NOT share a persistent slot.
    const at = src.indexOf('_tileUniforms.ensureSlot(')
    const windowBefore = src.slice(Math.max(0, at - 600), at)
    expect(windowBefore).toMatch(/visibleKey < 0/)
  })

  it('the store release hook frees the tile slots (every evict/drop/supersede path)', () => {
    const hook = src.match(/_releaseTileHook = \(handleKey: string\): void => \{([\s\S]*?)\n {2}\}/)
    expect(hook, '_releaseTileHook arrow not found').toBeTruthy()
    expect(hook![1]).toContain('_tileUniforms.releaseTile(handleKey)')
  })

  it('resetForReupload is paired with the wholesale slot drop', () => {
    const at = src.indexOf('resetForReupload()')
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 400)).toContain('_tileUniforms.resetAll()')
  })

  it('the arena flushes with the ring and tears down with the renderer', () => {
    expect(src).toMatch(/flushUniformStaging\(\): void \{[\s\S]{0,400}?_tileUniforms\.flush\(\)/)
    expect(src).toContain('_tileUniforms.destroy()')
  })
})
