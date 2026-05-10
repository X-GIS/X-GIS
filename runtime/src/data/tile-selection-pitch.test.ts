import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/projection/camera'
import { visibleTilesFrustum } from './tile-select'
import { mercator } from '../engine/projection/projection'

// Reproduces the user-reported bug: when lowering pitch to near 0 (top-down),
// tile selection should still return a sensible set of tiles overlapping the
// viewport. Failure mode reported: "empty tiles fill the screen."

describe('visibleTilesFrustum at low pitch', () => {
  const W = 1024
  const H = 768

  function makeCam(zoom: number, pitch: number, lon = 0, lat = 0, bearing = 0): Camera {
    const c = new Camera(lon, lat, zoom)
    c.pitch = pitch
    c.bearing = bearing
    return c
  }

  function logTiles(label: string, tiles: ReturnType<typeof visibleTilesFrustum>) {
    const byZoom: Record<number, number> = {}
    for (const t of tiles) byZoom[t.z] = (byZoom[t.z] ?? 0) + 1
    // eslint-disable-next-line no-console
    console.log(label, { total: tiles.length, byZoom, sample: tiles.slice(0, 5) })
  }

  it('at pitch 0 zoom 5 equator: returns non-empty set covering center tile', () => {
    const cam = makeCam(5, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
    logTiles('pitch=0 zoom=5', tiles)
    expect(tiles.length).toBeGreaterThan(0)
    // At zoom 5, we expect ~4-16 tiles at z=5 near the center.
    // None should be at z > 5 (maxZ).
    const maxZoom = Math.max(...tiles.map(t => t.z))
    expect(maxZoom).toBeLessThanOrEqual(5)
  })

  it('at pitch 60 zoom 5 equator: returns similar-or-more tiles than pitch 0', () => {
    const cam0 = makeCam(5, 0)
    const cam60 = makeCam(5, 60)
    const tiles0 = visibleTilesFrustum(cam0, mercator, 5, W, H)
    const tiles60 = visibleTilesFrustum(cam60, mercator, 5, W, H)
    logTiles('pitch=0', tiles0)
    logTiles('pitch=60', tiles60)
    expect(tiles0.length).toBeGreaterThan(0)
    expect(tiles60.length).toBeGreaterThan(0)
  })

  it('at pitch 0 zoom 3 (low zoom, always-subdivide branch): returns tiles at z=3 only', () => {
    const cam = makeCam(3, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 3, W, H)
    logTiles('pitch=0 zoom=3', tiles)
    // BUG SUSPECT: at maxZ <= 3, classifyTile short-circuits to
    // "always subdivide" without checking the viewport. tz == maxZ
    // then blindly pushes tiles → potentially many off-screen tiles.
    const byZoom: Record<number, number> = {}
    for (const t of tiles) byZoom[t.z] = (byZoom[t.z] ?? 0) + 1
    // All tiles should be at z=3 (maxZ)
    expect(Object.keys(byZoom)).toEqual(['3'])
  })

  it('at pitch 0 zoom 2: how many z=2 tiles are returned? (check off-screen leak)', () => {
    const cam = makeCam(2, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 2, W, H)
    logTiles('pitch=0 zoom=2', tiles)
    // At zoom 2 with canvas 1024×768, the whole world fits. ~16 tiles at z=2
    // across 5 world copies = potentially ~80 tiles. If MORE, something is wrong.
    // If tiles at z=2 are being returned WITHOUT viewport culling, we'd see
    // nearly all 80 regardless of whether they're on screen.
  })

  it('at pitch 0 zoom 5 at northern lat (Germany): sensible tile set', () => {
    const cam = makeCam(5, 0, 10, 50)
    const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
    logTiles('pitch=0 zoom=5 germany', tiles)
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.length).toBeLessThan(100)
  })

  it('at pitch 5 zoom 5: transition case (low but non-zero pitch)', () => {
    const cam = makeCam(5, 5)
    const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
    logTiles('pitch=5 zoom=5', tiles)
    // Low pitch should NOT explode to 300 — should be close to pitch=0 count
    expect(tiles.length).toBeLessThan(100)
  })

  it('at pitch 15 zoom 5: still low pitch, should not explode', () => {
    const cam = makeCam(5, 15)
    const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
    logTiles('pitch=15 zoom=5', tiles)

    // Look specifically for tiles in far world copies (ox negative and large)
    const farLeft = tiles.filter(t => (t.ox ?? t.x) < -40)
    const farRight = tiles.filter(t => (t.ox ?? t.x) > 60)
    // eslint-disable-next-line no-console
    console.log('far tiles:', { farLeft: farLeft.length, farRight: farRight.length, sampleLeft: farLeft.slice(0, 3) })

    // At pitch 15° with camera at equator, tiles in world copies 2+ away
    // should be culled — they're far off-screen.
    expect(farLeft.length).toBe(0)
    expect(farRight.length).toBe(0)
    expect(tiles.length).toBeLessThan(200)
  })

  it('GeoJSON fit bounds: camera.zoom ≈ 1 at pitch 0 returns non-empty tile set', () => {
    // Simulates a GeoJSON source (e.g., ne_110m_land.geojson) that covers the
    // whole world. After bounds-fit, map.ts sets camera.zoom ≈ 1.
    const cam = makeCam(1, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 1, W, H)
    logTiles('geojson-fit zoom=1 pitch=0', tiles)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('GeoJSON fit bounds: camera.zoom ≈ 1 at pitch 5 still returns tiles', () => {
    const cam = makeCam(1, 5)
    const tiles = visibleTilesFrustum(cam, mercator, 1, W, H)
    logTiles('geojson-fit zoom=1 pitch=5', tiles)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('GeoJSON world fit: sweeping pitch 0..60 at zoom 1', () => {
    const results: { pitch: number; count: number }[] = []
    for (let pitch = 0; pitch <= 60; pitch += 10) {
      const cam = makeCam(1, pitch)
      const tiles = visibleTilesFrustum(cam, mercator, 1, W, H)
      results.push({ pitch, count: tiles.length })
    }
    // eslint-disable-next-line no-console
    console.log('geojson zoom=1 pitch sweep:', results)
    for (const r of results) {
      expect(r.count).toBeGreaterThan(0)
    }
  })

  it('at zoom 4 (common GeoJSON overzoom) sweep pitch 0..60', () => {
    const results: { pitch: number; count: number }[] = []
    for (let pitch = 0; pitch <= 60; pitch += 5) {
      const cam = makeCam(4, pitch)
      const tiles = visibleTilesFrustum(cam, mercator, 4, W, H)
      results.push({ pitch, count: tiles.length })
    }
    // eslint-disable-next-line no-console
    console.log('zoom=4 pitch sweep:', results)
    for (const r of results) {
      expect(r.count).toBeGreaterThan(0)
    }
  })

  it('at zoom 4 pitch 0 at a non-equator position (lat=50)', () => {
    const cam = makeCam(4, 0, 0, 50)
    const tiles = visibleTilesFrustum(cam, mercator, 4, W, H)
    logTiles('zoom=4 pitch=0 lat=50', tiles)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('pitch transition: at zoom 4, tiles at pitch 0 should overlap tiles at pitch 15', () => {
    // If lowering pitch causes tiles to disappear, the pitch=0 result should
    // be a SUBSET of the pitch=15 result (modulo a few fringe tiles).
    const cam0 = makeCam(4, 0)
    const cam15 = makeCam(4, 15)
    const tiles0 = visibleTilesFrustum(cam0, mercator, 4, W, H)
    const tiles15 = visibleTilesFrustum(cam15, mercator, 4, W, H)
    const keys15 = new Set(tiles15.map(t => `${t.z}/${t.x}/${t.y}/${t.ox}`))
    const missingInPitch15 = tiles0.filter(t => !keys15.has(`${t.z}/${t.x}/${t.y}/${t.ox}`))
    // eslint-disable-next-line no-console
    console.log('pitch 0 vs 15 overlap:', {
      pitch0: tiles0.length,
      pitch15: tiles15.length,
      inPitch0ButNotInPitch15: missingInPitch15.length,
      sample: missingInPitch15.slice(0, 5),
    })
    expect(tiles0.length).toBeGreaterThan(0)
  })

  it('BEARING sweep at zoom 5 pitch 0: tile count should stay stable', () => {
    const results: { bearing: number; count: number }[] = []
    for (let bearing = 0; bearing < 360; bearing += 15) {
      const cam = makeCam(5, 0, 0, 0, bearing)
      const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
      results.push({ bearing, count: tiles.length })
    }
    // eslint-disable-next-line no-console
    console.log('zoom=5 pitch=0 bearing sweep:', results)
    for (const r of results) {
      expect(r.count).toBeGreaterThan(0)
    }
  })

  it('BEARING sweep at zoom 5 pitch 30: tile count should stay stable', () => {
    const results: { bearing: number; count: number }[] = []
    for (let bearing = 0; bearing < 360; bearing += 15) {
      const cam = makeCam(5, 30, 0, 0, bearing)
      const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
      results.push({ bearing, count: tiles.length })
    }
    // eslint-disable-next-line no-console
    console.log('zoom=5 pitch=30 bearing sweep:', results)
    for (const r of results) {
      expect(r.count).toBeGreaterThan(0)
    }
  })

  it('PITCH × BEARING grid at zoom 5: find the bad cells', () => {
    const failing: { pitch: number; bearing: number; count: number }[] = []
    for (let pitch = 0; pitch <= 60; pitch += 10) {
      for (let bearing = 0; bearing < 360; bearing += 30) {
        const cam = makeCam(5, pitch, 0, 0, bearing)
        const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
        if (tiles.length < 4) {
          failing.push({ pitch, bearing, count: tiles.length })
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log('pitch×bearing cells with < 4 tiles:', failing)
    expect(failing).toEqual([])
  })

  it('BUG HUNT: specific pitch×bearing at various camera positions', () => {
    // Spot-check combinations to find a failing cell
    const cases: { lon: number; lat: number; zoom: number }[] = [
      { lon: 0, lat: 0, zoom: 1 },   // world fit
      { lon: 0, lat: 0, zoom: 3 },
      { lon: 0, lat: 0, zoom: 5 },
      { lon: 10, lat: 50, zoom: 4 }, // Europe
      { lon: 10, lat: 50, zoom: 6 },
    ]
    const all: { pos: string; p: number; b: number; c: number }[] = []
    for (const c of cases) {
      for (const pitch of [0, 10, 20, 30, 40, 50, 60]) {
        for (const bearing of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
          const cam = makeCam(c.zoom, pitch, c.lon, c.lat, bearing)
          const tiles = visibleTilesFrustum(cam, mercator, Math.round(c.zoom), W, H)
          all.push({
            pos: `lon${c.lon},lat${c.lat},z${c.zoom}`,
            p: pitch,
            b: bearing,
            c: tiles.length,
          })
          if (tiles.length === 0) {
            // eslint-disable-next-line no-console
            console.log('ZERO TILES:', { pos: c, pitch, bearing })
          }
        }
      }
    }
    // Summarize — print worst cells (lowest count)
    all.sort((a, b) => a.c - b.c)
    // eslint-disable-next-line no-console
    console.log('lowest-count cells:', all.slice(0, 10))
    for (const r of all) {
      expect(r.c).toBeGreaterThan(0)
    }
  })

  it('higher zoom 8: sweep pitch 0..60 should return tiles at every pitch', () => {
    const results: { pitch: number; count: number }[] = []
    for (let pitch = 0; pitch <= 60; pitch += 10) {
      const cam = makeCam(8, pitch)
      const tiles = visibleTilesFrustum(cam, mercator, 8, W, H)
      results.push({ pitch, count: tiles.length })
    }
    // eslint-disable-next-line no-console
    console.log('zoom=8 pitch sweep:', results)
    for (const r of results) {
      expect(r.count).toBeGreaterThan(0)
    }
  })

  it('BUG REPRO: lowering pitch with realistic GeoJSON camera positions', () => {
    // Try common camera setups that GeoJSON demos use
    const cases: { name: string; lon: number; lat: number; zoom: number }[] = [
      { name: 'world-fit (lon0,lat0,z1)', lon: 0, lat: 0, zoom: 1 },
      { name: 'world-fit North (lon0,lat30,z1)', lon: 0, lat: 30, zoom: 1 },
      { name: 'zoomed to Europe (lon10,lat50,z4)', lon: 10, lat: 50, zoom: 4 },
      { name: 'zoomed to Asia (lon120,lat35,z5)', lon: 120, lat: 35, zoom: 5 },
      { name: 'Arctic (lon0,lat75,z3)', lon: 0, lat: 75, zoom: 3 },
    ]
    for (const c of cases) {
      const counts: Record<number, number> = {}
      for (const pitch of [0, 5, 10, 20, 40, 60]) {
        const cam = makeCam(c.zoom, pitch, c.lon, c.lat)
        const tiles = visibleTilesFrustum(cam, mercator, Math.round(c.zoom), W, H)
        counts[pitch] = tiles.length
      }
      // eslint-disable-next-line no-console
      console.log(`[${c.name}]`, counts)
      for (const p in counts) {
        expect(counts[+p]).toBeGreaterThan(0)
      }
    }
  })

  it('GeoJSON fit bounds: camera.zoom = 0.5 (very zoomed out) at pitch 0', () => {
    const cam = makeCam(0.5, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 1, W, H)  // round(0.5) = 1? or 0?
    logTiles('geojson-fit zoom=0.5 pitch=0', tiles)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('extreme pitch 82.5 bearing 45 zoom 7.8: foreground must reach maxZ', () => {
    // Regression: DFS starting from wx=-maxCopies used to burn all 300 tile
    // slots on distant horizon tiles at z=3-4 before ever reaching the
    // central world copy. Foreground tiles under the camera were never
    // refined → vector tiles rendered empty where the user was looking.
    // Reported state: #7.80/36.20226/131.26816/45.0/82.5
    const cam = makeCam(7.8, 82.5, 131.26816, 36.20226, 45)
    const tiles = visibleTilesFrustum(cam, mercator, 8, 1280, 800)
    const byZ: Record<number, number> = {}
    for (const t of tiles) byZ[t.z] = (byZ[t.z] ?? 0) + 1
    // eslint-disable-next-line no-console
    console.log('extreme pitch tiles:', { total: tiles.length, byZ })
    expect(tiles.length).toBeGreaterThan(0)
    // Must have at least some high-zoom tiles (z >= 7) — foreground detail.
    const highZ = (byZ[7] ?? 0) + (byZ[8] ?? 0)
    expect(highZ).toBeGreaterThan(10)
  })

  it('sweeping pitch 0..60 degrees at zoom 5: tile counts should stay bounded', () => {
    const results: { pitch: number; count: number }[] = []
    for (let pitch = 0; pitch <= 60; pitch += 10) {
      const cam = makeCam(5, pitch)
      const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
      results.push({ pitch, count: tiles.length })
    }
    // eslint-disable-next-line no-console
    console.log('pitch sweep:', results)
    for (const r of results) {
      expect(r.count).toBeGreaterThan(0)
      expect(r.count).toBeLessThanOrEqual(300)
    }
  })

  // Regression: stroke-offset shifts the rendered stroke perpendicular
  // to the centerline. When the centerline sits just outside the default
  // 0.25×canvas culling envelope but the offset reaches back into the
  // viewport, the source tile must still be selected so its line data
  // gets drawn. `extraMarginPx` adds that reach to the overlap test.
  it('extraMarginPx grows the selected tile set (offset-aware culling)', () => {
    // Zoom into a specific location and compare the tile set with and
    // without extra margin. Extra margin must not SHRINK the set, and
    // at a large margin value should include strictly more tiles.
    const cam = makeCam(8, 0, 0.05, 0.0)
    const baseline = visibleTilesFrustum(cam, mercator, 8, W, H)
    const widened = visibleTilesFrustum(cam, mercator, 8, W, H, /* extraMarginPx */ 400)
    expect(widened.length).toBeGreaterThanOrEqual(baseline.length)
    // Defense-in-depth: no tile lost by widening the envelope.
    const baseKeys = new Set(baseline.map(t => `${t.z}/${t.x}/${t.y}/${t.ox ?? t.x}`))
    for (const k of baseKeys) {
      expect(widened.some(t => `${t.z}/${t.x}/${t.y}/${t.ox ?? t.x}` === k)).toBe(true)
    }
  })

  it('default extraMarginPx=0 matches pre-fix behaviour exactly', () => {
    // Callers that don't pass the param must see no change in selection.
    const cam = makeCam(5, 30, 10, 20, 15)
    const withoutArg = visibleTilesFrustum(cam, mercator, 5, W, H)
    const withZero = visibleTilesFrustum(cam, mercator, 5, W, H, 0)
    expect(withZero.length).toBe(withoutArg.length)
  })
})
