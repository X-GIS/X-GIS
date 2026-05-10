import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { Camera } from '../engine/camera'
import { visibleTilesFrustum } from '../data/tile-select'
import { mercator } from '../engine/projection'
import { TileCatalog } from '../data/tile-catalog'
import {
  decomposeFeatures,
  compileGeoJSONToTiles,
  tileKey,
  TILE_FLAG_FULL_COVER,
} from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '@xgis/compiler'

// Real-data tile tests: load actual playground fixtures (Natural Earth
// 10m countries) and exercise the tile-selection + sub-tile-generation
// pipeline with real multi-polygon geometry. Catches regressions that
// one-feature synthetic tests miss — MultiPolygon clipping, hole
// handling, feature-id dedup across ~250 features, per-country bbox
// reject, and full-cover detection on real country-sized polygons.

const __dirname = dirname(fileURLToPath(import.meta.url))
const COUNTRIES_PATH = resolve(__dirname, '../../../playground/public/data/countries.geojson')

// Load once — 265 KB file, ~250 features, some MultiPolygon with many
// islands (Indonesia, Philippines).
let countries: GeoJSONFeatureCollection | null = null
function loadCountries(): GeoJSONFeatureCollection {
  if (countries) return countries
  const raw = readFileSync(COUNTRIES_PATH, 'utf8')
  countries = JSON.parse(raw) as GeoJSONFeatureCollection
  return countries
}

const W = 1024
const H = 768
const R = 6378137
const DEG2RAD = Math.PI / 180

function makeCam(zoom: number, pitch: number, lon: number, lat: number, bearing = 0): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  c.bearing = bearing
  return c
}

function setupSource(): TileCatalog {
  const gj = loadCountries()
  const parts = decomposeFeatures(gj.features)
  const set = compileGeoJSONToTiles(gj, { minZoom: 0, maxZoom: 0 })
  const source = new TileCatalog()
  source.addTileLevel(set.levels[0], set.bounds, set.propertyTable)
  source.setRawParts(parts, 22)
  return source
}

// Lookup the feature index by property.name (matches how
// decomposeFeatures assigns featureIndex = array order).
function featureIndexByName(name: string): number {
  const gj = loadCountries()
  return gj.features.findIndex(f => (f.properties as { name?: string } | null)?.name === name)
}

describe('Real-data: countries.geojson pipeline', () => {
  it('loads and compiles ~250 features without throwing', () => {
    const gj = loadCountries()
    expect(gj.type).toBe('FeatureCollection')
    expect(gj.features.length).toBeGreaterThan(200)
    const set = compileGeoJSONToTiles(gj, { minZoom: 0, maxZoom: 0 })
    expect(set.levels.length).toBe(1)
    expect(set.levels[0].zoom).toBe(0)
    expect(set.levels[0].tiles.size).toBeGreaterThan(0)
  })

  it('property table carries all feature names', () => {
    const gj = loadCountries()
    const set = compileGeoJSONToTiles(gj, { minZoom: 0, maxZoom: 0 })
    const pt = set.propertyTable
    const nameIdx = pt.fieldNames.indexOf('name')
    expect(nameIdx).toBeGreaterThan(-1)
    // France and Japan must both round-trip through the property
    // table. If feature decomposition reorders or drops features,
    // these lookups fail.
    const franceIdx = featureIndexByName('France')
    const japanIdx = featureIndexByName('Japan')
    expect(franceIdx).toBeGreaterThan(-1)
    expect(japanIdx).toBeGreaterThan(-1)
    expect(pt.values[franceIdx][nameIdx]).toBe('France')
    expect(pt.values[japanIdx][nameIdx]).toBe('Japan')
  })
})

describe('Real-data: tile selection covers known locations', () => {
  it('Paris at z=10 selects tiles that overlap France\'s geometry', () => {
    const cam = makeCam(10, 0, 2.3522, 48.8566)
    const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
    expect(tiles.length).toBeGreaterThan(0)
    // The camera-center tile is mandatory (see animation-coverage
    // tests). Here we additionally check the center tile's geographic
    // bounds overlap France's lon/lat range (~(-5, 41) to (10, 52)).
    const centerTile = tiles.find(t => {
      const n = Math.pow(2, t.z)
      const lonW = t.x / n * 360 - 180
      const lonE = (t.x + 1) / n * 360 - 180
      const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * t.y / n))) * 180 / Math.PI
      const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (t.y + 1) / n))) * 180 / Math.PI
      return 2.3522 >= lonW && 2.3522 < lonE && 48.8566 >= latS && 48.8566 < latN
    })
    expect(centerTile).toBeDefined()
  })

  it('Tokyo and Paris at z=10 produce disjoint tile sets (no spurious overlap)', () => {
    const camParis = makeCam(10, 0, 2.3522, 48.8566)
    const camTokyo = makeCam(10, 0, 139.6917, 35.6895)
    const parisTiles = visibleTilesFrustum(camParis, mercator, 10, W, H)
    const tokyoTiles = visibleTilesFrustum(camTokyo, mercator, 10, W, H)
    const parisKeys = new Set(parisTiles.map(t => `${t.z}/${t.x}/${t.y}`))
    for (const t of tokyoTiles) {
      expect(parisKeys.has(`${t.z}/${t.x}/${t.y}`)).toBe(false)
    }
  })
})

describe('Real-data: sub-tile generation for country interiors', () => {
  it('whenever a real-data sub-tile is full-cover, the quad shape is correct', () => {
    // Sweep a handful of candidate interior locations at z=12-14.
    // Real borders are fractal (rivers, disputed zones, tiny islands
    // in 10m admin data) so we don't require any specific hit — but
    // every time full-cover DOES fire on real data, the synthesized
    // quad MUST have the expected shape (4 vertices × stride 5 = 20
    // floats, 6 indices). The strict zoom-animation test below
    // guarantees that full-cover fires for France/Paris at some
    // zoom, so this is a supplementary shape check.
    const source = setupSource()
    const candidates: Array<{ lon: number; lat: number; z: number }> = [
      { lon: 2,    lat: 25,  z: 14 },
      { lon: 100,  lat: 45,  z: 14 },
      { lon: 25,   lat: -20, z: 14 },
      { lon: -60,  lat: -15, z: 14 },
      { lon: 135,  lat: -25, z: 14 },
    ]
    for (const c of candidates) {
      source.resetCompileBudget()
      const n = Math.pow(2, c.z)
      const tx = Math.floor((c.lon + 180) / 360 * n)
      const clampedLat = Math.max(-85.051129, Math.min(85.051129, c.lat))
      const ty = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n)
      const key = tileKey(c.z, tx, ty)
      source.compileTileOnDemand(key)
      const entry = source.getIndex()!.entryByHash.get(key)
      if (!entry || (entry.flags & TILE_FLAG_FULL_COVER) === 0) continue
      const data = source.getTileData(key)
      expect(data).not.toBeNull()
      expect(data!.vertices.length).toBe(20)
      expect(data!.indices.length).toBe(6)
    }
  })

  it('z=10 sub-tile over mid-Atlantic ocean has NO full-cover flag', () => {
    // (-30, 30) is deep Atlantic — no country polygon covers it.
    // compileTileOnDemand may either return null (no geometry) or a
    // non-full-cover entry. Either way the entry MUST NOT claim
    // full-cover of some bogus feature id.
    const source = setupSource()
    const z = 10
    const n = Math.pow(2, z)
    const tx = Math.floor((-30 + 180) / 360 * n)
    const clampedLat = Math.max(-85.051129, Math.min(85.051129, 30))
    const ty = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n)
    const key = tileKey(z, tx, ty)

    source.compileTileOnDemand(key)
    const entry = source.getIndex()!.entryByHash.get(key)
    // No full-cover over open ocean.
    if (entry) {
      expect(entry.flags & TILE_FLAG_FULL_COVER).toBe(0)
    }
  })

  it('sub-tile at a country border carries geometry but NOT the full-cover flag', () => {
    // (8, 48) is near the French-German border in Alsace — the z=8
    // tile straddles multiple countries.
    const source = setupSource()
    const z = 8
    const n = Math.pow(2, z)
    const tx = Math.floor((8 + 180) / 360 * n)
    const clampedLat = Math.max(-85.051129, Math.min(85.051129, 48))
    const ty = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n)
    const key = tileKey(z, tx, ty)

    source.compileTileOnDemand(key)
    const entry = source.getIndex()!.entryByHash.get(key)
    expect(entry).toBeDefined()
    // Multiple features cross this tile → cannot be single-feature
    // full-cover.
    expect(entry!.flags & TILE_FLAG_FULL_COVER).toBe(0)

    // But it should still have drawable geometry (triangulated).
    const data = source.getTileData(key)
    expect(data).not.toBeNull()
    expect(data!.vertices.length).toBeGreaterThan(0)
    expect(data!.indices.length).toBeGreaterThan(0)
  })
})

describe('Real-data: zoom-in animation over Paris', () => {
  it('every zoom frame from 5 → 15 keeps Paris covered, and high-zoom frames promote to full-cover', () => {
    const source = setupSource()
    const franceIdx = featureIndexByName('France')
    let fullCoverReachedAtZoom = -1

    for (let zoom = 5; zoom <= 15; zoom++) {
      // Reset per-frame compile budget so each iteration can compile
      // its center tile (TileCatalog caps compilations at 4/frame).
      source.resetCompileBudget()

      const cam = makeCam(zoom, 0, 2.3522, 48.8566)
      const tiles = visibleTilesFrustum(cam, mercator, zoom, W, H)
      expect(tiles.length).toBeGreaterThan(0)

      // Get the camera-center tile at this zoom.
      const n = Math.pow(2, zoom)
      const cx = Math.floor((2.3522 + 180) / 360 * n)
      const clampedLat = Math.max(-85.051129, Math.min(85.051129, 48.8566))
      const cy = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n)
      const centerKey = tileKey(zoom, cx, cy)

      // Trigger sub-tile generation and check the resulting entry.
      source.compileTileOnDemand(centerKey)
      const entry = source.getIndex()!.entryByHash.get(centerKey)
      expect(entry).toBeDefined()

      // At sufficiently high zoom the Paris-center tile falls entirely
      // inside France → full-cover quad with France's feature id.
      // Record the first zoom where this happens.
      if (entry!.flags & TILE_FLAG_FULL_COVER) {
        expect(entry!.fullCoverFeatureId).toBe(franceIdx)
        if (fullCoverReachedAtZoom === -1) fullCoverReachedAtZoom = zoom
      }
    }

    // France is big enough that a z=15 tile over Paris is definitely
    // full-cover. If convergence never happens, something broke the
    // full-cover detection chain.
    expect(fullCoverReachedAtZoom).toBeGreaterThan(-1)
    expect(fullCoverReachedAtZoom).toBeLessThanOrEqual(15)
  })
})
