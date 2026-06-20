// ═══ Demo Definitions — assembler ═══
// The single DEMOS record is now ASSEMBLED from per-category fragments
// (demos/<category>.ts), each a pure `Record<string, Demo>` keyed by the
// SAME demo ids as before (URL nav depends on them — ids are unchanged). This
// is a faithful relocation: the assembled record is SET-identical to the
// previous inline table (same keys, same values) AND preserves the original
// INSERTION ORDER (the gallery renders categories in this order), so the
// importers (demo-runner.ts, gallery.ts) still import `DEMOS` from here.
//
// Why split: every feature used to insert a key into one ~125-entry record and
// collide on it. Per-category fragments make new demos append-only per
// category — a new line demo touches only demos/lines.ts, a new fixture only
// demos/fixtures.ts.
//
// The shared loader (.xgis ?raw glob + URL rewrites + load() + Demo) lives in
// demos/loader.ts.

import type { Demo } from './demos/loader'
import { DEMOS_CORE } from './demos/core'
import { DEMOS_STYLE } from './demos/style'
import { DEMOS_NATURAL_EARTH } from './demos/natural-earth'
import { DEMOS_DATA_DRIVEN } from './demos/data-driven'
import { DEMOS_PROCEDURAL } from './demos/procedural'
import { DEMOS_LINES } from './demos/lines'
import { DEMOS_DETAIL_10M } from './demos/detail-10m'
import { DEMOS_THEMATIC } from './demos/thematic'
import { DEMOS_FIXTURES } from './demos/fixtures'

export type { Demo }

export const DEMOS: Record<string, Demo> = {
  ...DEMOS_CORE,
  ...DEMOS_STYLE,
  ...DEMOS_NATURAL_EARTH,
  ...DEMOS_DATA_DRIVEN,
  ...DEMOS_PROCEDURAL,
  ...DEMOS_LINES,
  ...DEMOS_DETAIL_10M,
  ...DEMOS_THEMATIC,
  ...DEMOS_FIXTURES,
}
