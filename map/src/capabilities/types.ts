// Runtime capability row type. Split out of ../capabilities.ts so each
// per-layer-type descriptor file (fill.ts / line.ts / circle.ts / …) can
// import the type WITHOUT a circular dependency on the assembler that
// spreads them all together.
//
// Convention (see ../capabilities.ts header): layer.property:variant where
// variant is 'constant' | 'zoom-interp' | 'data-driven'. Set `supported`
// false ONLY when the runtime path drops or silently degrades the input.

export interface RuntimeCapability {
  property: string
  layerType: string
  variant: 'constant' | 'zoom-interp' | 'data-driven'
  supported: boolean
  /** When false, brief reason for the gap. */
  note?: string
}
