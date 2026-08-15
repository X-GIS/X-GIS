// ═══ Discover the example modules on disk (#1716) ═══
//
// ONE authority for the export convention, shared by the generator
// (`scripts/gen-example-registry.ts`) and the drift gate (`registry-drift.test.ts`). Two
// copies of a regex is how a scan and the gate that checks it come to disagree, and the
// disagreement is invisible: both keep passing, on different sets.
//
// Reads the filesystem, so it is NOT importable from the browser build — hence the leading
// underscore, which also keeps it out of its own discovery (the `_` files are helpers, not
// examples). It stays inside `shader-dsl/` rather than moving to root `scripts/` because
// `registry-drift.test.ts` imports it, and nothing tracked under `shader-dsl/` may reference
// a path outside the package (`src/self-contained.test.ts`).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** `export const <name>: ShaderExample = {` … `id: '<id>'` — the convention every example
 *  file follows. Both must be present for a file to count as an example. */
const DECL = /export const (\w+)\s*:\s*ShaderExample\s*=/
const ID = /\bid:\s*'([^']+)'/

/** One discovered example: its stable id, the module to import, and the binding to import. */
export interface DiscoveredExample {
  readonly id: string
  readonly importPath: string
  readonly exportName: string
}

/**
 * Every example module in `dir`, sorted by id.
 *
 * The export name is READ rather than derived from the filename, because it is not derivable:
 * `shadertoy-plasma.ts` exports `plasma` and `gradient-pass.ts` exports `gradient`. A
 * generator that guessed would emit imports that do not resolve, and only tsc would say so.
 *
 * @param dir - the examples directory.
 * @returns the discovered set, id-sorted so the result is deterministic across filesystems.
 */
export function discoverExamples(dir: string): readonly DiscoveredExample[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'))
    .flatMap((file) => {
      const src = readFileSync(join(dir, file), 'utf8')
      const decl = DECL.exec(src)
      const id = ID.exec(src)
      return decl && id ? [{ id: id[1]!, importPath: `./${file}`, exportName: decl[1]! }] : []
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}
