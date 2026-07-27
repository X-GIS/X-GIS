// Vitest global setup. The shader-dsl projection graph is host-injected via
// configureProjections(); without a configured spec list every projection emit
// / cpu-projection access throws. Production wires this in the XGISMap
// constructor; the test runner wires it here so any suite that reaches the
// projection path (polygon/line/point/raster/heatmap emit, cpu-projections,
// threshold-drift / rim-rollout / wgsl-reserved-words) is configured first.
// Deep import, NOT the `@xgis/map` barrel. The barrel pulls the whole map module
// graph into EVERY test file's worker context — setup cost was 45 s across 24
// files that never touch the map package, and ~1348 s across the full 1150-file
// run against 283 s of actual test time. `@xgis/map` exports `./src/index.ts`,
// so this path resolves to the same module instance the barrel would reach:
// configureProjections' module state is shared with every consumer either way.
import { configureProjections } from './map/src/shaders/dsl/projections'
import { PROJECTIONS } from '@xgis/geo'

configureProjections(PROJECTIONS)
