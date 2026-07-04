import { describe, it, expect, vi } from 'vitest'
import { fromRows } from '../ingest'
import { join } from './index'
import { seoulSigunguGazetteer } from '../gazetteer/kr'

const rows = [
  { gu: '11680', out: 52000 }, // 강남구
  { gu: '11350', out: 41000 }, // 노원구
  { gu: '99999', out: 100 }, // unknown code → warn + drop
]

describe('@xgis/pipeline · join', () => {
  it('resolves standard codes → WGS84 centroids, dropping + warning the unknown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = fromRows(rows, { vintage: '2026' })
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const j = join(t, { code: 'gu', gaz, as: 'origin' })
    expect(j.length).toBe(2) // 99999 dropped
    expect(j.columns).toContain('origin.lon')
    expect(j.columns).toContain('origin.name')
    const i = (j.col('gu') as string[]).indexOf('11680')
    expect(Number(j.col('origin.lon')[i])).toBeCloseTo(127.075, 2)
    expect(j.col('origin.name')[i]).toBe('강남구')
    expect(warn).toHaveBeenCalled() // the 99999 drop
    warn.mockRestore()
  })

  it('THROWS on a vintage mismatch (the reassigned-code guard)', () => {
    const t = fromRows(rows, { vintage: '2020' })
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    expect(() => join(t, { code: 'gu', gaz, as: 'o' })).toThrow(/vintage mismatch/)
  })

  it('THROWS when the data has no stamped vintage', () => {
    const t = fromRows(rows) // no vintage
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    expect(() => join(t, { code: 'gu', gaz, as: 'o' })).toThrow(/needs the data vintage/)
  })

  it('THROWS on a code-system mismatch when the data declares its system', () => {
    const t = fromRows(rows, { vintage: '2026', system: 'KR:법정동코드' })
    const gaz = seoulSigunguGazetteer({ vintage: '2026' }) // system 'KR:ADMCD'
    expect(() => join(t, { code: 'gu', gaz, as: 'o' })).toThrow(/code-system mismatch/)
  })
})
