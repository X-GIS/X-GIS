// ═══ heatmap layer registration (Phase R) ═══
// The heatmap converter body lives in ../layers-heatmap.ts. This module
// registers it into the per-type registry so the dispatcher routes
// `heatmap` through the same Map as every other layer type.

import { convertHeatmapLayer } from '../layers-heatmap'
import { registerLayerConverter } from './types'

registerLayerConverter('heatmap', convertHeatmapLayer)
