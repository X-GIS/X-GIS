// ═══ Pass-order authority — ONE frozen sequence, consumed by both orchestrations ═══
//
// The full-frame pass sequence is executed by TWO paths (#1004): the native
// pass-chain (pass-chain.ts buildRenderNodes — the WebGPU authority) and the
// forced-WebGL2 linear twin (render-loop.ts renderFrameViaRhi). Before this
// module each hand-maintained its own copy of the order, and the comments in
// render-loop.ts enumerate the real divergence bugs that caused (vanishing
// point labels, missing strokes, double-paint). This constant is the single
// authority: pass-chain BUILDS from it (constructive — it cannot diverge), and
// pass-order-parity.test.ts pins the twin's source order against it plus the
// documented not-yet-ported set below.
//
// Entries are the passes' real `label` strings ('labels', not 'label' — the
// singleton's label, label-pass.ts). Pure data, zero imports — safe for both
// runtime consumption and fs-scanning tests.

/** The byte-frozen full-frame pass order (see pass-chain.ts for per-pass
 *  semantics; oit is registered but runtime-dead — shouldRun immutably false). */
export const PASS_CHAIN_ORDER = [
  'background',
  'opaque',
  'oit',
  'translucent',
  'points',
  'labels',
  'heatmap',
  'overdraw-compose',
  'graphics',
] as const

export type PassLabel = (typeof PASS_CHAIN_ORDER)[number]

/** Passes the renderFrameViaRhi twin does NOT yet port (#1004 shrink-only
 *  baseline): porting one to the twin must REMOVE it here in the same commit
 *  (pass-order-parity.test.ts fails otherwise — locks the win). oit is dead in
 *  both paths but stays listed for order fidelity. Close-out = [] when the
 *  #991 P4/P5 unification runs the RenderNode chain over RHI passes. */
export const RHI_TWIN_MISSING: readonly PassLabel[] = [
  'oit',
  // 'points' ported in #1057 (direct-layer + the VT tile-points inline path);
  // 'heatmap' ported in #1060 (renderFrameViaRhi -> heatmapRenderer.renderRhi).
  'overdraw-compose',
]
