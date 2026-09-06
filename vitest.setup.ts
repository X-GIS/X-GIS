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
import { afterAll } from 'vitest'
import { configureProjections } from './map/src/shaders/dsl/projections'
import { PROJECTIONS } from '@xgis/geo'
// Deep import for the same reason as above, and free: body.ts imports nothing.
import { EARTH, activeBody } from './shared/src/body'

configureProjections(PROJECTIONS)

// ── Body-leak guard: name the file that LEAKED, not the one that ran next ──
// `configureBody()` / `applyBodyOption()` (the XGISMap `{ body }` ctor knob) write
// a PROCESS-global slot. The shared-registry pass runs a whole worker's files in
// ONE process (measured: same pid, one setup execution per file), so a body left
// configured is still configured for every file that worker runs afterwards —
// which fails somewhere else entirely, naming the victim (#2567). This runs after
// the file's own afterEach restores and accuses the file that actually leaked.
// Restore in an `afterEach`, not an `afterAll`: only afterEach is ordered before
// this hook regardless of registration order.
afterAll(() => {
  const left = activeBody()
  if (left !== EARTH)
    throw new Error(
      `body leak: this file left the process-global Body configured to '${left.name}' ` +
        `(a=${left.a}, f=${left.f}). configureBody()/applyBodyOption() is process-global — ` +
        `restore it with configureBody(EARTH) in an afterEach, or every file this worker ` +
        `runs next renders the wrong planet (#2567).`,
    )
})
