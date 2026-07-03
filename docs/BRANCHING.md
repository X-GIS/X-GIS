# Branching & PR strategy

**Model: trunk-based.** `main` is the single integration branch — always green,
always demo-ready. There is **no `dev`/integration branch.**

_Rationale._ X-GIS is a solo learning/portfolio project where the architecture
quality **is** the deliverable (`docs/redesign/VISION.md` §0) and there are no
versioned releases (we do not bump package versions). For that audience the
strongest git signal is a **clean, linear `main` with atomic, individually-green
`(#NNN)` PRs** — a reviewer reads the history as disciplined increments. A `dev`
branch buys integration isolation that one author with no release cadence does
not need, and a half-integrated `dev` reads as ceremony / cargo-cult. So `main`
is the trunk, and every change earns its place there one PR at a time.

## Flow

1. Branch off `main`: `<type>/<kebab-summary>`.
2. Small, focused commits. Conventional-commit titles; body = _why_ + the
   verification run; AI-assisted commits keep the `Co-Authored-By` trailer.
3. **One PR per coherent change**, individually green.
4. **Squash-merge** to `main` → a single `<type>(scope): summary (#NNN)` commit.
   Linear history, no merge bubbles.
5. **Delete the head branch on merge** (enable GitHub's auto-delete-head-branches).

## Branch naming

`<type>/<kebab>` where `type` ∈ `{feat, fix, docs, chore, refactor, test, ci,
perf}` — the same set as the conventional-commit type. Examples:
`feat/outside-band-coverage`, `fix/arena-compaction`, `docs/branch-strategy`.

## Verification gate (`main` protection) — honest about no-GPU CI

Per [ADR-0004](adr/0004-verification-gate-strategy.md), **CI has no GPU**: GitHub
Actions runs only the pure-compute / WGSL-compile gates under SwiftShader.
Render-correctness (pixel-match, coverage black-ratio, globe render, eyeball)
runs **local / pre-push on a real GPU**. So `main` protection is three layers,
not a single CI check:

- **GitHub branch protection on `main`:** require a PR (no direct push), require
  the no-GPU CI checks to pass, require linear history (squash).
- **Local pre-push (author discipline, optionally a `pre-push` hook):** run the
  real-GPU gate relevant to the change — e.g.
  `playground/e2e/_coverage-black-ratio.spec.ts`,
  `_pixel-match-survey.spec.ts` — and confirm green **before** opening / merging.
  Record the gate output in the PR description: the screenshot matrix is the
  _discovery tripwire_; the deterministic numeric gate is the _proof of record_
  (`docs/redesign/VISION.md` §6, `docs/verification/STRATEGY.md`).
- **Never merge on a red local gate.** A passing no-GPU CI is necessary, not
  sufficient — "does it render correctly" is only ever checked locally.

## The redesign thread

Each `VISION` gap is **its own `feat/` branch → own PR → `main`** (incremental,
individually green) — NOT a long-lived redesign integration branch. Shipped:
coverage (gap #1, `feat/outside-band-coverage`). Next: `text-pitch-alignment`
(gap #2), framing + camera (gap #3), clip-and-suture (gap #4). Incremental green
PRs are the disciplined-increment narrative; a big-bang redesign merge is not.

## WIP / parked branches

Unmerged work-in-progress branches are **kept** (e.g. `fix/arena-compaction` —
the globe-z13 OOM compaction fix, verified, parked). Rebase on `main` before
opening the PR. Don't let them rot — either land them or close them.

## Hygiene

- Enable the repo setting **"Automatically delete head branches"** (Settings →
  General → Pull Requests) so merged branches stop accumulating.
- After remote branches are deleted, `git remote prune origin` drops the stale
  local remote-tracking refs.

## Related

- [ADR-0004](adr/0004-verification-gate-strategy.md) — the two-tier (no-GPU CI vs
  real-GPU local) verification strategy this gate policy follows.
- [`docs/verification/STRATEGY.md`](verification/STRATEGY.md) — the verification ladder.
- [`docs/redesign/VISION.md`](redesign/VISION.md) §6 — the per-gap migration + abort gate.
