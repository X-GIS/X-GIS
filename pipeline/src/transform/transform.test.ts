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

  // ── min/max on a group with no numeric cell (#2358) ──────────────────────
  //
  // `aggregate` seeds min with +Infinity and max with -Infinity and skips every
  // NaN cell, so a group whose cells are ALL non-numeric returns the untouched
  // seed. Ingested CSV supplies exactly that shape ('N/A', '-', ''), and
  // fromRows stores such cells verbatim.
  //
  // The n > 0 cases below are not padding: the fix touches the return path that
  // min/max share with every other group, so a change that "fixed" the empty
  // group by breaking the populated one would pass an empty-group-only test.
  // Nothing in this file exercised min/max at all before #2358.

  it('min/max return NaN — not +/-Infinity — when a group has no numeric cell', () => {
    // NOT '' — `Number('')` is 0, so a blank cell is NUMERIC to this function
    // and the group would not be empty on its own. Blank-as-missing is #2378,
    // covered separately below.
    const t = fromRows([
      { g: 'none', v: 'N/A' },
      { g: 'none', v: '-' },
      { g: 'none', v: 'null' },
    ])
    const lo = groupBy(t, { by: ['g'], agg: { v: 'min' } }).col('v')[0] as number
    const hi = groupBy(t, { by: ['g'], agg: { v: 'max' } }).col('v')[0] as number
    expect(Number.isNaN(lo)).toBe(true)
    expect(Number.isNaN(hi)).toBe(true)
    // Named separately: NaN and Infinity are both non-finite, so a
    // `Number.isFinite` assertion alone would pass on the pre-fix Infinity too
    // and prove nothing (CLAUDE.md §12).
    expect(lo).not.toBe(Infinity)
    expect(hi).not.toBe(-Infinity)
  })

  it('min/max still return the real extreme when the group has numeric cells', () => {
    const t = fromRows([
      { g: 'a', v: 7 },
      { g: 'a', v: 3 },
      { g: 'a', v: 11 },
    ])
    expect(groupBy(t, { by: ['g'], agg: { v: 'min' } }).col('v')[0]).toBe(3)
    expect(groupBy(t, { by: ['g'], agg: { v: 'max' } }).col('v')[0]).toBe(11)
  })

  it('min/max ignore the non-numeric cells in a MIXED group rather than giving up', () => {
    // The decoy for a fix that returns NaN whenever any cell is non-numeric
    // instead of only when none is: this group must still report 4 and 9.
    const t = fromRows([
      { g: 'm', v: 'N/A' },
      { g: 'm', v: 9 },
      { g: 'm', v: '-' },
      { g: 'm', v: 4 },
    ])
    expect(groupBy(t, { by: ['g'], agg: { v: 'min' } }).col('v')[0]).toBe(4)
    expect(groupBy(t, { by: ['g'], agg: { v: 'max' } }).col('v')[0]).toBe(9)
  })

  // ── blank cells are MISSING, not zero (#2378) ────────────────────────────
  //
  // `Number('')` and `Number(' ')` are both 0 per ECMAScript StringToNumber
  // (the empty/whitespace string converts to +0), so the plain `Number.isNaN`
  // guard in `aggregate` never fires for a blank cell and it was silently
  // counted as a real 0 — wrong for `min`/`max` (reports [0, 0] for an
  // all-blank group instead of the #2358 no-data sentinel) and numerically
  // wrong for `avg` (blanks inflated `n`). A blank cell must now be skipped
  // like 'N/A' or '-'.

  it('avg skips blank cells instead of counting them as 0', () => {
    // The arm that changes NUMERICALLY: if blanks still counted toward `n`,
    // avg([10, '', '']) would be 10/3, not 10.
    const t = fromRows([
      { g: 'a', v: 10 },
      { g: 'a', v: '' },
      { g: 'a', v: '' },
    ])
    expect(groupBy(t, { by: ['g'], agg: { v: 'avg' } }).col('v')[0]).toBe(10)
  })

  it('min/max over all-blank cells match all-N/A cells, both the #2358 sentinel', () => {
    const blanks = fromRows([
      { g: 'blank', v: '' },
      { g: 'blank', v: '' },
    ])
    const nas = fromRows([
      { g: 'na', v: 'N/A' },
      { g: 'na', v: 'N/A' },
    ])
    const blankMin = groupBy(blanks, { by: ['g'], agg: { v: 'min' } }).col('v')[0] as number
    const blankMax = groupBy(blanks, { by: ['g'], agg: { v: 'max' } }).col('v')[0] as number
    const naMin = groupBy(nas, { by: ['g'], agg: { v: 'min' } }).col('v')[0] as number
    const naMax = groupBy(nas, { by: ['g'], agg: { v: 'max' } }).col('v')[0] as number
    // NaN !== NaN, so "equal" is asserted via Number.isNaN on each side —
    // this is also the sentinel `aggregate` actually returns (see #2358 above).
    expect(Number.isNaN(blankMin)).toBe(true)
    expect(Number.isNaN(blankMax)).toBe(true)
    expect(Number.isNaN(naMin)).toBe(true)
    expect(Number.isNaN(naMax)).toBe(true)
  })

  it('a genuine 0 is still counted (control: the fix must not eat real zeros)', () => {
    const t = fromRows([
      { g: 'z', v: 0 },
      { g: 'z', v: 5 },
      { g: 'z', v: '' },
    ])
    expect(groupBy(t, { by: ['g'], agg: { v: 'min' } }).col('v')[0]).toBe(0)
    expect(groupBy(t, { by: ['g'], agg: { v: 'max' } }).col('v')[0]).toBe(5)
    expect(groupBy(t, { by: ['g'], agg: { v: 'avg' } }).col('v')[0]).toBe(2.5)
  })

  it('whitespace-only cells (space, tab) are treated as blank too', () => {
    const t = fromRows([
      { g: 'a', v: 10 },
      { g: 'a', v: ' ' },
      { g: 'a', v: '\t' },
    ])
    expect(groupBy(t, { by: ['g'], agg: { v: 'avg' } }).col('v')[0]).toBe(10)
    expect(groupBy(t, { by: ['g'], agg: { v: 'sum' } }).col('v')[0]).toBe(10)
  })

  it('count is unaffected by blanks — it counts rows, not numeric cells', () => {
    const t = fromRows([
      { g: 'a', v: 10 },
      { g: 'a', v: '' },
      { g: 'a', v: ' ' },
    ])
    expect(groupBy(t, { by: ['g'], agg: { v: 'count' } }).col('v')[0]).toBe(3)
  })

  it('the empty-group result is per group, not per column', () => {
    // A column where one group is all-non-numeric and another is numeric must
    // not let the broken group contaminate the healthy one.
    const t = fromRows([
      { g: 'bad', v: 'N/A' },
      { g: 'good', v: 5 },
    ])
    const out = groupBy(t, { by: ['g'], agg: { v: 'min' } })
    const gs = out.col('g') as string[]
    const vs = out.col('v') as number[]
    expect(Number.isNaN(vs[gs.indexOf('bad')]!)).toBe(true)
    expect(vs[gs.indexOf('good')]).toBe(5)
  })
})
