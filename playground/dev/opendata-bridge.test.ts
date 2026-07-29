import { describe, expect, it, beforeEach } from 'vitest'
import { handleOpenData } from './opendata-bridge'
import { S111_MODELS, _resetS111CatalogueCache } from './s111-catalogue'
import { OPEN_DATA_HOSTS } from './opendata-hosts'
import { parseCoverageCatalogue, itemsForView } from '@xgis/map'

type FetchImpl = typeof globalThis.fetch

const S111_HOST = 'noaa-s111-pds.s3.us-east-1.amazonaws.com'

/** A fake S3 that answers the S-111 day listing for EVERY model, and COUNTS the LISTs it
 *  serves — so a test can prove the memo collapses a whole burst into one catalogue build AND
 *  that the build stays inside Cloudflare's 50-subrequest budget.
 *
 *  It answers only for TODAY, and the `dcf3`/`dcf2/tiles` decoys are in the response on purpose:
 *  both sort AFTER `dcf2/regional/`, so a resolver that took a bare maximum over the day would
 *  return one of them. That is the mistake the real bucket's layout invites. */
function makeS3(now = Date.now()): { fetch: FetchImpl; listCount: () => number } {
  const d = new Date(now)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const today = `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`
  let n = 0
  const fetchImpl = (async (input: string | URL): Promise<Response> => {
    n++
    // URLSearchParams already percent-decodes, so `prefix` is the raw S3 prefix.
    const prefix = new URL(String(input)).searchParams.get('prefix') ?? ''
    // The model listing: the BUCKET is the authority on which models exist, so the build asks
    // for them before resolving any. It publishes one the bbox table cannot place, to pin that
    // such a model is skipped rather than guessed at.
    if (prefix === 'ed1.0.1/model_forecast_guidance/')
      return new Response(
        [...S111_MODELS.map((m) => m.key), 'nyofs']
          .map((k) => `<Prefix>${prefix}${k}/</Prefix>`)
          .join(''),
        { status: 200 },
      )
    const model = /model_forecast_guidance\/([a-z0-9_]+)\//.exec(prefix)?.[1]
    if (!model || !prefix.endsWith(`/${today}/`)) return new Response('', { status: 200 })
    const at = (hour: string, tail: string): string => `<Key>${prefix}${hour}/${tail}</Key>`
    return new Response(
      at('00', `dcf2/regional/${model}_00.h5`) +
        at('18', `dcf2/regional/${model}_18.h5`) +
        at('18', `dcf2/tiles/${model}_tile.h5`) + // sorts after regional/
        at('18', `dcf3/${model}_dcf3.h5`), // sorts after dcf2/
      { status: 200 },
    )
  }) as unknown as FetchImpl
  return { fetch: fetchImpl, listCount: () => n }
}

const expectedKey = (model: string, now = Date.now()): string => {
  const d = new Date(now)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const day = `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`
  return `ed1.0.1/model_forecast_guidance/${model}/${day}/18/dcf2/regional/${model}_18.h5`
}

const NEVER_FETCH = (async () => {
  throw new Error('this route must not touch the network')
}) as unknown as FetchImpl

beforeEach(() => {
  _resetS111CatalogueCache()
})

// ── The S-111 cell catalogue (#1453) ──
//
// The route the `s111_live` demo's `type: coverage` source names. It is parsed by the ENGINE, so
// these gates run the real `parseCoverageCatalogue` over the real document rather than asserting
// the shape this file happens to emit.

describe('GET /opendata/s111.stac.json', () => {
  it('is served as CORS-open geo+json', async () => {
    const res = await handleOpenData('/opendata/s111.stac.json', null, null, makeS3().fetch)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/geo+json')
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
  })

  it("builds inside Cloudflare's 50-subrequest budget, once per burst", async () => {
    // BOTH halves of this shipped broken. The build ran a 5-to-10-LIST prefix walk per model, so
    // twelve concurrent models blew Cloudflare's 50-subrequest-per-request cap and the catalogue
    // answered 200 with 5 of 12 models silently missing. One LIST per model per candidate day is
    // what fits. The memo is the other half: a reload must not rebuild.
    const s3 = makeS3()
    const docs = await Promise.all(
      Array.from({ length: 8 }, () =>
        handleOpenData('/opendata/s111.stac.json', null, null, s3.fetch).then((r) => r.json()),
      ),
    )
    expect(s3.listCount()).toBe(1 + S111_MODELS.length) // ONE build: the model list + one day per model
    expect(s3.listCount(), 'inside the Workers subrequest cap').toBeLessThan(50)
    for (const d of docs) expect((d as { features: unknown[] }).features).toHaveLength(12)
  })

  it("reports a PARTIAL build through STAC's own counters", async () => {
    // A dropped model is otherwise invisible: the document is well-formed and the status is 200.
    // `scripts/check-opendata-bridge.ts` fails the deploy on this shortfall.
    const s3 = makeS3()
    const partial = (async (input: string | URL): Promise<Response> => {
      if (String(input).includes('cbofs')) return new Response('', { status: 500 })
      return s3.fetch(input as string)
    }) as unknown as FetchImpl
    const whole = (await (
      await handleOpenData('/opendata/s111.stac.json', null, null, s3.fetch)
    ).json()) as { numberMatched: number; numberReturned: number }
    // 12, not 13: the bucket also lists `nyofs`, which has no envelope here and is skipped.
    expect(whole).toMatchObject({ numberMatched: 12, numberReturned: 12 })

    _resetS111CatalogueCache()
    const cut = (await (
      await handleOpenData('/opendata/s111.stac.json', null, null, partial)
    ).json()) as { numberMatched: number; numberReturned: number }
    expect(cut).toMatchObject({ numberMatched: 12, numberReturned: 11 })
  })

  it('takes the newest dcf2/regional cell, not the dcf3 or tiles sibling that sorts after it', async () => {
    // A day's keys carry `dcf3/` and `dcf2/tiles/` alongside `dcf2/regional/`, and both sort
    // LATER — so a bare lexicographic maximum over the day returns the wrong product entirely.
    const res = await handleOpenData('/opendata/s111.stac.json', null, null, makeS3().fetch)
    const items = parseCoverageCatalogue(await res.json(), '/opendata/s111.stac.json', 'test')
    for (const i of items) {
      expect(i.href, i.id).toContain('/dcf2/regional/')
      expect(i.href, i.id).not.toContain('dcf3')
      expect(i.href, i.id).not.toContain('/tiles/')
    }
  })

  it('the ENGINE parses it — every model becomes one addressable cell', async () => {
    const res = await handleOpenData('/opendata/s111.stac.json', null, null, makeS3().fetch)
    const items = parseCoverageCatalogue(await res.json(), '/opendata/s111.stac.json', 'test')
    expect(items).toHaveLength(S111_MODELS.length)
    expect(items.map((i) => i.id).sort()).toEqual(S111_MODELS.map((m) => m.key).sort())
  })

  it('hrefs are RELATIVE, so they follow the catalogue to whichever origin served it', async () => {
    // The production site rewrites `/opendata/` to the Cloudflare Worker, so the catalogue
    // arrives from the WORKER's origin. A root-relative href would resolve against the PAGE
    // origin (github.io), which serves no cells — every item would 404 in prod and ONLY in prod.
    // Both resolutions are asserted here so that cannot regress silently.
    const res = await handleOpenData('/opendata/s111.stac.json', null, null, makeS3().fetch)
    const doc = await res.json()
    const dev = parseCoverageCatalogue(doc, '/opendata/s111.stac.json', 'test')
    expect(dev.find((i) => i.id === 'cbofs')!.href).toBe(
      `/opendata/${S111_HOST}/${expectedKey('cbofs')}`,
    )

    const prod = parseCoverageCatalogue(
      doc,
      'https://opendata-bridge.x-gis.workers.dev/opendata/s111.stac.json',
      'test',
    )
    expect(prod.find((i) => i.id === 'cbofs')!.href).toBe(
      `https://opendata-bridge.x-gis.workers.dev/opendata/${S111_HOST}/${expectedKey('cbofs')}`,
    )
  })

  it('an href resolves to a path this bridge actually serves', async () => {
    // The two halves are written in different files, so nothing but this proves they agree: the
    // href the catalogue emits must be a request the passthrough accepts, not a 403 or a 404.
    const res = await handleOpenData('/opendata/s111.stac.json', null, null, makeS3().fetch)
    const items = parseCoverageCatalogue(await res.json(), '/opendata/s111.stac.json', 'test')
    const href = items.find((i) => i.id === 'cbofs')!.href
    const streamed = await handleOpenData(href, null, null, makeS3().fetch)
    expect(streamed.status).toBe(200)
  })

  it('DROPS a model whose walk fails rather than failing the whole catalogue', async () => {
    // One unreachable basin must not take the other eleven with it, and an item whose href we
    // cannot name would point the engine at a key that does not exist.
    const s3 = makeS3()
    const partial = (async (input: string | URL): Promise<Response> => {
      if (String(input).includes('cbofs')) return new Response('', { status: 500 })
      return s3.fetch(input as string)
    }) as unknown as FetchImpl
    const res = await handleOpenData('/opendata/s111.stac.json', null, null, partial)
    const items = parseCoverageCatalogue(await res.json(), '/opendata/s111.stac.json', 'test')
    expect(items.map((i) => i.id)).not.toContain('cbofs')
    expect(items).toHaveLength(S111_MODELS.length - 1)
  })

  it('the demo viewports still resolve to the cells the mosaic used to pick', async () => {
    // The witnesses `s111-models.test.ts` carried, now proven END TO END: served document →
    // engine parse → engine selection. The demo's own opening view is the Chesapeake one.
    const res = await handleOpenData('/opendata/s111.stac.json', null, null, makeS3().fetch)
    const items = parseCoverageCatalogue(await res.json(), '/opendata/s111.stac.json', 'test')
    const keys = (v: [number, number, number, number]): string[] =>
      itemsForView(items, v).map((i) => i.id)

    expect(keys([-76.6, 37.5, -75.9, 38.3])[0]).toBe('cbofs')
    expect(keys([-122.6, 37.5, -122.1, 38.0])[0]).toBe('sfbofs') // tie → the local domain
    expect(keys([-160, 10, -150, 20])).toEqual([]) // mid-Pacific: no cell
    const midAtlantic = keys([-76.5, 37.5, -74.5, 39.5])
    expect(midAtlantic[0]).toBe('cbofs')
    expect(midAtlantic).toContain('dbofs') // BOTH — the mosaic, without any app code
  })

  it('every model envelope is well-formed and uniquely keyed', () => {
    const seen = new Set<string>()
    for (const m of S111_MODELS) {
      expect(m.bounds[0], m.key).toBeLessThan(m.bounds[2])
      expect(m.bounds[1], m.key).toBeLessThan(m.bounds[3])
      expect(seen.has(m.key), `duplicate key ${m.key}`).toBe(false)
      seen.add(m.key)
    }
  })

  it('404s an unknown catalogue id without touching the network', async () => {
    const res = await handleOpenData('/opendata/nope.stac.json', null, null, NEVER_FETCH)
    expect(res.status).toBe(404)
  })
})

// ── The host allowlist ──
//
// `/opendata/<host>/<path>` can name any host in the world, so this set is the only thing
// between the bridge and being an open proxy anyone could borrow to launder bandwidth through
// the x-gis account. Its AWS half is generated from awslabs/open-data-registry and its other
// half is hand-listed; both merge into one set with one lookup, and a list nobody exercises is
// a list that silently loosens.

/** Records the URL a passthrough resolved to, and answers with an empty 200. */
function recordingFetch(): { fetch: FetchImpl; urls: string[] } {
  const urls: string[] = []
  const f = (async (input: string | URL): Promise<Response> => {
    urls.push(String(input))
    return new Response('', { status: 200 })
  }) as unknown as FetchImpl
  return { fetch: f, urls }
}

describe('GET /opendata/<host>/<path> (allowlisted passthrough)', () => {
  it('carries the generated AWS hosts and is not a token list', () => {
    expect(OPEN_DATA_HOSTS.has(S111_HOST)).toBe(true)
    expect(OPEN_DATA_HOSTS.has('noaa-s102-pds.s3.us-east-1.amazonaws.com')).toBe(true)
    // The registry has ~1200 datasets; a couple of hundred hosts would mean the generator
    // silently stopped parsing partway.
    expect(OPEN_DATA_HOSTS.size).toBeGreaterThan(500)
  })

  it('streams an allowlisted host, preserving the path and the query', async () => {
    const rec = recordingFetch()
    const res = await handleOpenData(
      `/opendata/${S111_HOST}/?list-type=2&prefix=ed1.0.1/`,
      null,
      null,
      rec.fetch,
    )
    expect(res.status).toBe(200)
    expect(rec.urls).toEqual([`https://${S111_HOST}/?list-type=2&prefix=ed1.0.1/`])
  })

  it('REFUSES a host that is not on the list — without fetching it', async () => {
    const res = await handleOpenData(
      '/opendata/internal.corp.example/secret',
      null,
      null,
      NEVER_FETCH,
    )
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('internal.corp.example')
  })

  it('refuses a NEAR-MISS of an allowlisted host (no prefix/suffix/authority slack)', async () => {
    // Every one of these is a string an attacker can control end to end: `.evil.com` is a
    // registerable domain, and `@`/`:` change which authority a URL actually addresses. An exact
    // match against the set is what makes all of them the same non-answer.
    for (const host of [
      `${S111_HOST}.evil.com`,
      `evil.com.${S111_HOST}`,
      `${S111_HOST}@evil.com`,
      `${S111_HOST}:8080`,
      'noaa-s111-pds.s3.amazonaws.com', // the region-less form is NOT the allowlisted host
    ]) {
      const res = await handleOpenData(`/opendata/${host}/k`, null, null, NEVER_FETCH)
      expect(res.status, host).toBe(403)
    }
  })

  it('404s a path outside the /opendata prefix rather than proxying it', async () => {
    const res = await handleOpenData('/noaa-s111/catalog.json', null, null, NEVER_FETCH)
    expect(res.status).toBe(404)
  })
})
