import { describe, it, expect } from 'vitest'
import { resolveText } from './text-resolver'
import type { TextValue } from '@xgis/compiler'

const fld = (field: string) =>
  ({ kind: 'FieldAccess' as const, object: null, field })

describe('resolveText', () => {
  describe('kind: expr', () => {
    it('resolves a bare field access', () => {
      const tv: TextValue = { kind: 'expr', expr: { ast: fld('name') } }
      expect(resolveText(tv, { name: 'Seoul' })).toBe('Seoul')
    })

    it('coerces numbers to string', () => {
      const tv: TextValue = { kind: 'expr', expr: { ast: fld('pop') } }
      expect(resolveText(tv, { pop: 9_733_509 })).toBe('9733509')
    })

    it('null/undefined value → empty string', () => {
      const tv: TextValue = { kind: 'expr', expr: { ast: fld('missing') } }
      expect(resolveText(tv, {})).toBe('')
    })

    it('crashing expression → empty string (graceful)', () => {
      // Constructed AST that will throw inside evaluate (unknown kind)
      const tv: TextValue = {
        kind: 'expr',
        expr: { ast: { kind: 'BogusKind' } as never },
      }
      expect(resolveText(tv, { x: 1 })).toBe('')
    })
  })

  describe('kind: template', () => {
    it('literal-only template returns concatenated text', () => {
      const tv: TextValue = {
        kind: 'template',
        parts: [
          { kind: 'literal', value: 'Hello ' },
          { kind: 'literal', value: 'world' },
        ],
      }
      expect(resolveText(tv, {})).toBe('Hello world')
    })

    it('literal + interp + literal with format spec', () => {
      const tv: TextValue = {
        kind: 'template',
        parts: [
          { kind: 'literal', value: 'Lat: ' },
          { kind: 'interp', expr: { ast: fld('lat') }, spec: { precision: 4, type: 'f' } },
          { kind: 'literal', value: '°N' },
        ],
      }
      expect(resolveText(tv, { lat: 37.566535 })).toBe('Lat: 37.5665°N')
    })

    it('multi-interp template', () => {
      const tv: TextValue = {
        kind: 'template',
        parts: [
          { kind: 'interp', expr: { ast: fld('name') } },
          { kind: 'literal', value: ' (' },
          { kind: 'interp', expr: { ast: fld('country') } },
          { kind: 'literal', value: ')' },
        ],
      }
      expect(resolveText(tv, { name: 'Seoul', country: 'Korea' }))
        .toBe('Seoul (Korea)')
    })

    it('GIS spec applied via formatValue', () => {
      const tv: TextValue = {
        kind: 'template',
        parts: [
          { kind: 'interp', expr: { ast: fld('lat') }, spec: { type: 'dms' } },
        ],
      }
      expect(resolveText(tv, { lat: 37.5665 })).toBe(`37°33'59.4"`)
    })

    it('grouping spec on integer pop', () => {
      const tv: TextValue = {
        kind: 'template',
        parts: [
          { kind: 'literal', value: 'Pop: ' },
          { kind: 'interp', expr: { ast: fld('pop') }, spec: { grouping: ',' } },
        ],
      }
      expect(resolveText(tv, { pop: 9_733_509 })).toBe('Pop: 9,733,509')
    })

    it('missing field on interp resolves to empty without breaking surrounding literals', () => {
      const tv: TextValue = {
        kind: 'template',
        parts: [
          { kind: 'literal', value: '[' },
          { kind: 'interp', expr: { ast: fld('missing') } },
          { kind: 'literal', value: ']' },
        ],
      }
      expect(resolveText(tv, {})).toBe('[]')
    })

    it('bearing format spec', () => {
      const tv: TextValue = {
        kind: 'template',
        parts: [
          { kind: 'interp', expr: { ast: fld('brg') }, spec: { type: 'bearing' } },
        ],
      }
      expect(resolveText(tv, { brg: 45 })).toBe('045°')
    })
  })
})
