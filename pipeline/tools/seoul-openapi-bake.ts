// ═══ seoul-openapi-bake — live 서울 열린데이터광장 open-API → .odb (node, zero npm) ═══
//
// Run BEFORE anything ships: a browser cannot call data.seoul.go.kr directly
// (http:8088 is mixed-content on an https GitHub Pages host, the API sends no CORS
// headers, and the auth key would be exposed in client JS). So the fetch happens
// OFFLINE here — this tool pages the whole dataset, aggregates it to (origin, dest,
// hour) sums, and encodes the tiny result via the pipeline's `encodeODB`. The KB-
// scale .odb is what you commit / put on a CDN; the hero page fetches THAT.
//
// The API key comes ONLY from the SEOUL_OPENAPI_KEY env var — it is never a CLI
// arg (shell history), never committed, and never logged (URLs are redacted).
//
// node/bun builtins only (fs/zlib + global fetch) — no npm, mirroring @xgis/pipeline's
// zero-dep charter. All protocol/normalize logic lives in (and is unit-tested from)
// ../src/ingest/seoul-openapi; this file is the thin I/O shell. It is a devDep tool,
// excluded from the package build.
//
// Usage:
//   SEOUL_OPENAPI_KEY=xxxx bun pipeline/tools/seoul-openapi-bake.ts <out.odb> --service=<S> [opts]
//
// Field mapping (defaults = the OA-22300 생활이동 CSV column names — OVERRIDE these to
// match the chosen service's JSON field keys, which differ per dataset):
//   --service=<name>      REQUIRED data.seoul.go.kr OpenAPI service name (e.g. OA-22300's)
//   --origin-code=<f>     origin admin-code field      (default: 출발_행정동_코드)
//   --dest-code=<f>       destination admin-code field (default: 도착_행정동_코드)
//   --origin-name=<f>     origin admin-NAME field      (name→code join fallback)
//   --dest-name=<f>       destination admin-NAME field (name→code join fallback)
//   --hour=<f>            arrival-hour field           (default: 도착_시간; omit for all-day)
//   --pop=<f>             moving-population field       (default: 이동인구_합)
//   --avgtime=<f>         mean travel-minutes field    (optional)
//   --purpose=<f>         move-purpose field 1–7        (optional)
//   --segment=<f>         내국인/단기외국인/장기외국인 field (optional)
// Aggregation (shrinks the payload to a committable fixture):
//   --rollup=<n>          truncate admin codes to <n> chars (5 = 행정동→시군구)
//   --region=<p,p>        keep flows whose BOTH endpoints start with a prefix (11 = 서울)
//   --hourbucket=<n>      bucket 24h into <n> bands
//   --top=<n>             keep only the top-N flows by population
//   --brotli              also write <out>.br (transport-compressed)
// Protocol:
//   --page-size=<n>       rows per request (default/cap 1000)
//   --max-rows=<n>        stop after N collected rows (long-tail cap)
//   --type=<t>            response type path segment (default: json)
//   --base=<url>          override the API base (default openapi.seoul.go.kr:8088)
//   --arg=<v>             extra trailing path arg (repeatable, in order)

import { writeFileSync } from 'node:fs'
import { brotliCompressSync } from 'node:zlib'
import { encodeODB } from '../src/odb/format'
import { SEOUL_SIGUNGU } from '../src/gazetteer/kr'
import {
  buildPageUrl,
  fetchAllRows,
  redactKey,
  rowsToFlows,
  type AggregateOpts,
  type FetchPage,
  type FlowDiagnostics,
  type FlowFieldMap,
} from '../src/ingest/seoul-openapi'

interface CliOpts {
  output: string
  service: string
  fields: FlowFieldMap
  agg: AggregateOpts
  pageSize?: number
  maxRows?: number
  type?: string
  base?: string
  args: string[]
  brotli: boolean
}

function parseArgs(argv: string[]): CliOpts {
  const positional: string[] = []
  const fields: FlowFieldMap = {
    originCode: '출발_행정동_코드',
    destCode: '도착_행정동_코드',
    hour: '도착_시간',
    pop: '이동인구_합',
  }
  const agg: AggregateOpts = { districts: SEOUL_SIGUNGU }
  const out: CliOpts = { output: '', service: '', fields, agg, args: [], brotli: false }

  for (const a of argv) {
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const k = eq === -1 ? a.slice(2) : a.slice(2, eq)
    const v = eq === -1 ? '' : a.slice(eq + 1)
    switch (k) {
      case 'service':
        out.service = v
        break
      case 'origin-code':
        fields.originCode = v || undefined
        break
      case 'dest-code':
        fields.destCode = v || undefined
        break
      case 'origin-name':
        fields.originName = v || undefined
        break
      case 'dest-name':
        fields.destName = v || undefined
        break
      case 'hour':
        fields.hour = v || undefined
        break
      case 'pop':
        fields.pop = v
        break
      case 'avgtime':
        fields.avgTime = v || undefined
        break
      case 'purpose':
        fields.purpose = v || undefined
        break
      case 'segment':
        fields.segment = v || undefined
        break
      case 'rollup':
        agg.rollup = Number(v)
        break
      case 'region':
        agg.region = v.split(',').map((s) => s.trim())
        break
      case 'hourbucket':
        agg.hourBucket = Number(v)
        break
      case 'top':
        agg.top = Number(v)
        break
      case 'page-size':
        out.pageSize = Number(v)
        break
      case 'max-rows':
        out.maxRows = Number(v)
        break
      case 'type':
        out.type = v
        break
      case 'base':
        out.base = v
        break
      case 'arg':
        out.args.push(v)
        break
      case 'brotli':
        out.brotli = true
        break
      default:
        throw new Error(`unknown option --${k}`)
    }
  }
  out.output = positional[0] ?? ''
  if (!out.output || !out.service) {
    throw new Error(
      'usage: SEOUL_OPENAPI_KEY=… seoul-openapi-bake <out.odb> --service=<name> [--rollup=5 --region=11 --top=2000 --brotli]',
    )
  }
  return out
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const key = process.env['SEOUL_OPENAPI_KEY']
  if (!key) {
    throw new Error(
      '[seoul-openapi-bake] SEOUL_OPENAPI_KEY is not set. Export your data.seoul.go.kr key ' +
        '(never pass it as a CLI arg or commit it): SEOUL_OPENAPI_KEY=xxxx bun pipeline/tools/seoul-openapi-bake.ts …',
    )
  }

  // The one place I/O lives: a `fetch`-backed page loader for the injected pager.
  const fetchPage: FetchPage = async (start, end) => {
    const url = buildPageUrl({
      key,
      service: opts.service,
      start,
      end,
      type: opts.type,
      base: opts.base,
      args: opts.args,
    })
    let res: Response
    try {
      res = await fetch(url)
    } catch (e) {
      // A REJECTED fetch (DNS / connection-refused — the common http:8088 failure)
      // carries the key-bearing URL on the error's own `path`/`cause`, which Bun
      // prints verbatim on an unhandled rejection. Rethrow a FRESH, redacted Error —
      // never inherit the original's properties.
      const detail = e instanceof Error ? e.message : String(e)
      throw new Error(
        redactKey(`[seoul-openapi-bake] fetch failed for ${opts.service}: ${detail}`, key),
      )
    }
    if (!res.ok) {
      // Redact defensively — statusText carries no key, but never risk echoing a URL.
      throw new Error(
        redactKey(
          `[seoul-openapi-bake] HTTP ${res.status} ${res.statusText} for ${opts.service}`,
          key,
        ),
      )
    }
    try {
      return await res.json()
    } catch (e) {
      // A malformed body's parse error can quote the payload; redact + reframe it too.
      const detail = e instanceof Error ? e.message : String(e)
      throw new Error(
        redactKey(`[seoul-openapi-bake] invalid JSON from ${opts.service}: ${detail}`, key),
      )
    }
  }

  const rows = await fetchAllRows({
    fetchPage,
    service: opts.service,
    pageSize: opts.pageSize,
    maxRows: opts.maxRows,
    onPage: ({ start, end, total, received }) => {
      console.log(
        `[seoul-openapi-bake] page ${start}–${end} of ${total || '?'} (+${received} rows)`,
      )
    },
  })

  const diagnostics: FlowDiagnostics = { unknownSegmentRows: 0, outOfRangePurposeRows: 0 }
  const flows = rowsToFlows(rows, opts.fields, opts.agg, diagnostics)
  if (diagnostics.unknownSegmentRows > 0) {
    console.warn(
      `[seoul-openapi-bake] ${diagnostics.unknownSegmentRows} rows had an unrecognized segment value → defaulted to 내국인 (0); check for NFD/2-value schema`,
    )
  }
  if (diagnostics.outOfRangePurposeRows > 0) {
    console.warn(
      `[seoul-openapi-bake] ${diagnostics.outOfRangePurposeRows} rows had an out-of-range purpose value (expected 1–7) → value kept as-is; check source data`,
    )
  }
  const buf = encodeODB(flows)
  writeFileSync(opts.output, Buffer.from(buf))
  let msg = `[seoul-openapi-bake] ${rows.length} rows → ${flows.length} flows → ${opts.output} (${(buf.byteLength / 1024).toFixed(1)}KB)`
  if (opts.brotli) {
    const br = brotliCompressSync(Buffer.from(buf))
    writeFileSync(opts.output + '.br', br)
    msg += ` + ${opts.output}.br (${(br.byteLength / 1024).toFixed(1)}KB brotli)`
  }
  console.log(msg)
}

void main()
