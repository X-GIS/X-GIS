import type { CoverageEntry } from './types'

// ─── 4. Layout properties (per layer type) ───────────────────────────
export const LAYOUT_FILL_LINE: readonly CoverageEntry[] = [
  {
    name: 'visibility',
    status: 'supported',
    note: '`none` → `visible: false`.',
    source: 'layers.ts:538',
  },
  {
    name: 'line-cap',
    status: 'supported',
    note: 'butt / round / square literals only.',
    source: 'layers.ts:548',
  },
  {
    name: 'line-join',
    status: 'supported',
    note: 'miter / round / bevel literals only.',
    source: 'layers.ts:552',
  },
  {
    name: 'line-miter-limit',
    status: 'supported',
    note: 'Constant only.',
    source: 'layers.ts:556',
  },
  {
    name: 'line-round-limit',
    status: 'supported',
    note: "Per-layer round-join fold threshold (default 1.05). Threaded end-to-end: layout `line-round-limit` → `stroke-roundlimit-N` → StrokeNode.roundLimit → ShowCommand → line layer uniform slot → the line shader scales its round-join acute-fold threshold by round-limit / 1.05. UNSET / default reproduces today's geometry byte-for-byte (the shader keeps its historical fold constant when the uniform is 0).",
    source: 'layer-converters/line.ts:48',
  },
  {
    name: 'fill-sort-key',
    status: 'unsupported',
    impact: 'low',
    note: "Per-feature fill draw-order. X-GIS tessellates every fill feature of a layer into ONE merged mesh per tile (no per-feature draw loop), so a CONSTANT sort-key is a no-op (uniform key → stable sort = source order = today's pixels) and the data-driven form needs a per-feature index-buffer reorder in the tiler's CPU↔WGSL byte-contract packing path. Deferred (high blast radius). symbol-z-order — the tractable sibling on the per-feature symbol collision/draw pass — is shipped (Phase S Batch 4).",
  },
  {
    name: 'line-sort-key',
    status: 'unsupported',
    impact: 'low',
    note: 'Per-feature line draw-order. Same merged-mesh gap as fill-sort-key (line features share one packed segment buffer per tile); constant form no-op, data-driven needs the tiler reorder. Deferred.',
  },
  {
    name: 'circle-sort-key',
    status: 'unsupported',
    impact: 'low',
    note: "Per-feature draw-order key for circle layers. PointRenderer draws the layer's circles from one shared instance buffer; constant form no-op, data-driven needs a per-feature instance reorder. Deferred (sibling symbol-z-order shipped Phase S Batch 4).",
  },
]
