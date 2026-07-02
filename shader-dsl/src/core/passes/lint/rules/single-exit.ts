import type { LintRule } from '../engine'
import { checkSingleExit } from '../../single-exit'

/** MISRA-C Rule 15.5 — a single point of exit (one return, as the final statement).
 *  The structural check lives in passes/single-exit.ts; this wires it as a rule.
 *
 *  POLICY (#740 R5 review): this is a STYLE discipline, not a correctness
 *  invariant — an early return emits perfectly valid WGSL/GLSL. It stays
 *  'error' in the DEFAULT ruleset (the shader static-analysis tests gate the
 *  authored shaders with it), but as 'style' it is OFF under the LENIENT
 *  preset, and it is LINT-ONLY (never in validate()'s CORE_RULES).
 *
 *  Sanctioned deviations (`allowEarlyReturn: true`, always with a comment):
 *  - a guard that SKIPS a bounded loop (the SDF out-of-bbox early-outs) —
 *    single-exit would run the loop for every discarded fragment;
 *  - a dispatch ladder selecting one arm per invocation (the projection
 *    fns) — single-exit would evaluate every arm per vertex.
 *  Both classes are perf-load-bearing and byte-identical to their authored
 *  form; anything else should be restructured, not opted out. */
export const singleExit: LintRule = {
  id: 'single-exit',
  description: 'MISRA-C Rule 15.5 — a single point of exit (one return, as the final statement)',
  severity: 'error',
  category: 'style',
  create: (ctx) => ({
    Func(f) {
      for (const msg of checkSingleExit(f)) ctx.report(msg, { fn: f.name })
    },
  }),
}
