// text-field data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `text-field` is the
// symbol-layout property that carries the label's text content. It is marked
// `supported` and lowers to LabelDef.text (a TextValue AST). The resolver
// itself (resolveText) is unit-tested in text-resolver.test.ts, but NOTHING
// pinned the WIRING: that the runtime label stage actually threads a layer's
// text-field TextValue + the feature props INTO resolveText and submits the
// resolved string to the glyph pipeline. A break there (renderer drops the
// field, hard-codes a string, or forgets the props) ships silently — the
// heatmap-class wiring bug.
//
// This drives the REAL TextStage.addLabel against a GPU-free stage stub
// (Object.create(TextStage.prototype) + injected `_diag` / `pending` / `opts`
// — same construction as text-stage.test.ts's submitted/drawn counter test,
// which never touches the WebGPU atlas/renderer surface) and reads back the
// post-resolve dispatched text via getDispatchedLabelTexts(). That accessor
// returns exactly the strings addLabel submitted after resolving text-field
// against the feature props (text-stage.ts:563 resolveText →
// :568 _diag.recordDispatch).
//
// Non-vacuous: the asserted string is derived from BOTH the text-field AST
// AND the feature props — swapping the props swaps the dispatched text, so no
// constant or prop-independent value can satisfy it.
//
// Fail-before: replace `const text = resolveText(value, props, this.cameraZoom)`
// in addLabel with a constant (e.g. `const text = 'XXX'`) and the dispatched
// text is no longer the field-derived value → every assertion below fails:
// the wire that makes text-field actually reach the glyph path is gone, and
// the test says so before a render ever runs.

import { describe, it, expect } from 'vitest'
import type { LabelDef, TextValue } from '@xgis/compiler'
import { TextStage } from '@xgis/map'
import { TextStageDiagnostics } from '@xgis/map'

// FieldAccess AST node helper — mirrors text-resolver.test.ts.
const fld = (field: string) =>
  ({ kind: 'FieldAccess' as const, object: null, field })

/** Build a GPU-free TextStage that only has the fields addLabel touches:
 *  cameraZoom (private, default undefined → no zoom enrichment), pending
 *  (the queue addLabel pushes to), opts.defaultFont (composeFontKey), the
 *  injected TextStageDiagnostics (recordDispatch / getDispatchedLabelTexts),
 *  and the optional _traceRecorder (null → recordTrace no-ops) / _debugHook
 *  (undefined → skipped). No GlyphAtlasHost / GPU / renderer is constructed,
 *  so this is WebGPU-free. */
function gpuFreeStage(): TextStage {
  const stage = Object.create(TextStage.prototype) as TextStage
  const diag = new TextStageDiagnostics()
  Object.assign(stage as unknown as Record<string, unknown>, {
    _diag: diag,
    _traceRecorder: null,
    _debugHook: undefined,
    cameraZoom: undefined,
    pending: [],
    opts: { defaultFont: 'sans-serif' },
  })
  return stage
}

/** A LabelDef whose text-field is the given TextValue. `size` is the only
 *  other field addLabel's path needs (via composeFontKey it reads font /
 *  fontWeight / fontStyle, all absent → default). */
function labelWith(text: TextValue): LabelDef {
  return { text, size: 12 } as LabelDef
}

describe('text-field data-path wiring (GPU-free)', () => {
  it('threads the text-field AST + props → dispatched label text', () => {
    const stage = gpuFreeStage()
    // text-field = "{name}" (single interp). Resolved against props.
    const value: TextValue = {
      kind: 'template',
      parts: [{ kind: 'interp', expr: { ast: fld('name') } }],
    }
    stage.addLabel(value, { name: 'Seoul' }, 100, 200, labelWith(value))
    expect(stage.getDispatchedLabelTexts()).toContain('Seoul')
  })

  it('dispatched text follows the PROPS, not a constant (prop-dependence)', () => {
    const stage = gpuFreeStage()
    const value: TextValue = { kind: 'expr', expr: { ast: fld('name') } }
    stage.addLabel(value, { name: 'Tokyo' }, 0, 0, labelWith(value))
    const texts = stage.getDispatchedLabelTexts()
    expect(texts).toContain('Tokyo')
    expect(texts).not.toContain('Seoul')
  })

  it('a literal text-field template reaches the glyph path verbatim', () => {
    const stage = gpuFreeStage()
    const value: TextValue = {
      kind: 'template',
      parts: [
        { kind: 'literal', value: 'Hello ' },
        { kind: 'literal', value: 'world' },
      ],
    }
    stage.addLabel(value, {}, 0, 0, labelWith(value))
    expect(stage.getDispatchedLabelTexts()).toContain('Hello world')
  })

  it('an empty-resolved text-field submits NO label (wired skip)', () => {
    const stage = gpuFreeStage()
    // Field is missing on the feature → resolveText yields '' → addLabel skips.
    const value: TextValue = { kind: 'expr', expr: { ast: fld('missing') } }
    stage.addLabel(value, {}, 0, 0, labelWith(value))
    expect(stage.getDispatchedLabelTexts()).toEqual([])
  })
})
