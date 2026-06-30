// ═══ X-GIS ViewportModeController — projection-mode + graticule cluster ═══
//
// Second structural decomposition of XGISMap (sibling of CameraController /
// SourceManager / InteractionController): the projection-MODE switch + the
// graticule overlay toggle live here. XGISMap keeps the shared `Camera`
// instance and delegates to a single ViewportModeController constructed in
// its ctor.
//
// BEHAVIOR + PUBLIC API IDENTICAL — every method below is moved verbatim
// from map.ts; only the dependency wiring changed:
//   - `this.projectionName`   → owned here (XGISMap exposes a field-read getter)
//   - `this._graticuleInitial` → owned here
//   - `this.camera.*`          → injected `camera` reference
//   - `this.renderer?.…`       → injected `getRenderer()` accessor (lazy → may be undefined)
//   - the world-band-change bg rebuild (fused with STYLE state, stays on
//     map.ts) → injected `onWorldBandChange(prevProj, canonical)` callback,
//     invoked at the EXACT position the inline block occupied so the
//     bg-rebuild → camera-writes → tag/invalidate order is byte-identical.
//
// EXPLICITLY NOT HERE (false-boundary #1, plan §5): `setBackgroundFill`,
// `_installSyntheticEarthSurfaceSource`, `_backgroundColor`, `_syntheticBackend`
// stay on map.ts — they are fused with the STYLE/SOURCE cluster
// (`teardownSource` / `rawDatasets` / `showCommands` / VTR+TileCatalog). This
// controller must NEVER touch them; it only SIGNALS a world-band change.

import type { Camera } from '@xgis/engine'
import type { MapRendererContent } from './renderer'
import { xlog } from '../log'

// One-shot guard for the setPolarCapsEnabled deprecation warning.
// Repeated calls share this module-scoped flag and emit at most one xlog.warn
// per session.
let _polarCapsWarned = false

/** Dependencies ViewportModeController needs from the host XGISMap. */
export interface ViewportModeControllerDeps {
  /** Active MapRenderer, or undefined before `run()` populates it. Graticule
   *  delegates to `renderer.setGraticuleEnabled` / `isGraticuleEnabled`;
   *  kept optional to preserve the host's `this.renderer?.…` semantics. */
  getRenderer(): MapRendererContent | undefined
  /** Run the world-band-change synthetic-backend rebuild ON map.ts (the
   *  bg-fill state is STYLE-fused and stays there — plan §5 false-boundary
   *  #1). Invoked from `setProjection` at the exact position the inline
   *  `setBackgroundFill(null)→setBackgroundFill(rgba)` block occupied, so
   *  the band-change → camera-writes ordering is unchanged. */
  onWorldBandChange(prevProj: string, canonical: string): void
}

export class ViewportModeController {
  private readonly camera: Camera
  private readonly getRenderer: () => MapRendererContent | undefined
  private readonly onWorldBandChange: (prevProj: string, canonical: string) => void

  /** The active projection's canonical name. XGISMap exposes a field-read
   *  getter that returns this (RenderLoop / label-pass read it through the
   *  host view as `host.projectionName`). */
  projectionName = 'mercator'

  /** Captured at ctor time so run() can apply it once MapRenderer exists. */
  graticuleInitial = false

  constructor(camera: Camera, deps: ViewportModeControllerDeps) {
    this.camera = camera
    this.getRenderer = deps.getRenderer
    this.onWorldBandChange = deps.onWorldBandChange
  }

  /** Change projection at runtime — GPU uniform only, no re-tessellation!
   *  Returns `false` when the name was rejected (so the forwarder skips its
   *  tag/invalidate); `true` when the switch applied. */
  setProjection(name: string): boolean {
    // Normalize common aliases so URL `?proj=equirect` / Monaco's
    // hyphen-separated names ('natural-earth') resolve to the canonical
    // key the projType lookup uses. Unknown values silently fell back to
    // mercator (renderFrame's `?? 0`) — a silent footgun.
    const ALIASES: Record<string, string> = {
      equirect: 'equirectangular',
      'natural-earth': 'natural_earth',
      // Mapbox style-spec `projection` uses camelCase type names; map the
      // ones with an X-GIS equivalent (naturalEarth → natural_earth). The
      // matching names (mercator / globe / equirectangular) need no alias.
      // Mapbox-only types (albers / equalEarth / lambertConformalConic /
      // winkelTripel) have no X-GIS surface → fall through to the VALID
      // gate below and warn + keep the current projection.
      naturalEarth: 'natural_earth',
      'azimuthal-equidistant': 'azimuthal_equidistant',
      'oblique-mercator': 'oblique_mercator',
    }
    const canonical = ALIASES[name] ?? name
    // Validate the canonical name is one the renderFrame projType
    // lookup recognises. Pre-fix an unknown name (`setProjection
    // ("globey")`) silently fell to mercator at renderFrame (`?? 0`)
    // — a debugging footgun. Warn loudly + drop the call so the
    // previous projection stays active.
    const VALID = new Set([
      'mercator', 'equirectangular', 'natural_earth',
      'orthographic', 'azimuthal_equidistant', 'stereographic',
      'oblique_mercator', 'globe',
    ])
    if (!VALID.has(canonical)) {
      xlog.warn(`[X-GIS] setProjection: unknown projection "${name}" — keeping "${this.projectionName}". Valid: ${[...VALID].join(', ')}.`)
      return false
    }
    const prevProj = this.projectionName
    this.projectionName = canonical
    name = canonical

    // Re-install the synthetic earth-surface backend when the world-band kind
    // changes (mercator-clamped ↔ sphere-full ↔ natural-earth) so the bg mesh
    // latitude extent — and its GPU vertex buffer — tracks the projection.
    // Band-preserving switches (e.g. mercator↔equirectangular, both
    // mercator-clamped) skip the teardown/rebuild. Color is unchanged, so we
    // round-trip the existing fill through the teardown + re-install path.
    // The bg-fill state is STYLE-fused and lives on map.ts (plan §5
    // false-boundary #1); this callback runs that rebuild in place.
    this.onWorldBandChange(prevProj, canonical)

    // Adjust zoom for different projection scale
    // The wide-view set (flat azimuthal discs + the true 3D globe) all
    // frame the whole earth, so they need the zoomed-out view.
    const isWideView = (n: string) =>
      ['orthographic', 'azimuthal_equidistant', 'stereographic', 'globe'].includes(n)
    if (!isWideView(prevProj) && isWideView(name)) {
      this.camera.zoom = Math.min(this.camera.zoom, 1.5)
    } else if (isWideView(prevProj) && !isWideView(name)) {
      this.camera.zoom = Math.max(this.camera.zoom, 1.5)
    }

    // The azimuthal projections (ortho / azimuthal_equidistant /
    // stereographic) are exact 2D discs at pitch=0. A pitched 2D camera
    // would just lay the disc on its side, so instead of locking pitch
    // we promote them to the true 3D sphere when tilted: renderFrame
    // flips them to the globe vertex path (projType 7) with an
    // ORTHOGRAPHIC orbit camera (camera.globeOrtho) once pitch>0, giving
    // a real parallel-projection 3D tilt that is byte-identical to the
    // 2D disc at pitch=0 (orthographic projection of a sphere from the
    // surface normal IS the disc). pitch is no longer locked; it starts
    // at 0 on a projection switch so the view opens flat/exact.
    const AZIMUTHAL = ['orthographic', 'azimuthal_equidistant', 'stereographic']
    const isAzimuthal = AZIMUTHAL.includes(name)
    this.camera.pitchLocked = false
    if (isAzimuthal || name === 'globe') this.camera.pitch = 0
    // Azimuthal-when-tilted uses the parallel (orthographic) orbit
    // camera; the true `globe` keeps its perspective orbit camera.
    this.camera.globeOrtho = isAzimuthal

    // True 3D globe always emits the orbit view-projection; the
    // azimuthal set switches to it dynamically in renderFrame when
    // pitch>0 (renderers branch on projType 7).
    this.camera.globeMode = name === 'globe'
    return true
  }

  getProjectionName(): string {
    return this.projectionName
  }

  /** Toggle the lat/lon grid overlay. Default off. The caller (map.ts
   *  forwarder) tags DirtyDomain.STYLE + invalidates, matching the original
   *  `setGraticuleEnabled` tail order. */
  setGraticuleEnabled(on: boolean): void {
    this.getRenderer()?.setGraticuleEnabled(on)
    this.graticuleInitial = on
  }

  /** Current graticule on/off state. */
  isGraticuleEnabled(): boolean {
    return this.getRenderer()?.isGraticuleEnabled() ?? this.graticuleInitial
  }

  /** @deprecated Phase 1a (Tier 3 source-honest principle): polar-cap
   *  synthesis is no longer renderer-driven. Preprocess GeoJSON with
   *  `injectPolarCaps` / `synthesizePolarCaps` (re-exported from
   *  `@xgis/runtime`) before `setSourceData`. This setter is a no-op +
   *  one-shot `xlog.warn` so existing host code does not throw. */
  setPolarCapsEnabled(_on: boolean): void {
    if (_polarCapsWarned) return
    _polarCapsWarned = true
    xlog.warn(
      '[X-GIS] setPolarCapsEnabled is no longer renderer-driven. ' +
      'Use the injectPolarCaps / synthesizePolarCaps exports as a pre-processing ' +
      'step on your data, or accept honest source coverage.',
    )
  }

  /** @deprecated Always returns `false` post-Phase 1a — polar-cap synthesis
   *  is no longer renderer-driven (see `setPolarCapsEnabled`). */
  isPolarCapsEnabled(): boolean { return false }
}
