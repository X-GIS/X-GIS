import { describe, it, expect } from 'vitest'
import {
  SEOUL_OPENAPI_BASE,
  classifyResult,
  parsePage,
  buildPageUrl,
  redactKey,
  fetchAllRows,
  normalizeName,
  buildNameToCode,
  resolveCode,
  rowsToFlows,
  type FetchPage,
} from './seoul-openapi'
import { decodeODB, encodeODB, ODB_HOUR_ALLDAY } from '../odb/format'

// ── Local API fixtures (no network) ─────────────────────────────────────────
const SERVICE = 'OA22300'

/** A success envelope for [start,end] over a synthetic `total`-row dataset. Each
 *  row is `{ o, d, h, pop }`; ids are the global 1-based row index so a test can
 *  assert the collected set is exact + de-duplicated across pages. */
function pageOf(total: number, start: number, end: number): unknown {
  const rows: Record<string, unknown>[] = []
  for (let i = start; i <= Math.min(end, total); i++) {
    rows.push({ o: '11110', d: '11680', h: String((i - 1) % 24), pop: i, id: i })
  }
  return {
    [SERVICE]: {
      list_total_count: total,
      RESULT: { CODE: 'INFO-000', MESSAGE: '정상 처리되었습니다' },
      row: rows,
    },
  }
}

/** An error/quota envelope (top-level RESULT, as auth failures actually arrive). */
function errorPage(code: string, message = ''): unknown {
  return { RESULT: { CODE: code, MESSAGE: message } }
}

/** Wrap a page producer so the test can assert the exact ranges requested. */
function recordingFetch(produce: (start: number, end: number) => unknown): {
  fetchPage: FetchPage
  calls: Array<[number, number]>
} {
  const calls: Array<[number, number]> = []
  const fetchPage: FetchPage = (start, end) => {
    calls.push([start, end])
    return Promise.resolve(produce(start, end))
  }
  return { fetchPage, calls }
}

describe('@xgis/pipeline · ingest/seoul-openapi · protocol', () => {
  it('classifies the documented RESULT codes (auth/quota/range/empty/ok)', () => {
    expect(classifyResult('INFO-000')).toBe('ok')
    expect(classifyResult('INFO-200')).toBe('empty')
    expect(classifyResult('INFO-100')).toBe('authError')
    expect(classifyResult('ERROR-337')).toBe('quotaExceeded')
    expect(classifyResult('ERROR-336')).toBe('rangeError')
    expect(classifyResult('ERROR-310')).toBe('badRequest') // unknown service
    expect(classifyResult('ERROR-500')).toBe('serverError')
    expect(classifyResult('WAT-999')).toBe('serverError') // unknown → fail loud
  })

  it('parsePage reads the service-wrapped envelope (total + rows)', () => {
    const page = parsePage(pageOf(5, 1, 2), SERVICE)
    expect(page.total).toBe(5)
    expect(page.rows.length).toBe(2)
    expect(page.code).toBe('INFO-000')
    expect(page.rows[0]).toMatchObject({ o: '11110', id: 1 })
  })

  it('parsePage coerces a single-object `row` into a one-element array', () => {
    const single = {
      [SERVICE]: { list_total_count: 1, RESULT: { CODE: 'INFO-000' }, row: { o: '1', d: '2' } },
    }
    expect(parsePage(single, SERVICE).rows).toHaveLength(1)
  })

  it('parsePage throws a redaction-safe error on auth + quota codes', () => {
    expect(() => parsePage(errorPage('INFO-100', '인증키가 유효하지 않습니다.'), SERVICE)).toThrow(
      /authError/,
    )
    expect(() => parsePage(errorPage('ERROR-337', '일별 트래픽 제한 초과'), SERVICE)).toThrow(
      /quotaExceeded/,
    )
  })

  it('buildPageUrl lays out {base}/{key}/{type}/{service}/{start}/{end}[/args]', () => {
    const url = buildPageUrl({ key: 'SECRET', service: SERVICE, start: 1, end: 1000 })
    expect(url).toBe(`${SEOUL_OPENAPI_BASE}/SECRET/json/${SERVICE}/1/1000`)
    const withArgs = buildPageUrl({
      key: 'SECRET',
      service: SERVICE,
      start: 1,
      end: 5,
      args: ['202401'],
    })
    expect(withArgs.endsWith('/1/5/202401')).toBe(true)
  })

  it('redactKey masks the key (raw + percent-encoded) so a URL is safe to log', () => {
    const key = 'a b/secret+key'
    const url = buildPageUrl({ key, service: SERVICE, start: 1, end: 5 })
    const safe = redactKey(url, key)
    expect(safe).not.toContain('secret')
    expect(safe).not.toContain(encodeURIComponent(key))
    expect(safe).toContain('***')
  })
})

describe('@xgis/pipeline · ingest/seoul-openapi · pagination', () => {
  it('walks multiple pages and stops on a SHORT last page', async () => {
    const { fetchPage, calls } = recordingFetch((s, e) => pageOf(5, s, e))
    const rows = await fetchAllRows({ fetchPage, service: SERVICE, pageSize: 2 })
    expect(rows.map((r) => r['id'])).toEqual([1, 2, 3, 4, 5]) // every row, once
    expect(calls).toEqual([
      [1, 2],
      [3, 4],
      [5, 6], // 1 row (< pageSize) → short-page stop
    ])
  })

  it('stops at list_total_count on an EXACT multiple — no wasted trailing request', async () => {
    const { fetchPage, calls } = recordingFetch((s, e) => pageOf(4, s, e))
    const rows = await fetchAllRows({ fetchPage, service: SERVICE, pageSize: 2 })
    expect(rows).toHaveLength(4)
    expect(calls).toEqual([
      [1, 2],
      [3, 4], // reached total → no empty [5,6] probe
    ])
  })

  it('stops on an EMPTY (INFO-200) page when the count over-reports', async () => {
    // total says 999 so neither short-page nor reached-total fires on page 1;
    // page 2 returns INFO-200 → the empty-stop path is exercised.
    const { fetchPage, calls } = recordingFetch((s) =>
      s === 1 ? pageOf(999, 1, 2) : errorPage('INFO-200', '해당하는 데이터가 없습니다'),
    )
    const rows = await fetchAllRows({ fetchPage, service: SERVICE, pageSize: 2 })
    expect(rows).toHaveLength(2)
    expect(calls).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('honours maxRows (long-tail cap) and stops early', async () => {
    const { fetchPage, calls } = recordingFetch((s, e) => pageOf(1000, s, e))
    const rows = await fetchAllRows({ fetchPage, service: SERVICE, pageSize: 100, maxRows: 150 })
    expect(rows).toHaveLength(150)
    expect(calls).toEqual([
      [1, 100],
      [101, 200],
    ])
  })

  it('clamps pageSize to the API max (1000)', async () => {
    const { fetchPage, calls } = recordingFetch((s, e) => pageOf(1, s, e))
    await fetchAllRows({ fetchPage, service: SERVICE, pageSize: 999999 })
    expect(calls[0]).toEqual([1, 1000])
  })

  it('propagates a fatal auth error out of the pager', async () => {
    const fetchPage: FetchPage = () => Promise.resolve(errorPage('INFO-100'))
    await expect(fetchAllRows({ fetchPage, service: SERVICE })).rejects.toThrow(/authError/)
  })

  it('propagates a quota error out of the pager', async () => {
    const fetchPage: FetchPage = () => Promise.resolve(errorPage('ERROR-337'))
    await expect(fetchAllRows({ fetchPage, service: SERVICE })).rejects.toThrow(/quotaExceeded/)
  })
})

describe('@xgis/pipeline · ingest/seoul-openapi · normalize + join', () => {
  const DISTRICTS = [
    { code: '11110', name: '종로구' },
    { code: '11680', name: '강남구' },
    { code: '11350', name: '노원구' },
  ]

  it('normalizeName folds NFC + trims + collapses whitespace', () => {
    expect(normalizeName('  강남구 ')).toBe('강남구')
    expect(normalizeName('강남  구')).toBe('강남 구')
    // NFD-composed name folds to the same key as the NFC form.
    expect(normalizeName('강남구'.normalize('NFD'))).toBe('강남구')
  })

  it('resolveCode trusts an explicit code, else joins a name → code', () => {
    const n2c = buildNameToCode(DISTRICTS)
    expect(resolveCode('11680', null, n2c)).toBe('11680') // explicit code wins
    expect(resolveCode(null, '강남구', n2c)).toBe('11680') // name join
    expect(resolveCode('', ' 노원구 ', n2c)).toBe('11350') // whitespace-tolerant
    expect(resolveCode(null, '없는구', n2c)).toBeNull() // unresolvable → drop
    // A finer-grained (행정동) code not in the 시군구 gazetteer is trusted as-is,
    // never dropped by validating it against the coarse gazetteer.
    expect(resolveCode('1168051', null, n2c)).toBe('1168051')
  })

  it('rowsToFlows resolves NAME-only rows to codes and aggregates by (o,d,h)', () => {
    const rows = [
      { from: '종로구', to: '강남구', hh: '8', p: 100 },
      { from: '종로구', to: '강남구', hh: '8', p: 40 }, // same key → summed
      { from: '종로구', to: '강남구', hh: '9', p: 7 },
    ]
    const flows = rowsToFlows(
      rows,
      { originName: 'from', destName: 'to', hour: 'hh', pop: 'p' },
      { districts: DISTRICTS },
    )
    const at8 = flows.find((f) => f.hour === 8)!
    expect(at8).toMatchObject({ origin: '11110', dest: '11680', pop: 140 })
    expect(flows.find((f) => f.hour === 9)!.pop).toBe(7)
  })

  it('rowsToFlows applies rollup, region filter, and top-N', () => {
    const rows = [
      { o: '11110515', d: '11680101', h: '8', pop: 500 }, // 종로 → 강남 (서울)
      { o: '11110515', d: '11680101', h: '9', pop: 5 }, // small → dropped by top-1
      { o: '41110101', d: '11680101', h: '8', pop: 900 }, // 경기(41) origin → region-filtered out
    ]
    const flows = rowsToFlows(
      rows,
      { originCode: 'o', destCode: 'd', hour: 'h', pop: 'pop' },
      { rollup: 5, region: ['11'], top: 1 },
    )
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({ origin: '11110', dest: '11680', hour: 8, pop: 500 })
  })

  it('rowsToFlows buckets hours and carries a pop-weighted avgTime', () => {
    const rows = [
      { o: '11110', d: '11680', h: '2', pop: 100, t: 10 }, // band 0 (6 bands over 24h)
      { o: '11110', d: '11680', h: '3', pop: 300, t: 30 }, // band 0 → merges with above
    ]
    const flows = rowsToFlows(
      rows,
      { originCode: 'o', destCode: 'd', hour: 'h', pop: 'pop', avgTime: 't' },
      { hourBucket: 6 },
    )
    expect(flows).toHaveLength(1)
    expect(flows[0]!.hour).toBe(0)
    expect(flows[0]!.pop).toBe(400)
    expect(flows[0]!.avgTime).toBeCloseTo((100 * 10 + 300 * 30) / 400) // 25
  })

  it('rowsToFlows carries purpose + segment (name→code segment folding)', () => {
    const rows = [
      { o: '11110', d: '11680', h: '8', pop: 100, purp: 1, seg: '내국인' },
      { o: '11110', d: '11680', h: '8', pop: 50, purp: 1, seg: '장기외국인' },
    ]
    const flows = rowsToFlows(rows, {
      originCode: 'o',
      destCode: 'd',
      hour: 'h',
      pop: 'pop',
      purpose: 'purp',
      segment: 'seg',
    })
    // Distinct segments (0 vs 2) do NOT merge even at the same (o,d,h,purpose).
    expect(flows).toHaveLength(2)
    expect(new Set(flows.map((f) => f.segment))).toEqual(new Set([0, 2]))
    expect(flows.every((f) => f.purpose === 1)).toBe(true)
  })

  it('rowsToFlows without an hour field yields an all-day sentinel aggregate', () => {
    const rows = [
      { o: '11110', d: '11680', pop: 10 },
      { o: '11110', d: '11680', pop: 90 },
    ]
    const flows = rowsToFlows(rows, { originCode: 'o', destCode: 'd', pop: 'pop' })
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({ hour: ODB_HOUR_ALLDAY, pop: 100 })
  })

  it('baked flows round-trip through the real encoder (byte-conventions)', () => {
    const rows = [
      { o: '11110', d: '11680', h: '8', pop: 100 },
      { o: '11680', d: '11110', h: '18', pop: 250 },
    ]
    const flows = rowsToFlows(rows, { originCode: 'o', destCode: 'd', hour: 'h', pop: 'pop' })
    const data = decodeODB(encodeODB(flows))
    expect(data.rowCount).toBe(2)
    expect(data.flow(0)).toEqual({ origin: '11110', dest: '11680', hour: 8, pop: 100 })
    expect(data.flow(1)).toEqual({ origin: '11680', dest: '11110', hour: 18, pop: 250 })
  })
})
