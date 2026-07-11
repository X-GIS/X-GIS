---
name: spec-wiring-corpus
description: Autonomously build a fail-before/verified test corpus — for each spec story write a test, prove it FAILS for the right reason, implement the wiring, prove it PASSES, logging every red→green transition. Use when the user asks to "wire the spec", "complete the test corpus", "fail-before tests", or turn a spec into a self-validating regression suite on X-GIS.
---

# Fail-before / verified spec-wiring corpus (X-GIS)

Turn a spec into a living regression suite where **every test is proven red-before-fix, green-after-fix**. A green-only test proves nothing.

## Hard constraints (X-GIS reality)

- **Run vitest and `tsc`/`bun run build` SEQUENTIALLY, never concurrently** — concurrent heavy jobs have frozen the machine (CLAUDE.md §7).
- **`bun run build` is the typecheck authority** (vitest does not typecheck). A TS6133 orphaned-import blocker passes `vite build` silently — check it explicitly (§11).
- Authority for spec coverage lives in `compiler/src/convert/spec-coverage.ts`; changing it means **regenerate `gap-matrix.md`** (a runtime leg gates on it) — a stale matrix = false "CI passes".
- vitest failure names get truncated by tee — use `--reporter=json --outputFile` to read the real failing spec, not a truncated console dump.

## Per-story loop

1. **Write the test** for the story's observable behavior.
2. **Prove RED for the right reason:** run it, confirm it FAILS, and confirm the failure message is the _intended_ assertion — not a compile error, missing import, or wrong-fixture false-positive. Isolate false-positives (stale tsc version, orphaned import, gate mismatch) and flag them; a test that fails for the wrong reason is not a valid red.
3. **Implement the wiring** (§2 minimal, §3 surgical).
4. **Prove GREEN:** re-run the SAME test, confirm PASS. Then run `bun run build` to confirm no type regression.
5. **Log the red→green transition** as evidence (story id, red reason, green proof).

## Wave gate

Merge to `main` only when the **entire wave** is verified green: full vitest baseline + `bun run build` + precheck + CI, run **one at a time**. If any story is stuck red, hold the whole wave — no partial merge that leaves a red story behind (no `test.skip`/`.only`, no stub tests — §failure_mode_guards).

## Output

A table of stories with red-reason → green-proof, the PRs, and any story deferred (say which and why).
