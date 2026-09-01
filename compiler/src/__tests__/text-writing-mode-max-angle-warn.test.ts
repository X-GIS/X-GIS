// Iter 90: promote text-writing-mode + text-max-angle from generic
// ignoredText aggregator to specific layer-level warnings naming
// the runtime gap. Parallel to icon-color (iter 88) and icon-halo
// / icon-text-fit (iter 89).
//
// T4 CJK vertical P1 (#2051): text-writing-mode is no longer a gap —
// it lowers end-to-end (text-writing-mode → label-writing-mode-vertical
// → LabelDef.writingMode), so its gap warning is GONE and the three
// cases below assert the EMIT plus the silence, not the warning. The
// end-to-end threading itself lives in text-writing-mode-convert.test.ts;
// what this file still owns is that NO warning is produced either way.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

function sourceOf(style: unknown): string {
  return convertMapboxStyle(style as never)
}

function buildSymbol(layout: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}', ...layout },
        paint: { 'text-color': '#000' },
      },
    ],
  }
}

describe('text-writing-mode + text-max-angle specific gap warnings', () => {
  it('text-writing-mode: ["vertical"] → wired, emits the utility, no gap warn', () => {
    const style = buildSymbol({ 'text-writing-mode': ['vertical'] })
    expect(sourceOf(style)).toContain('label-writing-mode-vertical')
    expect(warningsOf(style).some((s) => s.includes('text-writing-mode'))).toBe(false)
  })

  it('text-writing-mode: ["horizontal", "vertical"] → wired, emits the utility, no gap warn', () => {
    const style = buildSymbol({ 'text-writing-mode': ['horizontal', 'vertical'] })
    expect(sourceOf(style)).toContain('label-writing-mode-vertical')
    expect(warningsOf(style).some((s) => s.includes('text-writing-mode'))).toBe(false)
  })

  it('text-writing-mode: ["horizontal"] (default) emits nothing and does NOT warn', () => {
    const style = buildSymbol({ 'text-writing-mode': ['horizontal'] })
    expect(sourceOf(style)).not.toContain('label-writing-mode')
    expect(warningsOf(style).some((s) => s.includes('text-writing-mode'))).toBe(false)
  })

  it('text-max-angle: 30 (non-default) → wired, no gap warn', () => {
    // Now threaded end-to-end (Phase S Batch 2) — no longer a deferred gap.
    const w = warningsOf(buildSymbol({ 'text-max-angle': 30 }))
    expect(w.some((s) => s.includes('text-max-angle'))).toBe(false)
  })

  it('text-max-angle: 45 (spec default) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'text-max-angle': 45 }))
    expect(w.some((s) => s.includes('text-max-angle'))).toBe(false)
  })

  it('layer without these properties does NOT warn', () => {
    const w = warningsOf(buildSymbol({}))
    expect(w.some((s) => s.includes('text-writing-mode') || s.includes('text-max-angle'))).toBe(
      false,
    )
  })
})
