// ═══ Shader DSL — emitted-text minifier ═══
//
// Whitespace/comment compaction of an ALREADY-EMITTED WGSL / GLSL ES 3.00
// string. Provably token-safe because of two language facts:
//   • neither language has string literals — a `//` always starts a comment,
//     and whitespace is never significant inside any token;
//   • a newline is ordinary whitespace EXCEPT around GLSL preprocessor
//     directives (`#version`, `#extension`), which must sit on their own line
//     — directive lines pass through verbatim.
//
// Space-removal is deliberately conservative: a space is dropped only when it
// touches STRUCTURAL punctuation ((){}[];,:?) — characters that never begin or
// end a multi-character operator, so no `- -x` → `--x` / `a / /(b)` → `//`
// token can be created. Spaces around math/assignment operators are kept
// (a few bytes for zero ambiguity). Idempotent; no semantic change — the
// compile gates run the minified output on real Tint + ANGLE.

const STRUCTURAL = new Set(['(', ')', '{', '}', '[', ']', ';', ',', ':', '?'])

function squeeze(line: string): string {
  const collapsed = line.replace(/\s+/g, ' ').trim()
  let out = ''
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i]!
    if (ch === ' ') {
      const prev = out[out.length - 1]
      const next = collapsed[i + 1]
      if (prev !== undefined && next !== undefined && (STRUCTURAL.has(prev) || STRUCTURAL.has(next)))
        continue
    }
    out += ch
  }
  return out
}

/** Minify an emitted WGSL / GLSL shader string: strip `//` comments and blank
 *  lines, keep `#` directive lines verbatim on their own line, and join
 *  everything between them into single compact lines. */
export function minifyShaderText(src: string): string {
  const out: string[] = []
  let buf: string[] = []
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(squeeze(buf.join(' ')))
      buf = []
    }
  }
  for (const rawLine of src.split('\n')) {
    // No string literals in WGSL/GLSL — the first `//` is always a comment.
    const idx = rawLine.indexOf('//')
    const line = (idx === -1 ? rawLine : rawLine.slice(0, idx)).trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      flush()
      out.push(line)
    } else buf.push(line)
  }
  flush()
  return out.join('\n') + '\n'
}
