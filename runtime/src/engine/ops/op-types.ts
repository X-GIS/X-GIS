// Typed operator vocabulary (roadmap S4). Every public mutation becomes an Op
// so the OperatorBus can log/undo/test it and declare its dirty domain. This
// slice covers the three cold scene setters; camera/layer/source Ops follow.
export type Op =
  | { readonly kind: 'SetProjection'; readonly name: string }
  | { readonly kind: 'SetBackgroundFill'; readonly value: unknown }
  | { readonly kind: 'SetGraticule'; readonly value: unknown }
  | { readonly kind: 'SetCenter'; readonly lon: number; readonly lat: number }
  | { readonly kind: 'SetZoom'; readonly zoom: number }
  | { readonly kind: 'SetBearing'; readonly bearing: number }
  | { readonly kind: 'SetPitch'; readonly pitch: number }
  | { readonly kind: 'JumpTo'; readonly opts: unknown }
  | { readonly kind: 'EaseTo'; readonly opts: unknown }
  | { readonly kind: 'FlyTo'; readonly opts: unknown }
  | { readonly kind: 'PanBy'; readonly offset: readonly [number, number] }
  | { readonly kind: 'FitBounds'; readonly args: unknown }
  | { readonly kind: 'SetPaintProperty'; readonly layerId: string; readonly property: string; readonly value: unknown }
export type OpKind = Op['kind']
