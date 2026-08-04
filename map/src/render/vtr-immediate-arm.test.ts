// ═══ VTR.render routes the immediate-execution arm to the *Rhi entries (#1046 Inc-E2) ═══
//
// The chain's ShowDrawFn terminal: on a device with executionModel
// 'immediate' (the WebGL2 truth), the native tile body cannot run — its
// pipelines are WebGPU objects and the boundary unwrap fails loud (arch F3).
// The fork must route to the twin's immediate-mode entry family INSTEAD,
// handing the pass BY IDENTITY and never touching the unwrap. The F3 guard
// itself is the booby trap here: a foreign (non-WebGPU) pass THROWS the
// named error the moment the native body is entered, so a routing mutant
// cannot pass silently.

import { describe, it, expect, vi } from 'vitest'
import { VectorTileRenderer } from './vector-tile-renderer'
import type { RhiRenderPass } from '@xgis/rhi'

const foreignPass = { __gl2Pass: true } as unknown as RhiRenderPass

function makeVtr(executionModel: 'immediate' | 'deferred') {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  ;(vtr as unknown as { rhi: unknown }).rhi = { caps: { executionModel } }
  const fills = vi.spyOn(vtr, 'renderFillsRhi').mockImplementation(() => 0)
  const lines = vi.spyOn(vtr, 'renderLinesRhi').mockImplementation(() => 0)
  const points = vi.spyOn(vtr, 'emitTilePointsRhi').mockImplementation(() => {})
  return { vtr, fills, lines, points }
}

const CAMERA = { __cam: true } as never
const SHOW = { __show: true } as never
const RESOLVED = { __resolved: true } as never
const PIPE = { label: 'p' } as never
const POINTS = { __pointRenderer: true } as never

function callRender(
  vtr: VectorTileRenderer,
  phase: 'all' | 'fills' | 'strokes' | 'oit-fill',
  translucentBucket = false,
): void {
  vtr.render(
    foreignPass,
    CAMERA,
    0,
    0,
    0,
    800,
    600,
    SHOW,
    PIPE,
    PIPE,
    {} as never,
    undefined,
    undefined,
    POINTS,
    phase,
    1,
    undefined,
    undefined,
    translucentBucket,
    RESOLVED,
  )
}

describe('VTR.render — immediate-arm routing (#1046 Inc-E2)', () => {
  it("immediate + 'all' ⇒ fills('color') → tile points → strokes('opaque'), pass BY IDENTITY, no unwrap", () => {
    const { vtr, fills, lines, points } = makeVtr('immediate')
    expect(() => callRender(vtr, 'all')).not.toThrow()
    expect(fills).toHaveBeenCalledTimes(1)
    expect(fills.mock.calls[0]![0]).toBe(foreignPass)
    expect(fills.mock.calls[0]![10]).toBe('color')
    // Twin sequencing: points read the keys fills just selected.
    expect(points).toHaveBeenCalledTimes(1)
    expect(points.mock.calls[0]![0]).toBe(foreignPass)
    expect(points.mock.calls[0]![9]).toBe(POINTS)
    expect(lines).toHaveBeenCalledTimes(1)
    expect(lines.mock.calls[0]![10]).toBe('opaque')
    // fills before points before lines (call order — the twin's sequencing).
    expect(fills.mock.invocationCallOrder[0]!).toBeLessThan(points.mock.invocationCallOrder[0]!)
    expect(points.mock.invocationCallOrder[0]!).toBeLessThan(lines.mock.invocationCallOrder[0]!)
  })

  it("immediate + translucent 'strokes' ⇒ ONLY lines, MAX-blend material", () => {
    const { vtr, fills, lines, points } = makeVtr('immediate')
    expect(() => callRender(vtr, 'strokes', true)).not.toThrow()
    expect(fills).not.toHaveBeenCalled()
    expect(points).not.toHaveBeenCalled()
    expect(lines).toHaveBeenCalledTimes(1)
    expect(lines.mock.calls[0]![0]).toBe(foreignPass)
    expect(lines.mock.calls[0]![10]).toBe('max')
  })

  it("immediate + 'fills' ⇒ fills + points, no strokes", () => {
    const { vtr, fills, lines, points } = makeVtr('immediate')
    expect(() => callRender(vtr, 'fills')).not.toThrow()
    expect(fills).toHaveBeenCalledTimes(1)
    expect(points).toHaveBeenCalledTimes(1)
    expect(lines).not.toHaveBeenCalled()
  })

  it('deferred ⇒ the NATIVE body is entered (the F3 booby trap fires on the foreign pass)', () => {
    const { vtr, fills } = makeVtr('deferred')
    expect(() => callRender(vtr, 'all')).toThrow(/native-bodied terminal|not a WebGPU pass/)
    expect(fills).not.toHaveBeenCalled()
  })

  it("immediate + 'oit-fill' ⇒ falls through to the native body's NAMED failure (P6 scope)", () => {
    const { vtr, fills } = makeVtr('immediate')
    expect(() => callRender(vtr, 'oit-fill')).toThrow(/native-bodied terminal|not a WebGPU pass/)
    expect(fills).not.toHaveBeenCalled()
  })
})
