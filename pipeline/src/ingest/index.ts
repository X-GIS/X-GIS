// ═══ @xgis/pipeline · ingest — raw text/rows → Table ═══
//
// I/O is the HOST's (the package never touches fs/fetch — mirrors the compiler
// `module` resolver's injection rule), so `fromCSV` takes already-read text.
// A `vintage` (+ optional code `system`) is stamped so the join can check it.

import { ColumnarTable, type Cell, type Table } from '../core/table'

/** Build a table from parsed rows (objects). Union of all keys = columns; a row
 *  missing a key gets '' so columns stay rectangular. */
export function fromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: { vintage?: string; system?: string } = {},
): Table {
  const cols = new Map<string, Cell[]>()
  const names = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) names.add(k)
  for (const name of names) cols.set(name, [])
  for (const r of rows) {
    for (const name of names) {
      const v = r[name]
      cols.get(name)!.push(typeof v === 'number' ? v : v == null ? '' : String(v))
    }
  }
  return new ColumnarTable(cols, opts.vintage, opts.system)
}

/** Parse CSV/TSV text the host already read. Numeric-looking cells become numbers
 *  unless `types` pins a column to 'string'. First row = header. */
export function fromCSV(
  text: string,
  opts: {
    delimiter?: string
    types?: Record<string, 'number' | 'string'>
    vintage?: string
    system?: string
  } = {},
): Table {
  const delim = opts.delimiter ?? (text.includes('\t') && !text.includes(',') ? '\t' : ',')
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return new ColumnarTable(new Map(), opts.vintage, opts.system)
  const header = lines[0]!.split(delim).map((h) => h.trim())
  const cols = new Map<string, Cell[]>()
  for (const h of header) cols.set(h, [])
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r]!.split(delim)
    for (let c = 0; c < header.length; c++) {
      const name = header[c]!
      const raw = (cells[c] ?? '').trim()
      const forced = opts.types?.[name]
      let v: Cell
      if (forced === 'string') v = raw
      else if (forced === 'number') v = Number(raw)
      else v = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw
      cols.get(name)!.push(v)
    }
  }
  return new ColumnarTable(cols, opts.vintage, opts.system)
}
