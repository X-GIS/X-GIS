// ═══ xgis validate CLI — smoke test (#1073 slice 1) ═══
//
// Spawns scripts/xgis-validate.ts on corpus fixtures and asserts the exit
// codes + per-file output. conformance.test.ts exercises the front-end
// in-process; this proves the shipped CLI wiring (argv → lex/parse/resolve →
// exit code + stdout) end-to-end on a real subprocess.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// conformance/ → __tests__ → src → compiler → repo root → scripts/
const SCRIPT = join(HERE, '..', '..', '..', '..', 'scripts', 'xgis-validate.ts')
const VALID = join(HERE, 'valid')
const INVALID = join(HERE, 'invalid')

// Run the .ts CLI under bun. When this suite itself runs under bun,
// process.execPath IS the bun binary; otherwise fall back to `bun` on PATH.
const BUN = (process.versions as { bun?: string }).bun ? process.execPath : 'bun'

function run(...args: string[]) {
  return spawnSync(BUN, [SCRIPT, ...args], { encoding: 'utf8' })
}

describe('xgis validate CLI — smoke', () => {
  it('exits 0 and prints ok on a valid fixture', () => {
    const r = run(join(VALID, 'source.xgis'))
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('ok')
  })

  it('exits 1 and prints the X-GIS0008 diagnostic on an invalid fixture', () => {
    const r = run(join(INVALID, 'pragma-missing.xgis'))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('error')
    expect(r.stdout).toContain('X-GIS0008')
  })

  it('runs resolveImports for a file that imports a sibling', () => {
    const r = run(join(VALID, 'import-named.xgis'))
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  })

  it('exits 2 with a usage line when given no paths', () => {
    const r = run()
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage')
  })
})
