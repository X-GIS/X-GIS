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
    status: 'na',
    note: "na — incompatible with X-GIS' single-merged-mesh-per-tile draw model. X-GIS tessellates every fill feature of a layer into ONE merged mesh per tile (no per-feature draw loop), so a CONSTANT sort-key (the only form seen in practice) is a no-op BY CONSTRUCTION (uniform key → stable sort = source order = today's pixels), and honouring the data-driven form would require re-architecting the merged-mesh into a per-feature index-buffer reorder in the tiler's CPU↔WGSL byte-contract packing path — a change the single-draw perf design deliberately precludes. symbol-z-order — the tractable sibling on the per-feature symbol collision/draw pass — is shipped (Phase S Batch 4).",
  },
  {
    name: 'line-sort-key',
    status: 'na',
    note: 'na — same single-draw-architecture incompatibility as fill-sort-key: line features share ONE packed segment buffer per tile, so a constant sort-key is a no-op by construction and the data-driven form would need the merged-buffer reorder the single-draw design precludes.',
  },
  {
    name: 'circle-sort-key',
    status: 'na',
    note: "na — same single-draw-architecture incompatibility as fill-sort-key: PointRenderer draws the layer's circles from ONE shared instance buffer, so a constant sort-key is a no-op by construction and the data-driven form would need a per-feature instance reorder the single-draw design precludes. (Sibling symbol-z-order shipped Phase S Batch 4.)",
  },
]
