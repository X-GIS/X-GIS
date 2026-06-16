import { describe, it, expect } from 'vitest'
import {
  TILE_LAYOUT_VERSION,
  TILE_LAYOUT_VERSION_BASE,
  type TileSourceMeta,
  type TileLayoutVersion,
} from './tile-source'

describe('TILE_LAYOUT_VERSION (bumped to 4 — fill f32 tail slots now tile-local Mercator)', () => {
  it('current version is exported as a numeric literal const', () => {
    expect(TILE_LAYOUT_VERSION).toBe(4)
    expect(typeof TILE_LAYOUT_VERSION).toBe('number')
  })

  it('baseline stays at the original pre-version-field value', () => {
    // PR 2c.4 bumped current to 2 because PR 2c.2 switched polygon vertex
    // bytes from Mercator-DSFUN stride-5 to ECEF-DSFUN stride-9. Baseline
    // must NOT move — it's the "what undefined means" contract for
    // pre-PR-2c-prep backends and persisted cache entries.
    expect(TILE_LAYOUT_VERSION_BASE).toBe(1)
    expect(TILE_LAYOUT_VERSION).toBeGreaterThan(TILE_LAYOUT_VERSION_BASE)
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
    expect(v).toBe(4)
  })
})
