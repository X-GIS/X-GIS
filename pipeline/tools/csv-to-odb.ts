// ═══ csv-to-odb — offline OD CSV → .odb aggregator (node, zero npm) ═══
//
// Run BEFORE anything ships: raw origin-destination CSVs (수도권 생활이동 etc.)
// are 300MB+ of individual movement records that must never reach GitHub or a
// browser. This streams the raw CSV, aggregates to (origin, dest, hour) sums —
// the dominant compression, raw tens-of-millions of rows → a sparse tens-of-
// thousands — and encodes the result via the pipeline's `encodeODB`. The tiny
// .odb (KB) is what you commit / put on a CDN; the hero page fetches THAT.
//
// node builtins only (fs/readline/zlib) — no npm, mirroring @xgis/pipeline's
// zero-dep charter. This file is a devDep tool, excluded from the package build.
//
// Usage:
//   bun pipeline/tools/csv-to-odb.ts <input.csv> <output.odb> [options]
// Options (raw수도권생활이동 defaults; override for other schemas):
//   --origin=<col>    origin admin-code column name        (default: 출발_행정동_코드)
//   --dest=<col>      destination admin-code column name   (default: 도착_행정동_코드)
//   --hour=<col>      arrival-hour column name             (default: 도착_시간)
//   --pop=<col>       moving-population column name        (default: 이동인구_합)
//   --avgtime=<col>   mean travel-minutes column (optional)
//   --rollup=<n>      truncate admin codes to <n> chars    (e.g. 5 = 행정동→시군구)
//   --brotli          also write <output>.br (transport-compressed)
//
// The aggregation is what collapses 300MB → KB; the .odb encoding + brotli are
// the finishing 2–3×.

import { createReadStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { brotliCompressSync } from 'node:zlib'
import { encodeODB, type ODFlow } from '../src/odb/format'

interface Opts {
  origin: string
  dest: string
  hour: string
  pop: string
  avgtime?: string
  purpose?: string
  segment?: string
  rollup?: number
  brotli: boolean
  /** Keep only rows whose origin AND dest code start with one of these prefixes
   *  (post-rollup), e.g. 11,28,41 = 수도권 시·도. Shrinks 전국 → region. */
  region?: string[]
  /** Bucket the 24 hours into N buckets (e.g. 6 → 4-hour bands) to cut the hour
   *  cardinality while keeping a daily-pulse animation. */
  hourBucket?: number
  /** After aggregation, keep only the top-N flows by population (long-tail cut). */
  top?: number
}

function parseArgs(argv: string[]): { input: string; output: string; opts: Opts } {
  const positional: string[] = []
  const opts: Opts = {
    origin: '출발_행정동_코드',
    dest: '도착_행정동_코드',
    hour: '도착_시간',
    pop: '이동인구_합',
    brotli: false,
  }
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      if (k === 'brotli') opts.brotli = true
      else if (k === 'rollup') opts.rollup = Number(v)
      else if (k === 'hourbucket') opts.hourBucket = Number(v)
      else if (k === 'top') opts.top = Number(v)
      else if (k === 'region') opts.region = v!.split(',').map((s) => s.trim())
      else if (
        k === 'origin' ||
        k === 'dest' ||
        k === 'hour' ||
        k === 'pop' ||
        k === 'avgtime' ||
        k === 'purpose' ||
        k === 'segment'
      )
        opts[k] = v
    } else positional.push(a)
  }
  const [input, output] = positional
  if (!input || !output) {
    throw new Error('usage: csv-to-odb <input.csv> <output.odb> [--origin=… --rollup=5 --brotli]')
  }
  return { input, output, opts }
}

/** Split a CSV line honouring simple double-quotes (public OD exports are plain,
 *  but quoted 시도명 fields appear — don't split inside them). */
function splitCSV(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQ = !inQ
    else if (c === ',' && !inQ) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

const SEGMENT_MAP = new Map<string, number>([
  ['내국인', 0],
  ['단기외국인', 1],
  ['장기외국인', 2],
])

async function main(): Promise<void> {
  const { input, output, opts } = parseArgs(process.argv.slice(2))
  const roll = (code: string): string =>
    opts.rollup && code.length > opts.rollup ? code.slice(0, opts.rollup) : code
  const inRegion = (code: string): boolean =>
    !opts.region || opts.region.some((p) => code.startsWith(p))

  const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity })
  let header: string[] | null = null
  let iOrigin = -1
  let iDest = -1
  let iHour = -1
  let iPop = -1
  let iAvg = -1
  let iPurpose = -1
  let iSegment = -1

  // Aggregate: key = origin|dest|hour[|purpose|segment] → { pop, avgWeightedSum }.
  const agg = new Map<string, { pop: number; avgW: number }>()
  let rawRows = 0
  let unknownSegmentRows = 0
  let outOfRangePurposeRows = 0

  for await (const line of rl) {
    if (line.trim() === '') continue
    const cells = splitCSV(line)
    if (header === null) {
      header = cells.map((c) => c.trim())
      iOrigin = header.indexOf(opts.origin)
      iDest = header.indexOf(opts.dest)
      iHour = header.indexOf(opts.hour)
      iPop = header.indexOf(opts.pop)
      iAvg = opts.avgtime ? header.indexOf(opts.avgtime) : -1
      iPurpose = opts.purpose ? header.indexOf(opts.purpose) : -1
      iSegment = opts.segment ? header.indexOf(opts.segment) : -1
      for (const [name, idx] of [
        [opts.origin, iOrigin],
        [opts.dest, iDest],
        [opts.hour, iHour],
        [opts.pop, iPop],
      ] as const) {
        if (idx < 0) throw new Error(`column "${name}" not found in header: ${header.join(', ')}`)
      }
      continue
    }
    rawRows++
    const origin = roll(cells[iOrigin]!.trim())
    const dest = roll(cells[iDest]!.trim())
    // The hour column is MIXED: "HH" (2-digit hourly) OR "HHMM" (4-digit, 20-minute
    // buckets on commute hours 07-09/17-19, e.g. "0820"). Normalise to the hour (HH)
    // so it (a) fits u8 0-23 instead of overflowing (Number("0800")=800 → 800%256=32),
    // and (b) aggregates the 20-min sub-buckets into one hour for a clean daily pulse.
    const rawH = cells[iHour]!.trim()
    let hour = Number(rawH.length >= 4 ? rawH.slice(0, 2) : rawH)
    const pop = Number(cells[iPop]!.trim())
    if (!origin || !dest || !Number.isFinite(hour) || !Number.isFinite(pop)) continue
    if (!inRegion(origin) || !inRegion(dest)) continue // region filter (both endpoints)
    if (opts.hourBucket) hour = Math.floor((hour * opts.hourBucket) / 24) // bucket the day
    let purpose: number | undefined
    if (iPurpose >= 0) {
      const pRaw = Number(cells[iPurpose]!.trim())
      if (!Number.isFinite(pRaw) || pRaw < 1 || pRaw > 7) outOfRangePurposeRows++
      purpose = pRaw
    }
    let segment: number | undefined
    if (iSegment >= 0) {
      const mapped = SEGMENT_MAP.get(cells[iSegment]!.trim())
      if (mapped === undefined) unknownSegmentRows++
      segment = mapped ?? 0
    }
    const useDims = iPurpose >= 0 || iSegment >= 0
    const key = useDims
      ? `${origin}|${dest}|${hour}|${purpose ?? ''}|${segment ?? ''}`
      : `${origin}|${dest}|${hour}`
    let a = agg.get(key)
    if (!a) {
      a = { pop: 0, avgW: 0 }
      agg.set(key, a)
    }
    a.pop += pop
    if (iAvg >= 0) a.avgW += pop * Number(cells[iAvg]!.trim())
  }

  if (unknownSegmentRows > 0) {
    console.warn(
      `[csv-to-odb] ${unknownSegmentRows} rows had an unrecognized segment value → defaulted to 내국인 (0); check for NFD/2-value schema`,
    )
  }
  if (outOfRangePurposeRows > 0) {
    console.warn(
      `[csv-to-odb] ${outOfRangePurposeRows} rows had an out-of-range purpose value (expected 1–7) → value kept as-is; check source data`,
    )
  }

  let flows: ODFlow[] = []
  for (const [key, a] of agg) {
    const parts = key.split('|')
    const [origin, dest, hourStr] = parts
    const f: ODFlow = { origin: origin!, dest: dest!, hour: Number(hourStr), pop: a.pop }
    if (iAvg >= 0 && a.pop > 0) f.avgTime = a.avgW / a.pop
    const purposeStr = parts[3]
    const segmentStr = parts[4]
    if (iPurpose >= 0 && purposeStr !== undefined && purposeStr !== '')
      f.purpose = Number(purposeStr)
    if (iSegment >= 0 && segmentStr !== undefined && segmentStr !== '')
      f.segment = Number(segmentStr)
    flows.push(f)
  }
  if (opts.top && flows.length > opts.top) {
    flows.sort((a, b) => b.pop - a.pop) // keep the heaviest flows (long-tail cut)
    flows = flows.slice(0, opts.top)
  }

  const buf = encodeODB(flows)
  writeFileSync(output, Buffer.from(buf))
  let msg = `[csv-to-odb] ${rawRows} raw rows → ${flows.length} flows → ${output} (${(buf.byteLength / 1024).toFixed(1)}KB)`
  if (opts.brotli) {
    const br = brotliCompressSync(Buffer.from(buf))
    writeFileSync(output + '.br', br)
    msg += ` + ${output}.br (${(br.byteLength / 1024).toFixed(1)}KB brotli)`
  }
  console.log(msg)
}

void main()
