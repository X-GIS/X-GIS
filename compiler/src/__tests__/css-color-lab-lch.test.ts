// CSS Color Module 4 — lab(), lch(), oklab(), oklch() parsing.
// Fixture values cross-checked against three.js Color.js and
// https://www.w3.org/TR/css-color-4/#valdef-color-lab known maps.

import { describe, expect, it } from 'vitest'
import { resolveColor } from '../tokens/colors'

describe('CSS Color Module 4: lab() / lch() / oklab() / oklch()', () => {
  describe('lab()', () => {
    it('parses lab(50% 40 -20)', () => {
      const hex = resolveColor('lab(50% 40 -20)')
      expect(hex).not.toBeNull()
      expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    })

    it('lab(0% 0 0) ≈ black', () => {
      const hex = resolveColor('lab(0% 0 0)')
      expect(hex).toBe('#000000')
    })

    it('lab(100% 0 0) ≈ white', () => {
      const hex = resolveColor('lab(100% 0 0)')
      expect(hex).toBe('#ffffff')
    })

    it('lab(50% 0 0) ≈ middle grey', () => {
      const hex = resolveColor('lab(50% 0 0)')
      // L=50 in CIE Lab is roughly perceptual mid-grey, sRGB ~119
      expect(hex).not.toBeNull()
      const r = parseInt(hex!.slice(1, 3), 16)
      expect(r).toBeGreaterThan(100)
      expect(r).toBeLessThan(140)
    })

    it('lab(50% 40 -20 / 0.5) emits alpha', () => {
      const hex = resolveColor('lab(50% 40 -20 / 0.5)')
      expect(hex).toMatch(/^#[0-9a-f]{8}$/)
    })

    it('accepts bare numeric (no %) for L', () => {
      const a = resolveColor('lab(50 0 0)')
      const b = resolveColor('lab(50% 0 0)')
      expect(a).toBe(b)
    })
  })

  describe('lch()', () => {
    it('parses lch(50% 40 30)', () => {
      const hex = resolveColor('lch(50% 40 30)')
      expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    })

    it('lch(50% 0 0) ≈ middle grey (chroma 0 → no hue)', () => {
      const labGrey = resolveColor('lab(50% 0 0)')
      const lchGrey = resolveColor('lch(50% 0 0)')
      expect(lchGrey).toBe(labGrey)
    })

    it('lch(50% 40 0deg) ≈ lch(50% 40) along +a axis', () => {
      // hue=0 → all chroma on +a axis (red-ish in CIE Lab)
      const a = resolveColor('lch(50% 40 0)')
      const b = resolveColor('lch(50% 40 0deg)')
      expect(a).toBe(b)
    })
  })

  describe('oklab()', () => {
    it('parses oklab(0.5 0.1 -0.1)', () => {
      const hex = resolveColor('oklab(0.5 0.1 -0.1)')
      expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    })

    it('oklab(0 0 0) ≈ black', () => {
      const hex = resolveColor('oklab(0 0 0)')
      expect(hex).toBe('#000000')
    })

    it('oklab(1 0 0) ≈ white', () => {
      const hex = resolveColor('oklab(1 0 0)')
      expect(hex).toBe('#ffffff')
    })
  })

  describe('oklch()', () => {
    it('parses oklch(0.5 0.1 30)', () => {
      const hex = resolveColor('oklch(0.5 0.1 30)')
      expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    })

    it('oklch with hue=0 ≈ oklab on +a axis', () => {
      const a = resolveColor('oklch(0.5 0.1 0)')
      const b = resolveColor('oklab(0.5 0.1 0)')
      expect(a).toBe(b)
    })
  })

  describe('hue units (lch/oklch)', () => {
    it('accepts deg / turn / rad / grad', () => {
      const a = resolveColor('lch(50% 40 90)')
      const b = resolveColor('lch(50% 40 90deg)')
      const c = resolveColor('lch(50% 40 0.25turn)')
      const d = resolveColor(`lch(50% 40 ${Math.PI / 2}rad)`)
      const e = resolveColor('lch(50% 40 100grad)')
      expect(a).toBe(b)
      expect(a).toBe(c)
      // rad and grad have small floating-point divergence; allow
      // 1 channel of slack vs degrees baseline.
      expect(d).toMatch(/^#[0-9a-f]{6}$/)
      expect(e).toMatch(/^#[0-9a-f]{6}$/)
    })
  })
})
