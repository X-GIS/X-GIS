// ═══ Which tree is this? — the monorepo the package is cut from, or the standalone tree ═══
//
// The same files live in two trees. Inside the monorepo, `shader-dsl/` is one workspace of
// many and three of its tests assert arms whose SUBJECT is the monorepo: the root tsconfig
// baseline the package copy is pinned to (`src/tsconfig-drift.test.ts`), the doc-stub
// generator the coverage gate must agree with (`src/api-doc-coverage.test.ts`), and the
// root `workspaces` array whose publish-shaped members owe a reason
// (`src/self-contained.test.ts` S7). In the standalone tree — the mirror repository that
// `git subtree split --prefix=shader-dsl` produces, and a consumer's submodule checkout of
// it — none of those subjects exist: `..` is not a repository root, it is whatever
// directory the clone happens to sit in.
//
// So those arms ask THIS question first and run only where their subject is. That is not a
// skip to get green (CLAUDE.md §12): an invariant of the form "package copy == monorepo
// root" has no object in a tree that has no monorepo root, and the same file keeps
// asserting it, unchanged, inside the monorepo. The test is `workspaces` naming this
// directory — the one fact that distinguishes "a workspace of a bun monorepo" from "a
// directory that happens to have a package.json next to it" (a consumer vendoring the
// package under `vendor/` has a parent manifest too, and it is not a monorepo root).
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/** The monorepo root when `pkgDir` is a workspace of one, else `null` (the standalone tree). */
export function monorepoRoot(pkgDir: string): string | null {
  const parent = resolve(pkgDir, '..')
  const manifest = resolve(parent, 'package.json')
  if (!existsSync(manifest)) return null
  const ws = (JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces?: unknown }).workspaces
  return Array.isArray(ws) && ws.includes(basename(pkgDir)) ? parent : null
}
