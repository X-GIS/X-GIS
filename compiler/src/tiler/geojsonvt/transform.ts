// 1:1 port of geojson-vt/src/transform.js — Mercator-projected
// space → (extent × extent) tile-local integer coordinates.

import type {
  InternalTile,
  TransformedTile,
  TileFeature,
  TransformedTileFeature,
  FlatLine,
} from './types'

// In-place type transmutation — the three `as unknown as` bridges below
// are deliberate, mirroring upstream geojson-vt's mutate-in-place design.
// transformTile rewrites each feature's `geometry` from FlatLine shape
// (flat x,y,z runs) into tuple-pair shape ([x, y] pairs) ON THE SAME
// object and flips `transformed` to true, rather than allocating a
// parallel TransformedTile — one fewer allocation per tile. The object's
// logical type legitimately changes after that mutation (TileFeature →
// TransformedTileFeature, InternalTile → TransformedTile); TypeScript has
// no syntax for an in-place type change, so the reinterpretation bridges
// through `unknown` at the three marked sites.
export function transformTile(tile: InternalTile, extent: number): TransformedTile {
  if (tile.transformed) return tile as unknown as TransformedTile

  const z2 = 1 << tile.z
  const tx = tile.x
  const ty = tile.y

  for (const feature of tile.features as TileFeature[]) {
    const geom = feature.geometry
    const type = feature.type

    const tFeature = feature as unknown as TransformedTileFeature
    tFeature.geometry = []

    if (type === 1) {
      const flat = geom as FlatLine
      for (let j = 0; j < flat.length; j += 2) {
        ;(tFeature.geometry as [number, number][]).push(
          transformPoint(flat[j], flat[j + 1], extent, z2, tx, ty),
        )
      }
    } else {
      const rings = geom as FlatLine[]
      for (let j = 0; j < rings.length; j++) {
        const ring: [number, number][] = []
        const r = rings[j]
        for (let k = 0; k < r.length; k += 2) {
          ring.push(transformPoint(r[k], r[k + 1], extent, z2, tx, ty))
        }
        ;(tFeature.geometry as [number, number][][]).push(ring)
      }
    }
  }

  tile.transformed = true
  return tile as unknown as TransformedTile
}

function transformPoint(
  x: number,
  y: number,
  extent: number,
  z2: number,
  tx: number,
  ty: number,
): [number, number] {
  return [Math.round(extent * (x * z2 - tx)), Math.round(extent * (y * z2 - ty))]
}
