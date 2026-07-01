import { describe, it, expect, vi } from 'vitest'
import { SpriteAtlasHost } from '@xgis/map'

// Regression — the sprite atlas land had NO render-loop re-arm (audit ③): unlike
// the glyph pipeline (onResourceLanded → markLabelDirty), a sprite atlas that
// reached its terminal state fired only the whenReady() promise. So on a fully
// idle map (tiles settled, camera still, _needsRender cleared) a late sprite land
// was not painted until the next interaction — shouldRenderThisFrame /
// hasPendingSourceWork don't track the sprite fetch. The fix gives the host an
// onLanded hook that label-pass wires to host.markLabelDirty(). This test pins
// the host half: onLanded MUST fire on every terminal state.

describe('SpriteAtlasHost: onLanded fires on terminal state (render-loop re-arm)', () => {
  it('fires onLanded when the sprite fetch fails (async terminal: loaded/failed)', async () => {
    const onLanded = vi.fn()
    const fetch404 = (() => Promise.resolve(new Response('', { status: 404 }))) as typeof globalThis.fetch
    const host = new SpriteAtlasHost({ spriteUrl: 'https://example.test/sprite', fetch: fetch404, onLanded })
    await host.whenReady()
    expect(host.getState().status).toBe('failed')
    expect(onLanded, 'onLanded must fire so an idle map repaints the landed atlas').toHaveBeenCalledTimes(1)
  })

  it('fires onLanded on the synchronous SSRF-reject terminal path', () => {
    const onLanded = vi.fn()
    // A private/loopback URL is rejected synchronously in kickOffLoad → failed.
    const host = new SpriteAtlasHost({ spriteUrl: 'http://127.0.0.1/sprite', onLanded })
    expect(host.getState().status).toBe('failed')
    expect(onLanded).toHaveBeenCalledTimes(1)
  })
})
