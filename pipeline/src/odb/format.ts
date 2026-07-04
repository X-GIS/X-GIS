// ═══ .odb — OD-flow Binary (X-GIS origin-destination flow payload) ═══
//
// A compact, self-describing columnar binary for AGGREGATED origin→destination
// flow data (수도권 생활이동 and the like). Raw public OD CSVs are 300MB+ of
// individual movement records; nobody should ship or fetch that. The offline
// tool (tools/csv-to-odb) aggregates raw records to (origin, dest, hour) sums
// and encodes them here — 300MB CSV collapses to ~100KB–1MB, small enough for a
// hero page to fetch and render immediately.
//
// Zero-dep by construction: DataView is a universal built-in, so BOTH encode
// (offline, in the node tool) and decode (runtime, in the browser) live here
// with no import — @xgis/pipeline stays a shared-only leaf.
//
// ── Layout (little-endian) ────────────────────────────────────────────────
//   magic     u32   "XODB" (0x42444f58 LE)
//   version   u16   = 1
//   flags     u16   bit0 = hasAvgTime
//   rowCount  u32   number of aggregated flows
//   dictCount u16   number of distinct admin codes (max 65535 — 시군구/행정동 fit)
//   dict      [ len:u8, utf8:len ] × dictCount   admin-code strings, index order
//   origin    u16 × rowCount    dict index of the origin code
//   dest      u16 × rowCount    dict index of the destination code
//   hour      u8  × rowCount    arrival hour 0–23 (255 = all-day / unbucketed)
//   pop       u32 × rowCount    summed moving population
//   avgTime   f32 × rowCount    (only if flags.hasAvgTime) mean travel minutes
//
// The dict stores CODES only; code→coordinate is the join step's gazetteer
// (kept out so one .odb is reusable across vintages/gazetteers).

export const ODB_MAGIC = 0x42444f58 // "XODB" little-endian
export const ODB_VERSION = 1
export const ODB_FLAG_AVGTIME = 0x0001
export const ODB_FLAG_PURPOSE = 0x0002
export const ODB_FLAG_SEGMENT = 0x0004
/** Segment codes for the 내국인/단기외국인/장기외국인 dimension (in_forn_div_nm). */
export const SEGMENT = { 내국인: 0, 단기외국인: 1, 장기외국인: 2 } as const
/** hour-column sentinel for "not bucketed / all-day" (NOT a dict index). */
export const ODB_HOUR_ALLDAY = 255

/** One aggregated origin→destination flow (the decoded row shape). */
export interface ODFlow {
  origin: string // admin code
  dest: string // admin code
  hour: number // 0–23, or ODB_HOUR_ALLDAY
  pop: number // summed population
  avgTime?: number // mean travel minutes (if the payload carries it)
  purpose?: number // move_purpose code 1–7 (if the payload carries it)
  segment?: number // SEGMENT value 0–2 (if the payload carries it)
}

/** Decoded payload: parallel typed columns + the code dictionary. Columns are
 *  the fast path (no per-row objects); `flow(i)` materialises one row lazily. */
export interface ODBData {
  readonly version: number
  readonly rowCount: number
  /** admin code strings, indexed by the origin/dest columns. */
  readonly dict: readonly string[]
  readonly origin: Uint16Array
  readonly dest: Uint16Array
  readonly hour: Uint8Array
  readonly pop: Uint32Array
  readonly avgTime: Float32Array | null
  readonly purpose: Uint8Array | null
  readonly segment: Uint8Array | null
  /** Materialise row i as an ODFlow (resolves dict codes). */
  flow(i: number): ODFlow
}

const HEADER_BYTES = 4 + 2 + 2 + 4 + 2 // magic+version+flags+rowCount+dictCount

/** Encode aggregated flows → an .odb ArrayBuffer. Pure + universal (the offline
 *  CSV tool calls this after it aggregates; kept here so encode/decode can never
 *  drift). `avgTime` is written only when EVERY row carries it. */
export function encodeODB(flows: readonly ODFlow[]): ArrayBuffer {
  const rowCount = flows.length
  const hasAvgTime = rowCount > 0 && flows.every((f) => f.avgTime !== undefined)
  const hasPurpose = rowCount > 0 && flows.every((f) => f.purpose !== undefined)
  const hasSegment = rowCount > 0 && flows.every((f) => f.segment !== undefined)

  // Build the code dictionary (first-seen order) + the index columns.
  const codeToIndex = new Map<string, number>()
  const dict: string[] = []
  const indexOf = (code: string): number => {
    let i = codeToIndex.get(code)
    if (i === undefined) {
      i = dict.length
      if (i > 0xffff) {
        throw new Error(
          `[.odb] more than 65535 distinct admin codes (${dict.length}) — u16 dict index overflow. ` +
            `Aggregate to a coarser admin level (시군구) or split the payload.`,
        )
      }
      dict.push(code)
      codeToIndex.set(code, i)
    }
    return i
  }
  const originIdx = new Uint16Array(rowCount)
  const destIdx = new Uint16Array(rowCount)
  for (let i = 0; i < rowCount; i++) {
    originIdx[i] = indexOf(flows[i]!.origin)
    destIdx[i] = indexOf(flows[i]!.dest)
  }

  // Dict byte size: [len:u8, utf8:len] per code. ASCII admin codes → 1 byte/char.
  const enc = new TextEncoder()
  const dictBytesArr = dict.map((c) => enc.encode(c))
  let dictBytes = 0
  for (const b of dictBytesArr) {
    if (b.length > 0xff) {
      throw new Error(`[.odb] admin code longer than 255 bytes: "${dict[dictBytesArr.indexOf(b)]}"`)
    }
    dictBytes += 1 + b.length
  }

  const colBytes =
    rowCount * (2 + 2 + 1 + 4 + (hasAvgTime ? 4 : 0) + (hasPurpose ? 1 : 0) + (hasSegment ? 1 : 0))
  const buf = new ArrayBuffer(HEADER_BYTES + dictBytes + colBytes)
  const view = new DataView(buf)
  let o = 0

  view.setUint32(o, ODB_MAGIC, true)
  o += 4
  view.setUint16(o, ODB_VERSION, true)
  o += 2
  view.setUint16(
    o,
    (hasAvgTime ? ODB_FLAG_AVGTIME : 0) |
      (hasPurpose ? ODB_FLAG_PURPOSE : 0) |
      (hasSegment ? ODB_FLAG_SEGMENT : 0),
    true,
  )
  o += 2
  view.setUint32(o, rowCount, true)
  o += 4
  view.setUint16(o, dict.length, true)
  o += 2

  const bytes = new Uint8Array(buf)
  for (const b of dictBytesArr) {
    view.setUint8(o, b.length)
    o += 1
    bytes.set(b, o)
    o += b.length
  }

  for (let i = 0; i < rowCount; i++) {
    view.setUint16(o, originIdx[i]!, true)
    o += 2
  }
  for (let i = 0; i < rowCount; i++) {
    view.setUint16(o, destIdx[i]!, true)
    o += 2
  }
  for (let i = 0; i < rowCount; i++) {
    const h = flows[i]!.hour
    view.setUint8(o, h)
    o += 1
  }
  for (let i = 0; i < rowCount; i++) {
    // pop is a count; clamp to u32 range (public totals never approach 4.29e9).
    view.setUint32(o, flows[i]!.pop >>> 0, true)
    o += 4
  }
  if (hasAvgTime) {
    for (let i = 0; i < rowCount; i++) {
      view.setFloat32(o, flows[i]!.avgTime!, true)
      o += 4
    }
  }
  if (hasPurpose) {
    for (let i = 0; i < rowCount; i++) {
      view.setUint8(o, flows[i]!.purpose!)
      o += 1
    }
  }
  if (hasSegment) {
    for (let i = 0; i < rowCount; i++) {
      view.setUint8(o, flows[i]!.segment!)
      o += 1
    }
  }
  return buf
}

/** Decode an .odb ArrayBuffer → columnar payload. Zero-copy typed columns where
 *  alignment permits; throws a loud, source-attributable error on a bad magic /
 *  truncated buffer (never a silent mis-parse). */
export function decodeODB(buf: ArrayBuffer): ODBData {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`[.odb] buffer too small (${buf.byteLength} bytes) — not an .odb payload`)
  }
  const view = new DataView(buf)
  let o = 0
  const magic = view.getUint32(o, true)
  o += 4
  if (magic !== ODB_MAGIC) {
    throw new Error(
      `[.odb] bad magic 0x${magic.toString(16)} (expected 0x${ODB_MAGIC.toString(16)} "XODB") — ` +
        `wrong file, or not an .odb payload`,
    )
  }
  const version = view.getUint16(o, true)
  o += 2
  if (version !== ODB_VERSION) {
    throw new Error(`[.odb] unsupported version ${version} (this build reads v${ODB_VERSION})`)
  }
  const flags = view.getUint16(o, true)
  o += 2
  const rowCount = view.getUint32(o, true)
  o += 4
  const dictCount = view.getUint16(o, true)
  o += 2

  const dec = new TextDecoder()
  const bytes = new Uint8Array(buf)
  const dict: string[] = new Array(dictCount)
  for (let i = 0; i < dictCount; i++) {
    const len = view.getUint8(o)
    o += 1
    if (o + len > buf.byteLength) throw new Error(`[.odb] truncated dict at code ${i}`)
    dict[i] = dec.decode(bytes.subarray(o, o + len))
    o += len
  }

  const hasAvgTime = (flags & ODB_FLAG_AVGTIME) !== 0
  const hasPurpose = (flags & ODB_FLAG_PURPOSE) !== 0
  const hasSegment = (flags & ODB_FLAG_SEGMENT) !== 0
  const need =
    rowCount * (2 + 2 + 1 + 4 + (hasAvgTime ? 4 : 0) + (hasPurpose ? 1 : 0) + (hasSegment ? 1 : 0))
  if (o + need > buf.byteLength) {
    throw new Error(`[.odb] truncated columns: need ${need} bytes, have ${buf.byteLength - o}`)
  }

  // Copy each column into its own typed array — NOT a zero-copy subarray view,
  // for two reasons: (1) alignment — a column's byteOffset is `14 + dictBytes +
  // k*rowCount`, data-dependent, so `new Uint32Array(buf, o, n)` can hit a
  // non-multiple-of-4 offset and throw RangeError; (2) endianness — the format is
  // little-endian, but a typed-array view reads in HOST byte order, so a view would
  // byte-swap on a big-endian host. `DataView(.., true)` is endian-safe. The four
  // loops read four DISJOINT regions — one linear pass total, no re-walk.
  const origin = new Uint16Array(rowCount)
  for (let i = 0; i < rowCount; i++, o += 2) origin[i] = view.getUint16(o, true)
  const dest = new Uint16Array(rowCount)
  for (let i = 0; i < rowCount; i++, o += 2) dest[i] = view.getUint16(o, true)
  const hour = new Uint8Array(rowCount)
  for (let i = 0; i < rowCount; i++, o += 1) hour[i] = view.getUint8(o)
  const pop = new Uint32Array(rowCount)
  for (let i = 0; i < rowCount; i++, o += 4) pop[i] = view.getUint32(o, true)
  let avgTime: Float32Array | null = null
  if (hasAvgTime) {
    avgTime = new Float32Array(rowCount)
    for (let i = 0; i < rowCount; i++, o += 4) avgTime[i] = view.getFloat32(o, true)
  }
  let purpose: Uint8Array | null = null
  if (hasPurpose) {
    purpose = new Uint8Array(rowCount)
    for (let i = 0; i < rowCount; i++, o += 1) purpose[i] = view.getUint8(o)
  }
  let segment: Uint8Array | null = null
  if (hasSegment) {
    segment = new Uint8Array(rowCount)
    for (let i = 0; i < rowCount; i++, o += 1) segment[i] = view.getUint8(o)
  }

  return {
    version,
    rowCount,
    dict,
    origin,
    dest,
    hour,
    pop,
    avgTime,
    purpose,
    segment,
    flow(i: number): ODFlow {
      const f: ODFlow = {
        origin: dict[origin[i]!]!,
        dest: dict[dest[i]!]!,
        hour: hour[i]!,
        pop: pop[i]!,
      }
      if (avgTime) f.avgTime = avgTime[i]!
      if (purpose) f.purpose = purpose[i]!
      if (segment) f.segment = segment[i]!
      return f
    },
  }
}
