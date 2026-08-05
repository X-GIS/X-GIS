// ═══ `input`-dependent paint shapes resolve per frame (#1539) ═══
//
// The behaviour that makes `map.setInput()` visible on BOTH backends: a paint
// expression that references a declared `input` but reads no feature field is a
// per-frame CONSTANT, so it resolves on the CPU into the existing
// `u.opacity` / `u.fill_color` uniform instead of needing the WebGPU-only
// shader-variant path.
//
// Before #1539 the `data-driven` arm of both resolvers returned a flat fallback
// (`1` for numbers, `null` for colours) because every data-driven shape was
// assumed to be a per-feature worker bake. These tests pin the split: an
// `input-dependent` shape resolves to its live value, a genuinely per-feature
// one still takes the fallback.

import { describe, it, expect } from 'vitest'
import type { PropertyShape, ResolvedInputInfo } from '@xgis/compiler'
import { resolveNumberShape, resolveColorShape } from './paint-shape-resolve'
import { InputStore } from './input-store'

const store = (decls: ResolvedInputInfo[]): InputStore => {
  const s = new InputStore()
  s.reset(decls)
  return s
}
const f32Decl = (name: string, slot: number, value: number): ResolvedInputInfo => ({
  name,
  type: 'f32',
  slot,
  default: { kind: 'NumberLiteral', value, unit: null },
  line: 1,
})
const colorDecl = (name: string, slot: number, value: string): ResolvedInputInfo => ({
  name,
  type: 'color',
  slot,
  default: { kind: 'ColorLiteral', value },
  line: 1,
})

/** The shape emit-commands produces for `| opacity-[threshold]` — verified
 *  against the real pipeline in polygon-input-pool.test.ts. */
const inputNumberShape = (name: string, def: number): PropertyShape<number> => ({
  kind: 'data-driven',
  expr: {
    ast: {
      kind: 'InputRef',
      name,
      type: 'f32',
      slot: 0,
      default: { kind: 'NumberLiteral', value: def, unit: null },
    },
    classification: 'input-dependent',
  },
})
const inputColorShape = (
  name: string,
  def: string,
): PropertyShape<readonly [number, number, number, number]> => ({
  kind: 'data-driven',
  expr: {
    ast: {
      kind: 'InputRef',
      name,
      type: 'color',
      slot: 0,
      default: { kind: 'ColorLiteral', value: def },
    },
    classification: 'input-dependent',
  },
})
/** A genuinely per-feature shape — `.score`, baked by the worker. */
const featureShape: PropertyShape<number> = {
  kind: 'data-driven',
  expr: {
    ast: { kind: 'FieldAccess', object: null, field: 'score' },
    classification: 'per-feature-gpu',
  },
}

describe('resolveNumberShape — input-dependent (#1539)', () => {
  it('resolves to the live value, not the flat data-driven fallback', () => {
    const s = store([f32Decl('threshold', 0, 1)])
    s.set('threshold', 0.3)
    expect(resolveNumberShape(inputNumberShape('threshold', 1), 5, 0, s).value).toBe(0.3)
  })

  it('falls back to the declaration default when the host never set it', () => {
    const s = store([f32Decl('threshold', 0, 0.75)])
    expect(resolveNumberShape(inputNumberShape('threshold', 0.75), 5, 0, s).value).toBe(0.75)
  })

  it('with no store the pre-#1539 fallback of 1 is unchanged', () => {
    expect(resolveNumberShape(inputNumberShape('threshold', 0.75), 5, 0).value).toBe(1)
    expect(resolveNumberShape(inputNumberShape('threshold', 0.75), 5, 0, null).value).toBe(1)
  })

  it('a genuinely per-feature shape still takes the fallback (worker bake owns it)', () => {
    const s = store([f32Decl('threshold', 0, 0.3)])
    expect(resolveNumberShape(featureShape, 5, 0, s).value).toBe(1)
  })

  it('reports neither zoom nor time as a contributor (it is neither)', () => {
    const s = store([f32Decl('threshold', 0, 0.3)])
    const r = resolveNumberShape(inputNumberShape('threshold', 0.3), 5, 0, s)
    expect([r.hasZoom, r.hasTime]).toEqual([false, false])
  })
})

describe('resolveColorShape — input-dependent (#1539)', () => {
  it('resolves the hex the evaluator yields into RGBA 0..1', () => {
    const s = store([colorDecl('hl', 0, '#000000')])
    s.set('hl', '#ff0000')
    expect(resolveColorShape(inputColorShape('hl', '#000000'), 5, 0, s)?.value).toEqual([
      1, 0, 0, 1,
    ])
  })

  it('uses the declaration default when the host never set it', () => {
    const s = store([colorDecl('hl', 0, '#00ff00')])
    expect(resolveColorShape(inputColorShape('hl', '#00ff00'), 5, 0, s)?.value).toEqual([
      0, 1, 0, 1,
    ])
  })

  it('with no store the pre-#1539 null is unchanged', () => {
    expect(resolveColorShape(inputColorShape('hl', '#00ff00'), 5, 0)).toBeNull()
  })
})

// ─── The memo-invalidation half (#1539) ──────────────────────────────────
//
// resolveShow reuses the previous frame's snapshot when the paint-shape refs,
// the zoom and the clock all match. `setInput` moves NONE of those, so without
// InputStore.revision in the hit check the memo serves the pre-set value
// forever — the "I called setInput and nothing happened" failure. This is the
// test that names that specific mechanism: sever the revision bump and it fails
// HERE, saying the second frame still saw the old value.

const showWithInputOpacity = (): any => ({
  targetName: 'src',
  layerName: 'L1',
  opacity: 1,
  paintShapes: {
    fill: { fill: null },
    line: { stroke: null, strokeWidth: { kind: 'constant', value: 1 } },
    circle: { size: null },
    common: { opacity: inputNumberShape('threshold', 1) },
  },
})

describe('resolveShow — setInput must survive the per-frame memo (#1539)', () => {
  it('a second frame at the SAME zoom and clock sees the newly set value', async () => {
    const { resolveShow } = await import('./resolved-show')
    const s = store([f32Decl('threshold', 0, 1)])
    const show = showWithInputOpacity()
    const env = { cameraZoom: 5, elapsedMs: 0, inputs: s }

    expect(resolveShow(show, env).opacity).toBe(1)
    s.set('threshold', 0.25)
    // Same show object, same zoom, same elapsedMs — only the input moved.
    expect(
      resolveShow(show, env).opacity,
      'the resolve memo served a stale snapshot: setInput changed no shape ref, ' +
        'no zoom and no clock, so InputStore.revision is the only thing that can ' +
        'invalidate it (resolved-show.ts cache-hit check)',
    ).toBe(0.25)
  })

  it('an input-dependent opacity does NOT fall through to the show.opacity base', async () => {
    const { resolveShow } = await import('./resolved-show')
    const s = store([f32Decl('threshold', 0, 1)])
    s.set('threshold', 0.4)
    // show.opacity is 1 — the pre-#1539 data-driven arm would have returned it.
    expect(
      resolveShow(showWithInputOpacity(), { cameraZoom: 5, elapsedMs: 0, inputs: s }).opacity,
    ).toBe(0.4)
  })
})

describe('resolveShow — every scalar axis honours a live input (#1539)', () => {
  // opacity is covered above. width and size take the SAME `data-driven →
  // static base` shortcut, so an input bound to either must be routed the same
  // way; otherwise `| opacity-[x]` would respond to setInput while
  // `| width-[x]` / `| size-[x]` silently did not.
  const showWith = (axis: 'strokeWidth' | 'size'): any => ({
    targetName: 'src',
    layerName: 'L1',
    opacity: 1,
    strokeWidth: 9,
    size: 9,
    paintShapes: {
      fill: { fill: null },
      line: {
        stroke: null,
        strokeWidth:
          axis === 'strokeWidth' ? inputNumberShape('w', 1) : { kind: 'constant', value: 1 },
      },
      circle: { size: axis === 'size' ? inputNumberShape('w', 1) : null },
      common: { opacity: { kind: 'constant', value: 1 } },
    },
  })

  it.each(['strokeWidth', 'size'] as const)(
    '%s resolves the live value, not the static base',
    async (axis) => {
      const { resolveShow } = await import('./resolved-show')
      const s = store([f32Decl('w', 0, 1)])
      s.set('w', 4)
      const r = resolveShow(showWith(axis), { cameraZoom: 5, elapsedMs: 0, inputs: s })
      expect(axis === 'strokeWidth' ? r.strokeWidth : r.size).toBe(4)
    },
  )

  it('a per-feature width still reads the authored static base', async () => {
    const { resolveShow } = await import('./resolved-show')
    const show = showWith('strokeWidth')
    show.paintShapes.line.strokeWidth = featureShape
    const s = store([f32Decl('w', 0, 1)])
    expect(resolveShow(show, { cameraZoom: 5, elapsedMs: 0, inputs: s }).strokeWidth).toBe(9)
  })
})
