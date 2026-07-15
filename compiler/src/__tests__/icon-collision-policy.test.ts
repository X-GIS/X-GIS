// Phase S Batch 4 — icon collision policy end-to-end.
//
// icon-allow-overlap / icon-overlap / icon-ignore-placement / icon-optional
// now thread converter → utility → LabelDef IR. The runtime reads
// LabelDef.iconCollide / iconIgnorePlacement / iconOptional in
// label-pass.dispatchIcon to drive the IconStage `collide` AABB (#417/#419).
//
// Faithful-when-set with a byte-identical ABSENT default:
//   icon-overlap 'always' / icon-allow-overlap true / ABSENT → no
//       iconCollide field (X-GIS' historical always-place — OFM city dots).
//   icon-overlap 'never' / icon-allow-overlap false → iconCollide=true.
//   icon-overlap 'cooperative' → iconCollide=true (approx) + warning.
//   icon-overlap wins over icon-allow-overlap when both present.
//   icon-ignore-placement true → iconIgnorePlacement=true (overrides collide).
//   icon-optional true → iconOptional=true.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

type IconLabel = {
  iconCollide?: boolean
  iconIgnorePlacement?: boolean
  iconOptional?: boolean
}

function compileLabel(layout: Record<string, unknown>): IconLabel {
  const style = {
    version: 8,
    sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: { 'icon-image': 'pin', ...layout },
      },
    ],
  }
  const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const shows = emitCommands(optimize(scene)).shows
  return (shows[0]!.label ?? {}) as IconLabel
}

function convertWarnings(layout: Record<string, unknown>): string[] {
  const style = {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'v',
        'source-layer': 't',
        layout: { 'icon-image': 'pin', 'text-field': '{name}', ...layout },
      },
    ],
  }
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

function convertText(layout: Record<string, unknown>): string {
  const style = {
    version: 8,
    sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: { 'icon-image': 'pin', ...layout },
      },
    ],
  }
  return convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
}

describe('icon collision policy — converter → LabelDef IR', () => {
  describe('DEFAULT byte-identical (absent → always-place)', () => {
    it('absent → no iconCollide / iconIgnorePlacement / iconOptional fields', () => {
      const label = compileLabel({})
      expect(label.iconCollide).toBeUndefined()
      expect(label.iconIgnorePlacement).toBeUndefined()
      expect(label.iconOptional).toBeUndefined()
    })

    it('absent → no label-icon-collide utility in the xgis output', () => {
      expect(convertText({})).not.toContain('label-icon-collide')
    })

    it("icon-overlap 'always' → no iconCollide (matches always-place)", () => {
      expect(compileLabel({ 'icon-overlap': 'always' }).iconCollide).toBeUndefined()
    })

    it('icon-allow-overlap true → no iconCollide (OFM city-dot shape)', () => {
      expect(compileLabel({ 'icon-allow-overlap': true }).iconCollide).toBeUndefined()
    })
  })

  describe('collide opt-in (faithful when set)', () => {
    it("icon-overlap 'never' → iconCollide=true", () => {
      expect(compileLabel({ 'icon-overlap': 'never' }).iconCollide).toBe(true)
    })

    it('icon-allow-overlap false → iconCollide=true', () => {
      expect(compileLabel({ 'icon-allow-overlap': false }).iconCollide).toBe(true)
    })

    it('converter emits label-icon-collide utility for the collide case', () => {
      expect(convertText({ 'icon-overlap': 'never' })).toContain('label-icon-collide')
    })

    it("icon-overlap 'cooperative' → iconCollide=true + approximation warning", () => {
      expect(compileLabel({ 'icon-overlap': 'cooperative' }).iconCollide).toBe(true)
      const hits = convertWarnings({ 'icon-overlap': 'cooperative' }).filter((w) =>
        w.includes('icon-overlap'),
      )
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('cooperative')
    })

    it("icon-overlap wins over icon-allow-overlap when both present (overlap 'always' beats allow false)", () => {
      // overlap:'always' (no collide) must override allow-overlap:false.
      expect(
        compileLabel({ 'icon-overlap': 'always', 'icon-allow-overlap': false }).iconCollide,
      ).toBeUndefined()
    })
  })

  describe('icon-ignore-placement', () => {
    it('true → iconIgnorePlacement=true', () => {
      expect(compileLabel({ 'icon-ignore-placement': true }).iconIgnorePlacement).toBe(true)
    })

    it('false → no field (default no-op)', () => {
      expect(compileLabel({ 'icon-ignore-placement': false }).iconIgnorePlacement).toBeUndefined()
    })

    it('ignore-placement + overlap:never both carried (runtime keeps icon out of the queue)', () => {
      const label = compileLabel({ 'icon-overlap': 'never', 'icon-ignore-placement': true })
      expect(label.iconCollide).toBe(true)
      expect(label.iconIgnorePlacement).toBe(true)
    })
  })

  describe('icon-optional', () => {
    it('true → iconOptional=true', () => {
      expect(compileLabel({ 'icon-optional': true }).iconOptional).toBe(true)
    })

    it('false → no field (default; deferred reverse arbitration)', () => {
      expect(compileLabel({ 'icon-optional': false }).iconOptional).toBeUndefined()
    })
  })
})
