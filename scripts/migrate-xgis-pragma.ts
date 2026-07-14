#!/usr/bin/env bun
// ═══ Migrate the in-repo .xgis corpus to the version pragma (#1064) ═══
//
// Inserts `xgis <major>` as the first statement of every `.xgis` file under
// the in-repo corpus roots (examples / playground / e2e fixtures / docs).
//
// IDEMPOTENT: a file that already opens with `xgis <n>` — after any leading
// comments and blank lines, mirroring the lexer's first-token view — is left
// byte-for-byte untouched, so re-running is a no-op (this is what lets the
// rebase protocol re-run the script to reconcile fixture conflicts
// mechanically). The walk prunes build/vendor/worktree dirs, so the untracked
// `.claude` agent-worktree copies are never touched.
//
//   bun scripts/migrate-xgis-pragma.ts

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { XGIS_LANGUAGE_MAJOR } from '../compiler/src/language-version'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Corpus roots named by #1064. Only those that exist on disk are walked.
const CORPUS_ROOTS = ['examples', 'playground', 'e2e', 'docs']
const PRUNE = new Set(['node_modules', '.git', '.claude', 'dist', '.vite', 'coverage', 'build'])

function walkXgis(absDir: string, out: string[]): void {
  for (const name of readdirSync(absDir)) {
    if (PRUNE.has(name)) continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) walkXgis(p, out)
    else if (name.endsWith('.xgis')) out.push(p)
  }
}

/** True iff the source already opens with an `xgis <int>` pragma. Skips
 *  leading blank lines + `//` and block comments exactly as the lexer does,
 *  so this matches the parser's first-token view (a file with a pragma after
 *  a header comment is correctly recognised as already-migrated). */
function hasPragma(src: string): boolean {
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    // First meaningful token line — does it open the version pragma?
    return /^xgis[ \t]+\d+\b/.test(src.slice(i))
  }
  return false // comments / blanks only → no pragma present
}

const PRAGMA = `xgis ${XGIS_LANGUAGE_MAJOR}`
let scanned = 0
let migrated = 0
let already = 0

for (const rootName of CORPUS_ROOTS) {
  const abs = join(ROOT, rootName)
  let isDir = false
  try {
    isDir = statSync(abs).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) continue
  const files: string[] = []
  walkXgis(abs, files)
  for (const f of files) {
    scanned++
    const src = readFileSync(f, 'utf8')
    if (hasPragma(src)) {
      already++
      continue
    }
    writeFileSync(f, `${PRAGMA}\n\n${src}`)
    migrated++
  }
}

console.log(
  `[migrate-xgis-pragma] scanned ${scanned} .xgis file(s): ` +
    `${migrated} migrated, ${already} already had a pragma.`,
)
