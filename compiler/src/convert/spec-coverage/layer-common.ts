import type { CoverageEntry } from './types'

// ─── 3b. Layer common fields ──────────────────────────────────────────
export const LAYER_COMMON: readonly CoverageEntry[] = [
  {
    name: 'id',
    status: 'supported',
    note: 'Sanitised into a valid xgis identifier.',
    source: 'layers.ts:520',
  },
  { name: 'type', status: 'supported', note: 'Discriminator — see Layer types table above.' },
  { name: 'source', status: 'supported', source: 'layers.ts:521' },
  {
    name: 'source-layer',
    status: 'supported',
    note: 'Lowered to `sourceLayer: "..."` block prop.',
    source: 'layers.ts:522',
  },
  {
    name: 'minzoom',
    status: 'supported',
    note: 'PR #81: enforced at every label submission via `inZoomRange`.',
    source: 'layers.ts:523',
  },
  { name: 'maxzoom', status: 'supported', source: 'layers.ts:524' },
  {
    name: 'filter',
    status: 'supported',
    note: 'Legacy + expression form; routes through filter-eval.',
    source: 'layers.ts:525',
  },
  {
    name: 'metadata',
    status: 'unsupported',
    impact: 'low',
    note: 'Silently dropped by convertLayer — informational only, so no visual effect, but `unsupported` not `na`: the ROOT `metadata` row is `supported` because the converter preserves that level as a comment, which is a live counterexample to `na`\'s "no xgis equivalent and no plan to add". The two rows are bound to the converter\'s actual per-level behaviour by style-metadata-preserved.test.ts, so neither can drift from it or from the other again.',
  },
  {
    name: 'slot',
    status: 'unsupported',
    impact: 'medium',
    note: "v3 — names a position inside an IMPORTED style's layer stack. Imports are emitted as one block ahead of the root layers, so a slotted layer draws above the whole import; a per-layer warning names the slot when the style has imports (#2476). Interleaving is undesigned.",
  },
  { name: 'ref', status: 'na', note: 'Deprecated layer-ref shorthand (Mapbox style spec v7).' },
]
