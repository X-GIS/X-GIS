# The 2026-08-03 audit: prove findings before filing them (#1553)

_Campaign plan for the stability / performance / memory-safety / clean-code audit run against `120cdfb7`. Tracker: #1553. Deliverable is verified findings as issues plus an adjudication of the 2026-06 audit series — no library code changes in this pass._

## What this is

A four-track audit (stability, performance, memory — full re-audit, clean code) executed as a
finder fan-out → dedup → adversarial-verification pipeline, with every filed finding carrying a
stated confidence basis and every dynamic probe run sequentially with a pre-registered
falsifiable prediction. The output is a tracker issue (#1553), one issue per verified finding
cluster, and an adjudication table appended to `docs/research/2026-06-audit-series-index.md`.

## What is actually asymmetric today

Two prior audits exist, in different states of decay:

- **2026-06-08 series** (`docs/research/2026-06-audit-*.md`): ten audits, one 17-item master
  fix list — and no record anywhere of which items were fixed. Every `file:line` in those docs
  predates the `runtime/` → `map`/`data`/`geo`/`engine` extraction, so the refs are rotted.
  The list can neither be trusted nor ignored; it has to be adjudicated at HEAD.
- **2026-07-27 memory audit** (#1359): rigorous, recent, partially executed. Six of its twelve
  findings are fixed; #1349 #1355 #1356 #1364 #1367 #1379 remain open. Its headline stands:
  _the runtime engineering is strong; the gates protecting it are absent._ Verified gate
  absences at HEAD: no typed lint (`no-floating-promises` et al.), no eslint or knip in CI,
  no memory soak in CI, ~26 of 40 `_perf-*` specs assert nothing and none run in CI, no GPU
  create/destroy accounting invariant, `rhi-webgpu` excluded from the render paths-filter,
  and no meta-gate that a ratchet allowlist's path keys still resolve (#996 shape).

A third audit that ignored these two would re-discover their findings and burn its budget on
duplicates. This campaign therefore starts from them: prior findings are dedup targets, the
17 items are adjudication targets, and #1359's verified-healthy list is a re-verification
target (user chose a full memory re-audit — trust nothing, including the healthy list).

## Why "just read the code and file issues" is not the answer

The failure corpus (`site/src/content/blog/`, 73 postmortems) documents what unverified audits
produce here: probes that fabricate findings, grep sweeps that silently under-match, count
gates that pass on broken scenes, and confident static traces refuted by their own falsifiable
predictions (#1367's history). The #1359 method — every suspected defect verified rather than
reported from a read, with a per-finding confidence basis — is the bar. This campaign keeps it
and adds an adversarial stage: findings are batched to independent verifiers whose brief is to
kill them, with a prove-or-refute-style proof obligation (proposition → file:line-grounded
steps → closed, or the unproven step named and the finding demoted to needs-probe).

## The design

Pipeline (Workflow orchestration; agents are contractually read-only — Grep/Glob/Read and
read-only git only, no test/build processes, per CLAUDE.md §7):

1. **W0 corpus** (main loop): open-issue list, #1359 digest (findings + healthy list + current
   states), the 17 items, acknowledged-debt baselines, `95c7d3d..HEAD` delta file list.
2. **W1 fan-out (19)**: 3 Track-0 adjudicators (17 items → fixed / live / refuted /
   superseded-by-#N, evidence from code + git history) and 16 finders:
   memory M1 teardown-chain enumeration · M2 module-global state · M3 GPU create/destroy
   pairing · M4 data-package lifecycle · M5 healthy-list re-verification · M6 text/glyph/atlas;
   stability S1 floating promises · S2 teardown races · S3 error-propagation gaps · S4
   frame-loop re-arm/halt; perf P1 per-frame allocation · P2 algorithmic/scheduler · P3
   mechanical spec inventory; clean-code C1 dead exports (static, probe-gated) · C2 structural
   sibling duplication · C3 gate absences + ratchet stale-key check. Every candidate must carry
   a verbatim ≤3-line snippet from HEAD (mechanically re-checked downstream) — the
   anti-hallucination tripwire.
3. **W2 dedup (2)**: tag each candidate novel / dup-of-#N / extends-#N (becomes a comment on
   #N, not an issue) / healthy-regression / ratchet-acknowledged.
4. **W3 adversarial verification (≤12) + W3b (S1 double-check, ≤8-in-3)**: kill-brief batches
   by file locality; verdicts confirmed / refuted / downgraded / needs-probe, each with a
   falsifiable prediction. Zero-kill batches are spot-checked in the main loop.
5. **P sequential probes** (main loop, one at a time, ≤8): only for needs-probe survivors and
   quantified S1 claims; pre-registered expected-if-true vs expected-if-false plus a control
   arm. knip runs here (sequentially) to confirm or kill every dead-export candidate.
6. **W4 synthesis + filing** (main loop reviews everything): cluster by mechanism family and
   fix locus, file issues in the #1359 house format, finalize the tracker, append the
   adjudication table, commit docs, open the draft PR.

Evidence sufficient to file, per class: leak/teardown = owner-vs-destroy-chain enumeration;
unbounded cache = write sites + grep-proof of no cap/clear; floating promise = the reachable
reject path; race = a concrete interleaving argument or it is not filed; perf = caller-chain
reach + complexity argument, never an ms claim without a probe; dead code = mechanical (knip)
confirmation only; duplication = side-by-side verbatim cites; gate absence = config reads plus
one concrete missed-bug instance.

## Rejected, with reasons

- **Fix-as-you-audit** — rejected by the user for this pass; fixes ride follow-up issues so
  each gets its own gate and review instead of riding an audit diff nobody can review.
- **Delta-only memory audit** (the cheap option, given #1359 is a week old) — rejected by the
  user; the full re-audit re-verifies the healthy list instead of assuming it, which is also
  the only posture that can catch #1359's own blind spots.
- **A separate findings report doc in-repo** — #1359 set the convention: the tracker issue is
  the report; probes are run and discarded; the only committed artifacts are the plan, the
  adjudication of a doc that already exists, and any probe spec that earns permanence (#1369
  precedent). A second report file would be a second authority (§12's second-ratchet lesson).
- **Filing finder output directly** (no adversarial stage) — the corpus shows confident static
  reads being wrong repeatedly; an unverified finding costs a maintainer a triage round-trip,
  and twenty of them cost the audit its credibility.

## Open questions

- Whether wave-2 finders (conditional on ≥50% verified yield in a track) are worth their
  budget — decided in the main loop after W3 statistics land.
- Whether any probe earns permanence as an `_audit-*` e2e spec — decided per probe.

## Verification

- The pipeline verifies itself stage-wise: schema-validated outputs, snippet-existence checks
  at verification, dedup spot-checks, S1 double-verification, zero-kill-batch review.
- Campaign-level: every filed issue names its confidence basis and repro/enumeration; the
  tracker carries the method table and any corrections on record, mirroring #1359.
- Repo-level: the branch diff at PR time must be docs-only (plus any approved probe spec) —
  `git diff origin/main --stat` is checked before push.

## Increments

1. Corpus + tracker (#1553) — done before any finder ran (§9.5).
2. W1→W3b pipeline run; main-loop spot-checks of adjudication verdicts and dedup calls.
3. Sequential probes + knip; downgrade or confirm per prediction.
4. Synthesis; issues filed; tracker finalized; adjudication table committed.
5. Draft PR with docs-only diff; CI green; Korean summary reply to the user.
