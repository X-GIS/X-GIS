# DESIGN.md — X-GIS

> Design source-of-truth for the X-GIS site rebuild (Astro + React islands).
> Token + rule + rationale in one file. Every screen the rebuild produces must stay
> on this system. If a case isn't covered, decide from the **Principles** + **Voice**,
> then add the rule back here.

---

## 1. Essence

**X-GIS is a precision cartographic instrument that runs on the GPU.** Not a chat UI,
not a generic dev-tool dashboard, not a flat npm-library landing. The site should feel
like the cover of a survey instrument: **calm, exact, spacious, confident** — with the
*map / globe / shader render itself* as the hero, and the chrome receding around it.

Three words that gate every decision: **Precise · Spatial · Warm-technical.**

- **Precise** — hairlines not heavy borders; tabular numerals; coordinate-grade labels; nothing decorative-for-decoration.
- **Spatial** — Apple-grade whitespace and type scale; one idea per scroll section; the layout breathes like a map margin.
- **Warm-technical** — a cartographer's warm ink, not generic cold black. Engineering rigor with paper warmth.

**Anti-goals:** AI-startup gradient soup, neon-on-black "futuristic," bento-box card grids, emoji, drop shadows as decoration, more than one accent hue.

---

## 2. Voice

Confident, concrete, declarative. We say what the engine *does*, in the fewest exact words.

- ✅ "Declare the map. The GPU draws it." · "One typed IR → WGSL and GLSL."
- ❌ "Revolutionize your mapping workflow with cutting-edge AI-powered rendering."

Korean (later phase): plain, direct, 합쇼체 for product copy; pass all KR copy through the
`humanize-korean` skill before shipping (no translation-ese). KR is deferred — en first.

---

## 3. Palette — "Drafting Table" (refined dark instrument)

Dark is primary: it lets the map/globe/shader renders pop as the hero and reads as a
precision instrument. The ground is **warm ink** (black-with-warmth), never cold #000.
ONE accent — surveyor's **sienna**. Evolve the existing tokens; do not invent a new hue.

| Token | Value | Use |
|---|---|---|
| `--ink` (bg) | `#14110c` | page ground (warm, val ~7%) |
| `--ink-2` (bg-elev) | `#1e1a13` | raised panel |
| `--ink-3` (bg-card) | `#29231a` | card / inset |
| `--ink-4` (bg-hover) | `#352e21` | hover fill |
| `--paper` (fg) | `#efe8da` | primary text (warm paper) |
| `--paper-2` (fg-dim) | `#b8ad99` | secondary text |
| `--paper-3` (fg-mute) | `#8c8169` | labels / captions |
| `--paper-4` (fg-faint) | `#524a3a` | tertiary / disabled |
| `--hair` (line) | `rgba(239,232,218,.09)` | hairline rules — the primary structural device |
| `--hair-2` (line-strong) | `rgba(239,232,218,.16)` | emphasized rule / focus |
| `--sienna` (accent) | `#cb6a3c` | THE single accent — used sparsely |
| `--sienna-hover` | `#df8052` | accent hover |
| graticule | `rgba(239,232,218,.06)` | the meridian mesh motif |

**Accent budget rule:** sienna appears at most ~3–4 times per viewport (one primary CTA, a
kicker, a key number, an active link). If everything is accented, nothing is. Default to
paper-on-ink; reach for sienna only to mark the ONE thing that matters in a region.

**Color is carried by the work, not the chrome.** The vivid color on the page should come
from the actual map renders / shader outputs / globe, framed by a near-monochrome shell.

(A light "drafting paper" mode is a possible future variant — NOT in this rebuild. One mode, done well.)

---

## 4. Typography

Three self-hosted faces, already wired (`@fontsource-variable`):

- **Big Shoulders Display** (`--font-display`) — condensed survey-stamp face. Headlines ONLY.
- **Archivo** (`--font-sans`) — grotesque body. All prose + UI.
- **Spline Sans Mono** (`--font-mono`) — code, coordinate labels, kickers, numerals.

**Scale (Apple-grade, fluid):**

| Role | Size (mobile → desktop) | Face | Notes |
|---|---|---|---|
| Hero | 56 → 96px | display | `leading-[0.9]`, `tracking-[0.01em]`, uppercase ok |
| Section head | 36 → 56px | display | one per scroll section |
| Sub-head | 24 → 32px | display or sans-600 | |
| Lead / intro | 18 → 22px | sans | `leading-[1.6]`, `max-w-[660px]` |
| Body | 16 → 17px | sans | `leading-[1.7]`, measure `max-w-[680px]` |
| Caption / label | 11 → 13px | mono | `uppercase`, `tracking-[0.16em–0.22em]`, fg-mute |
| Code | 13px | mono | expressive-code frames |

Rules: tabular numerals everywhere (`font-variant-numeric: tabular-nums`). Generous line-height
on prose (1.6–1.75). Mono kickers above section heads ("`CONCEPT · 01`") are a signature device.

---

## 5. Space & layout

Apple-grade air. Whitespace is the primary design material.

- **Section rhythm:** vertical padding `80px (mobile) → 120 → 180px (desktop)` between major sections.
- **Content widths:** prose `max-w-[680px]`; standard section `max-w-[1100px]` (matches Header/Footer); full-bleed visuals may exceed.
- **One idea per scroll section**, separated by a single hairline rule — NOT boxed cards.
- **Structure via type hierarchy + space + hairlines**, not borders/shadows. Cards (when truly needed) are inset fills (`bg-card`) with a hairline, radius `0.625rem`, never shadowed.
- **Editorial feature lists** over equal-height card grids: `mono index · display title · sans prose` rows on a `grid-cols-[auto_1fr]`.
- 8px base grid for spacing.

---

## 6. Motion

Restrained, purposeful, Apple-calm. Easing `cubic-bezier(0.16, 0.84, 0.32, 1)`.

- **Scroll reveal:** sections fade + rise (~28px, ~0.8s) as they enter the viewport (IntersectionObserver).
  Staggered children via a `--reveal-delay` step (~0.08s). MUST be **no-JS safe** (content visible by
  default; hidden start-state gated behind an `html.js` class) and **reduced-motion safe** (`@media (prefers-reduced-motion: reduce)` → no transform/animation, full opacity).
- **Hover:** color/opacity transitions ~0.15s. No scale-bounces, no spring overshoot on UI.
- The **graticule mesh** may draw-in subtly on hero load (existing `draw-grid`).
- No autoplaying loops except the live map/globe demo itself.

---

## 7. Signature motifs (what makes it X-GIS, not generic)

1. **Graticule mesh** — faint meridian/parallel grid (existing `graticule-field`) as a background texture on heroes/section breaks. The map margin made into chrome.
2. **Coordinate labels** — mono, wide-tracked, uppercase micro-labels (`LAT 37.5413 · LON 126.8819`, `z14`, `EPSG:4326`) used as kickers/captions. Reads as instrument readout.
3. **Survey-stamp headlines** — Big Shoulders condensed caps for the biggest type.
4. **The render is the hero** — every major section should, where possible, show real X-GIS output (globe, vector tiles, a shader, the live compile graph), framed minimally.

---

## 8. Components (rebuild targets, React+Astro)

Astro for static/layout + content; **React islands** (shadcn/ui base, already installed) for
anything interactive (live compile graph, design toggles, search, tabs, the map/globe embeds).

- **Button** — primary: solid sienna, `text-on-sienna`, pill (`rounded-full`), `px-5 py-2.5`. Secondary: hairline border, paper text, hover→sienna border+text. No third style.
- **Nav (Header)** — fixed, `backdrop-blur`, `bg/72`, hairline bottom. Mono-ish links, active = sienna. Keep ≤7 items.
- **Kicker** — mono, uppercase, tracking `0.22em`, sienna or fg-mute, above heads.
- **Feature row** — `[mono index] [display title] [sans prose]`, hairline-separated, reveal-staggered.
- **Code block** — expressive-code, `github-dark-default` retoned, radius `0.75rem`, no frame shadow.
- **Card (sparingly)** — `bg-card` + hairline + radius, inset feel, never shadowed.
- **Footer** — calm, hairline top, mono meta, link columns.

Accessibility: real heading hierarchy, `:focus-visible` 2px sienna outline (existing), AA contrast
(paper-on-ink passes), reduced-motion honored, no-JS content visible.

---

## 9. Information architecture (rebuild scope)

- **Home** — promo hero + the X-GIS story in scroll sections (declare→compile→GPU; globe; shader IR; performance). The render is the hero.
- **Docs** — Diátaxis (Get started / Guides / Language / Concepts / API). Concepts EXPANDED (Globe, Shader IR, Rendering engine, Tiles & sources, Labels, Camera, Performance) — currently too few.
- **Blog** — engineering notes (shipped in foundation).
- **Examples / Shaders / Blueprint / Convert** — interactive surfaces, React islands.
- **i18n** — en first; `/ko` later, each KR page humanized.

---

## 10. Build rules

- **Astro + React islands.** Static pages in `.astro`; interactivity as React islands (shadcn base). Don't ship React where Astro suffices.
- **Tailwind v4 (`@theme`)** — use the tokens above via utilities (`bg-bg`, `text-fg-dim`, `border-line`, `text-accent`). Don't hardcode hexes in markup.
- **Surgical, on-system, reviewable diffs** — even in a full rebuild, land it page-by-page so each change is legible and ships green. No opaque mass file dumps.
- **CI is the gate** (local `astro` build is currently blocked by an expressive-code/shiki env issue) — every change validated by CI `bun run build` + reviewed on the GitHub Pages deploy.
