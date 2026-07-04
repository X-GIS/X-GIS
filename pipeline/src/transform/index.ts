// ═══ @xgis/pipeline · transform — pure Table → Table ops ═══
//
// The right-sized geo-viz subset of dataframe operations: equality-select, a
// predicate filter, and group-by aggregation. Every op returns a NEW Table (no
// mutation), so the whole package is deterministic + unit-testable.

import { ColumnarTable, type Cell, type Table } from '../core/table'

/** Keep rows selected by exact-equality on the given columns. NOT `slice` (that
 *  means index-range in JS). */
export function where(t: Table, eq: Record<string, Cell>): Table {
  const keys = Object.keys(eq)
  const keep: number[] = []
  for (let i = 0; i < t.length; i++) {
    let ok = true
    for (const k of keys) {
      if (t.col(k)[i] !== eq[k]) {
        ok = false
        break
      }
    }
    if (ok) keep.push(i)
  }
  return selectRows(t, keep)
}

/** Keep rows a predicate accepts (the escape hatch when `where` is too coarse). */
export function filter(t: Table, pred: (row: Record<string, Cell>) => boolean): Table {
  const keep: number[] = []
  for (let i = 0; i < t.length; i++) if (pred(t.row(i))) keep.push(i)
  return selectRows(t, keep)
}

export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max'

/** Group rows by `by` columns and aggregate the named value columns. Output
 *  columns = the `by` keys + the aggregated columns (same names). */
export function groupBy(t: Table, o: { by: string[]; agg: Record<string, Agg> }): Table {
  const aggCols = Object.keys(o.agg)
  const groups = new Map<string, { keyVals: Cell[]; rows: number[] }>()
  for (let i = 0; i < t.length; i++) {
    const keyVals = o.by.map((b) => t.col(b)[i]!)
    const key = keyVals.join(' ')
    let g = groups.get(key)
    if (!g) {
      g = { keyVals, rows: [] }
      groups.set(key, g)
    }
    g.rows.push(i)
  }
  const out = new Map<string, Cell[]>()
  for (const b of o.by) out.set(b, [])
  for (const a of aggCols) out.set(a, [])
  for (const g of groups.values()) {
    for (let k = 0; k < o.by.length; k++) out.get(o.by[k]!)!.push(g.keyVals[k]!)
    for (const a of aggCols) out.get(a)!.push(aggregate(t.col(a), g.rows, o.agg[a]!))
  }
  return new ColumnarTable(out, t.vintage, t.system)
}

function aggregate(col: readonly Cell[], rows: readonly number[], kind: Agg): number {
  if (kind === 'count') return rows.length
  let acc = kind === 'min' ? Infinity : kind === 'max' ? -Infinity : 0
  let n = 0
  for (const i of rows) {
    const v = Number(col[i])
    if (Number.isNaN(v)) continue
    n++
    if (kind === 'sum' || kind === 'avg') acc += v
    else if (kind === 'min') acc = Math.min(acc, v)
    else if (kind === 'max') acc = Math.max(acc, v)
  }
  return kind === 'avg' ? (n > 0 ? acc / n : 0) : acc
}

/** Materialise a row subset into a fresh columnar table (shared by where/filter). */
export function selectRows(t: Table, rows: readonly number[]): Table {
  const out = new Map<string, Cell[]>()
  for (const name of t.columns) {
    const src = t.col(name)
    out.set(
      name,
      rows.map((i) => src[i]!),
    )
  }
  return new ColumnarTable(out, t.vintage, t.system)
}
