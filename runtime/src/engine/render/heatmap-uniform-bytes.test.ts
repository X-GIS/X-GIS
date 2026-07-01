import { describe, expect, it } from 'vitest'
import { heatmapUniformSlots, heatmapUniformBytes } from '@xgis/map'

// Byte-identity gate for the heatmap-accum 'Uniforms' SIZE migration: the
// hand-coded literals (`new Float32Array(36)` scratch + bind `size: 144`) are now
// reflect-derived via heatmapUniformSlots().slots / heatmapUniformBytes(). The
// reflect value MUST equal the figure that shipped, or the migration silently
// changed the bound range (under-bind → WebGPU validation drop). If the DSL
// struct legitimately grows, bump these — a conscious re-bake (the whole point:
// the bind size can no longer drift from the struct unnoticed).
describe('heatmap-accum uniform size — reflect === shipped literal', () => {
  it('slots === 36 (mvp16 + proj4 + viewport4 + cam_h4 + cam_l4 + globe_eye4)', () => {
    expect(heatmapUniformSlots().slots).toBe(36)
  })
  it('heatmapUniformBytes() === 144 (= slots × 4)', () => {
    expect(heatmapUniformBytes()).toBe(144)
    expect(heatmapUniformBytes()).toBe(heatmapUniformSlots().slots * 4)
  })
})
