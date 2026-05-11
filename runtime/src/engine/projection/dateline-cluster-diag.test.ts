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

  it('dumps every world-copy projection for Korea/USA/Mexico/Russia/India at camera (178, 35.26, z=1.86)', () => {
    const cam = new Camera(178.21660, 35.26713, 1.86)
    cam.bearing = 0.3
    cam.pitch = 2.2
    const mvp = cam.getRTCMatrix(PHYS_W, PHYS_H, DPR)
    const ccx = cam.centerX
    const ccy = cam.centerY

    const features = [
      { name: 'Gangwon (Korea)', lon: 128.5, lat: 37.7 },
      { name: 'Kansas (USA)',    lon: -98.0, lat: 38.5 },
      { name: 'Querétaro (Mex)', lon: -100.4, lat: 20.6 },
      { name: 'Hubei (China)',   lon: 113.0, lat: 30.5 },
      { name: 'Meghalaya (Ind)', lon: 91.0, lat: 25.5 },
      { name: 'Sakha (Russia)',  lon: 130.0, lat: 65.0 },
      { name: 'Kamchatka',       lon: 160.0, lat: 56.0 },
      { name: 'Bering Sea',      lon: 175.0, lat: 60.0 },
      { name: 'Sea of Japan',    lon: 135.0, lat: 40.0 },
      { name: 'Pacific Ocean',   lon: 175.0, lat: 0.0 },
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
