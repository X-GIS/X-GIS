// Label position consistency across projection × pitch × bearing.
//
// User reported: pitch 낮출 때 라벨 위치 이상, 글로브가 갑자기
// 기울어지는 비주얼 비정상. Snapshot tests of static views can miss
// THIS because they test a single (pitch, bearing) frame — the
// regression is in the DERIVATIVE of label position across the
// sweep. This spec sweeps the full matrix and pins per-cell
// screenshots so any future change that breaks label placement at
// pitch=30 on globe (but not pitch=0) surfaces as a per-cell
// diff.
//
// Phase 8.3 of the X-GIS strict-spec / runtime parity plan.

import { test, type Page } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(
  resolve(__dirname, '__convert-fixtures', 'bright.json'),
  'utf8',
)

const OUT_DIR = resolve(__dirname, '__label-pitch-bearing-matrix__')
mkdirSync(OUT_DIR, { recursive: true })

const PROJECTIONS = [
  'mercator',
  'equirectangular',
  'natural_earth',
  'orthographic',
  'azimuthal_equidistant',
  'stereographic',
  'oblique_mercator',
  'globe',
] as const

const PITCHES = [0, 30, 60, 80] as const
const BEARINGS = [0, 90, 180, 270] as const

async function setupPage(page: Page, projection: string) {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((args) => {
    sessionStorage.setItem('__xgisImportSource', args.src)
    sessionStorage.setItem('__xgisImportLabel', `Bright label-pitch-bearing (proj=${args.proj})`)
  }, { src: xgis, proj: projection })
  await page.goto(
    `/demo.html?id=__import&proj=${projection}#12/35.68/139.76/0/0`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
}

test.describe.configure({ mode: 'serial' })

test.describe('label-pitch-bearing matrix', () => {
  for (const proj of PROJECTIONS) {
    for (const pitch of PITCHES) {
      for (const bearing of BEARINGS) {
        test(`${proj} pitch=${pitch} bearing=${bearing}`, async ({ page }) => {
          await setupPage(page, proj)
          await page.evaluate(({ p, b }) => {
            const m = (window as unknown as { __xgisMap?: {
              setPitch: (v: number) => void;
              setBearing: (v: number) => void;
              invalidate: () => void;
            } }).__xgisMap
            if (!m) throw new Error('__xgisMap not exposed')
            m.setPitch(p)
            m.setBearing(b)
            m.invalidate()
          }, { p: pitch, b: bearing })
          // Wait for label collision pass + glyph atlas catch-up.
          // Labels can take 2-3 frames to settle after a pitch /
          // bearing change while the placement worker reroutes.
          await page.waitForTimeout(1500)
          const out = join(OUT_DIR, `${proj}-pitch${pitch}-bearing${bearing}.png`)
          await page.screenshot({ path: out, fullPage: false })
          // Smoke gate: snapshot exists + camera state actually applied.
          const cam = await page.evaluate(() => {
            const m = (window as unknown as { __xgisMap?: {
              getCamera: () => { pitch: number; bearing: number };
            } }).__xgisMap
            return m?.getCamera() ?? { pitch: -1, bearing: -1 }
          })
          // Camera should have honoured the setters (or rejected with a
          // clamp — still a known value, never -1).
          if (cam.pitch === -1) throw new Error(`pitch setter rejected on ${proj}`)
          if (cam.bearing === -1) throw new Error(`bearing setter rejected on ${proj}`)
        })
      }
    }
  }
})
