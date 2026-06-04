// Typed operator vocabulary (roadmap S4). Every public mutation becomes an Op
// so the OperatorBus can log/undo/test it and declare its dirty domain. This
// slice covers the three cold scene setters; camera/layer/source Ops follow.
export type Op =
  | { readonly kind: 'SetProjection'; readonly name: string }
  | { readonly kind: 'SetBackgroundFill'; readonly value: unknown }
  | { readonly kind: 'SetGraticule'; readonly value: unknown }
export type OpKind = Op['kind']
