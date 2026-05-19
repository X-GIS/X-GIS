// Pin the invariant that our four production fixtures (OFM Bright /
// Liberty / Positron / MapLibre demotiles) do NOT use any
// densification-eligible operator forms — cubic-bezier curves or
// interpolate-lab / interpolate-hcl. If a future fixture update
// introduces these, the iter 60-62 densification will change the
// emitted xgis stop count, the fixture-ir-snapshot fingerprint
// will drift, and this gate triggers a deliberate snapshot regen
// rather than a confused investigation of why the byte count moved.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const FIXTURES = [
  'openfreemap-bright',
  'openfreemap-liberty',
  'openfreemap-positron',
  'maplibre-demotiles',
] as const

function fixtureRaw(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8')
}

describe('Fixture densification-eligibility invariant', () => {
  for (const name of FIXTURES) {
    it(`${name} — no cubic-bezier / interpolate-lab / interpolate-hcl forms`, () => {
      const raw = fixtureRaw(name)
      // Substring search on the JSON source — operator tokens always
      // appear as exact quoted strings in Mapbox style JSON.
      expect(
        raw.includes('"cubic-bezier"'),
        `${name} introduces cubic-bezier; iter 60 densification will mutate this fixture's IR — regenerate fixture-ir-snapshot if intentional`,
      ).toBe(false)
      expect(
        raw.includes('"interpolate-lab"'),
        `${name} introduces interpolate-lab; iter 61-62 densification will mutate this fixture's IR — regenerate fixture-ir-snapshot if intentional`,
      ).toBe(false)
      expect(
        raw.includes('"interpolate-hcl"'),
        `${name} introduces interpolate-hcl; iter 61-62 densification will mutate this fixture's IR — regenerate fixture-ir-snapshot if intentional`,
      ).toBe(false)
    })
  }
})
