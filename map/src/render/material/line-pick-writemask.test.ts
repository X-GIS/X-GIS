// ═══ #1215 — line/stroke pick target must be writeMask 0 (GPU-free descriptor gate) ═══
//
// Adjudication of #1058 (filed as #1215): the line pick fragment writes
// pick = vec2u(0,0) by design (a LineSegment carries no per-feature id), and the
// pick decode treats either channel = 0 as a miss (interaction-controller.ts:275).
// If the line pick material's rg32uint pick target is UNMASKED, an opaque stroke
// covering a fill overwrites the fill's real pick id with (0,0) in the shared
// opaque-pass pick attachment — a click on a road over a country polygon misses.
//
// Fix: the pick target carries writeMask 0 so strokes stop writing their useless
// (0,0) into the pick attachment. The colour target (0) keeps writing.
//
// FAIL-BEFORE: on origin/main the rg32uint pick target has NO writeMask (undefined),
// so `expect(pickTarget.writeMask).toBe(0)` fails for both the plain and pattern
// line pipeline variants.

import { describe, it, expect } from 'vitest'
import type { RhiDevice, RhiRenderPass } from '@xgis/engine'
import { LineDraper, type LineBatch } from './line-material'

interface CapturedPipeline {
  label?: string
  colorTargets: ReadonlyArray<{ format: string; blend?: string; writeMask?: number }>
}

/** Construct a LineDraper against a fake RhiDevice that captures every
 *  createPipeline call, then trigger the LAZY pick material via a no-op
 *  draw(mode='pick'). The pick Material's constructor eagerly builds both
 *  variants (plain + pattern), so their colorTargets land in `captured`. */
function captureLinePickVariants(): CapturedPipeline[] {
  const captured: CapturedPipeline[] = []
  const rhi = {
    backend: 'webgpu',
    createPipeline: (d: CapturedPipeline) => {
      captured.push(d)
      return {}
    },
  } as unknown as RhiDevice
  // Dummy native layouts — wrapWebGpuBindGroupLayout just boxes them as { native }.
  const layout = {} as unknown as GPUBindGroupLayout
  const draper = new LineDraper(rhi, 'bgra8unorm', 4, layout, layout)
  // No-op pass so executeItems runs harmlessly; the pick Material is built first.
  const pass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    setVertexBuffer: () => {},
    draw: () => {},
    drawIndexed: () => {},
    setIndexBuffer: () => {},
  } as unknown as RhiRenderPass
  const batch: LineBatch = {
    tileBG: {} as LineBatch['tileBG'],
    layerBG: {} as LineBatch['layerBG'],
    tileOffset: 0,
    layerOffset: 0,
    pattern: false,
    segmentCount: 0,
  }
  draper.draw(pass, batch, 'pick')
  return captured
}

const byLabel = (caps: CapturedPipeline[], needle: string): CapturedPipeline => {
  const hit = caps.find((c) => (c.label ?? '').includes(needle))
  if (!hit)
    throw new Error(
      `no line variant labelled *${needle}* (found: ${caps.map((c) => c.label).join(', ')})`,
    )
  return hit
}

describe('#1215 line pick target writeMask — pipeline descriptors', () => {
  it('both pick variants declare a two-target MRT (colour + rg32uint pick)', () => {
    const caps = captureLinePickVariants()
    for (const needle of ['line-pipeline-pick-rhi', 'line-pipeline-pattern-pick-rhi']) {
      const v = byLabel(caps, needle)
      expect(v.colorTargets.length, `${needle} target count`).toBe(2)
      expect(v.colorTargets[1]?.format, `${needle} pick format`).toBe('rg32uint')
    }
  })

  it('the rg32uint pick target is writeMask 0 (strokes must not clobber the fill id)', () => {
    const caps = captureLinePickVariants()
    for (const needle of ['line-pipeline-pick-rhi', 'line-pipeline-pattern-pick-rhi']) {
      const v = byLabel(caps, needle)
      expect(v.colorTargets[1]?.writeMask, `${needle} pick writeMask`).toBe(0)
    }
  })

  it('the colour target (0) still writes — the stroke colour is NOT masked', () => {
    const caps = captureLinePickVariants()
    for (const needle of ['line-pipeline-pick-rhi', 'line-pipeline-pattern-pick-rhi']) {
      const v = byLabel(caps, needle)
      // No writeMask override (undefined) or an explicit non-zero mask both mean "writes".
      expect(v.colorTargets[0]?.writeMask, `${needle} colour writeMask`).not.toBe(0)
    }
  })
})
