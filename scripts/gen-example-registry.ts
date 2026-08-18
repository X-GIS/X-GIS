// ═══ Generate shader-dsl/examples/index.ts from the directory + the curated order (#1716) ═══
//
//     bun scripts/gen-example-registry.ts > shader-dsl/examples/index.ts
//
// Writes to STDOUT, following `scripts/emit-gap-matrix.ts`: the caller redirects, so a
// half-written artifact is impossible and a dry run costs nothing. The alternative in-repo
// precedent (`gen-opendata-hosts.ts`, write-in-place) has no freshness gate, which is the
// failure #1716 exists to avoid — this one has `gen-example-registry.test.ts`.
//
// WHY THIS LIVES AT REPO ROOT: it must be invoked from the root and it writes into the
// package, and nothing tracked under `shader-dsl/` may reference a path outside it
// (`shader-dsl/src/self-contained.test.ts`). The `bake:goldens` relocation is the precedent.
//
// WHAT IT DOES NOT OWN: the ORDER. `examples/_order.ts` is hand-written, because a scan can
// enumerate the modules but cannot know that cartographic examples lead. Before this, that
// ordering lived in `index.ts` twice — the re-export block and the `examples` array — beside
// 35 imports, so adding one example meant editing three places. That is the issue verbatim.
//
// WHY IT RENDERS THE FILE ITSELF rather than using `buildRegistry`'s output: buildRegistry
// emits a keyed `Record` + a key union, and this file's shape is an ordered ARRAY plus named
// re-exports that `@xgis/shader-dsl/examples` already publishes. Bending the generic renderer
// to one consumer's shape would be gold-plating; its reusable half is the VALIDATOR, and that
// is what gets used here — both drift directions, reported in one message.
//
// A note recorded rather than acted on: nothing in this repo imports any of the 35 named
// re-exports — every consumer takes `examples` and the types. They are kept because removing
// public surface from a published subpath is a separate decision from generating this file.

import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRegistry } from '../shader-dsl/src/core/registry.ts'
import { discoverExamples } from '../shader-dsl/examples/_scan.ts'
import { CURATED_ORDER } from '../shader-dsl/examples/_order.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const EXAMPLES_DIR = join(ROOT, 'shader-dsl/examples')
export const REGISTRY_PATH = join(EXAMPLES_DIR, 'index.ts')
export const REGENERATE_WITH = 'bun scripts/gen-example-registry.ts > shader-dsl/examples/index.ts'

/**
 * Render `shader-dsl/examples/index.ts` from the discovered modules and the curated order.
 *
 * @param dir - the examples directory to scan. Defaults to the one in this repo.
 * @returns the complete file contents, ending in a newline.
 * @throws when the directory and `CURATED_ORDER` disagree in either direction — an id naming
 *   no module, or a module no id names. The second is the one that bites: add a file, forget
 *   to register it, and it is simply absent with nothing to notice.
 */
export function renderExampleRegistry(dir: string = EXAMPLES_DIR): string {
  const found = discoverExamples(dir)
  // buildRegistry is the VALIDATOR here. Its rendered source is discarded on purpose — see
  // the header — but its two-way check and its ordered ids are exactly what this needs.
  const { ids } = buildRegistry([...found], {
    order: CURATED_ORDER,
    regenerateWith: REGENERATE_WITH,
  })
  const byId = new Map(found.map((e) => [e.id, e]))
  const rows = ids.map((id) => byId.get(id)!)

  return [
    `// ═══ @xgis/shader-dsl examples — registry ═══`,
    `//`,
    `// GENERATED — DO NOT EDIT.`,
    `// Regenerate with: ${REGENERATE_WITH}`,
    `//`,
    `// The single import surface for the examples: the CLI printer (print.ts) and the site's`,
    `// interactive /shader-dsl page both consume \`examples\` from here. Each entry carries its`,
    `// built DSL \`module\` (emit WGSL/GLSL + reflect from it) plus the metadata the site needs`,
    `// to render + control it. This file is runtime-free and browser-safe (no console / node).`,
    `//`,
    `// The ORDER is curated, not discovered — edit \`_order.ts\`, then regenerate. Adding an`,
    `// example is: write the file, add its id to \`_order.ts\`, run the command above.`,
    ``,
    ...rows.map((r) => `import { ${r.exportName} } from '${r.importPath}'`),
    `import type { ShaderExample } from './_shared.js'`,
    ``,
    `export type { ShaderExample, Control } from './_shared.js'`,
    `export {`,
    ...rows.map((r) => `  ${r.exportName},`),
    `}`,
    ``,
    `/** All examples, cartographic first (they belong on a map site), then generic, then compute. */`,
    `export const examples: readonly ShaderExample[] = [`,
    ...rows.map((r) => `  ${r.exportName},`),
    `]`,
    ``,
  ].join('\n')
}

// STDOUT by contract (see the header) — `> index.ts` is the caller's job. The `--write` form
// exists for the freshness gate's fix-it instruction, so nobody has to remember the redirect.
if (import.meta.main) {
  const source = renderExampleRegistry()
  if (process.argv.includes('--write')) writeFileSync(REGISTRY_PATH, source)
  else process.stdout.write(source)
}
