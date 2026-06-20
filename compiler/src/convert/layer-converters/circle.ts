// ═══ circle layer registration ═══
// The circle converter body already lives in ../layers-circle.ts
// (extracted earlier). A4 only registers it into the per-type
// registry so the dispatcher routes `circle` through the same Map as
// every other layer type. Zero logic change.

import { convertCircleLayer } from '../layers-circle'
import { registerLayerConverter } from './types'

registerLayerConverter('circle', convertCircleLayer)
