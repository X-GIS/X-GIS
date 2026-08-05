// ═══ #1605 Phase 0 — the silent-drop dev warning ═══
// warnStageBlockUnsupported is the fix for the silent half of #1605: a
// @color/@stroke stage block on a point/line layer used to compile clean
// and render the flat fallback with zero signal. These tests pin the guard
// logic directly (sink injected, mirroring checkPatternParams's callback
// shape in line-pattern.ts) rather than mocking xlog.

import { describe, expect, it } from 'vitest'
import { warnStageBlockUnsupported } from '@xgis/map'

function collect(): { calls: string[]; sink: (msg: string) => void } {
  const calls: string[] = []
  return { calls, sink: (msg) => calls.push(msg) }
}

describe('warnStageBlockUnsupported (#1605)', () => {
  it('is quiet when the layer carries no stage-block expression', () => {
    const { calls, sink } = collect()
    warnStageBlockUnsupported('layer-quiet-1', 'point', false, sink)
    expect(calls).toEqual([])
  })

  it('warns once, naming the layer, kind, and #1605', () => {
    const { calls, sink } = collect()
    warnStageBlockUnsupported('layer-warn-1', 'point', true, sink)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('layer-warn-1')
    expect(calls[0]).toContain('point')
    expect(calls[0]).toContain('#1605')
  })

  it('dedupes: a second call for the same layer + kind stays quiet', () => {
    const { calls, sink } = collect()
    warnStageBlockUnsupported('layer-warn-2', 'line', true, sink)
    warnStageBlockUnsupported('layer-warn-2', 'line', true, sink)
    warnStageBlockUnsupported('layer-warn-2', 'line', true, sink)
    expect(calls).toHaveLength(1)
  })

  it('point and line are independent keys for the same layer name', () => {
    const { calls, sink } = collect()
    warnStageBlockUnsupported('layer-warn-3', 'point', true, sink)
    warnStageBlockUnsupported('layer-warn-3', 'line', true, sink)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('point')
    expect(calls[1]).toContain('line')
  })

  it('a later false call does not re-arm an already-warned key', () => {
    const { calls, sink } = collect()
    warnStageBlockUnsupported('layer-warn-4', 'point', true, sink)
    warnStageBlockUnsupported('layer-warn-4', 'point', false, sink)
    warnStageBlockUnsupported('layer-warn-4', 'point', true, sink)
    expect(calls).toHaveLength(1)
  })
})
