// Encode a tiled feature set into MVT (Mapbox Vector Tile) PBF bytes.
//
// Algorithm: standard MVT v2.1 spec encoding (Tile → Layer → Feature
// → packed geometry commands). The layout mirrors what vt-pbf
// produces but skips the wrapper indirection — our TransformedTile
// already exposes the per-feature geometry as [number, number][] /
// [number, number][][], so the encoder reads it directly.
//
// The output bytes are decoded by the existing MVT worker
// (compiler/src/input/mvt-decoder.ts uses @mapbox/vector-tile + pbf),
// so the GeoJSON tiling path and the PMTiles path converge on the
// same downstream pipeline.

import Pbf from 'pbf'
import type { TransformedTile, TransformedTileFeature } from './types'

/** MVT Tile messages can contain multiple Layers; we usually emit
 *  one layer per GeoJSON source, but the encoder takes a map so
 *  callers can pack several layers into one tile when sources share
 *  the same (z, x, y) address. */
export interface MVTLayerInput {
  /** Layer name as seen by the renderer's `sourceLayer:` filter. */
  name: string
  /** Tile from `GeoJSONVT.getTile()` — geometry already in extent
   *  units (the transform pass quantized to 16-bit ints). */
  tile: TransformedTile
}

export interface EncodeOptions {
  /** MVT spec version. Default 2 — matches PMTiles archives the
   *  runtime currently reads. */
  version?: number
  /** Tile extent in coordinate units. Must match the geojsonvt
   *  GeoJSONVTOptions.extent that produced `tile`. Default 8192. */
  extent?: number
}

/** Encode one or more tiled layers at the same tile address into a
 *  single MVT PBF byte array.
 *
 *  Returns an empty `Uint8Array` if no layer contains any feature —
 *  callers should treat empty bytes as "tile has no data" rather
 *  than "tile failed to encode". */
export function encodeMVT(
  layers: MVTLayerInput[],
  options: EncodeOptions = {},
): Uint8Array {
  const version = options.version ?? 2
  const extent = options.extent ?? 8192

  const pbf = new Pbf()
  for (const layer of layers) {
    if (layer.tile.features.length === 0) continue
    pbf.writeMessage(3, writeLayer, { name: layer.name, features: layer.tile.features, version, extent })
  }
  return pbf.finish()
}

interface LayerContext {
  name: string
  features: TransformedTileFeature[]
  version: number
  extent: number
}

interface FeatureContext {
  feature: TransformedTileFeature
  keys: string[]
  values: unknown[]
  keycache: Map<string, number>
  valuecache: Map<string, number>
}

function writeLayer(layer: LayerContext, pbf: Pbf): void {
  pbf.writeVarintField(15, layer.version)
  pbf.writeStringField(1, layer.name)
  pbf.writeVarintField(5, layer.extent)

  const keys: string[] = []
  const values: unknown[] = []
  const keycache = new Map<string, number>()
  const valuecache = new Map<string, number>()

  for (const feature of layer.features) {
    const ctx: FeatureContext = { feature, keys, values, keycache, valuecache }
    pbf.writeMessage(2, writeFeature, ctx)
  }

  for (const k of keys) pbf.writeStringField(3, k)
  for (const v of values) pbf.writeMessage(4, writeValue, v)
}

function writeFeature(ctx: FeatureContext, pbf: Pbf): void {
  const feature = ctx.feature
  if (feature.id !== undefined && typeof feature.id === 'number') {
    pbf.writeVarintField(1, feature.id)
  }
  pbf.writeMessage(2, writeProperties, ctx)
  pbf.writeVarintField(3, feature.type)
  pbf.writeMessage(4, writeGeometry, feature)
}

function writeProperties(ctx: FeatureContext, pbf: Pbf): void {
  const { feature, keys, values, keycache, valuecache } = ctx
  const tags = feature.tags
  if (tags === null) return

  for (const key in tags) {
    const value = tags[key]
    if (value === null) continue // spec says don't encode null values

    let keyIndex = keycache.get(key)
    if (keyIndex === undefined) {
      keys.push(key)
      keyIndex = keys.length - 1
      keycache.set(key, keyIndex)
    }
    pbf.writeVarint(keyIndex)

    const type = typeof value
    const storedValue = (type !== 'string' && type !== 'boolean' && type !== 'number')
      ? JSON.stringify(value)
      : value
    const valueKey = `${typeof storedValue}:${String(storedValue)}`
    let valueIndex = valuecache.get(valueKey)
    if (valueIndex === undefined) {
      values.push(storedValue)
      valueIndex = values.length - 1
      valuecache.set(valueKey, valueIndex)
    }
    pbf.writeVarint(valueIndex)
  }
}

function writeValue(value: unknown, pbf: Pbf): void {
  const type = typeof value
  if (type === 'string') {
    pbf.writeStringField(1, value as string)
  } else if (type === 'boolean') {
    pbf.writeBooleanField(7, value as boolean)
  } else if (type === 'number') {
    const n = value as number
    if (n % 1 !== 0) {
      pbf.writeDoubleField(3, n)
    } else if (n < 0) {
      pbf.writeSVarintField(6, n)
    } else {
      pbf.writeVarintField(5, n)
    }
  }
  // Other types intentionally dropped — spec doesn't model them.
}

/** MVT geometry command word: low 3 bits = command id, high bits = count. */
function command(cmd: number, length: number): number {
  return (length << 3) + (cmd & 0x7)
}

/** ZigZag-encode a signed 32-bit int as an unsigned varint payload. */
function zigzag(num: number): number {
  return (num << 1) ^ (num >> 31)
}

function writeGeometry(feature: TransformedTileFeature, pbf: Pbf): void {
  const type = feature.type
  // Point/MultiPoint stores geometry as a single Pair[] in our shape;
  // wrap it in an outer array so the rings loop below treats every
  // type uniformly.
  const rings = type === 1
    ? [feature.geometry as [number, number][]]
    : (feature.geometry as [number, number][][])

  let x = 0
  let y = 0

  for (const ring of rings) {
    let count = 1
    if (type === 1) count = ring.length

    pbf.writeVarint(command(1, count)) // MoveTo
    // Polygons don't write the closing edge as a LineTo — the
    // ClosePath command at the end implies it. Subtract one from
    // the count for polygons.
    const lineCount = type === 3 ? ring.length - 1 : ring.length

    for (let i = 0; i < lineCount; i++) {
      // Emit the LineTo header before the first LineTo coord (i.e.
      // right after the initial MoveTo's coord) for line/polygon.
      if (i === 1 && type !== 1) {
        pbf.writeVarint(command(2, lineCount - 1)) // LineTo
      }
      const dx = ring[i][0] - x
      const dy = ring[i][1] - y
      pbf.writeVarint(zigzag(dx))
      pbf.writeVarint(zigzag(dy))
      x += dx
      y += dy
    }

    if (type === 3) {
      pbf.writeVarint(command(7, 1)) // ClosePath
    }
  }
}
