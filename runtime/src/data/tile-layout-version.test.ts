import { describe, it, expect } from 'vitest'
import {
  TILE_LAYOUT_VERSION,
  TILE_LAYOUT_VERSION_BASE,
  type TileSourceMeta,
  type TileLayoutVersion,
} from './tile-source'

describe('TILE_LAYOUT_VERSION (Phase 2 PR 2c-prep scaffolding)', () => {
  it('current version is exported as a numeric literal const', () => {
    expect(TILE_LAYOUT_VERSION).toBe(1)
    expect(typeof TILE_LAYOUT_VERSION).toBe('number')
  })

  it('baseline matches current version (Phase 2 PR 2c-prep) — bump in PR 2c proper', () => {
    // Until PR 2c flips the polygon vertex layout from Mercator to ECEF,
    // baseline and current are equal. PR 2c will bump TILE_LAYOUT_VERSION
    // to 2 so older caches re-decode.
    expect(TILE_LAYOUT_VERSION).toBe(TILE_LAYOUT_VERSION_BASE)
  })

  it('TileSourceMeta accepts the optional layoutVersion field', () => {
    const meta: TileSourceMeta = {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 14,
      scheme: 'web-mercator-xyz',
      layoutVersion: TILE_LAYOUT_VERSION,
    }
    expect(meta.layoutVersion).toBe(TILE_LAYOUT_VERSION)
  })

  it('TileSourceMeta.layoutVersion is omittable (back-compat)', () => {
    // Existing backends that have not yet declared layoutVersion remain
    // type-compatible — catalog treats `undefined` as
    // TILE_LAYOUT_VERSION_BASE for back-compat.
    const meta: TileSourceMeta = {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 14,
      scheme: 'web-mercator-xyz',
    }
    expect(meta.layoutVersion).toBeUndefined()
  })

  it('TileLayoutVersion type narrows to the literal current value', () => {
    const v: TileLayoutVersion = TILE_LAYOUT_VERSION
    expect(v).toBe(1)
  })
})
