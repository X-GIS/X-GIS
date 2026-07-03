# Class Diagram — Render Subsystem

UML class view of the runtime render path (`runtime/src/engine/`). Shows
ownership (composition), the `RenderPass` chain, and the per-frame data
objects. Grounded in `map.ts`, `render-loop.ts`, `render/passes/*.ts`,
`vector-tile-renderer.ts`, `projection/camera.ts`.

> Known debt: `VectorTileRenderer` (5608 LOC / 174 methods) and `XGISMap`
> (2956 / 160) are **god objects** — unclear state-ownership. See
> [MODULES.md](../MODULES.md). The diagram shows their _current_ surface,
> not a target shape.

```mermaid
classDiagram
    direction TB

    class XGISMap {
        <<public API facade>>
        +camera: Camera
        +vtSources: Map~string, VTSourceEntry~
        +renderer: MapRenderer
        +lineRenderer: LineRenderer
        +pointRenderer: PointRenderer
        +renderFrame() void
        +setStyle() void
        +jumpTo/easeTo/flyTo() void
        +addSource/addLayer() void
    }

    class RenderLoop {
        +render() void
        -host: RenderLoopHost
    }

    class RenderPass {
        <<interface>>
        +label: string
        +shouldRun(scene) bool
        +execute(ctx, scene, host) void
    }

    class OpaquePass {
        <<singleton>>
        bg + fills + opaque strokes
    }
    class OitPass {
        <<singleton>>
        translucent 3D extrude (MRT)
    }
    class TranslucentPass {
        <<singleton>>
        strokes offscreen + composite
    }
    class PointsPass {
        <<singleton>>
    }
    class LabelPass {
        <<singleton>>
        CPU projector + glyph atlas
    }
    class OverdrawComposePass {
        <<singleton>>
    }

    class VectorTileRenderer {
        <<god object — 174 methods>>
        +render(pass, camera, projType, ...) void
        -renderTileKeys(keys, pass, fill, line, ...) void
        -renderPolygonTile() drawIndexed
        -uploadQueue / gpuCache / arena
        -uniform ring
        +dispatchComputePass() void
        +pumpPrefetch(camera, projType, ...) void
    }

    class Camera {
        +getViewForProjection(projType, w, h, dpr) View
        +getECEFFrameView() GlobeView
        +getVisibleWorldCopies() number[]
        +unprojectToZ0() LngLat
    }

    class MapRenderer {
        fill/line pipeline creation
        +uniformBuffer: GPUBuffer
        +renderToPass() void
    }
    class LineRenderer {
        +beginTranslucentPass() pass
        +composite(pass, opacity) void
    }
    class PointRenderer
    class TextStage {
        <<god object>>
        label shaping / layout / atlas / collision
    }

    class FrameContext {
        <<per-frame data>>
        +encoder: GPUCommandEncoder
        +colorView / rt / screenView
        +projType / centerLon / centerLat
        +w / h / dpr
    }
    class SceneView {
        <<per-frame data>>
        +opaqueGroups / translucent / oit
        +hasPoints / hasTranslucent / hasOit
        +resolveOwner
    }

    class ProjectionsTable {
        <<Source of Truth>>
        projType, cullThreshold,
        worldCopies, worldBand,
        isFlat/isSeam/periodic
    }

    XGISMap *-- Camera
    XGISMap *-- MapRenderer
    XGISMap *-- LineRenderer
    XGISMap *-- PointRenderer
    XGISMap *-- "1..*" VectorTileRenderer : vtSources
    XGISMap ..> RenderLoop : renderFrame delegates

    RenderLoop ..> RenderPass : drives chain
    RenderLoop ..> FrameContext : builds
    RenderLoop ..> SceneView : buildSceneView()

    RenderPass <|.. OpaquePass
    RenderPass <|.. OitPass
    RenderPass <|.. TranslucentPass
    RenderPass <|.. PointsPass
    RenderPass <|.. LabelPass
    RenderPass <|.. OverdrawComposePass

    OpaquePass ..> VectorTileRenderer : render() fill+line
    OpaquePass ..> MapRenderer : raster + bg
    TranslucentPass ..> LineRenderer : offscreen + composite
    LabelPass ..> TextStage
    PointsPass ..> PointRenderer

    VectorTileRenderer ..> Camera : getViewForProjection
    VectorTileRenderer ..> ProjectionsTable : worldCopies/cull
    Camera ..> ProjectionsTable : projType data
```

## Reading notes

- **Composition (`*--`)** = the owner allocates/owns lifetime. `XGISMap`
  owns one `Camera`, the shared renderers, and one `VectorTileRenderer`
  per vector source (`vtSources`). `VTSourceEntry` is not a named type — it
  is the inline object literal `{ source: TileCatalog; renderer:
VectorTileRenderer }` (`map.ts:159`), so each entry also owns a
  `TileCatalog` (omitted from the arrows to keep the box readable).
- **Dependency (`..>`)** = "uses at call time", no ownership. The passes
  are _stateless singletons_ (`render/passes/*.ts` export one instance);
  they reach renderers/camera through the `host: RenderLoopHost` view.
- **`ProjectionsTable`** (`projection/projections-table.ts`) is the single
  authority every projection-aware site reads — see
  [ADR-0003](../../adr/0003-shader-dsl-single-emit.md).
- The actual GPU draw of fills + strokes happens inside
  `VectorTileRenderer.renderTileKeys` (one tile = fill `drawIndexed` then
  line `drawIndexed`); see [sequence-frame-render.md](./sequence-frame-render.md).
