<!--
One PR per coherent change, individually green (docs/BRANCHING.md). Squash-merge
to main with a `<type>(scope): summary (#NNN)` title. Delete this comment block.
-->

## What & why

<!-- The change in one or two sentences, then the reason it's needed. Link the
issue(s): `Closes #NNN` for a complete fix, or `#NNN` to reference without
auto-closing (use plain `#NNN` when only a by-construction slice landed and the
real-GPU verification is still pending). -->

-

## How it works

<!-- The key mechanism a reviewer needs to follow the diff. Cite `file:line` for
the load-bearing change. Note anything deliberately left out of scope. -->

-

## Verification

<!-- main protection is two tiers (docs/adr/0004): the no-GPU gates below PROVE
what CI can prove; render-correctness is checked LOCALLY on a real GPU. Record
the real proof here — a passing no-GPU CI is necessary, not sufficient. -->

**No-GPU gates (CI-checkable):**

- [ ] `bun run test` (vitest) — new/changed tests included; state the count
- [ ] `bun run lint` + `bun run format:check`
- [ ] Ratchets unaffected or intentionally bumped (LOC ceilings, dependency-direction, earth-literal) — note any bump + why
- [ ] Typecheck / WGSL-compile gate green

**Real-GPU gate (local, per ADR-0004 — CI has no GPU):**

<!-- The screenshot matrix is the discovery tripwire; the deterministic numeric
gate is the proof of record. Paste the numbers (e.g. pixel-match Δ, coverage
black-ratio, directional pixel-diff DC>0 / D1<D0), or check "pending" and say so
plainly — never claim a render is correct you haven't seen. -->

- [ ] Ran the relevant real-GPU gate and it is green — output:
- [ ] N/A — no runtime render surface (docs / pure-CPU / test-only change)
- [ ] ⏳ Pending — by-construction gates pass; the on-screen result is not yet GPU-verified (say which view)

## Scope check

- [ ] Every changed line traces to this PR's stated goal (no drive-by refactors)
- [ ] Orphans created by this change are cleaned up; pre-existing dead code is left alone
- [ ] Repo artifacts (code, comments, commits, docs) are in English
