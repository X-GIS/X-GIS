// ═══ #2042 INC-2 — VTR ↔ TileUniformArena wiring gate (source scan) ═══
//
// The arena's guarantees hold only while VTR keeps all six wiring points:
// slot establishment on the unclipped per-tile path, release on the store's
// eviction hook, wholesale drop beside resetForReupload, flush beside the
// ring flush, grow-retired drain beside the ring drain, teardown in
// destroy. tsc proves each CALL compiles, not that
// it is still CALLED — a refactor that drops one leaves slots leaking (or
// stale) with no compile error. Same static-scan discipline as
// vector-tile-renderer-uniform-completeness.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'vector-tile-renderer.ts'), 'utf8')

describe('VTR wires TileUniformArena at all six lifecycle points (#2042 INC-2)', () => {
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

  it('grow-retired arena buffers are drained beside the ring drain (drop refs, no destroy)', () => {
    // Same discipline as the ring one line above the drain: refs dropped in
    // the per-frame window, NEVER destroyBuffer'd (a bind group captured just
    // before grow may still ride an in-flight submit).
    const ringDrain = src.indexOf('uniformRing?.takeRetired()')
    expect(ringDrain, 'ring drain site not found').toBeGreaterThan(0)
    const window = src.slice(ringDrain, ringDrain + 400)
    expect(window).toContain('_tileUniforms.takeRetired()')
    expect(window).not.toContain('destroyBuffer')
  })
})

describe('VTR wires UniformSplitBind at all lifecycle points (#2042 INC-4b)', () => {
  it('flush / drain / destroy pair with the arena wiring; setFillRhi hands off the layout', () => {
    // Same static-scan rationale as the arena gate above: a refactor that
    // drops one of these leaves split draws reading stale or leaked state
    // with no compile error.
    expect(src).toMatch(/flushUniformStaging\(\): void \{[\s\S]{0,500}?_splitBind\?\.flush\(\)/)
    const ringDrain = src.indexOf('uniformRing?.takeRetired()')
    expect(src.slice(ringDrain, ringDrain + 500)).toContain('_splitBind?.takeRetired()')
    expect(src).toContain('_splitBind?.destroy()')
    expect(src).toMatch(
      /setFillRhi\(state[\s\S]{0,400}?_splitBind\?\.setLayout\(state\.split\.layout\)/,
    )
    // Both grow wires reach the single rebind handler (bind-group retire +
    // bundle invalidation): the tile arena's via setOnGrow, and the handler
    // itself must invalidate BOTH.
    expect(src).toContain('_tileUniforms.setOnGrow(() => this._onSplitRebind())')
    expect(src).toMatch(
      /_onSplitRebind\(\): void \{[\s\S]{0,200}?invalidateBindGroup\(\)[\s\S]{0,200}?bundleCache\.invalidateAll\(\)/,
    )
  })

  it('the per-tile split resolve stays inside the qualifying gate (unclipped, sliced)', () => {
    // #2042 INC-4c hoisted the resolve to tile-loop scope so fills AND the
    // stroke queue share it; the extrude exclusion moved to recordFillDraw's
    // !bindZBuffer guard (asserted in its own suite), so the gate here is
    // the tile-level pair: unclipped + a real slice identity.
    const at = src.indexOf('_tileUniforms.offsetOf(')
    expect(at, 'split residency lookup not found').toBeGreaterThan(0)
    const before = src.slice(Math.max(0, at - 700), at)
    expect(before).toContain('visibleKey < 0')
    expect(before).toContain("sliceLayer !== ''")
  })
})
