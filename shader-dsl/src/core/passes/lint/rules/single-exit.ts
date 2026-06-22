import type { LintRule } from '../engine'
import { checkSingleExit } from '../../single-exit'

/** MISRA-C Rule 15.5 — a single point of exit (one return, as the final statement).
 *  The structural check lives in passes/single-exit.ts; this wires it as a rule. */
export const singleExit: LintRule = {
  id: 'single-exit',
  description: 'MISRA-C Rule 15.5 — a single point of exit (one return, as the final statement)',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Func(f) {
      for (const msg of checkSingleExit(f)) ctx.report(msg, { fn: f.name })
    },
  }),
}
