// Shared test helper: cross-check a single-source vertex-format spec against
// the WGSL vertex entry it feeds. Pure functions (no expect) so each spec's
// test owns the assertion. Used by vertex-layout-consistency.test.ts (polygon)
// and the point/text/icon layout tests.

import type { VertexFormat } from '@xgis/compiler'

/** Parse `@location(N) name: type` inputs a WGSL fn declares → location→type. */
export function parseVertexFnParamTypes(shaderSrc: string, fnName: string): Map<number, string> | null {
  const re = new RegExp(`fn ${fnName}\\s*\\(([\\s\\S]*?)\\)\\s*->`)
  const m = shaderSrc.match(re)
  if (!m) return null
  const out = new Map<number, string>()
  const pRe = /@location\((\d+)\)\s+\w+\s*:\s*([\w<>]+)/g
  let p: RegExpExecArray | null
  while ((p = pRe.exec(m[1]!)) !== null) out.set(parseInt(p[1]!, 10), p[2]!.trim())
  return out
}

/** Return human-readable mismatches between a vertex-format spec and the WGSL
 *  entry that consumes it: a field whose @location is missing or whose WGSL
 *  type differs, plus any shader location not present in the spec. Empty array
 *  == spec and shader agree exactly. The caller asserts `=== []`. */
export function specShaderMismatches(fmt: VertexFormat, shaderSrc: string, fnName: string): string[] {
  const shaderTypes = parseVertexFnParamTypes(shaderSrc, fnName)
  if (!shaderTypes) return [`WGSL fn ${fnName} not found in emit`]
  const issues: string[] = []
  for (const f of fmt.fields) {
    const got = shaderTypes.get(f.location)
    if (got !== f.wgslType) {
      issues.push(`loc${f.location} (${f.name}): spec '${f.wgslType}' vs shader '${got ?? 'absent'}'`)
    }
  }
  const specLocs = new Set(fmt.fields.map((f) => f.location))
  for (const loc of shaderTypes.keys()) {
    if (!specLocs.has(loc)) issues.push(`${fnName} reads @location(${loc}) not in spec`)
  }
  return issues
}
