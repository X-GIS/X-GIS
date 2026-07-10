// ═══ @xgis/pipeline · ingest/seoul-openapi — 서울 열린데이터광장 open-API client ═══
//
// The pure, host-I/O-free half of the offline bake tool (tools/seoul-openapi-bake).
// data.seoul.go.kr serves its datasets over a UNIFORM paginated JSON protocol —
// same URL grammar, same envelope, same RESULT codes for every dataset (OA-22300
// 생활이동 and the rest) — so this module encodes that PROTOCOL once, generically,
// and the CLI feeds it a dataset's field mapping. A browser can't call the API
// (http:8088 mixed-content on https Pages + no CORS + it would leak the key), so
// the fetch happens offline here and only the tiny aggregated .odb is committed.
//
// Mirroring ingest/'s charter, the package never touches fetch itself: the pager
// takes an injected `fetchPage`, so this file is network-free and unit-testable
// with local fixtures (the compiler `module` resolver's injection rule again).
//
// ── data.seoul.go.kr protocol ──────────────────────────────────────────────
//   URL   {base}/{KEY}/{TYPE}/{SERVICE}/{START}/{END}[/{arg}…]   (1-based, inclusive)
//   page  END-START+1 ≤ 1000 rows per request (SEOUL_PAGE_MAX)
//   body  { "<SERVICE>": { list_total_count, RESULT:{CODE,MESSAGE}, row:[…] } }
//         auth failures instead arrive un-wrapped as a top-level { RESULT:{…} }.

import { type ODFlow, SEGMENT, ODB_HOUR_ALLDAY } from '../odb/format'

export const SEOUL_OPENAPI_BASE = 'http://openapi.seoul.go.kr:8088'
/** Hard per-request row cap the API enforces (ERROR-336 past it). */
export const SEOUL_PAGE_MAX = 1000

// ── Result-code taxonomy ────────────────────────────────────────────────────
// The documented data.seoul.go.kr codes, folded into the few classes the pager
// actually branches on. Only `ok` continues; `empty` ends pagination cleanly;
// everything else is a loud, distinct failure (auth vs quota vs the rest).
export type ResultClass =
  | 'ok' // INFO-000 정상
  | 'empty' // INFO-200 해당하는 데이터가 없습니다 → end of pages
  | 'authError' // INFO-100 인증키가 유효하지 않습니다
  | 'quotaExceeded' // ERROR-337 일별 요청 제한 초과
  | 'rangeError' // ERROR-336 한번에 1,000건 초과
  | 'badRequest' // ERROR-3xx 필수값 누락 / 위치값 오류 / 서비스 없음
  | 'serverError' // ERROR-500/600/601 (+ any unknown code — fail loud, never guess)

const RESULT_CLASS: Readonly<Record<string, ResultClass>> = {
  'INFO-000': 'ok',
  'INFO-200': 'empty',
  'INFO-100': 'authError',
  'ERROR-337': 'quotaExceeded',
  'ERROR-336': 'rangeError',
}

/** Classify a data.seoul.go.kr RESULT.CODE. Known ERROR-3xx (bad request family)
 *  map to `badRequest`; every other/unknown code fails loud as `serverError`. */
export function classifyResult(code: string): ResultClass {
  const known = RESULT_CLASS[code]
  if (known) return known
  // ERROR-300…335: missing/invalid required value, bad start/end, unknown service.
  if (/^ERROR-3\d\d$/.test(code)) return 'badRequest'
  return 'serverError'
}

/** One decoded page: the total row count (for pagination) + this page's raw rows. */
export interface SeoulPage {
  readonly total: number
  readonly rows: ReadonlyArray<Record<string, unknown>>
  readonly code: string
  readonly message: string
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

/** Decode one API response into a {@link SeoulPage}. Finds the `<SERVICE>` envelope
 *  (or the un-wrapped top-level RESULT auth failures use), classifies the RESULT
 *  code, and THROWS a source-attributable error on any fatal class — never the URL
 *  or key in the message. `ok`/`empty` return normally so the pager can branch. */
export function parsePage(json: unknown, service: string): SeoulPage {
  const root = asObject(json)
  if (!root) throw new Error(`[seoul-openapi] ${service}: response was not a JSON object`)
  const envelope = asObject(root[service]) ?? root
  const result = asObject(envelope['RESULT']) ?? asObject(root['RESULT'])
  const code = typeof result?.['CODE'] === 'string' ? (result['CODE'] as string) : ''
  const message = typeof result?.['MESSAGE'] === 'string' ? (result['MESSAGE'] as string) : ''

  const rawRow = envelope['row']
  const rows: Record<string, unknown>[] = Array.isArray(rawRow)
    ? (rawRow.filter((r) => asObject(r) !== null) as Record<string, unknown>[])
    : asObject(rawRow)
      ? [rawRow as Record<string, unknown>]
      : []

  // A missing RESULT (some services omit it) is judged by payload: rows ⇒ ok.
  const cls = code ? classifyResult(code) : rows.length > 0 ? 'ok' : 'empty'
  if (cls !== 'ok' && cls !== 'empty') {
    throw new Error(
      `[seoul-openapi] ${service}: ${cls} (${code || 'no RESULT.CODE'}) — ${message || 'no message'}`,
    )
  }

  const total = Number(envelope['list_total_count'])
  return { total: Number.isFinite(total) ? total : 0, rows, code, message }
}

/** Build the path-style request URL. The key is a PATH SEGMENT (percent-encoded);
 *  never build this for logging — pass the result through {@link redactKey} first. */
export function buildPageUrl(o: {
  key: string
  service: string
  start: number
  end: number
  type?: string
  base?: string
  /** Extra trailing path args some datasets require (e.g. a date), in order. */
  args?: readonly string[]
}): string {
  const base = o.base ?? SEOUL_OPENAPI_BASE
  const seg = [
    encodeURIComponent(o.key),
    o.type ?? 'json',
    o.service,
    String(o.start),
    String(o.end),
    ...(o.args ?? []).map(encodeURIComponent),
  ]
  return `${base}/${seg.join('/')}`
}

/** Mask the API key wherever it appears (raw or percent-encoded) so a URL is safe
 *  to log. The key lives in the URL PATH, so a bare `console.log(url)` would leak
 *  it — always redact first. */
export function redactKey(text: string, key: string): string {
  if (!key) return text
  return text.split(key).join('***').split(encodeURIComponent(key)).join('***')
}

/** Fetch a page: given a 1-based inclusive [start,end] range, resolve the parsed
 *  JSON body (the CLI supplies a `fetch`-backed one; tests supply a fixture). */
export type FetchPage = (start: number, end: number) => Promise<unknown>

/** Walk every page of a service and collect the raw rows. Stops on ANY of three
 *  last-page signals — an `empty` (INFO-200) page, a short page (fewer rows than
 *  requested), or having reached `list_total_count` — so a dataset whose length is
 *  an exact multiple of the page size costs no wasted trailing request. Fatal
 *  RESULT codes (auth/quota/…) propagate out of {@link parsePage}. */
export async function fetchAllRows(o: {
  fetchPage: FetchPage
  service: string
  /** Rows per request; clamped to [1, {@link SEOUL_PAGE_MAX}]. Default = the max. */
  pageSize?: number
  /** Stop once this many rows are collected (long-tail cap for a small fixture). */
  maxRows?: number
  onPage?: (info: { start: number; end: number; total: number; received: number }) => void
}): Promise<Record<string, unknown>[]> {
  const pageSize = Math.max(1, Math.min(o.pageSize ?? SEOUL_PAGE_MAX, SEOUL_PAGE_MAX))
  const all: Record<string, unknown>[] = []
  let start = 1
  let total = Number.POSITIVE_INFINITY // unknown until the first page reports it

  while (start <= total) {
    const end = start + pageSize - 1
    const page = parsePage(await o.fetchPage(start, end), o.service)
    o.onPage?.({ start, end, total: page.total, received: page.rows.length })
    if (page.rows.length === 0) break // empty / INFO-200 → past the end
    if (page.total > 0) total = page.total
    for (const r of page.rows) all.push(r)
    if (o.maxRows !== undefined && all.length >= o.maxRows) {
      all.length = o.maxRows
      break
    }
    if (page.rows.length < pageSize) break // short page = last page
    if (page.total > 0 && start + page.rows.length - 1 >= page.total) break // reached total
    start = end + 1
  }
  return all
}

// ── Normalize / join (admin name ↔ standard code) ───────────────────────────
// Public rows key a district by a standard CODE, a NAME, or both. The .odb dict
// stores CODES only, so a name-only row must be resolved to its code — the issue's
// "join by name/code". The reverse name→code table is built from the caller's
// gazetteer entries (kept country-generic: the CLI passes 서울 자치구).

/** NFC-fold, trim, and collapse internal whitespace so '  강남구 ' and a NFD-composed
 *  '강남구' key the same bucket. */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ')
}

/** Map normalized admin name → standard code, from a gazetteer's entries. */
export function buildNameToCode(
  entries: ReadonlyArray<{ code: string; name: string }>,
): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of entries) m.set(normalizeName(e.name), e.code)
  return m
}

/** Resolve a row's origin/destination to a standard code: trust an explicit code,
 *  else fall back to a name→code lookup. Returns null when neither resolves (the
 *  row is dropped upstream). Codes are trusted as-is (행정동 8-digit codes are NOT
 *  in a 시군구 gazetteer, so validating against it would wrongly drop them). */
export function resolveCode(
  rawCode: unknown,
  rawName: unknown,
  nameToCode: ReadonlyMap<string, string>,
): string | null {
  const code = rawCode == null ? '' : String(rawCode).trim()
  if (code) return code
  const name = rawName == null ? '' : normalizeName(String(rawName))
  if (name) return nameToCode.get(name) ?? null
  return null
}

// ── Rows → aggregated ODFlow[] (ready for encodeODB) ────────────────────────

/** Field mapping from a dataset's JSON keys to the OD dimensions. `pop` is the
 *  only required column; origin/dest accept a code field, a name field, or both. */
export interface FlowFieldMap {
  originCode?: string
  originName?: string
  destCode?: string
  destName?: string
  /** Arrival-hour field. Omit for an all-day aggregate ({@link ODB_HOUR_ALLDAY}). */
  hour?: string
  pop: string
  avgTime?: string
  purpose?: string
  segment?: string
}

/** Aggregation controls (mirrors the csv-to-odb knobs so both paths bake the same
 *  fixture shape). */
export interface AggregateOpts {
  /** Truncate admin codes to N chars post-resolve (5 = 행정동→시군구). */
  rollup?: number
  /** Keep only flows whose BOTH endpoints start with one of these code prefixes. */
  region?: readonly string[]
  /** Bucket the 24h into N bands (6 → 4-hour bands) to cut hour cardinality. */
  hourBucket?: number
  /** After aggregation keep only the top-N flows by population (long-tail cut). */
  top?: number
  /** Gazetteer entries for the name→code join (name-only rows). */
  districts?: ReadonlyArray<{ code: string; name: string }>
}

/** Parse the arrival-hour cell. The 생활이동 hour column is MIXED — "HH" hourly or
 *  "HHMM" 20-minute commute buckets ("0820") — so keep the leading HH, matching
 *  csv-to-odb (Number("0800") would be 800 and overflow the u8). */
function parseHour(raw: unknown): number {
  const s = String(raw).trim()
  return Number(s.length >= 4 ? s.slice(0, 2) : s)
}

/** Normalize + aggregate raw API rows into `(origin, dest, hour[, purpose, segment])`
 *  sums — the compression that makes the .odb tiny — returning ODFlow[] ready for
 *  `encodeODB` (the single encode authority; this never touches bytes). */
export function rowsToFlows(
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: FlowFieldMap,
  opts: AggregateOpts = {},
): ODFlow[] {
  const nameToCode = buildNameToCode(opts.districts ?? [])
  const roll = (c: string): string =>
    opts.rollup && c.length > opts.rollup ? c.slice(0, opts.rollup) : c
  const inRegion = (c: string): boolean => !opts.region || opts.region.some((p) => c.startsWith(p))
  const useHour = fields.hour !== undefined
  const useAvg = fields.avgTime !== undefined
  const usePurpose = fields.purpose !== undefined
  const useSegment = fields.segment !== undefined
  const useDims = usePurpose || useSegment

  const agg = new Map<string, { pop: number; avgW: number }>()
  for (const r of rows) {
    const o = resolveCode(
      fields.originCode ? r[fields.originCode] : null,
      fields.originName ? r[fields.originName] : null,
      nameToCode,
    )
    const d = resolveCode(
      fields.destCode ? r[fields.destCode] : null,
      fields.destName ? r[fields.destName] : null,
      nameToCode,
    )
    if (!o || !d) continue
    const origin = roll(o)
    const dest = roll(d)
    if (!inRegion(origin) || !inRegion(dest)) continue
    let hour = useHour ? parseHour(r[fields.hour!]) : ODB_HOUR_ALLDAY
    const pop = Number(r[fields.pop])
    if (!Number.isFinite(hour) || !Number.isFinite(pop)) continue
    if (useHour && opts.hourBucket) hour = Math.floor((hour * opts.hourBucket) / 24)
    let purpose: number | undefined
    if (usePurpose) purpose = Number(r[fields.purpose!])
    let segment: number | undefined
    if (useSegment) {
      const raw = r[fields.segment!]
      const mapped = SEGMENT[normalizeName(String(raw)) as keyof typeof SEGMENT]
      segment = typeof raw === 'number' ? raw : (mapped ?? 0)
    }
    const key = useDims
      ? `${origin}|${dest}|${hour}|${purpose ?? ''}|${segment ?? ''}`
      : `${origin}|${dest}|${hour}`
    let a = agg.get(key)
    if (!a) {
      a = { pop: 0, avgW: 0 }
      agg.set(key, a)
    }
    a.pop += pop
    if (useAvg) a.avgW += pop * Number(r[fields.avgTime!])
  }

  let flows: ODFlow[] = []
  for (const [key, a] of agg) {
    const [origin, dest, hourStr, purposeStr, segmentStr] = key.split('|')
    const f: ODFlow = { origin: origin!, dest: dest!, hour: Number(hourStr), pop: a.pop }
    if (useAvg && a.pop > 0) f.avgTime = a.avgW / a.pop
    if (usePurpose && purposeStr) f.purpose = Number(purposeStr)
    if (useSegment && segmentStr) f.segment = Number(segmentStr)
    flows.push(f)
  }
  if (opts.top && flows.length > opts.top) {
    flows.sort((a, b) => b.pop - a.pop) // keep the heaviest flows (long-tail cut)
    flows = flows.slice(0, opts.top)
  }
  return flows
}
