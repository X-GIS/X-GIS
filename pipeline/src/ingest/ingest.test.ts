import { describe, it, expect } from 'vitest'
import { fromRows, fromCSV } from './index'

describe('@xgis/pipeline · ingest', () => {
  it('fromRows builds a columnar Table with vintage + system', () => {
    const t = fromRows(
      [
        { gu: '11680', hour: 8, out: 52000 },
        { gu: '11350', hour: 8, out: 41000 },
      ],
      { vintage: '2026', system: 'KR:ADMCD' },
    )
    expect(t.length).toBe(2)
    expect(t.vintage).toBe('2026')
    expect(t.system).toBe('KR:ADMCD')
    expect(t.columns).toEqual(['gu', 'hour', 'out'])
    expect(t.col('out')[0]).toBe(52000)
    expect(t.row(1)).toEqual({ gu: '11350', hour: 8, out: 41000 })
  })

  it('fromCSV parses numeric cells + honours a string-pinned column', () => {
    const t = fromCSV('gu,out\n11680,52000\n11350,41000', {
      types: { gu: 'string' },
      vintage: '2026',
    })
    expect(t.length).toBe(2)
    expect(t.col('gu')[0]).toBe('11680') // pinned string, not number
    expect(t.col('out')[0]).toBe(52000) // parsed number
  })
})
