import { describe, it, expect } from 'vitest'
import {
  emitArrowRetainedAdvectedWgsl,
  emitArrowRetainedAdvectedGlslStages,
} from './arrow-advected'
describe('smoke', () => {
  it('emits', () => {
    const w = emitArrowRetainedAdvectedWgsl()
    expect(w).toContain('fn vs_arrow_retained_advected(')
    const g = emitArrowRetainedAdvectedGlslStages()
    expect(g.vertex.length).toBeGreaterThan(0)
    console.log(w.slice(w.indexOf('fn vs_arrow_retained_advected(')))
  })
})
