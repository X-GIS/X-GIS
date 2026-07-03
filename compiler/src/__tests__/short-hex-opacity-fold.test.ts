// Regression test: short-form hex (#rgb / #rgba) + constant opacity fold.
// Bug: both circle-stroke-color and background-color fold sites assumed the
// color was always #rrggbb (7 chars) or #rrggbbaa (9 chars). For short hex
// like "#abc" (4 chars) they sliced wrong → emitted "#abc80" (5 hex digits)
// which the runtime rejects → stroke/background silently dropped to no-color.
// For "#abcd" (5 chars) they emitted "#abcd80" (6 digits) parsed as a WRONG
// opaque color, losing the intended alpha.
// Fix: expand short-form hex before the fold via applyAlphaMultiplier.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

// ─── circle-stroke-color + circle-stroke-opacity ─────────────────────────────

function circleStyle(strokeColor: string, strokeOpacity: number) {
  return {
    version: 8,
    sources: { p: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      {
        id: 'pts',
        type: 'circle',
        source: 'p',
        paint: {
          'circle-radius': 5,
          'circle-color': '#ff0000',
          'circle-stroke-color': strokeColor,
          'circle-stroke-width': 2,
          'circle-stroke-opacity': strokeOpacity,
        },
      },
    ],
  } as const
}

describe('circle-stroke-color short-hex + opacity fold', () => {
  it('#abc + 0.5 → valid 8-char hex with correct RGB and ~0.5 alpha', () => {
    // "#abc" expands to "#aabbcc"; 0.5 * 255 ≈ 128 = 0x80
    const xgis = convertMapboxStyle(circleStyle('#abc', 0.5) as never)
    expect(xgis).toContain('stroke-#aabbcc80')
  })

  it('#abcd + 0.5 → valid 8-char hex with correct RGBA (existing alpha * 0.5)', () => {
    // "#abcd" expands to "#aabbccdd"; dd=221; 221/255*0.5≈0.4333; round(0.4333*255)=111=0x6f
    const xgis = convertMapboxStyle(circleStyle('#abcd', 0.5) as never)
    expect(xgis).toContain('stroke-#aabbcc6f')
  })

  // Controls: 6/8-digit must be unchanged
  it('#0000ff + 0.5 → #0000ff80 (unchanged from before)', () => {
    const xgis = convertMapboxStyle(circleStyle('#0000ff', 0.5) as never)
    expect(xgis).toContain('stroke-#0000ff80')
  })

  it('#0000ff80 + 0.5 → alpha halved correctly', () => {
    // 0x80=128; 128/255*0.5≈0.251; round(0.251*255)=64=0x40
    const xgis = convertMapboxStyle(circleStyle('#0000ff80', 0.5) as never)
    expect(xgis).toContain('stroke-#0000ff40')
  })

  // No mangled 5-digit or 6-digit garbage hex
  it('#abc + 0.5 does NOT emit a 5-digit hex fragment', () => {
    const xgis = convertMapboxStyle(circleStyle('#abc', 0.5) as never)
    // The old bug emitted "stroke-#abc80" (5 hex digits after #)
    expect(xgis).not.toMatch(/stroke-#[0-9a-f]{5}(?:[^0-9a-f]|$)/i)
  })
})

// ─── background-color + background-opacity ───────────────────────────────────

function bgStyle(bgColor: string, bgOpacity: number) {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'bg',
        type: 'background',
        paint: {
          'background-color': bgColor,
          'background-opacity': bgOpacity,
        },
      },
    ],
  } as const
}

describe('background-color short-hex + opacity fold', () => {
  it('#abc + 0.5 → valid 8-char hex with correct RGB and ~0.5 alpha', () => {
    // "#abc" expands to "#aabbcc"; 0.5 * 255 ≈ 128 = 0x80
    const xgis = convertMapboxStyle(bgStyle('#abc', 0.5) as never)
    expect(xgis).toContain('background { fill: #aabbcc80 }')
  })

  it('#abcd + 0.5 → valid 8-char hex with correct RGBA (existing alpha * 0.5)', () => {
    // "#abcd" expands to "#aabbccdd"; dd=221; 221/255*0.5≈0.4333; round(0.4333*255)=111=0x6f
    const xgis = convertMapboxStyle(bgStyle('#abcd', 0.5) as never)
    expect(xgis).toContain('background { fill: #aabbcc6f }')
  })

  // Controls: 6/8-digit must be unchanged
  it('#ff8000 + 0.5 → #ff800080 (unchanged from before)', () => {
    const xgis = convertMapboxStyle(bgStyle('#ff8000', 0.5) as never)
    expect(xgis).toContain('background { fill: #ff800080 }')
  })

  it('#ff800080 + 0.5 → alpha halved correctly', () => {
    // 0x80=128; 128/255*0.5≈0.251; round(0.251*255)=64=0x40
    const xgis = convertMapboxStyle(bgStyle('#ff800080', 0.5) as never)
    expect(xgis).toContain('background { fill: #ff800040 }')
  })

  it('#abc + 0.5 does NOT emit a 5-digit hex fragment', () => {
    const xgis = convertMapboxStyle(bgStyle('#abc', 0.5) as never)
    expect(xgis).not.toMatch(/fill: #[0-9a-f]{5}(?:[^0-9a-f]|$)/i)
  })
})
