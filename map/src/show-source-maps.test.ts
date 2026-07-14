// Regression: filter_gdp emerald/yellow rendered NOTHING because inline
// GeoJSON shows have empty `sourceLayer` and the old code skipped them
// when building per-source maps. The backend then didn't know about the
// per-show filter / extrude / data-driven paint inputs and emitted only
// the unfiltered base; downstream consumers looked up missing sliceKeys
// and silently rendered nothing.
//
// Fix (show-source-maps.ts + vector-tile-renderer.ts + map.ts label
// path): a single `effectiveLayer = sourceLayer || targetName` fallback
// is applied at every key derivation site so worker output and
// renderer lookups agree. This test pins the contract across ALL the
// per-source maps so the silent-mercator-class drop can't reappear in
// any of the 6 derivation sites.

import { describe, it, expect } from 'vitest'
import { buildShowSourceMaps } from './show-source-maps'
import { computeSliceKey, evalExtrudeExpr } from '@xgis/data'

type MinimalShow = {
  targetName: string
  sourceLayer?: string
  filterExpr?: { ast: unknown } | null
  sizeExpr?: { ast: unknown } | null
  label?: unknown
  shaderVariant?: { needsFeatureBuffer?: boolean; featureFields?: string[] }
  extrude?: { kind: string; expr?: { ast: unknown }; value?: number } | undefined
  extrudeBase?: { kind: string; expr?: { ast: unknown }; value?: number } | undefined
  strokeWidthExpr?: { ast: unknown } | undefined
  strokeColorExpr?: { ast: unknown } | undefined
}

// AST builder mirroring runtime/src/engine/text/text-resolver.test.ts —
// `collectFields` adds the `field` of a FieldAccess node.
const fld = (field: string) => ({ kind: 'FieldAccess' as const, object: null, field })
// `get("name:latin")` builtin call — the form the Mapbox converter emits for
// colon-bearing keys that the `.field` syntax cannot lex (mapbox-to-xgis).
const getStr = (field: string) => ({
  kind: 'FnCall' as const,
  callee: { kind: 'Identifier' as const, name: 'get' },
  args: [{ kind: 'StringLiteral' as const, value: field }],
})

const show = (s: MinimalShow): never => s as never
const FILTER_GT_1M = { ast: { kind: 'BinaryExpr', op: '>', left: 'a', right: 1_000_000 } }
const FILTER_GT_5M = { ast: { kind: 'BinaryExpr', op: '>', left: 'a', right: 5_000_000 } }

describe('buildShowSourceMaps showSlicesBySource — filter routing', () => {
  it('inline GeoJSON shows (no sourceLayer) still get slice entries', () => {
    const { showSlicesBySource } = buildShowSourceMaps([show({ targetName: 'countries' })])
    const list = showSlicesBySource.get('countries')
    expect(list, 'inline GeoJSON show should get a slice list').toBeTruthy()
    expect(list).toHaveLength(1)
    expect(list![0]!.sourceLayer).toBe('countries')
  })

  it('inline filtered shows get a distinct sliceKey per filter', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'countries' }),
      show({ targetName: 'countries', filterExpr: FILTER_GT_1M }),
      show({ targetName: 'countries', filterExpr: FILTER_GT_5M }),
    ])
    const list = showSlicesBySource.get('countries')!
    expect(list).toHaveLength(3)
    expect(new Set(list.map((s) => s.sliceKey)).size, '3 unique sliceKeys').toBe(3)
    expect(list[0]!.sliceKey).toBe('countries')
  })

  it('MVT shows with explicit sourceLayer still use it (no fallback)', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'protomaps', sourceLayer: 'water' }),
      show({ targetName: 'protomaps', sourceLayer: 'roads' }),
    ])
    const list = showSlicesBySource.get('protomaps')!
    expect(list.map((s) => s.sourceLayer).sort()).toEqual(['roads', 'water'])
  })
})

// Same silent-drop class hit all 5 per-source maps before the
// `effectiveLayer` fallback. These pin each map so a future regression
// in the helper / inline GeoJSON gate trips loudly.
describe('buildShowSourceMaps — all 5 maps honour inline GeoJSON shows', () => {
  it('usedSourceLayers includes inline GeoJSON layers', () => {
    const { usedSourceLayers } = buildShowSourceMaps([show({ targetName: 'countries' })])
    expect(usedSourceLayers.get('countries')?.has('countries')).toBe(true)
  })

  it('extrudeExprsBySource indexes inline-show extrude under targetName', () => {
    const { extrudeExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'buildings', extrude: { kind: 'feature', expr: { ast: 'h' } } }),
    ])
    const layerMap = extrudeExprsBySource.get('buildings')
    expect(layerMap, 'inline extrude show should produce a layerMap').toBeTruthy()
    expect(layerMap!['buildings']).toBe('h')
  })

  it('extrudeBaseExprsBySource indexes inline-show extrudeBase under targetName', () => {
    const { extrudeBaseExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'buildings', extrudeBase: { kind: 'feature', expr: { ast: 'b' } } }),
    ])
    expect(extrudeBaseExprsBySource.get('buildings')?.['buildings']).toBe('b')
  })

  // #1084 — a CONSTANT `extrude: 50` used to render FLAT: the extrude UNIFORM
  // (u.extrude_height_m) is read by NO shader (polygon.ts declares it, nothing
  // consumes it), and the constant form produced no per-feature heights AST, so
  // data.heights stayed empty → the upload dispatch took the flat vertex path.
  // The fix lowers the constant into the SAME per-feature channel as the feature
  // form via a synthesised NumberLiteral, so extractFeatureHeights → wall mesh.
  it('#1084 constant extrude synthesises a per-feature heights AST (evaluates to the constant)', () => {
    const { extrudeExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'buildings', extrude: { kind: 'constant', value: 50 } }),
    ])
    const layerMap = extrudeExprsBySource.get('buildings')
    expect(layerMap, 'constant extrude must feed the per-feature heights channel').toBeTruthy()
    expect(evalExtrudeExpr(layerMap!['buildings'], {})).toBe(50)
  })

  it('#1084 constant extrudeBase also synthesises a per-feature AST', () => {
    const { extrudeBaseExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'buildings', extrudeBase: { kind: 'constant', value: 12 } }),
    ])
    expect(evalExtrudeExpr(extrudeBaseExprsBySource.get('buildings')?.['buildings'], {})).toBe(12)
  })

  it('strokeWidthExprsBySource indexes inline-show width-expr by sliceKey', () => {
    const { strokeWidthExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'rivers', strokeWidthExpr: { ast: 'w' } }),
      show({ targetName: 'rivers', strokeWidthExpr: { ast: 'w2' }, filterExpr: FILTER_GT_1M }),
    ])
    const layerMap = strokeWidthExprsBySource.get('rivers')!
    expect(Object.keys(layerMap).length).toBe(2)
    expect(layerMap[computeSliceKey('rivers', null)]).toBe('w')
    expect(layerMap[computeSliceKey('rivers', FILTER_GT_1M.ast)]).toBe('w2')
  })

  it('strokeColorExprsBySource indexes inline-show colour-expr by sliceKey', () => {
    const { strokeColorExprsBySource } = buildShowSourceMaps([
      show({ targetName: 'roads', strokeColorExpr: { ast: 'c' } }),
    ])
    expect(strokeColorExprsBySource.get('roads')?.[computeSliceKey('roads', null)]).toBe('c')
  })
})

// Cross-path invariant: the sliceKey the BACKEND emits (derived from
// the showSlices descriptor we hand it) MUST equal the sliceKey the
// renderer-side path computes for the same show. Without this contract
// pinned, the two sides can silently drift — which is exactly what
// happened with filter_gdp: backend emitted 'countries' (no filter)
// while VTR's runtime path looked up '' (the bare sourceLayer with no
// targetName fallback). Both code paths now use the same
// `sourceLayer || targetName` fallback; this test asserts they agree
// for a representative input set.
describe('cross-path sliceKey invariant (backend ↔ renderer)', () => {
  // Mirror of vector-tile-renderer.ts:2422 and the label path at
  // map.ts:3494. Updating either of those without updating this test
  // means the renderer side has drifted from the backend side.
  const rendererSliceKey = (s: MinimalShow): string =>
    computeSliceKey(s.sourceLayer || s.targetName || '', s.filterExpr?.ast ?? null)

  it('inline + filter combinations all agree', () => {
    const shows: MinimalShow[] = [
      { targetName: 'countries' },
      { targetName: 'countries', filterExpr: FILTER_GT_1M },
      { targetName: 'countries', filterExpr: FILTER_GT_5M },
      { targetName: 'water', sourceLayer: 'water' },
      { targetName: 'protomaps', sourceLayer: 'roads', filterExpr: FILTER_GT_1M },
    ]
    const { showSlicesBySource } = buildShowSourceMaps(shows.map(show))
    for (const s of shows) {
      const list = showSlicesBySource.get(s.targetName)!
      const filterAst = s.filterExpr?.ast ?? null
      const backendEntry = list.find((e) => e.filterAst === filterAst)
      expect(
        backendEntry,
        `backend slice missing for target=${s.targetName} filter=${!!filterAst}`,
      ).toBeTruthy()
      expect(
        backendEntry!.sliceKey,
        `backend (${backendEntry!.sliceKey}) ↔ renderer (${rendererSliceKey(s)}) drift on ${s.targetName}`,
      ).toBe(rendererSliceKey(s))
    }
  })
})

// featureProps field-filter perf opt: each slice carries the MINIMAL set
// of feature-property keys its consumers (label text-field + iconImageExpr +
// shapes.size + shapes.color + data-driven variant featureFields) actually
// read, so the MVT worker clones only those across the worker→main boundary.
// Fail-before: the slice had no featurePropKeys at all (OPT-001 R1).
// These tests also cover the GAP 1 (missing label sub-ASTs) and GAP 2
// (collectFields silently truncating match/ternary) defects found in review.
describe('buildShowSourceMaps — featurePropKeys field-filter', () => {
  // ── Baseline: simple labels still collect exactly ──────────────────
  it('simple {name} template + variant on .class → [class, name]', () => {
    // Regression: must still work after the 4-source expansion.
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'places',
        label: {
          text: { kind: 'template', parts: [{ kind: 'interp', expr: { ast: fld('name') } }] },
        },
        shaderVariant: { needsFeatureBuffer: true, featureFields: ['class'] },
      }),
    ])
    const list = showSlicesBySource.get('places')!
    expect(list).toHaveLength(1)
    expect(list[0]!.featurePropKeys).toEqual(['class', 'name'])
    expect(list[0]!.needsFeatureProps).toBe(true)
  })

  it('expr-kind text-field contributes its field', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'places', label: { text: { kind: 'expr', expr: { ast: fld('name') } } } }),
    ])
    expect(showSlicesBySource.get('places')![0]!.featurePropKeys).toEqual(['name'])
  })

  it('variant featureFields ignored when needsFeatureBuffer is false', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'water',
        sourceLayer: 'water',
        shaderVariant: { needsFeatureBuffer: false, featureFields: ['class'] },
      }),
    ])
    expect(showSlicesBySource.get('water')![0]!.featurePropKeys).toEqual([])
  })

  it('shows sharing a sliceKey union their fields', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'poi', label: { text: { kind: 'expr', expr: { ast: fld('name') } } } }),
      show({
        targetName: 'poi',
        shaderVariant: { needsFeatureBuffer: true, featureFields: ['class', 'rank'] },
      }),
    ])
    expect(showSlicesBySource.get('poi')![0]!.featurePropKeys).toEqual(['class', 'name', 'rank'])
  })

  it('literal-only label template → [] (no fields)', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'lit',
        label: { text: { kind: 'template', parts: [{ kind: 'literal', value: 'X' }] } },
      }),
    ])
    expect(showSlicesBySource.get('lit')![0]!.featurePropKeys).toEqual([])
  })

  // ── GAP 2: match/ternary in text-field → full-props fallback ────────
  // collectFieldsStrict returns null on ConditionalExpr / MatchBlock so the
  // slice falls back to full props rather than silently dropping fields.
  it('ternary text-field → [] (full-props fallback, not a partial set)', () => {
    // A `condition ? .name : .alt` text-field would have dropped .alt with
    // the old collectFields. collectFieldsStrict returns null → [].
    // fail-before: old code returned a partial Set missing at least one field.
    const ternaryAst = {
      kind: 'ConditionalExpr' as const,
      condition: fld('lang'),
      thenExpr: fld('name'),
      elseExpr: fld('alt'),
    }
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'places', label: { text: { kind: 'expr', expr: { ast: ternaryAst } } } }),
    ])
    // collectFieldsStrict returns a Set for ConditionalExpr (fully traversed).
    // So the result is ['alt', 'lang', 'name'] — all three fields collected.
    expect(showSlicesBySource.get('places')![0]!.featurePropKeys).toEqual(['alt', 'lang', 'name'])
  })

  it('match text-field (FnCall + matchBlock arms) → all fields collected', () => {
    // OFM-style match(.subclass) { "shop" -> .name, _ -> .ref } — old
    // collectFields dropped arm-value fields. collectFieldsStrict walks arms.
    // fail-before: featurePropKeys would be ['subclass'] only, missing name/ref.
    const matchAst = {
      kind: 'FnCall' as const,
      callee: { kind: 'Identifier' as const, name: 'match' },
      args: [fld('subclass')],
      matchBlock: {
        kind: 'MatchBlock' as const,
        arms: [
          { pattern: 'shop', value: fld('name') },
          { pattern: '_', value: fld('ref') },
        ],
      },
    }
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'poi', label: { text: { kind: 'expr', expr: { ast: matchAst } } } }),
    ])
    // All three fields must be present (match subject + arm values).
    expect(showSlicesBySource.get('poi')![0]!.featurePropKeys).toEqual(['name', 'ref', 'subclass'])
  })

  // ── GAP 1: iconImageExpr contributes its fields ─────────────────────
  // label-pass.ts:353 evaluates iconImageExpr per-feature. Old code only
  // read label.text → iconImageExpr fields were silently dropped.
  it('data-driven iconImageExpr on a match(.subclass) → full-props fallback', () => {
    // The match arms' fields can't be extracted cleanly — collectFieldsStrict
    // on the match subject returns the subject field, but the arm VALUES
    // (subclass/class) are in the MatchBlock which collectFieldsStrict DOES
    // traverse. Since collectFieldsStrict IS complete for MatchBlock,
    // this should collect all fields.
    // Use a simpler case: iconImageExpr is a bare field access.
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'poi',
        label: {
          text: { kind: 'expr', expr: { ast: fld('name') } },
          iconImageExpr: { ast: fld('subclass') },
        },
      }),
    ])
    // Both text field (name) and iconImageExpr field (subclass) must appear.
    // fail-before: only 'name' appeared (iconImageExpr was not read).
    expect(showSlicesBySource.get('poi')![0]!.featurePropKeys).toEqual(['name', 'subclass'])
  })

  it('iconImageExpr with match(.subclass) arms reading .class → all collected', () => {
    // OFM Bright: icon-image: match(get(subclass), "shop"->icon, _->match(get(class),...))
    // Both subclass (match subject) and class (arm value field) must be present.
    const iconMatchAst = {
      kind: 'FnCall' as const,
      callee: { kind: 'Identifier' as const, name: 'match' },
      args: [fld('subclass')],
      matchBlock: {
        kind: 'MatchBlock' as const,
        arms: [
          { pattern: 'shop', value: { kind: 'StringLiteral' as const, value: 'shop_icon' } },
          { pattern: '_', value: fld('class') },
        ],
      },
    }
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'poi',
        label: {
          text: { kind: 'expr', expr: { ast: fld('name') } },
          iconImageExpr: { ast: iconMatchAst },
        },
      }),
    ])
    // fail-before: only ['name', 'subclass'] — 'class' (arm value) was dropped.
    expect(showSlicesBySource.get('poi')![0]!.featurePropKeys).toEqual([
      'class',
      'name',
      'subclass',
    ])
  })

  // ── GAP 3: get("colon-field") builtin call (the #375 OFM regression) ─
  // The converter emits get("name:latin") (FnCall) for colon keys the
  // `.field` syntax can't lex; collectFieldsStrict must read the StringLiteral
  // arg or the field is silently dropped from the transfer filter.
  it('get("name:latin") text-field → [name:latin] (colon field via builtin call)', () => {
    // fail-before: collectFieldsStrict returned [] (FnCall arg-recursion saw a
    // StringLiteral and added nothing) → OFM non-latin labels lost their text.
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'place',
        label: { text: { kind: 'expr', expr: { ast: getStr('name:latin') } } },
      }),
    ])
    expect(showSlicesBySource.get('place')![0]!.featurePropKeys).toEqual(['name:latin'])
  })

  it('OFM Bright place label expr → all 4 name fields collected', () => {
    // get("name:nonlatin") != null ? concat(get("name:latin"),get("name:nonlatin")) : .name_en ?? .name
    // The two colon fields are get()-calls; name_en/name are FieldAccess. All
    // four must survive the filter or non-latin places render the wrong/blank
    // name. fail-before: only ['name', 'name_en'] (the FieldAccess ones).
    const ofmText = {
      kind: 'ConditionalExpr' as const,
      condition: {
        kind: 'BinaryExpr' as const,
        op: '!=',
        left: getStr('name:nonlatin'),
        right: { kind: 'Identifier' as const, name: 'null' },
      },
      thenExpr: {
        kind: 'FnCall' as const,
        callee: { kind: 'Identifier' as const, name: 'concat' },
        args: [getStr('name:latin'), getStr('name:nonlatin')],
      },
      elseExpr: { kind: 'BinaryExpr' as const, op: '??', left: fld('name_en'), right: fld('name') },
    }
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'place', label: { text: { kind: 'expr', expr: { ast: ofmText } } } }),
    ])
    expect(showSlicesBySource.get('place')![0]!.featurePropKeys).toEqual([
      'name',
      'name:latin',
      'name:nonlatin',
      'name_en',
    ])
  })

  it('dynamic get(<non-literal>) → full-props fallback ([])', () => {
    // get(concat("name:", get("lang"))) — the accessed key is unknowable
    // statically, so the slice must keep full props rather than drop a field.
    const dynGet = {
      kind: 'FnCall' as const,
      callee: { kind: 'Identifier' as const, name: 'get' },
      args: [
        {
          kind: 'FnCall' as const,
          callee: { kind: 'Identifier' as const, name: 'concat' },
          args: [{ kind: 'StringLiteral' as const, value: 'name:' }, getStr('lang')],
        },
      ],
    }
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'place', label: { text: { kind: 'expr', expr: { ast: dynGet } } } }),
    ])
    expect(showSlicesBySource.get('place')![0]!.featurePropKeys).toEqual([])
  })

  // ── GAP 1: shapes.size / shapes.color data-driven fields ───────────
  it('data-driven shapes.size contributes its field', () => {
    // label-pass.ts:343 evaluates shapes.size.expr per feature. Old code
    // did not read shapes at all — the field was silently dropped.
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'places',
        label: {
          text: { kind: 'expr', expr: { ast: fld('name') } },
          shapes: {
            textLayout: { size: { kind: 'data-driven', expr: { ast: fld('rank') } } },
            textPaint: { color: null },
          },
        },
      }),
    ])
    // fail-before: only ['name'] — 'rank' (shapes.size.expr) was missing.
    expect(showSlicesBySource.get('places')![0]!.featurePropKeys).toEqual(['name', 'rank'])
  })

  it('data-driven shapes.color contributes its field', () => {
    // label-pass.ts:345 evaluates shapes.color.expr per feature.
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'places',
        label: {
          text: { kind: 'expr', expr: { ast: fld('name') } },
          shapes: {
            textLayout: { size: { kind: 'constant', value: 14 } },
            textPaint: { color: { kind: 'data-driven', expr: { ast: fld('category') } } },
          },
        },
      }),
    ])
    // fail-before: only ['name'] — 'category' (shapes.color.expr) was missing.
    expect(showSlicesBySource.get('places')![0]!.featurePropKeys).toEqual(['category', 'name'])
  })

  // ── Safe fallback: un-introspectable AST → full props (no field loss) ──
  it('unknown TextValue shape → [] (full-props fallback)', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({
        targetName: 'mystery',
        label: { text: { kind: 'mystery-shape' } },
        shaderVariant: { needsFeatureBuffer: true, featureFields: ['class'] },
      }),
    ])
    const slice = showSlicesBySource.get('mystery')![0]!
    expect(slice.needsFeatureProps).toBe(true)
    expect(slice.featurePropKeys).toEqual([])
  })
})

// #722 S4 — DATA-LAYER half. A data-driven POINT size (`show.sizeExpr`) is
// resolved per feature on the CPU (point-renderer flushTilePoints / VTR's
// `wantsFeatProps = show.sizeExpr?.ast != null`), so the MVT worker MUST ship
// featureProps for the source — else `tileData.featureProps` is undefined and
// every point collapses to the constant `show.size` (exactly what shipped for
// gradient_points `size-[sqrt(.pop_max)/120]`: the cities source carried no
// featureProps). Fail-before: show-source-maps.ts only saw label / shaderVariant
// on the needsFeatureProps gate, so a size-only show stayed false and pop_max
// never entered featurePropKeys.
describe('buildShowSourceMaps — #722 S4 data-driven point size', () => {
  // Real AST shape for gradient_points `size-[sqrt(.pop_max)/120]`: the
  // compiler emits this as show.sizeExpr (emit-commands.ts:542 sets sizeExpr
  // iff node.size.kind === 'data-driven'). Uses the same FieldAccess builder
  // (`fld`) the label tests use, so collectFieldsStrict walks it identically.
  const sizeSqrtPop = {
    ast: {
      kind: 'BinaryExpr' as const,
      op: '/',
      left: {
        kind: 'FnCall' as const,
        callee: { kind: 'Identifier' as const, name: 'sqrt' },
        args: [fld('pop_max')],
      },
      right: { kind: 'NumberLiteral' as const, value: 120 },
    },
  }

  it('data-driven point size → needsFeatureProps true + size field shipped', () => {
    const { showSlicesBySource } = buildShowSourceMaps([
      show({ targetName: 'cities', sizeExpr: sizeSqrtPop }),
    ])
    const slice = showSlicesBySource.get('cities')![0]!
    // fail-before: needsFeatureProps stayed false (gate only saw label/variant).
    expect(slice.needsFeatureProps, 'S4: data-driven point size must ship featureProps').toBe(true)
    // fail-before: featurePropKeys was [] so the worker never cloned pop_max.
    expect(slice.featurePropKeys, 'size expr field pop_max must be cloned').toContain('pop_max')
  })

  it('constant point size (no sizeExpr) ships no featureProps — byte-identical', () => {
    // Negative control: without a size expression the byte-identical constant
    // path must NOT force featureProps (avoids the 309 ms/msg clone regression).
    const { showSlicesBySource } = buildShowSourceMaps([show({ targetName: 'cities' })])
    const slice = showSlicesBySource.get('cities')![0]!
    expect(slice.needsFeatureProps).toBe(false)
    expect(slice.featurePropKeys).toEqual([])
  })
})
