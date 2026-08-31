// The two `fill-extrusion-ambient-occlusion-*` coverage rows are RECORDS:
// nothing in the engine changes when their note changes, so a test that reads
// the row's own status back would prove nothing. What IS falsifiable is the
// two measured facts the note rests on — and this file binds the note to both,
// so a note that mis-describes the engine fails here rather than mis-costing
// the feature for whoever reads it next.
//
//   1. SUBSTRATE. The note used to say AO "would need per-vertex normal". That
//      normal already ships: `face_normal` (float32x3, @location(5)) is in
//      POLYGON_EXTRUDED_FORMAT and map/src/shaders/dsl/polygon.ts already dots
//      it against the light. While that field is in the format, no AO note may
//      read as "the substrate is missing" — it must name the attribute.
//
//   2. ORACLE. `paint_fill-extrusion` in the pinned
//      @maplibre/maplibre-gl-style-spec carries exactly the keys asserted
//      below and NO ambient-occlusion key, so the compiler's own oracle
//      (spec/oracle.ts) cannot resolve the property and there is no reference
//      implementation to verify an X-GIS one against. The key count each note
//      quotes must equal the count the oracle actually carries — so a spec bump
//      that adds the property turns this red and forces the note to be
//      re-derived instead of silently rotting.

import { describe, it, expect } from 'vitest'
import { POLYGON_EXTRUDED_FORMAT } from '../tiler/polygon-vertex-format'
import { spec } from '../spec/oracle'
import { MAPBOX_COVERAGE } from '../convert/spec-coverage'

const PFE_KEYS = Object.keys(
  (spec as unknown as Record<string, Record<string, unknown>>)['paint_fill-extrusion']!,
)

const AO_ROWS = MAPBOX_COVERAGE.find((s) => s.id === 'paint-fill-extrusion')!.entries.filter((e) =>
  e.name.includes('ambient-occlusion'),
)

describe('fill-extrusion ambient-occlusion — the note matches the engine', () => {
  it('the per-vertex normal AO needs already ships in POLYGON_EXTRUDED_FORMAT', () => {
    const faceNormal = POLYGON_EXTRUDED_FORMAT.fields.find((f) => f.name === 'face_normal')
    expect(faceNormal, 'face_normal missing from POLYGON_EXTRUDED_FORMAT').toBeDefined()
    expect(faceNormal!.wgslType).toBe('vec3<f32>')
    expect(faceNormal!.vbFormat).toBe('float32x3')
    expect(faceNormal!.location).toBe(5)
  })

  it('the pinned spec oracle has no ambient-occlusion key in paint_fill-extrusion', () => {
    expect(PFE_KEYS.filter((k) => /ambient|occlusion/i.test(k))).toEqual([])
    // Pinned so a spec bump that GROWS the block is visible here too — the
    // notes quote this count and would otherwise go stale unnoticed.
    expect(PFE_KEYS.slice().sort()).toEqual([
      'fill-extrusion-base',
      'fill-extrusion-color',
      'fill-extrusion-height',
      'fill-extrusion-opacity',
      'fill-extrusion-pattern',
      'fill-extrusion-translate',
      'fill-extrusion-translate-anchor',
      'fill-extrusion-vertical-gradient',
    ])
  })

  it('both AO rows exist and neither reads as a missing-substrate gap', () => {
    expect(AO_ROWS.map((e) => e.name)).toEqual([
      'fill-extrusion-ambient-occlusion-intensity',
      'fill-extrusion-ambient-occlusion-radius',
    ])
    // The substrate assertion above holds, so the note must NAME the attribute
    // that ships rather than describe it as absent.
    for (const row of AO_ROWS) {
      expect(row.note ?? '', `${row.name}: note must name the face_normal that ships`).toContain(
        'face_normal',
      )
    }
  })

  it('each AO note quotes the key count the oracle actually carries', () => {
    for (const row of AO_ROWS) {
      const quoted = [...(row.note ?? '').matchAll(/(\d+)[ -]key/g)].map((m) => Number(m[1]))
      expect(
        quoted.length,
        `${row.name}: note must quote the paint_fill-extrusion key count (the reason there is no oracle)`,
      ).toBeGreaterThan(0)
      for (const n of quoted) {
        expect(n, `${row.name}: note quotes ${n} keys, oracle carries ${PFE_KEYS.length}`).toBe(
          PFE_KEYS.length,
        )
      }
    }
  })
})
