// Load + apply real-world camera-motion scenarios from JSON fixtures
// in playground/e2e/fixtures/scenarios/. The scenarios describe a
// startCamera → endCamera transition under a given projection with
// an easing curve and duration. This helper:
//
//   1. Loads the JSON fixture by name
//   2. Validates the schema (shape gate so missing fields are loud)
//   3. Exposes the parsed scenario to consumer specs that can plug
//      it into runInteraction() or a direct setCamera setup
//
// Plan §8.5 — paired with playground/e2e/fixtures/scenarios/*.json.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'scenarios')

export interface CameraState {
  lon: number
  lat: number
  zoom: number
  pitch: number
  bearing: number
}

export interface Scenario {
  name: string
  description: string
  projection:
    | 'mercator'
    | 'globe'
    | 'equirectangular'
    | 'natural_earth'
    | 'orthographic'
    | 'azimuthal_equidistant'
    | 'stereographic'
    | 'oblique_mercator'
  startCamera: CameraState
  endCamera: CameraState
  durationMs: number
  easing: 'linear' | 'ease-in-out-cubic'
}

const VALID_PROJECTIONS = new Set<Scenario['projection']>([
  'mercator',
  'globe',
  'equirectangular',
  'natural_earth',
  'orthographic',
  'azimuthal_equidistant',
  'stereographic',
  'oblique_mercator',
])

const VALID_EASING = new Set<Scenario['easing']>(['linear', 'ease-in-out-cubic'])

function validateCameraState(c: unknown, label: string): asserts c is CameraState {
  if (typeof c !== 'object' || c === null) {
    throw new Error(`${label}: not an object`)
  }
  const o = c as Record<string, unknown>
  for (const field of ['lon', 'lat', 'zoom', 'pitch', 'bearing']) {
    if (typeof o[field] !== 'number' || !Number.isFinite(o[field])) {
      throw new Error(`${label}.${field}: expected finite number, got ${typeof o[field]}`)
    }
  }
}

export function loadScenario(name: string): Scenario {
  const path = join(FIXTURES_DIR, `${name}.json`)
  const raw = readFileSync(path, 'utf8')
  const data = JSON.parse(raw) as unknown
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Scenario ${name}: parsed JSON is not an object`)
  }
  const s = data as Record<string, unknown>
  if (typeof s.name !== 'string') throw new Error(`${name}: missing name`)
  if (typeof s.description !== 'string') throw new Error(`${name}: missing description`)
  if (typeof s.projection !== 'string' || !VALID_PROJECTIONS.has(s.projection as Scenario['projection'])) {
    throw new Error(`${name}: invalid projection "${String(s.projection)}"`)
  }
  validateCameraState(s.startCamera, `${name}.startCamera`)
  validateCameraState(s.endCamera, `${name}.endCamera`)
  if (typeof s.durationMs !== 'number' || !Number.isFinite(s.durationMs) || s.durationMs <= 0) {
    throw new Error(`${name}.durationMs: expected positive number, got ${s.durationMs}`)
  }
  if (typeof s.easing !== 'string' || !VALID_EASING.has(s.easing as Scenario['easing'])) {
    throw new Error(`${name}.easing: expected one of ${[...VALID_EASING].join(' / ')}, got "${String(s.easing)}"`)
  }
  return s as unknown as Scenario
}

export function listKnownScenarios(): string[] {
  return ['seoul-zoomin', 'manhattan-pitch', 'global-globe-rotation', 'arctic-projection-flip']
}
