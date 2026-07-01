import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { mercator } from '@xgis/engine'
import { reprojectFeatureCollection } from '../data/sources/reproject-fc'
import type { GeoJSONFeatureCollection } from '@xgis/data'

// ═══ EPSG input-reprojection cross-validation (AC5) ═══
//
// This test verifies that the X-GIS EPSG→WGS84 reprojection pipeline
// produces FINAL Web Mercator (EPSG:3857) coordinates that match the
// pyproj reference within 1 mm (1e-3 m), the tolerance decided by the
// AC0 spike (max observed divergence ≈ 3.7 nm — pure f64 round-off).
//
// Pipeline under test:
//   reprojectFeatureCollection(fc, fromEPSG)  →  WGS84 lon/lat
//   mercator.forward(lon, lat)                →  EPSG:3857 metres
//
// The reference values (refMercX, refMercY) were computed by pyproj in
// scripts/cross-validation/generate-fixtures.py and are committed to the
// fixture file. When pyproj and X-GIS agree to <1 mm on the final
// Mercator metres, the reprojection is correct end-to-end.

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(__dirname, './cross-validation.fixture.json')

interface EpsgReprojectionSample {
  label: string
  fromEPSG: string
  inputX: number
  inputY: number
  refMercX: number
  refMercY: number
}

interface FixtureSubset {
  epsg_reprojection: EpsgReprojectionSample[]
}

const fixture: FixtureSubset = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

// ─── tolerance ───────────────────────────────────────────────────────────────
// 1 mm in EPSG:3857 metres. Decided by AC0 spike: proj4js vs pyproj
// EPSG:5179/5186 measured at final Web Mercator gave max divergence ≈ 3.7 nm.
// The 1 mm bound leaves ~6 orders of magnitude of margin.
const TOLERANCE_M = 1e-3 // 1 mm

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Wrap a single (x, y) point as a GeoJSON Point FeatureCollection. */
function pointFC(x: number, y: number): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [x, y] },
        properties: {},
      },
    ],
  }
}

/** Extract the single Point coordinate from a reprojected FeatureCollection. */
function extractLonLat(fc: GeoJSONFeatureCollection): [number, number] {
  const geom = fc.features[0]!.geometry as { type: string; coordinates: number[] }
  return [geom.coordinates[0]!, geom.coordinates[1]!]
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('EPSG reprojection cross-validation: final Web Mercator <1 mm vs pyproj (AC5)', () => {
  // Group samples by EPSG code for cleaner failure messages.
  const byEPSG = new Map<string, EpsgReprojectionSample[]>()
  for (const s of fixture.epsg_reprojection) {
    if (!byEPSG.has(s.fromEPSG)) byEPSG.set(s.fromEPSG, [])
    byEPSG.get(s.fromEPSG)!.push(s)
  }

  for (const [epsgCode, samples] of byEPSG) {
    it(`${epsgCode} → WGS84 → MM: all ${samples.length} points within ${TOLERANCE_M * 1000} mm of pyproj`, () => {
      for (const s of samples) {
        // Step 1: EPSG:n → WGS84 lon/lat via reprojectFeatureCollection.
        const fc = pointFC(s.inputX, s.inputY)
        const reprojected = reprojectFeatureCollection(fc, s.fromEPSG)
        const [lon, lat] = extractLonLat(reprojected)

        // Step 2: WGS84 lon/lat → EPSG:3857 metres via the pipeline's own
        // mercator.forward — same path the tile pipeline takes.
        const [mercX, mercY] = mercator.forward(lon, lat)

        // Assert within 1 mm of pyproj's EPSG:3857 reference.
        const dX = Math.abs(mercX - s.refMercX)
        const dY = Math.abs(mercY - s.refMercY)

        expect(
          dX,
          `${epsgCode} "${s.label}" X: got ${mercX.toFixed(4)}, ref ${s.refMercX.toFixed(4)}, delta ${dX.toExponential(3)} m`,
        ).toBeLessThan(TOLERANCE_M)

        expect(
          dY,
          `${epsgCode} "${s.label}" Y: got ${mercY.toFixed(4)}, ref ${s.refMercY.toFixed(4)}, delta ${dY.toExponential(3)} m`,
        ).toBeLessThan(TOLERANCE_M)
      }
    })
  }
})
