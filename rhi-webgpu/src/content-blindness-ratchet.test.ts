// ═══ Content-blindness ratchet — the backend adapters stay geo/style/data-viz BLIND ═══
//
// Charter invariant (#1000): @xgis/rhi-webgpu and @xgis/rhi-webgl2 are BACKEND
// ADAPTERS — "cartography-free — GPU state, not map content" (the rule the
// backend documents on ITSELF at gpu-shared.ts:258-262, where the Web-Mercator
// world-wrap constants were evicted to @xgis/geo precisely because "a render
// backend stays geo-blind"). A backend knows textures, buffers, blend states and
// pipelines; it must NOT know what a heatmap is, what a colour gradient/palette
// is, or that a style has a `fill` vs `stroke-color` paint axis. That DOMAIN
// content belongs in @xgis/map (the content layer). Today it has leaked DOWN into
// the backend:
//   • data-viz (heatmap): render-targets.ts owns heatmapAccum/BlurTexture +
//     heatmapAccum/BlurView + ensureHeatmap/destroyHeatmap; gpu-shared.ts owns
//     the HEATMAP_DENSITY_FORMAT constant.
//   • data-viz (palette/gradient): palette-texture.ts owns PaletteTextures /
//     uploadPalette / colorGradientAtlas / scalarGradientAtlas.
//   • style enum: compute-bind-layout.ts USED TO thread the paint axis selector
//     through the bind-group builder — RELOCATED to @xgis/map in #1000. The
//     builder now takes an opaque output-slot index; the style-aware caller
//     resolves slot→axis→buffer. (Row removed from the baseline below.)
//
// WHY this is UN-gated today. The backend LEGITIMATELY speaks generic GPU
// vocabulary (GPUTexture, createTexture, blend states, r16float), so tsc + the
// engine's `types:[]` neutrality say nothing about it. The sibling ratchets miss
// this axis by construction: raw-webgpu-ratchet bans native `GPU*` only inside
// @xgis/map; backend-adapter-ratchet bans @xgis/map → backend IMPORTS; the #929
// dependency-direction ratchet bans cross-package VALUE imports (it will drive
// out palette-texture.ts's `PackedPalette`/`GRADIENT_WIDTH` imports from
// @xgis/compiler). NONE of them looks at the domain CONTENT VOCABULARY sitting
// INSIDE the backend's own surface — so a heatmap target or a paint-axis enum
// added to the adapter tomorrow passes every existing gate. This ratchet is that
// missing mechanism: it seeds the CURRENT domain-content footprint of both
// backend `src` trees as a per-file BASELINE and drives it to zero as the
// heatmap render targets, the palette upload, and the paint-axis bind wiring
// relocate to @xgis/map. Close-out (#1000) = this map == {}.
//
// SIGNAL (specific leaked terms, not generic GPU vocab → low false positives).
// Per file, over COMMENT-STRIPPED source (both backends document heatmap/palette
// in prose we must NOT count), we count occurrences of the domain-content
// markers:
//   heatmap  (case-insensitive) — catches heatmap* fields/methods/labels AND the
//                                  HEATMAP_DENSITY_FORMAT constant in one net.
//   paintAxis                    — the style paint-axis selector.
//   'stroke-color'               — the paint-axis enum literal (QUOTED; the sister
//                                  value 'fill' is deliberately NOT a marker — it
//                                  is generic GPU/English vocabulary that would
//                                  false-positive).
//   PaletteTextures / uploadPalette / colorGradientAtlas / scalarGradientAtlas
//                                — the palette/gradient data-viz surface.
// A single combined alternation, matched once per position, so the heatmap net
// and HEATMAP_DENSITY_FORMAT can never double-count. rhi-webgl2/src carries ZERO
// in code today (its only heatmap mentions are fail-closed COMMENTS, stripped) —
// the scan still WALKS it so a future leak DOWN into the GL2 adapter fails here.
//
// STRICT-equal, BOTH directions, over the UNION of scanned+baseline files
// (mirrors raw-webgpu-ratchet / #929 — see those for the rationale, and #996 for
// why the union-scan must FAIL, not pass-green-while-dead, when a baseline entry
// points at a moved/deleted file):
//   • actual > baseline → NEW domain-content leak. Move it to @xgis/map; don't
//     grow the baseline.
//   • actual < baseline → you relocated content. LOWER the baseline to lock it.
//   • baseline file absent from the scan → fails loudly (moved/renamed/deleted).
//
// GPU-free; co-located in rhi-webgpu/src so it rides the `test (engine-rhi-data)`
// CI leg (`vitest … rhi-webgpu/src rhi-webgl2/src …`). Baseline started at 53
// markers / 4 files (2026-07-11); the paint-axis bind wiring relocated to
// @xgis/map in #1000, leaving 51 markers / 3 files. Drive the rest to 0 by
// relocating the heatmap targets + palette upload to @xgis/map (#1000).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEBGPU_SRC = join(ROOT, 'rhi-webgpu/src')
const WEBGL2_SRC = join(ROOT, 'rhi-webgl2/src')

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}
const rel = (abs: string): string => relative(ROOT, abs).split('\\').join('/')

// Strip block + line comments so the ratchet tracks CODE, not contract prose.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// The leaked DOMAIN-content markers. Single combined alternation (matched once
// per position, so `heatmap` and the HEATMAP_DENSITY_FORMAT it subsumes never
// double-count). Case-insensitive so `heatmap` catches HEATMAP_*/Heatmap* too;
// the terms are specific enough that no casing collides with the backend's
// legitimate generic GPU vocabulary. `'fill'` is intentionally excluded — only
// the specific paint-axis literal `'stroke-color'` is a marker.
const CONTENT_RE =
  /heatmap|paintAxis|'stroke-color'|PaletteTextures|uploadPalette|colorGradientAtlas|scalarGradientAtlas/gi

function contentCount(abs: string): number {
  const code = stripComments(readFileSync(abs, 'utf8'))
  return (code.match(CONTENT_RE) || []).length
}

// Per-file domain-content marker count. SHRINK-ONLY: a phase that relocates
// heatmap/palette/paint-axis content to @xgis/map lowers its number (to 0 =
// delete the entry) in the same commit. Measured 2026-07-11. Ordered by path.
const BASELINE: Record<string, number> = {
  'rhi-webgpu/src/gpu-shared.ts': 1,
  'rhi-webgpu/src/palette-texture.ts': 14,
  'rhi-webgpu/src/render-targets.ts': 36,
}

describe('content-blindness ratchet: rhi-webgpu|webgl2 hold no geo/style/data-viz content (#1000)', () => {
  it('per-file domain-content marker count equals the shrink-only baseline', () => {
    const actual = new Map<string, number>()
    for (const abs of [...walkTs(WEBGPU_SRC), ...walkTs(WEBGL2_SRC)]) {
      const n = contentCount(abs)
      if (n > 0) actual.set(rel(abs), n)
    }

    const files = [...new Set([...actual.keys(), ...Object.keys(BASELINE)])].sort()
    const violations: string[] = []
    for (const f of files) {
      const a = actual.get(f) ?? 0
      const b = BASELINE[f] ?? 0
      if (a === b) continue
      if (b === 0)
        violations.push(
          `${f}: ${a} domain-content marker(s), not in baseline — this belongs in @xgis/map, not a ` +
            `backend adapter; if genuinely a new gap-blocked site, add '${f}': ${a} with a one-line rationale`,
        )
      else if (a === 0)
        violations.push(
          `${f}: baseline ${b} but 0 now — DELETE this baseline entry (content relocated; lock the win). ` +
            `If the file MOVED, this failure is the #996 vacuity guard doing its job`,
        )
      else if (a > b)
        violations.push(
          `${f}: ${a} > baseline ${b} — NEW domain-content leak(s); relocate to @xgis/map, don't grow the baseline`,
        )
      else
        violations.push(
          `${f}: ${a} < baseline ${b} — content relocated; LOWER this baseline to ${a} in the same commit`,
        )
    }

    expect(
      violations,
      `Domain-content footprint of the backend adapters drifted from the #1000 ratchet baseline:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
