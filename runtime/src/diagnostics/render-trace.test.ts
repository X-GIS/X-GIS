import { describe, it, expect } from 'vitest'
import {
  InMemoryTraceRecorder,
  createTraceRecorder,
  type RenderTraceRecorder,
  type TraceLayer,
  type TraceLabel,
} from './render-trace'

describe('InMemoryTraceRecorder', () => {
  it('returns an empty trace before any record calls', () => {
    const rec = new InMemoryTraceRecorder()
    const trace = rec.snapshot()
    expect(trace.cameraZoom).toBe(0)
    expect(trace.cameraCenter).toEqual([0, 0])
    expect(trace.layers).toEqual([])
    expect(trace.labels).toEqual([])
    expect(trace.tileLOD.selectedCz).toBe(0)
    expect(trace.tileLOD.fetchedKeys).toEqual([])
  })

  it('records camera state', () => {
    const rec = new InMemoryTraceRecorder()
    rec.recordCamera(4.5, 139.76, 35.68)
    const trace = rec.snapshot()
    expect(trace.cameraZoom).toBe(4.5)
    expect(trace.cameraCenter).toEqual([139.76, 35.68])
  })

  it('records tile-LOD decision', () => {
    const rec = new InMemoryTraceRecorder()
    rec.recordTileLOD({ selectedCz: 5, fetchedKeys: ['5/16/12', '5/16/13'] })
    const trace = rec.snapshot()
    expect(trace.tileLOD.selectedCz).toBe(5)
    expect(trace.tileLOD.fetchedKeys).toEqual(['5/16/12', '5/16/13'])
  })

  it('accumulates layers in record order', () => {
    const rec = new InMemoryTraceRecorder()
    const a: TraceLayer = {
      layerName: 'water',
      fillPhase: 'fills',
      resolvedOpacity: 1,
      resolvedStrokeWidth: 0,
      resolvedFill: [0.7, 0.8, 0.9, 1],
    }
    const b: TraceLayer = {
      layerName: 'countries-boundary',
      fillPhase: 'strokes',
      resolvedOpacity: 0.5,
      resolvedStrokeWidth: 1.2,
      resolvedStroke: [1, 1, 1, 1],
    }
    rec.recordLayer(a)
    rec.recordLayer(b)
    const trace = rec.snapshot()
    expect(trace.layers).toEqual([a, b])
  })

  it('accumulates labels in record order', () => {
    const rec = new InMemoryTraceRecorder()
    const south: TraceLabel = {
      layerName: 'countries-label',
      text: 'South Korea',
      color: [0, 0, 0, 1],
      fontFamily: 'Open Sans',
      fontWeight: 600,
      fontStyle: 'normal',
      sizePx: 12,
      placement: 'point',
      state: 'placed',
      anchorScreenX: 100,
      anchorScreenY: 200,
    }
    rec.recordLabel(south)
    const trace = rec.snapshot()
    expect(trace.labels).toHaveLength(1)
    expect(trace.labels[0]).toEqual(south)
  })

  it('snapshot resets internal state so the recorder is reusable', () => {
    const rec = new InMemoryTraceRecorder()
    rec.recordCamera(3, 0, 0)
    rec.recordLayer({
      layerName: 'a',
      fillPhase: 'all',
      resolvedOpacity: 1,
      resolvedStrokeWidth: 1,
    })
    rec.snapshot()  // discard

    rec.recordCamera(5, 1, 2)
    const second = rec.snapshot()
    expect(second.cameraZoom).toBe(5)
    expect(second.cameraCenter).toEqual([1, 2])
    expect(second.layers).toEqual([])  // reset cleared
  })

  it('createTraceRecorder factory returns a working recorder', () => {
    const rec: RenderTraceRecorder = createTraceRecorder()
    rec.recordCamera(7, -73.97, 40.78)
    const trace = rec.snapshot()
    expect(trace.cameraZoom).toBe(7)
    expect(trace.cameraCenter).toEqual([-73.97, 40.78])
  })
})
