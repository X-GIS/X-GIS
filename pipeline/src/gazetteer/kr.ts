// ═══ @xgis/pipeline · gazetteer/kr — Korea (bundled snapshot) ═══
//
// One country's gazetteer, keyed by the Korean 행정표준코드 (KR:ADMCD). Other
// countries get a sibling file (gazetteer/us.ts, gazetteer/jp.ts) built the same
// way — `makeGazetteer(meta, entries)` from the generic join/ resolver — so the
// pipeline stays country-generic.
//
// Seoul 25 자치구 (sigungu, adminLevel 2), 행정표준코드 5-digit code (11110 종로구 …
// 11740 강동구) → WGS84 centroid.
//
// PROVENANCE: centroids derived (vertex mean of the exterior ring) from
// southkorea/seoul-maps (`kostat/2013/json/seoul_municipalities_geo_simple.json`),
// itself from SGIS / 통계청 (KOSTAT) boundary data. Sigungu boundaries are
// vintage-STABLE (unlike 행정동, which merge/split yearly), so one snapshot serves
// every vintage — the `vintage` argument satisfies the join's contract.
//
// ⚠️ LICENSE — UNVERIFIED (prototype). Before this ships to a PUBLIC (non-`private`)
// package, the southkorea/seoul-maps + SGIS redistribution terms MUST be confirmed
// (design doc §6, hard gate). If redistribution is not permitted, replace this
// bundled snapshot with a fetch-and-cache generator. This package is `"private": true`
// and used for the internal prototype only.

import { makeGazetteer, type GazEntry, type Gazetteer } from '../join'

/** Seoul 자치구 (sigungu), 행정표준코드 → WGS84 centroid. */
const SEOUL_SIGUNGU: readonly GazEntry[] = [
  { code: '11110', name: '종로구', lon: 126.98155, lat: 37.59469 },
  { code: '11140', name: '중구', lon: 126.99629, lat: 37.55526 },
  { code: '11170', name: '용산구', lon: 126.9842, lat: 37.53437 },
  { code: '11200', name: '성동구', lon: 127.03598, lat: 37.55109 },
  { code: '11215', name: '광진구', lon: 127.09398, lat: 37.54897 },
  { code: '11230', name: '동대문구', lon: 127.05691, lat: 37.5846 },
  { code: '11260', name: '중랑구', lon: 127.09859, lat: 37.59572 },
  { code: '11290', name: '성북구', lon: 127.01952, lat: 37.60528 },
  { code: '11305', name: '강북구', lon: 127.01243, lat: 37.64283 },
  { code: '11320', name: '도봉구', lon: 127.03328, lat: 37.66855 },
  { code: '11350', name: '노원구', lon: 127.08066, lat: 37.65041 },
  { code: '11380', name: '은평구', lon: 126.92712, lat: 37.61351 },
  { code: '11410', name: '서대문구', lon: 126.94297, lat: 37.57986 },
  { code: '11440', name: '마포구', lon: 126.91245, lat: 37.56108 },
  { code: '11470', name: '양천구', lon: 126.8554, lat: 37.52191 },
  { code: '11500', name: '강서구', lon: 126.81897, lat: 37.55771 },
  { code: '11530', name: '구로구', lon: 126.85505, lat: 37.49145 },
  { code: '11545', name: '금천구', lon: 126.90365, lat: 37.45786 },
  { code: '11560', name: '영등포구', lon: 126.90873, lat: 37.5186 },
  { code: '11590', name: '동작구', lon: 126.9488, lat: 37.49501 },
  { code: '11620', name: '관악구', lon: 126.9459, lat: 37.46479 },
  { code: '11650', name: '서초구', lon: 127.0392, lat: 37.46405 },
  { code: '11680', name: '강남구', lon: 127.07502, lat: 37.4879 },
  { code: '11710', name: '송파구', lon: 127.12419, lat: 37.49706 },
  { code: '11740', name: '강동구', lon: 127.15333, lat: 37.54851 },
]

/** The Seoul 자치구 (sigungu) gazetteer — country KR, system KR:ADMCD, adminLevel 2.
 *  Sigungu geometry is vintage-stable, so any vintage resolves the same centroids
 *  (the arg satisfies the join's vintage contract). */
export function seoulSigunguGazetteer(opts: { vintage: string }): Gazetteer {
  return makeGazetteer(
    { country: 'KR', system: 'KR:ADMCD', adminLevel: 2, vintage: opts.vintage },
    SEOUL_SIGUNGU,
  )
}

/** The raw entries (for a boundary-tier gazetteer / tests). */
export { SEOUL_SIGUNGU }
