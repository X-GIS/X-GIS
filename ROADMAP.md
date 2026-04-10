# X-GIS Development Roadmap

## 전체 흐름도

```
Phase 0: MVP                    Phase 1: Core Language
파서 + 타입체커 + WGSL 코드젠     표현식, 모디파이어, 심볼,
+ GeoJSON + WebGPU 렌더러          모듈, struct/enum, fn
"빨간 폴리곤이 화면에 보인다"      "실제 지도 앱을 만들 수 있다"
        │                                 │
        ▼                                 ▼
Phase 2: Data Pipeline          Phase 3: Advanced Rendering
벡터타일, 래스터, 스트림,           entity, 3D extrude, terrain,
input/uniform, 호스트 바인딩        effect, @fragment, pipeline
"실시간 데이터를 표시한다"          "3D 지도 + 커스텀 셰이더"
        │                                 │
        ▼                                 ▼
Phase 4: Compute                Phase 5: Application
simulation, analysis,            overlay, annotation, widget,
computed geometry, 공간 연산       draw_tool, animation, interaction
"GPU로 분석을 돌린다"              "완전한 C2 앱을 만든다"
        │                                 │
        ▼                                 ▼
Phase 6: Domain Standards       Phase 7: Ecosystem & Production
S-100, MIL-STD-2525,            레지스트리, Studio, 서버렌더링,
Portrayal 변환, HDF5             멀티유저, 보안, ECDIS 인증
"해도를 표시한다"                 "실전 배치 가능하다"
```

---

## Phase 0: MVP — "화면에 폴리곤 하나"

### 목표
`source → layer → | fill-red-500 → 화면에 빨간 폴리곤`이 동작하는 것.
언어 설계의 핵심 가설(유틸리티 스타일 → WGSL 컴파일)을 검증.

### 구현 범위

```
컴파일러 (xgisc):
  ├── Lexer           토크나이저 (키워드, 유틸리티, 리터럴)
  ├── Parser          source, layer, | 유틸리티 파싱
  ├── Type Checker    기본 타입 (f32, rgba, string), source 스키마 매칭
  ├── IR Generation   UtilityLine → RenderNode
  └── WGSL Codegen    fill/stroke/opacity → vertex.wgsl + fragment.wgsl

런타임 (xgis-runtime):
  ├── WebGPU Context  디바이스 초기화, 렌더 루프
  ├── GeoJSON Loader  GeoJSON → GPU 버퍼 (폴리곤 테셀레이션, 라인, 포인트)
  ├── Pipeline Mgr    생성된 WGSL → WebGPU 파이프라인
  └── Map View        줌/패닝 카메라, 타일 좌표 ↔ 화면 좌표

CLI:
  └── xgisc dev scene.xgis --watch   (파일 변경 → 재컴파일 → 브라우저 리프레시)

지원 유틸리티 (최소):
  fill-{color}        fill-red-500, fill-#ff0000, fill-[field]
  stroke-{color}      stroke-blue-400
  stroke-{width}      stroke-2
  opacity-{value}     opacity-80
  size-{value}        size-8
```

### 입력 예시 (MVP로 동작해야 하는 코드)

```
// scene.xgis
source neighborhoods {
  type: geojson
  url: "./data/seoul_gu.geojson"
}

layer districts {
  source: neighborhoods
  | fill-blue-400  stroke-white  stroke-2  opacity-80
}
```

### 검증 기준
- [ ] .xgis 파일을 파싱하여 AST 생성
- [ ] AST → IR (RenderNode) 변환
- [ ] IR → WGSL 셰이더 생성
- [ ] GeoJSON 로드 → 폴리곤 테셀레이션 → GPU 버퍼
- [ ] WebGPU로 화면에 렌더링
- [ ] 줌/패닝 동작
- [ ] --watch 모드에서 .xgis 수정 → 실시간 반영

---

## Phase 1: Core Language — "진짜 지도 앱"

### 목표
데이터 기반 스타일링, 심볼, 모듈 시스템이 동작하여 실제 지도 앱을 만들 수 있는 수준.

### 구현 범위

```
언어 기능:
  ├── 표현식 시스템     산술, 비교, 논리, match, if
  ├── 데이터 모디파이어  friendly:fill-green-500, [speed>100]:fill-red
  ├── 줌 모디파이어      z8:opacity-40  z16:opacity-100 (보간 포함)
  ├── [expression] 바인딩  size-[speed/50|clamp:4,24]
  ├── 파이프 연산자      | clamp, ramp, round, format
  ├── symbol 정의        SVG path, rect, circle, anchor
  ├── preset             재사용 유틸리티 조합
  ├── struct / enum      데이터 스키마 정의
  ├── fn                 순수 함수 (GPU)
  ├── import / export    모듈 시스템
  ├── const / constexpr  상수
  └── nullable (T?, ??)  null 안전성

렌더러 확장:
  ├── 심볼 렌더링        SDF 기반 포인트 심볼
  ├── 라인 렌더링        대시, 캡, 조인
  └── 줌 보간            CPU에서 uniform 보간 → GPU

도구:
  ├── xgisc check        타입 체크 + lint (빌드 없이)
  ├── xgisc fmt          코드 포매터
  └── LSP 기초           자동완성, 에러 표시
```

### 검증 기준
- [ ] 데이터 속성에 따라 피처별 다른 색상
- [ ] 줌 레벨에 따라 스타일이 부드럽게 변화
- [ ] 커스텀 SVG 심볼이 올바른 위치에 렌더링
- [ ] 다른 .xgs 파일에서 스타일 import

---

## Phase 2: Data Pipeline — "동적 데이터"

### 목표
외부 데이터를 실시간으로 주입하고, 다양한 소스 포맷을 지원.

### 구현 범위

```
데이터:
  ├── 벡터 타일 (MVT)    타일 로딩 + 디코딩 + LOD
  ├── 래스터 타일         이미지 타일 텍스처
  ├── input / uniform     호스트에서 데이터 주입 (set/update/bind)
  ├── stream              WebSocket 실시간 피드
  ├── stream_processor    그룹핑, 윈도잉, 타임아웃

호스트 바인딩:
  ├── xgisc codegen --target=ts   TypeScript 인터페이스 + 버퍼 헬퍼 생성
  ├── 데이터 백킹 자동 결정        uniform vs storage vs texture
  └── f64 → f32 RTC 자동 처리

타일 시스템:
  ├── Quadtree 타일 관리
  ├── 타일 캐싱 (LRU)
  └── 줌 레벨별 LOD
```

### 검증 기준
- [ ] 벡터 타일 소스로 전 세계 지도 렌더링
- [ ] WebSocket으로 실시간 위치 업데이트 → 엔티티 이동
- [ ] TypeScript에서 map.set('tracks', buffer) → 즉시 반영

---

## Phase 3: Advanced Rendering — "3D + 이펙트"

### 목표
3D 건물, 지형, 커스텀 셰이더, 멀티패스 렌더링.

### 구현 범위

```
3D:
  ├── extrude             폴리곤 → 3D 돌출
  ├── terrain             DEM → 지형 메시
  ├── 3D geometry         sphere, cylinder, cone, frustum
  ├── terrain-clip        지형 위/아래 클리핑
  ├── drape-on-terrain    2D → 지형 드레이핑

렌더링:
  ├── @fragment / @vertex  셰이더 탈출구
  ├── effect 시스템        재사용 가능 이펙트 패키지
  ├── pipeline             멀티패스 (shadow → main → post)
  ├── PBR lighting        물리 기반 조명
  ├── depth buffer        깊이 테스트
  └── entity 시스템        개별 3D 오브젝트 + 모델 로딩 (glTF)

실행 전략:
  ├── 자동 instancing      동일 심볼 감지 → instanced draw
  ├── 자동 batching        배칭 그룹핑
  └── @strategy 힌트       render_bundle, indirect 등
```

### 검증 기준
- [ ] 3D 건물이 높이 데이터에 따라 돌출
- [ ] glTF 모델이 지도 위 정확한 좌표에 배치
- [ ] 커스텀 @fragment로 히트맵 렌더링
- [ ] 그림자 맵 동작

---

## Phase 4: Compute — "GPU 분석"

### 목표
GPU compute로 시뮬레이션과 공간 분석을 실행.

### 구현 범위

```
시뮬레이션:
  ├── grid 시뮬레이션      확산, 파동, 유체
  ├── particle 시뮬레이션   파티클 시스템
  ├── agent 시뮬레이션      궤적, 이동체
  └── 더블 버퍼링          자동 상태 스왑

분석:
  ├── analysis 파이프라인   step → parallel → reduce
  ├── per_segment / per_cell / per_item / per_pair / per_ray
  ├── 결과 → source 연결    analysis.output → layer.source
  └── 트리거 / 캐싱        on_change, cache: true

지오메트리 연산:
  ├── buffer, convex_hull, voronoi, contour
  ├── union, intersection, difference (불리언)
  └── 동적 지오메트리      엔티티 위치 기반 실시간 갱신
```

### 검증 기준
- [ ] 유류 확산 시뮬레이션이 그리드에서 동작
- [ ] 항로 위험 분석이 GPU에서 병렬 실행
- [ ] 분석 결과가 자동으로 레이어에 반영
- [ ] contour() 로 등치선 추출

---

## Phase 5: Application — "완전한 앱"

### 목표
HUD, 인터랙션, 드로잉 도구, 애니메이션이 포함된 완전한 지도 애플리케이션.

### 구현 범위

```
UI:
  ├── overlay              화면 고정 HUD (compass, status bar)
  ├── annotation           지리 좌표 텍스트 + 충돌 회피
  ├── widget               호스트 UI 프레임워크 브릿지 (React/Qt)
  └── 텍스트 렌더링         MSDF + 다국어

인터랙션:
  ├── click / hover / drag  통합 이벤트 모델
  ├── 피킹 (GPU pick)      피처 ID 렌더 패스
  ├── context_menu         우클릭 메뉴
  └── draw_tool            포인트/라인/폴리곤 드로잉

연결:
  ├── connection            엔티티 간 동적 라인
  └── trigger / zone_alert  영역 진입/이탈 이벤트

애니메이션:
  ├── state_machine         상태별 비주얼 전환
  ├── motion                데이터 보간 (smooth, angular)
  ├── timeline              항적 리플레이
  ├── model_anim            glTF 애니메이션 바인딩
  ├── keyframe_sequence     브리핑 시나리오
  └── camera animation      fly_to, follow, orbit

포맷팅:
  ├── 파이프 시스템          | mgrs, dms, compass, zulu, nm 등
  └── 커스텀 파이프 정의     @host pipe, GPU pipe

오디오:
  └── 경고 오디오            공간 음향, 트리거 연동
```

### 검증 기준
- [ ] 함정 전투 정보 체계 HUD (compass, status bar)
- [ ] 엔티티 우클릭 → 정보 패널
- [ ] 드로잉 도구로 작전 구역 그리기
- [ ] 항적 리플레이 (타임라인 슬라이더)
- [ ] 좌표 | mgrs 포맷팅 동작

---

## Phase 6: Domain Standards — "해도, 군사"

### 목표
S-100 해도 표준과 군사 심볼 체계를 지원.

### 구현 범위

```
S-100:
  ├── ISO 8211 파서        S-101 벡터 데이터 로딩
  ├── HDF5 로더            S-102/S-104/S-111 그리드 데이터
  ├── Feature Catalogue    → struct 자동 생성 (xgisc codegen)
  ├── Portrayal Catalogue  → 유틸리티 자동 변환 (xgisc convert-portrayal)
  ├── S-52 색상/심볼       tokens + symbol 라이브러리
  ├── Context Parameters   → uniform 매핑
  └── S-98 통합 규칙       멀티 프로덕트 레이어 순서

군사:
  ├── MIL-STD-2525         군사 심볼 라이브러리
  ├── NATO APP-6           NATO 심볼 체계
  ├── MGRS/UTM/GEOREF      좌표 변환
  └── Link-16, VMF         전술 데이터 링크 디코딩

마이그레이션:
  ├── xgisc convert        Mapbox Style JSON → X-GIS
  ├── Mapbox bridge        하이브리드 모드 (기존 앱에 X-GIS 추가)
  └── GeoPackage/Shapefile 변환
```

### 검증 기준
- [ ] S-101 ENC 해도가 S-52 규격으로 렌더링
- [ ] S-102 수심 데이터가 색상 램프로 표시
- [ ] MIL-STD-2525 군사 심볼 자동 표시
- [ ] Mapbox Style JSON을 X-GIS로 변환

---

## Phase 7: Ecosystem & Production — "실전 배치"

### 구현 범위

```
도구 생태계:
  ├── 패키지 레지스트리     @xgis/* 공식 + 커뮤니티
  ├── Studio               비주얼 스타일 에디터 (웹)
  ├── Playground            브라우저 코드 실험
  └── 문서 사이트            가이드 + API 레퍼런스

프로덕션:
  ├── 서버 렌더링           헤드리스 (Vulkan/CPU), 타일 서버, PDF
  ├── 멀티 타깃 빌드        WebGPU, Vulkan, Metal, HLSL
  ├── 게임 엔진 임베딩      Unity/Unreal 브릿지
  └── 성능 최적화           프로파일러, 자동 최적화 힌트

협업/보안:
  ├── 멀티 유저 동기화      shared/local 상태, 역할 기반
  ├── 보안 등급             레이어별 classification
  ├── 에어갭 번들           오프라인 패키지
  ├── 코드 서명             무결성 검증
  └── ECDIS 인증 경로       IHO 테스트 표준 대응 (장기)

컴파일러 고도화:
  ├── Rust 재작성?          성능 병목 확인 후 판단
  ├── 증분 컴파일           변경된 모듈만 재컴파일
  └── IR 최적화             상수 접기, 데드 코드, variant 최소화
```

---

## Phase 간 의존성

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3
  (MVP)     (언어)      (데이터)    (렌더링)
                                      │
                          ┌───────────┤
                          ▼           ▼
                      Phase 4     Phase 5
                      (분석)      (앱)
                          │           │
                          └─────┬─────┘
                                ▼
                            Phase 6
                            (표준)
                                │
                                ▼
                            Phase 7
                            (생태계)

병렬 가능:
  Phase 2 + Phase 3  (데이터와 3D는 독립적으로 진행 가능)
  Phase 4 + Phase 5  (분석과 앱 UI는 독립적)
  Phase 6의 마이그레이션 도구는 Phase 2 이후 시작 가능
  Phase 7의 문서/플레이그라운드는 Phase 1 이후 시작 가능
```

## 리스크

```
리스크                           완화 방안
──────                          ──────────
파서/컴파일러 복잡도 폭발         Phase 0에서 최소 문법만 구현, 점진 확장
WebGPU 브라우저 호환성            Vulkan 폴백, polyfill 모니터링
S-100 표준 접근성 (유료 문서)     IHO 공개 리소스 + OpenS100 참조
ECDIS 인증 비용/기간              비인증 뷰어로 시작, 인증은 Phase 7+
혼자/소규모 팀으로 전체 구현       Phase 0~2를 빠르게 → 커뮤니티 확보 → 기여자
```
