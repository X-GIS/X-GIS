# X-GIS Technical Documentation

How X-GIS works — the rendering algorithms, the math, the memory model, and the
engineering system that keeps them correct. Written for readers who want to build a
similar engine and extract the transferable design decisions without excavating the
~210k-LOC codebase.

## Two editions, same topics

Every chapter exists in two parallel editions:

- **[`dev/`](./dev/)** — for experienced human engineers. Narrative essays: the problem,
  why naive approaches fail, the mechanism, and the incidents that shaped it. Read these
  first.
- **[`agent/`](./agent/)** — for an AI agent (or a very patient human) mining the design.
  Dense and citation-first: exact formulas, struct layouts, invariants with their
  enforcing gates, `file:line` pointers into this repository, rejected alternatives with
  the measurements that rejected them, and a "transferable design rules" list per
  chapter.

The editions mirror each other chapter-for-chapter; each links to its counterpart.

## Chapters

| # | Topic | dev | agent |
|---|---|---|---|
| 01 | Architecture: packages, boundaries, ratchets, ADRs, the pass chain | [dev](./dev/01-architecture.md) | [agent](./agent/01-architecture.md) |
| 02 | Coordinates & precision: error budgets, RTC, df64, depth, parity | [dev](./dev/02-coordinates-precision.md) | [agent](./agent/02-coordinates-precision.md) |
| 03 | The shader DSL: typed IR → WGSL + GLSL + CPU oracle + reflection | [dev](./dev/03-shader-dsl.md) | [agent](./agent/03-shader-dsl.md) |
| 04 | Line rendering: instanced quads + fragment SDF | [dev](./dev/04-line-rendering.md) | [agent](./agent/04-line-rendering.md) |
| 05 | Polygon rendering: tessellation, fill/outline agreement, patterns, extrusion | [dev](./dev/05-polygon-rendering.md) | [agent](./agent/05-polygon-rendering.md) |
| 06 | Memory & upload: RHI, arenas, budgets, workers | [dev](./dev/06-memory-upload.md) | [agent](./agent/06-memory-upload.md) |
| 07 | Performance: demand rendering, tile selection, adaptive quality, draw batching | [dev](./dev/07-performance.md) | [agent](./agent/07-performance.md) |
| 08 | Content subsystems: text/labels, the style compiler, scientific coverage, flow, globe surface | [dev](./dev/08-content-subsystems.md) | [agent](./agent/08-content-subsystems.md) |
| 09 | Verification: gate ladders, fail-before, hash-equality rendering | [dev](./dev/09-verification.md) | [agent](./agent/09-verification.md) |

## Suggested reading orders

- **"I'm designing a new map/globe engine"**: 01 → 02 → 04 → 05 → 03 → 06 → 07 → 09 → 08.
- **"I want the rendering techniques only"**: 04 → 05 → 02 → 03.
- **"I want the engineering system"**: 01 → 09 → the postmortem corpus below.
- **AI agents**: read `agent/` end-to-end (≈ the full design surface at ~1/60 the tokens
  of the source tree); follow `file:line` pointers only where implementation detail is
  needed.

## Relationship to other documentation in this repo

These chapters synthesize; they do not replace the primary sources:

- `docs/COORDINATES.md` — the coordinate-space **contract** (normative).
- `docs/adr/` — decision records with rejected alternatives (append-only; the WHY).
- `docs/architecture/` — C4 views, module DAG, subsystem plans and status.
- `docs/verification/` — the verification strategy and the real-GPU matrix.
- `site/src/content/blog/` — 74 incident postmortems; each frontmatter `description` is
  its abstract. Deliberately **no index file** (a hand-synced index would drift — see the
  "second ratchet" postmortem); grep it by keyword.
- `CLAUDE.md` §12 — the condensed lessons ledger, one line per paid-for incident.

Facts in these chapters were verified against the code at the commit that introduced
them; `file:line` references may drift as the code moves (see the postmortem
`the-coordinates-rot-before-the-symptom` — the precise-looking part of a document rots
first). When a chapter and the code disagree, the code and its gates win.
