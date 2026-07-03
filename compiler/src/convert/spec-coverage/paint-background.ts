import type { CoverageEntry } from './types'

// ─── 5. Paint properties ──────────────────────────────────────────────
export const PAINT_BACKGROUND: readonly CoverageEntry[] = [
  {
    name: 'background-color',
    status: 'supported',
    impact: 'low',
    note: 'Constant + CSS form fold to a hex; interpolate-by-zoom resolves per frame (WS-1) — flat via the background-pass clear, sphere via the synthetic earth-surface show paintShapes.fill.',
  },
  {
    name: 'background-opacity',
    status: 'supported',
    impact: 'low',
    note: 'Constant numeric form folds into background-color hex alpha (iter 47, mirror of circle-stroke-opacity iter 4). Interpolate-by-zoom emits an opacity: style property that resolves per frame (WS-1) and multiplies into the background clear alpha on the FLAT path. On sphere/globe the synthetic earth-surface show carries the colour shape but the separate per-zoom opacity is not applied there (the earth surface is opaque; sphere bg-opacity semantics are a documented follow-up).',
  },
  {
    name: 'background-pattern',
    status: 'unsupported',
    impact: 'low',
    note: 'Needs sprite atlas + tiled fragment. Batch 2 dependency.',
  },
]
