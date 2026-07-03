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

/** Handle to a live retained batch. */
export interface DrawHandle {
  /** Icons currently in the batch. */
  readonly count: number
  /** Re-run the named accessors and re-upload their attribute(s). `['color']`
   *  re-uploads ONLY the tint buffer; other triggers re-pack the feat buffer. */
  update(patch: { readonly triggers: readonly IconUpdateTrigger[] }): void
  /** Remove the batch (frees its GPU buffers). */
  remove(): void
}
