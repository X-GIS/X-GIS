// ═══ SceneBuilder twin corpus — paired-example drift guard (#1194 A2/A3) ═══
//
// THE single authority pairing a gallery demo with its hand-built
// `SceneBuilder` twin — the JS-API form of the same scene. Each entry names
// the .xgis file it mirrors (`example`, under playground/src/examples/) and
// constructs the twin (`build`). Lives in the compiler because the corpus IS
// the design's drift guard for the builder surface (scene-builder.md §2.3),
// and because dependency direction forbids the reverse edge (the parity gate
// runs in this package; playground already depends on compiler). Exposed via
// the `@xgis/compiler/builder/twin-corpus` subpath — NOT the main index —
// so library consumers never see demo content.
//
// Consumed by:
//   • the parity gate (scene-builder-parity.test.ts), which iterates THIS
//     registry and asserts each twin is AST-equal + byte-equal-commands to
//     its parsed `example` — so the two forms cannot drift and no second
//     copy of any twin exists anywhere.
//   • playground demo-runner's `?runscene=1` flag: mounts the twin via
//     `map.runScene()` INSTEAD of `map.run(text)` — a first-mount, so the
//     twin-render e2e gate (_scene-builder-twin.spec.ts) compares two clean
//     page loads and never sits on the live-swap path.
//   • (A3) the gallery's future JS tab, which displays this construction
//     next to the .xgis text.
//
// Keys are playground demo ids (demos/*.ts); values name the paired example.

import {
  SceneBuilder,
  call,
  compare,
  field,
  ident,
  interpolateZoom,
  matchOn,
} from './scene-builder'
import type { SceneProgram } from './scene-builder'

export interface SceneBuilderTwin {
  /** The gallery .xgis file this twin mirrors (playground/src/examples/). */
  readonly example: string
  readonly build: () => SceneProgram
}

export const SCENE_BUILDER_TWINS: Record<string, SceneBuilderTwin> = {
  minimal: {
    example: 'minimal.xgis',
    build: () =>
      new SceneBuilder()
        .source('world', { type: ident('geojson'), url: 'ne_110m_countries.geojson' })
        .layer('countries', (l) =>
          l.source('world').util('fill-stone-200', 'stroke-stone-400', 'stroke-1'),
        )
        .build(),
  },

  zoom: {
    example: 'zoom.xgis',
    build: () =>
      new SceneBuilder()
        .source('world', { type: ident('geojson'), url: 'countries.geojson' })
        .layer('countries', (l) =>
          l
            .source('world')
            .util('fill-purple-400', 'stroke-purple-200', 'stroke-1')
            .util({ name: 'opacity', binding: interpolateZoom([2, 30], [5, 60], [8, 90]) }),
        )
        .build(),
  },

  continent_match: {
    example: 'continent-match.xgis',
    build: () =>
      new SceneBuilder()
        .source('countries', { type: ident('geojson'), url: 'ne_110m_countries.geojson' })
        .layer('continents', (l) =>
          l.source('countries').util(
            {
              name: 'fill',
              binding: matchOn('CONTINENT', {
                Africa: 'amber-600',
                Asia: 'rose-500',
                Europe: 'sky-500',
                'North America': 'emerald-500',
                'South America': 'lime-500',
                Oceania: 'violet-500',
                Antarctica: 'slate-300',
                _: '#9ca3af',
              }),
            },
            'stroke-slate-700',
            'stroke-0.5',
            'opacity-90',
          ),
        )
        .build(),
  },

  filter_gdp: {
    example: 'filter-gdp.xgis',
    build: () =>
      new SceneBuilder()
        .preset('dark_base', ['fill-slate-900', 'stroke-slate-700', 'stroke-0.5'])
        .source('countries', { type: ident('geojson'), url: 'ne_110m_countries.geojson' })
        .layer('all', (l) => l.source('countries').style('dark_base'))
        .layer('wealthy', (l) =>
          l
            .source('countries')
            .filter(compare(field('GDP_MD_EST'), '>', 1000000))
            .styleProp('fill', 'emerald-600')
            .styleProp('stroke', 'emerald-400')
            .styleProp('stroke-width', 1)
            .styleProp('opacity', 0.9),
        )
        .layer('top_economies', (l) =>
          l
            .source('countries')
            .filter(compare(field('GDP_MD_EST'), '>', 5000000))
            .styleProp('fill', 'yellow-500')
            .styleProp('stroke', 'yellow-300')
            .styleProp('stroke-width', 2),
        )
        .build(),
  },

  custom_symbol: {
    example: 'custom-symbol.xgis',
    build: () =>
      new SceneBuilder()
        .symbol('arrow', { path: 'M 0 -1 L 0.4 0.4 L 0 0.1 L -0.4 0.4 Z' })
        .symbol('flag', {
          path: 'M -0.15 -1 L -0.15 1 L -0.05 1 L -0.05 -1 Z M -0.05 -1 L 0.8 -0.5 L -0.05 0 Z',
        })
        .source('land', { type: ident('geojson'), url: 'ne_110m_land.geojson' })
        .source('cities', { type: ident('geojson'), url: 'ne_110m_populated_places.geojson' })
        .layer('ground', (l) =>
          l.source('land').util('fill-slate-800', 'stroke-slate-700', 'stroke-0.5'),
        )
        .layer('capitals', (l) =>
          l
            .source('cities')
            .filter(compare(field('featurecla'), '==', 'Admin-0 capital'))
            .util('shape-arrow', 'fill-emerald-400', 'stroke-emerald-600', 'stroke-1', 'size-16'),
        )
        .layer('others', (l) =>
          l
            .source('cities')
            .filter(compare(field('featurecla'), '!=', 'Admin-0 capital'))
            .util('shape-flag', 'fill-sky-300', 'stroke-sky-500', 'stroke-0.5', 'size-10'),
        )
        .build(),
  },

  animation_pulse: {
    example: 'animation-pulse.xgis',
    build: () =>
      new SceneBuilder()
        .keyframes('pulse', {
          0: ['opacity-100'],
          50: ['opacity-30'],
          100: ['opacity-100'],
        })
        .source('land', { type: ident('geojson'), url: 'ne_110m_land.geojson' })
        .source('coast', { type: ident('geojson'), url: 'ne_110m_coastline.geojson' })
        .layer('land_fill', (l) => l.source('land').util('fill-slate-800'))
        .layer('pulsing_coast', (l) =>
          l
            .source('coast')
            .util('stroke-amber-300', 'stroke-3')
            .util(
              'animation-pulse',
              'animation-duration-1500',
              'animation-ease-in-out',
              'animation-infinite',
            ),
        )
        .build(),
  },

  categorical: {
    example: 'categorical.xgis',
    build: () =>
      new SceneBuilder()
        .source('world', { type: ident('geojson'), url: 'countries.geojson' })
        .layer('countries', (l) =>
          l
            .source('world')
            .util(
              { name: 'fill', binding: call('categorical', ident('name')) },
              'stroke-slate-700',
              'stroke-1',
              'opacity-95',
            ),
        )
        .build(),
  },
}
