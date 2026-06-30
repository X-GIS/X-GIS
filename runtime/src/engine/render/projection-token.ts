// ═══ Opaque per-frame projection token (content-owned) ═══
//
// The engine `FrameContext` (frame-context.ts) carries ONE of these per frame
// and transports it frame-to-frame, but it can NEVER decode it: `ProjectionToken`
// exposes no readable members, so engine code that reaches for `.projType` /
// `.centerLon` / `.centerLat` fails to type-check. Only content code — the draw
// closures + the background / opaque / points / heatmap / label passes that own
// the projection-specific shader/draw signatures — unwraps it via
// `unwrapProjection()`. This is the P2-carve §3 inversion: the engine frame
// struct is projection-blind; the projection triple lives behind a content
// handle.
//
// The token is MINTED from values the render loop already computes for the
// camera (the azimuthal-when-tilted projType + the RTC-centre lon/lat); minting
// is a pure bundling, so the unwrapped triple is byte-identical to the former
// `ctx.projType / ctx.centerLon / ctx.centerLat` scalars. To honour the
// allocation-paranoid 60 Hz loop, the token is allocated ONCE (with the reused
// FrameContext) and repopulated in place each frame via `setProjectionToken`.

declare const PROJECTION_TOKEN_BRAND: unique symbol

/** Opaque projection handle. Engine transports it on FrameContext but has no
 *  way to read the projection triple it wraps (the brand is its only typed
 *  member). Content mints it (`makeProjectionToken` / `setProjectionToken`) and
 *  decodes it (`unwrapProjection`). */
export interface ProjectionToken {
  readonly [PROJECTION_TOKEN_BRAND]: true
}

/** The decoded projection triple — content-only. */
export interface ProjectionValues {
  /** Resolved numeric projection kind (mercator=0 … globe=7), already promoted
   *  to 7 for azimuthal-when-tilted. */
  readonly projType: number
  /** Camera-centre longitude in degrees (RTC projection centre). */
  readonly centerLon: number
  /** Camera-centre latitude in degrees, clamped to the projection pole limit. */
  readonly centerLat: number
}

/** Internal mutable backing shape — never surfaced through `ProjectionToken`. */
interface MutableProjection {
  projType: number
  centerLon: number
  centerLat: number
}

/** Allocate the reused projection token (once, alongside the FrameContext). */
export function makeProjectionToken(
  projType: number, centerLon: number, centerLat: number,
): ProjectionToken {
  return { projType, centerLon, centerLat } as unknown as ProjectionToken
}

/** Repopulate the reused token in place — the 60 Hz loop reuses one instance
 *  rather than allocating a fresh token per frame. */
export function setProjectionToken(
  token: ProjectionToken, projType: number, centerLon: number, centerLat: number,
): void {
  const m = token as unknown as MutableProjection
  m.projType = projType
  m.centerLon = centerLon
  m.centerLat = centerLat
}

/** Decode the token — content-side only. Returns the live backing object (the
 *  token is mutated in place each frame), so callers must read the triple
 *  synchronously rather than retaining the result across frames. */
export function unwrapProjection(token: ProjectionToken): ProjectionValues {
  return token as unknown as ProjectionValues
}
