// #2560 — `resetRenderedDraws` must cost what was DRAWN, not what the outer map
// has accumulated.
//
// The render-scoped dedup is `Map<tileKey, Map<subKey, …>>` and nothing ever
// removes an outer entry (#2495 made the inner maps reusable on purpose — the
// tile set is stable frame to frame). Resetting by walking `values()` therefore
// walked every tile key the renderer had ever drawn, once per `render()` — and
// `render()` is per ShowCommand, ~106x per frame on OFM Bright, not per frame.
//
// An owner CPU profile of the deployed build measured that walk at 44.2 ms
// against 21.3 ms for the `hasDrawn` + `markDrawn` pair it exists to serve: the
// bookkeeping cost twice the lookups it maintained.
//
// The fix is a list of keys touched since the last reset. Its correctness rests
// on one invariant, which the rows below hold it to:
//
//     an inner map is non-empty  ⟹  its key is in `_dirtyKeys`
//
// established because an inner map goes non-empty ONLY in `markDrawn`, which
// appends the key exactly on that empty→non-empty transition.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FrameDrawStats } from './frame-draw-stats'

const HERE = dirname(fileURLToPath(import.meta.url))

/** One drawn tile, spelled the way `renderTileKeys` spells it. */
function draw(s: FrameDrawStats, key: number, sub = 0): void {
  s.markDrawn(key, sub, 3, 0, 3, 14)
}

describe('resetRenderedDraws — clears everything it must (#2560)', () => {
  it('every marked key reads undrawn after the reset', () => {
    // The load-bearing row: it is what goes red if the touched-key list ever
    // misses a key, which is the ONLY way the cheaper reset can be wrong. A
    // missed key would leave a stale dedup entry and silently skip that tile's
    // next draw — the Korea fill-drop failure mode (2026-05-10) from the other
    // side.
    const s = new FrameDrawStats()
    s.beginFrame()
    const keys = [1, 5, 21, 1365, 395_633_048, 4 ** 11 + 7]
    for (const k of keys) draw(s, k)
    for (const k of keys) expect(s.hasDrawn(k, 0), `marked ${k}`).toBe(true)
    s.resetRenderedDraws()
    for (const k of keys) expect(s.hasDrawn(k, 0), `cleared ${k}`).toBe(false)
  })

  it('clears every SUB-key of a tile, not just the one that made it dirty', () => {
    // The list holds outer keys; the reset clears each key's whole inner map.
    // A fix that instead remembered (key, sub) pairs and deleted them one by
    // one would pass the row above and still be wrong here if it deduplicated
    // by outer key.
    const s = new FrameDrawStats()
    s.beginFrame()
    for (const sub of [0, 1, 2, 3]) draw(s, 24_146, sub)
    for (const sub of [0, 1, 2, 3]) expect(s.hasDrawn(24_146, sub)).toBe(true)
    s.resetRenderedDraws()
    for (const sub of [0, 1, 2, 3]) expect(s.hasDrawn(24_146, sub), `sub ${sub}`).toBe(false)
  })

  it('a key drawn in one render does not leak into any later one', () => {
    // Three renders, because a list emptied by the reset could still be right
    // for exactly one cycle. The key is drawn only in render 1.
    const s = new FrameDrawStats()
    s.beginFrame()
    draw(s, 96_587)
    s.resetRenderedDraws()
    expect(s.hasDrawn(96_587, 0), 'render 2').toBe(false)
    s.resetRenderedDraws()
    expect(s.hasDrawn(96_587, 0), 'render 3').toBe(false)
  })

  it('a key can go dirty again after being cleared', () => {
    // The empty→non-empty transition has to be re-detected, not latched. If the
    // list were only ever appended to on FIRST sight of a key, the second
    // render's draw would never be cleared.
    const s = new FrameDrawStats()
    s.beginFrame()
    draw(s, 42)
    s.resetRenderedDraws()
    draw(s, 42)
    expect(s.hasDrawn(42, 0), 'redrawn').toBe(true)
    s.resetRenderedDraws()
    expect(s.hasDrawn(42, 0), 'and cleared again').toBe(false)
  })

  it('repeated marks of one key inside a render stay correct', () => {
    // `markDrawn` on an already-dirty key must not re-append (that would grow
    // the list without bound inside a single render), and must not disturb the
    // entry either. Behaviour is what is observable here; the size property is
    // pinned by the source gate below.
    const s = new FrameDrawStats()
    s.beginFrame()
    for (let i = 0; i < 50; i++) draw(s, 7, 0)
    expect(s.hasDrawn(7, 0)).toBe(true)
    s.resetRenderedDraws()
    expect(s.hasDrawn(7, 0)).toBe(false)
  })
})

describe('resetRenderedDraws — and costs what was drawn (#2560)', () => {
  const SRC = readFileSync(join(HERE, 'frame-draw-stats.ts'), 'utf8')

  it('does not walk the whole outer map', () => {
    // The behaviour rows above pass under BOTH the O(all keys) walk and the
    // O(drawn) list — clearing too much is still clearing. Only this row
    // distinguishes them, which is the whole reason the change exists.
    const at = SRC.indexOf('resetRenderedDraws(): void {')
    expect(at, 'the method must exist').toBeGreaterThan(-1)
    const body = SRC.slice(at, SRC.indexOf('\n  }', at))
    expect(body, 'the retired whole-map walk').not.toMatch(/renderedDraws\.values\(\)/)
    // Non-vacuity: it reads the touched-key list and empties it.
    expect(body).toContain('_dirtyKeys')
    expect(body).toMatch(/_dirtyKeys\.length = 0/)
  })

  it('the list is appended from the empty→non-empty transition alone', () => {
    // Pins WHERE the invariant is established. An append moved anywhere else in
    // `markDrawn` — before the `get`, or unconditionally — either misses keys
    // or grows the list per draw, and the behaviour rows cannot see the second.
    const at = SRC.indexOf('markDrawn(')
    const body = SRC.slice(at, SRC.indexOf('\n  }', at))
    expect(body).toMatch(/if \(inner\.size === 0\) this\._dirtyKeys\.push\(key\)/)
    expect([...body.matchAll(/_dirtyKeys\.push\(/g)].length, 'exactly one append site').toBe(1)
  })
})
