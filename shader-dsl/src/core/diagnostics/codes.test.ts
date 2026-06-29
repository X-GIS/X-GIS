import { describe, it, expect } from 'vitest'
import { CODES } from './codes'

describe('diagnostic code catalogue', () => {
  const entries = Object.entries(CODES)

  it('every key is a well-formed SD#### code matching its entry', () => {
    for (const [key, def] of entries) {
      expect(key).toMatch(/^SD\d{4}$/)
      expect(def.code).toBe(key)
    }
  })

  it('every code has a non-empty summary', () => {
    for (const [, def] of entries) expect(def.summary.length).toBeGreaterThan(0)
  })

  it('codes are unique', () => {
    const codes = entries.map(([, d]) => d.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  // A deliberate snapshot of the catalogue keys — adding/removing a code is a reviewed diff.
  it('catalogue keys are stable', () => {
    expect(entries.map(([k]) => k).sort()).toMatchInlineSnapshot(`
      [
        "SD0001",
        "SD0002",
        "SD0003",
        "SD0004",
        "SD0005",
        "SD0006",
        "SD0007",
        "SD0008",
        "SD0009",
        "SD0010",
        "SD0011",
        "SD0012",
        "SD0013",
        "SD0020",
        "SD0030",
        "SD0107",
      ]
    `)
  })
})
