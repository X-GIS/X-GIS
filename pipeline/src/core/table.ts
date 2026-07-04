// ═══ @xgis/pipeline · core — the Table model ═══
//
// The columnar tabular value every pipeline stage passes along. Columnar so a
// 100k-row public-data file stays a handful of arrays, not 100k objects. Carries
// two provenance tags the join needs: `vintage` (admin boundaries drift yearly)
// and `system` (the standard code system of the code column). Pure data model —
// ingest builds it (ingest/), transforms return new ones (transform/).

export type Cell = number | string

export interface Table {
  readonly columns: readonly string[]
  readonly length: number
  /** Data vintage (e.g. '2023') — compared to the gazetteer's at join time. */
  readonly vintage?: string
  /** Declared standard code system of the code column(s), e.g. 'KR:ADMCD',
   *  'US:FIPS', 'ISO3166-2'. When set, the join asserts it matches the gazetteer's
   *  so a wrong-system code fails loud instead of resolving to the wrong place. */
  readonly system?: string
  /** A column's values, in row order. */
  col(name: string): readonly Cell[]
  /** One row as a plain object (for predicates / encoders). */
  row(i: number): Record<string, Cell>
}

/** Concrete columnar table. Columns are parallel arrays keyed by name. */
export class ColumnarTable implements Table {
  readonly columns: readonly string[]
  readonly length: number
  readonly vintage?: string
  readonly system?: string
  private readonly data: ReadonlyMap<string, readonly Cell[]>

  constructor(data: Map<string, readonly Cell[]>, vintage?: string, system?: string) {
    this.columns = [...data.keys()]
    this.data = data
    // Length = the longest column (all should match; ingest guarantees it).
    let n = 0
    for (const c of data.values()) n = Math.max(n, c.length)
    this.length = n
    this.vintage = vintage
    this.system = system
  }

  col(name: string): readonly Cell[] {
    const c = this.data.get(name)
    if (c === undefined) {
      throw new Error(
        `[@xgis/pipeline] no column "${name}"; available: ${this.columns.join(', ') || '(none)'}`,
      )
    }
    return c
  }

  row(i: number): Record<string, Cell> {
    const out: Record<string, Cell> = {}
    for (const name of this.columns) out[name] = this.data.get(name)![i]!
    return out
  }
}
