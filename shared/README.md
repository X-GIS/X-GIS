# @xgis/shared

The cross-package **math kernel** for the X-GIS monorepo. `src/ecef.ts` holds
the WGS84 / ECEF coordinate math, and `src/quantize.ts` the shared vertex
quantization, that both the `@xgis/compiler` tiler and the `@xgis/runtime`
engine need to agree on, byte-for-byte.

It is the smallest package in the repo on purpose: it is a **leaf** with
**zero dependencies**. Keeping it dependency-free is the whole point — both
packages (and cross-validation tooling) can import the same math without
pulling in an engine, a DOM, or a compiler graph.

> Position in the dependency DAG: see
> [`docs/architecture/MODULES.md`](../docs/architecture/MODULES.md) — `@xgis/shared`
> sits at the bottom, imported by both compiler and runtime.

## Why it exists

The tile vertex pipeline ends in **ECEF** (Earth-Centered Earth-Fixed)
Cartesian metres, so the runtime vertex shader collapses to a linear
`mvp * vec4(ecef_rtc, 1)` (see [ADR-0001](../docs/adr/0001-ecef-tile-pipeline.md)).
The compiler's tiler bakes the per-tile ECEF anchors; the runtime's camera
and vertex paths consume them. If the two sides used even slightly different
WGS84 constants or a different ellipsoid forward, vertices would not line up.

Before this package existed, the tiler **hand-mirrored** the constants and the
ellipsoid forward from `runtime/src/engine/projection/ecef.ts` (the old
`// mirrors runtime/.../ecef.ts` comments). Those hand-copies are now **real
imports** of a single source of truth, with precision-fuzz tests pinning
parity.

## Install / import

Internal workspace package (`private: true`, not published). Consumed via the
bun workspace:

```ts
import { lonLatToECEF, dsfunSplitECEF, WGS84 } from '@xgis/shared'
```

The runtime re-exports it so existing `../projection/ecef` import paths stay
stable — no engine consumer had to change:

```ts
// runtime/src/engine/projection/ecef.ts
export * from '@xgis/shared'
```

## Public surface

Everything is re-exported from `src/index.ts` (`export * from './ecef'` +
`export * from './quantize'`). All helpers are pure functions over the WGS84
ellipsoid (`a = 6378137 m`, `1/f = 298.257223563`).

### Types

| Export | Shape |
| --- | --- |
| `ECEF` | `readonly [x, y, z]` — ECEF Cartesian metres |
| `LonLatHeight` | `readonly [lon, lat, height]` — degrees + ellipsoidal metres |

### Forward / inverse maps

| Export | Role |
| --- | --- |
| `lonLatToECEF(lon, lat, height?)` | lon/lat (deg) + height → ECEF (ellipsoidal) |
| `ecefToLonLat(x, y, z)` | ECEF → lon/lat/height (Bowring iteration) |
| `mercatorToECEF(mx, my, height?)` | Web Mercator metres → ECEF (ellipsoidal) |
| `tileEcefCenterFromMerc(mx, my)` | per-tile ECEF anchor from a Mercator tile corner |

### Sphere variants

The legacy 2D MVP path is built on a **spherical** Mercator basis, so these
mirror the forwards above with eccentricity `E2 = 0` to keep the dual ECEF/legacy
paths parity-matched at the equator until the legacy path is retired:

| Export | Role |
| --- | --- |
| `lonLatToECEFSphere(lon, lat, height?)` | spherical `lonLatToECEF` (radius `A`) |
| `mercatorToECEFSphere(mx, my, height?)` | spherical `mercatorToECEF` |

### GPU-precision + basis helpers

| Export | Role |
| --- | --- |
| `dsfunSplitECEF(ecef, ecefCenter)` | hi/lo f32 split of an RTC-relative ECEF vertex (sub-mm precision on GPU) |
| `ecefToENURotation(lon, lat)` | column-major `Float32Array(16)` ECEF→ENU (East/North/Up) rotation |
| `WGS84` | `{ A, F, E2, RAD2DEG }` constants, for WGSL emission / tiler / cross-validation |
| `quantizeAxis(axis, halfRange, invSpan)` | quantize one absolute axis value into a double-u16 `[hi, lo]` pair for the packed ECEF vertex layout (shared by the tiler + synthetic-earth packer) |

## Build

```bash
bun run build   # tsc --build
```

There is no separate `test` script here (only `build`); the co-located
`src/ecef.test.ts` characterization suite runs via the root `vitest`, and parity
is also pinned by the consumers' precision-fuzz tests (e.g. the runtime's
`globe-ecef-frame-consistency.test.ts` and the compiler tiler's ECEF
point-precision fuzz).

## Constraints

- **Keep it dependency-free.** No engine, DOM, compiler, or GPU imports. The
  one place the temptation appears is `mercatorToECEF`, which inlines the
  inverse-Mercator formula (matching `projection.ts` byte-for-byte) rather
  than importing it.
- **This is the home of ECEF/WGS84 math.** New cross-package coordinate
  helpers belong here, not re-mirrored in compiler or runtime.

## See also

- [`docs/architecture/MODULES.md`](../docs/architecture/MODULES.md) — module DAG; this package is the shared leaf
- [`docs/architecture/OVERVIEW.md`](../docs/architecture/OVERVIEW.md) — C4 view of the engine
- [`docs/adr/0001-ecef-tile-pipeline.md`](../docs/adr/0001-ecef-tile-pipeline.md) — why the pipeline ends in ECEF metres
- [`docs/COORDINATES.md`](../docs/COORDINATES.md) — the LL / MM / DLM / SP coordinate spaces ECEF sits at the end of
