// ═══ #1579 — the raster texture budget diverged three ways ═══
//
// A: the mip fix (#1436) landed on the WebGL2 arm only — raster-renderer's WebGPU arm
//    bypassed the RHI entirely via the raw-device `loadImageTexture` (one mip level), so
//    every render gate CI runs (WebGL2) could not see the far-field minification bug still
//    live on the default backend. Fixed by deleting that arm; `loadTileTexture` now routes
//    BOTH backends through the same RHI create + generateMipmaps. And `textureBytesOf`
//    charged the full chain unconditionally, over-charging deliberately un-mipped DEM tiles
//    by ~4/3 (mip-scope-invariant.test.ts pins hillshade un-mipped) — every budget it feeds
//    silently shrank. Fixed with a required `mipped` flag.
// B: the WebGL2 twin (`render-loop.ts`'s isolated `?forcegl2=1` path) never called
//    raster/hillshade `beginFrame()` — their ONLY over-budget eviction backstop — so under
//    that backend the tile caches grew without bound. #1057 re-added the point/line pair
//    when this same class of gap hit them; raster/hillshade were left out.
//    (#1046 Track A1 deleted the twin — `render()`'s single chain path now drains all four
//    caches unconditionally, so B's fix is real but has no twin-specific shape left to pin;
//    its verification block was removed rather than adapted to a moot subject.)

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { textureBytesOf, mipLevelCountFor } from './raster-cache-budget'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('#1579 A — textureBytesOf requires an explicit mipped flag', () => {
  it('mipped=false is exactly one level — the DEM/hillshade case', () => {
    expect(textureBytesOf(512, 512, false)).toBe(512 * 512 * 4)
    // Non-square, non-power-of-two: still just width*height*4, no chain math at all.
    expect(textureBytesOf(300, 200, false)).toBe(300 * 200 * 4)
  })

  it('mipped=true sums the full chain — the raster/appearance case', () => {
    // 256x256: base + 128² + 64² + ... + 1x1 = 4/3 of the base, exactly (power-of-two square).
    expect(textureBytesOf(256, 256, true)).toBe(349_524)
    expect(textureBytesOf(256, 256, true)).toBeGreaterThan(textureBytesOf(256, 256, false))
  })

  it('CONTROL — mixing the flags must disagree, or the parameter carries no information', () => {
    // If mipped=true and mipped=false ever produced the same number, a call site could pass
    // the wrong one and no test would notice.
    const dim = 512
    expect(textureBytesOf(dim, dim, true)).not.toBe(textureBytesOf(dim, dim, false))
  })
})

describe('#1579/#1623 — raster AND hillshade no longer bypass the RHI on WebGPU', () => {
  it("imports no raw-device texture loader — both renderers' forks are gone", () => {
    // `loadImageTexture` (data/src/tile-select.ts) was the raw-device, unmipped, non-RHI
    // WebGPU-only path #1436's fix never reached. #1579 closed raster's copy; #1623 closed
    // hillshade's — the last one in the raster family. Its removal from BOTH renderers'
    // import lists is what proves the fork itself — not just its symptom — is gone.
    for (const file of ['./raster-renderer.ts', './hillshade-renderer.ts']) {
      const src = read(file)
      expect(src, `${file} must not import the raw-device loader`).not.toMatch(
        /import\s*\{[^}]*\bloadImageTexture\b[^}]*\}\s*from\s*['"]@xgis\/data['"]/,
      )
    }
  })

  it('CONTROL — the loader is deleted, not just unimported (non-vacuity)', () => {
    // Without this, the assertion above would pass just as well against a tree where
    // `loadImageTexture` still existed in tile-select.ts but both renderers happened to
    // stop importing it — proving nothing about the fork actually closing.
    const src = read('../../../data/src/tile-select.ts')
    expect(src, 'tile-select.ts must no longer export the raw-device loader').not.toMatch(
      /export\s+async\s+function\s+loadImageTexture\b/,
    )
  })

  it('loadTileTexture builds one mip chain unconditionally — no backend branch left', () => {
    const src = read('./raster-renderer.ts')
    const start = src.indexOf('private async loadTileTexture(')
    expect(start, 'raster-renderer.ts must still define loadTileTexture').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n  }', start))
    expect(body, 'no backend fork left inside the method body').not.toContain(
      "this.rhi.backend !== 'webgl2'",
    )
    expect(body, 'creates through the RHI with a real mip chain').toContain(
      'mipLevelCount: mipLevelCountFor(',
    )
    expect(
      body,
      'and fills it in — a chain descriptor with no generateMipmaps is empty above level 0',
    ).toContain('this.rhi.generateMipmaps(')
  })

  it('mipLevelCountFor matches the shared authority both the texture and its budget read', () => {
    // Fail-before target: if raster-renderer inlined its own level-count formula instead of
    // importing this one, a future change to the shared formula would silently desync it
    // from the budget that charges for it.
    expect(mipLevelCountFor(2048, 2048)).toBe(12)
    expect(read('./raster-renderer.ts')).toContain('mipLevelCountFor(bitmap.width, bitmap.height)')
  })
})
