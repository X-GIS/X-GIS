// ═══ Render-target views reach the passes through the RHI (#1046 F4 — Inc-D) ═══
//
// RenderTargets allocates through `RhiDevice.createTexture` and hands out
// RhiTextureView handles directly, so the loop-side native bridge machinery
// (`_rhiViewMemo` / `_rhiViewFor` / the screen-view unwrap) is gone — the
// last chain-frame native besides the P6-scoped compose bind groups. This
// file pins the LOOP side: render-loop.ts and frame-context.ts hold ZERO
// native texture-view bridge calls. The allocation side is pinned by the
// FakeRhiDevice port of render-targets-ensure.test.ts, whose ctx.device is
// booby-trapped — proving ensure can never hit the WebGL2 chain frame's
// fail-loud device Proxy (flip blocker #1).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcOf = (rel: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), 'utf8')

describe('target-view seam (#1046 F4 Inc-D)', () => {
  it('render-loop holds ZERO native texture-view bridges', () => {
    const src = srcOf('../render-loop.ts')
    // A survivor is a loop-tail native the WebGL2 chain frame would crash on
    // (the unwrap of a WebGl2-minted view) — the exact class of residue Inc-D
    // exists to retire. `unwrapWebGpuTexture\b` closes the bypass spelling
    // (unwrap the TEXTURE, then native .createView() on it — verification
    // review finding 5); `.createView(` itself is NOT banned because the
    // loop's pick path legitimately calls the RHI form `rhi.createView(...)`,
    // and a ban that fires on correct code distinguishes nothing.
    expect(src.match(/unwrapWebGpuTextureView/g) ?? []).toHaveLength(0)
    expect(src.match(/wrapWebGpuTextureView/g) ?? []).toHaveLength(0)
    expect(src.match(/unwrapWebGpuTexture\b/g) ?? []).toHaveLength(0)
  })

  it('frame-context wires the colour bridges without a native view in sight', () => {
    const src = srcOf('./frame-context.ts')
    // wireFrameColour consumes RenderTargets.ensure's RHI-typed result
    // directly — no memo-wrap callback rides the signature, and no native
    // view type is spelled anywhere in the file.
    expect(src.match(/unwrapWebGpuTextureView/g) ?? []).toHaveLength(0)
    expect(src.match(/wrapWebGpuTextureView/g) ?? []).toHaveLength(0)
    expect(src.match(/unwrapWebGpuTexture\b/g) ?? []).toHaveLength(0)
    expect(src.match(/GPUTextureView/g) ?? []).toHaveLength(0)
    expect(src.match(/rhiViewFor/g) ?? []).toHaveLength(0)
  })
})
