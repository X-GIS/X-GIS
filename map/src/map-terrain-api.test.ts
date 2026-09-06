// `map.setTerrain()` / `map.getTerrain()` — the terrain facade (D5, #2539).
//
// The facade exists to hide two things the raw lever
// (`map.hillshadeRenderer.setTerrainExaggeration`) forces a caller to know: that
// 3D displacement is owned by the HILLSHADE renderer, and that every renderer
// install starts a fresh one at 0. The second is the footgun, so the re-apply
// wiring is gated here as well as the semantics.

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { XGISMap } from './map'
import type { TerrainOptions } from './map-types'

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

interface Internals {
  setTerrain(t: TerrainOptions | null): void
  getTerrain(): TerrainOptions | null
  applyTerrain(): void
  hillshadeRenderer?: { setTerrainExaggeration: (e: number) => void }
}

describe('#2539 — the terrain facade', () => {
  let map: Internals
  let set: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    map = new XGISMap(mockCanvas()) as unknown as Internals
    set = vi.fn()
    // The stub carries ONLY the method the facade is allowed to call — if the
    // facade ever reaches for more of the renderer, this test breaks loudly
    // instead of the production path breaking quietly (§12: a hand-rolled double
    // cast `as unknown as` is invisible to tsc).
    map.hillshadeRenderer = { setTerrainExaggeration: set }
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('is off by default — getTerrain() is null and nothing was pushed', () => {
    expect(map.getTerrain()).toBeNull()
    expect(set).not.toHaveBeenCalled()
  })

  it('setTerrain({}) means ON at 1x, as Mapbox does', () => {
    map.setTerrain({})
    expect(map.getTerrain()).toEqual({ exaggeration: 1 })
    expect(set).toHaveBeenLastCalledWith(1)
  })

  it('carries an explicit exaggeration through to the renderer', () => {
    map.setTerrain({ exaggeration: 2.5 })
    expect(map.getTerrain()).toEqual({ exaggeration: 2.5 })
    expect(set).toHaveBeenLastCalledWith(2.5)
  })

  it('setTerrain(null) turns it off — the renderer is pushed 0, not left stale', () => {
    map.setTerrain({ exaggeration: 3 })
    map.setTerrain(null)
    expect(map.getTerrain()).toBeNull()
    // The push matters more than the getter: a facade that only forgot its own
    // state would leave the GROUND displaced while reporting terrain off.
    expect(set).toHaveBeenLastCalledWith(0)
  })

  it('exaggeration 0 is kept as an explicit state, distinct from null', () => {
    map.setTerrain({ exaggeration: 0 })
    expect(map.getTerrain()).toEqual({ exaggeration: 0 })
    expect(set).toHaveBeenLastCalledWith(0)
  })

  it.each([
    ['negative', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('rejects %s without disturbing the state in force', (_label, bad) => {
    map.setTerrain({ exaggeration: 4 })
    set.mockClear()
    map.setTerrain({ exaggeration: bad })
    expect(warnSpy).toHaveBeenCalled()
    expect(map.getTerrain()).toEqual({ exaggeration: 4 })
    expect(set, 'a rejected value must not reach the renderer at all').not.toHaveBeenCalled()
  })

  it('getTerrain() returns a copy — mutating it cannot reach the map', () => {
    map.setTerrain({ exaggeration: 2 })
    const got = map.getTerrain()!
    got.exaggeration = 99
    expect(map.getTerrain()).toEqual({ exaggeration: 2 })
  })

  it('THE FOOTGUN: a terrain set before any renderer exists still reaches the one installed later', () => {
    const fresh = new XGISMap(mockCanvas()) as unknown as Internals
    expect(fresh.hillshadeRenderer, 'no renderer before run()').toBeUndefined()
    fresh.setTerrain({ exaggeration: 1.5 }) // must not throw, must be remembered
    expect(fresh.getTerrain()).toEqual({ exaggeration: 1.5 })

    const late = vi.fn()
    fresh.hillshadeRenderer = { setTerrainExaggeration: late } // what run() does
    fresh.applyTerrain() // ...followed by this — the wiring gated below
    expect(late).toHaveBeenCalledWith(1.5)
  })
})

describe('#2539 — ONE install authority, and it re-applies the terrain', () => {
  // The behavioural tests above prove `applyTerrain()` works; they cannot prove the boot
  // paths CALL it, and a missing call is exactly the silent bug the facade exists to
  // prevent — invisible to tsc. Gate it on the source.
  //
  // This started as "every `this.hillshadeRenderer = rendererSet.hillshadeRenderer` is
  // followed by applyTerrain()", over the two hand-rolled copies `runScene` and
  // `runBinary` carried. Adding one line to both tipped them past the duplication
  // ratchet's threshold, which was right: the copies were the reason a boot path could
  // forget. They are now one `installRendererSet`, so the invariant gets STRONGER —
  // exactly one installer, and every boot path goes through it. A third boot path that
  // hand-rolls the assignments reds here instead of silently shipping flat ground.
  const SRC = readFileSync(new URL('./map.ts', import.meta.url), 'utf8').split('\n')
  const at = (re: RegExp) => SRC.map((l, i) => [l, i] as const).filter(([l]) => re.test(l))
  const installs = at(/this\.hillshadeRenderer = rendererSet\.hillshadeRenderer/)
  const boots = at(/buildSceneRenderers\(/)

  it('the instrument finds the boot paths at all (a zero here would pass vacuously)', () => {
    expect(
      boots.length,
      'map.ts builds a renderer set in at least two places',
    ).toBeGreaterThanOrEqual(2)
  })

  it('exactly ONE place installs a renderer set', () => {
    expect(installs.length, 'a second installer is a second place to forget applyTerrain()').toBe(1)
  })

  it('that one place re-applies the map-owned terrain intent', () => {
    expect(SRC[installs[0][1] + 1], `map.ts:${installs[0][1] + 2}`).toContain('this.applyTerrain()')
  })

  it.each(boots.map(([, i]) => i))('the boot path at map.ts:%i installs through it', (i) => {
    expect(
      SRC.slice(i, i + 8).join('\n'),
      `map.ts:${i + 1} must not hand-roll the install`,
    ).toContain('this.installRendererSet(rendererSet)')
  })
})
