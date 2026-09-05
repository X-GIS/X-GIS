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
    const hook = src.match(
      /_releaseTileHook = \(handleKey: string,[^)]*\): void => \{([\s\S]*?)\n {2}\}/,
    )
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

  it('the split stamps are the FRAME id, never the per-render counter (#2309)', () => {
    // `syncFrame` / `syncShow` dedup on the `frame` argument and are documented
    // "ONCE per frame". They used to be handed `this.frameCount`, which
    // increments in BOTH render() bodies — i.e. once per ShowCommand, ~95 a
    // frame on a dense style (#2273 measured the same cadence for cancelStale).
    // So the guard never fired inside a frame: measured 11.5 syncFrame calls per
    // frame across 11.5 DISTINCT stamps, re-copying and re-uploading a frame
    // block whose span bytes hashed to ONE value all frame long.
    //
    // `this.currentFrameId` is the real per-frame id — set by beginFrame(frameId),
    // which render-loop.ts calls once per frame with the map's own _frameCount.
    // A source scan, not a unit test, because the class-side guard is already
    // proven in uniform-split-bind.test.ts: the defect was never in the class,
    // it was in what the caller passed, and only the call site can show that.
    for (const m of src.matchAll(/_splitBind!?\.syncFrame\(([^)]*)\)/g)) {
      expect(m[1], 'syncFrame stamp').toContain('this.currentFrameId')
      expect(m[1], 'syncFrame stamp must not be the per-render counter').not.toContain(
        'this.frameCount',
      )
    }
    for (const m of src.matchAll(/_splitBind!?\.syncShow\(([\s\S]*?)\n\s*\)/g)) {
      expect(m[1], 'syncShow stamp').toContain('this.currentFrameId')
      expect(m[1], 'syncShow stamp must not be the per-render counter').not.toContain(
        'this.frameCount',
      )
    }
    // Non-vacuity (#996): the scan must actually have found the call sites.
    expect([...src.matchAll(/_splitBind!?\.syncFrame\(/g)].length).toBe(3)
    expect([...src.matchAll(/_splitBind!?\.syncShow\(/g)].length).toBe(3)
  })

  it('the per-tile split resolve stays inside the qualifying gate (unclipped, sliced)', () => {
    // #2042 INC-4c hoisted the resolve to tile-loop scope so fills AND the
    // stroke queue share it; the extrude exclusion moved to recordFillDraw's
    // !bindZBuffer guard (asserted in its own suite), so the gate here is
    // the tile-level pair: unclipped + a real slice identity. INC-5 added a
    // SECOND residency lookup ahead of it — the walk-skip — whose gate is the
    // per-call splitWalkSkip qualification; both sites are pinned.
    const first = src.indexOf('_tileUniforms.offsetOf(')
    expect(first, 'walk-skip residency lookup not found').toBeGreaterThan(0)
    const second = src.indexOf('_tileUniforms.offsetOf(', first + 1)
    expect(second, 'pack-path residency lookup not found').toBeGreaterThan(first)
    // Walk-skip site: gated on the per-call qualification + a completed seed pack.
    expect(src.slice(Math.max(0, first - 700), first)).toContain('splitWalkSkip && packedOnce')
    // Pack-path resolve: unclipped + a real slice identity.
    const before = src.slice(Math.max(0, second - 700), second)
    expect(before).toContain('visibleKey < 0')
    expect(before).toContain("sliceLayer !== ''")
    // The qualification lives in the SINGLE ring-free authority
    // (_walkRingFree, #2042 INC-5b) — consulted by BOTH renderTileKeys'
    // splitWalkSkip and the bundle-key builder's ringCursor sentinel; drift
    // between them would re-couple the keys the sentinel decouples. Pin the
    // authority's terms, the delegation, and both key sites.
    const qual = src.indexOf('private _walkRingFree(')
    expect(qual, '_walkRingFree authority not found').toBeGreaterThan(0)
    const qualBody = src.slice(qual, qual + 1600)
    for (const term of [
      'visibleKeysForClip === null',
      "sliceLayer !== ''",
      'baseLayout()',
      '_patternUniformActive',
      '_linePatternActiveForShow',
      "currentExtrudeMode !== 'per-feature'",
      'translucentLines',
      'lineVariant == null',
      'isOverdrawActive',
      'perStyleTwin',
    ]) {
      expect(qualBody, `_walkRingFree lost the "${term}" qualification`).toContain(term)
    }
    expect(src).toContain('const splitWalkSkip = this._walkRingFree(')
    // INC-5b — the primary bundle key uses the -2 sentinel for ring-free
    // walks; the fallback-clip key always uses the live cursor.
    expect(src).toMatch(/ringCursor: this\._walkRingFree\([\s\S]{0,300}?\)\s*\?\s*-2\s*:/)
    expect(src).toContain('ringCursor: this._ringCursorForBundleKey(),')
    // The ring-alloc invariant exemption rides the qualification: every call
    // must publish it, and the bundle-hit invariant must read it — a walk
    // that skips packs allocs FEWER ring slots than its bundle recorded
    // (residency transitions), which is only sound because nothing baked
    // reads those slots. Gate2 2026-08-25 caught the unexempted invariant
    // halting the render loop ("allocated 1 ring slots where the encoded
    // bundle recorded 2").
    expect(src).toContain('this._lastWalkRingFree = splitWalkSkip')
    expect(src).toMatch(/if \(_inv && !this\._lastWalkRingFree\) \{/)
    // #2042 INC-4d — the qualification's fill term must be capability-based
    // (default pipes OR an eligible per-style twin), and the stroke clause
    // must consult the draper's derivation verdict — NOT a bare
    // `lineVariant == null` (which excluded every compiled show: constant
    // paints inline as preamble consts, so all converted-style fills are
    // per-style; the class the walk-skip exists for).
    expect(src).toContain('const splitFillsCapable =')
    const cap = src.indexOf('const splitFillsCapable =')
    const capBody = src.slice(cap, cap + 600)
    expect(capBody).toContain('perStyleTwin')
    expect(qualBody).toContain('splitFillsCapable')
    expect(qualBody).toContain('splitStrokeEligible(lineVariant)')
    expect(qualBody).toContain('!drawStrokes ||')
  })
})
