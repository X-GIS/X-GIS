import { Button } from '@xgis/site'

// This DS is dark-canvas by construction: `--background` is a near-black ink and
// `--foreground` is white. Every preview establishes that surface itself, the same
// way an app does at its root — without it the white `primary` pill is invisible.
const surface = 'bg-background text-foreground rounded-lg p-8'

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

export function Variants() {
  return (
    <div className={`${surface} flex flex-wrap items-center gap-3`}>
      <Button>Read the docs</Button>
      <Button variant="outline">View examples</Button>
      <Button variant="secondary">Copy config</Button>
      <Button variant="ghost">Dismiss</Button>
      <Button variant="destructive">Delete layer</Button>
      <Button variant="link">Changelog</Button>
    </div>
  )
}

export function Sizes() {
  return (
    <div className={`${surface} flex flex-wrap items-center gap-3`}>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Next">
        <ChevronRight />
      </Button>
    </div>
  )
}

export function WithIcon() {
  return (
    <div className={`${surface} flex flex-wrap items-center gap-3.5`}>
      <Button size="lg">
        Read the docs <ChevronRight />
      </Button>
      <Button size="lg" variant="outline">
        View examples
      </Button>
      <Button size="lg" variant="ghost" className="text-muted-foreground">
        Convert from Mapbox <ChevronRight className="opacity-70" />
      </Button>
    </div>
  )
}

export function Disabled() {
  return (
    <div className={`${surface} flex flex-wrap items-center gap-3`}>
      <Button disabled>Compiling…</Button>
      <Button variant="outline" disabled>
        View examples
      </Button>
      <Button variant="ghost" disabled>
        Dismiss
      </Button>
    </div>
  )
}

export function AsLink() {
  return (
    <div className={`${surface} flex flex-wrap items-center gap-3`}>
      <Button asChild>
        <a href="#docs">Anchor styled as a button</a>
      </Button>
      <Button asChild variant="outline">
        <a href="#examples">Secondary anchor</a>
      </Button>
    </div>
  )
}
