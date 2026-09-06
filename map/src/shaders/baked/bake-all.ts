// ═══ Baked shaders — the six committed modules, rendered by ONE authority (#2535) ═══
//
// Two consumers write the artifacts: the CLI driver (`map/scripts/bake-shaders.ts`, run by
// a human after `bun run build`) and the dev-server plugin
// (`playground/dev/bake-shaders-on-edit.ts`, run by Vite on every edit to a file the bake
// depends on). If each configured the host seams and walked the (language, group) grid
// itself, the two could drift — a seam configured in one and not the other is a different
// artifact with the same file name (§12's two-authorities rule). So the loop lives here,
// under `map/src` where `tsc --build` checks it and vitest can import it, and both
// consumers reduce to "call this, then write what it returns".
//
// HOST SEAMS. `configureProjections(PROJECTIONS)` then `applyBodyOption()` — the order the
// XGISMap constructor uses. The emitted sources splice in the host-injected projection
// graph and embed the body consts as literals, so a bake under other seams is a different
// artifact; `applyBodyOption()` with no argument is EARTH, the only body the committed
// artifact is valid for (the gate re-checks it through `meta`). Both calls are idempotent,
// which is why this can run in a process that already configured them (`vitest.setup.ts`
// does) and in one that has not (the CLI, the Vite runner).
//
// The text returned is PRE-FORMAT. The committed bytes are prettier's output over this text
// (`singleQuote` alone rewrites every JSON-quoted key), so a consumer that compares against
// the file on disk must format first — see the plugin's sync step.

import { PROJECTIONS } from '@xgis/geo'
import { configureProjections } from '../dsl/projections'
import { applyBodyOption } from '../../body-consts'
import {
  BAKED_GROUPS,
  BAKED_LANGUAGES,
  bakedArtifactFile,
  buildBakedArtifact,
  renderBakedModule,
} from './bake'
import type { BakedArtifact, BakedGroup, BakedLanguage } from './registry'

export interface RenderedBakedModule {
  language: BakedLanguage
  group: BakedGroup
  /** File name relative to `map/src/shaders/baked/` (`bakedArtifactFile`). */
  file: string
  /** The module's TypeScript source, before prettier. */
  text: string
  artifact: BakedArtifact
}

/** Configure the host seams and emit every registry key into its (language, group) module.
 *  Deterministic: the same tree renders the same six texts (measured by `baked-sync`). */
export function renderAllBakedModules(): RenderedBakedModule[] {
  configureProjections(PROJECTIONS)
  applyBodyOption()
  const out: RenderedBakedModule[] = []
  for (const language of BAKED_LANGUAGES)
    for (const group of BAKED_GROUPS) {
      const artifact = buildBakedArtifact(language, group)
      out.push({
        language,
        group,
        file: bakedArtifactFile(language, group),
        text: renderBakedModule(language, group, artifact),
        artifact,
      })
    }
  return out
}
