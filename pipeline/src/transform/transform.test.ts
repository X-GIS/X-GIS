import { describe, it, expect } from 'vitest'
import { fromRows } from '../ingest'
import { where, filter, groupBy } from './index'

const rows = [
  { gu: '11680', hour: 8, out: 52000 },
  { gu: '11350', hour: 8, out: 41000 },
  { gu: '11710', hour: 8, out: 38000 },
  { gu: '11680', hour: 18, out: 61000 },
]

describe('@xgis/pipeline · transform', () => {
  it('where selects by exact equality', () => {
    const t = fromRows(rows, { vintage: '2026' })
    expect(where(t, { hour: 8 }).length).toBe(3)
    expect(where(t, { gu: '11680' }).length).toBe(2)
  })

  it('filter selects by predicate (range)', () => {
    const t = fromRows(rows, { vintage: '2026' })
    expect(filter(t, (r) => Number(r.out) >= 45000).length).toBe(2)
  })

  it('groupBy aggregates the value columns', () => {
    const t = fromRows(rows, { vintage: '2026' })
    const perGu = groupBy(where(t, { hour: 8 }), { by: ['gu'], agg: { out: 'sum' } })
    expect(perGu.length).toBe(3)
    const i = (perGu.col('gu') as string[]).indexOf('11680')
    expect(perGu.col('out')[i]).toBe(52000)
    // propagates vintage.
    expect(perGu.vintage).toBe('2026')
  })
})
