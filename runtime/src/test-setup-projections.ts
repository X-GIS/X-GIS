// Vitest global setup. The shader-dsl projection graph is host-injected via
// configureProjections(); without a configured spec list every projection emit
// / cpu-projection access throws. Production wires this in the XGISMap
// constructor; the test runner wires it here so any suite that reaches the
// projection path (polygon/line/point/raster/heatmap emit, cpu-projections,
// threshold-drift / rim-rollout / wgsl-reserved-words) is configured first.
import { configureProjections } from './engine/shaders/dsl'
import { PROJECTIONS } from './engine/projection/projections-table'

configureProjections(PROJECTIONS)
