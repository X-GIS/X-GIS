// ═══ Frustum tile BUDGET — viewport classification + the per-frame cap ═══
// Extracted from tile-select.ts (verbatim; behaviour-preserving) so the
// quadtree walk and the budget policy stop sharing one file — the split the
// LOC ceiling ratchet asks for. `isMobileViewport` is still module-private to
// this pair; `viewport-class-budget-migration.test.ts` gates its body here.

import { isMobileClassViewport } from '@xgis/shared'

// Mobile GPUs choke on 300 frustum tiles — each tile is a draw call plus
// SDF-shaded line segments. 120 keeps the foreground refined and the
// horizon at a coarse LOD.
// Mobile classification routes through `isMobileClassViewport` — the
// shared authority (#1350) — so a small DESKTOP window (fine primary
// pointer) keeps the desktop tile budget instead of being throttled
// to phone caps by width alone. Note we evaluate the canvas
// dimensions PER CALL rather than reading `window.innerWidth` once at
// module load; Playwright sets the viewport after import so a
// top-level constant captures the pre-viewport default and
// miscategorises the test as desktop.
//
// Inputs MUST be CSS-pixel dimensions, not device pixels. A DPR=3
// phone's device-pixel canvas is 1290×2235 — `max > 900` would
// flip it to "desktop" and apply the desktop tile budget. Tile
// count is a logical/perceptual concept (one tile per ~256 CSS
// px) and must stay DPR-invariant; only the rasterised pixel
// count scales with DPR.
export function isMobileViewport(cssWidth: number, cssHeight: number): boolean {
  return isMobileClassViewport(Math.max(cssWidth, cssHeight))
}
// Viewport-aware tile budget — replaces the old static cap.
// Density of ~one tile per 12 K pixels keeps drawCalls bounded on
// any viewport: desktop 1280×720 → 76 tiles, mobile 390×844 → 27
// tiles. Floor on mobile is tighter (real iPhones throttle past
// ~60 unique tiles ≈ 240 drawCalls).
export const MAX_FRUSTUM_TILES_CEILING = 300
export function maxFrustumTilesFor(
  cssWidth: number,
  cssHeight: number,
  pitchDeg: number = 0,
): number {
  // Mobile cap calibrated against actual viewport coverage rather
  // than just thermal budget. The DFS prioritises camera-side tiles,
  // so a too-small cap leaves the viewport edges uncovered (real-
  // device test showed canvas's lower half going black on flat-
  // pitch with cap 5). Floor 12 + divisor 18 K covers a typical
  // 430×715 mobile canvas (cap 14) with margin headroom; cap
  // 12 minimum guarantees corner coverage.
  //
  // Inputs MUST be CSS pixels — not device pixels. Device pixels
  // would inflate the budget by DPR² (9× on a DPR=3 phone), but
  // the number of tiles needed to cover a viewport is the same
  // regardless of how densely each tile is rasterised.
  //
  // PITCH SCALE. At flat top-down, viewport AABB is compact and
  // ~9 tiles cover everything. Tilt to 70° and the same screen
  // shows foreground at z=N PLUS a long horizon strip whose
  // coverage demands many low-z tiles. Without scaling, DFS
  // burns the whole budget on camera-side subdivisions and the
  // horizon goes white — measured on iPhone z=15 pitch=71° before
  // the merge-pass landed (drawn z=12 only 1 unique tile across
  // 13 layers). 2× / 4× multipliers match the pitch bands the
  // DFS already uses for its margin formula at line ~395, so the
  // budget grows in lockstep with the visible horizon area. The
  // ~3× draw-call reduction from the auto-merge (61.5 % fold on
  // OSM-style) leaves enough headroom for the bigger budget at
  // high pitch without exceeding the 16.7 ms 60 fps target.
  const isMobile = isMobileViewport(cssWidth, cssHeight)
  const baseFloor = isMobile ? 12 : 60
  const divisor = isMobile ? 18000 : 12000
  // Pitch multiplier was 1/2/4 — measured Bright at z=14 pitch=80°
  // selecting 2700+ tiles, hitting 63 ms / frame frame time (16 fps).
  // Mapbox uses ~200-400 tiles for the equivalent view because their
  // selector picks a SINGLE coarse zoom for the horizon strip rather
  // than letting DFS keep subdividing. We can't (yet) match that
  // selector design — but we can clamp the budget hard so drawCall
  // count stays in 60 fps territory: 1.5/2 multiplier instead of 2/4.
  // The horizon strip becomes visibly chunkier (one or two zoom levels
  // coarser) past pitch 60°, which is preferable to a 1-fps freeze.
  const pitchMul = pitchDeg >= 60 ? 2 : pitchDeg >= 30 ? 1.5 : 1
  const floor = Math.round(baseFloor * pitchMul)
  return Math.max(
    floor,
    Math.min(MAX_FRUSTUM_TILES_CEILING, Math.round((cssWidth * cssHeight) / divisor) * pitchMul),
  )
}
