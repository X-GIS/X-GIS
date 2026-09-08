# ADR-0014: TypeShade is an independent project; `typeshade/typeshade` is its development home

- **Status**: Accepted
- **Date**: 2026-09-07
- **Related**: #2660 (phase 1), #1681 (the decision whose monorepo half this reverses),
  `.github/workflows/mirror-shader-dsl.yml`, `shader-dsl/`,
  `playground/e2e/_wgsl-compile-gate.spec.ts` / `_glsl-compile-gate.spec.ts`,
  `docs/plans/2026-09-07-shader-dsl-standalone-product-strategy.md` (§1, §3, §10, App. B),
  `docs/plans/2026-09-07-typeshade-strategic-plan.md` (§13 D14)

## Context

### What #1681 decided, and why it was right for a package with one consumer

#1681 recorded, in its body: **publish FROM THE MONOREPO; do not extract to a separate
repository.** The stated reason was verification, not convenience — shader-dsl's
real-driver evidence lives in `playground/e2e/*` and is driven by X-GIS's own scenes
(`_wgsl-compile-gate.spec.ts`, `_glsl-compile-gate.spec.ts`, `_emit-obfuscate-gate.spec.ts`).
An extraction paid for losing that infrastructure up front and bought only release-cycle
independence.

Increment C was then re-scoped mid-issue (comment, 2026-08-13) from an npm publish to a
**`git subtree split` mirror**, which preserved that decision exactly: the monorepo stays
authoritative, the mirror is a derivative and read-only, fixes flow back through X-GIS.
It was measured before it was chosen — 235 commits split, a second split producing the
identical head SHA (idempotent, so CI fast-forwards and never force-pushes), 1.6 MB bare
against the monorepo's 498 MB `.git`, and a fresh consumer clone type-checking standalone
(`tsc -p tsconfig.json` → exit 0, 82 emitted files, no `node_modules` anywhere up the
tree). `.github/workflows/mirror-shader-dsl.yml` is that producer; its header states the
consequence plainly — no release script, no tag convention, no version bump anywhere in the
file. The mirror went live at `typeshade/typeshade` on 2026-09-07 08:34 UTC (run
34101085972).

For a package with exactly one consumer and no audience, that shape was correct, and the
prior art is real: every Symfony component is a read-only subtree split whose README
redirects contributions to the monorepo.

### What changed: the package acquired a public face, and the face advertises its consumer

Measured 2026-09-07 on the built site (`typeshade/typeshade.github.io` @ `eeed14c`) and the
mirror (`typeshade/typeshade` @ `7d675f7`), recorded in #2660:

| Surface                 | Measurement                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typeshade.dev`         | **9** visible `X-GIS` occurrences and **8** links into `X-GIS/X-GIS` (nav + footer `Docs` → `x-gis.github.io/X-GIS/shader-dsl/`, footer `X-GIS source`, both compile-gate spec links, `test.yml`); `og:description` and `/llms.txt` say the same |
| the rail chip of record | `Checked by real compilers, every build — in X-GIS CI.`                                                                                                                                                                                          |
| mirror `README.md`      | 8 X-GIS lines; the package is `@xgis/shader-dsl`                                                                                                                                                                                                 |
| mirror `AUTHORING.md`   | 18, five of them API-reference links into `x-gis.github.io/X-GIS/api/`                                                                                                                                                                           |
| mirror `AGENTS.md`      | 2, plus `Parent: ../AGENTS.md` and "consumed by `map/`"                                                                                                                                                                                          |
| mirror `package.json`   | `author`, `homepage`, `bugs`, `repository` all X-GIS                                                                                                                                                                                             |
| mirror `CHANGELOG.md`   | 241 X-GIS PR links                                                                                                                                                                                                                               |
| mirror root             | **no workflow** — `git ls-files shader-dsl` top level is 11 entries, no `.github`                                                                                                                                                                |

The last row is why the copy names X-GIS at all: with no CI at the mirror's root, the only
evidence for "checked by real compilers" is X-GIS CI, so every proof link has to point
there. The branding is not decoration that a copy edit removes — it is load-bearing on a
missing gate.

**The owner's reading of that measurement (2026-09-07): a product whose page advertises its
consumer is not a product.** MapLibre does not link deck.gl; deck.gl links MapLibre. The
library is the thing being adopted, and a landing page that routes the reader to another
project's repository, another project's docs site and another project's CI for its own
proof has inverted that relationship on every rung a reader checks. Under the Symfony
model this is not a bug — Symfony's components are components of Symfony. TypeShade is
being launched as a library for hosts that have never heard of a globe engine
(`docs/plans/2026-09-07-typeshade-strategic-plan.md` §6.4: PixiJS, MapLibre, deck.gl/luma),
and for that audience the relationship is a liability, not a credential.

### Alternatives considered and rejected

1. **Keep the Symfony model and de-brand the page.** Rejected, and this is the decision's
   crux: the proof links ARE the relationship. The rail chip can be reworded, but the two
   compile-gate links and the `test.yml` link resolve into `X-GIS/X-GIS` because that is
   where the gates run; removing the words while keeping the links produces a page that
   hides its dependency instead of not having one, which is worse. The only way the copy
   stops naming X-GIS honestly is for the gates to exist at the mirror (#2660 item 1).
   Symfony's model works because the components ARE Symfony's; the analogy fails the moment
   the component is meant to outlive and out-reach its host.
2. **npm-first — publish `typeshade` and let the registry be the public face**, leaving the
   source in the monorepo. Rejected as a sequencing error rather than on merit: it needs the
   `0.1.0` tag (direction doc decision 6, after Wave 1) and it needs #1681 increment C's
   unresolved `exports`→`dist` question — measured there to fix nothing for a plain-Node
   consumer (`dist` fails `ERR_UNSUPPORTED_DIR_IMPORT` identically to `src`, because `tsc`
   does not rewrite the 197 extensionless specifiers) while costing 3–4 new alias
   authorities, and already tried and reverted once (`7f41f487` → `f6a8f392`). None of that
   is blocking for CI and docs at the mirror, so the independence work does not wait on it.
3. **A bidirectional sync** — edits in either repository replayed into the other. Rejected:
   drift by construction. The subtree split is safe precisely because it is a pure function
   of `shader-dsl/`'s history with a single writer; a second writer makes the split
   non-fast-forwardable, and the reconciliation policy for a conflicting pair of histories
   is exactly the two-authorities problem CLAUDE.md §12 names. One home at a time — the
   monorepo now, the repository after the move.

## Decision

**TypeShade is an independent project.** `typeshade/typeshade` becomes its development
home — issues, pull requests, CI and releases — X-GIS becomes a consumer of it, and **no
public surface of TypeShade names or links X-GIS.**

This reverses the monorepo-first half of #1681's recorded decision. Nothing else in #1681
is reversed: increment A's API cleanups, increment B's packaging and increment C's
self-containment invariant all stand, and the self-containment invariant is what makes this
decision cheap (`shader-dsl/src/self-contained.test.ts`).

The sequencing is three units, and the first is deliberately valid under BOTH the interim
state and the target state, so no step of it is thrown away:

1. **Phase 1 — #2660, this work, authored in X-GIS under `shader-dsl/` and carried to the
   mirror by the existing split.** The mirror gains (a) its own CI at its root
   (`.github/workflows/ci.yml`, authored as `shader-dsl/.github/workflows/ci.yml`) running
   type-check, the vitest suite, and a **compile gate** that emits every registered example
   and compiles the WGSL on Tint and both GLSL ES 3.00 stages on a real WebGL2 context; and
   (b) X-GIS-free public docs — `README.md`, `AGENTS.md`, `AUTHORING.md` and the
   `package.json` metadata name no other project. **The one transition-only exception**,
   stated in the README's contributing section: a single factual line with a single link
   saying changes still land upstream until the move completes. No branding.
2. **The site re-sources its proof to the mirror's CI** (a separate PR in
   `typeshade/typeshade.github.io`): the compile-gate links, the `test.yml` link and the
   rail chip point at the mirror's own workflow and gate, which by then exist.
3. **The move — a separate intent, not this record's scope.** X-GIS consumes the
   repository rather than owning the source; `mirror-shader-dsl.yml` retires; `CHANGELOG.md`
   is generated from the repository's own history; the docs site moves off
   `x-gis.github.io`; the package is renamed at `0.1.0` with `@xgis/shader-dsl` kept as an
   alias for one major.

## Consequences

**What X-GIS loses, once step 3 lands** (nothing is lost at Phase 1):

- (−) **The single source tree.** Today a shader-DSL change and its X-GIS consumer change
  are one PR, gated together by one `bun run build` and one vitest run. After the move they
  are two PRs in two repositories, and a breaking DSL change reaches X-GIS as a dependency
  bump — which is the point (strategic plan §13 D6: the forward-compat promise is only
  tested by a consumer who notices), and is also a real cost in round-trips.
- (−) **The subtree split's idempotent fast-forward.** The property measured in #1681 —
  a second split producing the identical head SHA, so CI never force-pushes — exists
  because the monorepo is the only writer. It ends when the mirror gains its own commits.
  Phase 1 does not end it: everything Phase 1 adds is authored under `shader-dsl/` and
  carried by the split, so the mirror stays a pure derivative until the move.

**What X-GIS keeps:**

- (+) **Its own real-driver compile gates over its baked corpus.** `_wgsl-compile-gate` and
  `_glsl-compile-gate` enumerate X-GIS's baked shaders through the playground; they are
  gates on X-GIS's emission, not on the package, and they stay. #2660 deliberately does not
  port them — the mirror's gate compiles the package's own examples, which is the claim the
  site can honestly make.
- (+) **Its consumer-side tests.** Everything that asserts how `map/` uses the DSL is
  X-GIS's and is unaffected by where the DSL is developed.

**Standing hazards carried over from #1681's comments — recorded, not solved:**

- (−) **Two copies in one dependency tree is a real bug here, not a nuisance.** The package
  holds module-level registration state: `shader-dsl/src/core/ir/node.ts:156,174`
  (`let _stmtSink` / `installStmtSink`) written by `builder.ts:429`, which is why
  `sideEffects` is an array naming that one file (`shader-dsl/package.json:24-26`). Two
  authoring surfaces sharing one process must share one copy. Two of the three
  module-level slots are already `globalThis`-backed against exactly this (`builder.ts:393`
  `scopeStack`, `:680` `fnAutoState`, both #763 D2, with a once-only warning when a second
  copy loads) — that mitigation makes duplication survivable, not correct. A published
  package with a version range makes this MORE reachable than a pinned submodule does, so
  the dedupe story is a precondition of the move, not a detail of it.
- (−) **No semver ranges under a submodule.** A submodule pins a SHA; there is no `^0.1.0`.
  Until the package is published, "X-GIS consumes TypeShade" means a pinned commit and a
  deliberate bump — the same discipline `typeshade.github.io` already applies to its own
  `vendor/shader-dsl` pin.
- (−) **The mirror token must be allowed to write workflows BEFORE Phase 1 merges.**
  `SHADER_DSL_MIRROR_TOKEN` was minted with `Contents: Read and write` only
  (`.github/workflows/mirror-shader-dsl.yml:29-31`). A push that adds
  `.github/workflows/ci.yml` to the mirror is refused without `Workflows: Read and write`
  (fine-grained PAT) or the `workflow` scope (classic). This is an owner action with a
  deadline: get it wrong and the mirror sync goes red on every `shader-dsl/**` merge until
  it is fixed.

**On the record itself:** this supersedes nothing formally, because #1681's decision lives
in an issue rather than in an ADR. What it does flip is the strategy doc's rows that
recorded it as settled — §1's "publish from the monorepo" row, §3's "a separate source
repository for the DSL" rejection, and §10's open question 5 — all three updated
2026-09-07 to point here.
