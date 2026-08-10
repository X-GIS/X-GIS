import { describe, it, expect, afterEach } from 'vitest'
import {
  XGISError,
  XGISInputError,
  XGISSecurityError,
  assertIngestBudget,
  assertNotErrorPage,
  assertSafeRemoteUrl,
  readBodyCapped,
  INGEST_LIMITS,
} from '@xgis/shared'

describe('XGISError taxonomy', () => {
  it('subclasses are instanceof XGISError and Error', () => {
    const input = new XGISInputError('x')
    const sec = new XGISSecurityError('y')
    expect(input).toBeInstanceOf(XGISError)
    expect(input).toBeInstanceOf(Error)
    expect(sec).toBeInstanceOf(XGISError)
    expect(input.name).toBe('XGISInputError')
    expect(sec.name).toBe('XGISSecurityError')
  })
})

describe('assertSafeRemoteUrl same-origin loopback allowance', () => {
  const setOrigin = (origin: string | undefined) => {
    if (origin === undefined) delete (globalThis as { window?: unknown }).window
    else
      (globalThis as { window?: { location: { origin: string } } }).window = {
        location: { origin },
      }
  }
  afterEach(() => setOrigin(undefined))

  it('allows a loopback host that is the SAME origin as the page (dev server own assets + proxy)', () => {
    setOrigin('https://localhost:3000')
    expect(() => assertSafeRemoteUrl('https://localhost:3000/data/x.geojson')).not.toThrow()
    expect(() =>
      assertSafeRemoteUrl('https://localhost:3000/pmtiles-proxy/v4.pmtiles'),
    ).not.toThrow()
  })

  it('still blocks a private host that is a DIFFERENT origin than the page', () => {
    setOrigin('https://maps.example.com')
    expect(() => assertSafeRemoteUrl('https://127.0.0.1/internal')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      XGISSecurityError,
    )
    // a different loopback PORT is cross-origin → still blocked
    setOrigin('https://localhost:3000')
    expect(() => assertSafeRemoteUrl('https://localhost:8080/x')).toThrow(XGISSecurityError)
  })

  it('blocks every private host when there is no page origin (Node / SSR — the real SSRF surface)', () => {
    setOrigin(undefined)
    expect(() => assertSafeRemoteUrl('https://localhost:3000/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('https://127.0.0.1/x')).toThrow(XGISSecurityError)
  })
})

describe('assertIngestBudget', () => {
  const limits = { maxFeatures: 3, maxVertices: 5 }

  it('throws XGISInputError when feature count exceeds the cap', () => {
    const features = Array.from({ length: 4 }, () => ({ geometry: null }))
    expect(() => assertIngestBudget(features, 'test', limits)).toThrow(XGISInputError)
  })

  it('passes at exactly the feature cap', () => {
    const features = Array.from({ length: 3 }, () => ({ geometry: null }))
    expect(() => assertIngestBudget(features, 'test', limits)).not.toThrow()
  })

  it('throws when total vertices exceed the cap', () => {
    const big = {
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 2],
          [3, 3],
          [4, 4],
          [5, 5],
        ],
      },
    }
    expect(() => assertIngestBudget([big], 'test', limits)).toThrow(XGISInputError)
  })

  it('counts nested polygon rings and GeometryCollection members', () => {
    const poly = {
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ], // 4 vertices
      },
    }
    // 4 ring vertices > the 3-vertex cap ⇒ nested-ring counting reached it.
    expect(() => assertIngestBudget([poly], 'test', { maxFeatures: 3, maxVertices: 3 })).toThrow(
      XGISInputError,
    )
    const gc = {
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [0, 0] },
          { type: 'Point', coordinates: [1, 1] },
        ],
      },
    }
    expect(() => assertIngestBudget([gc], 'test', { maxFeatures: 3, maxVertices: 1 })).toThrow(
      XGISInputError,
    )
  })

  it('is a no-op when features is not an array', () => {
    expect(() => assertIngestBudget(undefined)).not.toThrow()
    expect(() => assertIngestBudget(null)).not.toThrow()
    expect(() => assertIngestBudget({})).not.toThrow()
  })

  it('default limits are generous (a small collection passes)', () => {
    const features = Array.from({ length: 10 }, () => ({
      geometry: { type: 'Point', coordinates: [0, 0] },
    }))
    expect(() => assertIngestBudget(features)).not.toThrow()
    expect(INGEST_LIMITS.maxFeatures).toBeGreaterThan(10_000)
  })
})

describe('assertSafeRemoteUrl', () => {
  it('rejects dangerous schemes', () => {
    expect(() => assertSafeRemoteUrl('javascript:alert(1)')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('data:text/html,<script>')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('file:///etc/passwd')).toThrow(XGISSecurityError)
  })

  it('rejects private / loopback IPv4 hosts (SSRF)', () => {
    expect(() => assertSafeRemoteUrl('http://127.0.0.1/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://10.0.0.5/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://192.168.1.1/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://172.16.3.4/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://169.254.1.1/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://0.0.0.0/x')).toThrow(XGISSecurityError)
  })

  it('rejects localhost and IPv6 loopback', () => {
    expect(() => assertSafeRemoteUrl('http://localhost:8080/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://[::1]/x')).toThrow(XGISSecurityError)
  })

  it('allows public http/https URLs', () => {
    expect(() => assertSafeRemoteUrl('https://example.com/sprites/foo')).not.toThrow()
    expect(() => assertSafeRemoteUrl('http://x/atlas')).not.toThrow()
    expect(() =>
      assertSafeRemoteUrl('https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'),
    ).not.toThrow()
  })

  it('allows relative (same-origin) URLs', () => {
    expect(() => assertSafeRemoteUrl('sprites/basic')).not.toThrow()
    expect(() => assertSafeRemoteUrl('/assets/glyphs/{fontstack}/{range}.pbf')).not.toThrow()
  })

  it('blocks IPv4-mapped IPv6 loopback / metadata (SSRF bypass)', () => {
    expect(() => assertSafeRemoteUrl('http://[::ffff:127.0.0.1]/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://[::ffff:169.254.169.254]/x')).toThrow(
      XGISSecurityError,
    )
  })

  it('blocks IPv4-compatible / NAT64 / 6to4 IPv6 wrapping private addresses', () => {
    expect(() => assertSafeRemoteUrl('http://[::127.0.0.1]/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://[::a9fe:a9fe]/x')).toThrow(XGISSecurityError) // ::169.254.169.254
    expect(() => assertSafeRemoteUrl('http://[64:ff9b::a9fe:a9fe]/x')).toThrow(XGISSecurityError) // NAT64 metadata
    expect(() => assertSafeRemoteUrl('http://[2002:7f00:1::]/x')).toThrow(XGISSecurityError) // 6to4 127.0.0.1
  })

  it('does not over-block IPv6-embedded PUBLIC v4 addresses', () => {
    // ::8.8.8.8 (public) must stay allowed — the guard re-checks the
    // embedded v4 rather than blanket-blocking the embedding form.
    expect(() => assertSafeRemoteUrl('http://[::808:808]/x')).not.toThrow()
  })

  it('blocks protocol-relative URLs to private hosts but allows public ones', () => {
    expect(() => assertSafeRemoteUrl('//169.254.169.254/latest/meta-data')).toThrow(
      XGISSecurityError,
    )
    expect(() => assertSafeRemoteUrl('//127.0.0.1/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('//cdn.example.com/sprite')).not.toThrow()
  })

  it('blocks CGNAT and benchmarking ranges', () => {
    expect(() => assertSafeRemoteUrl('http://100.64.0.1/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://198.18.0.1/x')).toThrow(XGISSecurityError)
  })

  it('still catches decimal / hex IPv4 encodings (parser-normalised)', () => {
    expect(() => assertSafeRemoteUrl('http://2130706433/x')).toThrow(XGISSecurityError) // 127.0.0.1
    expect(() => assertSafeRemoteUrl('http://0x7f000001/x')).toThrow(XGISSecurityError)
  })

  it('blocks trailing-dot hostnames (SSRF bypass via DNS absolute label)', () => {
    // WHATWG URL parser preserves the trailing dot on non-numeric hosts,
    // so "localhost." !== "localhost" and the old guard returned false.
    // After normalization, these must be treated identically to the bare forms.
    expect(() => assertSafeRemoteUrl('http://localhost./x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://foo.localhost./x')).toThrow(XGISSecurityError)
    // Control: a public host with a trailing dot must NOT be blocked.
    expect(() => assertSafeRemoteUrl('http://example.com./x')).not.toThrow()
  })
})

describe('assertIngestBudget DoS-nesting hardening', () => {
  it('throws XGISInputError (not RangeError) on adversarially deep nesting', () => {
    // Build a coordinates array nested far past MAX_GEOJSON_NEST.
    let coords: unknown = [0, 0]
    for (let i = 0; i < 5000; i++) coords = [coords]
    const feature = { geometry: { type: 'LineString', coordinates: coords } }
    expect(() => assertIngestBudget([feature], 'deep')).toThrow(XGISInputError)
  })

  it('early-exits within a single oversized feature (vertex cap mid-traversal)', () => {
    const ring = Array.from({ length: 50 }, (_, i) => [i, i])
    const feature = { geometry: { type: 'LineString', coordinates: ring } }
    // One feature, 50 vertices, cap 10 → must throw even though feature
    // count (1) is under maxFeatures.
    expect(() =>
      assertIngestBudget([feature], 'big', { maxFeatures: 10, maxVertices: 10 }),
    ).toThrow(XGISInputError)
  })
})

describe('readBodyCapped', () => {
  it('returns a body under the cap', async () => {
    const resp = new Response(new Uint8Array([1, 2, 3, 4]))
    const bytes = await readBodyCapped(resp, 1024, 'test')
    expect(bytes.length).toBe(4)
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4])
  })

  it('throws XGISInputError on an over-cap body', async () => {
    const resp = new Response(new Uint8Array(4096))
    await expect(readBodyCapped(resp, 1024, 'test')).rejects.toThrow(XGISInputError)
  })
})

// ═══ assertNotErrorPage (#1627) ═══
//
// The bug this guards: a MISSING path is not a 404 on a dev server or most
// static hosts — the SPA fallback answers **HTTP 200 with an HTML document**.
// Every caller's `resp.ok` check therefore passes and the page reaches the
// lexer / JSON.parse, which reports a position inside HTML the author never
// wrote. So every response below is built with status 200 ON PURPOSE: a 404
// fixture would exercise the guard that already worked and prove nothing.
describe('assertNotErrorPage (#1627)', () => {
  const enc = new TextEncoder()
  /** 200 + a body, i.e. exactly what an SPA fallback returns. */
  const ok200 = (contentType?: string): Response =>
    new Response(null, {
      status: 200,
      headers: contentType ? { 'content-type': contentType } : {},
    })

  describe('rejects an HTML error page served with 200', () => {
    for (const [name, body] of [
      ['lowercase doctype (vite dev server)', '<!doctype html>\n<html lang="en">'],
      ['uppercase doctype (GitHub Pages 404)', '<!DOCTYPE html>\n<html>'],
      ['bare <html> root, no doctype', '<html><body>404 Not Found</body></html>'],
      ['leading blank lines before the doctype', '\n\n  <!doctype html>'],
      ['a UTF-8 BOM ahead of the doctype', '﻿<!doctype html>'],
    ] as const) {
      it(name, () => {
        expect(() => assertNotErrorPage(ok200('text/html'), enc.encode(body), 'style x')).toThrow(
          XGISInputError,
        )
      })
    }

    it('names the label, the status and the content-type — not a position in the body', () => {
      let msg = ''
      try {
        assertNotErrorPage(
          ok200('text/html'),
          enc.encode('<!doctype html>'),
          'style import /a.xgis',
        )
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toContain('style import /a.xgis')
      expect(msg).toContain('HTTP 200')
      expect(msg).toContain('text/html')
      // The whole point: the reader is pointed at the URL, not at a line
      // number inside a document they did not author.
      expect(msg).toMatch(/HTML document/i)
    })
  })

  describe('accepts every real payload', () => {
    for (const [name, body] of [
      ['X-GIS source', 'xgis 1\n\nsource land {\n  type: geojson\n}'],
      ['GeoJSON', '{"type":"FeatureCollection","features":[]}'],
      ['TileJSON', '{"tiles":["https://x/{z}/{x}/{y}.pbf"]}'],
      ['an empty body', ''],
      ['a comment-led style', '// a leading comment\nxgis 1'],
    ] as const) {
      it(name, () => {
        expect(() => assertNotErrorPage(ok200(), enc.encode(body), 'x')).not.toThrow()
      })
    }

    it('binary payloads (PNG magic, HDF5 signature)', () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const hdf5 = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(() => assertNotErrorPage(ok200(), png, 'sprite png')).not.toThrow()
      expect(() => assertNotErrorPage(ok200(), hdf5, 'coverage cell')).not.toThrow()
    })

    // THE DISCRIMINATING CASE — this is why the guard sniffs the BODY and not
    // `Content-Type`. Static hosts routinely serve an unknown extension
    // (`.xgis`, `.xgb`) as text/html; a header-based guard would reject this
    // WORKING setup. If someone "simplifies" the guard to a header check,
    // this test — and only this test — goes red.
    it('a real payload served AS text/html still passes (header is never the decision)', () => {
      const style = enc.encode('xgis 1\n\nlayer a { source: s }')
      expect(() => assertNotErrorPage(ok200('text/html'), style, 'style /a.xgis')).not.toThrow()
    })

    // The match is anchored at the head, so HTML *inside* a payload is fine.
    it('a payload merely CONTAINING html markup later in the body', () => {
      const geo = enc.encode('{"type":"Feature","properties":{"popup":"<html>hi</html>"}}')
      expect(() => assertNotErrorPage(ok200(), geo, 'geojson')).not.toThrow()
    })
  })
})
