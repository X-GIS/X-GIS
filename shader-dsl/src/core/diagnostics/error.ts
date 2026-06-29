// ═══ Shader DSL — structured error + source location ═══
//
// One canonical error shape (`ShaderDslError`) carrying a stable `code` (see ./codes),
// an optional one-line `hint`, and an optional authored-source `loc` (see ./loc). The
// `dslError(code, detail?)` factory composes a readable `.message` from the catalogue
// entry + the dynamic detail, and is the single replacement for the package's former
// bare `throw new Error('shader-dsl: …')` sites.
//
// The two pre-existing public error classes (ValidationError, UnsupportedFeatureError)
// subclass this so `instanceof` / `.name` checks in consumers keep working, while every
// thrown error now carries a code the host can branch on.

import { CODES, type ErrorCode, type ErrorCodeDef } from './codes'

/** A pointer back into the AUTHORED TypeScript — the first stack frame outside this
 *  package, captured (opt-in) when source tracing is on. Never emitted into WGSL/GLSL. */
export interface SourceLoc {
  readonly file: string
  readonly line: number
  readonly col: number
}

/** `file:line:col` — the shared one-line spelling of a SourceLoc (reused by the
 *  aggregated validation message and by formatReport). */
export const formatLoc = (loc: SourceLoc): string => `${loc.file}:${loc.line}:${loc.col}`

export class ShaderDslError extends Error {
  readonly code: string
  readonly hint?: string
  readonly loc?: SourceLoc
  constructor(opts: { code: string; message: string; hint?: string; loc?: SourceLoc }) {
    super(opts.message)
    this.name = 'ShaderDslError'
    this.code = opts.code
    this.hint = opts.hint
    this.loc = opts.loc
  }
}

/** Compose the human message for a coded error: a `shader-dsl [SD####]: <summary>` head,
 *  the dynamic `detail` (if any), then indented `hint:` / `at file:line:col` lines. */
export function formatMessage(
  code: string,
  summary: string,
  opts?: { detail?: string; hint?: string; loc?: SourceLoc },
): string {
  let msg = `shader-dsl [${code}]: ${summary}`
  if (opts?.detail) msg += ` — ${opts.detail}`
  if (opts?.loc) msg += `\n  at ${formatLoc(opts.loc)}`
  if (opts?.hint) msg += `\n  hint: ${opts.hint}`
  return msg
}

/** Build a coded ShaderDslError from the catalogue. `detail` carries the dynamic part
 *  of the message (the offending types / names); `opts.hint` overrides the catalogue
 *  hint when a call site has a more specific one. */
export function dslError(
  code: ErrorCode,
  detail?: string,
  opts?: { hint?: string; loc?: SourceLoc },
): ShaderDslError {
  const def: ErrorCodeDef = CODES[code]
  const hint = opts?.hint ?? def.hint
  return new ShaderDslError({
    code,
    message: formatMessage(code, def.summary, { detail, hint, loc: opts?.loc }),
    hint,
    loc: opts?.loc,
  })
}
