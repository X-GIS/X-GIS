// Strict-mode diagnostics — the lower pass surfaces likely-wrong
// constructs (deprecated syntax, etc.) via Scene.diagnostics so
// callers (runtime, /convert page, CLI) can warn the user instead
// of silently producing wrong output.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

function lowerSrc(src: string) {
  const tokens = new Lexer(src).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

describe('X-GIS0001: deprecated z<N>: zoom modifier', () => {
  it('warns on `z8:opacity-40` modifier (the silent-failure case)', () => {
    const scene = lowerSrc(`
      source x { type: geojson, url: "x.geojson" }
      layer y {
        source: x
        | fill-red-500
        | z8:opacity-40
      }
    `)
    expect(scene.diagnostics).toBeDefined()
    expect(scene.diagnostics!.length).toBeGreaterThan(0)
    const d = scene.diagnostics!.find(d => d.code === 'X-GIS0001')
    expect(d).toBeDefined()
    expect(d!.severity).toBe('warn')
    expect(d!.message).toContain('z8:')
    expect(d!.message).toContain('interpolate(zoom')
    expect(d!.message).toContain('interpolate(zoom, 8, 40)')  // suggested replacement
  })

  it('warns once per `z<N>:` modifier instance', () => {
    const scene = lowerSrc(`
      source x { type: geojson, url: "x.geojson" }
      layer y {
        source: x
        | fill-red-500
        | z2:opacity-30 z5:opacity-60 z8:opacity-90
      }
    `)
    const zd = scene.diagnostics!.filter(d => d.code === 'X-GIS0001')
    expect(zd.length).toBe(3)
    expect(zd.map(d => d.message).every(m => m.includes('interpolate(zoom'))).toBe(true)
  })

  it('correct interpolate(zoom, …) syntax produces NO diagnostic', () => {
    const scene = lowerSrc(`
      source x { type: geojson, url: "x.geojson" }
      layer y {
        source: x
        | fill-red-500
        | opacity-[interpolate(zoom, 8, 40, 14, 100)]
      }
    `)
    const zd = (scene.diagnostics ?? []).filter(d => d.code === 'X-GIS0001')
    expect(zd.length).toBe(0)
  })

  it('legitimate field-name modifiers are NOT flagged', () => {
    // Real-data modifiers like `priority:fill-red-500` or
    // `highway:stroke-2` don't match the z<digit>+ pattern. Make
    // sure the strict check doesn't have false positives there.
    const scene = lowerSrc(`
      source x { type: geojson, url: "x.geojson" }
      layer y {
        source: x
        | priority:fill-red-500 highway:stroke-2
      }
    `)
    const zd = (scene.diagnostics ?? []).filter(d => d.code === 'X-GIS0001')
    expect(zd.length).toBe(0)
  })
})

describe('Scene.diagnostics shape', () => {
  it('is an array (possibly empty) — never undefined when set', () => {
    const scene = lowerSrc(`
      source x { type: geojson, url: "x.geojson" }
      layer y { source: x | fill-red-500 }
    `)
    expect(Array.isArray(scene.diagnostics)).toBe(true)
  })

  it('each diagnostic has severity + message + code', () => {
    const scene = lowerSrc(`
      source x { type: geojson, url: "x.geojson" }
      layer y { source: x | z5:opacity-50 }
    `)
    for (const d of scene.diagnostics ?? []) {
      expect(d.severity).toMatch(/^(warn|info)$/)
      expect(typeof d.message).toBe('string')
      expect(d.message.length).toBeGreaterThan(0)
      expect(typeof d.code).toBe('string')
      expect(d.code).toMatch(/^X-GIS\d{4}$/)
    }
  })
})
