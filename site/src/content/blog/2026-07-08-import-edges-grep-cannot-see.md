---
title: 'The import edges grep cannot see'
description: 'Relocating a module is editing the dependency graph, and text search sees only some of its edges. It misses dynamic imports and re-exports, and a regex-dialect gap can make a guard silently lie. Grep narrows; the compiler decides.'
date: 2026-07-08
tags: ['refactoring', 'tooling', 'typescript', 'methodology']
lang: en
---

Moving a module looks like the most mechanical refactor there is: `git mv` the
file, then repoint the imports. Extracting the `Camera` cluster — six files — out
of `@xgis/engine` into `@xgis/map`, we repointed roughly ninety import sites from
`@xgis/engine` to the new home. "Roughly ninety" is already the tell: nobody
counts by hand, so the count comes from a grep, and the job is only as correct as
that grep is complete.

It is not complete. A module's place in a build is a set of edges in a dependency
graph, and text search sees only some of those edges. Three times on this one
move, a grep said the coast was clear when it wasn't — and each time the compiler,
not the grep, was the thing that actually knew.

## The guard that lied: `\b` is not a word boundary in `git grep`

Before moving `Camera`, the safety check was simple: nothing *below* `@xgis/map`
may import it, or the move inverts a dependency. So we asked git — does `@xgis/data`
(which sits below map) still name `Camera`?

```bash
git grep -nE "import[^;]*\bCamera\b[^;]*@xgis/engine" origin/main -- 'data/src/**'
```

Empty. Great — `data` is `Camera`-free, the move is safe. Except `data` was not
`Camera`-free at all. `data/src/tile-select.ts` opens with
`import type { Camera } from '@xgis/engine'`, plain as day.

The bug is the `\b`. `git grep -E` uses POSIX ERE, and in POSIX ERE `\b` is not a
word boundary — it's unspecified, and here it matched nothing resembling a word,
so the guard returned a false "clean." The identical query in ripgrep — whose Rust
regex engine implements `\b` as a real word boundary — found every occurrence
instantly.

We had nearly built the whole slice on a false premise: that two prerequisite PRs,
which strip `Camera` out of `data` and `rhi-webgpu`, were unnecessary. They were
not. The lesson is narrow and load-bearing: **`git grep` and ripgrep do not share a
regex dialect.** A guard that must not miss is one you run in an engine whose
regex you actually trust — and cross-check when the answer is "nothing," because
"nothing" is exactly what a broken pattern also returns.

## The edge with no `from`: dynamic `import()`

With the prerequisites really in place, the move went in and the build ran. It
died in the *engine* package — the one we were removing geo *from*:

```
engine/src/projection/globe.test.ts(326,37):
  error TS2307: Cannot find module './camera'
```

Every static scan had said the staying engine files were clean. They were. But
`globe.test.ts` reached `Camera` a different way:

```ts
const { Camera } = await import('./camera')
```

A dynamic `import()`. It has no `from` clause, so a scan for `import … from
'./camera'` never sees it, and it's easy to forget `import()` is even an import
when you're sweeping a hundred static ones. The test builds a `Camera` to prove a
globe matrix matches its flat-2D framing — a genuine camera↔globe test that, in
the end state, belongs with `Camera` in `@xgis/map`. Lifting that one `describe`
out of the engine's globe suite into the camera cluster made the engine build go
quiet.

## The edge that points outward: `export … from`

The build got further and died again — this time in the site bundle, on the
package one level *above*:

```
runtime/src/index.ts:3  export { Camera } from '@xgis/engine'
  "Camera" is not exported by "engine/src/index.ts"
```

The sweep had rewritten `import { Camera } from '@xgis/engine'` everywhere. It had
not touched `export { Camera } from '@xgis/engine'` — a re-export in the runtime
barrel — because the pattern anchored on `import`. A re-export is an import edge
wearing a different keyword: it pulls the symbol in *and* pushes it back out, and
it breaks the same way when the source stops exporting. One character in the
search — `import` → `export` — found it.

## An aside that cost twenty minutes: the pipe ate the exit code

Between the second and third failures, a build "passed" that hadn't. The command
was `bun run build | tail -50`, backgrounded; the completion notice read *exit
code 0*. But `tail` exits 0 whether or not `bun` did — in a pipeline the shell
reports the **last** command's status, and the real failure had scrolled into the
middle of the log, above the tail window. Re-running as a bare `bun run build >
log` — no pipe — surfaced the true exit 1. When a build's pass/fail is the thing
you're checking, never read it through a pipe: redirect, and check the exit code
of the process you actually care about.

## Grep narrows, the build decides

None of these three edges is exotic. Dynamic imports, re-exports, and type-only
imports are ordinary TypeScript. What they share is that an `import … from '…'`
text pattern — the mental model that "an import is a line that says *import … from*"
— cannot see them, and neither can a sed sweep built on that model. The dependency
graph has more kinds of edge than one keyword.

So the working method is not "grep, then trust the grep." It's:

- **Grep to narrow and to plan.** It gives you the shape and the count, and it's
  how you sort the work. Just never let a *"no matches"* stand as proof — confirm
  it in a second engine, because a broken pattern and a clean tree return the
  identical empty set.
- **Let the compiler enumerate.** `tsc` (via `bun run build`) is the only tool
  that walks *every* edge — static, dynamic, re-exported, type-only — and it fails
  loudly and precisely (`file:line`, "cannot find", "not exported by") on the ones
  the grep missed. A green full build isn't a formality after a module move; it
  *is* the reference-completeness check.

The move was, in the end, exactly as mechanical as it looked — `git mv` plus
import edits, zero behavioural change, byte-identical render. But "mechanical"
doesn't mean "grep-complete." A file move is a graph edit, and the only tool that
sees the whole graph is the one that compiles it.
