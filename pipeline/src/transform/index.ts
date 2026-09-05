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
    const raw = col[i]
    // A blank cell ('' or whitespace-only, e.g. an empty CSV field) must be
    // treated as MISSING, not as zero. `Number('')` and `Number(' ')` are both
    // +0 per the ECMAScript StringToNumber grammar (the empty/whitespace
    // string converts to +0), so the `Number.isNaN` guard below never fires
    // for a blank cell and it would otherwise be silently counted as a real
    // 0. This check runs on the raw cell (before the numeric coercion) so a
    // genuine numeric 0 — `number` 0, or the string '0' — is unaffected.
    if (typeof raw === 'string' && raw.trim() === '') continue
    const v = Number(raw)
    if (Number.isNaN(v)) continue
    n++
    if (kind === 'sum' || kind === 'avg') acc += v
    else if (kind === 'min') acc = Math.min(acc, v)
    else if (kind === 'max') acc = Math.max(acc, v)
  }
  if (kind === 'avg' && n > 0) return acc / n
  // min/max seed with +/-Infinity, so a group whose cells are ALL non-numeric
  // ('N/A', '-', '' — ordinary in ingested CSV) skips every row above and
  // returns the untouched seed. Infinity reaching a Table column is worse than
  // it looks: it is a plausible-shaped extreme, so a downstream domain/scale
  // computation consumes it silently rather than rejecting it.
  //
  // #2409 — `avg` joins them, and its old answer was worse still: it returned
  // 0, which is not merely plausible but INDISTINGUISHABLE from a group that
  // genuinely averages to zero, and passes every `Number.isFinite` caller
  // guard. `sum` deliberately stays out: the empty sum really is 0 (the
  // additive identity), whereas the mean of nothing is undefined.
  //
  // NaN is the sentinel because `aggregate` returns `number` (Cell is
  // `number | string`), so there is no out-of-band value available, and of the
  // in-band candidates NaN is the only one that cannot be mistaken for real
  // data — 0 is a legitimate min. It also matches the `Number.isNaN` skip this
  // function already uses to mean "not numeric". Callers test with
  // `Number.isFinite`, which rejects both the old and the new value; what
  // changes is that NaN cannot be silently arithmetic'd into a plausible result.
  if ((kind === 'min' || kind === 'max' || kind === 'avg') && n === 0) return NaN
  return acc
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
