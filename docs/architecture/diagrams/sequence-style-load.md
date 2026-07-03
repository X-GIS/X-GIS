# Sequence Diagram — Style Load (source → first paint)

How a `.xgis` style string travels from `XGISMap.run(style)` to the first
on-screen tile. Grounded in `runtime/src/engine/map.ts`
(`run` → `_installSyntheticEarthSurfaceSource` → `rebuildLayers` →
`renderLoop`), `runtime/src/engine/source-manager.ts` (`_attachOneSource`),
`runtime/src/data/tile-catalog.ts` (`attachBackend` → `makeSink` →
`checkLayoutVersion`, `prewarmSkeleton`, `requestTiles` → `acceptResult` →
`cacheTileData` → `onTileLoaded`), `runtime/src/loader/vector-tile-loader.ts`
(`attachPMTilesSource`), `runtime/src/data/sources/synthetic-earth-surface-backend.ts`
(`attach` → `loadTile` → `acceptResult`), and
`runtime/src/engine/render/vector-tile-renderer.ts`
(`setSource` wires `catalog.onTileLoaded = uploadTile`).

Two things run **in parallel** inside `run`: GPU init (`initGPU`, dominated by
`requestDevice()`) is kicked off first, then the synchronous compile pipeline
(lex → parse → lower → emitCommands) runs while the device promise is in flight.
Loading is **push-based** end to end — a backend is fire-and-forget, and decoded
tiles arrive asynchronously through `sink.acceptResult` → `catalog.onTileLoaded`
→ `VectorTileRenderer.uploadTile`.

```mermaid
sequenceDiagram
    autonumber
    participant App as App / host
    participant Map as XGISMap
    participant Comp as @xgis/compiler
    participant SM as SourceManager
    participant Cat as TileCatalog
    participant Be as TileSource backend
    participant VTR as VectorTileRenderer
    participant RL as RenderLoop

    App->>Map: run(source, baseUrl)
    Map->>Map: initGPU(canvas)  %% step 0 — in flight, awaited at step 2

    Note over Map,Comp: 1. compile style → commands
    Map->>Comp: new Lexer(source).tokenize() → Parser.parse() → ast
    opt ast has ImportStatement
        Map->>Comp: resolveImportsAsync(ast, baseUrl, fetch)
    end
    alt new syntax (Source/Layer statements)
        Map->>Comp: lower → optimize → emitCommands(scene)
    else legacy
        Map->>Comp: interpret(ast)
    end
    Comp-->>Map: commands {loads, shows, palette, symbols, ...}
    Map->>Map: scan ast BackgroundStatement → _backgroundColor

    Note over Map: 2. await initGPU → build renderers
    Map->>Map: ctx = await gpuInit; new MapRenderer/RasterRenderer/<br/>PointRenderer/LineRenderer; uploadPalette

    Note over Map,Be: 3. attach sources (Promise.allSettled, parallel)
    loop per load in commands.loads
        Map->>SM: _attachOneSource(load, baseUrl, maps, cameraFitState)
        alt vector-tile (pmtiles / tilejson)
            SM->>Cat: new TileCatalog()
            SM->>VTR: new VectorTileRenderer(ctx); set pipelines/atlases
            SM->>VTR: setSource(catalog)
            VTR->>Cat: catalog.onTileLoaded = (k,d,layer) => uploadTile(...)
            SM->>Cat: attachPMTilesSource(catalog, {url, kind, layers, ...})
            Cat->>Cat: attachBackend(new PMTilesBackend(...))
            Cat->>Be: backend.attach(makeSink(backend))
            Cat->>Cat: mergeBackendMeta + checkLayoutVersion(meta.layoutVersion)
            Cat->>Cat: prewarmSkeleton() → markSkeleton + prefetchTiles(z0..N)
        else raster URL
            SM->>Map: rawDatasets.set(name, {_tileUrl})
        else GeoJSON URL
            SM->>SM: fetch + readBodyCapped → attach via VirtualPMTiles / setRawParts
        end
    end

    Note over Map,Be: 3b. synthetic earth-surface (only if background fill)
    opt _backgroundColor set — see ADR-0005
        Map->>Map: _installSyntheticEarthSurfaceSource(rgba)
        Map->>Cat: attachBackend(new SyntheticEarthSurfaceBackend(projType))
        Cat->>Be: backend.attach(sink)
        Be->>Cat: loadTile(Z0_KEY) → sink.acceptResult(z0 mesh)
        Cat->>Cat: cacheTileData → onTileLoaded → VTR.uploadTile
        Map->>Map: commands.shows = [syntheticShow, ...commands.shows]
    end

    Map->>Map: showCommands = commands.shows
    Map->>Map: rebuildLayers()  %% build vectorTileShows from shows × rawDatasets
    Map->>Map: switchController(); running = true

    Note over Map,RL: 4. first frame
    Map->>RL: renderLoop() → renderFrame()
    RL->>VTR: select visible tiles → requestTiles(neededKeys)
    VTR->>Cat: requestTiles(keys)
    Cat->>Be: loadTile(key)   %% fire-and-forget
    Be-->>Cat: sink.acceptResult(key, result, sourceLayer)  %% async, off-thread decode
    Cat->>Cat: cacheTileData(key, ...)
    Cat-->>VTR: onTileLoaded(key, data, sourceLayer) → uploadTile → GPU
    VTR->>RL: renderTileKeys → first draw
    Map->>App: window.__xgisReady = true
```

## Reading notes

- **Compile is synchronous, GPU init is not.** `run` fires `initGPU(canvas)`
  _before_ lexing (step 0) and only `await`s it at step 2, so `requestDevice()`
  overlaps the lex/parse/lower/emit work. New-syntax styles (any `Source`/`Layer`
  statement) go `lower → optimize → emitCommands`; older styles fall back to
  `interpret(ast)`. Either way the product is a `SceneCommands` carrying `loads`
  and `shows` (`map.ts` `run`, lines ~1500–1582).
- **`setSource` is what wires the push.** `VectorTileRenderer.setSource(catalog)`
  assigns `catalog.onTileLoaded = (k, d, layer) => this.uploadTile(k, d, layer)`
  (`vector-tile-renderer.ts:578-582`). Everything a backend later pushes into the
  catalog therefore fans out to a GPU upload without the renderer polling.
- **`attachBackend` is the single attach choke point.** It calls
  `backend.attach(makeSink(backend))` (a fresh per-backend sink so
  `acceptResult` can stamp `originBackend`), merges the backend's `meta`
  (bounds/maxLevel/propertyTable), then `checkLayoutVersion` compares
  `backend.meta.layoutVersion` against the runtime `TILE_LAYOUT_VERSION` and
  evicts + warns once on mismatch (`tile-catalog.ts:254-280`). PMTiles/TileJSON
  attach then calls `prewarmSkeleton()` to pin the z=0..N quadtree so the
  parent-fallback walk always finds an ancestor (`vector-tile-loader.ts:203-217`).
- **The synthetic earth-surface source is special only in timing.** Its backend
  emits its single z=0 mesh tile _immediately on `attach`_ (`backend.ts:113-118`:
  `attach` → `loadTile(Z0_KEY)` → `sink.acceptResult`), so it is cached + uploaded
  before the first render request rather than fetched on demand. Its
  `ShowCommand` is prepended at `commands.shows[0]` so it paints behind every
  authored layer — see [ADR-0005](../../adr/0005-synthetic-earth-surface-background.md).
  It is otherwise a normal show through the standard polygon pipeline.
- **First paint is data-gated, not run-gated.** `run` returns (and sets
  `__xgisReady = true`) after the render loop starts, but real tiles only appear
  once `requestTiles` → backend `loadTile` → async `acceptResult` →
  `onTileLoaded` → `uploadTile` completes for visible keys. The per-tile detail
  of that async leg (worker decode, upload budget, GPU arena) is the
  [tile lifecycle diagram](./sequence-tile-lifecycle.md).

## Related

- Per-tile detail (fetch → decode → upload → draw):
  [sequence-tile-lifecycle.md](./sequence-tile-lifecycle.md).
- Per-frame render after first paint:
  [sequence-frame-render.md](./sequence-frame-render.md).
- Object ownership (`XGISMap` → renderers → `TileCatalog`/backends):
  [class-render-subsystem.md](./class-render-subsystem.md).
- Synthetic background prepend rationale:
  [ADR-0005](../../adr/0005-synthetic-earth-surface-background.md).
- ECEF tile packing the backends emit:
  [ADR-0001](../../adr/0001-ecef-tile-pipeline.md).
