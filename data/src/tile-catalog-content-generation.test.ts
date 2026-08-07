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
  it('does NOT move on a first write — nothing was drawing that key yet', () => {
    const catalog = new TileCatalog()
    const before = catalog.contentGeneration()
    write(catalog, tileKey(2, 1, 1), 'l')
    expect(
      catalog.contentGeneration(),
      'a first write is not a replacement: bumping here would repack every ' +
        'tile-point buffer on every tile that lands, which is the cost #1581 removed',
    ).toBe(before)
  })

  it('moves on an OVERWRITE of the same key + layer', () => {
    const catalog = new TileCatalog()
    const key = tileKey(2, 1, 1)
    write(catalog, key, 'l') // first write — establishes the entry
    const afterFirst = catalog.contentGeneration()

    write(catalog, key, 'l') // re-tile of a key already served
    expect(
      catalog.contentGeneration(),
      'a re-tiled key must be observable: the tile-point pack cache skips its ' +
        'getTileData re-read on a hit, so an unobservable replacement redraws the ' +
        'superseded geometry indefinitely',
    ).not.toBe(afterFirst)
  })

  it('CONTROL — indexGeneration CANNOT see that same overwrite', () => {
    // The reason a new signal was needed rather than reusing the existing one.
    // Without this control, `contentGeneration` might look redundant.
    const catalog = new TileCatalog()
    const key = tileKey(2, 1, 1)
    write(catalog, key, 'l')
    const idxAfterFirst = catalog.indexGeneration()
    write(catalog, key, 'l')
    expect(catalog.indexGeneration(), 'index entries only grow — the overwrite is invisible').toBe(
      idxAfterFirst,
    )
  })

  it('moves once per replacement, so consecutive replacements stay distinguishable', () => {
    // The consumer compares against LAST FRAME's value, so two replacements in
    // separate frames must not collapse into one observable change.
    const catalog = new TileCatalog()
    const key = tileKey(2, 1, 1)
    write(catalog, key, 'l')
    const g0 = catalog.contentGeneration()
    write(catalog, key, 'l')
    const g1 = catalog.contentGeneration()
    write(catalog, key, 'l')
    const g2 = catalog.contentGeneration()
    expect(new Set([g0, g1, g2]).size, 'each replacement is separately observable').toBe(3)
  })
})
