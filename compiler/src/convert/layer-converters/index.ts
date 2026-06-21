// ═══ Layer-converter registry assembler ═══
// Importing this module triggers each per-type converter to self-
// register into LAYER_CONVERTERS (side-effect imports). The dispatcher
// (../layers.ts) imports LAYER_CONVERTERS from here and looks up the
// converter by `layer.type`. Adding a new layer type = add one module
// + one import line here (append-only, parallel-safe).

import './generic' // fill, fill-extrusion, raster
import './line'
import './circle'
import './symbol'
import './heatmap'

export { LAYER_CONVERTERS, type LayerConvertFn } from './types'
