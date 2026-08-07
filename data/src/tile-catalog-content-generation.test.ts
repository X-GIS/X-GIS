// ═══ contentGeneration distinguishes a REPLACED tile from a newly-landed one (#1616) ═══
//
// `indexGeneration()` is `entryByHash.size` — index entries only ever grow, so it
// answers "has a new key landed", never "did an existing key's data change". Every
// memo keyed on it (and on the selected key set, which a re-tile also leaves alone)
// is therefore blind to a host data push / PMTiles refetch / moving feature that
// re-tiles a key already in the set.
//
// That blindness became a live stale-draw once #1581 leg B let the tile-point pack
// cache skip its per-frame `getTileData` re-read on a hit. `contentGeneration()` is
// the missing signal: it moves on OVERWRITE and only on overwrite.
//
// Fail-before: without the counter, `contentGeneration` does not exist and the
// overwrite case below cannot be distinguished from the first-write case at all.

import { describe, it, expect } from 'vitest'
import { TileCatalog } from './tile-catalog'
import { tileKey } from '@xgis/compiler'

/** `acceptResult(key, null, layer)` writes an EMPTY slice through the same
 *  `cacheTileData` path a real backend result takes — the shortest route to a
 *  first-write / overwrite pair without standing up a backend. */
function write(catalog: TileCatalog, key: number, layer: string): void {
  ;(
    catalog as unknown as {
      acceptResult(key: number, result: unknown, sourceLayer?: string): void
    }
  ).acceptResult(key, null, layer)
}

describe('TileCatalog.contentGeneration (#1616)', () => {
  it('MOVES on a first write — a tile ARRIVING for a selected key must be observable', () => {
    // This assertion was originally the opposite, on the reasoning that bumping per
    // landed tile would repack point buffers during load and give back what #1581
    // bought. That reasoning was wrong, and a probe driving the real
    // `emitTilePointsRhi` showed the cost: with `stableKeys = [1, 2]` where tile 2's
    // data lands a frame later, the sequence was REPACK / CACHED / CACHED — tile 2's
    // points were never packed at all. The selection does not change when data
    // arrives (`stableKeys` is the key SET), `indexGeneration` does not move (the
    // entry already existed), and the cache-hit path skips the `getTileData` re-read
    // that used to notice. Something must move, and the write is the only event.
    // #1581's win is at a settled camera with nothing landing — which this preserves,
    // because a frame in which no slice is written does not bump.
    const catalog = new TileCatalog()
    const before = catalog.contentGeneration()
    write(catalog, tileKey(2, 1, 1), 'l')
    expect(
      catalog.contentGeneration(),
      'a tile arriving under an already-selected key is invisible to every other ' +
        'field in the pack key, so an unobservable arrival never gets packed',
    ).not.toBe(before)
  })

  it('moves on an OVERWRITE of the same key + layer', () => {
    const catalog = new TileCatalog()
    const key = tileKey(2, 1, 1)
    write(catalog, key, 'l')
    const afterFirst = catalog.contentGeneration()
    write(catalog, key, 'l') // re-tile of a key already served
    expect(
      catalog.contentGeneration(),
      'a re-tiled key must be observable: the tile-point pack cache skips its ' +
        'getTileData re-read on a hit, so an unobservable replacement redraws the ' +
        'superseded geometry indefinitely',
    ).not.toBe(afterFirst)
  })

  it('CONTROL — indexGeneration sees NEITHER event', () => {
    // The reason a new signal was needed rather than reusing the existing one. Without
    // this control `contentGeneration` might look redundant.
    const catalog = new TileCatalog()
    const key = tileKey(2, 1, 1)
    write(catalog, key, 'l')
    const idxAfterFirst = catalog.indexGeneration()
    write(catalog, key, 'l')
    expect(catalog.indexGeneration(), 'index entries only grow — both writes invisible').toBe(
      idxAfterFirst,
    )
  })

  it('CONTROL — a frame that writes nothing does NOT move it (#1581 stays bought)', () => {
    // The load-bearing half of the perf contract: the counter must be STABLE at rest,
    // or the pack would rebuild every frame and this fix would undo #1581 entirely.
    const catalog = new TileCatalog()
    write(catalog, tileKey(2, 1, 1), 'l')
    const settled = catalog.contentGeneration()
    for (let i = 0; i < 10; i++) catalog.contentGeneration()
    expect(catalog.contentGeneration(), 'no write, no change').toBe(settled)
  })

  it('moves once per write, so consecutive writes stay distinguishable', () => {
    // The consumer compares against LAST FRAME's value, so two writes in separate
    // frames must not collapse into one observable change.
    const catalog = new TileCatalog()
    const key = tileKey(2, 1, 1)
    write(catalog, key, 'l')
    const g0 = catalog.contentGeneration()
    write(catalog, key, 'l')
    const g1 = catalog.contentGeneration()
    write(catalog, key, 'l')
    const g2 = catalog.contentGeneration()
    expect(new Set([g0, g1, g2]).size, 'each write is separately observable').toBe(3)
  })
})
