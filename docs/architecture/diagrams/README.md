# Architecture Diagrams

UML diagrams (Mermaid — renders natively on GitHub) of the X-GIS runtime.
Each is grounded in the cited source files; update the diagram in the same
PR that changes the structure it describes.

| Diagram | Kind | Covers |
|---|---|---|
| [class-compiler-pipeline.md](./class-compiler-pipeline.md) | Class | `convert → parser → ir/lower + optimize → tiler / codegen`; data types `AST Program → Scene/RenderNode → CompiledTile / ShaderVariant` |
| [class-render-subsystem.md](./class-render-subsystem.md) | Class | `XGISMap` → `RenderLoop` → `RenderPass` chain → `VectorTileRenderer` / `Camera` / renderers, + per-frame data objects + the `ProjectionsTable` SoT |
| [class-data-source-layer.md](./class-data-source-layer.md) | Class | `TileCatalog` router/cache ↔ `TileSource` backends (PMTiles / virtual-PMTiles / GeoJSON-runtime / synthetic-earth-surface) ↔ `TileSourceSink` push contract ↔ MVT / GeoJSON worker pools |
| [sequence-frame-render.md](./sequence-frame-render.md) | Sequence | one frame: compute → opaque (fill+line per tile) → OIT → translucent → points → labels → submit |
| [sequence-tile-lifecycle.md](./sequence-tile-lifecycle.md) | Sequence | one tile: source `loadTile` → worker decode → catalog cache → upload queue → GPU arena → draw |
| [sequence-style-load.md](./sequence-style-load.md) | Sequence | `.xgis` source → compile → attach backends + synthetic bg → `rebuildLayers` → first frame → first paint |
| [state-projection-modes.md](./state-projection-modes.md) | State | the per-frame view-matrix mode (flat-Mercator MVP ↔ ECEF/globe orbit) + the `projType` {3,4,5} pitch-promotion and `globeMode` transitions |

## Conventions

- **Mermaid** in fenced ```` ```mermaid ```` blocks. No binary image files —
  diagrams stay diffable and review-able in the PR.
- `*--` = composition (ownership/lifetime); `..>` = use-time dependency;
  `<|..` = interface realization.
- Keep each diagram to the **essential** classes/messages. Detail that
  doesn't change the reader's mental model belongs in prose, not the box.
- Cross-link to the relevant [ADR](../../adr/) for the *why*.

## Not yet drawn (candidates)

_(none — the current structural surface is covered above.)_
