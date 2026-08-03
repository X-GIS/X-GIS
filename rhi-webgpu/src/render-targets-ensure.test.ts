// Device-free unit test for RenderTargets.ensure — pins the recreate-on-
// resize lifecycle (the gate + destroy-old order + format/usage choices)
// extracted VERBATIM from RenderLoop, now allocated through the neutral
// RhiDevice primitives (#1046 F4 Inc-D). Runs against an instrumented fake
// RhiDevice; the ctx's `device` property is BOOBY-TRAPPED — the WebGL2 chain
// frame's GPUContext carries a fail-loud Proxy there, so a RenderTargets
// that so much as touches ctx.device would crash that frame on frame one
// (flip blocker #1). The trap turns any such regression into a named
// failure here instead of a dead frame there.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RenderTargets } from '@xgis/rhi-webgpu'
import type { GPUContext } from '@xgis/rhi-webgpu'
import type { RhiDevice, RhiTexture, RhiTextureDesc, RhiTextureView } from '@xgis/rhi'

interface FakeTexture {
  id: number
  desc: RhiTextureDesc
  destroyed: boolean
}

interface FakeRhi {
  created: FakeTexture[]
  rhi: RhiDevice
}

function makeFakeRhi(): FakeRhi {
  const created: FakeTexture[] = []
  let nextId = 0
  const rhi = {
    createTexture(desc: RhiTextureDesc): RhiTexture {
      const tex: FakeTexture = { id: nextId++, desc, destroyed: false }
      created.push(tex)
      return tex as unknown as RhiTexture
    },
    destroyTexture(tex: RhiTexture): void {
      ;(tex as unknown as FakeTexture).destroyed = true
    },
    // Fresh object per call — the RT's identity-keyed cache is what dedupes.
    // Shaped like the adapter's wrapper ({native}) so the *Native getters'
    // unwrap resolves to a definite object the P6 pin below can assert on.
    createView: (): RhiTextureView =>
      ({ native: { __nativeView: true } }) as unknown as RhiTextureView,
  } as unknown as RhiDevice
  return { created, rhi }
}

function makeCtx(rhi: RhiDevice): GPUContext {
  return {
    rhi,
    format: 'bgra8unorm',
    get device(): never {
      throw new Error(
        'RenderTargets touched ctx.device — the WebGL2 chain frame (fail-loud Proxy) would crash',
      )
    },
  } as unknown as GPUContext
}

const screenView = {} as RhiTextureView

describe('RenderTargets.ensure', () => {
  it('allocates ONLY stencil on first ensure (no MSAA, no pick, no overdraw); OIT/extrude are lazy', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    const { useResolve, colorView } = rt.ensure(800, 600, 800, 600, 1, false, false, screenView)

    expect(useResolve).toBe(false)
    // sc === 1 → no MSAA texture, no pick (disabled), no overdraw.
    expect(rt.msaaTexture).toBeNull()
    expect(rt.pickTexture).toBeNull()
    expect(rt.overdrawAccumTexture).toBeNull()
    // stencil allocated + its view cached.
    expect(rt.stencilTexture).not.toBeNull()
    expect(rt.stencilView).not.toBeNull()
    // OIT + offscreen-extrude are NOT allocated by ensure() — they are lazy
    // (ensureOit), gated on scene OIT content. Default path allocates none.
    expect(rt.oitAccumTexture).toBeNull()
    expect(rt.oitRevealageTexture).toBeNull()
    expect(rt.offscreenExtrudeDepth).toBeNull()
    expect(rt.msaaWidth).toBe(800)
    expect(rt.msaaHeight).toBe(600)
    // sc === 1 → colorView is the swapchain view directly.
    expect(colorView).toBe(screenView)
    // 1 texture created (stencil only), render-attachment usage.
    expect(fake.created.length).toBe(1)
    expect(fake.created[0]!.desc.format).toBe('depth24plus-stencil8')
    expect(fake.created[0]!.desc.usage).toEqual(['render'])
  })

  it('allocates MSAA + pick + overdraw when those inputs are on (still no OIT)', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    const { useResolve, colorView } = rt.ensure(640, 480, 640, 480, 4, true, true, screenView)

    expect(useResolve).toBe(true)
    expect(rt.msaaTexture).not.toBeNull()
    expect(rt.pickTexture).not.toBeNull()
    expect(rt.overdrawAccumTexture).not.toBeNull()
    // Cached views populated alongside their textures.
    expect(rt.msaaView).not.toBeNull()
    expect(rt.pickView).not.toBeNull()
    expect(rt.overdrawView).not.toBeNull()
    // OIT still not allocated by ensure().
    expect(rt.oitAccumTexture).toBeNull()
    // debug-overdraw → colorView is the accumulator view, not screenView.
    expect(colorView).not.toBe(screenView)
    // msaa(format bgra8unorm), stencil, pick(rg32uint sc1), overdrawAccum = 4.
    expect(fake.created.length).toBe(4)
    const msaa = rt.msaaTexture as unknown as FakeTexture
    expect(msaa.desc.format).toBe('bgra8unorm')
    expect(msaa.desc.sampleCount).toBe(4)
    const pick = rt.pickTexture as unknown as FakeTexture
    expect(pick.desc.format).toBe('rg32uint')
    // pick stays single-sample regardless of the opaque sample count, and
    // carries copy-src so the readback can copyTextureToBuffer it.
    expect(pick.desc.sampleCount).toBe(1)
    expect(pick.desc.usage).toEqual(['render', 'copy-src'])
    // The readback's coordinate authority mirrors the allocation size.
    expect(rt.pickSize()).toEqual({ width: 640, height: 480 })
  })

  it('ensureOit lazily allocates the 3 OIT targets once, recreates on size/sample change', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))
    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    const afterEnsure = fake.created.length // stencil only

    rt.ensureOit(800, 600, 1)
    // oitAccum + oitRevealage + offscreenExtrudeDepth = 3, views cached.
    expect(fake.created.length).toBe(afterEnsure + 3)
    expect(rt.oitAccumTexture).not.toBeNull()
    expect(rt.oitRevealageTexture).not.toBeNull()
    expect(rt.offscreenExtrudeDepth).not.toBeNull()
    expect(rt.oitAccumView).not.toBeNull()
    expect(rt.oitRevealageView).not.toBeNull()

    // Same size + sample count → no recreate.
    rt.ensureOit(800, 600, 1)
    expect(fake.created.length).toBe(afterEnsure + 3)

    // Sample-count change → recreate (OIT must match the opaque sample count).
    rt.ensureOit(800, 600, 4)
    expect(fake.created.length).toBe(afterEnsure + 6)
    const accum = rt.oitAccumTexture as unknown as FakeTexture
    expect(accum.desc.sampleCount).toBe(4)
    // Fill target + compose sample source in one texture.
    expect(accum.desc.usage).toEqual(['render', 'sample'])
  })

  it('does NOT recreate when ensure is called again at the same size', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    const countAfterFirst = fake.created.length
    const stencilFirst = rt.stencilTexture

    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)

    // No new textures, same handles.
    expect(fake.created.length).toBe(countAfterFirst)
    expect(rt.stencilTexture).toBe(stencilFirst)
  })

  it('recreates on resize: destroys old then allocates new at the new size', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    const firstBatch = [...fake.created]
    const countAfterFirst = fake.created.length

    rt.ensure(1024, 768, 1024, 768, 1, false, false, screenView)

    // New textures allocated for the new size.
    expect(fake.created.length).toBe(countAfterFirst * 2)
    expect(rt.msaaWidth).toBe(1024)
    expect(rt.msaaHeight).toBe(768)
    // Every first-batch texture was destroyed (recreate-on-resize).
    for (const t of firstBatch) expect(t.destroyed).toBe(true)
    // New stencil sized to the new dimensions.
    const newStencil = rt.stencilTexture as unknown as FakeTexture
    expect(newStencil.desc.width).toBe(1024)
    expect(newStencil.desc.height).toBe(768)
  })

  it('view getters self-heal across a resize — never hand back a stale view', () => {
    // The desync trap the identity-keyed cache exists to prevent: after a
    // resize recreates stencilTexture, stencilView MUST derive from the NEW
    // texture, not a view cached against the destroyed one.
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    const texA = rt.stencilTexture
    const viewA = rt.stencilView
    expect(viewA).not.toBeNull()
    // Same texture → same cached view object (no per-call allocation).
    expect(rt.stencilView).toBe(viewA)

    rt.ensure(1024, 768, 1024, 768, 1, false, false, screenView)
    expect(rt.stencilTexture).not.toBe(texA) // recreated
    // The getter now derives from the new texture: a different view object,
    // and never the one bound to the destroyed texture.
    expect(rt.stencilView).not.toBe(viewA)
    expect(rt.stencilView).not.toBeNull()
  })

  it('NOT scaled ⇒ the pre-split frame by IDENTITY — no scene pair, every seam field reduces (#1429)', () => {
    // The scale-1 constructive no-op gate: a host that never trips the
    // ladder allocates nothing new and every INC-2 field is the identity of
    // a pre-split field — not an equal value, the SAME object.
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    const r1 = rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    expect(r1.sceneScaled).toBe(false)
    expect(rt.sceneColorTexture).toBeNull()
    expect(rt.screenMsaaTexture).toBeNull()
    expect(r1.sceneColorSampleView).toBeNull()
    expect(r1.sceneResolveView).toBe(screenView)
    expect(r1.colorViewScreen).toBe(r1.colorView)
    expect(fake.created.length).toBe(1) // stencil only — the pre-split count

    const fake4 = makeFakeRhi()
    const rt4 = new RenderTargets(() => makeCtx(fake4.rhi))
    const r4 = rt4.ensure(640, 480, 640, 480, 4, false, false, screenView)
    expect(r4.sceneScaled).toBe(false)
    expect(r4.sceneResolveView).toBe(screenView)
    expect(r4.colorViewScreen).toBe(r4.colorView)
    expect(fake4.created.length).toBe(2) // msaa + stencil — the pre-split count
  })

  it('scaled + MSAA ⇒ scene-sized scene block, sceneColor + screenMsaa pair, seam fields split (#1429)', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    const r = rt.ensure(576, 416, 800, 600, 4, false, false, screenView)
    expect(r.sceneScaled).toBe(true)
    // Scene block sized from SCENE pixels.
    const msaa = rt.msaaTexture as unknown as FakeTexture
    expect(msaa.desc.width).toBe(576)
    const stencil = rt.stencilTexture as unknown as FakeTexture
    expect(stencil.desc.width).toBe(576)
    // The pair: sceneColor single-sample scene-sized + sampleable; screenMsaa
    // at native size with the frame's sample count.
    const sceneColor = rt.sceneColorTexture as unknown as FakeTexture
    expect(sceneColor.desc.width).toBe(576)
    expect(sceneColor.desc.sampleCount).toBe(1)
    expect(sceneColor.desc.usage).toEqual(['render', 'sample'])
    const screenMsaa = rt.screenMsaaTexture as unknown as FakeTexture
    expect(screenMsaa.desc.width).toBe(800)
    expect(screenMsaa.desc.sampleCount).toBe(4)
    // Scene passes write the scene MSAA and resolve into sceneColor; the
    // seam samples sceneColor; seam + overlay write screenMsaa.
    expect(r.colorView).toBe(rt.msaaView)
    expect(r.sceneResolveView).toBe(r.sceneColorSampleView)
    expect(r.sceneResolveView).not.toBe(screenView)
    expect(r.colorViewScreen).not.toBe(r.colorView)
  })

  it('scaled without MSAA ⇒ sceneColor is the direct scene target; overlay writes the swapchain (#1429)', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    const r = rt.ensure(576, 416, 800, 600, 1, false, false, screenView)
    expect(r.sceneScaled).toBe(true)
    expect(rt.screenMsaaTexture).toBeNull() // sc === 1 — no MSAA anywhere
    expect(r.colorView).toBe(r.sceneColorSampleView) // direct scene write
    expect(r.colorViewScreen).toBe(screenView)
  })

  it('a ladder notch moves the scene while the canvas is unchanged ⇒ scene block + pair recreate (#1429)', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    rt.ensure(576, 416, 800, 600, 4, false, false, screenView)
    const colorA = rt.sceneColorTexture as unknown as FakeTexture
    rt.ensure(480, 352, 800, 600, 4, false, false, screenView)
    expect(colorA.destroyed).toBe(true)
    const colorB = rt.sceneColorTexture as unknown as FakeTexture
    expect(colorB.desc.width).toBe(480)
    expect(rt.msaaWidth).toBe(480)
  })

  it('the ladder recovering to native retires the pair (#1429)', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    rt.ensure(576, 416, 800, 600, 4, false, false, screenView)
    const sceneColor = rt.sceneColorTexture as unknown as FakeTexture
    const screenMsaa = rt.screenMsaaTexture as unknown as FakeTexture

    const r = rt.ensure(800, 600, 800, 600, 4, false, false, screenView)
    expect(r.sceneScaled).toBe(false)
    expect(sceneColor.destroyed).toBe(true)
    expect(screenMsaa.destroyed).toBe(true)
    expect(rt.sceneColorTexture).toBeNull()
    expect(rt.screenMsaaTexture).toBeNull()
    expect(r.sceneResolveView).toBe(screenView)
    expect(r.colorViewScreen).toBe(r.colorView)
  })

  it('*Native getters unwrap the SAME cached view — the P6 compose residue, pinned (review finding 6)', () => {
    // The three native getters exist ONLY for the raw compose bind groups
    // (P6); each must be the `.native` of the cached RHI view — the same
    // object every read (cache-backed, no re-mint), never undefined.
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))
    rt.ensure(640, 480, 640, 480, 4, false, true, screenView) // overdraw on
    rt.ensureOit(640, 480, 4)

    const nativeOf = (v: RhiTextureView | null): unknown =>
      (v as unknown as { native: unknown }).native
    expect(rt.overdrawViewNative).toBeDefined()
    expect(rt.overdrawViewNative).toBe(nativeOf(rt.overdrawView))
    expect(rt.oitAccumViewNative).toBe(nativeOf(rt.oitAccumView))
    expect(rt.oitRevealageViewNative).toBe(nativeOf(rt.oitRevealageView))
    // Identity-stable across reads (the cache, not a per-read unwrap+mint).
    expect(rt.overdrawViewNative).toBe(rt.overdrawViewNative)

    // Source pin: exactly the THREE compose-residue call sites unwrap in
    // render-targets.ts — a fourth is a new native leak; fewer means a
    // getter lost its backing without this file noticing.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'render-targets.ts'),
      'utf8',
    )
    expect(src.match(/unwrapWebGpuTextureView\(/g) ?? []).toHaveLength(3)
  })

  it('pickSize() survives invalidate() while the texture lives — the #1429 authority is the TEXTURE (review F1)', () => {
    // The retired native read was `pickTexture.width` — untouched by
    // invalidate(), so a pickAt in the setQuality→next-ensure window still
    // sampled the live texture correctly. pickSize() must mirror that
    // lifetime exactly: recorded at mint, zeroed only when the texture goes
    // away (device swap / pick disabled), NEVER by the recreate tracker.
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    rt.ensure(800, 600, 800, 600, 1, true, false, screenView)
    expect(rt.pickSize()).toEqual({ width: 800, height: 600 })

    rt.invalidate()
    expect(rt.pickTexture).not.toBeNull() // the texture is still the pick source
    expect(rt.pickSize()).toEqual({ width: 800, height: 600 }) // ← the F1 window

    // Pick disabled on the next ensure ⇒ no texture ⇒ size zeroes with it.
    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    expect(rt.pickTexture).toBeNull()
    expect(rt.pickSize()).toEqual({ width: 0, height: 0 })
  })

  it('invalidate() forces a recreate even when w/h are unchanged', () => {
    const fake = makeFakeRhi()
    const rt = new RenderTargets(() => makeCtx(fake.rhi))

    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    const countAfterFirst = fake.created.length

    // Same size → no recreate without invalidate.
    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    expect(fake.created.length).toBe(countAfterFirst)

    // invalidate zeroes the size tracker → next ensure recreates.
    rt.invalidate()
    expect(rt.msaaWidth).toBe(0)
    expect(rt.msaaHeight).toBe(0)
    rt.ensure(800, 600, 800, 600, 1, false, false, screenView)
    expect(fake.created.length).toBe(countAfterFirst * 2)
  })
})
