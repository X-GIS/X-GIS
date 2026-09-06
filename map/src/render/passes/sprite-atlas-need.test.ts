// #2517 — the lazy IconStage gate's predicate. The fail-before is the third
// arm: a text-only style whose label text carries an inline `image(...)` MUST
// need the atlas — the pre-#2517 gate (icon || pattern) returned false for it,
// so the sprite was never fetched and the image resolved to nothing. Controls
// keep it honest: plain text needs nothing, and an icon / a pattern still do.
import { describe, expect, it } from 'vitest'
import type { Expr, LabelDef, TextValue } from '@xgis/compiler'
import { spriteAtlasNeeded, textUsesInlineImage } from './sprite-atlas-need'

const str = (value: string): Expr => ({ kind: 'StringLiteral', value })
const ident = (name: string): Expr => ({ kind: 'Identifier', name })
const field = (name: string): Expr => ({ kind: 'FieldAccess', object: null, field: name })
const call = (name: string, ...args: Expr[]): Expr => ({
  kind: 'FnCall',
  callee: ident(name),
  args,
})
const exprText = (ast: Expr): TextValue => ({ kind: 'expr', expr: { ast } })
const label = (text: TextValue, extra: Record<string, unknown> = {}): LabelDef =>
  ({ text, size: 14, ...extra }) as unknown as LabelDef

describe('#2517 — textUsesInlineImage finds image() wherever the author put it', () => {
  it('bare image(...) text-field', () => {
    expect(textUsesInlineImage(exprText(call('image', str('shield'))))).toBe(true)
  })
  it('inside concat(...) — the lowered `format` section shape', () => {
    expect(
      textUsesInlineImage(exprText(call('concat', field('name'), call('image', str('shield'))))),
    ).toBe(true)
  })
  it('inside a template interp part', () => {
    const t: TextValue = {
      kind: 'template',
      parts: [
        { kind: 'literal', value: 'Route ' },
        { kind: 'interp', expr: { ast: call('image', field('ref')) } },
      ],
    }
    expect(textUsesInlineImage(t)).toBe(true)
  })
  it('nested in a conditional and a match arm', () => {
    const cond: Expr = {
      kind: 'ConditionalExpr',
      condition: field('shielded'),
      thenExpr: call('image', str('shield')),
      elseExpr: field('name'),
    }
    expect(textUsesInlineImage(exprText(cond))).toBe(true)
    const m: Expr = {
      kind: 'FnCall',
      callee: ident('match'),
      args: [field('kind')],
      matchBlock: { kind: 'MatchBlock', arms: [{ pattern: 'a', value: call('image', str('x')) }] },
    }
    expect(textUsesInlineImage(exprText(m))).toBe(true)
  })
  it('control: plain text, a field, a template without image → false', () => {
    expect(textUsesInlineImage(exprText(field('name')))).toBe(false)
    expect(textUsesInlineImage(exprText(call('concat', field('a'), str(' '), field('b'))))).toBe(
      false,
    )
    expect(
      textUsesInlineImage({
        kind: 'template',
        parts: [{ kind: 'interp', expr: { ast: field('name') } }],
      }),
    ).toBe(false)
    expect(textUsesInlineImage(undefined)).toBe(false)
  })
})

describe('#2517 — spriteAtlasNeeded: the three reasons, and their absence', () => {
  const plain = { label: label(exprText(field('name'))) }
  it('FAIL-BEFORE — a text-only show whose text carries image(...) needs the atlas', () => {
    const inline = {
      label: label(exprText(call('concat', field('name'), call('image', str('shield'))))),
    }
    expect(spriteAtlasNeeded([inline], [inline])).toBe(true)
  })
  it('an icon on a label show (const or per-feature) needs it', () => {
    expect(
      spriteAtlasNeeded([{ label: label(exprText(field('name')), { iconImage: 'pin' }) }], []),
    ).toBe(true)
    expect(
      spriteAtlasNeeded(
        [{ label: label(exprText(field('name')), { iconImageExpr: { ast: field('icon') } }) }],
        [],
      ),
    ).toBe(true)
  })
  it('a fill-pattern / line-pattern show needs it, even with no label show', () => {
    expect(spriteAtlasNeeded([], [{ fillPattern: 'wetland' }])).toBe(true)
    expect(spriteAtlasNeeded([], [{ linePattern: 'rail' }])).toBe(true)
    expect(spriteAtlasNeeded([], [{ fillPattern: null, linePattern: null }])).toBe(false)
  })
  it('control: plain text labels and pattern-less shows need nothing', () => {
    expect(spriteAtlasNeeded([plain], [plain, { fillPattern: null }])).toBe(false)
    expect(spriteAtlasNeeded([], [])).toBe(false)
  })
})
