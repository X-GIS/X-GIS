# X-GIS Design System — how to build with it

This kit comes from the X-GIS documentation site. It is a **dark-canvas** system: a warm
near-black ground with white ink, elevation carried by hairline borders and value steps —
never by shadows.

## 1. Always establish the canvas at the root

There is no provider component to wrap in. What every screen needs instead is the surface,
set once at the root of what you build:

```jsx
<div className="min-h-screen bg-background text-foreground font-sans">{/* everything else */}</div>
```

**Do not skip this.** `primary` in this system is pure white (`#ffffff`) on a near-black
ground (`#0a0a0a`). Rendered on a default white page, a primary `Button` is an invisible
white pill and a `Card` has nothing to lift off. Emphasis here is carried by **shape (the
pill) and weight**, not by hue.

Fonts load from the stylesheet — `Inter Variable` for text, `Geist Mono Variable` for
labels and code. Reach for them through `font-sans` / `font-display` / `font-mono`, never
by hard-coding a family name.

## 2. The styling idiom: Tailwind utility classes

Style with utility classes. Two token vocabularies coexist and both resolve to the same
swatches — either is correct.

**shadcn semantic tokens** (what the React components themselves use):

| Family | Classes                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------- |
| Ground | `bg-background`, `bg-card`, `bg-popover`, `bg-muted`, `bg-secondary`                            |
| Ink    | `text-foreground`, `text-card-foreground`, `text-muted-foreground`, `text-secondary-foreground` |
| Accent | `bg-primary`, `text-primary-foreground`, `bg-destructive`, `text-destructive-foreground`        |
| Edges  | `border-border`, `border-input`, `ring-ring`                                                    |
| Radius | `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-full`                          |

**Project aliases** (used across the site's own markup, same swatches):

| Family | Classes                                                   |
| ------ | --------------------------------------------------------- |
| Ground | `bg-bg`, `bg-bg-elev`, `bg-bg-card`, `bg-bg-hover`        |
| Ink    | `text-fg`, `text-fg-dim`, `text-fg-mute`, `text-fg-faint` |
| Edges  | `border-line`, `border-line-strong`                       |
| Accent | `text-accent`, `bg-accent`                                |

**Signature motion + texture utilities**: `fade-up`, `fade-in`, `scale-fade`, `draw-grid`,
`marker-pulse`, and `graticule-field` (a surveyor's grid mesh for hero backgrounds; tune
its pitch with `--grid-step`). All respect `prefers-reduced-motion`.

House details worth imitating: uppercase tracked mono labels
(`font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground`), tabular
numerals for metrics (`tabular-nums`), and hairline dividers (`border-t border-border`).

## 3. The components

Three components ship with preview cards — `Badge`, `Button`, `Card` — plus `Card`'s parts
and the two variant helpers, all importable from the bundle:

- `Badge` — variants `default`, `secondary`, `outline`, `legend`. `legend` is the
  chart-label treatment: borderless, mono, uppercase, letterspaced.
- `Button` — variants `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`;
  sizes `default`, `sm`, `lg`, `icon`. Pill-shaped by default. `asChild` renders the
  styling onto a child element — that is how the site turns anchors into buttons.
- `Card` with `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`.
- `badgeVariants` / `buttonVariants` for applying the same classes to your own elements.

Anything else — layout, headers, tables, navigation — you build yourself from the utility
vocabulary above.

## 4. Where the truth lives

Read `_ds/<folder>/styles.css` and the files it `@import`s for the definitive token and
utility list, and each component's `.prompt.md` and `.d.ts` for its exact props. Those files
beat this summary whenever they disagree.

## 5. A representative composition

```jsx
const { Badge, Button, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } =
  window.XGis

export default function Panel() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans p-10">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
        Tile pipeline
      </div>
      <Card className="mt-4 max-w-[420px]">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Renderer backend</CardTitle>
            <Badge>WebGPU</Badge>
          </div>
          <CardDescription>
            Falls back to WebGL2 when the adapter request returns null.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl tabular-nums">14.2</span>
            <span className="text-sm text-muted-foreground">ms / frame at z14</span>
          </div>
        </CardContent>
        <CardFooter className="gap-3">
          <Button size="sm">Open profile</Button>
          <Button size="sm" variant="ghost">
            Dismiss
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
```
