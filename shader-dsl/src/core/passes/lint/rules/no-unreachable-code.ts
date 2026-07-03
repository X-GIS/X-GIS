import type { Stmt } from '../../../ir'
import type { LintRule } from '../engine'

function reportUnreachable(
  body: readonly Stmt[],
  fnName: string,
  report: (m: string, o?: { fn?: string }) => void,
): void {
  body.forEach((s, i) => {
    const terminator =
      s.s === 'return' || s.s === 'discard' || s.s === 'break' || s.s === 'continue'
    if (terminator && i < body.length - 1) {
      report(`unreachable statement after '${s.s}' in fn '${fnName}'`, { fn: fnName })
    }
    if (s.s === 'if') {
      for (const arm of s.arms) reportUnreachable(arm.body, fnName, report)
      if (s.elseBody) reportUnreachable(s.elseBody, fnName, report)
    } else if (s.s === 'for') {
      reportUnreachable(s.body, fnName, report)
    } else if (s.s === 'switch') {
      for (const c of s.cases) reportUnreachable(c.body, fnName, report)
      if (s.defaultBody) reportUnreachable(s.defaultBody, fnName, report)
    }
  })
}

/** No statements after a return / discard / break / continue in the same block. */
export const noUnreachable: LintRule = {
  id: 'no-unreachable-code',
  description: 'no statements after a return / discard / break / continue in the same block',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Func(f) {
      reportUnreachable(f.body, f.name, ctx.report)
    },
  }),
}
