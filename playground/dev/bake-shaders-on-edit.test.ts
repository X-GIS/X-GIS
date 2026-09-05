// ═══ Bake HMR — the plugin's three claims, each with a fail-before arm (#2535) ═══
//
//   (1) `syncBakedFiles` formats with the REPO's prettier config and writes only what moved —
//       a double-quoted key comes back single-quoted and the semicolon goes (the repo config
//       was honoured, not prettier's defaults), a second sync writes nothing, a mutated file
//       is rewritten and its untouched sibling is not. Arm 1 has now caught two ways of
//       getting this silently wrong at exit 0: a prettier CLI spawn formats NOTHING for paths
//       outside its ignore files' directory, and the API formats with DEFAULTS when the
//       config is resolved for the staging path instead of the artifact's committed one.
//   (2) ONE AUTHORITY — what the plugin renders through Vite's SSR runner, formatted, is
//       byte-identical to the six COMMITTED artifacts, which `bun run bake:shaders` wrote.
//       The CLI and the plugin therefore cannot disagree about the bytes; `baked-sync`
//       remains the key-by-key gate against the emitters.
//   (3) The dependency set is DERIVED: it holds the emitters, the seam, the body consts and
//       the DSL core, and not the artifacts themselves — a write must not re-trigger a bake.
//
// The server is the REAL playground config in middleware mode (no port, no watcher, no HMR
// channel), so the module resolution under test is the one `bun run dev` uses.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { BAKED_DIR, runBake, syncBakedFiles, type BakeRun } from './bake-shaders-on-edit'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

describe('syncBakedFiles — root prettier, write-only-what-moved', () => {
  const out = mkdtempSync(join(tmpdir(), 'xgis-bake-hmr-test-'))
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  const rendered = [
    { file: 'a.generated.ts', text: 'export const A = {\n  "k": "v",\n}\n' },
    { file: 'b.generated.ts', text: 'export const B = {\n  "k": "w",\n}\n' },
  ]

  it('formats with the repo config (double → single quotes) and writes every new file', async () => {
    const r = await syncBakedFiles(rendered, out)
    expect(r.written.sort()).toEqual(['a.generated.ts', 'b.generated.ts'])
    expect(r.unchanged).toEqual([])
    const a = readFileSync(join(out, 'a.generated.ts'), 'utf8')
    // prettier's DEFAULT is double quotes; the repo's `.prettierrc.json` says singleQuote.
    expect(a).toContain("k: 'v'")
    expect(a).not.toContain('"k"')
    // `.prettierrc.json` says `semi: false`; prettier's default says otherwise.
    expect(a).not.toContain('};')
  })

  it('a second sync of the same text writes nothing', async () => {
    const r = await syncBakedFiles(rendered, out)
    expect(r.written).toEqual([])
    expect(r.unchanged.sort()).toEqual(['a.generated.ts', 'b.generated.ts'])
  })

  it('a file that drifted on disk is rewritten; its untouched sibling is not', async () => {
    writeFileSync(join(out, 'a.generated.ts'), '// drift\n')
    const r = await syncBakedFiles(rendered, out)
    expect(r.written).toEqual(['a.generated.ts'])
    expect(r.unchanged).toEqual(['b.generated.ts'])
    expect(readFileSync(join(out, 'a.generated.ts'), 'utf8')).toContain("k: 'v'")
  })
})

describe('runBake through the real playground Vite config', () => {
  let server: ViteDevServer
  let run: BakeRun
  const out = mkdtempSync(join(tmpdir(), 'xgis-bake-hmr-run-'))

  beforeAll(async () => {
    server = await createServer({
      configFile: join(ROOT, 'playground/vite.config.ts'),
      logLevel: 'silent',
      server: { middlewareMode: true, watch: null, hmr: false },
    })
    run = await runBake(server, out)
  }, 180_000)
  afterAll(async () => {
    await server.close()
    rmSync(out, { recursive: true, force: true })
  })

  it('(2) renders the six committed artifacts byte-for-byte — one authority with the CLI', () => {
    expect(run.sync).toBeDefined()
    const files = [...run.sync!.written, ...run.sync!.unchanged].sort()
    expect(files).toEqual([
      'baked-glsl-boot.generated.ts',
      'baked-glsl-hillshade.generated.ts',
      'baked-glsl-lazy.generated.ts',
      'baked-wgsl-boot.generated.ts',
      'baked-wgsl-hillshade.generated.ts',
      'baked-wgsl-lazy.generated.ts',
    ])
    for (const f of files) {
      const plugin = readFileSync(join(out, f))
      const committed = readFileSync(join(BAKED_DIR, f))
      expect(
        plugin.equals(committed),
        `${f}: the plugin's formatted render differs from the committed artifact — either the ` +
          `tree needs \`bun run bake:shaders\` (baked-sync says so too) or the two paths drifted`,
      ).toBe(true)
    }
  })

  it('(3) the dependency set is the evaluated import closure, and excludes the artifacts', () => {
    const rel = [...run.deps].map((f) => f.replace(ROOT, '')).sort()
    for (const must of [
      'map/src/shaders/baked/bake-all.ts',
      'map/src/shaders/baked/bake.ts',
      'map/src/shaders/baked/registry.ts',
      'map/src/shaders/dsl/polygon.ts',
      'map/src/shaders/dsl/projections.ts',
      'map/src/render/material/wgsl-for.ts',
      'map/src/body-consts.ts',
      'shader-dsl/src/index.ts',
      'geo/src/projections-table.ts',
    ])
      expect(rel, `${must} must be a bake dependency`).toContain(must)
    expect(rel.filter((f) => f.endsWith('.generated.ts'))).toEqual([])
    expect(rel.filter((f) => f.includes('node_modules'))).toEqual([])
    // Sanity on size: the whole DSL corpus, not a handful of files.
    expect(rel.length).toBeGreaterThan(60)
  })
})
