# PR 2c.2 Resume Handoff (작업 미완)

## 상태
- 브랜치: `feature/ecef-tile-pipeline-phase2-pr2c2`
- 위치: 작업 디스크에 보존됨 (커밋 안됨, push 안됨)
- 기반: `feature/ecef-tile-pipeline-phase2-pr2c` (PR #159, main 머지 대기)
- tsc: 양 패키지 clean
- vitest: 18+ 실패. 첫 확인된 케이스: `tile-cross-path-invariants.test.ts:257` outline endpoint가 fill 경계에서 471482 단위 이격

## 구현 완료 (커밋 미실행)

### 폴리곤 DSL (runtime/src/engine/shader-dsl/shaders/polygon.ts)
- DELETED: `vs_main_quantized`, `vs_main_quantized_extruded`
- PRESERVED: `vs_main` (LINE pipeline entry at renderer.ts:822, 858)
- ADDED: `vs_main_ecef` (stride-9 inputs: pos_h/pos_l/feat_id/abs_lon/abs_lat)
- ADDED: `vs_main_ecef_extruded` (stride-14 inputs: + face_normal/wall_height/is_top)
- snapshot baselines 8개 **stale** (regen 필요)

### 타일러 (compiler/src/tiler/vector-tiler.ts)
- packECEFPolygonVertices stride-7 → stride-9 (abs_lon/abs_lat 추가)
- 호출 사이트 :1411, :1623 packDSFUNPolygonVertices → packECEFPolygonVertices 스왑
- packQuantizedPolygonVertices + QUANT_POLY_* 상수 삭제
- `pointVertices` 경로는 packDSFUNPolygonVertices 보존 (점 VS PR 2d 마이그레이션 대기)

### 런타임 메쉬 (runtime/src/core/polygon-mesh.ts)
- ADDED: `generateWallMeshExtrudedECEF(polygons, heights, bases, tileMx, tileMy, tileEcefCenter)` → stride-14
- DELETED: `quantizePolygonVertices`, `quantizePolygonVerticesExtruded`
- 메인 세션에서 버그 fix 적용: writeVertex/midpoint/writeRoofVert에 `tileMx + mx`, `tileMy + my` 절대 좌표 변환 추가

### VTR (runtime/src/engine/render/vector-tile-renderer.ts)
- quantize* imports + 호출 사이트 :2171, :2198, :2432, :2439 모두 삭제
- generateWallMeshExtruded → generateWallMeshExtrudedECEF 스왑
- zAttribute parallel 버퍼 폐기 (stride-14 unified)

### Renderer (runtime/src/engine/render/renderer.ts)
- vertexBufferLayout: arrayStride 8 → 36 (float32x3 + float32x3 + 3×float32)
- extrudedZBufferLayout RETIRED
- extrudedVertexBufferLayout NEW: arrayStride 56 (stride-9 + face_normal + wall_height + is_top)
- ~20 폴리곤 파이프라인 binding: vs_main_quantized* → vs_main_ecef* 리와이어
- lineVertexBufferLayout + vs_main 바인딩 (:822, :858, :981) 보존

### Uniform writer (위치 미확인 - 신규 세션에서 검증 필요)
- `u.mvp_ecef` 슬롯은 PR 2c.1에서 추가됨
- D-render 워커가 wire 했다고 보고. 미검증

## 신규 테스트 (passes)
- compiler/src/tiler/ecef-precision-fuzz.test.ts (8 pass)
- runtime/src/engine/projection/ecef.test.ts (33 pass, extended)
- runtime/src/engine/projection/camera-ecef-mvp.test.ts (4 pass)
- runtime/src/engine/projection/polygon-ecef-mvp-latitude-parity.test.ts (25 pass)
- runtime/src/core/polygon-mesh-ecef.test.ts (5 pass)
- runtime/src/engine/shader-dsl/shaders/polygon-dsl.test.ts (27 pass, updated)
- runtime/src/data/tile-data-origin-backend.test.ts (6 pass)

## 실패 테스트 (18+, 첫 확인)
- `runtime/src/data/tile-cross-path-invariants.test.ts:257` outline endpoint off fill = 471482 (expected ≤10)
  - **원인 추정**: 폴리곤 fill 정점이 ECEF metres 절대 좌표 (stride-9: pos_h+pos_l+fid+abs_lon+abs_lat). Outline 정점은 여전히 Mercator-DSFUN (stride-6: mx_h, my_h, mx_l, my_l, fid, arc_start). 두 좌표계 비교 → 의미 없음.
  - **수정 방향**: 테스트가 폴리곤 fill 정점을 abs_lon/abs_lat로 추출 → 같은 lon/lat 공간에서 outline 비교. 또는 ECEF 정점 → Mercator 역변환 후 비교.

## 신규 세션 명령어

### 1. 컨텍스트 복구
```bash
cd D:/X-GIS
git checkout feature/ecef-tile-pipeline-phase2-pr2c2
git status --short
cat .omc/plans/PR-2c2-resume-handoff.md
cat .omc/plans/ralplan-tier3-phase2-ecef-vs-migration.md | head -200
```

### 2. 현재 상태 확인
```bash
npx tsc -p compiler/tsconfig.json --noEmit
npx tsc -p runtime/tsconfig.json --noEmit
# 양쪽 clean 확인됨
```

### 3. 실패 테스트 전체 목록 추출
```bash
npx vitest run --reporter=verbose 2>&1 | grep -E '(FAIL|×)' | head -50
```

### 4. 첫 실패 디버그 (cross-path-invariants)
```bash
npx vitest run runtime/src/data/tile-cross-path-invariants.test.ts 2>&1 | tail -50
# 테스트 파일 읽고 stride-9 ECEF 좌표 추출하도록 수정
```

### 5. Snapshot baselines regen (drift gate 검증 후)
```bash
# 먼저 한 baseline diff 검토
npx vitest run runtime/src/engine/shader-dsl/shaders/polygon-variant-diff.test.ts 2>&1 | head -100
# 검토 후 regen
npx vitest run runtime/src/engine/shader-dsl/shaders/polygon-variant-diff.test.ts -u
```

### 6. 위도-spanning ~200셀 픽셀 디프 harness
```bash
# 픽셀 디프 harness 위치 확인 필요
find runtime/src -name 'pixel-survey*' -o -name '*pixel-diff*' | head -5
npx vitest run <harness-path>
```

### 7. 전체 vitest + render-gate
```bash
npx vitest run
# 모두 green 후
gh pr checks  # render-gate CI 확인
```

### 8. PR 2c.2 커밋 + push + open
```bash
git add -A
git commit -m "feat: PR 2c.2 polygon ECEF VS rewrite + retire quantized + wall-mesh ECEF (...)"
git push -u origin feature/ecef-tile-pipeline-phase2-pr2c2
gh pr create --base feature/ecef-tile-pipeline-phase2-pr2c --title "[Phase 2 PR 2c.2] Polygon DSL ECEF VS + retire quantized + runtime wall-mesh ECEF lift" --body "..."
```

### 9. PR 2c.3 시작 (분리 세션 권장)
```bash
git checkout -b feature/ecef-tile-pipeline-phase2-pr2c3
# SyntheticEarthSurfaceBackend + BackgroundRenderer 삭제
# 자세한 ACs는 .omc/plans/ralplan-tier3-phase2-ecef-vs-migration.md US-002 참조
```

### 10. PR 2c.4 시작 (분리 세션)
```bash
git checkout -b feature/ecef-tile-pipeline-phase2-pr2c4
# TILE_LAYOUT_VERSION 1→2 + catalog mismatch eviction + closeout tracking issue
# 자세한 ACs는 plan US-003 참조
```

## 주요 디자인 결정 보존

### Dual-MVP (architect/critic 컨센서스, iter 1-4)
- `u.mvp` = Mercator-DSFUN MVP (line VS + legacy paths)
- `u.mvp_ecef` = ENU-metre native MVP (polygon ECEF VS)
- 폴리곤만 ECEF; line/point/raster/text는 PR 2d에서 마이그레이션
- Phase 2 closeout: PR 2d 종료시 `u.mvp` 삭제 + `u.mvp_ecef` → `u.mvp` 리네임

### Sphere vs Ellipsoid
- legacy Mercator MVP = 구면 (E2=0)
- PR 2c.1 추가 변형: `lonLatToECEFSphere`, `mercatorToECEFSphere`
- camera가 sphere variant 사용 (legacy basis 매칭)
- ellipsoid 헬퍼는 미래 3D Tiles 1.1 parity용 보존

### 위도 패리티 검증 (Critic C-1 gate)
- 24-cell lat∈{0,30,45,60,75,85} × zoom∈{0,4,10,18} matrix-parity 테스트
- worst case 0.77px (threshold 1.5px) — green
- 이거 fail하면 dual-MVP 수학 잘못된 것

## 컨텍스트
- 일자: 2026-05-27
- 작업 시간: ralph 100 iteration (~수 시간)
- 사용 모델: opus 4.7 (1M context)
- 작업자: Claude (X-GIS xgis-dev)
- 컨센서스 plan: v4 (architect + critic 2회 + 1회 추가)
- 메모리 노트 갱신 미실행 (신규 세션에서 plan 마무리 후)
