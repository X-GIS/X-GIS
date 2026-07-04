---
name: xgis-inline-perfeature-render-gate
description: X-GIS inline setSourceData per-feature COLOR silently renders BLANK while WIDTH works — shaderVariant.needsFeatureBuffer routes color to a broken legacy slice; only a real-GPU 3-way probe reveals it
triggers:
  - inline geojson blank
  - setSourceData line not rendering
  - per-feature color match blank
  - VirtualPMTiles needsFeatureBuffer
  - stroke match blank
  - width works color does not
---

# X-GIS inline per-feature render-path gate

## The Insight

On an inline `setSourceData(FeatureCollection)` source, per-feature WIDTH and per-feature COLOR take DIFFERENT render paths, and one of them silently fails. WIDTH (`stroke-[<expr>]`) writes a segment-buffer slot override (slot[17] `width_px_override`) and creates NO shader variant, so it rides the VirtualPMTiles path fine. COLOR `match()` / gradient sets `show.shaderVariant.needsFeatureBuffer = true` (map.ts:3206), and that flag is REJECTED by the VirtualPMTiles gate (`map.ts:3214`, the `!needsFeatureBuffer` term) → the show falls back to the legacy `pool.compile` path → the legacy single-layer GeoJSON backend stores tiles under the `''` slice (tile-decision.ts:104) while the VTR looks them up under `computeSliceKey(show.targetName)` = e.g. `'arcs'` (vector-tile-renderer.ts:1210) → permanent cache miss → **BLANK, no error**.

## Why This Matters

Turning on per-feature COLOR makes the whole layer vanish silently. This is the answer to "why does per-feature width render but adding a color expression blanks everything?" A static code read will NOT settle it — whether a style trips `needsFeatureBuffer` is buried in variant computation, and the legacy-path drop only manifests at draw time.

## Recognition Pattern

- inline `setSourceData` + `__XGIS_USE_VIRTUAL_INLINE_GEOJSON = true`, add a per-feature `stroke match(.field){...}` color → basemap only, arcs gone.
- Constant color renders; `stroke-[expr]` width renders; ONLY `match()`/gradient color blanks.

## The Approach

1. **Adjudicate with a real-GPU 3-way probe, never a static read**: style A (constant), B (per-feature width only), C (width + per-feature color match). If B renders and C is blank, the gate-reject → legacy-slice-drop is confirmed. (map.ts gate is at ~3206-3214.)
2. **Work around by SEPARATE constant-color layers** — one source+layer per category, each a single constant `stroke-<color>`. Each stays on the VirtualPMTiles path (no `needsFeatureBuffer`), so color-by-category works without per-feature `match()`. This is a legitimate categorical-styling pattern, not a hack.
3. **The root fix** (legacy backend store under `computeSliceKey(sourceName)` instead of `''`) is entangled with the tile-decision empty-placeholder logic (`''` doubles as the "no overlapping geometry" placeholder) → high risk, do it as a separate issue (#821), not inline with feature work.
4. **Capture canvas-native `toBlob`**, never a DOM screenshot: a colorHistogram gate faked a PASS on UI-chrome orange (a slider) once. Exclude the page chrome so the gate reads only the map.

## Example

```
# BLANK (color match trips needsFeatureBuffer → legacy '' slice → VTR 'arcs' miss):
source arcs { type: geojson }
layer arcs_lines { source: arcs | stroke match(.purpose){ 1 -> orange-500  _ -> gray-500 } }

# WORKS (per-feature width is a slot override, no variant):
layer arcs_lines { source: arcs | stroke-orange-400 stroke-[sqrt(.weight)*0.07+1] }

# WORKS (color-by-category via separate constant-color layers):
source arcs_commute { type: geojson }   # client pushes only purpose 1,2 rows here
layer l_commute { source: arcs_commute | stroke-orange-400 stroke-[sqrt(.weight)*0.07+1] }
source arcs_shop { type: geojson }       # only purpose 3,4 rows
layer l_shop { source: arcs_shop | stroke-cyan-400 stroke-[sqrt(.weight)*0.07+1] }
```
