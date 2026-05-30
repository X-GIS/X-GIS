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
    // Restore the prototype chain so `instanceof` holds across the
    // ES5 transpile target (extending built-ins otherwise breaks it).
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Caller supplied malformed or oversized input (bad GeoJSON, over-budget
 *  feature collection). */
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

/** Reject pathological GeoJSON before it is reprojected / retiled /
 *  uploaded. Checks the feature count (O(1) length) first, then counts
 *  vertices with an early-exit so a size-bomb is refused without a full
 *  traversal. No-op when `features` is not an array — shape errors are
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
  let verts = 0
  for (const f of features) {
    verts += countGeometryVertices((f as { geometry?: unknown } | null | undefined)?.geometry)
    if (verts > limits.maxVertices) {
      throw new XGISInputError(
        `[X-GIS] ${label}: vertex count exceeds the ${limits.maxVertices} ingest cap (DoS guard).`,
      )
    }
  }
}

function countGeometryVertices(geometry: unknown): number {
  if (!geometry || typeof geometry !== 'object') return 0
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown }
  if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
    let n = 0
    for (const sub of g.geometries) n += countGeometryVertices(sub)
    return n
  }
  return countCoordPairs(g.coordinates)
}

/** Count coordinate positions in a (possibly deeply nested) GeoJSON
 *  coordinates array. A position is `[number, number, …]`; deeper arrays
 *  are rings / polygons / multi-geometries. */
function countCoordPairs(coords: unknown): number {
  if (!Array.isArray(coords)) return 0
  if (typeof coords[0] === 'number') return 1
  let n = 0
  for (const c of coords) n += countCoordPairs(c)
  return n
}

/** SSRF guard for remote asset URLs. Absolute URLs must use http(s) and
 *  must not target a private / loopback / link-local host. Relative URLs
 *  resolve same-origin and are allowed. Throws XGISSecurityError on a
 *  dangerous scheme or a private host. */
export function assertSafeRemoteUrl(raw: string, label = 'remote URL'): void {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // Unparseable as an absolute URL ⇒ relative (no scheme/host) ⇒
    // same-origin, safe. Belt-and-suspenders: still refuse a dangerous
    // scheme that a lenient parser might have let through as "relative".
    if (/^\s*(javascript|data|blob|file|vbscript|about):/i.test(raw)) {
      throw new XGISSecurityError(`[X-GIS] ${label}: disallowed scheme in "${raw}".`)
    }
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new XGISSecurityError(
      `[X-GIS] ${label}: protocol "${parsed.protocol}" is not allowed (http/https only).`,
    )
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new XGISSecurityError(
      `[X-GIS] ${label}: private/loopback host "${parsed.hostname}" is blocked (SSRF guard).`,
    )
  }
}

/** True for loopback, private (RFC1918), link-local, and IPv6
 *  unique-local / link-local hosts. Conservative: a bare single-label
 *  host (e.g. an intranet name) is NOT treated as private here — only
 *  the well-known reserved ranges + `localhost`. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '::') return true
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // fc00::/7 unique-local
  if (/^fe80:/.test(h)) return true // link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = +m[1]
    const b = +m[2]
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
  }
  return false
}
