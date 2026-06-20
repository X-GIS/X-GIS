import type { CoverageEntry } from './types'

// ─── 4. Layout properties (per layer type) ───────────────────────────
export const LAYOUT_FILL_LINE: readonly CoverageEntry[] = [
  { name: 'visibility',       status: 'supported', note: '`none` → `visible: false`.', source: 'layers.ts:538' },
  { name: 'line-cap',         status: 'supported', note: 'butt / round / square literals only.', source: 'layers.ts:548' },
  { name: 'line-join',        status: 'supported', note: 'miter / round / bevel literals only.', source: 'layers.ts:552' },
  { name: 'line-miter-limit', status: 'supported', note: 'Constant only.', source: 'layers.ts:556' },
  { name: 'line-round-limit', status: 'unsupported', impact: 'low', note: 'Limit beyond which round joins switch to bevel. X-GIS line-join logic uses a fixed threshold; per-layer override not threaded.' },
  { name: 'fill-sort-key',    status: 'unsupported', impact: 'low', note: 'Per-feature fill draw-order. X-GIS uses layer-order; per-feature would need an additional sort pass.' },
  { name: 'line-sort-key',    status: 'unsupported', impact: 'low', note: 'Per-feature line draw-order. Same gap as fill-sort-key.' },
  { name: 'circle-sort-key',  status: 'unsupported', impact: 'low', note: 'Per-feature draw-order key for circle layers; current renderer ignores it.' },
]
