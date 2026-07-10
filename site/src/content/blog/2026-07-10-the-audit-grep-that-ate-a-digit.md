---
title: 'The boundary audit missed an edge because a regex ate a digit'
description: "A hand audit of a 16-workspace import graph concluded the backend adapters were clean. It was wrong twice — once because `[a-z-]` doesn't match a `2`, once because `from '…'` can't see a dynamic import. The 166-line CI gate built FROM that audit found the missed edge on its first run."
date: 2026-07-10T03:30:00Z
tags: ['architecture', 'ci', 'tooling', 'methodology']
lang: en
draft: false
---

While auditing whether our backend adapters really depend on nothing but the
RHI interface, this bash one-liner summarized the two adapter packages'
imports:

```bash
grep -rhoE "from '@xgis/[a-z-]+" rhi-webgl2/src rhi-webgpu/src | sort | uniq -c
#   7 from '@xgis/compiler
#   5 from '@xgis/engine
#   8 from '@xgis/rhi
#   5 from '@xgis/rhi-webgl     ← this line
#   3 from '@xgis/shader-dsl
```

That fourth line says `rhi-webgl`, not `rhi-webgl2`. The character class
`[a-z-]` has no digits, so the match stopped one character short of the real
package name. Reading the output, the truncated name looked like the
`rhi-webgl2` package importing itself — self-import noise, safe to ignore. The
audit moved on, an architecture issue was filed from its findings, and the
finding it should have contained — one backend adapter importing _another
backend adapter_ — wasn't in it.

## The wrong first move, twice

The tempting conclusion is "use a better regex," and that was in fact the
second wrong move. The follow-up audit script fixed the class to
`[a-z0-9-]+` and parsed every workspace's sources properly:

```python
for m in re.finditer(r"from\s+['\"](@xgis/[a-z0-9-]+)", text):
```

This one produced a clean graph — and _still_ showed `rhi-webgpu →
rhi-webgl2` as a test-only edge, absent from production source. Both audits
were wrong for different reasons, and the second miss is the instructive one:
the actual coupling was a lazy boot fallback, and lazy code doesn't say
`from`:

```ts
// rhi-webgpu/src/backend-providers.ts — the WebGPU→WebGL2 fallback provider
create: async (canvas) => {
  const { WebGl2Device } = await import('@xgis/rhi-webgl2')
  return initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl))
},
```

A `from\s+['"]…` pattern structurally cannot see `import('…')`. The exact
mechanism that makes the dependency cheap at runtime — dynamic import, so only
a WebGL2 boot pays for the WebGL2 package — is what made it invisible to both
audits. The edge wasn't hiding; it was written in a dialect the tooling didn't
speak.

## What actually happened

The audit's conclusions became a CI gate: a 166-line vitest test that scans
every workspace's `src/**/*.ts`, extracts `@xgis/*` imports, and fails on any
edge outside a declared allowed graph. Because it was going to run forever
rather than once, its extraction pattern got the five minutes of care the
one-liner never did:

```ts
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|import\s+)['"]@xgis\/([a-z0-9-]+)['"]?/g
```

Static `from`, bare side-effect `import '…'`, and dynamic `import('…')` — all
three forms. Its very first local run, before it had ever gated anything:

```
- Expected  []
+ Received  [
+   "rhi-webgpu -> @xgis/rhi-webgl2 (e.g. rhi-webgpu/src/backend-providers.ts)",
+ ]
```

The gate found, in its first execution, the edge two rounds of hand auditing
had missed. Chasing it to the file header revealed it wasn't even a bug: the
coupling is a _documented transitional home_ — both boot providers produce the
same WebGPU-typed context until a planned context-neutralization milestone
relocates them. Legitimate, deliberate, and absent from the architecture
issue that was supposed to enumerate exactly this kind of thing.

## The fix

The edge went into the gate's baseline — pinned, not allowed — with the
rationale attached to the pin:

```ts
const BASELINE: ReadonlyArray<readonly [pkg: string, dep: string]> = [
  ['rhi-webgl2', 'compiler'],
  ['rhi-webgpu', 'compiler'],
  ['rhi-webgpu', 'engine'],
  // Documented transitional home (#834 M5): both boot providers produce the
  // WebGPU-typed GPUContext, so the webgl2 provider lives in rhi-webgpu until
  // GPUContext neutralizes — then this edge burns down.
  ['rhi-webgpu', 'rhi-webgl2'],
]
```

The baseline is shrink-only in both directions: a new edge outside
`ALLOWED ∪ BASELINE` fails, and a baseline edge that no longer exists in the
code _also_ fails until its entry is deleted — so every burn-down is locked in
the same commit that achieves it, and the baseline can never quietly go stale.

One more scar from the morning's lesson made it into the test. If a regex can
silently under-match, a gate built on a regex can silently pass on nothing. So
the gate asserts its own scanner sees edges that must exist:

```ts
it('scanner sanity — permanent structural edges are seen', () => {
  // engine→rhi and map→engine are permanent; if the scan ever stops seeing
  // them the walker/regex broke, not the codebase, and the gate would be
  // silently passing on nothing.
  expect(edges.has('engine -> rhi')).toBe(true)
  expect(edges.has('map -> engine')).toBe(true)
})
```

That canary is the difference between the gate and the audits it replaced: the
one-liner's failure mode was an output that _looked_ complete; the gate's
failure mode is a red build.

## How we know it holds

Both directions of the ratchet fired for real within the same pull request.
The undocumented edge made the gate red before baselining (above), proving
detection. Then the burn-down that removed the adapters' engine-policy imports
deleted the `rhi-webgl2 → engine` edge from the code — and the gate stayed red
on the stale baseline entry until that line was deleted in the same commit,
proving the shrink lock. Five baseline entries became four, mechanically.

## What generalizes

The audit and the gate ran the _same kind of scan_. The difference wasn't
technique — it was that the audit's tooling was treated as throwaway and the
gate's was treated as production. A one-shot audit script gets no code review,
no test, no second look at its character classes; yet its output turns
directly into filed issues and architectural decisions, which makes it
load-bearing exactly once — at the moment nobody is checking it. If a
scan's output will become a decision, either give the scan the same rigor as
shipped code, or ship it: turn it into the permanent gate first and read the
gate's first run as the audit. The gate caught in milliseconds what the
eyeball audit missed twice, and it did so before it ever gated a single
commit.

## References

1. ["Slicing a 700-reference coupling into moves you can verify"](/blog/2026-07-08-slicing-a-700-reference-coupling) — the earlier milestone in the same boundary program; this post's gate now pins the graph that migration produced.
