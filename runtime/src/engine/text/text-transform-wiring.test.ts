// text-transform: runtime wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-transform is
// marked `supported` (uppercase/lowercase/none) and the PURE helper
// applyTextTransform is unit-tested in text-stage.test.ts — but nothing
// pinned the WIRING that TextStage.addLabel actually threads the lowered
// LabelDef.transform field INTO applyTextTransform before the label is
// dispatched. The helper could stay correct while the call site silently
// drops `def.transform` (passes undefined), and every "uppercase" label
// would ship mixed-case with no test failing — the heatmap-class
// data-path break, but for text-transform.
//
// This drives the REAL TextStage.addLabel against the WebGPU stub (no GPU;
// the constructor's atlas/renderer are built against the stub device, the
// addLabel path itself — resolveText → applyTextTransform → recordDispatch
// — is pure CPU) and reads the CPU-observable dispatch diagnostic
// (getDispatchedLabelTexts) which records the POST-transform string.
//
// Non-vacuous: the asserted dispatched string is a direct function of
// def.transform — 'uppercase' → 'SEOUL', 'lowercase' → 'seoul', none →
// 'Seoul'. Fail-before: drop `def.transform` at the addLabel call site
// (text-stage.ts:565, applyTextTransform(text, def.transform) →
// applyTextTransform(text, undefined)) and the uppercase/lowercase
// assertions fail — the wire that makes text-transform reach the glyph
// pipeline is gone, and this test catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { TextStage } from './text-stage'
import { WebGpuDevice } from '@xgis/engine'
import type { LabelDef, TextValue } from '@xgis/compiler'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800; height = 600
      getContext(_t: string): unknown { return null }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => { stub.uninstall() })

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

// A literal text-field value that resolves to a fixed mixed-case string,
// so the transform result is unambiguous: 'Seoul' → 'SEOUL' / 'seoul'.
const VALUE: TextValue = {
  kind: 'expr',
  expr: { ast: { kind: 'StringLiteral', value: 'Seoul' } as never },
}

/** Add one point label whose LabelDef carries the given text-transform,
 *  then return the single string the stage recorded as DISPATCHED — i.e.
 *  the post-applyTextTransform text the addLabel call-site produced. */
function dispatchedFor(
  ctx: GPUContext,
  transform: 'none' | 'uppercase' | 'lowercase' | undefined,
): string {
  const stage = new TextStage(ctx.device, new WebGpuDevice(ctx.device), ctx.format)
  stage.clearDispatchedLabelTexts()
  const def: LabelDef = { text: VALUE, size: 12, transform }
  stage.addLabel(VALUE, {}, 100, 100, def)
  const dispatched = stage.getDispatchedLabelTexts()
  expect(dispatched.length, 'addLabel should have dispatched exactly one label').toBe(1)
  return dispatched[0]!
}

describe('text-transform runtime wiring (GPU-free)', () => {
  it("transform='uppercase' threads def.transform → dispatched text is uppercased", async () => {
    const ctx = await makeCtx()
    // Break the addLabel call-site (drop def.transform) and this fails.
    expect(dispatchedFor(ctx, 'uppercase')).toBe('SEOUL')
  })

  it("transform='lowercase' threads def.transform → dispatched text is lowercased", async () => {
    const ctx = await makeCtx()
    expect(dispatchedFor(ctx, 'lowercase')).toBe('seoul')
  })

  it("transform='none' / undefined → dispatched text is unchanged", async () => {
    const ctx = await makeCtx()
    expect(dispatchedFor(ctx, 'none')).toBe('Seoul')
    expect(dispatchedFor(ctx, undefined)).toBe('Seoul')
  })
})
