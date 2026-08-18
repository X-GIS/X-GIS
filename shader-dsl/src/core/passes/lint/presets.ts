// Lint configuration presets, derived from the registry. The DEFAULT (no config) uses
// each rule's own severity — that is what validate() runs. These presets are for
// explicit lint passes that want a different posture.

import type { LintConfig, Severity } from './engine.js'
import { RULES } from './rules/index.js'

const severityFor = (pick: (category: string | undefined) => Severity): LintConfig['severity'] =>
  Object.fromEntries(RULES.map((r) => [r.id, pick(r.category)]))

/** Every rule is an error — the maximum-rigour pass (e.g. a pre-release gate). */
export const STRICT: LintConfig = { severity: severityFor(() => 'error') }

/** Only correctness rules fire; style + perf rules are off — for quick / legacy passes. */
export const LENIENT: LintConfig = {
  severity: severityFor((category) =>
    category === undefined || category === 'correctness' ? 'error' : 'off',
  ),
}
