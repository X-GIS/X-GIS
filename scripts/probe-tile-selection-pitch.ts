#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════
// Tile-selection pitch sweep — the deterministic repro for the
// "frame drops + permanent [FLICKER] at high pitch" report.
// ═══════════════════════════════════════════════════════════════════
//
// Reported camera (OFM Liberty): #16.00/51.50466/-0.11813/60.0/72.4
//
// Drives the REAL selector (`visibleTilesFrustum`) across a pitch sweep and
// prints, per pitch, the selected tile count and the per-zoom histogram. Pure
// CPU — no GPU, no network, no browser — so the numbers are deterministic and
// backend-independent, unlike the frame timings the report started from (which
// a software rasteriser cannot represent).
//
// What it surfaces at 1280x800 / z16 / bearing 60:
//
//   pitch 59 ->  40 tiles   z12:1 z13:12 z14:27
//   pitch 60 -> 191 tiles   z4:100 ...            <- the cliff
//
// and the z4 span at pitch 60 is x 0..15 of 0..15, y 0..6 of 0..15 — every
// longitude column, pole down to London's row. A street-level z16 view is
// enumerating most of the northern hemisphere. That is not an LOD taper; the
// frustum's ground intersection is unbounded past the horizon, and the
// `pitchDeg >= 60` budget doubling in `maxFrustumTilesFor` (tile-select.ts)
// then lets DFS spend the extra budget emitting them.
//
// Also visible: MAX_FRUSTUM_TILES for this viewport at pitch >= 60 is 170, but
// 191-192 tiles come back — the cap is exceeded, not merely reached.
//
// Invocation:
//   bun scripts/probe-tile-selection-pitch.ts

import { visibleTilesFrustum } from '../data/src/tile-select'
import { mercator } from '@xgis/geo'
import { Camera } from '../map/src/camera/camera'

const LAT = 51.50466
const LON = -0.11813
const ZOOM = 16
const BEARING = 60
const MAX_SOURCE_Z = 14 // OFM planet

/** [canvasW, canvasH, dpr] — the compare-harness pane (dpr 3) and a plain desktop. */
const VIEWPORTS: [number, number, number][] = [
  [636 * 3, 704 * 3, 3],
  [1280, 800, 1],
]

const PITCHES = [0, 30, 50, 59, 60, 65, 70, 72.4, 75, 80]

for (const [cw, ch, dpr] of VIEWPORTS) {
  console.log(`\n=== canvas ${cw}x${ch} dpr=${dpr} (css ${cw / dpr}x${ch / dpr}) ===`)
  for (const pitch of PITCHES) {
    const camera = new Camera(LON, LAT, ZOOM)
    camera.bearing = BEARING
    camera.pitch = pitch
    camera.syncCenterLat()

    const tiles = visibleTilesFrustum(
      camera as unknown as Parameters<typeof visibleTilesFrustum>[0],
      mercator,
      MAX_SOURCE_Z,
      cw,
      ch,
      0,
      dpr,
    )
    const unique = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`))
    const byZ: Record<number, number> = {}
    for (const t of tiles) byZ[t.z] = (byZ[t.z] ?? 0) + 1
    const zs = Object.keys(byZ)
      .map(Number)
      .sort((a, b) => a - b)

    console.log(
      `pitch ${String(pitch).padStart(5)}  tiles=${String(tiles.length).padStart(4)}` +
        `  unique=${String(unique.size).padStart(4)}  ` +
        zs.map((z) => `z${z}:${byZ[z]}`).join(' '),
    )

    // The coarse tiles are the story — print their world span so a
    // "whole-hemisphere" selection is visible rather than inferred.
    for (const z of zs) {
      if (z > 6 || byZ[z] < 10) continue
      const at = tiles.filter((t) => t.z === z)
      const xs = at.map((t) => t.x)
      const ys = at.map((t) => t.y)
      const side = 2 ** z
      console.log(
        `        z${z} span: x ${Math.min(...xs)}..${Math.max(...xs)} of 0..${side - 1}, ` +
          `y ${Math.min(...ys)}..${Math.max(...ys)} of 0..${side - 1}`,
      )
    }
  }
}
