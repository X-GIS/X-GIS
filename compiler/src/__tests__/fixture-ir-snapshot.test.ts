// Structural snapshot gate for the four large fixture styles.
// Locks (output hash, line count, layer count, warning count) per
// fixture so unrelated converter edits that silently change the
// emitted IR fail loudly. We deliberately do NOT snapshot the
// full converted string — those run to hundreds of KB per fixture
// and would balloon the snapshots dir. The four-tuple is enough
// to surface any drift; reviewers can regenerate by running with
// `vitest -u` and inspecting the diff against `git log -p` of the
// converter.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'

const FIXTURES = [
  'openfreemap-bright',
  'openfreemap-liberty',
  'openfreemap-positron',
  'maplibre-demotiles',
] as const

interface StructuralFingerprint {
  outputSha256: string
  outputLines: number
  outputBytes: number
  warningCount: number
  layerCount: number
}

function fingerprint(name: string): StructuralFingerprint {
  const path = join(__dirname, 'fixtures', `${name}.json`)
  const raw = readFileSync(path, 'utf8')
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const out = convertMapboxStyle(raw, { coverage })
  return {
    outputSha256: createHash('sha256').update(out, 'utf8').digest('hex'),
    outputLines: out.split('\n').length,
    outputBytes: out.length,
    warningCount: coverage.warnings.length,
    layerCount: coverage.layers.length,
  }
}

describe('Fixture conversion structural snapshot', () => {
  for (const name of FIXTURES) {
    it(`${name} — converted output fingerprint`, () => {
      const fp = fingerprint(name)
      expect(fp).toMatchSnapshot()
    })
  }

  it('deterministic — second run produces identical fingerprint', () => {
    const a = fingerprint('openfreemap-bright')
    const b = fingerprint('openfreemap-bright')
    expect(a).toEqual(b)
  })
})
