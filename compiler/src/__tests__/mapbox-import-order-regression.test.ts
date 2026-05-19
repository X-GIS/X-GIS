// Static-source regression gate: playground demo-runner must call
// setSpriteUrl + setGlyphsUrl BEFORE `await runSource()`. Iter 56
// fixed a production deploy regression where icons didn't render
// because the order was reversed — runSource awaited the first
// label-bearing frame, IconStage construction gate saw spriteUrl
// still null, never built.
//
// Static lint instead of e2e because the e2e path needs real GPU.
// We just check the source code order.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const DEMO_RUNNER_PATH = join(__dirname, '..', '..', '..', 'playground', 'src', 'demo-runner.ts')

describe('Mapbox import setSpriteUrl ordering regression gate', () => {
  it('demo-runner sets sprite + glyphs URL BEFORE awaiting runSource', () => {
    const src = readFileSync(DEMO_RUNNER_PATH, 'utf8')
    // Find the __xgisImportMapbox handler
    const idx = src.indexOf('__xgisImportMapbox')
    expect(idx, 'demo-runner should expose __xgisImportMapbox').toBeGreaterThan(0)
    // Within the handler, the first occurrence of setSpriteUrl must
    // be BEFORE the first occurrence of "await runSource".
    const handlerWindow = src.slice(idx, idx + 5000)
    const setSpriteIdx = handlerWindow.indexOf('setSpriteUrl')
    const awaitRunSourceIdx = handlerWindow.indexOf('await runSource')
    expect(setSpriteIdx, 'setSpriteUrl call missing in import handler').toBeGreaterThan(0)
    expect(awaitRunSourceIdx, 'await runSource call missing in import handler').toBeGreaterThan(0)
    expect(setSpriteIdx,
      `setSpriteUrl (offset ${setSpriteIdx}) must precede await runSource (offset ${awaitRunSourceIdx})`,
    ).toBeLessThan(awaitRunSourceIdx)
  })

  it('demo-runner sets glyphs URL BEFORE awaiting runSource', () => {
    const src = readFileSync(DEMO_RUNNER_PATH, 'utf8')
    const idx = src.indexOf('__xgisImportMapbox')
    const handlerWindow = src.slice(idx, idx + 5000)
    const setGlyphsIdx = handlerWindow.indexOf('setGlyphsUrl')
    const awaitRunSourceIdx = handlerWindow.indexOf('await runSource')
    expect(setGlyphsIdx).toBeGreaterThan(0)
    expect(setGlyphsIdx).toBeLessThan(awaitRunSourceIdx)
  })

  it('belt-and-braces re-apply after runSource is also present (idempotent)', () => {
    // Both setters appear at least TWICE in the handler (before + after).
    const src = readFileSync(DEMO_RUNNER_PATH, 'utf8')
    const idx = src.indexOf('__xgisImportMapbox')
    const handlerWindow = src.slice(idx, idx + 5000)
    const setSpriteCount = (handlerWindow.match(/setSpriteUrl/g) ?? []).length
    const setGlyphsCount = (handlerWindow.match(/setGlyphsUrl/g) ?? []).length
    expect(setSpriteCount, 'setSpriteUrl should appear ≥2× (before + after runSource)').toBeGreaterThanOrEqual(2)
    expect(setGlyphsCount, 'setGlyphsUrl should appear ≥2× (before + after runSource)').toBeGreaterThanOrEqual(2)
  })
})
