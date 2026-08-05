// ═══ The raster draws clamp `pick` by the DEVICE, not by the host's ask (#1046 Inc-F2d) ═══
//
// Picking is two different facts wearing one name. `QUALITY.picking` is what the
// HOST asked for; whether the frame can carry the rg32uint pick attachment is a
// device CAPABILITY (`caps.presentablePassMrt`). A presentable pass that cannot
// do MRT — WebGl2Device, where FBO 0 takes one colour attachment — gets exactly
// one attachment, so a draw that selects a two-target pick pipeline there is an
// attachment mismatch, every frame.
//
// The ask and the draw must therefore come from the SAME expression:
// RenderTargets allocates the attachment from it (frame-context.ts), the opaque
// pass attaches it from it, and every draper selects its pipeline from it. That
// is `pickTargetsEnabled(caps)` — one authority, in the engine beside
// `isPickEnabled` so a consumer cannot reach one without seeing the other.
//
// WHY THIS FILE EXISTS. The expression was briefly duplicated, and the copy in
// raster-renderer drifted to a bare `isPickEnabled()`. Nothing caught it:
// reverting the argument entirely left 43 files and 265 tests green, because the
// checker gate mocks `renderRhiChecker` wholesale and the resampling gate reads
// only `_nearest`. The repo already had this exact lesson written down one layer
// up — `wire-frame-colour-pick-cap.test.ts` exists because passing
// `isPickEnabled()` straight through to RenderTargets was the same bug — and it
// was reproduced two files over regardless.
//
// Reachability, so this is not a hypothetical: `quality.ts` drops picking for
// `?debug=overdraw` only, never for `?debug=checker`. So
// `?forcegl2=1&debug=checker&picking=1` is a URL that reaches it, and after the
// twin is deleted the WebGL2 chain is the default frame for it.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QUALITY, pickTargetsEnabled } from '@xgis/engine'

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'raster-renderer.ts'),
  'utf8',
)

const orig = QUALITY.picking
afterEach(() => {
  QUALITY.picking = orig
})

const WEBGL2 = { presentablePassMrt: false }
const WEBGPU = { presentablePassMrt: true }

describe('pickTargetsEnabled — the one clamp both the ask and the draw read (#1046 Inc-F2d)', () => {
  it('host asks for picking + device CANNOT present MRT ⇒ no pick targets', () => {
    QUALITY.picking = true
    expect(
      pickTargetsEnabled(WEBGL2),
      'a two-target pick pipeline would be selected for a pass that has one attachment — the ' +
        'mismatch ?forcegl2=1&debug=checker&picking=1 hits, every frame',
    ).toBe(false)
  })

  it('host asks + device CAN ⇒ pick targets, so this is a clamp and not an off-switch', () => {
    // The anti-vacuity arm. A blanket `false` satisfies the case above while
    // silently killing picking on WebGPU, where it is the whole feature.
    QUALITY.picking = true
    expect(pickTargetsEnabled(WEBGPU), 'WebGPU must keep picking').toBe(true)
  })

  it('host did NOT ask ⇒ no pick targets on either device', () => {
    QUALITY.picking = false
    expect(pickTargetsEnabled(WEBGPU)).toBe(false)
    expect(pickTargetsEnabled(WEBGL2)).toBe(false)
  })
})

describe('the raster draws consume that clamp, not the bare ask (#1046 Inc-F2d review MAJOR-1/2)', () => {
  // A SOURCE gate: both draws need a real device, draper, camera and packed
  // uniforms to run, and a stub deep enough to execute them would pin the mock.
  // What must not regress is WHICH expression reaches the `pick` slot, so that
  // is what is asserted — and the #996 guards below prove the anchors resolve.
  it('every anchor is still present (not vacuous — #996)', () => {
    expect(SRC).toContain('pickTargetsEnabled')
    expect(SRC, 'the checker draw').toContain('draper.draw(pass, B.buffer, tiles, false,')
    expect(SRC, 'the live raster draw').toContain('this.ensureRasterDraper().draw(')
  })

  it('NEITHER draw passes a bare isPickEnabled() into the pick slot', () => {
    // The exact regression, twice shipped: copying the neighbouring call site
    // instead of the clamp authority two files over.
    expect(
      SRC,
      'a raster draw selects its pick pipeline from the host ask instead of the device clamp — ' +
        'on WebGL2 that binds a 2-target pipeline into a 1-attachment pass',
    ).not.toMatch(/\.draw\([^)]*isPickEnabled\(\)/s)
    expect(SRC, 'isPickEnabled must not even be imported here any more').not.toMatch(
      /import \{[^}]*\bisPickEnabled\b/,
    )
  })

  it('both draws reach the clamp, and neither dropped the argument entirely', () => {
    // Dropping it is silent: `pick` defaults to false, so WebGPU loses picking
    // on the raster layer with no error anywhere.
    expect(SRC).toContain(
      'draper.draw(pass, B.buffer, tiles, false, pickTargetsEnabled(this.rhi.caps))',
    )
    expect(SRC).toMatch(/const pick = pickTargetsEnabled\(this\.rhi\.caps\)/)
    expect(SRC).toMatch(/ensureRasterDraper\(\)\.draw\([^)]*this\._nearest, pick\)/s)
  })
})
