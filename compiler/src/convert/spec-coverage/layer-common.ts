import type { CoverageEntry } from './types'

// ─── 3b. Layer common fields ──────────────────────────────────────────
export const LAYER_COMMON: readonly CoverageEntry[] = [
  { name: 'id',           status: 'supported', note: 'Sanitised into a valid xgis identifier.', source: 'layers.ts:520' },
  { name: 'type',          status: 'supported', note: 'Discriminator — see Layer types table above.' },
  { name: 'source',        status: 'supported', source: 'layers.ts:521' },
  { name: 'source-layer',  status: 'supported', note: 'Lowered to `sourceLayer: "..."` block prop.', source: 'layers.ts:522' },
  { name: 'minzoom',       status: 'supported', note: 'PR #81: enforced at every label submission via `inZoomRange`.', source: 'layers.ts:523' },
  { name: 'maxzoom',       status: 'supported', source: 'layers.ts:524' },
  { name: 'filter',        status: 'supported', note: 'Legacy + expression form; routes through filter-eval.', source: 'layers.ts:525' },
  { name: 'metadata',      status: 'unsupported', impact: 'low', note: 'Informational — silently dropped.' },
  { name: 'ref',           status: 'na', note: 'Deprecated layer-ref shorthand (Mapbox style spec v7).' },
]
