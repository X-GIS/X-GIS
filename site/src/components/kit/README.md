# Site component kit (`src/components/kit/`)

The reusable **xAI** primitives that pages compose from — extracted from the
Wave-3 home sections so pages stop hand-writing the utility stack. Token-driven
(no hardcoded hexes; uses the `bg-bg` / `text-fg*` / `border-line` / `text-accent`
utilities from `global.css`), Astro 5 syntax, reduced-motion + no-JS safe.

Import via the barrel:

```astro
---
import { ContentBand, SectionHead, Card, FeatureRow, Eyebrow } from '@/components/kit'
---

<ContentBand id="why">
  <SectionHead num="01" eyebrow="The Approach"
    title="Beyond the library."
    lead="GIS rendering is locked to libraries. X-GIS answers with a language instead of an API." />
</ContentBand>
```

The barrel (`index.ts`) re-exports each `.astro` default. You can also import a
component directly (`import SectionHead from '@/components/kit/SectionHead.astro'`).

---

## Components

### `Eyebrow`
The signature mono-caps kicker (Geist Mono UPPERCASE, positively tracked — reads
as a code comment). Renders `font-mono uppercase tracking-[0.18em] text-[12px]
text-fg-mute`.

| Prop    | Type     | Default | Notes |
|---------|----------|---------|-------|
| `label` | `string` | —       | Kicker text. Falls back to `<slot>` when omitted. |
| `num`   | `string` | —       | Optional ordinal, e.g. `"01"`. Rendered as a `NN ·` prefix. |
| `class` | `string` | `''`    | Merged onto the root `<p>`. |

```astro
<Eyebrow num="01" label="The Approach" />   {/* 01 · The Approach */}
<Eyebrow label="What It Covers" />
<Eyebrow num="03">Made With It</Eyebrow>    {/* slot body */}
```

---

### `SectionHead`
The canonical section opener: `Eyebrow` → Inter weight-400 display head (tight
negative tracking, sentence-case) → optional lead. Composes `Eyebrow`. Head is
responsive `text-[40px] sm:text-[52px] lg:text-[64px]`, `tracking-[-0.02em]`.

| Prop      | Type     | Default | Notes |
|-----------|----------|---------|-------|
| `eyebrow` | `string` | —       | Eyebrow text. Omit to drop the eyebrow. |
| `num`     | `string` | —       | Ordinal forwarded to the eyebrow. |
| `title`   | `string` | —       | Head text. Falls back to `<slot>` (so you can pass `<br/>` / markup). |
| `lead`    | `string` | —       | Lead paragraph (`text-fg-dim text-[17px] sm:text-[19px] leading-[1.6] max-w-[660px]`). Plain text — use the head slot for rich markup. |
| `class`   | `string` | `''`    | Merged onto the wrapping container (default `max-w-[840px]`). |

```astro
<SectionHead num="01" eyebrow="The Approach"
  title="Beyond the library." lead="…" />

<SectionHead num="02" eyebrow="The Language">
  Write the map.<br />Read the program.   {/* slot = head, allows <br/> */}
</SectionHead>
```

---

### `ContentBand`
The section-rhythm wrapper: xAI vertical rhythm (`py-20 sm:py-32 lg:py-40`), a top
hairline divider, a centered max-width container, and `px-6` gutters. Renders a
`<section>`.

| Prop    | Type                                | Default      | Notes |
|---------|-------------------------------------|--------------|-------|
| `id`    | `string`                            | —            | Anchor id on the `<section>`. |
| `width` | `'standard' \| 'prose' \| 'wide'`   | `'standard'` | `standard` 1100px · `prose` 680px · `wide` 1280px. |
| `class` | `string`                            | `''`         | Merged onto the `<section>` (e.g. `border-t-0` for the first band). |

```astro
<ContentBand id="install" width="prose">…</ContentBand>
<ContentBand width="wide" class="border-t-0">…</ContentBand>
```

---

### `Card`
The xAI inset card: `bg-bg-card border border-line rounded-[8px]`, **no shadow**
(the hairline carries elevation). Renders a `<div>`.

| Prop      | Type     | Default | Notes |
|-----------|----------|---------|-------|
| `padding` | `string` | `'p-6'` | Padding utility (`p-8`, `px-5 py-4`, …). |
| `class`   | `string` | `''`    | Merged onto the root `<div>`. |

```astro
<Card>…</Card>
<Card padding="p-8" class="flex flex-col gap-4">…</Card>
```

---

### `FeatureRow`
The editorial row (rows over boxed grids): `grid-cols-[auto_1fr]` — a mono ordinal
rail · [display title + prose `<slot>`] — with a top hairline and generous `py-8`.
Pass `href` to make the whole row a link (title→accent + a 2px arrow nudge on
hover; reduced-motion disables the nudge).

| Prop    | Type     | Default | Notes |
|---------|----------|---------|-------|
| `num`   | `string` | —       | Ordinal in the left rail, e.g. `"01"`. |
| `title` | `string` | —       | **Required.** Row title (display, weight 400). |
| `href`  | `string` | —       | When set, the row renders as `<a>` and gains the link affordance. |
| `class` | `string` | `''`    | Merged onto the root element. |

Body goes in the default slot:

```astro
<FeatureRow num="01" title="Globe & 3D" href="/docs/concepts/globe">
  A real ellipsoidal globe, not a textured sphere — projections switch on a uniform.
</FeatureRow>
```

---

## Conventions

- **Tokens only** — never hardcode hexes; use the `global.css` utilities.
- **Astro 5** — frontmatter `---` + `interface Props` + `Astro.props` + `<slot/>`;
  classes merged with `class:list`.
- **Motion-safe** — only `FeatureRow` animates (a hover nudge), already guarded by
  `prefers-reduced-motion` and degrading without JS. The rest are static.
- **Buildable** — `bun run build` (CI) is the gate; local `astro build` is blocked
  by the expressive-code/shiki env issue.
