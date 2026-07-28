// ═══ Coverage catalogue: the cell/catalogue discriminator, STAC parse, viewport select ═══
//
// Gates the PURE half of #1453. Three things must hold:
//
//  1. The discriminator reads BYTES, not URLs — that is what lets a coverage `url:` name
//     either a cell or a catalogue with no new source type and no DSL change.
//  2. A published catalogue is read as STAC, tolerantly: one malformed item never costs the
//     user the rest of the catalogue, but a document that is not an ItemCollection at all
//     fails LOUDLY (a coverage that silently draws nothing is the §12 failure mode).
//  3. The viewport ordering rule is EXACTLY the one it replaces. The witnesses below are
//     ported verbatim from `playground/src/examples/s111-models.test.ts` — same viewports,
//     same expected keys — so "we moved the rule" is proven rather than asserted.

import { describe, it, expect } from 'vitest'
import { isHdf5 } from '@xgis/data'
import { setLogSink } from '@xgis/shared'
import {
  itemsForView,
  parseCoverageCatalogue,
  type CoverageCatalogueItem,
} from './coverage-catalogue'
import type { Bbox } from '@xgis/data'

const LABEL = 'coverage source "currents"'

/** A STAC ItemCollection feature with a `data`-roled asset. */
function item(id: string, bbox: number[], href = `${id}.h5`): unknown {
  return {
    type: 'Feature',
    stac_version: '1.0.0',
    id,
    bbox,
    geometry: null,
    properties: { datetime: '2026-07-28T00:00:00Z' },
    assets: { data: { href, type: 'application/x-hdf5', roles: ['data'] } },
  }
}
const collection = (features: unknown[]): unknown => ({
  type: 'FeatureCollection',
  stac_version: '1.0.0',
  features,
})

/** Silence (and capture) the skip warnings so a tolerant parse does not spam the run. */
function withCapturedLog<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = []
  setLogSink((level, message) => {
    if (level === 'warn') warnings.push(message)
  })
  try {
    return { value: fn(), warnings }
  } finally {
    setLogSink(null)
  }
}

describe('cell vs catalogue: the discriminator is the HDF5 signature (#1453)', () => {
  const HDF5_HEAD = Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x08])

  it('an S-100 cell is recognised by its signature', () => {
    expect(isHdf5(HDF5_HEAD)).toBe(true)
  })

  it('a JSON catalogue is not', () => {
    expect(isHdf5(new TextEncoder().encode('{"type":"FeatureCollection"'))).toBe(false)
  })

  it('a truncated read is not HDF5 — never a partial match', () => {
    expect(isHdf5(HDF5_HEAD.slice(0, 7))).toBe(false)
    expect(isHdf5(new Uint8Array(0))).toBe(false)
  })

  it('one wrong byte is enough — the whole signature must match', () => {
    // The final byte is `\n` (0x0a). A near-miss here is exactly the typo a hand-copied
    // magic number makes, and it would route every real cell into the JSON parse.
    const nearMiss = Uint8Array.from(HDF5_HEAD)
    nearMiss[7] = 0x08
    expect(isHdf5(nearMiss)).toBe(false)
  })
})

describe('parseCoverageCatalogue — STAC ItemCollection (#1453)', () => {
  it('reads id, bbox and the data asset href', () => {
    const items = parseCoverageCatalogue(
      collection([item('cbofs', [-77.3, 36.0, -74.9, 39.6], '/noaa-s111/latest/cbofs.h5')]),
      '/noaa-s111/catalog.json',
      LABEL,
    )
    expect(items).toEqual([
      { id: 'cbofs', bbox: [-77.3, 36.0, -74.9, 39.6], href: '/noaa-s111/latest/cbofs.h5' },
    ])
  })

  it('resolves a RELATIVE href against the catalogue URL, and passes absolute ones through', () => {
    const items = parseCoverageCatalogue(
      collection([
        item('a', [0, 0, 1, 1], 'cells/a.h5'),
        item('b', [0, 0, 1, 1], '/abs/b.h5'),
        item('c', [0, 0, 1, 1], 'https://example.com/c.h5'),
      ]),
      '/noaa-s111/catalog.json',
      LABEL,
    )
    expect(items.map((i) => i.href)).toEqual([
      '/noaa-s111/cells/a.h5',
      '/abs/b.h5',
      'https://example.com/c.h5',
    ])
  })

  it('accepts STAC 3D bbox (6 numbers) by taking the horizontal envelope', () => {
    const items = parseCoverageCatalogue(
      collection([item('deep', [-77.3, 36.0, -50, -74.9, 39.6, 0])]),
      '/c.json',
      LABEL,
    )
    expect(items[0]!.bbox).toEqual([-77.3, 36.0, -74.9, 39.6])
  })

  it('finds the cell asset by ROLE, by KEY, or as the only asset', () => {
    const byRole = { assets: { primary: { href: 'r.h5', roles: ['data'] } } }
    const byKey = { assets: { data: { href: 'k.h5' } } }
    const only = { assets: { whatever: { href: 'o.h5' } } }
    const items = parseCoverageCatalogue(
      collection([
        { ...(item('a', [0, 0, 1, 1]) as object), ...byRole },
        { ...(item('b', [0, 0, 1, 1]) as object), ...byKey },
        { ...(item('c', [0, 0, 1, 1]) as object), ...only },
      ]),
      '/c.json',
      LABEL,
    )
    expect(items.map((i) => i.href)).toEqual(['/r.h5', '/k.h5', '/o.h5'])
  })

  it('SKIPS a malformed item and keeps the rest — one bad entry is not a dead catalogue', () => {
    const { value, warnings } = withCapturedLog(() =>
      parseCoverageCatalogue(
        collection([
          item('good', [-77.3, 36.0, -74.9, 39.6]),
          { type: 'Feature', id: 'no-bbox', assets: { data: { href: 'x.h5' } } },
          { type: 'Feature', id: 'no-asset', bbox: [0, 0, 1, 1], assets: {} },
          item('inverted', [10, 10, 5, 5]), // west > east — can never overlap anything
        ]),
        '/c.json',
        LABEL,
      ),
    )
    expect(value.map((i) => i.id)).toEqual(['good'])
    expect(warnings).toHaveLength(3)
  })

  it('SKIPS a duplicate id — two cells under one region key is a silent overwrite', () => {
    const { value, warnings } = withCapturedLog(() =>
      parseCoverageCatalogue(
        collection([
          item('cbofs', [0, 0, 1, 1], 'first.h5'),
          item('cbofs', [2, 2, 3, 3], 'second.h5'),
        ]),
        '/c.json',
        LABEL,
      ),
    )
    expect(value.map((i) => i.href)).toEqual(['/first.h5'])
    expect(warnings[0]).toMatch(/duplicate/)
  })

  it('THROWS, naming the source, when the document is neither a cell nor an ItemCollection', () => {
    expect(() => parseCoverageCatalogue({ hello: 'world' }, '/c.json', LABEL)).toThrow(
      /coverage source "currents".*not an S-100 cell.*not a STAC ItemCollection/s,
    )
    expect(() => parseCoverageCatalogue(null, '/c.json', LABEL)).toThrow(/ItemCollection/)
  })

  it('an EMPTY ItemCollection parses to no items — valid, just nothing to draw', () => {
    expect(parseCoverageCatalogue(collection([]), '/c.json', LABEL)).toEqual([])
  })
})

// ── The ordering rule, proven identical to the demo registry it replaces ──
//
// Same bboxes as `S111_MODELS`, same viewports as its test, same expectations.
const NOAA: CoverageCatalogueItem[] = (
  [
    ['wcofs', [-134.0, 30.0, -117.0, 49.0]],
    ['gomofs', [-72.0, 39.5, -63.0, 45.5]],
    ['ngofs2', [-98.5, 27.0, -87.5, 31.0]],
    ['cbofs', [-77.3, 36.0, -74.9, 39.6]],
    ['dbofs', [-75.9, 38.0, -74.2, 40.5]],
    ['sfbofs', [-123.2, 36.9, -121.3, 38.5]],
    ['tbofs', [-83.2, 27.2, -82.4, 28.1]],
    ['ciofs', [-155.0, 58.5, -148.0, 61.5]],
  ] as const
).map(([id, bbox]) => ({ id, bbox: bbox as Bbox, href: `/latest/${id}.h5` }))

const keysFor = (view: Bbox): string[] => itemsForView(NOAA, view).map((i) => i.id)

describe('itemsForView — the S-111 mosaic ordering rule, now content-blind (#1453)', () => {
  it('picks the covering regional cell for a viewport over that region', () => {
    expect(keysFor([-76.6, 37.5, -75.9, 38.3])[0]).toBe('cbofs')
  })

  it('breaks a containment tie toward the SMALLER (more local) bbox', () => {
    // A San Francisco Bay view sits fully inside BOTH sfbofs (local) and wcofs (the whole
    // West Coast). Both overlaps equal the view area → tie → the local, higher-res cell wins.
    expect(keysFor([-122.6, 37.5, -122.1, 38.0])[0]).toBe('sfbofs')
  })

  it('returns nothing when the viewport covers no cell (mid-ocean)', () => {
    expect(keysFor([-160, 10, -150, 20])).toEqual([])
  })

  it('lists EVERY overlapping cell, most-overlap-first, across a boundary', () => {
    // A mid-Atlantic view spans both Chesapeake (cbofs) and Delaware (dbofs) bays. Both are
    // wanted — that is the mosaic, as opposed to a most-overlap contest with one winner.
    const keys = keysFor([-76.5, 37.5, -74.5, 39.5])
    expect(keys).toContain('cbofs')
    expect(keys).toContain('dbofs')
    expect(keys[0]).toBe('cbofs')
  })

  it('a boundary-adjacent ZOOM changes the order but never the SET — no cell is wiped', () => {
    // The case the demo needed hysteresis for: same centre, different extent. When only ONE
    // cell could be resident, this flipped it and wiped the other's arrows. Both are resident
    // now, so the set is stable and only the primary label moves — which `primaryCoverageTime`
    // does not follow, because it reads the first-ARMED region, not this order.
    const wide: Bbox = [-76.9, 37.3, -73.9, 40.3]
    const zoomedIn: Bbox = [-75.7, 38.5, -75.1, 39.1]
    expect(keysFor(wide)[0]).toBe('cbofs')
    expect(keysFor(zoomedIn)[0]).toBe('dbofs')
    expect(new Set(keysFor(wide))).toEqual(new Set(keysFor(zoomedIn)))
  })

  it('an item touching the viewport only at its EDGE is not wanted (zero overlap area)', () => {
    expect(keysFor([-74.9, 36.0, -74.0, 37.0])).not.toContain('cbofs')
  })
})

describe('itemsForView — no hidden caps', () => {
  it('returns every overlapping item; bounding residency is the renderer budget’s job', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      bbox: [0, 0, 10, 10] as Bbox,
      href: `/c${i}.h5`,
    }))
    expect(itemsForView(many, [0, 0, 10, 10])).toHaveLength(40)
  })
})
