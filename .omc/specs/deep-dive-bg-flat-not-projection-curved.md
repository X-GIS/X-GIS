# Deep Dive Spec: Tile-scheme-agnostic ECEF rendering pipeline

(슬러그 유지: `bg-flat-not-projection-curved` — 시작은 bg 평면 문제였으나 근본 원인 = tile-scheme / 렌더 도메인 미스매치. 별도 브랜치에서 근원 해결 결정됨.)

## Goal

X-GIS를 **타일 스킴 무관 (scheme-agnostic) ECEF 정점 파이프라인**으로 전환. 3D Tiles 1.1 호환을 최종 목표로 함.

핵심 원칙: **Source-honest rendering**.
- 데이터가 ±85°까지만 커버하면 ±85°까지만 그림. 극지에 가짜 데이터 합성 안 함.
- 데이터가 ±90°까지 커버하면 (EPSG:4326 / S2 소스) ±90°까지 그대로 그림.
- 텍스처 stretch / 폴리곤 cap synthesis 같은 "보정" 일체 없음. 산업 관례라도 거부.
- 사용자는 데이터의 진실을 보고 싶어함. 렌더러가 데이터에 없는 것 만들어내면 안 됨.

부차 결과:
- bg 평면 문제 자동 소멸 (타일 메시가 ECEF 구면 위에 있으면 bg는 그 메시 footprint 색이며 자연 곡면화).
- 비-Mercator projection에서 sparse-vertex feature 곡률 결함 부분 해결 (정점이 ECEF 3D면 VP matrix만으로 정확한 위치, 다만 정점 사이의 great-circle 보간은 별도 — 정점 밀도 종속 잔존).

## Constraints

**Hard constraints:**

1. **Source-honest**: 렌더러는 데이터에 없는 영역을 **절대** 자동 채우거나 합성하지 않음.
   - 현재 `setPolarCapsEnabled()` 같은 옵션 → **유지 가능하지만 별도 데이터-전처리 도구**로 분류. 렌더러 코어에서 호출 안 함.
   - Cesium-style 텍스처 stretch → 도입 X.
   - 빈 영역 = 캔버스 clearValue (사용자 style 또는 투명).
2. **Tile-scheme abstraction**: 소스 백엔드가 자신의 타일 스킴 declare → 렌더러는 그 declaration 따름.
   - 지원 스킴 (Phase 1): `WebMercatorXYZ` (기존 PMTiles/raster), `EPSG:4326` (geographic quadtree, 2 root tiles).
   - 향후 (Phase 2): `S2CubeSphere` (6 root cells, 3D Tiles 1.1 `3DTILES_bounding_volume_S2` 호환).
3. **ECEF vertex pipeline**: 모든 타일 정점은 ECEF (Earth-Centered Earth-Fixed) Cartesian으로 GPU에 업로드.
   - compiler 측에서 lon/lat (또는 Mercator) → ECEF 변환을 인코딩 단계에 수행.
   - VS = `clip = mvp * vec4(ecef_rtc, 1.0)`. `project_geom` per-vertex 디스패치 **폐기**.
   - 카메라 매트릭스가 ECEF → 클립 좌표 책임짐 (3D Tiles 렌더러 표준 패턴).
4. **별도 브랜치 작업**: 메인 라인과 분리. 점진 머지 가능한 작은 PR 시리즈 또는 long-running feature branch. user 결정.

**Soft constraints:**

5. **Mercator 자산 호환**: 기존 PMTiles (Web Mercator MVT) + raster XYZ (OSM/Bing) 그대로 수용. 데이터 변환 강요 X.
   - Web Mercator 타일 → ECEF 변환은 compiler decode 단계에서 자동. 사용자는 PMTiles URL 그대로 사용.
   - 단 데이터의 ±85° 한계는 그대로 보임 (정직성 원칙).
6. **Mobile budget 보존**: ECEF f32 정밀도 한계 시 DSFUN (double-single fused unit) 또는 RTC (relative-to-center) 패턴 그대로 적용. 현 정밀도 손실 0.
7. **점진 출하 가능성**: Tier 1 (스킴 추상화 + EPSG:4326 backend) 먼저 머지, Tier 3 (ECEF 정점) 나중. user가 마일스톤 분할 결정.

## Non-Goals

- **Polar-cap synth 렌더러 기본 동작 도입.** band-aid. 별도 데이터 전처리 CLI로 분리 가능.
- **Imagery stretching at poles** (Cesium-imagery 방식). 도입 X.
- **3D Tiles glTF native consumer**: spec/loader 측은 향후. 현 단계 = "3D Tiles와 호환 가능한 좌표/스킴 토대" 까지.
- **자체 데이터 ECEF publishing tool**: 사용자 데이터 측을 ECEF로 변환하는 도구는 별도 트랙.
- **Per-vertex great-circle 보간 (line densification)**: 정점 사이의 곡률 부족 문제는 분리. 데이터 측 densification 또는 future runtime tessellation으로 처리.

## Acceptance Criteria

| AC | 기준 | 검증 |
|----|------|------|
| AC1 | Web Mercator XYZ 소스 (PMTiles, raster) 렌더링 결과: Mercator projection에서 **pixel-identical pre-change baseline**. 회귀 0. | 기존 픽셀 diff suite. |
| AC2 | Web Mercator XYZ 소스 + globe projection: 데이터가 있는 ±85° 영역만 sphere mesh로 렌더링. 그 외는 canvas clearValue (현재 캔버스 배경색). 가짜 폴라 캡 합성 0. | 새 globe-z2 screenshot 테스트, 극 영역 픽셀 = clearValue. |
| AC3 | EPSG:4326 geographic 스킴 소스 (테스트용으로 합성 가능) 렌더링: 모든 projection에서 ±90°까지 자연 도달. | 새 backend + 새 테스트 fixture. |
| AC4 | bg 평면 렌더링 문제 자동 해소 — bg는 별도 draw call 없이 sphere mesh의 자연 색으로 처리. | 글로벌/오쏘 픽셀 검사: bg 색이 sphere disc 모양 따라감. |
| AC5 | `project_geom` 셰이더 함수 호출 site 0개로 감소. (shader-DSL projection 함수 전체 삭제 또는 별도 transitional 보관) | grep `project_geom` 결과 0 또는 명시적 deprecated path. |
| AC6 | 타일 백엔드는 `TileScheme` 인터페이스로 자신의 스킴 declare. catalog가 dispatch. | 새 인터페이스 + dual-backend unit test. |
| AC7 | `setPolarCapsEnabled()` 렌더러 API 제거 또는 deprecation. 분리된 CLI/import 도구로 이동. | 코어 grep `polarCaps` 0 (또는 deprecation 표기). |
| AC8 | 모바일 mobile budget (`bun run build` + 디바이스 테스트) 회귀 없음. | 디바이스 측정. |

## Phased Execution

별도 브랜치 (`feature/ecef-tile-pipeline` 가칭) 위에서 다음 마일스톤:

**Phase 1: Tile-scheme abstraction (~1-2주)**
- `TileScheme` 인터페이스 도입.
- 기존 backend (PMTiles/GeoJSON/raster) 모두 `WebMercatorXYZ` 스킴 declare.
- catalog/key/source-manager가 스킴 인지.
- 새 `EPSG4326Backend` 스텁 (placeholder, 데이터 없어도 인터페이스 호환).
- ✅ Mercator-only world 그대로 동작 (AC1).
- ✅ source-honest 원칙 코드화 (polar-cap-synth 코어 호출 끊기).

**Phase 2: ECEF vertex pipeline (~2-4주)**
- compiler 측 `mvtToEcef` 또는 `latlonToEcef` 변환 추가 — encode-time.
- shader-DSL 폴리곤/라인/포인트/래스터 VS를 ECEF-input 가정으로 재작성. `project_geom` 호출 폐기.
- 카메라 매트릭스를 ECEF → clip 표준으로 재정의.
- DSFUN / RTC 정밀도 패턴 적용.
- bg 평면 문제 자동 해소 (AC4).
- ✅ AC5 달성.

**Phase 3: 풀 EPSG:4326 backend + 데이터 (~2-3주)**
- 실제 EPSG:4326 PMTiles 또는 GeoJSON 입력 처리.
- Geographic quadtree (2 root tile) 분기 로직.
- ✅ AC3 달성. 데이터가 ±90° 가지면 자연 도달.

**Phase 4: S2 cube-sphere 옵션 (~3-4주, 선택)**
- 3D Tiles 1.1 `3DTILES_bounding_volume_S2` 호환.
- Google S2 lib 통합 또는 hand-written S2 cell indexing.
- 6 root cell 분기.
- 풀-글로브 distortion 균일.

각 Phase 끝에 main 머지 후보. 또는 long-running branch + 한 번에 머지.

## Assumptions Exposed

- **A1**: ECEF 좌표는 미터 단위. WGS84 ellipsoid (a=6378137, f=1/298.257223563). float 정밀도 한계 = 약 ±0.5m at world scale, RTC/DSFUN로 sub-mm 회복.
- **A2**: 현 카메라 (`camera.ts`)는 Mercator 평면 좌표 기준. ECEF 전환 시 카메라 매트릭스 빌더 전면 재작성. 단 user-facing API (`setCenter(lon, lat)`, `setZoom(z)` 등) 보존.
- **A3**: 3D Tiles 1.1 region/box/sphere bounding volume은 지금 단계에서 안 다룸. Phase 4까지는 lat/lon 박스 + EPSG:4326 quadtree 또는 S2 cell-id로 충분.
- **A4**: PMTiles MVT 디코더의 vertex unpack 단계에서 lon/lat 복원 후 ECEF 변환 가능. 이미 `polygon.ts:206-210`에서 `abs_lon/abs_lat` 재구성 중 → encode-time으로 이동.
- **A5**: 사용자가 자체 EPSG:4326 PMTiles 데이터를 제공할 수 있다고 가정. 또는 X-GIS가 GeoJSON 입력을 EPSG:4326 모드로 슬라이스하는 옵션 추가.
- **A6**: User는 부분 머지 / 점진 출하 vs long-running branch 머지 결정 권한.

## Technical Context

**파일 영향 (예상):**

Phase 1 (스킴 추상화):
- `runtime/src/data/tile-source.ts` — `TileScheme` 인터페이스 추가
- `runtime/src/data/sources/pmtiles-backend.ts` — `scheme: 'WebMercatorXYZ'` declare
- `runtime/src/data/sources/virtual-pmtiles-backend.ts` — 동일
- `runtime/src/data/sources/raster-backend.ts` — 동일
- `runtime/src/data/tile-catalog.ts` — 키에 스킴 차원 추가
- `runtime/src/loader/polar-cap-*.ts` — 코어에서 분리, optional 패키지로 이동 또는 deprecate

Phase 2 (ECEF VS):
- `compiler/src/codegen/shader-gen.ts` (hot path, memory 따르면 48× hit)
- `runtime/src/engine/shader-dsl/shaders/polygon.ts` (lines 195-260 VS body)
- `runtime/src/engine/shader-dsl/shaders/line.ts`
- `runtime/src/engine/shader-dsl/shaders/point.ts`
- `runtime/src/engine/shader-dsl/shaders/raster.ts`
- `runtime/src/engine/shader-dsl/shaders/background.ts` — **삭제**
- `runtime/src/engine/shader-dsl/shaders/projections.ts` — `project_geom` 함수 폐기 또는 transitional 잔존
- `runtime/src/engine/render/background-renderer.ts` — **삭제** (AC4 자동)
- `runtime/src/engine/projection/camera.ts` — ECEF 카메라로 재작성
- `runtime/src/engine/projection/projections.ts` — CPU 측 project_geom dispatch 제거
- compiler MVT decoder — ECEF emit

Phase 3 (EPSG:4326 backend):
- `runtime/src/data/sources/epsg4326-pmtiles-backend.ts` (신규)
- `runtime/src/data/sources/epsg4326-geojson-backend.ts` (신규 또는 옵션)
- catalog quadtree dispatch

**리스크:**

- **카메라 ECEF 재작성** = 대규모 작업. interaction-controller, pitch/bearing/zoom 모두 ECEF 기반 재정의 필요.
- **DSFUN 정밀도 검증** = 모든 줌 레벨에서 sub-mm precision 보장 필수. 새 unit test surface.
- **MVT decoder 변경** = compiler worker 측 통째 변경. 캐시 키 변경.
- **점진 출하 어려움** = Phase 1 단독은 visible value 적음. Phase 2 완료 후 visible delta. user가 long-running branch 허용해야 함.

## Trace Findings (요약)

- bg 평면 = "tile-scheme / 렌더 도메인 미스매치"의 가장 가시적 사례. 같은 원인 다른 증상:
  - sparse-vertex feature가 great-circle 안 따름 (low zoom + 비-Mercator).
  - 극지 hole on globe (Web Merc ±85° 클램프).
  - oblique-merc polar tearing (memory `project_oblique_polar_tearing.md`).
  - non-Merc z=0 disc render fail (memory `project_non_merc_z0_disc_render_fail_2026_05_20.md`).
- 산업 표준 = Cesium (geographic terrain + Mercator imagery hybrid, polar stretch). 사용자가 거부.
- 진짜 source-honest 해법 = tile-scheme abstraction + ECEF 정점 + 합성 없음. 3D Tiles 1.1과 자연 호환.

## Ontology

| 용어 | 의미 |
|------|------|
| **Tile scheme** | 타일이 지구 표면을 분할하는 방식. `WebMercatorXYZ` / `EPSG:4326 quadtree` / `S2 cube-sphere` 등. |
| **ECEF** | Earth-Centered Earth-Fixed. 지구 중심 기준 3D Cartesian (X, Y, Z 미터). 모든 lat/lon은 ECEF로 1:1 매핑. |
| **Source-honest** | 렌더러가 데이터에 없는 영역을 합성하거나 stretch하지 않음. 데이터 = 진실의 단일 출처. |
| **Geographic quadtree (EPSG:4326)** | lon/lat 직접 분할. 2 root tile at z=0. 극에 특이점 없음. NASA Worldwind / Cesium World Terrain 기본. |
| **S2 cube-sphere** | 구체를 6 cube face로 투영 후 각 face를 quadtree 분할. 모든 셀 면적/distortion 균일. Google S2, 3D Tiles 1.1 표준 확장. |

## Trace Findings (full reference)

전체 trace 분석: `.omc/specs/deep-dive-trace-bg-flat-not-projection-curved.md`.

## Interview Transcript (요약)

1. Scope: bg 평면 (모든 non-Mercator).
2. Architecture: 초기 (A) 셰이더 측 projection-aware → 사용자 정정 → (α) per-tile bg fill.
3. Reference 리서치: Mapbox/MapLibre 같은 패턴, Cesium은 baked-in.
4. Architect 권고: per-projType hybrid (Option D — sphere만 tessellated mesh).
5. 사용자 정정: line/polygon도 같은 정점 밀도 결함 → 더 깊은 구조 문제.
6. 사용자 정정: 타일 기준이 Web Merc로 묶여 극지 필연 실패.
7. PMTiles/GeoJSON 인코딩 경로 (`VirtualPMTilesBackend` → geojsonvt → MVT) 확인.
8. NASA 3D Tiles / Cesium 리서치: EPSG:4326 quadtree, S2, ECEF.
9. 사용자 결정: 별도 브랜치에서 근원 해결. Tier 3 (ECEF + scheme abstraction) 방향.
10. 사용자 정정: **source-honest 원칙**. polar synth / texture stretch 거부. 데이터가 ±85°까지면 ±85°까지만 그림.

Final ambiguity ~5% (수용 가능). 구조적 결정 명확. Phase 분할 + 브랜치 워크플로우만 user 추가 확인 필요.
