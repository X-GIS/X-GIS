// ═══ Is this coverage a VECTOR FIELD, and which bands carry it? (#1333) ═══
//
// SINGLE AUTHORITY for the question every vector-field consumer must ask first: the arrow
// portrayal, the flow-field upload, and anything later (GFS wind, #1273). They must agree,
// because disagreeing means one of them draws a field the other says does not exist.
//
// WHY THIS EXISTS — a proven defect, not a hypothetical. `coverage-arrow-show.ts` resolved
// its bands as:
//
//     bands.find(b => b.header.name === 'surfaceCurrentSpeed')     ?? bands[0]
//     bands.find(b => b.header.name === 'surfaceCurrentDirection') ?? bands[1]
//
// The index fallback exists for a legitimate reason (an S-111-shaped file whose producer used
// non-conforming band names), but it cannot tell "S-111 with odd names" from "not a vector
// field at all". Fed a real S-102 bathymetry coverage — bands `depth` and `uncertainty`, both
// in metres — it silently resolved depth AS SPEED and uncertainty AS DIRECTION, and drew four
// arrows whose bearings were uncertainty values in metres read as degrees:
//
//     arrows emitted : 4          (expected 0)
//     bearings (deg) : [0.5, 1.2, 0.3, 2]        ← metres of uncertainty
//     sizes (px)     : [81.6, 88.4, 34, 88.4]    ← depth scaled as if knots
//
// On a navigation-adjacent surface that is silently wrong information, so the fallback is
// narrowed rather than removed: it still rescues an oddly-named vector field, but only when
// the second band's UNIT says it is an angle. A scalar coverage has no angular band, so it
// can no longer masquerade as one.

import type { CoverageHandle } from '@xgis/data'

/** S-111's conforming band names — matched first, before any fallback. */
const SPEED_NAME = 'surfaceCurrentSpeed'
const DIRECTION_NAME = 'surfaceCurrentDirection'

/** Units that denote an ANGLE. The S-100 vocabulary is `arc-degrees`; the others are the
 *  spellings real producers emit. A band measured in metres, knots or seconds is not a
 *  direction, which is exactly what disqualifies a bathymetry pair. */
const ANGULAR_UNITS = new Set(['arc-degrees', 'arc-degree', 'degrees', 'degree', 'deg'])

export interface VectorBands {
  /** Magnitude values (S-111: surface current speed). */
  speed: Float32Array
  /** Direction values, degrees true clockwise from north (S-111 convention). */
  direction: Float32Array
  /** The u16 quantization codes, when the reader kept them — nodata is exact through these. */
  speedCodes?: Uint16Array
  directionCodes?: Uint16Array
}

function isAngular(unit: string | undefined): boolean {
  return unit !== undefined && ANGULAR_UNITS.has(unit.trim().toLowerCase())
}

/** Resolve the magnitude+direction pair, or null when this coverage is NOT a vector field.
 *
 *  Null is the answer for every scalar coverage — S-102 bathymetry above all — and callers
 *  must treat it as "draw nothing, allocate nothing" rather than as an error: a bathymetry
 *  layer is not malformed, it simply has no current to portray. */
export function resolveVectorBands(handle: CoverageHandle): VectorBands | null {
  const bands = handle.bands
  const byName = (n: string) => bands.find((b) => b.header.name === n)

  const namedSpeed = byName(SPEED_NAME)
  const namedDir = byName(DIRECTION_NAME)
  if (namedSpeed && namedDir) return pair(namedSpeed, namedDir)

  // Fallback: an oddly-named vector field. Admitted ONLY on the unit evidence — without it
  // this branch is what let a depth/uncertainty pair render as a current field.
  const s = bands[0]
  const d = bands[1]
  if (!s || !d) return null
  if (!isAngular(d.header.unit)) return null
  return pair(s, d)
}

function pair(s: CoverageHandle['bands'][number], d: CoverageHandle['bands'][number]): VectorBands {
  return {
    speed: s.values,
    direction: d.values,
    ...(s.codes ? { speedCodes: s.codes } : {}),
    ...(d.codes ? { directionCodes: d.codes } : {}),
  }
}

/** Cheap predicate for the arming/allocation gates — "does this coverage animate at all?".
 *  Equivalent to `resolveVectorBands(handle) !== null`, named for the call sites that only
 *  need the yes/no (the flow-field upload must allocate NOTHING for a scalar coverage). */
export function isVectorFieldCoverage(handle: CoverageHandle): boolean {
  return resolveVectorBands(handle) !== null
}
