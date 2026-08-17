import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@xgis/site'

// This DS is dark-canvas by construction: `--background` is a near-black ink and
// `--foreground` is white. Every preview establishes that surface itself, the same
// way an app does at its root — a Card lifts off the canvas by a value step plus a
// hairline border, so on a white page it has nothing to lift off.
const surface = 'bg-background text-foreground rounded-lg p-8'

export function Basic() {
  return (
    <div className={surface}>
      <Card className="max-w-[420px]">
        <CardHeader>
          <CardTitle>Tile pipeline</CardTitle>
          <CardDescription>
            Vector tiles are decoded off-thread, then packed into GPU arenas once per frame.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl tabular-nums text-foreground">14.2</span>
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

export function CodePanel() {
  return (
    <div className={surface}>
      <Card className="max-w-[560px] overflow-hidden">
        <pre className="m-0 overflow-x-auto whitespace-pre px-7 py-6 font-mono text-[13.5px] leading-[1.8] text-foreground">
          <code>
            {'source land {\n'}
            {'  type: geojson\n'}
            {'  url:  "data/land.geojson"\n'}
            {'}\n\n'}
            {'layer continents {\n'}
            {'  source: land\n'}
            {'  | fill-zinc-200\n'}
            {'}'}
          </code>
        </pre>
        <div className="border-t border-border" />
        <div className="flex items-center justify-between gap-4 px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
          <span>Source · land.geojson</span>
          <span className="inline-flex items-center gap-2">
            Projection
            <span className="inline-block size-1.5 rounded-full bg-primary" />
            <span className="text-foreground/80">Mercator</span>
          </span>
        </div>
      </Card>
    </div>
  )
}

export function WithBadges() {
  return (
    <div className={surface}>
      <Card className="max-w-[420px]">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Renderer backend</CardTitle>
            <Badge>WebGPU</Badge>
          </div>
          <CardDescription>
            Falls back to WebGL2 when the adapter request returns null.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Badge variant="secondary">std140 UBO</Badge>
          <Badge variant="secondary">VAO</Badge>
          <Badge variant="outline">SwiftShader</Badge>
        </CardContent>
      </Card>
    </div>
  )
}

export function Grid() {
  return (
    <div className={`${surface} grid max-w-[720px] grid-cols-2 gap-4`}>
      <Card>
        <CardHeader>
          <CardTitle>Mercator</CardTitle>
          <CardDescription>Web-standard, conformal, poles clipped at ±85°.</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Orthographic</CardTitle>
          <CardDescription>Globe view from an infinite viewing distance.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
