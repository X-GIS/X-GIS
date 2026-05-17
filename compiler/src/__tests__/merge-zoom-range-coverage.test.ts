// Pin merge-layers' zoom-range invariant. Two same-source-layer
// candidates with DIFFERENT minzoom or maxzoom must not be folded
// into one compound node — the merge would broadcast first.minzoom
// across the whole group, so a layer authored at minzoom: 10 would
// start rendering at minzoom: 8 (if it joined a group whose first
// member had minzoom: 8).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower, optimize } from '@xgis/compiler'

function compileAndOptimize(mapbox: unknown) {
  const xgis = convertMapboxStyle(mapbox as never)
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  return optimize(lower(ast))
}

describe('merge-layers: zoom-range invariant', () => {
  it('two landuse layers with SAME minzoom merge into one compound', () => {
    const scene = compileAndOptimize({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'landuse_park',
          type: 'fill', source: 'v', 'source-layer': 'landuse',
          minzoom: 8,
          filter: ['==', ['get', 'class'], 'park'],
          paint: { 'fill-color': '#0a0' },
        },
        {
          id: 'landuse_forest',
          type: 'fill', source: 'v', 'source-layer': 'landuse',
          minzoom: 8,
          filter: ['==', ['get', 'class'], 'forest'],
          paint: { 'fill-color': '#080' },
        },
      ],
    })
    // Same minzoom → merge proceeds → 1 compound node.
    expect(scene.renderNodes.length).toBe(1)
    expect(scene.renderNodes[0]!.name).toMatch(/__merged_2/)
  })

  it('two landuse layers with DIFFERENT minzoom stay separate', () => {
    // Pre-fix the merge would broadcast first.minzoom (8) across
    // both, so the residential layer would render at z=8 instead
    // of its authored z=10. Visible as residential fills appearing
    // 2 zoom levels too early.
    const scene = compileAndOptimize({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'landuse_park',
          type: 'fill', source: 'v', 'source-layer': 'landuse',
          minzoom: 8,
          filter: ['==', ['get', 'class'], 'park'],
          paint: { 'fill-color': '#0a0' },
        },
        {
          id: 'landuse_residential',
          type: 'fill', source: 'v', 'source-layer': 'landuse',
          minzoom: 10,
          filter: ['==', ['get', 'class'], 'residential'],
          paint: { 'fill-color': '#aaa' },
        },
      ],
    })
    // Different minzoom → no merge → 2 nodes preserved.
    expect(scene.renderNodes.length).toBe(2)
    expect(scene.renderNodes[0]!.minzoom).toBe(8)
    expect(scene.renderNodes[1]!.minzoom).toBe(10)
  })

  it('two line layers with DIFFERENT line-blur stay separate', () => {
    // Pre-fix strokesShapeEqual didn't check `blur`. Two contiguous
    // line layers could fold despite different edge-feather radii;
    // the merged compound would render every absorbed kind with
    // the FIRST member's blur — half the road network came out
    // crisp / soft against author intent.
    const scene = compileAndOptimize({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'road_primary',
          type: 'line', source: 'v', 'source-layer': 'transportation',
          filter: ['==', ['get', 'class'], 'primary'],
          paint: { 'line-color': '#000', 'line-width': 2, 'line-blur': 0 },
        },
        {
          id: 'road_secondary',
          type: 'line', source: 'v', 'source-layer': 'transportation',
          filter: ['==', ['get', 'class'], 'secondary'],
          paint: { 'line-color': '#000', 'line-width': 2, 'line-blur': 4 },
        },
      ],
    })
    expect(scene.renderNodes.length).toBe(2)
  })

  it('two layers with DIFFERENT maxzoom stay separate', () => {
    const scene = compileAndOptimize({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'landuse_park',
          type: 'fill', source: 'v', 'source-layer': 'landuse',
          maxzoom: 14,
          filter: ['==', ['get', 'class'], 'park'],
          paint: { 'fill-color': '#0a0' },
        },
        {
          id: 'landuse_forest',
          type: 'fill', source: 'v', 'source-layer': 'landuse',
          maxzoom: 18,
          filter: ['==', ['get', 'class'], 'forest'],
          paint: { 'fill-color': '#080' },
        },
      ],
    })
    expect(scene.renderNodes.length).toBe(2)
  })
})
