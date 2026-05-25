import { describe, expect, it } from 'vitest'
import {
  mercator, equirectangular, naturalEarth,
  orthographic, azimuthalEquidistant, stereographic, obliqueMercator,
} from '../projection/projection'
import { globeForward } from '../projection/globe'
import * as mirror from '../projection/projection-wgsl-mirror'
import {
  projMercatorCpu, projEquirectangularCpu, projNaturalEarthCpu,
  projOrthographicCpu, projAzimuthalEquidistantCpu, projStereographicCpu,
  projObliqueMercatorCpu, projGlobeCpu, cosCCpu,
  projectCpu, projectGeomCpu, needsBackfaceCullCpu, invMercLatRadCpu,
} from './cpu-projections'

// AC2-spike (a) — the mirror-deletion gate. The cpu-f64 lowering GENERATED
// from the IR must reproduce the current mirror's numbers: it is the same f64
// op tree with the same full-precision consts. Two checks:
//   (1) generated cpu ↔ canonical projection.ts  ≤1mm  (the same grid the
//       existing projection-wgsl-consistency.test.ts holds the mirror to)
//   (2) generated cpu ↔ existing mirror           ≤1e-6 m  (byte-equivalence,
//       proving the generated dispatch can REPLACE the file before deletion)

function sampleGrid(): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      out.push([-180 + (i / 9) * 360, -85 + (j / 9) * 170])
    }
  }
  return out
}
const GRID = sampleGrid()
const CL = 0, CT = 20

describe('AC2-spike(a): generated cpu-f64 ↔ canonical projection.ts (≤1mm)', () => {
  it('mercator', () => {
    for (const [lon, lat] of GRID) {
      const [xA, yA] = mercator.forward(lon, lat)
      const [xB, yB] = projMercatorCpu(lon, lat)
      expect(xB).toBeCloseTo(xA, 3); expect(yB).toBeCloseTo(yA, 3)
    }
  })
  it('equirectangular', () => {
    const eq = equirectangular()
    for (const [lon, lat] of GRID) {
      const [xA, yA] = eq.forward(lon, lat)
      const [xB, yB] = projEquirectangularCpu(lon, lat)
      expect(xB).toBeCloseTo(xA, 3); expect(yB).toBeCloseTo(yA, 3)
    }
  })
  it('natural_earth', () => {
    const ne = naturalEarth()
    for (const [lon, lat] of GRID) {
      const [xA, yA] = ne.forward(lon, lat)
      const [xB, yB] = projNaturalEarthCpu(lon, lat)
      expect(xB).toBeCloseTo(xA, 3); expect(yB).toBeCloseTo(yA, 3)
    }
  })
  it('orthographic (front hemisphere)', () => {
    const cpu = orthographic(CL, CT)
    for (const [lon, lat] of GRID) {
      if (cosCCpu(lon, lat, CL, CT) <= 0) continue
      const [xA, yA] = cpu.forward(lon, lat)
      const [xB, yB] = projOrthographicCpu(lon, lat, CL, CT)
      expect(xB).toBeCloseTo(xA, 3); expect(yB).toBeCloseTo(yA, 3)
    }
  })
  it('azimuthal equidistant (full globe)', () => {
    const cpu = azimuthalEquidistant(CL, CT)
    for (const [lon, lat] of GRID) {
      const [xA, yA] = cpu.forward(lon, lat)
      const [xB, yB] = projAzimuthalEquidistantCpu(lon, lat, CL, CT)
      expect(xB).toBeCloseTo(xA, 3); expect(yB).toBeCloseTo(yA, 3)
    }
  })
  it('stereographic (non-antipodal)', () => {
    const cpu = stereographic(CL, CT)
    for (const [lon, lat] of GRID) {
      if (cosCCpu(lon, lat, CL, CT) <= -0.9) continue
      const [xA, yA] = cpu.forward(lon, lat)
      const [xB, yB] = projStereographicCpu(lon, lat, CL, CT)
      expect(xB).toBeCloseTo(xA, 3); expect(yB).toBeCloseTo(yA, 3)
    }
  })
  it('oblique_mercator (main strip)', () => {
    const cpu = obliqueMercator(CL, CT)
    for (const [lon, lat] of GRID) {
      const [xA, yA] = cpu.forward(lon, lat)
      const [xB, yB] = projObliqueMercatorCpu(lon, lat, CL, CT)
      expect(xB).toBeCloseTo(xA, 3); expect(yB).toBeCloseTo(yA, 3)
    }
  })
  it('globe (true 3D)', () => {
    for (const [lon, lat] of GRID) {
      const [xA, yA, zA] = globeForward(lon, lat)
      const [xB, yB, zB] = projGlobeCpu(lon, lat)
      expect(xB).toBeCloseTo(xA, 3); expect(yB).toBeCloseTo(yA, 3); expect(zB).toBeCloseTo(zA, 3)
    }
  })
})

describe('AC2-spike(a): generated cpu-f64 ↔ existing mirror (byte-equivalence, ≤1e-6 m)', () => {
  const perProj: Array<[string, (l: number, a: number) => [number, number], (l: number, a: number) => [number, number]]> = [
    ['mercator', (l, a) => projMercatorCpu(l, a), (l, a) => mirror.projMercatorWgsl(l, a)],
    ['equirectangular', (l, a) => projEquirectangularCpu(l, a, 0), (l, a) => mirror.projEquirectangularWgsl(l, a, 0)],
    ['natural_earth', (l, a) => projNaturalEarthCpu(l, a, 0), (l, a) => mirror.projNaturalEarthWgsl(l, a, 0)],
    ['orthographic', (l, a) => projOrthographicCpu(l, a, CL, CT), (l, a) => mirror.projOrthographicWgsl(l, a, CL, CT)],
    ['azimuthal', (l, a) => projAzimuthalEquidistantCpu(l, a, CL, CT), (l, a) => mirror.projAzimuthalEquidistantWgsl(l, a, CL, CT)],
    ['stereographic', (l, a) => projStereographicCpu(l, a, CL, CT), (l, a) => mirror.projStereographicWgsl(l, a, CL, CT)],
    ['oblique_mercator', (l, a) => projObliqueMercatorCpu(l, a, CL, CT), (l, a) => mirror.projObliqueMercatorWgsl(l, a, CL, CT)],
  ]
  it.each(perProj)('per-projection forward: %s', (_name, gen, ref) => {
    for (const [lon, lat] of GRID) {
      const [gx, gy] = gen(lon, lat)
      const [rx, ry] = ref(lon, lat)
      expect(gx).toBeCloseTo(rx, 6); expect(gy).toBeCloseTo(ry, 6)
    }
  })

  it('project() dispatch matches mirror for projType 0..6', () => {
    for (let pt = 0; pt <= 6; pt++) {
      for (const [lon, lat] of GRID) {
        const [gx, gy] = projectCpu(pt, lon, lat, CL, CT)
        const [rx, ry] = mirror.projectWgsl(pt, lon, lat, CL, CT)
        if (!Number.isFinite(rx)) continue
        expect(gx).toBeCloseTo(rx, 6); expect(gy).toBeCloseTo(ry, 6)
      }
    }
  })

  it('project_geom() matches mirror (incl. seam unwrap) for projType 0..6', () => {
    for (let pt = 0; pt <= 6; pt++) {
      for (const refLon of [0, 127, -150, 175]) {
        for (const [lon, lat] of GRID) {
          const [gx, gy] = projectGeomCpu(pt, lon, lat, CL, CT, refLon)
          const [rx, ry] = mirror.projectGeomWgsl(pt, lon, lat, CL, CT, refLon)
          if (!Number.isFinite(rx)) continue
          expect(gx).toBeCloseTo(rx, 4); expect(gy).toBeCloseTo(ry, 4)
        }
      }
    }
  })

  it('needs_backface_cull() matches mirror sign for projType 0..7', () => {
    for (let pt = 0; pt <= 7; pt++) {
      for (const [lon, lat] of GRID) {
        const g = needsBackfaceCullCpu(pt, lon, lat, CL, CT)
        const r = mirror.needsBackfaceCullWgsl(pt, lon, lat, CL, CT)
        expect(Math.sign(g)).toBe(Math.sign(r))
        if (pt === 3 || pt === 7) expect(g).toBeCloseTo(r, 6) // raw cos(c)
      }
    }
  })

  it('inv_merc_lat_rad() matches mirror', () => {
    for (let lat = -85; lat <= 85; lat += 5) {
      const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * 6378137
      expect(invMercLatRadCpu(y)).toBeCloseTo(mirror.invMercLatRad(y), 9)
    }
  })
})
