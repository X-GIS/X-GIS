// Pin Mapbox type-coercion ops (`number` / `string` / `boolean` /
// `to-number` / `to-string` / `to-boolean` / `to-color`) lowering
// the fallback-chain. Pre-fix the converter only passed the first
// arg through and silently dropped the fallbacks — styles authoring
// `["number", ["get", "height"], 0]` to default missing values lost
// the default and the property collapsed to null.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('Mapbox type-coercion fallback chain', () => {
  it('["number", v, 0] → v ?? 0', () => {
    const w: string[] = []
    expect(exprToXgis(['number', ['get', 'height'], 0], w)).toBe('.height ?? 0')
  })

  it('["to-number", v, 0] → v ?? 0 (alias name)', () => {
    const w: string[] = []
    expect(exprToXgis(['to-number', ['get', 'height'], 0], w)).toBe('.height ?? 0')
  })

  it('["number", v] (single arg) → v (no coalesce overhead)', () => {
    const w: string[] = []
    expect(exprToXgis(['number', ['get', 'height']], w)).toBe('.height')
  })

  it('["number", a, b, c] → a ?? b ?? c (multi-fallback)', () => {
    const w: string[] = []
    expect(
      exprToXgis(['number', ['get', 'a'], ['get', 'b'], 0], w),
    ).toBe('.a ?? .b ?? 0')
  })

  it('["string", v, "default"] → v ?? "default"', () => {
    const w: string[] = []
    expect(
      exprToXgis(['string', ['get', 'name_en'], 'unknown'], w),
    ).toBe('.name_en ?? "unknown"')
  })

  it('["boolean", ["has", "x"], false] → has-check ?? false', () => {
    const w: string[] = []
    expect(
      exprToXgis(['boolean', ['has', 'x'], false], w),
    ).toBe('.x != null ?? false')
  })

  it('["to-color", ["get","c"], "#000"] → c ?? "#000"', () => {
    const w: string[] = []
    expect(
      exprToXgis(['to-color', ['get', 'c'], '#000'], w),
    ).toBe('.c ?? "#000"')
  })

  it('all args dropped (uncconvertible) → null', () => {
    const w: string[] = []
    expect(exprToXgis(['number', ['nonexistent-op']], w)).toBeNull()
  })
})
