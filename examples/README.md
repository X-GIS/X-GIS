# X-GIS — TypeScript API examples

Runnable, copy-pasteable examples for the **imperative `XGISMap` TypeScript API** — the
counterpart to the declarative `.xgis` style gallery under `playground/src/examples/`.

Each file is self-contained: grab a `<canvas>`, `new XGISMap(canvas, …)`, load a scene with
`map.run(source)`, then drive the map from code.

| file                                                           | shows                                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`01-hello-map.ts`](./01-hello-map.ts)                         | the minimum: construct a map + load a GeoJSON scene                                                       |
| [`02-graphics-shapes.ts`](./02-graphics-shapes.ts)             | `map.graphics.add({ type: 'circle' })` — retained, geo-anchored discs with per-feature radius/fill/stroke |
| [`03-graphics-icons-arrows.ts`](./03-graphics-icons-arrows.ts) | `addImage` + `map.graphics.add({ type: 'icon' \| 'arrow' })` — sprite markers + a movement vector field   |
| [`04-text-overlays.ts`](./04-text-overlays.ts)                 | `map.addOverlay(...)` — geo-anchored text labels                                                          |

## Run them

These are browser modules (`XGISMap` needs a real `<canvas>` + WebGPU/WebGL2). With any bundler
that resolves `@xgis/map` (Vite, esbuild, webpack) point an entry HTML at the example:

```html
<!doctype html>
<canvas id="map" style="width:100vw;height:100vh"></canvas>
<script type="module" src="./02-graphics-shapes.ts"></script>
```

```bash
# type-check every example against @xgis/map's published .d.ts (run from the repo root)
node node_modules/typescript/bin/tsc -p examples/tsconfig.json
```

## The retained graphics contract (why `getX` accessors, not per-frame callbacks)

`map.graphics.add(spec)` is **retained**: each `getPosition` / `getRadius` / `getColor` accessor
runs **once** at `add()` (or `update()`), never per frame. A camera move rewrites only the frame
uniform — the per-item GPU buffers are packed once, so 100k items cost the same per-frame work as
10k (one instanced draw per world copy). Accessors must be **pure**: do not read the live camera
or zoom inside them (that would freeze at `add()`-time). Per-frame data-driven styling belongs in a
compiled `.xgis` layer, not a host closure.
