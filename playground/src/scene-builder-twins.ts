// ═══ SceneBuilder twins of gallery demos (#1194 A1b / A3 seed) ═══
//
// Each entry is the hand-built `SceneBuilder` twin of a gallery demo's .xgis
// source — the JS-API form of the same scene. Consumed by:
//   • demo-runner's `?runscene=1` flag: mounts the twin via `map.runScene()`
//     INSTEAD of `map.run(text)` — a first-mount, so the twin-render e2e gate
//     (_scene-builder-twin.spec.ts) compares two clean page loads and never
//     sits on the live-swap path.
//   • (A3) the gallery's future JS tab, which displays this construction next
//     to the .xgis text.
// Twins are pinned to their .xgis pair by the compiler parity gate
// (scene-builder-parity.test.ts) — AST-equal + byte-equal SceneCommands — so
// the two forms cannot drift.

import { SceneBuilder, ident, type SceneProgram } from '@xgis/compiler'

export const SCENE_BUILDER_TWINS: Record<string, () => SceneProgram> = {
  minimal: () =>
    new SceneBuilder()
      .source('world', { type: ident('geojson'), url: 'ne_110m_countries.geojson' })
      .layer('countries', (l) =>
        l.source('world').util('fill-stone-200', 'stroke-stone-400', 'stroke-1'),
      )
      .build(),
}
