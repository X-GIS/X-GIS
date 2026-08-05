// ═══ #1580 leg F — `_glyphsByTextCache` was declared, cleared, never used ═══
//
// Repo-wide grep found exactly two hits: the declaration and a wholesale
// `.clear()` beside two caches that ARE live. No `.set`/`.get`/`.delete`
// anywhere, so the Map was provably empty for the life of the stage — zero
// bytes leaked, but a doc block presenting it as a live 4096-capped
// across-frame cache is audit noise at exactly the file:line region memory
// audits are pointed at. Deleted; this pins it from coming back.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('#1580 leg F — _glyphsByTextCache stays deleted', () => {
  it('does not exist anywhere in text-stage.ts', () => {
    const src = readFileSync(fileURLToPath(new URL('./text-stage.ts', import.meta.url)), 'utf8')
    expect(src).not.toContain('_glyphsByTextCache')
  })
})
