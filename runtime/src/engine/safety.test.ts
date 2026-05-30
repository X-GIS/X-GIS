import { describe, it, expect } from 'vitest'
import {
  XGISError,
  XGISInputError,
  XGISSecurityError,
  assertIngestBudget,
  assertSafeRemoteUrl,
  INGEST_LIMITS,
} from './safety'

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
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]] },
    }
    expect(() => assertIngestBudget([big], 'test', limits)).toThrow(XGISInputError)
  })

  it('counts nested polygon rings and GeometryCollection members', () => {
    const poly = {
      geometry: {
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]], // 4 vertices
      },
    }
    // 4 ring vertices > the 3-vertex cap ⇒ nested-ring counting reached it.
    expect(() => assertIngestBudget([poly], 'test', { maxFeatures: 3, maxVertices: 3 })).toThrow(XGISInputError)
    const gc = {
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [0, 0] },
          { type: 'Point', coordinates: [1, 1] },
        ],
      },
    }
    expect(() => assertIngestBudget([gc], 'test', { maxFeatures: 3, maxVertices: 1 })).toThrow(XGISInputError)
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
    expect(() => assertSafeRemoteUrl('https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf')).not.toThrow()
  })

  it('allows relative (same-origin) URLs', () => {
    expect(() => assertSafeRemoteUrl('sprites/basic')).not.toThrow()
    expect(() => assertSafeRemoteUrl('/assets/glyphs/{fontstack}/{range}.pbf')).not.toThrow()
  })

  it('blocks IPv4-mapped IPv6 loopback / metadata (SSRF bypass)', () => {
    expect(() => assertSafeRemoteUrl('http://[::ffff:127.0.0.1]/x')).toThrow(XGISSecurityError)
    expect(() => assertSafeRemoteUrl('http://[::ffff:169.254.169.254]/x')).toThrow(XGISSecurityError)
  })

  it('blocks protocol-relative URLs to private hosts but allows public ones', () => {
    expect(() => assertSafeRemoteUrl('//169.254.169.254/latest/meta-data')).toThrow(XGISSecurityError)
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
    expect(() => assertIngestBudget([feature], 'big', { maxFeatures: 10, maxVertices: 10 })).toThrow(
      XGISInputError,
    )
  })
})
