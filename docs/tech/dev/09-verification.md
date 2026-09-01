# Proving a renderer: gates, fail-before, and md5 as a graphics test

> Edition: **dev**. Exhaustive version: [`../agent/09-verification.md`](../agent/09-verification.md).

X-GIS has more test code than product code, and the reason is a single uncomfortable
fact about GPU engines: your worst bugs are invisible to everything you normally trust.
The project's formative incident: nine commits, 3,900 green unit tests, a green
typecheck, fifteen green CI checks — and **zero pixels drawn**, from two independent
breaks none of those layers could see. The first real render caught both. Everything in
this chapter is machinery for never being lied to like that again.

## Split by what each tier can honestly see

The strategy fits in a sentence: _CI verifies what needs no rasterization (compilation,
compute, math parity); pixels are verified locally on real GPUs._ Software rasterization
(SwiftShader) turns out to cover more than assumed — compile/link/validate/draw
correctness all run headlessly; what it can't give you is timing or hardware-raster
fidelity, so tolerances are **GPU-class-aware** (tight on hardware, ~6× above measured
software-transcendental noise on SwiftShader). A meta-lesson rides along: the earlier,
wrong claim that "WebGPU can't run here" survived long enough to be quoted as a reason
not to verify something — so a skipped test whose stated reason is an environment claim
is itself treated as a bug to re-check.

The top tier is often forgotten: **independent references** (pyproj, mercantile, shapely).
Everything else only proves your CPU matches your GPU — which is exactly the proof that
passes when both share a bug.

## The render-gate ladder

Three rungs, in order of strength:

1. **Directional**: for an intentional change, prove before≠after (`DC > 0`) and that the
   change moved _toward_ the reference (`D1 < D0`). Never gate on an absolute match
   percentage — the reference diff is noisy.
2. **Zero-diff**, valid only after measuring the same-code noise floor. (A 0.02 %
   "regression" was once settled by running the _same commit twice_: 0.023 % of pure
   harness jitter, confined to a HUD strip.)
3. **Hash equality.** Determinism isn't found, it's _engineered_: pin the camera, pump
   frames until render-on-demand converges, use the software rasterizer, capture with a
   helper that hides on-canvas chrome (a status line whose text tracks tile loading was
   53 % of one gate's "regression"), and pin every wall-clock-driven render input (the
   adaptive-quality controller changes the _selected tile set_ on a slower machine).
   Do all that and three captures across a merge hash identically — "verification
   collapses from statistics to md5sum."

Two habits multiply the ladder's value. **Read the diff image, full-resolution, in
tiles** — downscaled review erases exactly the sub-pixel offsets real bugs are made of
(paired red/blue edges = position shift; red on both sides = width change). And use
**cross-gate agreement**: when two gates toggling unrelated flags produced the same
impossible result, the shared suspect was the harness — and it was (boot order). Agreement
between independently-built gates is evidence no single gate can fake for itself.

## Fail-before, tightened four times

The project's testing doctrine is a ladder of increasingly paranoid questions, each added
after a gate passed while wrong:

1. **Does the test fail before the fix, for the right reason?** Green-only tests prove
   nothing.
2. **Does it fail when you cut the mechanism it guards?** One gate asserted triangle
   counts; severing the exact wire it existed to watch produced the _same_ failure as the
   wire working — no fix could ever have greened it. Cut the mechanism, and check the
   failure message names the severed half. Assert causes before effects — the first
   assertion to fail is the one that gets blamed.
3. **Do the inputs carry information?** Five green tests all passed whole typed arrays —
   `byteOffset 0`, the one shape where the bug (a dropped view window) is invisible.
   Feed inputs shaped like production's, and plant a decoy.
4. **Is the instrument itself live?** A blind measuring tool reports zero, and zero reads
   as a finding. A text-regex over CSE-mangled shader output measured "no optimization
   opportunities" thirteen times; the IR said thousands. An unauthenticated CI poller
   turned an auth error into an empty list and declared "all green" in under a second.
   _Validate the instrument against a known positive before believing any zero._

The same paranoia is embedded in the gates: detector-liveness assertions (the gate's regex
must see a planted positive and ignore a planted decoy), population proofs ("a gate that
does not prove its own population is the bug it guards against, one level up"),
structural assertions over pixel counts (a count gate passed on an image whose "line" was
a 200 px wall), and an initiation rite for new gates — **break the feature on purpose and
watch the red** before trusting any green. "A gate that cannot fail is decoration."

## Baselines that can't bully, CI that can't lie quietly

The permanent real-GPU sweep (projection × pitch × zoom × data) is framed honestly as a
tripwire — a red cell proves something moved; a green matrix proves nothing — and has one
structural safeguard worth copying anywhere baselines exist: a cell whose baseline is
unreviewed, or whose bug is documented, is **forced non-blocking regardless of its
declared strictness**. Whether an unreviewed baseline can block a push is not left to
author discipline. One writer owns the baseline directory, refuses to overwrite without
force, and stamps who reviewed what at which commit.

The CI config itself is treated as code with its own bug classes, and has its own tests:
the paths-filter's real matching semantics, workflow validity (one workflow ran 56 times
with zero jobs), shard-family coverage (a missing shard leg reports green), and a
post-merge guard (a merge once landed minutes before its own red result reported,
breaking main for 2.5 hours). Sharding exists for infrastructure limits, not speed — the
unit suite splits because the test runner's IPC times out past ~110 files per leg ("all
2,592 tests passed and the job failed"), and the render suite splits because two browser
workers **contend for one software rasterizer** and lose a random spec. Empty shards fail
loudly (a shard matching nothing exits 0 printing nothing). Flakes are counted but never
gated on — with retries, fail-then-pass exits 0 and the default reporting drops it — and
"that flake was fixed" is unproven until a post-fix run is clean.

## The archive

Seventy-four postmortems, each with a one-line abstract, and a standing rule to grep them
_before_ debugging in an area. Deliberately no index file — a hand-synced index would be a
second authority, which is the drift disease the corpus itself documents. Recurring
lessons get promoted to a short ledger, one actionable line plus a citation. And each
session starts from the position that everything inherited — the green check, the
installed dependencies, the "fixed" flake — is _a claim left by someone who is no longer
here_, checked mechanically where possible and re-read where not.

## What to steal

1. Tier verification by what each layer can honestly see, and keep an
   independent-reference tier for the shared-bug case.
2. Engineer determinism (pinned camera, pumped convergence, software raster, chrome-free
   capture, pinned wall-clock inputs), then let hash equality replace statistics.
3. Directional and structural assertions; measure noise floors; read diffs at full
   resolution; use cross-gate agreement.
4. The four-question ladder for every new test: fails-before? fails-on-cut? real-shaped
   inputs? live instrument?
5. Unreviewed baselines must be structurally unable to block anyone.
6. Test your CI; shard for infrastructure limits; fail empty shards; count flakes without
   gating.
7. Keep a postmortem corpus, grep-first, with no secondary index; start every session by
   distrusting what you inherited.
