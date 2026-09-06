// ═══ #2499 step 4 — layout derivation never emits ═══
//
// The five `*-uniform-slots.ts` helpers used to be `uniformFieldSlots(reflect(build*Module()),
// name)`: build the whole module — and, the first time in a process, run the projection
// fixpoint (~16 ms, #2459's table) — to read a struct's byte layout. On a boot where every
// shader comes from the bake (#2499 steps 0–3) that was the last optimizer run left, and it ran
// for a layout. They now derive from the `uniformStruct` HANDLE alone via
// `wgslLayout(u.struct, 'std140')`, the way the typed `uniformBlock(U)` packers already did.
//
// Two arms, because "module-free" is a property of the SOURCE and "same layout" a property of
// the VALUES:
//   (a) none of the five files imports `reflect` or a `build*Module` — the arm that reds on the
//       old tree (the fail-before), and on anyone routing a layout back through an emit;
//   (b) every handle-derived slot table deep-equals the reflect-derived one — the proof that
//       the handle and the module describe the same struct (reflect() reads the same
//       `StructDecl`s the handle carries, so this is expected to hold by construction; the arm
//       is what makes that a fact instead of a belief).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reflect } from '@xgis/shader-dsl'
import { uniformFieldSlots } from '@xgis/rhi-webgpu'
import { buildPolygonModule } from '../shaders/dsl/polygon'
import { buildRasterModule } from '../shaders/dsl/raster'
import { buildHillshadeModule } from '../shaders/dsl/hillshade'
import { buildHeatmapAccumModule } from '../shaders/dsl/heatmap-accum'
import { buildLineModule } from '../shaders/dsl/line'
import { polygonUniformSlots } from './polygon-uniform-slots'
import { rasterTileSlots, rasterUniformSlots } from './raster-uniform-slots'
import { hillshadeUniformSlots } from './hillshade-uniform-slots'
import { heatmapUniformSlots } from './heatmap-uniform-slots'
import { lineLayerUniformSlots } from './line-uniform-slots'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES = [
  'polygon-uniform-slots.ts',
  'raster-uniform-slots.ts',
  'hillshade-uniform-slots.ts',
  'heatmap-uniform-slots.ts',
  'line-uniform-slots.ts',
]

describe('#2499 step 4 — (a) the slots helpers are module-free at the source', () => {
  for (const f of FILES)
    it(`${f} imports neither reflect nor a build*Module`, () => {
      const src = readFileSync(join(HERE, f), 'utf8')
      // Import lines only — the header prose is allowed to NAME the retired form.
      const imports = src.split('\n').filter((l) => /^import\b/.test(l))
      expect(imports.length, `${f}: no import lines read — the scan is vacuous`).toBeGreaterThan(1)
      for (const line of imports) {
        expect(
          line,
          `${f} imports reflect — a layout is being read through an emit again`,
        ).not.toMatch(/\breflect\b/)
        expect(
          line,
          `${f} imports a module builder — a layout is being read through an emit again`,
        ).not.toMatch(/\bbuild[A-Za-z]*Module\b/)
      }
      expect(src, `${f} does not derive from the handle`).toContain('wgslLayout(')
    })
})

describe('#2499 step 4 — (b) handle-derived slots === reflect-derived slots', () => {
  it('polygon Uniforms', () => {
    expect(polygonUniformSlots()).toEqual(
      uniformFieldSlots(reflect(buildPolygonModule(null, false)), 'Uniforms'),
    )
  })
  it('raster Uniforms + TileUniforms', () => {
    const r = reflect(buildRasterModule(false))
    expect(rasterUniformSlots()).toEqual(uniformFieldSlots(r, 'Uniforms'))
    expect(rasterTileSlots()).toEqual(uniformFieldSlots(r, 'TileUniforms'))
  })
  it('hillshade HillshadeUniforms', () => {
    expect(hillshadeUniformSlots()).toEqual(
      uniformFieldSlots(reflect(buildHillshadeModule(false)), 'HillshadeUniforms'),
    )
  })
  it('heatmap-accum Uniforms', () => {
    expect(heatmapUniformSlots()).toEqual(
      uniformFieldSlots(reflect(buildHeatmapAccumModule()), 'Uniforms'),
    )
  })
  it('line LineLayer', () => {
    expect(lineLayerUniformSlots()).toEqual(
      uniformFieldSlots(reflect(buildLineModule(null, false)), 'LineLayer'),
    )
  })
  it('the comparison is not vacuous — a slot table has fields and a size', () => {
    const p = polygonUniformSlots()
    expect(Object.keys(p.slot).length).toBeGreaterThan(4)
    expect(p.slots).toBeGreaterThan(16)
  })
})
