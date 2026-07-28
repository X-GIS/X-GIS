#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════
// Tile-selection pitch sweep — the deterministic repro for the
// "frame drops + permanent [FLICKER] at high pitch" report (#1427).
// ═══════════════════════════════════════════════════════════════════
//
// Reported camera (OFM Liberty): #16.00/51.50466/-0.11813/60.0/72.4
//
// Drives BOTH production selectors across a pitch sweep and prints, per
// pitch, the selected tile count and the per-zoom histogram. Pure CPU — no
// GPU, no network, no browser — so the numbers are deterministic and
// backend-independent, unlike the frame timings the report started from
// (which a software rasteriser cannot represent).
//
// WHICH SELECTOR RUNS WHERE (`map/src/render/tile-selection-cache.ts`):
//
//   visibleTilesSSE       — the VECTOR render path, i.e. the reported OFM
//                           Liberty view. This is the one that describes
//                           the report.
//   visibleTilesFrustum   — the raster renderer, the pitch>=30 prefetch
//                           (`map/src/tile-decision.ts`), and the
//                           SSE-disabled fallback.
//
// An earlier revision of this probe drove only `visibleTilesFrustum` and
// read its numbers as if they described the reported camera; they do not.
// Both are printed here so that mistake cannot repeat.
//
// Invocation:
//   bun scripts/probe-tile-selection-pitch.ts

import { visibleTilesFrustum } from '../data/src/tile-select'
import { visibleTilesSSE } from '../data/src/tiles-sse'
import { mercator } from '@xgis/geo'
import { Camera } from '../map/src/camera/camera'

const LAT = 51.50466
const LON = -0.11813
const ZOOM = 16
const BEARING = 60
const MAX_SOURCE_Z = 14 // OFM planet

/** [canvasW, canvasH, dpr, label] — the compare-harness pane the report was
 *  filed from (measured 639x704 @ dpr 1) and a plain full-window desktop. */
const VIEWPORTS: [number, number, number, string][] = [
  [639, 704, 1, 'compare pane (as reported)'],
  [1280, 800, 1, 'full desktop'],
]

const PITCHES = [0, 30, 50, 59, 60, 65, 70, 72.4, 75, 80]

function histogram(tiles: { z: number; x: number; y: number }[]): string {
  const byZ: Record<number, number> = {}
  for (const t of tiles) byZ[t.z] = (byZ[t.z] ?? 0) + 1
  return Object.keys(byZ)
    .map(Number)
    .sort((a, b) => a - b)
    .map((z) => `z${z}:${byZ[z]}`)
    .join(' ')
}

for (const [cw, ch, dpr, label] of VIEWPORTS) {
  console.log(`\n=== ${label}: canvas ${cw}x${ch} dpr=${dpr} ===`)
  for (const pitch of PITCHES) {
    const camera = new Camera(LON, LAT, ZOOM)
    camera.bearing = BEARING
    camera.pitch = pitch
    camera.syncCenterLat()
    const cam = camera as unknown as Parameters<typeof visibleTilesFrustum>[0]

    const sse = visibleTilesSSE(cam, mercator, MAX_SOURCE_Z, cw, ch, 0, dpr)
    const dfs = visibleTilesFrustum(cam, mercator, MAX_SOURCE_Z, cw, ch, 0, dpr)
    const ssePrimary = sse.filter((t) => !t.fallbackOnly)

    console.log(
      `pitch ${String(pitch).padStart(5)}  SSE=${String(ssePrimary.length).padStart(4)}` +
        ` (+${sse.length - ssePrimary.length} fallback)   ${histogram(ssePrimary)}`,
    )
    console.log(
      `               DFS=${String(dfs.length).padStart(4)}                 ${histogram(dfs)}`,
    )
  }
}
