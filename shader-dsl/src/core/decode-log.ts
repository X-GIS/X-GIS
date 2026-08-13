// ═══ Shader DSL — decoding a production driver log ═══
//
// `mangle({ renames })` and `aliasTypes({ renames })` fill a Map because the
// emitted text is unreadable on purpose: a driver error from a shipped build
// says `no matching overload for operator -` in function `b`, at a `d` of type
// `l`. The Map is the shader source map. This is the half that USES it.
//
// The map is authored → emitted, and inverting it is where the honesty lives:
//   • module-scope names (helper fns, plain structs, module consts) and type
//     aliases invert UNIQUELY — one `b`, one authored name. These are what a
//     driver names, and they decode cleanly.
//   • function-scoped names (params, locals) deliberately REUSE the short end of
//     the alphabet in every function, so one `f` inverts to many authored names.
//     Guessing one would be worse than saying so.
//
// So an ambiguous name is annotated with its candidates rather than replaced,
// and the caller sees which it is. Nothing here runs at emit time; it is a
// build/debug tool that a shipped bundle never imports (`/emit-prod`).

/** How a decoded name was resolved — the count is the ambiguity. */
export interface DecodedName {
  readonly emitted: string
  /** Authored names that could have produced it, in the map's insertion order. */
  readonly authored: readonly string[]
}

const KEY_SCOPE = /^(.+)\.([^.]+)$/

/** Invert an authored → emitted rename map. A function-scoped key
 *  (`authoredFn.authoredName`) contributes its LOCAL half, qualified back to the
 *  function it came from, so `noise.coordinate → f` inverts to
 *  `f → 'coordinate (in noise)'`. */
export function invertRenames(
  renames: ReadonlyMap<string, string>,
): ReadonlyMap<string, DecodedName> {
  const byEmitted = new Map<string, string[]>()
  for (const [from, to] of renames) {
    const scoped = KEY_SCOPE.exec(from)
    // A type spelling is the one key that legitimately contains no scope but may
    // contain punctuation (`vec2<f32>`); it is not a `fn.local` pair.
    const label = scoped !== null && !/[<>]/.test(from) ? `${scoped[2]!} (in ${scoped[1]!})` : from
    const list = byEmitted.get(to)
    if (list) list.push(label)
    else byEmitted.set(to, [label])
  }
  const out = new Map<string, DecodedName>()
  for (const [emitted, authored] of byEmitted) out.set(emitted, { emitted, authored })
  return out
}

/** Rewrite a driver log / GPU capture back into authored names.
 *
 *  A name that inverts uniquely is REPLACED; one that inverts to several (the
 *  reused function-scoped names) is annotated `f⟨p (in noise) | t (in shade)⟩`,
 *  because picking one would be a guess the log cannot support. Text that is not
 *  an identifier — the driver's own prose, line numbers, source excerpts — is
 *  untouched, since the substitution is token-wise, not a substring replace:
 *  replacing `b` as a substring would corrupt every word containing it. */
export function decodeShaderLog(log: string, renames: ReadonlyMap<string, string>): string {
  const table = invertRenames(renames)
  if (table.size === 0) return log
  return log.replace(/[A-Za-z_]\w*/g, (word) => {
    const hit = table.get(word)
    if (hit === undefined) return word
    return hit.authored.length === 1 ? hit.authored[0]! : `${word}⟨${hit.authored.join(' | ')}⟩`
  })
}
