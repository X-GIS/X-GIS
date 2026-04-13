# X-GIS

A domain-specific language and WebGPU rendering engine for GIS maps.

```
source neighborhoods {
  type: geojson
  url: "./data/seoul_gu.geojson"
}

layer districts {
  source: neighborhoods
  | fill-blue-400 stroke-white stroke-2 opacity-80
}
```

X-GIS is to maps what HTML/CSS is to web pages. Declare **what** data looks like; the compiler decides **how** to render it on the GPU.

## Why

GIS rendering today is locked to libraries. Mapbox, Deck.gl, OpenLayers each have their own APIs, style formats, and shader constraints. Switching libraries means rewriting everything. Customizing shaders means learning each library's internals.

X-GIS solves this with a **language** instead of a library:

- **Declare, don't program** -- `fill-red-500 stroke-black opacity-80` instead of imperative API calls
- **GPU-invisible** -- the compiler generates optimized WGSL shaders, buffer layouts, and render strategies automatically
- **Tailwind for maps** -- utility-class styling with modifiers: `z8:opacity-40`, `friendly:fill-green-500`, `hover:glow-8`
- **Compile-time optimization** -- constant folding, expression classification, shader specialization
- **One source, any renderer** -- WebGPU when available, Canvas 2D fallback when not

## Quick Start

```bash
bun install
bun run dev        # http://localhost:3000
```

## Language

### Data Sources

```
source world {
  type: geojson
  url: "countries.geojson"
}
```

### Layers with Utility Styling

```
layer tracks {
  source: military_tracks
  | symbol-arrow size-[speed/50|clamp:4,24] rotate-[heading]
  | friendly:fill-green-500 hostile:fill-red-500 fill-gray-400
  | stroke-black stroke-1
  | z8:opacity-40 z14:opacity-100
}
```

### Presets (Reusable Style Combos)

```
preset alert_track {
  | symbol-arrow fill-red-500 glow-8
  | animate-pulse-1s
}

layer emergency {
  source: emergency_feed
  | apply-alert_track
  | size-[speed/30|clamp:8,32]
}
```

### Functions

```
fn threat_size(level: f32) -> f32 {
  clamp(level * 4, 8, 32)
}

layer threats {
  source: data
  | size-[threat_size(.level)]   // per-feature GPU evaluation
  | size-[threat_size(5)]        // constant-folded at compile time
}
```

### Symbols

```
symbol arrow {
  path "M 0 -1 L -0.4 0.3 L 0.4 0.3 Z"
  anchor: center
}
```

### Imports

```
import { military_track } from "./styles.xgs"

layer tracks {
  source: data
  | apply-military_track
}
```

## Architecture

```
.xgis source
  |
  Lexer -> Parser -> AST
                      |
                    lower()
                      |
                   IR (Scene)
                      |
                  optimize()         -- constant folding, expression classification
                      |
              emit    |    codegen
             /                  \
     SceneCommands        ShaderVariant[]
             \                  /
              Runtime + GPU / Canvas 2D
```

Three packages:

| Package | Role |
|---------|------|
| `@xgis/compiler` | Lexer, parser, IR, optimizer, WGSL codegen. Pure TypeScript, no GPU deps. |
| `@xgis/runtime` | WebGPU renderers (vector, raster tiles, globe), Canvas 2D fallback, camera, interaction. |
| `@xgis/playground` | Vite dev app for testing. |

## Rendering

- **WebGPU** (primary) -- 7 map projections baked into WGSL shaders, RTC coordinate system for float32 precision
- **Canvas 2D** (fallback) -- automatic when WebGPU adapter unavailable, same projections via CPU
- **Globe mode** -- 2-pass: equirectangular flat map to offscreen texture, then sphere mesh with lighting
- **Raster tiles** -- `{z}/{x}/{y}` URL templates, LRU cache (256 tiles), priority loading, zoom-change cancellation
- **Mobile** -- touch pan/pinch-zoom, DPR-aware rendering, HTTPS dev server for WebGPU

## Compile-Time Optimizations

The compiler statically analyzes expressions and optimizes rendering:

| Expression | Classification | Handling |
|-----------|---------------|----------|
| `360 / 12` | constant | Folded to `30` at compile time |
| `z8:opacity-40` | zoom-dependent | CPU-interpolated per frame |
| `speed / 50 \| clamp(4,24)` | per-feature-gpu | WGSL codegen, GPU evaluation |
| `threat_size(5)` | constant (user fn) | Inlined and folded at compile time |

## Commands

```bash
bun install                   # install dependencies
bun run build                 # build all packages
bun run test                  # run tests
bun run dev                   # dev server with HTTPS

# Compiler CLI
bun compiler/src/cli/compile.ts compile hello.xgis -o hello.xgb
bun compiler/src/cli/compile.ts parse hello.xgis          # print AST
bun compiler/src/cli/compile.ts ir hello.xgis              # print IR
bun compiler/src/cli/compile.ts tile data.geojson -o data.xgvt   # GeoJSON → XGVT
```

## Vector Tiles (.xgvt)

XGVT (X-GIS Vector Tile) is a single-file vector tile format optimized for WebGPU rendering. It pre-processes GeoJSON into a tile pyramid at compile time, enabling instant rendering without runtime tessellation.

### Why XGVT

| | Raw GeoJSON | XGVT |
|---|---|---|
| **Loading** | Parse JSON + tessellate all polygons at runtime | Read binary + upload to GPU (zero-copy) |
| **Tiling** | Runtime `compileGeoJSONToTiles()` on every page load | Pre-computed at build time |
| **Precision** | Absolute lon/lat in f32 (precision loss at high zoom) | Tile-local coordinates (small values, precise in f32) |
| **Streaming** | Load entire dataset before first render | HTTP Range Requests — load only visible tiles |
| **Overzoom** | Fixed detail level | Runtime sub-tile generation from stored polygon rings |

### Format

```
[Header 32B] [TileIndex N×24B] [TileData...]

Header:   magic(XGVT) version bounds(4×f64) indexOffset indexLength
Index:    tileHash compactSize gpuReadySize vertexCount indexCount flags
TileData: gzip'd compact layer (ZigZag delta-encoded rings + coordinates)
```

- **Compact layer**: ZigZag delta-encoded polygon rings + line coordinates, gzip compressed. Decoded and tessellated at runtime using earcut in Mercator space.
- **Morton-keyed index**: Tiles indexed by Z-order curve for spatial cache coherence.
- **HTTP Range Request compatible**: Load header+index first (single request), then fetch individual tiles on demand.

### Compiling

```bash
# Basic (compact only — small files, runtime earcut)
bun compiler/src/cli/compile.ts tile countries.geojson -o countries.xgvt

# With GPU-ready layer (larger files, zero-copy GPU upload, no runtime earcut)
bun compiler/src/cli/compile.ts tile countries.geojson -o countries.xgvt --gpu
```

### Usage in X-GIS

```
source world {
  type: geojson
  url: "countries.xgvt"
}

layer countries {
  source: world
  | fill-emerald-700 stroke-emerald-900 stroke-1
}
```

### Tile Pipeline

```
GeoJSON features
  │
  ├─ decomposeFeatures()     Split MultiPolygon → individual parts with tight bbox
  │
  ├─ Per zoom level (z0 → zMax):
  │   ├─ clipPolygonToRect()  Sutherland-Hodgman clip to tile bounds
  │   ├─ simplifyPolygon()    Douglas-Peucker simplification (zoom-adaptive)
  │   ├─ earcut(mercCoords)   Triangulate in Mercator space (correct screen topology)
  │   └─ tile-local coords    vertex -= (tileWest, tileSouth) for f32 precision
  │
  ├─ Adaptive subdivision     Only subdivide tiles where simplification removed detail
  │
  └─ serializeXGVT()         Pack into single binary with Morton-keyed index
```

Key design decision: **earcut runs in Mercator-projected coordinates**. Triangle edges are straight in Mercator space, matching GPU rendering. This prevents fill artifacts where lon/lat-straight edges curve in Mercator, overshooting coastlines.

## Projections

Mercator, Equirectangular, Natural Earth, Orthographic, Azimuthal Equidistant, Stereographic, Oblique Mercator. Each has dual CPU + GPU implementations. Switching is instant via GPU uniform -- no re-tessellation.

## License

MIT
