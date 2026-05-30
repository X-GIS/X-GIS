// Untrusted-input hardening primitives shared across GeoJSON ingest and
// the remote-asset loaders (sprite / glyph / tile). One leaf module with
// no engine dependencies so every layer can import it.
//
// Three concerns:
//   - XGISError taxonomy hosts can catch (instanceof) and branch on.
//   - assertSafeRemoteUrl: SSRF guard for remote asset URLs.
//   - assertIngestBudget: OOM guard for host-pushed / fetched GeoJSON.

/** Base class for every error X-GIS throws on purpose. Hosts can
 *  `catch (e) { if (e instanceof XGISError) … }` to separate library
 *  rejections from unexpected runtime faults. */
export class XGISError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XGISError'
    // Restore the prototype chain so `instanceof` holds even if a
    // downstream embedder re-transpiles the bundle to ES5/ES2015.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Caller supplied malformed or oversized input (bad GeoJSON, over-budget
 *  feature collection, abusive nesting). */
export class XGISInputError extends XGISError {
  constructor(message: string) {
    super(message)
    this.name = 'XGISInputError'
  }
}

/** A request was refused for a security reason (disallowed URL scheme,
 *  private/loopback host — SSRF). */
export class XGISSecurityError extends XGISError {
  constructor(message: string) {
    super(message)
    this.name = 'XGISSecurityError'
  }
}

/** DoS ceilings for untrusted GeoJSON ingest. Defensive, NOT product
 *  limits — chosen well above interactive real-world data yet below the
 *  point where a single collection can OOM the tab. */
export interface IngestLimits {
  maxFeatures: number
  maxVertices: number
}

export const INGEST_LIMITS: IngestLimits = {
  maxFeatures: 1_000_000,
  maxVertices: 16_000_000,
}

/** Max coordinate/geometry nesting we will recurse into. Real GeoJSON
 *  tops out at MultiPolygon (coords nested 4 deep); a GeometryCollection
 *  adds one. 12 is generous for legitimate data and turns a deeply-nested
 *  array bomb into a bounded XGISInputError instead of a stack overflow. */
const MAX_GEOJSON_NEST = 12

interface VertexBudget {
  verts: number
  max: number
  label: string
}

/** Reject pathological GeoJSON before it is reprojected / retiled /
 *  uploaded. Checks the feature count (O(1) length) first, then walks the
 *  geometries with a running vertex counter that throws the instant the
 *  cap is crossed (true mid-traversal early-exit) and a depth cap that
 *  converts an array-nesting bomb into an XGISInputError rather than a
 *  RangeError. No-op when `features` is not an array — shape errors are
 *  handled by the caller's own validation. Throws XGISInputError. */
export function assertIngestBudget(
  features: unknown,
  label = 'GeoJSON',
  limits: IngestLimits = INGEST_LIMITS,
): void {
  if (!Array.isArray(features)) return
  if (features.length > limits.maxFeatures) {
    throw new XGISInputError(
      `[X-GIS] ${label}: ${features.length} features exceeds the ${limits.maxFeatures} ingest cap (DoS guard).`,
    )
  }
  const budget: VertexBudget = { verts: 0, max: limits.maxVertices, label }
  for (const f of features) {
    walkGeometryVertices((f as { geometry?: unknown } | null | undefined)?.geometry, budget, 0)
  }
}

function walkGeometryVertices(geometry: unknown, budget: VertexBudget, depth: number): void {
  if (depth > MAX_GEOJSON_NEST) {
    throw new XGISInputError(`[X-GIS] ${budget.label}: geometry nesting too deep (DoS guard).`)
  }
  if (!geometry || typeof geometry !== 'object') return
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown }
  if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
    for (const sub of g.geometries) walkGeometryVertices(sub, budget, depth + 1)
    return
  }
  walkCoordPairs(g.coordinates, budget, depth)
}

/** Walk a (possibly deeply nested) GeoJSON coordinates array, counting
 *  positions into `budget` and throwing the moment the cap is crossed or
 *  the nesting exceeds MAX_GEOJSON_NEST. */
function walkCoordPairs(coords: unknown, budget: VertexBudget, depth: number): void {
  if (depth > MAX_GEOJSON_NEST) {
    throw new XGISInputError(`[X-GIS] ${budget.label}: coordinate nesting too deep (DoS guard).`)
  }
  if (!Array.isArray(coords)) return
  if (typeof coords[0] === 'number') {
    budget.verts++
    if (budget.verts > budget.max) {
      throw new XGISInputError(
        `[X-GIS] ${budget.label}: vertex count exceeds the ${budget.max} ingest cap (DoS guard).`,
      )
    }
    return
  }
  for (const c of coords) walkCoordPairs(c, budget, depth + 1)
}

/** SSRF guard for remote asset URLs. Absolute URLs must use http(s) and
 *  must not target a private / loopback / link-local host. Relative URLs
 *  resolve same-origin and are allowed — EXCEPT protocol-relative
 *  ("//host/…") references, which carry a cross-origin authority and are
 *  re-checked against the private-host blocklist. Throws
 *  XGISSecurityError on a dangerous scheme or a private host. Error
 *  messages stay generic so a blocked internal host is not echoed back as
 *  a probing oracle. */
export function assertSafeRemoteUrl(raw: string, label = 'remote URL'): void {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    const trimmed = raw.trim()
    // Protocol-relative ("//host/…" or "\\host\…") carries an authority
    // that fetch() resolves cross-origin; re-parse against a dummy base
    // and block it if the resolved host is private. A public authority
    // (e.g. "//cdn.example.com/sprite") stays allowed.
    if (/^[\\/]{2}/.test(trimmed)) {
      let resolved: URL | null = null
      try {
        resolved = new URL(trimmed.replace(/\\/g, '/'), 'https://x.invalid')
      } catch {
        resolved = null
      }
      if (resolved && resolved.hostname !== 'x.invalid' && isPrivateHost(resolved.hostname)) {
        throw new XGISSecurityError(`[X-GIS] ${label}: private/loopback host blocked (SSRF guard).`)
      }
    }
    // Belt-and-suspenders: refuse a dangerous scheme a lenient parser
    // might otherwise have surfaced as "relative".
    if (/^(javascript|data|blob|file|vbscript|about):/i.test(trimmed)) {
      throw new XGISSecurityError(`[X-GIS] ${label}: disallowed URL scheme.`)
    }
    // Genuine relative (path-only) reference → same-origin, safe.
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new XGISSecurityError(`[X-GIS] ${label}: URL scheme not allowed (http/https only).`)
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new XGISSecurityError(`[X-GIS] ${label}: private/loopback host blocked (SSRF guard).`)
  }
}

/** True for loopback, private (RFC1918 / CGNAT / benchmarking), link-local,
 *  and IPv6 unique-local / link-local / IPv4-mapped hosts. Decimal / hex /
 *  octal / short-form IPv4 are already normalised to dotted-quad by the
 *  WHATWG URL parser before this runs, so only the canonical forms need
 *  matching here. A bare single-label intranet name is NOT treated as
 *  private — only the well-known reserved ranges + `localhost`. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '::') return true
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // fc00::/7 unique-local
  if (/^fe80:/.test(h)) return true // link-local
  // IPv4-mapped IPv6 (the standard SSRF bypass): new URL() renders
  // [::ffff:127.0.0.1] as either "::ffff:7f00:1" (hex hextets) or the
  // dotted tail — extract the embedded IPv4 and re-check it.
  const v4Dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4Dotted) return isPrivateHost(v4Dotted[1])
  const v4Hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (v4Hex) {
    const hi = parseInt(v4Hex[1], 16)
    const lo = parseInt(v4Hex[2], 16)
    return isPrivateHost(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = +m[1]
    const b = +m[2]
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true // link-local (incl. cloud metadata)
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
    if (h === '255.255.255.255') return true
  }
  return false
}
