// FULL example audit: load every demo, capture console errors + warnings +
// pageerrors + HTTP 4xx/5xx + request failures + a render check, and dump a
// machine-readable JSON to tmp/full-audit.json for analysis. Adapted from
// _warn-check.spec.ts (its capture net) but over ALL demos.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'

const IDS = 'minimal dark raster zoom multi_layer picking_demo categorical vector_categorical pmtiles_source pmtiles_labels import_mapbox_style import_mapbox_inline_geojson import_maplibre_demo along_path_roads step_and_concat multiline_labels pmtiles_v4 pmtiles_layered openfreemap_bright pmtiles_only_landuse osm_style styled_world filter_gdp ocean_land rivers_lakes coastline physical_map physical_map_50m states_provinces continent_match gdp_gradient income_match population_gradient gradient_points custom_shapes shape_gallery custom_symbol procedural_circles sdf_points line_styles dashed_lines pattern_lines multi_layer_line line_offset translucent_lines stroke_align physical_map_10m states_10m rivers_10m zoom_lod populated_places night_map continent_outlines dashed_borders coastline_10m water_hierarchy raster_overlay bold_borders megacities layered_borders bucket_order animation_pulse animation_showcase fixture_point fixture_line fixture_line_join fixture_triangle fixture_square fixture_stroke_fill fixture_dashed_line fixture_translucent_stroke fixture_multi_layer fixture_anim_opacity fixture_anim_color fixture_sdf_point fixture_sdf_glow fixture_categorical fixture_picking fixture_mercator_clip fixture_antimeridian fixture_x_translucent_anim fixture_x_points_translucent fixture_x_zoom_time_opacity fixture_x_anim_multi_property reftest_triangle_static reftest_triangle_match reftest_zoom_static reftest_zoom_degenerate reftest_stroke_static reftest_stroke_keyframe_static fixture_stress_all_renderers fixture_stress_many_layers fixture_cap_round fixture_cap_square fixture_join_round fixture_join_bevel fixture_pattern_multi fixture_stroke_inset fixture_stroke_offset_right fixture_stroke_offset_right_large fixture_anim_ease_linear fixture_dasharray_complex fixture_size_expr fixture_filter_complex fixture_shape_custom_svg fixture_projection_equirectangular fixture_anchor_center fixture_anchor_top fixture_flat_anchor_bottom fixture_size_zoom fixture_stroke_outset fixture_pattern_anchor_start fixture_pattern_anchor_end fixture_pattern_units_km fixture_anim_dashoffset fixture_miterlimit fixture_inline_push fixture_render_verify fixture_typed_array_points fixture_cap_arrow fixture_anchor_bottom fixture_projection_orthographic fixture_projection_natural_earth fixture_zoom_opacity fixture_synth_bg_only'.split(' ')

// Localhost SSRF blocks + vite/devtools noise are TEST-ENV artifacts, not bugs.
const NOISE = /\[vite\]|powerPreference|DevTools|Slow network|private\/loopback host blocked|SSRF/

interface Rec { id: string; ready: boolean; readyMs: number; painted: number; errors: string[]; warnings: string[]; other: string[] }

test('full demo audit', async ({ browser }) => {
  test.setTimeout(900_000)
  const out: Rec[] = []
  for (const id of IDS) {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 640 }, ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    const errors: string[] = [], warnings: string[] = [], other: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (NOISE.test(t)) return
      if (m.type() === 'error') errors.push(t.slice(0, 220))
      else if (m.type() === 'warning') warnings.push(t.slice(0, 220))
    })
    page.on('pageerror', (e) => { if (!NOISE.test(e.message)) errors.push('[pageerror] ' + e.message.slice(0, 220)) })
    page.on('response', (r) => { if (r.status() >= 400 && !NOISE.test(r.url())) other.push(`http${r.status()} ${r.url().slice(0, 120)}`) })
    page.on('requestfailed', (r) => { const u = r.url(); if (!NOISE.test(u) && !u.includes('favicon')) other.push(`reqfail ${r.failure()?.errorText} ${u.slice(0, 120)}`) })
    let ready = false; let readyMs = -1; let painted = -1
    const t0 = Date.now()
    try {
      await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      try {
        await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 18_000 })
        ready = true; readyMs = Date.now() - t0
      } catch { ready = false }
      await page.waitForTimeout(700)
      // painted-pixel count: non-uniform pixels in the canvas screenshot
      try {
        const canvas = page.locator('canvas').first()
        const buf = await canvas.screenshot({ timeout: 8_000 })
        painted = buf.length // proxy: PNG byte size (uniform frame compresses tiny; content = larger)
      } catch { painted = -2 }
    } catch (e) { errors.push('[goto] ' + String(e).slice(0, 200)) }
    out.push({ id, ready, readyMs, painted, errors: [...new Set(errors)], warnings: [...new Set(warnings)], other: [...new Set(other)] })
    const flag = !ready ? 'NOT-READY' : errors.length ? `ERR${errors.length}` : warnings.length ? `warn${warnings.length}` : other.length ? `net${other.length}` : 'ok'
    console.log(`[AUDIT] ${id.padEnd(38)} ${flag}`)
    await ctx.close()
  }
  mkdirSync('D:/X-GIS/tmp', { recursive: true })
  writeFileSync('D:/X-GIS/tmp/full-audit.json', JSON.stringify(out, null, 1))
  const bad = out.filter(r => !r.ready || r.errors.length)
  const warns = out.filter(r => r.ready && !r.errors.length && r.warnings.length)
  console.log(`\n=== AUDIT DONE: ${out.length} demos | not-ready/errors: ${bad.length} | warnings-only: ${warns.length} ===`)
  for (const r of bad) console.log(`  BAD  ${r.id}: ${!r.ready ? 'NOT-READY ' : ''}${r.errors.slice(0, 2).join(' || ')}`)
  for (const r of warns) console.log(`  WARN ${r.id}: ${r.warnings.slice(0, 2).join(' || ')}`)
})
