// ═══ Map-level `error` event payload ═══
//
// Extracted from layer.ts, which sits on a shrink-only LOC ceiling. These two
// types are a self-contained cluster — nothing else in layer.ts refers to them
// and they refer to nothing there — so they lift out without a seam. Re-exported
// from layer.ts, so every existing `import { XGISMapErrorInfo } from './layer'`
// keeps working.

/** Phase of a fired map-level `'error'` event. `'gpufault'` (#1599) is an async
 *  GPU validation/OOM fault reaching the typed map `'error'` channel instead of
 *  only the console. */
export type XGISMapErrorPhase = 'boot' | 'devicelost' | 'halt' | 'gpufault' | 'source'

/** Payload carried by a map-level `'error'` event (on the XGISMapEvent). `fatal`
 *  separates an unrecoverable stop (boot failure, 3-strike halt) from a
 *  recoverable fault the engine auto-recovers from (device loss); `error` is the
 *  underlying cause (an Error, a RhiDeviceLostInfo, …). */
export interface XGISMapErrorInfo {
  phase: XGISMapErrorPhase
  fatal: boolean
  error: unknown
  /** Which source failed, on `phase: 'source'`. Absent for every other phase.
   *
   *  A source-load failure used to reach the host through `console.error` and
   *  nothing else (#1364), so an embedding app could not tell a healthy map from
   *  one whose only data source is dead — it could not even name the layer to
   *  warn about. The two failure paths still behave differently, deliberately:
   *  a GeoJSON URL failure keeps the documented fail-the-run contract
   *  (`fatal: true`, and `run()` still rejects), while a TileJSON/PMTiles
   *  manifest failure is a soft-fail that leaves the rest of the map running
   *  (`fatal: false`). `fatal` is what distinguishes them. */
  source?: string
}
