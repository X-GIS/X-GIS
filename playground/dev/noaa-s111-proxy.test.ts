import { describe, expect, it } from 'vitest'
import { resolveLatestS111Cached } from './noaa-s111-proxy'

type FetchImpl = typeof globalThis.fetch

// A fake S3 that answers the `resolveLatestS111` date-tree walk for one model with canned
// XML and COUNTS the LISTs it serves — so a test can prove the memo collapses a whole load
// burst into ONE walk. The walk lists year → month → day → hour prefixes, then the leaf
// `dcf2/regional/` keys = 5 LISTs for the happy path below.
function makeS3(model: string): { fetch: FetchImpl; listCount: () => number } {
  const base = `ed1.0.1/model_forecast_guidance/${model}`
  let n = 0
  const xml = (body: string): Response => new Response(body, { status: 200 })
  const fetchImpl = (async (input: string | URL): Promise<Response> => {
    n++
    // URLSearchParams already percent-decodes, so `prefix` is the raw S3 prefix.
    const prefix = new URL(String(input)).searchParams.get('prefix') ?? ''
    if (prefix.endsWith('/00/dcf2/regional/')) return xml(`<Key>${prefix}CBOFS_TYP2.h5</Key>`)
    if (prefix === `${base}/2026/07/22/`) return xml(`<Prefix>${prefix}00/</Prefix>`)
    if (prefix === `${base}/2026/07/`) return xml(`<Prefix>${prefix}22/</Prefix>`)
    if (prefix === `${base}/2026/`) return xml(`<Prefix>${prefix}07/</Prefix>`)
    if (prefix === `${base}/`) return xml(`<Prefix>${prefix}2026/</Prefix>`)
    return xml('')
  }) as unknown as FetchImpl
  return { fetch: fetchImpl, listCount: () => n }
}

const expectedKey = (model: string): string =>
  `ed1.0.1/model_forecast_guidance/${model}/2026/07/22/00/dcf2/regional/CBOFS_TYP2.h5`

describe('resolveLatestS111Cached (burst memo)', () => {
  it('walks the S3 date tree ONCE for a concurrent burst of resolutions', async () => {
    const model = 'burstmodel'
    const s3 = makeS3(model)
    // The reader's ~13 range GETs each hit resolveTarget → resolveLatestS111Cached.
    const keys = await Promise.all(
      Array.from({ length: 13 }, () => resolveLatestS111Cached(model, s3.fetch)),
    )
    expect(keys.every((k) => k === expectedKey(model))).toBe(true)
    expect(s3.listCount()).toBe(5) // ONE walk (5 LISTs) — NOT 13 × 5 = 65.
  })

  it('re-resolves after a failure (a rejected walk is never cached)', async () => {
    const model = 'failmodel'
    let firstRequest = true
    const flakyFetch = (async (input: string | URL): Promise<Response> => {
      if (firstRequest) {
        // Kill the first walk at its first LIST: an empty body parses to zero year
        // folders, so resolveLatestS111 throws. The failure must NOT be cached.
        firstRequest = false
        return new Response('', { status: 500 })
      }
      return makeS3(model).fetch(input)
    }) as unknown as FetchImpl
    await expect(resolveLatestS111Cached(model, flakyFetch)).rejects.toThrow()
    // A fresh call must RETRY (cache evicted the failure) and now succeed.
    await expect(resolveLatestS111Cached(model, flakyFetch)).resolves.toBe(expectedKey(model))
  })
})
