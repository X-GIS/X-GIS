// Public types for the host DRAWING API's retained batch surface (#797 Phase 1).
//
// A retained batch is authored declaratively — `data` + per-item ACCESSORS. An
// accessor is either a CONSTANT (packs one shared value) or a FUNCTION run ONCE
// at add()/update() to pack a static per-item attribute. It is NEVER re-invoked
// per frame: a camera move rewrites only the frame uniform, so the accessor's
// purity contract is "must not read the live camera/zoom" (that would silently
// freeze at add()-time). Per-frame data-driven styling routes through a compiled
// `.xgis` layer, not a host closure — this is the retained-perf thesis.

/** Geo anchor `[lon, lat]` in degrees (WGS84), matching `map.addOverlay`. */
export type Position = readonly [number, number]

/** A CONSTANT (shared) or a run-ONCE function packing a per-item attribute.
 *  `(d, index)` — bare index, NOT a `{index}` box (100k throwaway objects would
 *  defeat the flat-array pack the perf thesis depends on). */
export type Packed<T, D> = T | ((d: D, index: number) => T)

/** Tint colour — a hex string (`'#rrggbb'` / `'#rrggbbaa'`) or an rgba tuple in
 *  0..1. Default white = identity (the sprite renders untinted). */
export type IconColor = string | readonly [number, number, number, number]

/** Quad anchor relative to the geo point — LAYER level (never per-item: a
 *  per-item anchor box at 100k allocates 100k objects and defeats the flat pack).
 *  Mirrors the screen-px icon anchors. */
export type IconAnchor =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

/** The attributes an `update({ triggers })` can surgically re-pack. `color`
 *  re-uploads ONLY the tint buffer (one writeBuffer); the others re-pack the
 *  whole feat buffer (a documented Phase-1 coarser boundary — the gate exercises
 *  the tint case). */
export type IconUpdateTrigger = 'position' | 'color' | 'size' | 'rotation' | 'image'

/** Declarative spec for a retained geo-anchored ICON batch (`map.graphics.add`). */
export interface IconDrawSpec<D> {
  readonly type: 'icon'
  readonly data: readonly D[]
  /** Geo anchor per item — the ONE required accessor. */
  readonly getPosition: Packed<Position, D>
  /** Registered sprite name (map.addImage / map.graphics.addImage). */
  readonly getImage: Packed<string, D>
  /** Scale on the sprite's native pixel size (1 = registered px). Default 1. */
  readonly getSize?: Packed<number, D>
  /** Tint modulate (works on raster host icons). Default white = identity. */
  readonly getColor?: Packed<IconColor, D>
  /** Icon rotation in radians (screen-space clockwise). Default 0. */
  readonly getRotation?: Packed<number, D>
  /** Layer-level quad anchor. Default 'center'. */
  readonly anchor?: IconAnchor
  /** Marks which attributes a later `update({ triggers })` will re-pack. */
  readonly updateTriggers?: Partial<Record<IconUpdateTrigger, unknown>>
}

/** Declarative spec for a retained geo-anchored ARROW batch — the movement vector-field
 *  glyph (`map.graphics.add`). Same retained/N-independent contract as `IconDrawSpec`, but
 *  the silhouette is a procedural oriented arrow mesh (no sprite): per item a geo anchor
 *  (the arrow tail), a screen-space rotation, a length, and a colour. */
export interface ArrowDrawSpec<D> {
  readonly type: 'arrow'
  readonly data: readonly D[]
  /** Geo anchor per item (the arrow TAIL) — the ONE required accessor. */
  readonly getPosition: Packed<Position, D>
  /** GEOGRAPHIC bearing the arrow points along, in degrees (0 = north, clockwise). Projected on
   *  the GPU from two geo points, so it stays correct under camera bearing / pitch / globe.
   *  Default 0 (north). */
  readonly getBearing?: Packed<number, D>
  /** Arrow LENGTH in px (tail→tip). Default 1. */
  readonly getSize?: Packed<number, D>
  /** Solid fill colour. Default white. */
  readonly getColor?: Packed<IconColor, D>
  /** Marks which attributes a later `update({ triggers })` will re-pack. */
  readonly updateTriggers?: Partial<Record<IconUpdateTrigger, unknown>>
}

/** Declarative spec for a retained geo-anchored CIRCLE (disc) batch — the simplest primitive
 *  (`map.graphics.add`). Same retained/N-independent contract as `IconDrawSpec`, but the silhouette
 *  is a procedural disc SDF (no sprite): per item a geo anchor, a pixel radius, a fill colour, and
 *  an optional inset stroke. Renders through the SAME disc SDF as a tile/inline point, so a retained
 *  circle is pixel-identical to a styled point of the same radius/fill/stroke. */
export interface CircleDrawSpec<D> {
  readonly type: 'circle'
  readonly data: readonly D[]
  /** Geo anchor per item (the disc CENTRE) — the ONE required accessor. */
  readonly getPosition: Packed<Position, D>
  /** Disc radius in px (fill edge). Default 4. */
  readonly getRadius?: Packed<number, D>
  /** Fill colour. Default white. */
  readonly getColor?: Packed<IconColor, D>
  /** Inset stroke (ring) colour. Default transparent = no stroke. */
  readonly getStrokeColor?: Packed<IconColor, D>
  /** Inset stroke width in px. Default 0 = no stroke. */
  readonly getStrokeWidth?: Packed<number, D>
  /** Marks which attributes a later `update({ triggers })` will re-pack. */
  readonly updateTriggers?: Partial<Record<IconUpdateTrigger, unknown>>
}

/** Declarative spec for a retained geo-anchored PARTICLE-FLOW batch — the wind-map aesthetic
 *  (`map.graphics.add`, #826). Unlike the other primitives, `data` is the PER-GU FIELD (design
 *  §2.1), NOT a per-instance list: the packer EXPANDS it into a fixed pool of drifting particles,
 *  allocating MORE particles to a busier gu so DENSITY ∝ volume (design §2.3). Each particle drifts
 *  along its home-gu outflow direction and respawns — the closed-form stateless drift (candidate b,
 *  design §3.2), so it renders on BOTH backends and verifies deterministically at a pinned clock.
 *  All allocation/animation knobs are optional with the design's recommended defaults (§5). */
export interface ParticleFlowDrawSpec<D> {
  readonly type: 'particle-flow'
  /** The per-gu field cells (e.g. 25 gu) — NOT a per-particle list. */
  readonly data: readonly D[]
  /** Gu centroid — the seed origin the particles jitter around (design §5-Q5). Required. */
  readonly getPosition: Packed<Position, D>
  /** GEOGRAPHIC outflow bearing the particles drift along, in degrees (0 = north, clockwise).
   *  Projected on the GPU from two geo points, so it stays correct under camera / pitch / globe.
   *  Default 0 (north). */
  readonly getBearing?: Packed<number, D>
  /** RAW outflow volume for this gu — drives density ∝ volume (design §2.3, §5-Q3: RAW, not the
   *  √-compressed arrow-length channel). Default 1 (uniform density). */
  readonly getVolume?: Packed<number, D>
  /** Per-gu particle colour. Default white. */
  readonly getColor?: Packed<IconColor, D>
  /** Target TOTAL particle count across the field (design §2.3 N_cap). Default 4096. */
  readonly particleCount?: number
  /** Hard ceiling on the total (design §2.3, power-of-two headroom). Default 16384. */
  readonly maxParticles?: number
  /** Floor of particles per gu so the quietest still shows motion (design §5-Q4). Default 8. */
  readonly minPerCell?: number
  /** Jitter radius around the centroid, in metres (design §5-Q5). Default 1200. */
  readonly seedRadiusMeters?: number
  /** Drift length in px a particle travels over ONE lifetime. Default 40. */
  readonly driftPx?: number
  /** Particle lifetime (drift-and-respawn period) in seconds. Default 2.5. */
  readonly lifetimeSeconds?: number
  /** Particle disc radius in px. Default 2. */
  readonly particleRadiusPx?: number
  /** PRNG seed for the deterministic jitter/phase (the §5 pinned-`t` reproducibility). Default 1. */
  readonly seed?: number
  /** Marks which attributes a later `update({ triggers })` will re-pack. */
  readonly updateTriggers?: Partial<Record<IconUpdateTrigger, unknown>>
}

/** Declarative spec for a retained geo-anchored STATIC TEXT batch (`map.graphics.add`). Same
 *  retained/N-independent contract as `IconDrawSpec`: the string is SHAPED EXACTLY ONCE at
 *  add()/update() through the shared SDF glyph atlas (never per frame), and every glyph becomes
 *  ONE GPU instance anchored at the label's geo point plus a baked per-glyph screen-space offset,
 *  so a camera move rewrites only the frame uniform. Glyph shaping is READ-ONLY reuse of the
 *  existing glyph-atlas machinery (`GlyphAtlasHost.ensureString`) — this API never forks glyph
 *  layout. `getText` is packed once like any other accessor; a later CONTENT change is a re-add
 *  (it changes the glyph/instance count), not an in-place `update()`. */
export interface TextDrawSpec<D> {
  readonly type: 'text'
  readonly data: readonly D[]
  /** Geo anchor per item (the label position) — a required accessor. */
  readonly getPosition: Packed<Position, D>
  /** The label string per item — a required accessor. Shaped ONCE at pack time. */
  readonly getText: Packed<string, D>
  /** Font size in px (pre-DPR design px, × DPR at pack time). Default 16. */
  readonly getSize?: Packed<number, D>
  /** Fill colour. Default white. */
  readonly getColor?: Packed<IconColor, D>
  /** Layer-level block anchor — which point of the text block sits on the geo point (MapLibre
   *  text-anchor semantics). Default 'center'. LAYER level, never per-item (a per-item anchor box
   *  at 100k allocates 100k objects and defeats the flat pack) — mirrors `IconDrawSpec.anchor`. */
  readonly anchor?: IconAnchor
  /** Layer-level font key handed to the glyph shaper. Default = the shaper's default font. LAYER
   *  level (a per-item font would fork the shaping key per datum against the flat-pack thesis). */
  readonly font?: string
  /** Marks which attributes a later `update({ triggers })` will re-pack (text honours
   *  'position' | 'color' | 'size'; 'color' re-uploads ONLY the tint buffer). */
  readonly updateTriggers?: Partial<Record<IconUpdateTrigger, unknown>>
}

/** Any retained batch spec accepted by `map.graphics.add` — discriminated by `type`. */
export type DrawSpec<D> =
  IconDrawSpec<D> | ArrowDrawSpec<D> | CircleDrawSpec<D> | ParticleFlowDrawSpec<D> | TextDrawSpec<D>

/** Handle to a live retained batch. `D` is the datum type the batch was authored
 *  over; it defaults to `unknown` so a bare `DrawHandle` reference stays valid. */
export interface DrawHandle<D = unknown> {
  /** Items currently drawn by this handle (the seed batch + any `append()`s). */
  readonly count: number
  /** Re-run the named accessors and re-upload their attribute(s). `['color']`
   *  re-uploads ONLY the tint buffer; other triggers re-pack the feat buffer. */
  update(patch: { readonly triggers: readonly IconUpdateTrigger[] }): void
  /** Append rows WITHOUT re-uploading the existing ones (#797 P2a — the
   *  incremental "O(changed)" lever). The new rows are packed into a SEPARATE
   *  retained batch with its OWN feat/tint buffers, so the seed batch's GPU bytes
   *  are never touched and its accessors are never re-run — only the appended data
   *  is packed + uploaded. Each `append()` is an independent pack, so its rows are
   *  indexed 0-based within the call (not continued from the seed's count). */
  append(data: readonly D[]): void
  /** Remove the batch (frees its GPU buffers). */
  remove(): void
}
