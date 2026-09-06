// ═══ Bake HMR — re-derive the six committed shader artifacts on every edit they depend on (#2535) ═══
//
// WHY. With bake-by-default (#2499) a closed-set shader is served from the COMMITTED
// artifact: `install.ts` merges `baked-*-boot.generated.ts` into the store at device attach,
// and every keyed call site reads the store before its emit thunk (`wgsl-for.ts`:
// `bakedSource(id) ?? shipSource(emit())`). So an edit under `map/src/shaders/dsl/**`
// changes nothing on screen until `bun run build && bun run bake:shaders` — three steps,
// with the stale-bake trap in the middle (`map/scripts/bake-shaders.ts` header). This plugin
// makes the loop one step: when a file the bake depends on changes, re-render the artifacts
// INSIDE the dev server and write the ones whose bytes moved; Vite then reloads the page (the
// artifact modules have no HMR boundary) and the next attach installs the fresh bake. The
// committed bytes are re-derived from the sources on every edit, so a commit made from a
// running dev server cannot carry a stale bake.
//
// NO BUILD NEEDED HERE. The CLI emits through `shader-dsl/dist` (bun honours map's tsconfig
// `paths`); this runs the SAME `renderAllBakedModules` (`map/src/shaders/baked/bake-all.ts`,
// the one authority the CLI also calls) through Vite's SSR module runner, where
// `@xgis/shader-dsl` / `@xgis/geo` / `@xgis/shared` resolve to SOURCE by their package
// `exports` and `@xgis/map` by the alias in vite.config.ts — the live tree, edit included.
//
// THE DEPENDENCY SET IS DERIVED, NOT LISTED. After each run, the files the runner evaluated
// (`runner.evaluatedModules`) ARE the files the bake depends on — every emitter, the DSL
// core, the projection table, the body consts, the minifier. A hand-kept glob would go blind
// the day a helper moved (§12's path-keyed-gate lesson); this set cannot. The first run, at
// server start, only LEARNS the set — it renders nothing and writes nothing — so a stale
// committed artifact is never rewritten underneath a page that is booting, and a render gate
// can never go green on bytes nobody committed. Writes happen only after a change event.
//
// WRITE ONLY WHAT MOVED. The rendered text is formatted first — the committed bytes are
// prettier's output (`singleQuote` alone rewrites every JSON-quoted key), so an unformatted
// comparison would rewrite all six files on every edit and reload the page for nothing.
// Formatting goes through prettier's API with the config RESOLVED FOR THE TARGET PATH
// (`.prettierrc.json` and `.editorconfig`, exactly what the CLI's `--write` resolves), so the
// two writers cannot drift; the test asserts that byte-for-byte against the committed six.
// A CLI spawn was tried first and is the wrong tool here: prettier SKIPS a path outside the
// directory its ignore files live in, so staging the render in a temp dir formatted nothing
// and the artifacts came out double-quoted — silently, at exit 0.
//
// OFF where nothing edits. `apply` refuses `build`, `CI`, and `XGIS_BAKE_HMR=0` — which the
// Playwright config sets for its webServer: a test fixture edits no sources (§7), and the
// learning run would otherwise share every render gate's boot with SwiftShader.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'
import { createServerModuleRunner, normalizePath, type Plugin, type ViteDevServer } from 'vite'

/** What `renderAllBakedModules` returns, as far as this file needs it. */
export interface RenderedText {
  /** File name relative to `map/src/shaders/baked/`. */
  file: string
  /** Module source before prettier. */
  text: string
}

export interface BakeSync {
  written: string[]
  unchanged: string[]
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
/** The one bake authority (`map/src/shaders/baked/bake-all.ts`), by absolute path. */
export const BAKE_ENTRY = join(ROOT, 'map/src/shaders/baked/bake-all.ts')
/** Where the six committed artifacts live. */
export const BAKED_DIR = join(ROOT, 'map/src/shaders/baked')

/** Format each rendered module the way `prettier --write` would at its target path, and write
 *  into `outDir` ONLY the files whose formatted bytes differ from what is already there. */
export async function syncBakedFiles(
  rendered: readonly RenderedText[],
  outDir: string,
): Promise<BakeSync> {
  const written: string[] = []
  const unchanged: string[] = []
  for (const m of rendered) {
    // Formatted for the file's HOME — the committed artifact's path — not for wherever this
    // sync writes: prettier resolves its config by walking UP from the path it is given, so
    // formatting for a temp directory silently yields prettier's DEFAULTS (double quotes,
    // semicolons) instead of the repo's. In production the two paths are the same file; a
    // test can then stage elsewhere and still measure the bytes production would write.
    // `editorconfig: true` is the CLI's default and the API's opt-in — the repo has an
    // `.editorconfig` (it mirrors `.prettierrc.json`), so asking for it keeps this identical
    // to `bun run bake:shaders` even if the two files ever stop agreeing.
    const home = join(BAKED_DIR, m.file)
    const target = join(outDir, m.file)
    const config = await resolveConfig(home, { editorconfig: true })
    const next = Buffer.from(await format(m.text, { ...config, filepath: home }))
    let same = false
    try {
      same = readFileSync(target).equals(next)
    } catch {
      same = false
    }
    if (same) unchanged.push(m.file)
    else {
      writeFileSync(target, next)
      written.push(m.file)
    }
  }
  return { written, unchanged }
}

export interface BakeRun {
  /** Absolute, forward-slash paths of every file the bake evaluated (its dependency set). */
  deps: Set<string>
  /** Present when `outDir` was given: what the sync wrote. */
  sync?: BakeSync
}

/** Import the bake authority through the dev server's SSR runner. Always returns the
 *  dependency set; renders and syncs into `outDir` only when one is given. A fresh runner per
 *  run is the invalidation strategy: the whole corpus is re-evaluated from the current tree,
 *  which is what an edit to any of it means. */
export async function runBake(server: ViteDevServer, outDir?: string): Promise<BakeRun> {
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false })
  try {
    const mod = (await runner.import(BAKE_ENTRY)) as {
      renderAllBakedModules: () => readonly RenderedText[]
    }
    const deps = new Set<string>()
    for (const file of runner.evaluatedModules.fileToModulesMap.keys())
      if (!file.includes('/node_modules/')) deps.add(file)
    const run: BakeRun = { deps }
    if (outDir !== undefined) run.sync = await syncBakedFiles(mod.renderAllBakedModules(), outDir)
    return run
  } finally {
    await runner.close()
  }
}

const DEBOUNCE_MS = 150

export function bakeShadersOnEdit(): Plugin {
  return {
    name: 'xgis:bake-shaders-on-edit',
    apply: (_config, env) =>
      env.command === 'serve' &&
      !env.isPreview &&
      process.env.CI === undefined &&
      process.env.XGIS_BAKE_HMR !== '0',
    configureServer(server) {
      const log = server.config.logger
      let deps = new Set<string>()
      let timer: ReturnType<typeof setTimeout> | undefined
      let inFlight: Promise<void> | undefined
      let queued = false

      const run = async (write: boolean): Promise<void> => {
        const t0 = performance.now()
        try {
          const r = await runBake(server, write ? BAKED_DIR : undefined)
          deps = r.deps
          // Files outside the Vite root are watched only once something asks for them.
          server.watcher.add([...deps])
          const secs = ((performance.now() - t0) / 1000).toFixed(1)
          if (r.sync)
            log.info(
              `[bake-hmr] ${
                r.sync.written.length > 0
                  ? `rewrote ${r.sync.written.join(', ')}`
                  : 'artifacts already current'
              } (${secs} s)`,
              { timestamp: true },
            )
          else
            log.info(`[bake-hmr] watching ${deps.size} files the shader bake depends on`, {
              timestamp: true,
            })
        } catch (e) {
          log.error(
            `[bake-hmr] bake failed — the committed artifacts were left as they are:\n` +
              `${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
            { timestamp: true },
          )
        }
      }
      // One run at a time; a change landing mid-run queues exactly one more.
      const kick = async (write: boolean): Promise<void> => {
        if (inFlight !== undefined) {
          queued = true
          return
        }
        inFlight = run(write).finally(() => {
          inFlight = undefined
        })
        await inFlight
        if (queued) {
          queued = false
          await kick(true)
        }
      }
      const onFile = (file: string): void => {
        if (!deps.has(normalizePath(file))) return
        clearTimeout(timer)
        timer = setTimeout(() => void kick(true), DEBOUNCE_MS)
      }
      server.watcher.on('change', onFile)
      server.watcher.on('add', onFile)
      server.watcher.on('unlink', onFile)
      // Learn the dependency set once the server is up. Nothing is rendered or written here.
      const http = server.httpServer
      if (http) http.once('listening', () => void kick(false))
      else void kick(false)
    },
  }
}
