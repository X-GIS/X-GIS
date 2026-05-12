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

```

## Vector Tile Pipeline

GeoJSON sources flow through an in-worker geojson-vt port that
emits per-tile MVT/PBF bytes, then through the same MVT decode +
compile pipeline PMTiles archives use. Single pipeline, two
upstreams (HTTP archive vs in-memory FeatureCollection).

```
GeoJSON FeatureCollection
  │
  ├─ tiling worker (geojson-vt port)
  │   ├─ convert()           Project to Web Mercator unit square
  │   ├─ wrap()              Antimeridian world-copy merge
  │   ├─ splitTile()         Recursive 4-quad clip (per-axis range)
  │   ├─ simplify()          Douglas-Peucker, zoom-adaptive tolerance
  │   └─ encodeMVT()         Pack per-tile features as PBF (vt-pbf shape)
  │
  └─ mvt-worker pool (same path PMTiles uses)
      ├─ decodeMvtTile()     pbf → GeoJSONFeature[] per MVT layer
      ├─ decomposeFeatures() Per-feature GeometryPart with tight bbox
      ├─ compileSingleTile() clip + simplify + earcut + DSFUN pack
      └─ buildLineSegments() Outline + line segments with boundary detection
```

Key design decision: **earcut runs in Mercator-projected
coordinates**. Triangle edges are straight in Mercator space,
matching GPU rendering. This prevents fill artifacts where
lon/lat-straight edges curve in Mercator, overshooting
coastlines.

## Projections

Mercator, Equirectangular, Natural Earth, Orthographic, Azimuthal Equidistant, Stereographic, Oblique Mercator. Each has dual CPU + GPU implementations. Switching is instant via GPU uniform -- no re-tessellation.

## License

MIT
