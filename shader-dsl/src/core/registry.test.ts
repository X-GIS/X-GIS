// ═══ buildRegistry — the validator half is the point (#1716) ═══
//
// Rendering a registry is easy; what everyone re-invents (and re-invents differently) is
// the CHECK that the curated list and the discovered set describe the same programs. Both
// directions have to fail — a curated id naming no module, and a module no curated id
// names — because the second is the one that actually bites: add a file, forget to
// register it, and it is simply absent with nothing to notice.

import { describe, it, expect } from 'vitest'
import { buildRegistry } from './registry.js'

const ENTRIES = [
  { id: 'alpha', importPath: './alpha.ts', exportName: 'alpha' },
  { id: 'beta', importPath: './beta.ts', exportName: 'beta' },
]

describe('buildRegistry — rendering', () => {
  it('renders a keyed union and record, in the CURATED order', () => {
    const { source, ids } = buildRegistry(ENTRIES, {
      order: ['beta', 'alpha'],
      typeName: 'DemoKey',
      recordName: 'DEMO',
      valueType: 'Demo',
    })
    expect(ids).toEqual(['beta', 'alpha'])
    expect(source).toContain('export type DemoKey =')
    expect(source).toContain('  | "beta"\n  | "alpha"')
    expect(source).toContain('export const DEMO: Readonly<Record<DemoKey, Demo>> = {')
    // Order is honoured in the imports too, so the file reads in one direction.
    expect(source.indexOf("from './beta.ts'")).toBeLessThan(source.indexOf("from './alpha.ts'"))
  })

  it('carries a DO-NOT-EDIT banner naming the regeneration command', () => {
    const { source } = buildRegistry(ENTRIES, { regenerateWith: 'bun scripts/gen.ts > out.ts' })
    expect(source.startsWith('// GENERATED — DO NOT EDIT.')).toBe(true)
    expect(source).toContain('// Regenerate with: bun scripts/gen.ts > out.ts')
  })

  it('is deterministic — same input, byte-identical output', () => {
    // A generator whose output churns cannot have a freshness gate.
    const a = buildRegistry(ENTRIES, { order: ['alpha', 'beta'] }).source
    const b = buildRegistry(ENTRIES, { order: ['alpha', 'beta'] }).source
    expect(a).toBe(b)
  })

  it('falls back to discovery order when no curation is given', () => {
    expect(buildRegistry(ENTRIES).ids).toEqual(['alpha', 'beta'])
  })
})

describe('buildRegistry — the drift it exists to catch', () => {
  it('a curated id that names no module fails, naming it', () => {
    expect(() => buildRegistry(ENTRIES, { order: ['alpha', 'beta', 'ghost'] })).toThrow(
      /curated but not discovered: ghost/,
    )
  })

  it('a discovered module no curated id names fails, naming it', () => {
    // The direction that actually bites: added a file, forgot to register it.
    expect(() => buildRegistry(ENTRIES, { order: ['alpha'] })).toThrow(
      /discovered but not curated: beta/,
    )
  })

  it('BOTH directions are reported in one failure, not just the first', () => {
    const run = () => buildRegistry(ENTRIES, { order: ['alpha', 'ghost'] })
    expect(run).toThrow(/curated but not discovered: ghost/)
    expect(run).toThrow(/discovered but not curated: beta/)
  })

  it('the failure names the regeneration command when it was given one', () => {
    expect(() =>
      buildRegistry(ENTRIES, { order: ['alpha'], regenerateWith: 'bun scripts/gen.ts' }),
    ).toThrow(/regenerate with: bun scripts\/gen\.ts/)
  })

  it('a duplicate id fails rather than letting one entry silently win', () => {
    expect(() => buildRegistry([...ENTRIES, ENTRIES[0]!])).toThrow(/duplicate id 'alpha'/)
  })

  it('an export name that is not an identifier fails', () => {
    // It would render a syntactically broken import that only tsc would catch, and only
    // after the file was written.
    expect(() =>
      buildRegistry([{ id: 'x', importPath: './x.ts', exportName: 'not an ident' }]),
    ).toThrow(/is not an identifier/)
  })

  it('a matching curated set passes — the arms above are not just "always throws"', () => {
    expect(() => buildRegistry(ENTRIES, { order: ['beta', 'alpha'] })).not.toThrow()
  })
})
