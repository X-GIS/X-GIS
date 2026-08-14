// ═══ Shader DSL — registry generation from a set of discovered modules (#1716) ═══
//
// At 20+ programs the hand-written wiring file becomes the bottleneck: a consumer reported
// 762 lines of import → key → emitter → reflection boilerplate, and adding a program means
// editing it in three places. This is the reusable half of the fix.
//
// It is a PURE RENDERER + VALIDATOR, deliberately: no filesystem, no glob, nothing that
// stops the package being browser-safe. The scan belongs to the caller, because the
// discovery convention is the caller's — their directory layout, their export names, their
// id scheme. What everyone would otherwise re-invent (and re-invent slightly differently)
// is the part below: checking the discovered set against the curated one, and rendering a
// deterministic module from it.
//
// The split matters, and scoping this increment is what surfaced why. The obvious dogfood
// was `shader-dsl/examples/index.ts` — 36 hand-maintained imports, exactly this issue's
// problem statement. But the part of that file which is genuinely hand-maintained is not
// the imports; it is the ORDER:
//
//     /** All examples, cartographic first (they belong on a map site), then generic … */
//
// A scan can enumerate modules. It cannot know that cartographic examples lead because the
// site is a map site. That curation is editorial value a generator does not produce — the
// same thing #1700 says about the reference page's grouping. So `order` is an INPUT here,
// not an output, and the gate's job is to prove the curated list and the discovered set
// describe the same programs.

/** One discovered module, as the caller's scan found it. */
export interface RegistryEntry {
  /** The stable id: the registry key, and what a pipeline cache or baked artifact names. */
  readonly id: string
  /** Module specifier to import from, exactly as it should appear in the generated file. */
  readonly importPath: string
  /** The exported binding to import from `importPath`. */
  readonly exportName: string
}

/** Options for {@link buildRegistry}. */
export interface BuildRegistryOptions {
  /** The curated id order. When given, it must name EVERY discovered id and no others —
   *  that mutual check is the drift this exists to catch (a new module nobody registered,
   *  or a registered id whose module was deleted). Omit to use discovery order. */
  readonly order?: readonly string[]
  /** Name of the generated union type. Default `RegistryKey`. */
  readonly typeName?: string
  /** Name of the generated id → module record. Default `REGISTRY`. */
  readonly recordName?: string
  /** Type annotation for a registry value, e.g. `ShaderExample`. Default `unknown`. */
  readonly valueType?: string
  /** Extra import line(s) placed above the generated ones — where `valueType` comes from. */
  readonly imports?: readonly string[]
  /** The command that regenerates this file, named in the banner so a reader who hits a
   *  drift failure is told what to run rather than left to guess. */
  readonly regenerateWith?: string
}

/** What {@link buildRegistry} produced. */
export interface BuiltRegistry {
  /** The rendered TypeScript module. */
  readonly source: string
  /** The ids, in the order they appear in the rendered file. */
  readonly ids: readonly string[]
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Validate a discovered module set against a curated order and render a registry module
 * from it (#1716): a typed key union, an id → module record, and the imports feeding it.
 *
 * ```ts
 * const { source } = buildRegistry(scan('./examples'), {
 *   order: CURATED_IDS,               // editorial; the scan cannot derive it
 *   valueType: 'ShaderExample',
 *   imports: ["import type { ShaderExample } from './_shared.ts'"],
 *   regenerateWith: 'bun scripts/gen-registry.ts > examples/registry.generated.ts',
 * })
 * ```
 *
 * @param entries - every module the caller's scan discovered.
 * @param opts - curated order, naming, and banner details.
 * @returns the rendered source and the ids in file order.
 * @throws when two entries share an id, when an export name is not an identifier, or when
 *   `order` and the discovered set disagree in either direction — a curated id naming no
 *   module, or a module no curated id names. Both are the real drift; reporting only the
 *   first would let a newly added module sit unregistered and invisible.
 */
export function buildRegistry(
  entries: readonly RegistryEntry[],
  opts?: BuildRegistryOptions,
): BuiltRegistry {
  const byId = new Map<string, RegistryEntry>()
  for (const e of entries) {
    if (byId.has(e.id)) throw new Error(`shader-dsl: buildRegistry duplicate id '${e.id}'`)
    if (!IDENT.test(e.exportName))
      throw new Error(
        `shader-dsl: buildRegistry export name '${e.exportName}' for '${e.id}' is not an identifier`,
      )
    byId.set(e.id, e)
  }

  let ids: readonly string[] = [...byId.keys()]
  if (opts?.order) {
    const curated = new Set(opts.order)
    const unknown = opts.order.filter((id) => !byId.has(id))
    const unregistered = ids.filter((id) => !curated.has(id))
    if (unknown.length || unregistered.length)
      throw new Error(
        `shader-dsl: buildRegistry order does not match the discovered modules.` +
          (unknown.length ? `\n  curated but not discovered: ${unknown.join(', ')}` : '') +
          (unregistered.length
            ? `\n  discovered but not curated: ${unregistered.join(', ')}`
            : '') +
          (opts.regenerateWith ? `\n  regenerate with: ${opts.regenerateWith}` : ''),
      )
    ids = opts.order
  }

  const typeName = opts?.typeName ?? 'RegistryKey'
  const recordName = opts?.recordName ?? 'REGISTRY'
  const valueType = opts?.valueType ?? 'unknown'
  const rows = ids.map((id) => byId.get(id)!)

  const source = [
    `// GENERATED — DO NOT EDIT.`,
    ...(opts?.regenerateWith ? [`// Regenerate with: ${opts.regenerateWith}`] : []),
    `//`,
    `// The id ORDER is curated, not discovered — see the generator's \`order\` input.`,
    ``,
    ...(opts?.imports ?? []),
    ...rows.map((r) => `import { ${r.exportName} } from '${r.importPath}'`),
    ``,
    `/** Every registry id. */`,
    `export type ${typeName} =`,
    ...ids.map((id) => `  | ${JSON.stringify(id)}`),
    ``,
    `/** Every registered module, keyed by id. */`,
    `export const ${recordName}: Readonly<Record<${typeName}, ${valueType}>> = {`,
    ...rows.map((r) => `  ${JSON.stringify(r.id)}: ${r.exportName},`),
    `}`,
    ``,
  ].join('\n')

  return { source, ids }
}
