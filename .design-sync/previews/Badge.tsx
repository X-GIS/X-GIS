import { Badge } from '@xgis/site'

// This DS is dark-canvas by construction: `--background` is a near-black ink and
// `--foreground` is white. Every preview establishes that surface itself, the same
// way an app does at its root — without it the white `primary` swatch is invisible.
const surface = 'bg-background text-foreground rounded-lg p-8'

export function Variants() {
  return (
    <div className={`${surface} flex flex-wrap items-center gap-3`}>
      <Badge>WebGPU</Badge>
      <Badge variant="secondary">WebGL2 fallback</Badge>
      <Badge variant="outline">experimental</Badge>
      <Badge variant="legend">Projection</Badge>
    </div>
  )
}

export function LegendRow() {
  return (
    <div className={`${surface} flex flex-col gap-3`}>
      <Badge variant="legend">Tile pipeline</Badge>
      <div className="flex items-center gap-3">
        <span className="text-2xl tabular-nums text-foreground">14.2</span>
        <span className="text-sm text-muted-foreground">ms / frame</span>
      </div>
      <div className="h-px bg-border" />
      <Badge variant="legend">Source · land.geojson</Badge>
    </div>
  )
}

export function StatusTags() {
  return (
    <div className={`${surface} flex flex-col items-start gap-2.5`}>
      <div className="flex items-center gap-2">
        <span className="w-28 text-sm text-muted-foreground">Mercator</span>
        <Badge>supported</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-28 text-sm text-muted-foreground">Orthographic</span>
        <Badge variant="secondary">partial</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-28 text-sm text-muted-foreground">Oblique</span>
        <Badge variant="outline">planned</Badge>
      </div>
    </div>
  )
}
