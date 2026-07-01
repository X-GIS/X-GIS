// Unit gate for the local-ideograph display-size path (#421): the size-bucket
// ladder, the synthetic-fontKey round-trip, and the PbfRasterizer routing that
// sends a size-marked CJK key to the LOCAL full rasterizer (at the bucket size)
// instead of the PBF server.

import { describe, it, expect } from 'vitest'
import { cjkBucketPx, CJK_SIZE_BUCKETS_CSS } from './text-wrap'
import {
  cjkSizedFontKey, parseSizedFontKey, MockRasterizer,
  type GlyphRasterizer, type GlyphRasterRequest, type GlyphRasterResult,
} from '@xgis/map'
import { PbfRasterizer } from './sdf/pbf-rasterizer'
import type { GlyphProvider } from './sdf/pbf/glyph-provider'

describe('cjkBucketPx ladder', () => {
  it('picks the smallest bucket >= display size (always minify, never magnify)', () => {
    expect(cjkBucketPx(9, 1)).toBe(12)   // below smallest → smallest bucket
    expect(cjkBucketPx(12, 1)).toBe(12)
    expect(cjkBucketPx(13, 1)).toBe(16)
    expect(cjkBucketPx(20, 1)).toBe(20)
    expect(cjkBucketPx(25, 1)).toBe(32)
  })
  it('clamps to the largest bucket', () => {
    const max = CJK_SIZE_BUCKETS_CSS[CJK_SIZE_BUCKETS_CSS.length - 1]!
    expect(cjkBucketPx(999, 1)).toBe(max)
  })
  it('scales by dpr', () => {
    expect(cjkBucketPx(12, 2)).toBe(24)   // 12px bucket × dpr2
    expect(cjkBucketPx(20, 2)).toBe(40)
  })
})

describe('sized fontKey round-trip', () => {
  it('appends + recovers the bucket; plain keys report null', () => {
    const k = cjkSizedFontKey('\x01normal\x01700\x01Noto Sans Bold', 16)
    const p = parseSizedFontKey(k)
    expect(p.sizePx).toBe(16)
    expect(p.fontKey).toBe('\x01normal\x01700\x01Noto Sans Bold')
    expect(parseSizedFontKey('\x01normal\x01700\x01Noto Sans Bold').sizePx).toBeNull()
  })
})

describe('PbfRasterizer local-ideograph routing', () => {
  function req(fontKey: string): GlyphRasterRequest {
    return { fontKey, fontSize: 24, codepoint: 0x56fd /* 国 */, sdfRadius: 8, slotSize: 64 }
  }
  // Records whether it was asked, and at what fontSize the request landed.
  function recordingRasterizer(tag: string, log: string[]): GlyphRasterizer {
    return {
      rasterize(r: GlyphRasterRequest): GlyphRasterResult {
        log.push(`${tag}:${parseSizedFontKey(r.fontKey).sizePx ?? r.fontSize}`)
        return new MockRasterizer().rasterize(r)
      },
    }
  }

  it('routes a size-marked key to cjkFull (local), never probing PBF providers', () => {
    const log: string[] = []
    const probed: number[] = []
    const provider: GlyphProvider = {
      get: (_fs, cp) => { probed.push(cp); return undefined },
    }
    const ras = new PbfRasterizer({
      fallback: recordingRasterizer('fallback', log),
      cjkFull: recordingRasterizer('cjkFull', log),
      providers: [provider],
      onLanded: () => {},
    })
    ras.rasterize(req(cjkSizedFontKey('\x01normal\x01400\x01Noto Sans', 16)))
    expect(log).toEqual(['cjkFull:16'])   // local path, at the bucket size
    expect(probed).toEqual([])            // PBF provider never consulted
  })

  it('a plain (unmarked) key still goes through the PBF provider chain', () => {
    const log: string[] = []
    const probed: number[] = []
    const provider: GlyphProvider = {
      get: (_fs, cp) => { probed.push(cp); return undefined },
    }
    const ras = new PbfRasterizer({
      fallback: recordingRasterizer('fallback', log),
      cjkFull: recordingRasterizer('cjkFull', log),
      providers: [provider],
      onLanded: () => {},
    })
    ras.rasterize(req('\x01normal\x01400\x01Noto Sans'))
    expect(probed).toEqual([0x56fd])      // PBF provider WAS consulted
    expect(log).toEqual(['fallback:24'])  // miss → metrics fallback, not cjkFull
  })
})
