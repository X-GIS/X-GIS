// Diagnostic for the user-reported Pacific-dateline label cluster.
//
// Reproduces the exact hash `#1.86/35.26713/178.21660/0.3/2.2` on a
// mobile-portrait canvas (390 CSS × 844 CSS, dpr=3) and asks: at
// camera lon=178, do features from across the world (Korea, USA,
// Mexico, India) actually project into the viewport via SOME world
// copy iteration? If they do, the user's screenshot is real visible
// output and we need to chase the projection. If they don't, the
// hook is firing PRE-rejection and the overlay is showing
// rejected submissions.

import { describe, it } from 'vitest'
import { Camera } from './camera'
import { WORLD_MERC } from '../gpu/gpu-shared'

const DEG2RAD = Math.PI / 180
const R = 6378137

function lonLatToMercator(lon: number, lat: number): [number, number] {
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat))
  return [
    lon * DEG2RAD * R,
    Math.log(Math.tan(Math.PI / 4 + (clampedLat * DEG2RAD) / 2)) * R,
  ]
}

function projectLonLat(
  mvp: Float32Array, w: number, h: number, ccx: number, ccy: number,
  lon: number, lat: number, worldMercatorOffset: number = 0,
): { ndcX: number; ndcY: number; cw: number; visible: boolean; screenX: number; screenY: number } {
  const [mx, my] = lonLatToMercator(lon, lat)
  const rtcX = (mx + worldMercatorOffset) - ccx
  const rtcY = my - ccy
  const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
  const ccx_ = mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!
  const ccy_ = mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!
  const ndcX = ccx_ / cw
  const ndcY = ccy_ / cw
  const visible = cw > 0 && ndcX >= -1.5 && ndcX <= 1.5 && ndcY >= -1.5 && ndcY <= 1.5
  return {
    ndcX, ndcY, cw, visible,
    screenX: (ndcX + 1) * 0.5 * w,
    screenY: (1 - ndcY) * 0.5 * h,
  }
}

describe('user-reported dateline cluster — what actually projects?', () => {
  // Hash `#1.86/35.26713/178.21660/0.3/2.2` + iPhone-portrait
  // physical canvas. dpr=3.
  const CSS_W = 390, CSS_H = 844
  const DPR = 3
  const PHYS_W = CSS_W * DPR, PHYS_H = CSS_H * DPR

  it('dumps every world-copy projection at user hash #1.55/14.76/-179.31', () => {
    // User-reported case where countries from Sweden / UK / Mexico
    // / Vietnam / Australia all stack into a single vertical column
    // near the antimeridian. Camera at lon=-179.31, near dateline,
    // very low zoom (z=1.55 → world span ~94° on a mobile canvas).
    const cam = new Camera(-179.31472, 14.76339, 1.55)
    cam.bearing = 358.3
    cam.pitch = 0
    const mvp = cam.getRTCMatrix(PHYS_W, PHYS_H, DPR)
    const ccx = cam.centerX
    const ccy = cam.centerY
    // eslint-disable-next-line no-console
    console.log('MVP matrix (column-major):')
    for (let r = 0; r < 4; r++) {
      const row: number[] = []
      for (let c = 0; c < 4; c++) row.push(mvp[c * 4 + r]!)
      // eslint-disable-next-line no-console
      console.log('  ', row.map(v => v.toExponential(3)).join('  '))
    }

    const features = [
      { name: 'Canada',          lon: -100, lat: 56 },
      { name: 'Sweden',          lon: 18, lat: 60 },
      { name: 'United Kingdom',  lon: -2, lat: 54 },
      { name: 'Belgium',         lon: 4, lat: 50 },
      { name: 'France',          lon: 2, lat: 46 },
      { name: 'Italy',           lon: 12, lat: 42 },
      { name: 'Portugal',        lon: -8, lat: 39 },
      { name: 'Japan',           lon: 138, lat: 36 },
      { name: 'Pakistan',        lon: 70, lat: 30 },
      { name: 'Mexico',          lon: -100, lat: 23 },
      { name: 'Vietnam',         lon: 108, lat: 16 },
      { name: 'Ethiopia',        lon: 38, lat: 9 },
      { name: 'Colombia',        lon: -74, lat: 4 },
      { name: 'Indonesia',       lon: 113, lat: -0.5 },
      { name: 'Peru',            lon: -75, lat: -10 },
      { name: 'Brazil',          lon: -55, lat: -10 },
      { name: 'Zambia',          lon: 28, lat: -15 },
      { name: 'Bolivia',         lon: -65, lat: -17 },
      { name: 'Australia',       lon: 135, lat: -25 },
      { name: 'South Africa',    lon: 25, lat: -30 },
      { name: 'Chile',           lon: -71, lat: -35 },
      { name: 'Argentina',       lon: -64, lat: -34 },
      { name: 'New Zealand',     lon: 174, lat: -41 },
    ]
    const worldCopies = [-2, -1, 0, 1, 2]

    // eslint-disable-next-line no-console
    console.log(`\n=== camera: lon=${cam.centerX} lat=${cam.centerY} (mercator) ===`)
    // eslint-disable-next-line no-console
    console.log(`    physical canvas: ${PHYS_W}×${PHYS_H} (CSS ${CSS_W}×${CSS_H}, dpr=${DPR})`)
    for (const f of features) {
      // eslint-disable-next-line no-console
      console.log(`\n${f.name} (lon=${f.lon}):`)
      for (const w of worldCopies) {
        const p = projectLonLat(mvp, PHYS_W, PHYS_H, ccx, ccy, f.lon, f.lat, w * WORLD_MERC)
        const marker = p.visible ? '✓' : '✗'
        // eslint-disable-next-line no-console
        console.log(`  w=${w >= 0 ? '+' : ''}${w}: ndcX=${p.ndcX.toFixed(2)} cw=${p.cw.toFixed(0)} screen=(${p.screenX.toFixed(0)},${p.screenY.toFixed(0)}) ${marker}`)
      }
    }
  })
})
