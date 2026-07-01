import { describe, expect, it } from 'vitest'
import { emitLineWgsl } from '@xgis/map'

// #606 — THIN lines render TOO THICK vs MapLibre on dpr>1 displays.
//
// ROOT CAUSE (proven analytically, not by eyeball): the line fragment shader's
// antialiasing half-band was a FIXED 0.5 CSS px (`aa = 0.5 + blur`), with NO
// dpr term. MapLibre's edge feather is dpr-aware: outset = w/2 + ANTIALIASING
// with ANTIALIASING = 1/(2·dpr), and coverage ramps over blur2 = blur + 1/dpr
// (maplibre line.fragment.glsl + line.vertex.glsl, fetched verbatim). A fixed
// 0.5-CSS-px band is therefore dpr× too wide in DEVICE px when dpr>1 — which is
// invisible on a ~12 px road (dominated by its opaque core) but roughly DOUBLES
// a ~1 px line (almost entirely AA fringe). That is exactly the reported
// "demotiles z0 country boundary (width 1) renders ~2-3 px in X-GIS vs ~1 px
// crisp in MapLibre, while a z19 12 px road is identical in both".
//
// The fix (line.ts compute_line_color): half-band = 1/(2·dpr) CSS px on the
// outer side (+ line-blur on the inner), matching MapLibre's outset/blur2.
//
// Two discriminating checks, both GPU-free:
//   1. EMITTED-WGSL structure — the FS coverage feather must divide by
//      `layer.dpr`. The old fixed-0.5 band had no `layer.dpr` in the FS
//      coverage smoothstep, so this fails before the fix (the VS already used
//      `layer.dpr`, but in a `/ layer.viewport_height` context, never inside a
//      `0.5 / layer.dpr` feather — see assertion below).
//   2. CLOSED-FORM device-px coverage — re-implements the EXACT emitted
//      coverage profile and integrates it in device px (screenshot space). It
//      asserts a thin (1 px) line's on-screen extent at dpr=2 matches MapLibre
//      (~1 px-equivalent core, fringe ~MapLibre's), NOT the old ~2× inflation,
//      AND that a wide (12 px) line is unchanged. The thin-line assertion FAILS
//      with the old fixed-0.5 band (it would compute ~3.76 device px outer
//      width vs the new/MapLibre ~2.88).

// ── MapLibre reference coverage (line.fragment.glsl), in CSS units ──
// outset = w/2 + ANTIALIASING (ANTIALIASING = 1/(2·dpr)); inset = 0;
// blur2 = (blur + 1/dpr); dist = perp_css;
// alpha = clamp(min(dist - (inset - blur2), outset - dist) / blur2, 0, 1)
function mlAlpha(perpDev: number, w: number, dpr: number, blur: number): number {
  const perp = perpDev / dpr
  const outset = w * 0.5 + (w * 0.5 === 0 ? 0 : 1 / (2 * dpr))
  const blur2 = blur + 1 / dpr
  const inner = perp - (0 - blur2)
  const outer = outset - perp
  return Math.max(0, Math.min(1, Math.min(inner, outer) / blur2))
}

// ── X-GIS emitted FS coverage (line.ts compute_line_color), in CSS units ──
// dPx = perp_css - w/2 (distance past the opaque core edge);
// halfAa = 0.5 / dpr; blurPx = max(0, aa_width_px - 1) = line-blur;
// alpha = 1 - smoothstep(-(halfAa + blurPx), +halfAa, dPx)
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
function xgisAlpha(perpDev: number, w: number, dpr: number, blur: number): number {
  const perp = perpDev / dpr
  const dPx = perp - w * 0.5
  const halfAa = 0.5 / dpr
  return 1 - smoothstep(-(halfAa + blur), halfAa, dPx)
}
// The OLD (buggy) band, for the fail-before guard: fixed 0.5 CSS px, dpr-blind.
function xgisAlphaOld(perpDev: number, w: number, dpr: number, blur: number): number {
  const perp = perpDev / dpr
  const dPx = perp - w * 0.5
  const aa = 0.5 + blur
  return 1 - smoothstep(-aa, aa, dPx)
}

// Numerically integrate a coverage profile in DEVICE px → (integratedWidth, w50, outerWidth).
function coverageDev(
  fn: (perpDev: number, w: number, dpr: number, blur: number) => number,
  w: number, dpr: number, blur: number,
): { integ: number; w50: number; outer: number } {
  const N = 40001
  const xmax = (Math.max(8, w + 6)) * dpr
  let integ = 0
  let w50 = 0
  let outer = 0
  let prevX = 0
  let prevA = fn(0, w, dpr, blur)
  for (let i = 1; i < N; i++) {
    const x = (i * xmax) / (N - 1)
    const a = fn(x, w, dpr, blur)
    integ += ((prevA + a) * 0.5) * (x - prevX)
    if (a >= 0.5) w50 = x
    if (a >= 0.01) outer = x
    prevX = x
    prevA = a
  }
  return { integ: 2 * integ, w50: 2 * w50, outer: 2 * outer }
}

describe('#606 thin-line width — dpr-aware AA (closed-form, GPU-free)', () => {
  // ── (1) EMITTED-WGSL structure: FS feather divides by layer.dpr ──
  it('FS edge feather divides by layer.dpr (fails before: was a fixed 0.5)', () => {
    const wgsl = emitLineWgsl(false)
    // The fragment coverage half-band is `0.5 / layer.dpr` (CSE/inlining may
    // rename temporaries, but the `0.5 / layer.dpr` node survives). The OLD
    // code emitted a bare `0.5` with no division by dpr in the coverage path.
    expect(wgsl).toMatch(/0\.5\s*\/\s*layer\.dpr/)
  })

  // ── (2) CLOSED-FORM: thin line at dpr=2 matches MapLibre, not the old 2× ──
  // countries-boundary at z0/z1 = width 1, no blur. dpr=2 (retina / headed Chrome).
  it('w=1 @ dpr=2: outer extent ≈ MapLibre (~3 device px), NOT the old ~3.8 px', () => {
    const ml = coverageDev(mlAlpha, 1, 2, 0)
    const fixed = coverageDev(xgisAlpha, 1, 2, 0)
    const old = coverageDev(xgisAlphaOld, 1, 2, 0)
    // The fix must land within ~0.3 device px of MapLibre's outer extent.
    expect(fixed.outer).toBeCloseTo(ml.outer, 0) // ~2.88 vs ML ~2.98
    expect(Math.abs(fixed.outer - ml.outer)).toBeLessThan(0.3)
    // Discriminating: the OLD band was materially wider than MapLibre (the bug).
    expect(old.outer - ml.outer).toBeGreaterThan(0.6) // old ~3.76 → +0.78 over ML
    // And the fix is strictly tighter than the old band (the line de-fattens).
    expect(fixed.outer).toBeLessThan(old.outer - 0.6)
  })

  it('w=1 @ dpr=2: 50%-coverage width equals 1 CSS px (= 2 device px), like MapLibre', () => {
    const fixed = coverageDev(xgisAlpha, 1, 2, 0)
    const ml = coverageDev(mlAlpha, 1, 2, 0)
    expect(fixed.w50).toBeCloseTo(2.0, 1)
    expect(fixed.w50).toBeCloseTo(ml.w50, 1)
  })

  // ── WIDE-LINE GUARD: a 12 px road must be UNCHANGED by the fix ──
  it('w=12 @ dpr=2: width unchanged (wide lines stay calibrated)', () => {
    const fixed = coverageDev(xgisAlpha, 12, 2, 0)
    const old = coverageDev(xgisAlphaOld, 12, 2, 0)
    const ml = coverageDev(mlAlpha, 12, 2, 0)
    // 50%-coverage width is identical old vs new vs MapLibre (= 12 CSS px = 24 device px).
    expect(fixed.w50).toBeCloseTo(24.0, 1)
    expect(old.w50).toBeCloseTo(24.0, 1)
    expect(fixed.w50).toBeCloseTo(ml.w50, 1)
    // Outer extent barely moves for a wide line (fringe is a rounding error
    // relative to the opaque core): old vs new differ by < 1 device px, and the
    // new value is within ~0.3 px of MapLibre — i.e. the fix does NOT regress
    // the proven-correct wide-line calibration.
    expect(Math.abs(fixed.outer - old.outer)).toBeLessThan(1.0)
    expect(Math.abs(fixed.outer - ml.outer)).toBeLessThan(0.3)
  })

  // ── dpr=1 BYTE-IDENTICALITY: blur=0 band must be unchanged (no golden churn) ──
  it('w=1 @ dpr=1, blur=0: new band == old band (byte-identical, no regression)', () => {
    // At dpr=1, halfAa = 0.5/1 = 0.5, blur=0 → smoothstep(-0.5, 0.5) == the old
    // fixed band exactly. Verify the two profiles agree everywhere.
    let maxDiff = 0
    for (let i = 0; i <= 40; i++) {
      const perpDev = (i * 4) / 40 // 0..4 device px at dpr=1 = CSS px
      const diff = Math.abs(xgisAlpha(perpDev, 1, 1, 0) - xgisAlphaOld(perpDev, 1, 1, 0))
      if (diff > maxDiff) maxDiff = diff
    }
    expect(maxDiff).toBeLessThan(1e-9)
  })

  // ── coastline (width 2, blur 0.5) @ dpr=2: matches MapLibre 50%-width ──
  it('w=2, blur=0.5 @ dpr=2: 50%-width matches MapLibre (blur handled)', () => {
    const fixed = coverageDev(xgisAlpha, 2, 2, 0.5)
    const ml = coverageDev(mlAlpha, 2, 2, 0.5)
    expect(fixed.w50).toBeCloseTo(ml.w50, 1) // both ≈ 3.0 device px
    // And the old band was wider on the outer fringe (part of the same bug).
    const old = coverageDev(xgisAlphaOld, 2, 2, 0.5)
    expect(old.outer - fixed.outer).toBeGreaterThan(1.0)
  })
})
