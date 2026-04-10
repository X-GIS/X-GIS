# X-GIS Vector Tile Specification (.xgvt)

## Overview

`.xgvt` (X-GIS Vector Tile) is a single-file vector tile format inspired by Cloud-Optimized GeoTIFF (COG). It stores pre-tessellated, GPU-ready vector geometry in a sparse tile pyramid with an index for random access via HTTP Range Requests.

## File Layout

```
[Header]              40 bytes, fixed position
[TileIndex]           variable, immediately after header
[PropertyTable]       variable, after index
[TileData...]         variable, after property table
```

## Header (40 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | u32 | Magic number: `0x54564758` ("XGVT" LE) |
| 4 | 2 | u16 | Version |
| 6 | 1 | u8 | Level count (number of zoom levels) |
| 7 | 1 | u8 | Max level (highest zoom in file) |
| 8 | 16 | f32×4 | Bounds: [minLon, minLat, maxLon, maxLat] |
| 24 | 4 | u32 | Index offset (bytes from file start) |
| 28 | 4 | u32 | Index length (bytes) |
| 32 | 4 | u32 | Property table offset |
| 36 | 4 | u32 | Property table length |

## Tile Index

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | u32 | Tile count |
| 4+ | 36×N | | Index entries (sorted by Morton key) |

### Index Entry (36 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | u32 | Tile hash (Morton code + sentinel) |
| 4 | 4 | u32 | Data offset (absolute file position) |
| 8 | 4 | u32 | Compact data size |
| 12 | 4 | u32 | GPU-ready data size (0 if compact-only) |
| 16 | 4 | u32 | Polygon vertex count |
| 20 | 4 | u32 | Polygon index count |
| 24 | 4 | u32 | Line vertex count |
| 28 | 4 | u32 | Line index count |
| 32 | 4 | u32 | Reserved |

## Tile Key (Morton Code)

Tiles are identified by a Morton code (Z-order curve) with a leading sentinel bit:

```
key = (1 << (2 * z)) | mortonEncode(x, y)
```

Properties:
- `parent = key >>> 2`
- `children = [key<<2, key<<2|1, key<<2|2, key<<2|3]`
- Supports zoom 0-26 (fits in JS safe integer)
- Spatially adjacent tiles have numerically adjacent keys

## Tile Data (per tile)

Each tile contains 6 compact sections:

| Section | Encoding | Content |
|---------|----------|---------|
| 1. Polygon coords | ZigZag delta varint | lon/lat pairs |
| 2. Polygon indices | ZigZag delta varint | triangle indices |
| 3. Line coords | ZigZag delta varint | lon/lat pairs |
| 4. Line indices | ZigZag delta varint | line segment indices |
| 5. Polygon feat_ids | ZigZag delta varint | per-vertex feature index |
| 6. Line feat_ids | ZigZag delta varint | per-vertex feature index |

Each section is prefixed with a u32 byte length.

### Coordinate Encoding

Coordinates are stored as delta-encoded, ZigZag-mapped, varint-packed integers:

```
[127.0, 37.5, 127.1, 37.6]  (degrees)
→ quantize (×precision): [127000000, 37500000, 127100000, 37600000]
→ delta:                 [127000000, 37500000, 100000, 100000]
→ zigzag:                [254000000, 75000000, 200000, 200000]
→ varint:                variable-length bytes
```

### Zoom-Adaptive Precision

| Zoom | Precision | Accuracy |
|------|-----------|----------|
| 0-4 | 1e4 | ~1.1 km |
| 5-8 | 1e5 | ~110 m |
| 9+ | 1e6 | ~11 m |

### Vertex Format (GPU-ready)

When decoded, vertices are stride-3 Float32:
```
[lon, lat, feat_id, lon, lat, feat_id, ...]
```

- `lon`, `lat`: degrees (WGS84)
- `feat_id`: original GeoJSON feature index (float-encoded integer)

## Property Table

Stores GeoJSON feature properties for all features. Shared across all tiles.

```
featureCount: u32
fieldCount: u16
fieldNames: [u16 length + UTF-8 bytes] × fieldCount
fieldTypes: u8[] (0=f64, 1=string, 2=bool)
stringPool: u32 count + [u16 length + UTF-8] × count
values: column-major, per-field per-feature
  f64:    Float64 (8 bytes)
  string: u32 string pool index (0xFFFFFFFF = null)
  bool:   u8 (0=false, 1=true, 0xFF=null)
```

## Compilation Pipeline

```
GeoJSON
  → Decompose MultiPolygon/MultiLineString into individual parts
  → Per zoom level:
      → Clip each part to tile boundaries (Sutherland-Hodgman)
      → Tessellate clipped geometry (earcut for polygons)
      → Encode to compact format (ZigZag delta varint)
  → Build property table from feature properties
  → Serialize to .xgvt
```

No geometry simplification is applied — original coordinates are preserved through the pipeline to maintain shared edge topology between adjacent features.

## Runtime Loading

### Full Load (< 50MB files)
1. `fetch(url)` → full ArrayBuffer
2. Parse header + index
3. Tiles decoded synchronously on demand

### Range Request (≥ 50MB files)
1. `fetch(url, Range: 0-39)` → Header
2. `fetch(url, Range: indexOffset-...)` → Index + PropertyTable
3. Per visible tile: `fetch(url, Range: tileOffset-...)` → Tile data
4. Batch adjacent tiles into single Range Requests

### Zoom Transition
- Previous zoom tiles remain visible while new zoom tiles load
- Atomic swap when all visible tiles at new zoom are cached
- LRU eviction protects stable-zoom tiles

## Projections

Tiles store coordinates in WGS84 degrees. GPU vertex shader applies projection at render time via RTC (Relative-To-Center) approach:

```wgsl
let vertex_projected = project(lonlat.x, lonlat.y);
let center_projected = project(center_lon, center_lat);
let rtc = vertex_projected - center_projected;
```

Supported: Mercator, Equirectangular, Natural Earth, Orthographic, Azimuthal Equidistant, Stereographic, Oblique Mercator.
