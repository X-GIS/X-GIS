# X-GIS Language Design Research

## 1. Problem Statement

지도 렌더링은 본질적으로 **데이터 기반 렌더링**이다. 그러나 현재 GIS 생태계에서는:

- **"무엇을 어떻게 그릴 것인가"의 정의가 라이브러리에 종속**됨
- 개발자가 셰이더를 모르면 GDI+/Canvas2D 수준의 렌더링에 머무름
- 군사/특수 데이터 포맷은 접근성이 떨어지고 라이브러리별로 개별 처리 필요
- 크로스플랫폼(Web, C++, Mobile) 일관성 부재

**비전**: HTML/CSS/JS가 웹 렌더링을 정의하듯, GIS 렌더링을 정의하는 **자체 언어 생태계**를 만든다.

```
[웹 세계]               [X-GIS 세계]
HTML (구조/데이터)  →   구조 언어 (레이어, 소스, 데이터 바인딩)
CSS (스타일)        →   스타일 언어 (심볼라이저, 시각 속성, 애니메이션)
JS (동작/로직)      →   로직 언어 (데이터 변환, 필터, 인터랙션, compute)
브라우저 엔진       →   X-GIS 엔진 (Quadtree, 3D Tiles, Projection, WebGPU)
```

---

## 2. Existing Approaches — Analysis

### 2.1 MapLibre/Mapbox Style Spec

**접근**: JSON 기반 선언적 스타일. Lisp-like 표현식 시스템.

| 강점 | 약점 |
|---|---|
| 직렬화 가능 → 도구(Maputnik, Studio) 생태계 | 커스텀 셰이더 불가 (CustomLayerInterface는 탈출구) |
| Paint/Layout 분리 → GPU 최적화 | 피처 간 연산 불가 (집계, 공간 조인 등) |
| 표현식 시스템으로 데이터 기반 스타일링 | Lisp-in-JSON 문법이 복잡해지면 가독성 저하 |
| 타일 기반 배칭 + GPU 보간 → 우수한 성능 | 고정된 레이어 타입 (fill/line/circle/symbol 등) |

**핵심 교훈**: Paint Property Binder 패턴 (정수 줌에서 평가, 분수 줌은 GPU 보간) 은 성능 최적화의 정석.

### 2.2 Deck.gl

**접근**: 프로그래밍 기반. JS/TS 클래스로 레이어 정의. 풀 셰이더 접근.

| 강점 | 약점 |
|---|---|
| 완전한 셰이더 커스터마이징 | 직렬화 불가 → 스타일 공유/도구화 어려움 |
| 셰이더 훅으로 파이프라인 단계별 코드 주입 | 커스텀 레이어 작성 시 학습 곡선 높음 |
| 바이너리/컬럼 데이터 제로카피 업로드 | 베이스맵과 인터리빙 제한 |
| 인스턴스드 렌더링으로 대규모 데이터 처리 | 라벨 충돌 감지 미지원 |

**핵심 교훈**: 셰이더 훅 시스템 (`DECKGL_FILTER_SIZE`, `DECKGL_FILTER_COLOR` 등) — 파이프라인 특정 단계에 코드를 주입하는 패턴.

### 2.3 Tangram (Mapzen)

**접근**: YAML 씬 파일 + **인라인 GLSL 셰이더 블록**.

| 강점 | 약점 |
|---|---|
| 선언적 스타일 + 인라인 GLSL 공존 | 프로젝트 사실상 중단 (2018~) |
| 셰이더 블록 (position/normal/color/filter) | 기본 레이어 타입 5개뿐 |
| 재사용 가능한 셰이더 라이브러리 | 데이터 기반 스타일링 표현식 미약 |
| YAML의 문자열 처리로 GLSL 작성 편리 | 복잡한 셰이더에서 성능 저하 |

**핵심 교훈**: **파이프라인 단계별 셰이더 블록 주입** — position, normal, color, filter 단계에 GLSL을 삽입하는 모델이 가장 접근성 높은 셰이더 통합 방식.

### 2.4 Cesium 3D Tiles Styling

**접근**: JSON + JS 서브셋 표현식. `${propertyName}` 구문.

| 강점 | 약점 |
|---|---|
| JS 서브셋이 Mapbox의 Lisp 배열보다 직관적 | show/color만 지원 (선 두께, 패턴, 텍스트 없음) |
| conditions 배열이 if/else 체인으로 깔끔 | CPU per-feature 평가 → 대규모 데이터에서 느림 |
| CustomShader API로 풀 GPU 접근 | 선언적 스타일과 CustomShader 동시 사용 불가 |

### 2.5 OpenLayers

**접근**: 완전 프로그래밍 기반. JS 스타일 함수.

| 강점 | 약점 |
|---|---|
| 최대 유연성 (어떤 JS 로직도 가능) | 스타일 함수가 매 프레임 매 피처 CPU 실행 |
| 애플리케이션 상태 접근 가능 | Canvas 2D: ~5K 피처 한계 |
| 커스텀 렌더러 함수 | WebGL 경로에서 텍스트 미지원 |

---

## 3. GPU Shader DSL Landscape

### 3.1 컴파일 전략 스펙트럼

```
런타임 컴파일          오프라인→IR→런타임        단일소스→멀티타깃         고수준 DSL→커널        메타프로그래밍
GLSL/WGSL              HLSL→DXIL               Slang                    Halide, Futhark        Terra, Zig comptime
│                      GLSL→SPIR-V             →SPIR-V/DXIL/GLSL/      (알고리즘/스케줄 분리)  (2-언어 모델)
│                                               WGSL/MSL
최대 유연성             균형                     최대 이식성               최대 추상화            최대 코드젠 유연성
최악 에러 경험          양호한 에러              단일 소스 진실            최소 제어              생태계 비용
```

### 3.2 핵심 인사이트

| 기술 | 핵심 교훈 |
|---|---|
| **WGSL** | 미니멀, 모듈 시스템 없음 → WESL이 커뮤니티에서 확장. 우리도 WGSL 위에 빌드 필요. |
| **CUDA** | C/C++ 확장으로 기존 개발자 전환 비용 최소화. `<<<grid, block>>>` 구문으로 GPU 실행 모델 노출. |
| **Slang** | 현재 셰이더 언어 최신 기술. 제네릭, 인터페이스, **자동 미분**. HLSL 슈퍼셋 → 점진적 도입. |
| **Halide** | **알고리즘/스케줄 분리** — "무엇"과 "어떻게"를 분리하는 황금 표준. |
| **Futhark** | 순수 함수형 + GPU 성능 양립 가능. **유니크니스 타입**으로 안전한 인플레이스 변경. |
| **JSX/TSX** | 구문 확장이 완전히 컴파일되어 사라짐. **jsxPragma 커스터마이징** → 같은 구문, 다른 런타임. |
| **Svelte** | 정적 분석으로 런타임 오버헤드 제거. 단일 파일에 여러 관심사 결합 후 컴파일. |
| **Zig comptime** | 하나의 언어, 두 실행 단계. 매크로/템플릿/코드젠 대체. |
| **Terra** | 메타 언어(Lua) + 퍼포먼스 언어(Terra) 2층 구조. GPU 커널을 프로그래밍적으로 생성. |

---

## 4. Design Principles (설계 원칙)

리서치를 종합하여 도출한 X-GIS 언어의 설계 원칙:

### P1. 알고리즘/스케줄 분리 (Halide에서)

개발자는 **"무엇을"** 그릴지 정의하고, 엔진이 **"어떻게"** GPU에서 실행할지 결정한다.
개발자가 워크그룹 크기, 버퍼 바인딩, 디스패치 호출을 알 필요 없다.

### P2. 파이프라인 단계별 개입 (Tangram + Deck.gl에서)

고정된 렌더링 파이프라인의 특정 단계에 코드를 주입할 수 있다:
- **data**: 데이터 접근 및 변환
- **geometry**: 좌표 변환, 버텍스 조작
- **style**: 색상, 크기, 패턴 결정
- **composite**: 최종 합성, 블렌딩

### P3. 선언적 + 프로그래밍 하이브리드 (Mapbox 표현식의 한계 극복)

선언적 스타일링(Mapbox의 장점)과 프로그래밍적 유연성(Deck.gl의 장점)을 하나의 언어에서 제공.
단순한 스타일은 선언적으로, 복잡한 로직은 함수로.

### P4. 직렬화 가능 (Mapbox의 장점 유지)

언어의 AST/IR은 직렬화 가능해야 한다 → 도구(에디터, 미리보기), 서버 사이드 렌더링, 스타일 공유 가능.

### P5. 컴파일 타임 최적화 (Svelte + Zig에서)

정적 분석으로 최대한 많은 것을 컴파일 타임에 결정:
- 사용되지 않는 속성 제거
- 상수 폴딩
- 셰이더 변형(variant) 자동 생성
- 타입 안전한 데이터 바인딩

### P6. 데이터 포인터 모델 (보안 + 성능)

개발자는 데이터의 **구조**와 **해석 방법**만 정의한다.
실제 데이터는 포인터/버퍼 참조로 전달되며, 셰이더 수준에서 직접 접근한다.
→ 군사/보안 데이터: 데이터가 언어를 통과하지 않고 GPU로 직행.

### P7. 점진적 복잡성 (Progressive Disclosure)

```
Level 1: 선언적 스타일만 (CSS처럼) → 누구나 사용
Level 2: 데이터 표현식 (Mapbox 표현식 수준) → 데이터 분석가
Level 3: 커스텀 함수 + 파이프라인 개입 → GIS 개발자
Level 4: 로우레벨 셰이더 블록 → GPU 프로그래머
```

### P8. 멀티 타깃 컴파일 (Slang에서)

하나의 소스에서:
- **WebGPU (WGSL)** → 웹 브라우저
- **Vulkan (SPIR-V)** → 네이티브 Linux/Windows/Android
- **Metal (MSL)** → macOS/iOS
- **HLSL** → Windows 네이티브

---

## 5. Language Architecture (v3 — 선언적 공간-시각 언어)

### 5.0 근본 철학: GPU가 보이지 않는 언어

```
SQL은 B-tree를 모른다. 쿼리를 선언하면 옵티마이저가 실행 계획을 세운다.
React는 DOM을 모른다. 상태를 선언하면 프레임워크가 렌더링을 결정한다.
X-GIS는 GPU를 모른다. 데이터와 시각 관계를 선언하면 컴파일러가 GPU 실행을 결정한다.
```

**개발자가 작성하는 것**: 데이터가 무엇이고, 어떻게 보여야 하는가
**컴파일러가 결정하는 것**: 버퍼, 파이프라인, 렌더 패스, 인스턴싱, 배칭 — 모든 GPU 결정

```
이전 설계:
  .xgis/.xgs/.xgl → [컴파일러] → WGSL + 호스트 코드 → [별도 엔진/런타임] → GPU
                                                        ↑ TypeScript/Rust로 작성

현재 설계:
  .xgis/.xgs/.xgl → [컴파일러] → 실행 가능한 바이너리/WASM → GPU
                                  ↑ 엔진이 X-GIS 표준 라이브러리로 구현됨

비유:
  C     = 언어. libc = 표준 라이브러리. OS syscall 위에 libc가 구축됨.
  Zig   = 언어. std  = 표준 라이브러리. OS 위에 std가 구축됨.
  X-GIS = 언어. @xgis/core = 표준 라이브러리. WebGPU API 위에 @xgis/core가 구축됨.

  libc의 printf()가 C로 구현되듯,
  @xgis/core의 circle()이 X-GIS로 구현된다.
```

**핵심**: `fill-red-500`, `circle()`, `extrude()`, `hillshade` 등 모든 렌더링 프리미티브가
**X-GIS 언어 자체로 구현**됨. 개발자는 이것들을 열어보고 수정하거나 대체할 수 있음.

### 5.0.1 언어의 3가지 축 — 공간, 시간, 시각

```
X-GIS의 모든 것은 이 3가지 축의 조합이다:

축 (Axis)       의미                    예시
─────────      ──────────────         ──────────────────
공간 (Spatial)  어디에, 어떤 범위에      position, within 5km, along route
시간 (Temporal) 언제, 어떤 기간에        now, over last 30min, at 2026-01-01
시각 (Visual)   어떻게 보이는가          fill-red, size-8, symbol-arrow

모든 선언은 이 축들의 조합:
  "이 데이터를(공간) 이 시점에(시간) 이렇게 보여라(시각)"
```

### 5.0.2 공간 (Spatial) — 일급 공간 타입

```
// ═══ 공간은 좌표가 아니라 "관계"이다 ═══

// 좌표는 단순한 숫자가 아니라 공간적 의미를 가진 타입
type Position = geodetic              // 위경도 — 언어가 CRS, 투영, 정밀도를 관리
type Region = polygon                 // 영역
type Path = polyline                  // 경로
type Field = grid2d<f32>              // 연속 필드 (수심, 고도, 밀도 등)

// 공간 관계는 언어의 키워드
ships within 5km of my_position       // 반경 검색
ships inside operation_area            // 영역 포함
ships along patrol_route within 1km   // 경로 근접
depth at ship.position                 // 필드 샘플링
gradient of bathymetry at position     // 필드 미분

// 공간 연산도 키워드
buffer(route, 500m)                   // 버퍼
intersection(zone_a, zone_b)          // 교집합
nearest(hospitals, from: my_position)  // 최근접
contour(bathymetry, levels: [10, 50, 100])  // 등치선
```

### 5.0.3 시간 (Temporal) — 모든 데이터는 시간 축을 갖는다

```
// ═══ 데이터는 "현재 값"이 아니라 "시간에 따른 흐름"이다 ═══

// 스트림 데이터: 자동으로 시간 축 보유
ships from stream("ais_feed") keyed by mmsi

// 시간 참조
ships.position                        // 현재 값
ships.position at 30min ago           // 30분 전 값
ships.position over last 2h           // 최근 2시간 궤적 (배열)
ships.position after 10min            // 10분 후 예측 (외삽)

// 시간 파생
ships.speed = derivative(ships.position)        // 위치의 시간 미분 = 속도
ships.acceleration = derivative(ships.speed)    // 속도의 시간 미분 = 가속도
ships.heading_rate = derivative(ships.heading)  // 선수 변화율

// 시간 필터
ships where last_seen within 5min     // 5분 내 업데이트된 것만
ships where speed increasing for 3min // 3분간 속도 증가 중인 것

// 시간 집계
max(ships.speed) over last 1h         // 최근 1시간 최대 속도
avg(temperature) over last 24h        // 24시간 평균 기온
```

### 5.0.4 시각 (Visual) — 데이터에서 렌더링으로의 순수 매핑

```
// ═══ "보여라"만 선언한다. "어떻게 GPU에서 그릴지"는 컴파일러 몫. ═══

// 가장 단순한 형태
show ships as circle sized 8 colored red

// 데이터 매핑
show ships as arrow
  sized by speed / 50 clamped 4 to 24
  colored by classification using palette military
  rotated by heading
  labeled by name
  when zoom >= 10

// 조건부
show ships as arrow
  colored green when friendly
  colored red when hostile
  colored gray otherwise

// 줌 반응
show ships
  as dot sized 4 when zoom < 10
  as arrow sized 8 when zoom 10 to 14
  as detailed_symbol sized 16 when zoom >= 14

// 시간 시각화
show ships.position over last 30min as trail
  fading from opaque to transparent
  colored by speed using ramp viridis

// 공간 시각화
show bathymetry as surface
  colored by depth using ramp ocean
  extruded by depth * -1
  shaded by terrain_lighting

// 관계 시각화
show links between ships as line
  weighted by signal_strength
  colored green when active
  colored red when lost
  dashed when degraded
```

### 5.0.5 탈출구 — 선언적으로 불가능할 때

```
95%는 선언적으로 해결된다. 나머지 5%를 위한 탈출구:

// ── @fragment: 픽셀 수준 커스텀 ──
// 가우시안 커널, SDF 효과, 절차적 텍스처 등
show heatmap_data as point sized 20 blended additive {
  @fragment {
    let d = length(uv - 0.5) * 2.0
    color = rgba(exp(-d * d * 4.0) * weight, 0, 0, 0.5)
  }
}

// ── @compute: GPU 병렬 연산 ──
// 이미 simulation과 analysis가 대부분 커버하지만,
// 완전히 새로운 알고리즘이 필요할 때
compute custom_algo(data: [MyData]) {
  let item = data[thread_id]
  // ... 커스텀 GPU 연산
}

// 탈출구는 명시적이다 (Rust의 unsafe처럼).
// "이 블록은 내가 직접 GPU를 제어한다"는 선언.
// 컴파일러의 자동 최적화가 이 블록에서는 적용되지 않을 수 있음.
```

### 5.0.6 SQL과의 비교 — X-GIS의 위치

```
SQL:
  SELECT name, population FROM cities WHERE population > 1000000 ORDER BY population DESC
  → 개발자는 "무엇을" 선언, 옵티마이저가 인덱스/조인/스캔 전략을 결정

X-GIS:
  show cities as circle sized by population colored by density labeled by name when zoom >= 8
  → 개발자는 "무엇을 어떻게 보여줄지" 선언, 컴파일러가 GPU 전략을 결정

  SQL의 EXPLAIN PLAN ↔ X-GIS의 성능 프로파일러
  SQL의 CREATE INDEX ↔ X-GIS의 @strategy 힌트 (필요 시)
  SQL의 stored procedure ↔ X-GIS의 @fragment/@compute (탈출구)
```

### 5.0.7 아키텍처 레이어

```
┌──────────────────────────────────────────────────────┐
│  개발자 코드 (.xgis / .xgs / .xgl)                    │
│  show ... as ... colored by ... when ...              │
│  find ... where ... within ... along ...              │
│  ← 공간-시간-시각 선언. GPU를 모른다.                   │
├──────────────────────────────────────────────────────┤
│  컴파일러 (옵티마이저)                                  │
│  데이터 흐름 분석, 렌더 그래프 구성, GPU 전략 결정        │
│  인스턴싱/배칭/렌더번들 자동 결정                        │
│  ← SQL 옵티마이저와 동일한 역할                         │
├──────────────────────────────────────────────────────┤
│  @xgis/core 표준 라이브러리                             │
│  컴파일러가 생성한 실행 계획을 GPU에서 실행               │
│  ← 개발자에게 투명. 필요 시 @fragment/@compute로 개입    │
├──────────────────────────────────────────────────────┤
│  WebGPU / Vulkan / Metal                              │
│  ← 완전히 투명. 언어에 존재하지 않음.                    │
└──────────────────────────────────────────────────────┘
```

SVG가 `<path d="M 0 -1 L -0.4 0.3 Z"/>` 로 형상을 설명하듯,
X-GIS도 형상과 스타일을 선언적으로 설명하고, 코드는 최후의 수단으로만 사용한다.

### 5.1 파일 구조

```
scene.xgis    — 씬 정의: 소스, 레이어, 구조, validate, query (HTML 역할)
*.xgs         — 스타일 + 형상 정의: symbol, preset, effect, line_pattern, theme (CSS + SVG 역할)
*.xgl         — 로직: fn, trait, impl, enum, struct, state_machine, constexpr (JS 역할)
```

### 5.2 scene.xgis — 씬 구조

```
source terrain_dem {
  type: raster-dem
  url: "https://tiles.example.com/terrain/{z}/{x}/{y}.png"
  encoding: mapbox
}

source buildings {
  type: vector
  url: "https://tiles.example.com/buildings/{z}/{x}/{y}.pbf"
}

source military_tracks {
  type: binary
  pointer: external
  schema: MilTrack            // 별도 정의된 struct 참조
}

// ── 레이어: 스타일을 인라인으로 (Tailwind처럼) ──

layer base_terrain {
  source: terrain_dem
  z-order: 0
  | hillshade  illumination-315  exaggeration-1.5
  | shadow-slate-900  highlight-gray-100
}

layer building_footprints {
  source: buildings
  source-layer: "buildings"
  filter: type == "commercial" and height > 10
  z-order: 10
  | extrude-[height]
  | residential:fill-blue-400  commercial:fill-red-400  fill-gray-300
  | z12:opacity-60  z16:opacity-90
  | lighting-default
}

layer tracks {
  source: military_tracks
  z-order: 100
  | symbol-arrow  size-[speed/50|clamp:4,24]  rotate-[heading]
  | friendly:fill-green-500  hostile:fill-red-500  fill-gray-400
  | stroke-black  stroke-1
  | z8:opacity-40  z14:opacity-100
  | hover:glow-8  selected:stroke-yellow-400  selected:stroke-3
  | transition-fill-300  transition-size-200
}

// ── 스타일 추출: 반복 패턴을 재사용 (Tailwind @apply처럼) ──

preset alert_track {
  | symbol-arrow  fill-red-500  glow-8
  | animate-pulse-1s
}

layer emergency_tracks {
  source: emergency_feed
  z-order: 200
  | apply-alert_track                  // preset 적용
  | size-[speed/30|clamp:8,32]         // 오버라이드 가능
  | rotate-[heading]
}
```

### 5.3 Utility-First Styling (Tailwind 모델)

#### 왜 Tailwind 모델인가

기존 CSS 모델 (별도 style 블록에서 정의):
- 레이어와 스타일이 분리됨 → 컨텍스트 스위칭
- 스타일 이름 짓기에 시간 소모
- 사용되지 않는 스타일 누적 (dead code)
- 조건 분기가 verbose (`match`, `interpolate` 블록)

Tailwind 모델 (인라인 유틸리티 조합):
- **사용하는 곳에서 직접 스타일링** → 컨텍스트 스위칭 없음
- **작은 유틸리티를 조합** → 이름 짓기 불필요
- **모디파이어로 조건 분기** → 한 줄에 조건+값
- **디자인 토큰으로 일관성** → 미리 정의된 스케일
- **preset으로 추출** → 반복 패턴만 이름 부여 (Tailwind @apply)

#### 유틸리티 문법

레이어 블록 안에서 `|` 접두사로 스타일 유틸리티를 나열:

```
layer tracks {
  source: military_tracks
  z-order: 100

  // 각 줄이 독립적인 유틸리티 조합
  | symbol-arrow  size-[speed/50|clamp:4,24]  rotate-[heading]
  | friendly:fill-green-500  hostile:fill-red-500  fill-gray-400
  | stroke-black  stroke-1
  | z8:opacity-40  z14:opacity-100
  | hover:glow-8  selected:stroke-yellow-400
  | transition-fill-300ms  transition-size-200ms
}
```

#### 모디파이어 시스템

**Tailwind의 `hover:`, `md:` 처럼 접두사로 조건을 표현:**

```
// ── 줌 모디파이어 (Tailwind의 반응형 브레이크포인트에 대응) ──
z8:opacity-40              // 줌 8에서 opacity 40%
z14:opacity-100            // 줌 14에서 opacity 100%
z8:size-4 z14:size-12      // 줌에 따라 크기 변화
                           // → 컴파일러가 자동으로 중간 줌은 보간

// ── 데이터 모디파이어 (Tailwind의 상태 변형에 대응) ──
// 필드명:값 또는 필드명 조건
friendly:fill-green-500    // classification == "friendly" 일 때
hostile:fill-red-500       // classification == "hostile" 일 때
fill-gray-400              // 기본값 (매칭 안 될 때)

// 조건식도 가능
[speed>500]:fill-red-600   // speed > 500 일 때
[altitude<100]:glow-16     // altitude < 100 일 때

// ── 인터랙션 모디파이어 ──
hover:glow-8               // 마우스 호버 시
hover:size-[*1.2]          // 호버 시 1.2배 확대
selected:stroke-yellow-400 // 선택된 피처
selected:stroke-3

// ── 테마 모디파이어 ──
dark:fill-blue-300         // 다크 테마
light:fill-blue-600        // 라이트 테마

// ── 복합 모디파이어 (Tailwind처럼 체이닝) ──
z14:hover:fill-red-300     // 줌 14 이상이고 호버 중일 때
hostile:selected:glow-16   // 적대 + 선택 상태일 때
```

#### 디자인 토큰

**일관된 스케일 (Tailwind의 `colors`, `spacing` 처럼):**

```
// ── 색상 팔레트 (커스터마이즈 가능) ──
fill-red-50 ~ fill-red-950          // 채우기 색상
stroke-blue-500                      // 테두리 색상
glow-yellow-300                      // 글로우 색상

// ── 크기 스케일 ──
size-1 size-2 size-4 size-8 size-16  // 미리 정의된 크기 (px)
size-[14]                            // 임의값 탈출구
size-[speed/50]                      // 데이터 바인딩 탈출구

// ── 불투명도 ──
opacity-0 opacity-20 opacity-40 ... opacity-100

// ── 스트로크 두께 ──
stroke-0 stroke-1 stroke-2 stroke-4

// ── 그림자/글로우 ──
glow-0 glow-4 glow-8 glow-16
shadow-sm shadow-md shadow-lg

// ── 전환 ──
transition-fill-150ms transition-fill-300ms
transition-size-200ms
transition-all-300ms

// ── 애니메이션 ──
animate-pulse-1s animate-spin-2s animate-bounce-500ms

// ── 블렌드 ──
blend-normal blend-additive blend-multiply
```

#### 데이터 바인딩 — `[expression]` 탈출구

**Tailwind의 `w-[137px]` 임의값처럼, `[expression]` 으로 데이터 바인딩:**

```
// 데이터 필드 직접 참조
size-[speed]                  // speed 필드의 값을 크기로
rotate-[heading]              // heading 필드의 값을 회전으로
fill-[color_field]            // 데이터의 색상 필드 직접 사용

// 표현식 (파이프 문법)
size-[speed/50|clamp:4,24]    // speed/50을 4~24로 클램프
fill-[altitude|ramp:viridis]  // altitude를 viridis 색상 램프로 매핑
opacity-[confidence|step:0.5:0,1]  // 0.5 기준 스텝 함수

// 상대값 (Tailwind의 calc처럼)
hover:size-[*1.2]             // 현재 크기의 1.2배
selected:stroke-[+2]         // 현재 두께 +2
```

#### Symbol 정의 (SVG 설명, 코드 아님)

```
// *.xgs 파일에서 형상을 설명적으로 정의

symbol arrow {
  path "M 0 -1 L -0.4 0.3 L 0.4 0.3 Z"
  rect x: -0.15  y: 0.3  w: 0.3  h: 0.5
  anchor: center
}

symbol nato_friendly {
  rect x: -1  y: -0.7  w: 2  h: 1.4
  circle cx: 0  cy: 0  r: 0.3
  anchor: center
}

// 외부 SVG 임포트
symbol helicopter {
  svg: "./assets/helicopter.svg"
}

// 파라미터화
symbol threat(level: u8) {
  circle cx: 0  cy: 0  r: 1
  if level >= 2 { path "M -0.5 -0.5 L 0.5 0.5 M -0.5 0.5 L 0.5 -0.5" }
  if level >= 3 { circle cx: 0  cy: 0  r: 1.3  fill: none  stroke-w: 0.1 }
}
```

**레이어에서 사용:**
```
layer tracks {
  source: military_tracks
  | symbol-arrow  size-8  rotate-[heading]  fill-green-500
}
```

#### Preset 추출 (Tailwind @apply)

**반복되는 유틸리티 조합을 이름 붙여 재사용:**

```
// 자주 쓰는 조합을 preset으로 추출
preset military_track {
  | symbol-arrow  stroke-black  stroke-1
  | friendly:fill-green-500  hostile:fill-red-500  fill-gray-400
  | z8:opacity-40  z14:opacity-100
  | hover:glow-8
  | transition-fill-300ms
}

preset alert_effect {
  | glow-8  animate-pulse-1s
  | fill-red-500  stroke-red-300  stroke-2
}

// 사용
layer tracks {
  source: military_tracks
  | apply-military_track                       // preset 적용
  | size-[speed/50|clamp:4,24]  rotate-[heading]  // 추가 유틸리티
}

layer emergency {
  source: emergency_feed
  | apply-military_track  apply-alert_effect   // 여러 preset 합성
  | size-[speed/30|clamp:8,32]                 // 오버라이드
}
```

#### 구조/지오메트리 유틸리티

**3D 돌출, 라인 장식 등도 유틸리티로:**

```
layer buildings {
  source: buildings
  | extrude-[height]  extrude-base-0          // 3D 돌출
  | fill-blue-400  lighting-default
  | z12:opacity-60  z16:opacity-90
}

layer routes {
  source: route_data
  | line-w-4  stroke-blue-500
  | dash-10-5  cap-round  join-round           // SVG 대시 패턴
  | decorate-arrow-100px                       // 100px 간격 화살표 장식
  | direction-gradient-blue-500-orange-500      // 방향 그라디언트
}
```

#### 포맷팅 파이프 — `|` 연산자

데이터 **변환**과 **표시 포맷팅**을 파이프로 체이닝:

```
// ══ 좌표 변환 파이프 ══

// WGS84 → 군사좌표계
text: "{position | mgrs}"                       // → "52S DG 43010 59100"
text: "{position | mgrs:precision=10}"           // → "52S DG 4301 5910" (10m 정밀도)
text: "{position | utm}"                         // → "52N 430102 5591003"
text: "{position | georef}"                      // → "VHCG 0152"

// WGS84 → 도분초 (DMS)
text: "{position.lat | dms}"                     // → 37°30'00.0"N
text: "{position.lon | dms}"                     // → 127°00'00.0"E
text: "{position.lat | dms:precision=2}"         // → 37°30'00.00"N
text: "{position.lat | dm}"                      // → 37°30.000'N  (도분)
text: "{position.lat | dd:precision=6}"          // → 37.500000°   (십진도)

// 좌표계 간 변환 (표시가 아니라 실제 변환)
let utm_coord = position | to_utm               // UTM 좌표 객체 반환
let mgrs_str = position | to_mgrs               // MGRS 문자열 반환
let pos = mgrs_string | from_mgrs               // MGRS → WGS84 역변환


// ══ 수치 포맷팅 파이프 ══

text: "{speed | round}"                          // → 15
text: "{speed | format:'0.0'}"                   // → 14.7
text: "{speed | round | pad:3}"                  // → "015"
text: "{distance | km | format:'0.0'}"           // → "11.2" (m→km 변환 + 포맷)
text: "{distance | nm | format:'0.0'}"           // → "6.0"  (m→해리)
text: "{altitude | ft}"                          // → 3281 (m→피트)
text: "{heading | round}°"                       // → "247°"
text: "{heading | compass}"                      // → "WSW"
text: "{heading | compass:16}"                   // → "WSW" (16방위)
text: "{heading | compass:32}"                   // → "WbS" (32방위)
text: "{heading | mils}"                         // → "4389" (NATO 밀)


// ══ 시간/날짜 파이프 ══

text: "{timestamp | datetime}"                   // → "2026-04-09 14:30:00"
text: "{timestamp | datetime:'HH:mm:ss'}"        // → "14:30:00"
text: "{timestamp | zulu}"                        // → "09 1430Z APR 2026"  (DTG)
text: "{timestamp | elapsed}"                     // → "2h 15m ago"
text: "{timestamp | julian}"                      // → "099"  (율리우스 일)


// ══ 군사 특화 파이프 ══

text: "{sidc | mil_symbol_name}"                 // → "Hostile Surface Combatant"
text: "{frequency | mhz | format:'0.000'}"       // → "243.000"
text: "{bearing | relative:ship.heading}"        // → "R045" (상대방위)
text: "{bearing | true}°T"                       // → "247°T" (진방위)
text: "{bearing | magnetic:declination}°M"       // → "239°M" (자북방위)
text: "{range | nm | format:'0.0'} NM"           // → "12.5 NM"


// ══ 색상 변환 파이프 ══

fill-[altitude | ramp:viridis]                   // 고도 → 색상 램프
fill-[speed | ramp:hot:0,100]                    // 0~100 범위로 정규화 후 hot 램프
fill-[temperature | ramp:coolwarm:-20,40]        // -20~40°C 범위
fill-[density | quantile:5:reds]                 // 5분위 분류 → Reds 팔레트


// ══ 파이프 체이닝 ══
// 왼쪽에서 오른쪽으로 순차 적용

text: "{distance | nm | format:'0.0' | pad:6}"
//      12500m  → 6.7nm → "6.7"    → "   6.7"

size-[population | log10 | clamp:1,5 | scale:4]
//     1000000  → 6.0   → 5.0      → 20.0 px

fill-[depth | abs | clamp:0,200 | ramp:blues]
//    -150   → 150 → 150         → 진한 파란색


// ══ 파이프 컨텍스트: 스타일 vs 텍스트 ══

// 텍스트 보간 내 파이프 → 문자열 포맷팅 (표시용)
text: "{position | mgrs}"                        // → 문자열

// 유틸리티 대괄호 내 파이프 → 값 변환 (렌더링용, GPU에서 실행)
| size-[speed | clamp:0,100 | scale:0.2]         // → f32 값
| fill-[altitude | ramp:terrain]                  // → rgba 값
```

**텍스트 보간 파이프** (`"{x | fmt}"`)는 CPU에서 실행 (문자열 생성).
**유틸리티 파이프** (`[x | transform]`)는 GPU에서 실행 (숫자/색상 변환).
컴파일러가 컨텍스트에 따라 자동 구분.

#### 커스텀 파이프 정의

```
// 사용자 정의 포맷 파이프 (@host = CPU에서 실행)
@host pipe dtg(t: timestamp) -> string {
  // DTG (Date-Time Group) 군사 포맷
  let d = to_datetime(t)
  return format("{} {}{}Z {} {}",
    d.day | pad:2, d.hour | pad:2, d.minute | pad:2,
    d.month | uppercase | slice:0,3, d.year)
}

// GPU에서 실행되는 변환 파이프
pipe threat_color(level: f32) -> rgba {
  return match {
    level < 0.3 => rgba(0, 200, 0, 255)
    level < 0.7 => rgba(255, 200, 0, 255)
    _           => rgba(255, 0, 0, 255)
  }
}

// 사용
text: "{event_time | dtg}"                       // → "09 1430Z APR 2026"
| fill-[threat_score | threat_color]             // GPU에서 색상 결정
```

#### 셰이더 탈출구 (@fragment, @vertex, @compute)

**유틸리티로 표현 불가능한 것만 코드 블록으로:**

```
// 히트맵 — 가우시안 커널은 유틸리티로 표현 불가
layer heatmap {
  source: events
  | size-20  blend-additive

  @fragment {
    let d = length(uv - 0.5) * 2.0
    let kernel = exp(-d * d * 4.0)
    color = rgba(kernel * weight, 0, 0, kernel * 0.5)
  }
}

// 플로우 필드 — 물리 시뮬레이션은 코드 필요
layer wind_particles {
  source: particles

  @compute(particles: [Particle], wind: grid2d<vec2>) {
    let p = particles[global_id.x]
    p.velocity = lerp(p.velocity, sample(wind, p.position), 0.1)
    p.position += p.velocity * delta_time
    particles[global_id.x] = p
  }

  | point-2  blend-additive
  | fill-[velocity|magnitude|ramp:plasma]
  | opacity-[velocity|magnitude|clamp:0.1,0.8]
}
```

#### 전체 비교 — Before vs After

```
// ═══ BEFORE: 기존 CSS 스타일 블록 모델 ═══

style track_style {
  symbol: arrow
  size: speed / 50 clamp(4, 24)
  rotate: heading
  fill: match classification {           // 6줄짜리 매치 블록
    0 => #00ff00
    1 => #ff0000
    2 => #ffff00
    _ => #808080
  }
  stroke: #000000
  stroke-width: 1
  opacity: interpolate zoom {            // 4줄짜리 보간 블록
    8  => 0.4
    12 => 0.8
    16 => 1.0
  }
  transition {
    fill: 300ms ease-out
    size: 200ms linear
  }
}

layer tracks {
  source: military_tracks
  style: track_style         // 이름으로 참조
  z-order: 100
}


// ═══ AFTER: Tailwind 유틸리티 모델 ═══

layer tracks {
  source: military_tracks
  z-order: 100
  | symbol-arrow  size-[speed/50|clamp:4,24]  rotate-[heading]
  | friendly:fill-green-500  hostile:fill-red-500  unknown:fill-yellow-500  fill-gray-400
  | stroke-black  stroke-1
  | z8:opacity-40  z12:opacity-80  z16:opacity-100
  | transition-fill-300ms-ease-out  transition-size-200ms
}

// 17줄 + 7줄 → 8줄. 컨텍스트 스위칭 제로.
```


### 5.3.1 Rendering Primitives — 채움, 선, 점, 그라디언트, 패턴 상세 사양

현재 `fill-red-500`은 단색 채움의 단축 문법일 뿐이다.
실제 렌더링에는 해치 패턴, 그라디언트, 커스텀 심볼, 라인 캡/조인 등
**그래픽 프리미티브의 전체 사양**이 필요하다.

#### Fill (채움) — 7가지 모드

```
// ═══ 1. 단색 (Solid) ═══
| fill-red-500                               // 디자인 토큰
| fill-#3388ff                               // hex
| fill-[property(color)]                     // 데이터 바인딩

// ═══ 2. 선형 그라디언트 (Linear Gradient) ═══
| fill-linear(0deg, red-500, blue-500)                    // 2색, 각도
| fill-linear(45deg, red-500, yellow-500, blue-500)       // 3색
| fill-linear(90deg, #ff0000 0%, #00ff00 50%, #0000ff 100%)  // 정지점 명시

// 동적 정지점 (데이터 기반)
| fill-linear(0deg, [gradient_stops])
// gradient_stops: [{ color: rgba, position: f32 }]
// 호스트에서 주입: map.set('gradient_stops', [...])

// ═══ 3. 방사형 그라디언트 (Radial Gradient) ═══
| fill-radial(center, red-500, blue-500)                  // 중심→외곽
| fill-radial(center, #ff0000 0%, transparent 100%)       // 페이드 아웃
| fill-radial(offset(0.3, 0.3), white 0%, blue-900 100%) // 오프셋 중심

// ═══ 4. 경로형 그라디언트 (Path Gradient) ═══
// 라인/폴리곤의 경로를 따라 색상 변화
| fill-path-gradient(red-500 0%, yellow-500 50%, green-500 100%)
// → 라인의 시작(0%) → 중간(50%) → 끝(100%) 에 따라 색 변화

// 데이터 기반 (속도에 따른 경로 색상)
| fill-path-gradient([speed | ramp:rdylgn])   // 경로 위치별 속도 → 색상

// ═══ 5. 해치 패턴 (Hatch Pattern) ═══
| fill-hatch(
    angle: 45deg                              // 해치 각도
    spacing: 8px                              // 해치 간격
    stroke: black                             // 해치 선 색상
    stroke-w: 1                               // 해치 선 두께
  )
| fill-hatch(angle: 0deg, spacing: 6, stroke: red-500, stroke-w: 2)   // 수평 해치
| fill-hatch(angle: 90deg, spacing: 6, stroke: red-500, stroke-w: 2)  // 수직 해치

// 크로스 해치 (교차)
| fill-crosshatch(
    spacing: 8px
    stroke: gray-600
    stroke-w: 1
    angle1: 45deg                             // 첫 번째 방향
    angle2: -45deg                            // 두 번째 방향
  )

// ═══ 6. SVG 패턴 (Pattern Fill) ═══
| fill-pattern(
    src: "./patterns/waves.svg"               // 패턴 SVG 파일
    scale: 1.0
    repeat: both                              // both | x | y | none
  )

// 내장 패턴 프리셋
| fill-pattern-dots(spacing: 10, radius: 2, color: gray-400)
| fill-pattern-grid(spacing: 20, stroke: gray-300, stroke-w: 1)
| fill-pattern-diagonal(spacing: 8, stroke: blue-400, stroke-w: 1)

// ═══ 7. 배경 없음 ═══
| fill-none                                   // 채움 없음 (윤곽만)

// ═══ 복합: 채움 + 패턴 오버레이 ═══
| fill-blue-200  fill-overlay-hatch(angle: 45deg, stroke: blue-600, spacing: 10)
// → 파란 배경 위에 해치 패턴 오버레이
```

#### Gradient Stops — 동적 정지점

```
// ── 정적 정지점 (컴파일 타임 확정) ──
| fill-linear(90deg, #001a33 0%, #0066cc 30%, #66ccff 70%, white 100%)

// ── 데이터 기반 정지점 (개수가 동적) ──

// X-GIS에서 선언
input gradient_config: GradientConfig

struct GradientStop {
  color: rgba
  position: f32          // 0.0 ~ 1.0
}

struct GradientConfig {
  angle: f32
  stops: [GradientStop]  // 동적 배열 — 개수를 런타임에 결정
}

// 유틸리티에서 참조
| fill-linear-dynamic(gradient_config)

// 호스트에서 주입
// map.set('gradient_config', {
//   angle: 90,
//   stops: [
//     { color: [0,0,0.5,1], position: 0.0 },
//     { color: [0,0.4,0.8,1], position: 0.3 },
//     { color: [0.4,0.8,1,1], position: 0.7 },
//     { color: [1,1,1,1], position: 1.0 },
//   ]
// })

// 컴파일러 처리:
//   정지점 배열 → Data Texture (1D) 로 패킹
//   @fragment에서 texture sample로 보간
//   → 정지점 개수에 관계없이 GPU에서 효율적 렌더링
```

#### Stroke (선) — 속성 전체

```
// ═══ 기본 속성 ═══
| stroke-blue-500                  // 선 색상
| stroke-w-2                       // 선 두께 (px)
| stroke-w-[width_field]           // 데이터 바인딩
| stroke-opacity-80                // 선 불투명도

// ═══ 대시 패턴 ═══
| stroke-dash-10-5                 // SVG dasharray: 10px 선, 5px 공백
| stroke-dash-10-5-3-5             // 복합 대시: 10선, 5공, 3선, 5공
| stroke-dash-none                 // 실선 (기본)

// 대시 오프셋 (애니메이션 가능)
| stroke-dash-offset-0             // 정적
| stroke-dash-offset-[time*50]     // 시간에 따라 흐르는 대시 (데이터 흐름 표현)

// ═══ 라인 캡 (Line Cap) ═══
| cap-butt                         // 평평한 끝 ─|
| cap-round                        // 둥근 끝 ─)
| cap-square                       // 사각형 끝 ─□
| cap-custom(symbol: arrow_head)   // 커스텀 심볼을 캡으로

// ═══ 라인 조인 (Line Join) ═══
| join-miter                       // 뾰족한 꺾임 ┐
| join-round                       // 둥근 꺾임
| join-bevel                       // 잘린 꺾임

// ═══ 라인 그라디언트 (경로 따라 색 변화) ═══
| stroke-gradient(red-500 0%, yellow-500 50%, green-500 100%)
| stroke-gradient([speed | ramp:rdylgn])  // 경로 위치별 속도 → 색상

// ═══ 라인 장식 (Decoration) ═══
| decorate-arrow(interval: 100px, size: 8, fill: white)
| decorate-symbol(symbol: dot, interval: 50px)
| decorate-distance-labels         // 구간별 거리 라벨

// ═══ 라인 오프셋 ═══
| stroke-offset-5                  // 라인에서 5px 오프셋 (평행선)
| stroke-offset-[-5]               // 반대 방향 오프셋

// ═══ 복합 라인 (다중 스트로크) ═══
// 도로처럼 외곽선 + 내부 채움이 필요한 경우
| stroke-compound [
    { w: 8, color: gray-700 }      // 바깥 (넓은 어두운 선)
    { w: 6, color: white }         // 안쪽 (좁은 밝은 선)
  ]
// → 도로 표현: 흰색 도로 + 검은 테두리

// 철도 표현
| stroke-compound [
    { w: 4, color: black }
    { w: 2, color: white, dash: 6-6 }   // 내부 대시
  ]

// ═══ 라인 패턴 (Line Pattern) ═══
// 라인의 두께 영역 안에 반복 패턴을 입힘

// 1. 내장 라인 패턴 프리셋
| stroke-pattern-railroad           // ─┼─┼─┼─  철도 (수직 눈금)
| stroke-pattern-fence              // ─╳─╳─╳─  울타리
| stroke-pattern-pipeline           // ─●─●─●─  파이프라인
| stroke-pattern-powerline          // ─⌒─⌒─⌒─  전력선 (아크)
| stroke-pattern-boundary-1         // ─ · ─ · ─  국경 (1종)
| stroke-pattern-boundary-2         // ── · · ── 국경 (2종)
| stroke-pattern-contour-tick       // ──┤──┤──  등치선 (경사 방향 틱)

// 2. 커스텀 라인 패턴 — SVG 심볼 반복
| stroke-pattern(
    symbol: custom_mark              // 반복할 심볼
    interval: 20px                   // 반복 간격
    orient: along-line               // 라인 방향에 따라 회전 (기본)
    //  또는 orient: fixed           // 회전 없이 고정
    //  또는 orient: perpendicular   // 라인에 수직
    offset: center                   // 라인 중심에 배치 (기본)
    //  또는 offset: left(3px)       // 왼쪽으로 3px 오프셋
    //  또는 offset: right(3px)
  )

// 3. 타일형 라인 패턴 — SVG 패턴을 라인 영역에 타일링
| stroke-fill-pattern(
    src: "./patterns/brick.svg"      // 라인 폭 안에 패턴 타일링
    repeat: along                    // 라인 방향으로 반복
    scale: 1.0
  )

// 해치 패턴을 라인 안에
| stroke-fill-hatch(angle: 45deg, spacing: 4, stroke: gray-500, stroke-w: 1)

// 그라디언트를 라인 안에 (폭 방향)
| stroke-fill-linear(perpendicular, blue-700, blue-300, blue-700)
// → 라인 중심이 밝고 가장자리가 어두운 효과 (입체감)


// 4. 복합 라인 패턴 정의 — 완전 커스텀

// 단위 패턴을 정의하고 반복
line_pattern railroad_pattern {
  // 패턴 단위: 20px 길이, 라인 폭만큼 높이
  unit_length: 20px

  // 패턴 안에 그릴 요소들 (로컬 좌표: x=경로방향, y=폭방향)
  // 원점(0,0)은 패턴 단위의 중앙

  // 메인 라인 (패턴 전체 길이)
  line x1: -10  y1: 0  x2: 10  y2: 0  stroke-w: 2  color: black

  // 수직 눈금 (중앙에 하나)
  line x1: 0  y1: -5  x2: 0  y2: 5  stroke-w: 1.5  color: black
}

| stroke-line-pattern(railroad_pattern)

// 울타리 패턴
line_pattern fence_pattern {
  unit_length: 16px

  // X 표시
  line x1: -4  y1: -4  x2: 4  y2: 4  stroke-w: 1  color: brown-600
  line x1: -4  y1: 4   x2: 4  y2: -4 stroke-w: 1  color: brown-600
}

// 전력선 패턴
line_pattern powerline_pattern {
  unit_length: 30px

  // 현수선 (catenary) 근사 — 아크
  arc cx: 0  cy: 3  rx: 12  ry: 6  start: 180deg  end: 360deg
    stroke-w: 1  color: gray-700

  // 전신주 위치 마커
  circle cx: -15  cy: 0  r: 2  fill: gray-600  stroke: none
}

// 국경 패턴 (복합)
line_pattern international_boundary {
  unit_length: 40px

  // 긴 대시
  line x1: -20  y1: 0  x2: -5  y2: 0  stroke-w: 2  color: red-700
  // 점
  circle cx: 0  cy: 0  r: 1.5  fill: red-700
  // 긴 대시
  line x1: 5  y1: 0  x2: 20  y2: 0  stroke-w: 2  color: red-700
}


// 5. 데이터 기반 라인 패턴 전환

layer boundaries {
  source: boundary_data
  // 경계 종류에 따라 다른 패턴
  | [level=="international"]:stroke-line-pattern(international_boundary)
  | [level=="provincial"]:stroke-dash-10-5  stroke-gray-600
  | [level=="municipal"]:stroke-dash-5-3    stroke-gray-400
  | stroke-w-2
}

layer infrastructure {
  source: infra_lines
  | [type=="railroad"]:stroke-line-pattern(railroad_pattern)
  | [type=="powerline"]:stroke-line-pattern(powerline_pattern)
  | [type=="pipeline"]:stroke-pattern-pipeline
  | [type=="fence"]:stroke-line-pattern(fence_pattern)
}


// 6. S-100 해도 라인 패턴 — 해양 기호
// S-52 Presentation Library에 정의된 라인 심볼을 X-GIS로 변환

line_pattern s52_depth_contour_safe {
  // 안전 수심선: 굵은 실선
  unit_length: 1px   // 연속 (패턴 없음)
  line x1: 0  y1: 0  x2: 1  y2: 0  stroke-w: 2  color: #1a6699
}

line_pattern s52_depth_contour_danger {
  // 위험 수심선: 굵은 실선 + 틱마크 (얕은 쪽으로)
  unit_length: 30px
  line x1: -15  y1: 0  x2: 15  y2: 0  stroke-w: 2  color: #994d00
  line x1: 0  y1: 0  x2: 0  y2: -5  stroke-w: 1  color: #994d00  // 틱 (얕은 쪽)
}

line_pattern s52_cable_submarine {
  // 해저 케이블: 대시 + 물결
  unit_length: 24px
  line x1: -12  y1: 0  x2: -4  y2: 0  stroke-w: 1  color: #660099
  arc cx: 0  cy: 0  rx: 4  ry: 3  start: 180deg  end: 360deg
    stroke-w: 1  color: #660099
}
```

#### Point (포인트) — 형상 + 채움 + 크기

```
// ═══ 포인트 형상 (Shape) ═══
| point-circle                     // 원 (기본)
| point-square                     // 사각형
| point-diamond                    // 마름모 (45도 회전 사각형)
| point-triangle                   // 삼각형 (▲)
| point-triangle-down              // 역삼각형 (▼)
| point-star(points: 5)            // 별 (꼭짓점 수 지정)
| point-cross                      // + 형태
| point-x                          // × 형태
| point-hexagon                    // 육각형
| point-custom(symbol: nato_friendly)  // 커스텀 심볼

// 데이터 기반 형상 선택
| point-[match type {
    "city" => circle
    "port" => square
    "airport" => triangle
    _ => diamond
  }]

// ═══ 포인트 크기 ═══
| size-8                           // 8px 고정
| size-[population | log10 | scale:4]  // 데이터 기반
| z10:size-4  z16:size-12          // 줌 기반

// ═══ 포인트 채움 — fill과 동일한 모든 모드 사용 가능 ═══
| point-circle  size-12  fill-red-500  stroke-white  stroke-w-2
| point-circle  size-16  fill-radial(center, white, blue-500)  // 그라디언트 채움
| point-square  size-10  fill-hatch(angle: 45deg, spacing: 3, stroke: black)

// ═══ 포인트 회전 ═══
| rotate-[heading]                 // 데이터 필드로 회전
| rotate-45deg                     // 고정 회전

// ═══ 포인트 앵커 ═══
| anchor-center                    // 중심 (기본)
| anchor-bottom                    // 아래쪽 (핀 마커)
| anchor-top-left                  // 좌상단

// ═══ 복합 포인트 (다중 레이어) ═══
// 하나의 포인트에 여러 도형 겹침
| point-compound [
    { shape: circle, size: 20, fill: white, stroke: black, stroke-w: 2 }
    { shape: circle, size: 14, fill-[classification | ramp:rdylgn] }
    { shape: circle, size: 6,  fill: white }
  ]
// → 동심원 마커: 흰 외곽 + 색상 원 + 내부 흰 점
```

#### Arc, Sector, Complex Shapes — 호, 부채꼴, 복합 도형

```
// ═══ 인라인 geometry로 정의 ═══

// 호 (Arc)
geometry radar_arc {
  arc(
    center: (127.0deg, 37.5deg)
    radius: 200km
    start: 30deg                             // 시작 방위
    end: 150deg                              // 끝 방위
  )
}

layer radar_display {
  source: radar_arc
  | fill-green-500/10  stroke-green-400  stroke-w-2
}

// 데이터 기반 동적 호
layer weapon_arcs {
  source: weapon_systems

  // 각 무기체계의 사거리와 방위 범위
  | arc(radius: [range], start: [bearing-arc/2], end: [bearing+arc/2])
  | hostile:fill-red-500/10  friendly:fill-blue-500/10
  | stroke-w-1  stroke-dash-5-3
}

// ═══ symbol 내 복합 도형 ═══

symbol compass_rose {
  // 외곽 원
  circle cx: 0  cy: 0  r: 1.0  fill: none  stroke-w: 0.02

  // 눈금 (주 방위 4개)
  for angle in [0, 90, 180, 270] {
    line x1: 0  y1: -0.85  x2: 0  y2: -1.0  rotate: angle  stroke-w: 0.03
  }

  // 눈금 (부 방위 4개)
  for angle in [45, 135, 225, 315] {
    line x1: 0  y1: -0.9  x2: 0  y2: -1.0  rotate: angle  stroke-w: 0.015
  }

  // 북쪽 삼각형
  path "M 0 -0.7 L -0.08 -0.55 L 0.08 -0.55 Z"  fill: red-500

  // 중심점
  circle cx: 0  cy: 0  r: 0.05  fill: black

  anchor: center
}

// ═══ 도넛 (링) ═══
symbol range_ring {
  circle cx: 0  cy: 0  r: 1.0   fill: none  stroke-w: 0.02
  circle cx: 0  cy: 0  r: 0.66  fill: none  stroke-w: 0.015
  circle cx: 0  cy: 0  r: 0.33  fill: none  stroke-w: 0.01
}

// ═══ 부채꼴 (Sector) — 등화 표현 등 ═══
symbol light_sector(start_angle: f32, end_angle: f32, color: rgba) {
  // SVG arc path로 부채꼴 표현
  arc cx: 0  cy: 0  r: 1.0
    start: start_angle
    end: end_angle
    fill: color/30                           // 반투명 채움
    stroke: color
    stroke-w: 0.02
}

// 사용: 등화의 색상별 섹터
layer light_sectors {
  source: lights_data
  | for sector in property(sectors) {
      symbol-light_sector(
        start_angle: sector.start
        end_angle: sector.end
        color: match sector.color {
          "W" => white
          "R" => red-500
          "G" => green-500
          _ => yellow-500
        }
      )
    }
  | size-[range * zoom_scale]
}

// ═══ 커스텀 라인 캡 ═══
symbol arrow_cap {
  path "M -0.5 0.5 L 0 0 L 0.5 0.5"
  fill: none
  stroke-w: 0.1
}

layer directed_route {
  source: route_data
  | stroke-blue-500  stroke-w-3
  | cap-custom(symbol: arrow_cap)             // 끝점에 화살표 캡
  | join-round
}

// ═══ 사용자 정의 대시 패턴 ═══
// SVG dasharray를 넘어서: 심볼 기반 대시
| stroke-symbol-dash(
    symbol: arrow_dash                        // 대시 대신 반복할 심볼
    interval: 20px                            // 반복 간격
    along: line                               // 라인을 따라 회전
  )
```

#### 전체 렌더링 프리미티브 — 카테고리 정리

```
카테고리           유틸리티                       모드/값
──────────        ──────────                     ──────────
Fill 채움          fill-*                         solid, linear, radial,
                                                 path-gradient, hatch,
                                                 crosshatch, pattern, none

Stroke 선          stroke-*                       color, width, opacity
                   stroke-dash-*                  dasharray, offset
                   cap-*                          butt, round, square, custom
                   join-*                         miter, round, bevel
                   stroke-gradient-*              along-path gradient
                   stroke-compound                multi-layer stroke
                   stroke-offset-*                parallel offset

Point 포인트       point-*                        circle, square, diamond,
                                                 triangle, star, hexagon,
                                                 cross, x, custom
                   size-*                         px, data-driven, zoom-driven
                   rotate-*                       degrees, data-field
                   anchor-*                       center, bottom, top-left, ...
                   point-compound                 multi-layer point

Gradient 그라디언트  fill-linear(angle, stops)     선형
                    fill-radial(center, stops)     방사형
                    fill-path-gradient(stops)      경로형
                    stroke-gradient(stops)         라인 경로형
                    stops: 정적 or 동적 배열

Pattern 패턴        fill-hatch(angle, spacing, ...)  해치
                    fill-crosshatch(...)              교차 해치
                    fill-pattern(src, scale, repeat)  SVG 패턴
                    fill-pattern-dots/grid/diagonal   프리셋 패턴

Shape 도형          geometry { arc(...) }             호
                    geometry { circle(...) }          원
                    symbol { path "..." }             SVG 경로
                    symbol { for ... }                반복 도형
                    compound [ { ... } ]              복합 (겹침)

Decoration 장식     decorate-arrow(interval, ...)     화살표
                    decorate-symbol(symbol, ...)      심볼 반복
                    decorate-distance-labels          거리 라벨
                    stroke-symbol-dash(symbol, ...)   심볼 대시

이 모든 것은:
  - 디자인 토큰 사용 가능 (fill-primary, stroke-danger)
  - 데이터 바인딩 가능 ([field], [expression])
  - 줌 모디파이어 가능 (z8:fill-*, z16:fill-*)
  - 데이터 모디파이어 가능 (hostile:fill-*)
  - 인터랙션 모디파이어 가능 (hover:fill-*)
```

#### 컴파일러가 이것들을 GPU에서 어떻게 처리하는가

```
렌더링 프리미티브        GPU 구현 전략
──────────────         ──────────────────────
단색 fill               → uniform color (가장 빠름)
선형 그라디언트          → @fragment에서 uv 기반 mix()
방사형 그라디언트        → @fragment에서 distance 기반 mix()
경로형 그라디언트        → vertex attribute로 경로 t값 전달, fragment에서 보간
동적 정지점             → 1D 텍스처로 패킹, texture sample
해치 패턴              → @fragment에서 절차적 생성 (fract + step)
SVG 패턴              → 패턴 텍스처로 변환, UV 반복 샘플링
포인트 형상            → SDF (Signed Distance Field) per shape
복합 포인트/라인        → 멀티 패스 또는 스텐실 버퍼
라인 캡/조인            → 라인 테셀레이터에서 지오메트리 생성
대시 패턴              → @fragment에서 UV.x 기반 fract + step
라인 장식              → 인스턴스드 렌더링 (라인 위 등간격 배치)

// 컴파일러는 사용된 프리미티브를 분석하여 최소한의 셰이더를 생성.
// fill-red-500만 쓰면 그라디언트 코드는 포함되지 않음 (tree shaking).
```

### 5.4 logic.xgl — 로직 (코드)

#### 5.4.1 @fragment에서 데이터 접근 — 자동 varying

전통 GPU 파이프라인에서 vertex → fragment 데이터 전달은 "varying"을 수동 선언해야 함.
X-GIS에서는 **컴파일러가 자동 추론**:

```
// 개발자가 작성하는 코드 — varying 선언 없음
layer tracks {
  source: military_tracks    // schema에 speed, altitude, classification 등
  | symbol-arrow  rotate-[heading]

  @fragment {
    // speed, altitude, classification을 그냥 쓴다
    // 컴파일러가 vertex→fragment varying을 자동 생성
    let threat = if speed > 500 and altitude < 100 { 1.0 } else { 0.0 }
    let base = if classification == 1u { vec3(1,0,0) } else { vec3(0,1,0) }
    color = vec4(mix(base, vec3(1,1,0), threat), 1.0)
  }
}

// 컴파일러가 생성하는 WGSL (개발자에게 보이지 않음):
//
// struct VertexOutput {
//   @builtin(position) pos: vec4f,
//   @location(0) speed: f32,                    // ← 자동 생성
//   @location(1) altitude: f32,                 // ← 자동 생성
//   @location(2) @interpolate(flat) classification: u32,  // ← 정수는 flat
// }
```

**규칙**:
- @fragment에서 사용된 데이터 필드 → 컴파일러가 자동으로 varying 생성
- `f32`, `vec2<f32>` 등 → `@interpolate(perspective)` (기본, 보간)
- `u32`, `i32`, `bool` 등 정수/불리언 → `@interpolate(flat)` (보간 없음)
- 명시적 제어가 필요하면 어노테이션: `@flat speed` 또는 `@smooth altitude`

#### 5.4.2 Enum

```
// 값 매핑 enum (분류 데이터에 필수)
enum Classification : u8 {
  friendly  = 0
  hostile   = 1
  neutral   = 2
  unknown   = 3
}

enum ThreatLevel {
  low
  medium
  high
  critical
}

// 사용 — 유틸리티 모디파이어에서
layer tracks {
  source: military_tracks
  | Classification.friendly:fill-green-500
  | Classification.hostile:fill-red-500
  | fill-gray-400
}

// 사용 — 로직에서
fn assess_threat(track: Track) -> ThreatLevel {
  if track.speed > 500 and track.altitude < 100 {
    return ThreatLevel.critical
  }
  return match track.classification {
    Classification.hostile  => ThreatLevel.high
    Classification.neutral  => ThreatLevel.medium
    _                       => ThreatLevel.low
  }
}

// 비트플래그 enum (군사 데이터에서 흔함)
enum Capability : u32 @flags {
  radar       = 0x01
  missile     = 0x02
  electronic  = 0x04
  stealth     = 0x08
}

// 사용
fn has_radar(cap: Capability) -> bool {
  return cap & Capability.radar != 0
}
```

#### 5.4.3 Trait (클래스 대신)

GPU에서 vtable/dynamic dispatch는 불가. 대신 **trait + impl** (Rust 모델):

```
// trait 정의 — 인터페이스 계약
trait Styleable {
  fn color(self) -> rgba
  fn size(self) -> f32
  fn priority(self) -> u32
}

// 구현 — 특정 struct에 trait 적용
impl Styleable for MilTrack {
  fn color(self) -> rgba {
    return match self.classification {
      Classification.friendly => rgba(0, 255, 0, 255)
      Classification.hostile  => rgba(255, 0, 0, 255)
      _                       => rgba(128, 128, 128, 255)
    }
  }

  fn size(self) -> f32 {
    return clamp(self.speed / 50.0, 4.0, 24.0)
  }

  fn priority(self) -> u32 {
    return if self.classification == Classification.hostile { 100u } else { 0u }
  }
}

impl Styleable for CivilAircraft {
  fn color(self) -> rgba { return rgba(100, 100, 255, 255) }
  fn size(self) -> f32 { return 6.0 }
  fn priority(self) -> u32 { return 0u }
}

// trait을 유틸리티에서 사용
layer tracks {
  source: military_tracks
  | symbol-arrow  size-[self|size]  fill-[self|color]
  //                     ↑ trait 메서드 호출
}
```

**컴파일러가 하는 일**: trait 메서드 호출을 **인라인 확장** (monomorphization).
GPU에는 vtable이 없으므로, 컴파일 타임에 구체 타입이 결정되어야 함.
제네릭 함수도 컴파일 타임에 구체 타입으로 특수화됨 (Rust/C++ 템플릿과 동일).

#### 5.4.4 재귀 — GPU 한계와 대안

**GPU에서 재귀가 불가능한 이유**: 콜 스택이 없음. WGSL, GLSL, HLSL, CUDA 커널 모두 동일.

**X-GIS의 해법 — 재귀 대신 패턴 제공**:

```
// ✗ 금지: 재귀 함수
fn factorial(n: u32) -> u32 {
  if n <= 1 { return 1u }
  return n * factorial(n - 1)   // 컴파일 에러: recursion not allowed on GPU
}

// ✓ 대안 1: 반복문 (가장 일반적)
fn factorial(n: u32) -> u32 {
  var result = 1u
  for i in 1..=n {
    result *= i
  }
  return result
}

// ✓ 대안 2: fold/reduce (함수형 패턴)
fn sum_of_squares(data: [f32]) -> f32 {
  return reduce(data, 0.0, fn(acc, x) { acc + x * x })
}

// ✓ 대안 3: 고정 깊이 언롤링 (트리 탐색 등)
// 컴파일러가 재귀를 감지하면 @unroll 힌트 제안
@unroll(max_depth: 8)
fn quadtree_lookup(node: u32, point: vec2<f32>) -> u32 {
  // 컴파일러가 8단계까지 루프로 변환
  var current = node
  for _depth in 0..8 {
    if is_leaf(current) { break }
    let quadrant = get_quadrant(current, point)
    current = get_child(current, quadrant)
  }
  return current
}

// ✓ 대안 4: comptime 재귀 (컴파일 타임에만, Zig comptime처럼)
// 결과가 상수로 접혀서 GPU 코드에는 재귀 없음
comptime fn generate_lut(depth: u32) -> [f32; 16] {
  // 이건 컴파일러에서 실행됨 — 재귀 OK
  var lut: [f32; 16]
  for i in 0..16 { lut[i] = comptime_helper(i, depth) }
  return lut
}
```

#### 5.4.5 const / constexpr / comptime — 3단계 상수 모델

```
// ═══ const — 런타임 불변 ═══
// GPU 실행 중 값이 고정되지만, 컴파일 타임에는 모를 수 있음
const max_speed = uniform.max_speed        // uniform에서 받은 값
const screen_center = viewport / 2.0       // 매 프레임 달라질 수 있음


// ═══ constexpr — 컴파일 타임 평가 가능하면 접고, 아니면 런타임 ═══
// C++의 constexpr과 동일한 의미론

constexpr fn to_radians(deg: f32) -> f32 {
  return deg * 3.14159265 / 180.0
}

// 컴파일 타임에 접힘 (입력이 리터럴)
const heading_north = to_radians(0.0)      // → 0.0 상수로 임베딩
const heading_east = to_radians(90.0)      // → 1.5708 상수로 임베딩

// 런타임 폴백 (입력이 데이터)
const heading_rad = to_radians(track.heading)  // → 런타임 계산

// constexpr 변수 — 컴파일 타임에 확정되는 값
constexpr PI = 3.14159265358979
constexpr WGS84_A = 6378137.0
constexpr WGS84_E2 = 0.00669437999014
constexpr TILE_SIZE = 256u
constexpr MAX_ZOOM = 22u

// constexpr 색상 팔레트
constexpr PALETTE = [
  rgba(66, 133, 244, 255),     // blue
  rgba(234, 67, 53, 255),      // red
  rgba(251, 188, 4, 255),      // yellow
  rgba(52, 168, 83, 255),      // green
]

// constexpr 구조체
constexpr DEFAULT_LIGHTING = Lighting {
  direction: vec3(0.577, 0.577, 0.577)
  ambient: 0.15
  diffuse: 0.8
}

// constexpr로 좌표 변환 테이블 생성
constexpr fn mercator_scale(lat_deg: f32) -> f32 {
  let lat = to_radians(lat_deg)
  return 1.0 / cos(lat)
}

// 리터럴 입력이면 컴파일 타임에 접힘
constexpr SCALE_AT_60 = mercator_scale(60.0)   // → 2.0 상수

// constexpr 배열 — 컴파일 타임 LUT
constexpr fn build_sin_table() -> [f32; 360] {
  var table: [f32; 360]
  for i in 0..360 {
    table[i] = sin(to_radians(f32(i)))
  }
  return table
}
constexpr SIN_TABLE = build_sin_table()  // 컴파일 타임에 360개 값 계산


// ═══ comptime — 반드시 컴파일 타임 (Zig) ═══
// constexpr와 차이: comptime은 런타임 폴백 불가, 코드 생성에 사용

comptime fn generate_zoom_thresholds(base: f32, levels: u32) -> [f32] {
  var result: [f32; levels]
  for i in 0..levels {
    result[i] = base / pow(2.0, f32(i))
  }
  return result
}

// 타입 레벨 계산 (comptime만 가능)
comptime fn vec_type(dim: u32) -> type {
  return match dim {
    2 => vec2<f32>
    3 => vec3<f32>
    4 => vec4<f32>
  }
}

// 재귀 (comptime만 허용)
comptime fn fibonacci(n: u32) -> u32 {
  if n <= 1 { return n }
  return fibonacci(n - 1) + fibonacci(n - 2)   // comptime에서는 재귀 OK
}
constexpr FIB_10 = fibonacci(10)               // -> 55 상수로 임베딩
```

**3단계 비교:**

```
                  컴파일 타임 평가    런타임 폴백    재귀    타입 계산    GPU 코드에 존재
const             ✗                  ✓ (항상)       ✗       ✗           ✓ (변수로)
constexpr         ✓ (가능하면)        ✓ (필요시)     ✗       ✗           조건부 (접히면 상수, 아니면 함수)
comptime          ✓ (반드시)          ✗              ✓       ✓           ✗ (결과만 임베딩)
```

**컴파일러 동작:**

```
constexpr fn foo(x: f32) -> f32 { return x * 2.0 + 1.0 }

foo(3.0)           // → 컴파일 타임: 7.0 상수로 치환
foo(speed)         // → 런타임: speed * 2.0 + 1.0 인라인 생성
foo(uniform.val)   // → 런타임: uniform.val * 2.0 + 1.0 인라인 생성

comptime fn bar(x: f32) -> f32 { return x * 2.0 + 1.0 }

bar(3.0)           // → 컴파일 타임: 7.0 상수로 치환
bar(speed)         // → 컴파일 에러: comptime requires compile-time arguments
```

#### 5.4.6 함수 실행 위치 — GPU vs CPU

```
// GPU에서 실행되는 함수 (기본)
fn lerp_color(a: rgba, b: rgba, t: f32) -> rgba {
  return rgba(mix(a.rgb, b.rgb, t), mix(a.a, b.a, t))
}

// CPU에서 실행되는 함수 (호스트 사이드)
@host fn fetch_metadata(id: u32) -> string {
  // 이 함수는 GPU 셰이더에서 호출 불가
  // 이벤트 핸들러, 데이터 전처리 등에서만 사용
  return database.query(id)
}

// 이벤트 핸들러 (항상 @host)
on click(layer: tracks) {
  let track = event.feature
  let meta = fetch_metadata(track.id)
  show_popup(track.id, meta)
}

// compute shader (GPU, 명시적)
@compute(workgroup: 256)
fn update_particles(particles: [Particle], wind: grid2d<vec2>) {
  let p = particles[global_id.x]
  p.velocity = lerp(p.velocity, sample(wind, p.position), 0.1)
  p.position += p.velocity * delta_time
  particles[global_id.x] = p
}
```

#### 5.4.7 에러 메시지 — GPU 제약 위반 시

```
error[E0401]: recursive function cannot run on GPU
  --> logic.xgl:12:3
   |
12 |   return n * factorial(n - 1)
   |              ^^^^^^^^^ recursive call detected
   |
help: GPU has no call stack. Use a loop instead:
   |
10 | fn factorial(n: u32) -> u32 {
   |   var result = 1u
   |   for i in 1..=n { result *= i }
   |   return result
   | }

error[E0402]: dynamic dispatch not available on GPU
  --> logic.xgl:25:5
   |
25 |   let s: dyn Styleable = get_item()
   |          ^^^^^^^^^^^^^ trait objects require vtable
   |
help: use concrete type or generic:
   |
25 |   let s: MilTrack = get_item()
   |          ^^^^^^^^

warning[W0201]: integer field 'classification' used in @fragment
  --> scene.xgis:15:12
   |
15 |   let c = classification
   |           ^^^^^^^^^^^^^^ will use @interpolate(flat) — no smooth interpolation
   |
note: this is correct for categorical data, but if you need
      interpolation, convert to f32 first
```

### 5.5 Advanced Rendering — pipeline / effect / schedule

#### 5.5.1 핵심 구조: `pipeline`

고급 렌더링은 **멀티 패스**가 핵심. 그림자 맵 → 메인 패스 → 포스트 프로세스.
X-GIS에서는 `pipeline` 블록으로 패스 순서와 렌더 타깃을 선언적으로 기술:

```
// 멀티 패스 파이프라인 선언
pipeline lit_scene {
  // 패스 1: 그림자 맵 생성
  pass shadow {
    target: depth_texture(2048, 2048)
    from: light_view                        // 광원 시점 카메라
    | depth-only                            // 색상 출력 없음, 깊이만
  }

  // 패스 2: 메인 렌더링 (그림자 맵 참조)
  pass main {
    target: screen
    use: shadow.depth as shadow_map         // 이전 패스 결과를 텍스처로 참조
  }

  // 패스 3: 포스트 프로세스
  pass post {
    target: screen
    use: main.color as scene_texture
    | fullscreen-quad

    @fragment {
      // 톤 매핑, 블룸, FXAA 등
      let hdr = sample(scene_texture, uv)
      color = aces_tonemap(hdr)
    }
  }
}
```

#### 5.5.2 렌더링 기법 — `effect` 모듈

고급 렌더링 기법을 **재사용 가능한 effect**로 패키징.
개발자는 effect를 import해서 레이어에 적용:

```
// ════════════════════════════════════════
// SDF — Signed Distance Field
// ════════════════════════════════════════

// 표준 라이브러리: @xgis/sdf
import { sdf_circle, sdf_box, sdf_union, sdf_subtract, sdf_smooth_union } from "@xgis/sdf"

// SDF 기반 커스텀 심볼 정의
symbol radar_indicator {
  @sdf {
    // SDF 프리미티브 조합 — 선언적
    let ring = sdf_circle(1.0) - sdf_circle(0.85)           // 링
    let cross = sdf_box(vec2(0.1, 0.8)) | sdf_box(vec2(0.8, 0.1))  // 십자
    let shape = sdf_union(ring, cross)

    // 데이터 기반 부채꼴 (레이더 스윕)
    let sweep = sdf_arc(heading, 30deg)                      // heading 방향 30도 호
    return sdf_union(shape, sweep)
  }
}

layer radar {
  source: radar_stations
  | symbol-radar_indicator  size-[range/1000]
  | fill-green-500/30  stroke-green-400  stroke-1            // 반투명 채우기
  | animate-rotate-[sweep_speed]                             // 스윕 애니메이션
}


// ════════════════════════════════════════
// Water Effect
// ════════════════════════════════════════

// 표준 라이브러리: @xgis/effects/water
import { water } from "@xgis/effects/water"

layer ocean {
  source: ocean_polygons
  | apply-water(
      wave-scale: 0.5
      wave-speed: 1.2
      depth-color: #001a33
      surface-color: #0066cc
      foam-threshold: 0.8
      reflection: environment_map         // 환경 맵 텍스처
      refraction: true
    )
  | z10:wave-detail-low  z14:wave-detail-high
}

// water effect 내부 구현 (라이브러리 작성자가 작성)
// 사용자는 이 코드를 볼 필요 없음, 파라미터만 조정
export effect water(
  wave_scale: f32 = 0.3,
  wave_speed: f32 = 1.0,
  depth_color: rgba = #001a33,
  surface_color: rgba = #0066cc,
  foam_threshold: f32 = 0.7,
  reflection: texture2d? = none,
  refraction: bool = false,
) {
  @vertex {
    // Gerstner 파도 시뮬레이션
    let wave1 = gerstner_wave(position.xz, time * wave_speed, vec2(1, 0), 0.5, wave_scale)
    let wave2 = gerstner_wave(position.xz, time * wave_speed, vec2(0.7, 0.7), 0.3, wave_scale * 0.6)
    position.y += wave1.y + wave2.y
    normal = normalize(vec3(-wave1.x - wave2.x, 1.0, -wave1.z - wave2.z))
  }

  @fragment {
    let depth_factor = clamp(water_depth / 50.0, 0.0, 1.0)
    let base = mix(surface_color, depth_color, depth_factor)

    // 반사
    if reflection != none {
      let reflect_dir = reflect(-view_dir, normal)
      let env = sample(reflection, reflect_dir.xz * 0.5 + 0.5)
      let fresnel = pow(1.0 - max(dot(view_dir, normal), 0.0), 3.0)
      base = mix(base, env, fresnel * 0.6)
    }

    // 폼 (파도 정상부 흰색)
    let foam = smoothstep(foam_threshold, 1.0, wave_height)
    color = mix(base, rgba(1,1,1,1), foam * 0.5)
  }
}


// ════════════════════════════════════════
// Lighting — PBR 기반
// ════════════════════════════════════════

import { pbr, directional_light, point_light, ambient_occlusion } from "@xgis/lighting"

layer buildings_3d {
  source: buildings
  | extrude-[height]

  // PBR 머티리얼 유틸리티로 적용
  | pbr(
      albedo: match property(type) {
        "glass"    => #88ccee
        "concrete" => #999999
        _          => #ccbbaa
      }
      roughness: match property(type) {
        "glass" => 0.1
        _       => 0.7
      }
      metallic: 0.0
    )

  // 조명 선언적 합성
  | light-directional(direction: vec3(0.5, 0.8, 0.3), color: #fffae6, intensity: 1.2)
  | light-ambient(color: #334455, intensity: 0.3)
  | shadow-map(resolution: 2048, bias: 0.002)
  | ambient-occlusion(radius: 2.0, samples: 16)
}


// ════════════════════════════════════════
// Raytracing / Ray Marching
// ════════════════════════════════════════

import { ray_march, atmosphere } from "@xgis/raytracing"

// 대기 산란 효과 (레이 마칭)
layer sky {
  | fullscreen-quad

  @fragment {
    let ray = camera_ray(uv)

    // 대기 산란: Rayleigh + Mie
    let scatter = atmosphere(
      ray_origin: camera_position,
      ray_dir: ray,
      sun_dir: sun_direction,
      planet_radius: 6371000.0,
      atmosphere_height: 100000.0,
    )
    color = vec4(scatter.rgb, 1.0)
  }
}

// SDF 기반 볼류메트릭 구름 (레이 마칭)
layer volumetric_clouds {
  | fullscreen-quad  blend-alpha

  @fragment {
    let ray = camera_ray(uv)
    var accumulated = vec4(0)

    // 고정 스텝 레이 마칭 (재귀 아님)
    for step in 0..64 {
      let p = camera_position + ray * f32(step) * step_size
      let density = fbm_noise(p * 0.0001 + vec3(time * 0.01, 0, 0))

      if density > 0.3 {
        let light = exp(-density * 2.0)
        let cloud_color = vec4(vec3(light), density * 0.05)
        accumulated += cloud_color * (1.0 - accumulated.a)
      }
      if accumulated.a > 0.95 { break }
    }
    color = accumulated
  }
}
```

#### 5.5.3 실행 전략 — 컴파일러가 결정 (개발자는 힌트만)

**Instancing, Batching, RenderBundle은 "스케줄"이다.**
Halide처럼 개발자는 "무엇을"만 쓰고, 컴파일러가 "어떻게"를 결정:

```
// ═══ 개발자가 작성하는 것 ═══

layer tracks {
  source: military_tracks    // 10만 개 포인트
  | symbol-arrow  size-[speed/50]  rotate-[heading]
  | friendly:fill-green-500  hostile:fill-red-500
}

// ═══ 컴파일러가 결정하는 것 ═══
//
// 분석:
//   - symbol-arrow: 모든 인스턴스가 동일한 지오메트리
//   - size, rotate, fill: 인스턴스별 다른 값
//   - 데이터 10만 건
//
// 결정: Instanced Draw
//   - arrow 메시 1개 업로드 (vertex buffer)
//   - per-instance 속성 (size, rotation, color)을 storage buffer에 패킹
//   - drawIndexed(arrow_indices, instance_count: 100000)
//
// 또 다른 시나리오: 각 피처가 다른 지오메트리라면?
//   → Dynamic batching: 지오메트리를 하나의 큰 버퍼에 합쳐서 1회 draw call


// ═══ 전문가가 힌트를 줄 때 ═══

// 명시적 인스턴싱 강제
@strategy(instanced)
layer tracks { ... }

// 렌더 번들: 정적 레이어를 사전 녹화
@strategy(render_bundle)
layer static_basemap {
  source: basemap_tiles
  | fill-[color]  stroke-[border_color]
  // 이 레이어는 매 프레임 변하지 않으므로 RenderBundle로 사전 녹화
  // GPU 커맨드 재생만으로 렌더링 → CPU 오버헤드 제거
}

// 배치 힌트
@strategy(batch, max_vertices: 65536)
layer poi_icons {
  source: points_of_interest
  | symbol-[icon_type]  size-8            // 여러 종류의 아이콘
  // 컴파일러: 같은 심볼끼리 배치, 아이콘 종류별 draw call
}

// 간접 드로우 (GPU driven rendering)
@strategy(indirect)
layer massive_points {
  source: lidar_data    // 수천만 포인트

  // 컴파일러가 compute shader로 가시성 판정 후
  // indirect draw buffer에 draw count 기록
  // CPU는 dispatch만, GPU가 draw call 수를 결정
  @compute {
    let visible = frustum_test(position) and occlusion_test(position)
    if visible {
      let idx = atomicAdd(draw_count, 1u)
      visible_buffer[idx] = instance_id
    }
  }
}
```

#### 5.5.4 컴파일러의 자동 전략 결정 로직

```
분석 입력:
  - 데이터 크기 (피처 수)
  - 지오메트리 동질성 (모든 인스턴스가 같은 모양?)
  - 프레임 간 변동성 (매 프레임 변하는가?)
  - @strategy 힌트

                    모든 인스턴스 같은 지오메트리?
                         ┌──── yes ────┐
                         │              │
                    데이터 크기?          │
               ┌── <10K ──┼── >10K ──┐  │
               │           │          │  │
            Dynamic     Instanced   Indirect
            Batch       Draw        Draw
               │           │          │
          매 프레임 변동?    │     @compute로
          ┌─ no ─┐        │     가시성 판정
          │      │        │
     RenderBundle  일반     │
     (사전 녹화)   Draw     │
                          │
                    지오메트리 다양?
                    ┌─── yes ───┐
                    │            │
               같은 타입끼리    Merge into
               그룹핑 →       single buffer →
               Multi-Draw     1 draw call
```

#### 5.5.5 effect 정의 — 라이브러리 작성자용

**effect는 재사용 가능한 렌더링 기법 패키지:**

```
// effect 정의 문법
export effect name(param: type = default, ...) {
  // 선언적 부분: 유틸리티처럼 적용됨
  requires: [depth_texture, normal_texture]   // 필요한 패스 출력물
  blend: ...
  depth: ...

  // 셰이더 부분
  @vertex { ... }
  @fragment { ... }
  @compute { ... }                            // 선택적
}

// effect vs style 차이:
// - style (유틸리티): 단순 속성 매핑, 선언적
// - effect: 셰이더 코드 포함, 멀티 패스 가능, 렌더 타깃 참조 가능

// effect 합성
layer ocean {
  source: ocean_polygons
  | apply-water(wave-scale: 0.5)              // water effect
  | apply-foam(threshold: 0.8)                // foam effect (water 위에 추가)
  | apply-caustics(intensity: 0.3)            // 코스틱 효과 합성
}
```

#### 5.5.6 전체 레벨 정리

```
Level 1: 유틸리티 조합          → fill-red-500  stroke-2  size-8
         (CSS/Tailwind 수준)      누구나 사용 가능

Level 2: 데이터 바인딩           → size-[speed/50]  friendly:fill-green-500
         (Mapbox 표현식 수준)     데이터 분석가

Level 3: effect 적용            → apply-water(wave-scale: 0.5)
         (라이브러리 사용)         apply-pbr(roughness: 0.7)
                                  GIS 개발자

Level 4: effect 작성            → export effect water(...) { @vertex {...} @fragment {...} }
         (셰이더 코드 작성)        GPU 프로그래머

Level 5: pipeline 정의 +        → pipeline { pass shadow {...} pass main {...} }
         실행 전략 힌트             @strategy(indirect)  @compute { frustum_test }
         (엔진 수준 제어)           렌더링 엔지니어
```

### 5.6 Simulation — 물리 시뮬레이션

#### 핵심: `simulation` = 상태 + 업데이트 규칙 + 시각화

개발자가 `@compute`의 워크그룹, 더블 버퍼링, 디스패치를 직접 다루는 대신,
**무엇이 어떤 규칙으로 변하는지**만 선언하면 엔진이 나머지를 처리:

```
// @compute 로우레벨 (Level 5 — 엔진 수준):
@compute(workgroup: 256)
fn step(buf_in: [Particle], buf_out: [Particle], wind: grid2d<vec2>) {
  let id = global_id.x
  let p = buf_in[id]
  p.velocity = lerp(p.velocity, sample(wind, p.position), 0.1)
  p.position += p.velocity * delta_time
  buf_out[id] = p
}

// simulation 선언적 (Level 3 — GIS 개발자):
simulation wind_flow {
  state: [Particle]
  update: velocity = lerp(velocity, sample(wind, position), 0.1)
          position += velocity * dt
  visualize: | point-2  fill-[velocity|magnitude|ramp:plasma]
}
// 엔진이 더블 버퍼링, 디스패치, 타임스텝을 자동 처리
```

#### 5.6.1 Grid 시뮬레이션 — 유체, 확산, 파동

```
// ── 유류 오염 확산 시뮬레이션 ──

simulation oil_spill {
  type: grid
  domain {
    bounds: geodetic_bbox(126.5deg, 37.0deg, 127.5deg, 37.8deg)
    resolution: 256 x 256
  }

  // 그리드 셀 상태
  state {
    concentration: f32 = 0.0     // 유류 농도
    velocity: vec2<f32>          // 해류 벡터
  }

  // 외부 입력
  input wind: grid2d<vec2>       // 기상 데이터
  input current: grid2d<vec2>    // 해류 데이터
  input spill_point: vec2<f64>   // 유출 지점

  // 초기 조건
  init {
    let dist = distance(cell_position, spill_point)
    concentration = if dist < 500.0 { 1.0 } else { 0.0 }
    velocity = sample(current, cell_position)
  }

  // 업데이트 규칙 (매 타임스텝)
  update {
    // 이류 (advection) — 해류 + 풍압 효과
    let advection_vel = velocity + sample(wind, cell_position) * 0.03
    let source_pos = cell_position - advection_vel * dt
    let advected = sample(concentration, source_pos)    // 반보간

    // 확산 (diffusion) — 라플라시안
    let diffusion = laplacian(concentration) * 0.001

    // 증발 (decay)
    let evaporation = concentration * 0.0001 * dt

    concentration = advected + diffusion * dt - evaporation
    concentration = clamp(concentration, 0.0, 1.0)
  }

  // 시각화
  visualize {
    | fill-[concentration | ramp:ylorrd:0,1]
    | opacity-[concentration | step:0.01:0,0.7]
    | blend-multiply
  }

  // 시뮬레이션 제어
  timestep: 60s                  // 1분 간격
  speed: 10x                     // 10배속 재생
}


// ── 음파 전파 시뮬레이션 (소나) ──

simulation sonar_propagation {
  type: grid
  domain {
    bounds: geodetic_bbox(125deg, 35deg, 129deg, 39deg)
    resolution: 512 x 512
  }

  state {
    pressure: f32 = 0.0
    pressure_prev: f32 = 0.0    // 파동 방정식에 필요한 이전 값
  }

  input bathymetry: grid2d<f32>  // 수심 데이터
  input source_pos: vec2<f64>    // 소나 위치
  input source_freq: f32         // 주파수

  update {
    // 파동 방정식: d2p/dt2 = c^2 * laplacian(p)
    let depth = sample(bathymetry, cell_position)
    let c = sound_speed_in_water(depth)                  // 수심별 음속
    let lap = laplacian(pressure)

    let next = 2.0 * pressure - pressure_prev + c * c * dt * dt * lap
    pressure_prev = pressure
    pressure = next

    // 감쇠
    pressure *= 0.9999

    // 소스 신호 주입
    let dist = distance(cell_position, source_pos)
    if dist < 100.0 {
      pressure += sin(time * source_freq * 2.0 * PI) * (1.0 - dist / 100.0)
    }
  }

  visualize {
    | fill-[pressure | abs | ramp:coolwarm:0,1]
    | opacity-60
  }

  timestep: 10ms
}


// ── 핵/화학 낙진 확산 ──

simulation fallout_spread {
  type: grid
  domain { bounds: area_of_interest  resolution: 1024 x 1024 }

  state {
    dose_rate: f32 = 0.0         // Gy/h
    ground_deposit: f32 = 0.0    // 지표 침적량
  }

  input wind_field: grid2d<vec2>
  input terrain: grid2d<f32>
  input source: FalloutSource     // 폭발 지점, 위력, 고도

  update {
    // 3D 가우시안 퍼프 모델 (단순화)
    let advected = advect(dose_rate, wind_field, dt)
    let diffused = advected + laplacian(dose_rate) * diffusion_coeff * dt

    // 중력 침강 + 지형 영향
    let elevation = sample(terrain, cell_position)
    let settling = dose_rate * settling_velocity / mixing_height * dt
    ground_deposit += settling

    // 방사성 붕괴
    dose_rate = diffused * exp(-decay_constant * dt) - settling
    dose_rate = max(dose_rate, 0.0)
  }

  visualize {
    | fill-[dose_rate | ramp:inferno:0,10]
    | opacity-[dose_rate | step:0.01:0,0.6]
    | z-order-50
  }
}
```

#### 5.6.2 Particle 시뮬레이션 — 연기, 기상, 추적자

```
// ── 바람 흐름 시각화 ──

simulation wind_particles {
  type: particle
  count: 100000

  state {
    position: vec2<f32>
    velocity: vec2<f32>
    age: f32 = 0.0
    max_age: f32
  }

  input wind: grid2d<vec2>

  // 파티클 초기화 / 리스폰
  spawn {
    position = random_in_bounds(domain)
    velocity = vec2(0)
    age = 0.0
    max_age = random(3.0, 8.0)              // 3~8초 수명
  }

  update {
    let wind_at = sample(wind, position)
    velocity = lerp(velocity, wind_at, 0.15)
    position += velocity * dt
    age += dt

    // 수명 초과 또는 영역 밖이면 리스폰
    if age > max_age or !in_bounds(position) {
      respawn()
    }
  }

  visualize {
    | point-2  blend-additive
    | fill-[velocity | magnitude | ramp:plasma]
    | opacity-[1.0 - age / max_age | clamp:0.1,0.8]   // 나이 들수록 투명
  }
}


// ── 폭발 파편 시뮬레이션 ──

simulation explosion_debris {
  type: particle
  count: 5000
  trigger: on_event("explosion")             // 이벤트 발생 시 시작

  state {
    position: vec3<f32>
    velocity: vec3<f32>
    size: f32
    age: f32 = 0.0
  }

  input terrain: grid2d<f32>
  input explosion_center: vec3<f64>
  input explosion_yield: f32

  spawn {
    position = vec3(explosion_center)
    let angle = random(0.0, 2.0 * PI)
    let elevation = random(0.2, 1.2)         // 위로 더 많이
    let speed = random(50.0, 200.0) * explosion_yield
    velocity = vec3(
      cos(angle) * cos(elevation) * speed,
      sin(angle) * cos(elevation) * speed,
      sin(elevation) * speed
    )
    size = random(1.0, 4.0)
  }

  update {
    // 중력
    velocity.z -= 9.81 * dt

    // 공기 저항
    velocity *= 0.995

    position += velocity * dt
    age += dt

    // 지형 충돌
    let ground = sample(terrain, position.xy)
    if position.z <= ground {
      velocity = vec3(0)
      position.z = ground
    }
  }

  visualize {
    | point-[size]
    | fill-[age | ramp:hot:0,5]              // 뜨거운→차가운
    | opacity-[1.0 - age / 5.0 | clamp:0,1]
  }

  lifetime: 5s                                // 5초 후 시뮬레이션 종료
}
```

#### 5.6.3 Agent 시뮬레이션 — 궤적, 이동체

```
// ── 탄도 미사일 궤적 시뮬레이션 ──

simulation ballistic_trajectory {
  type: agent
  source: launched_missiles                   // 엔티티 배열

  state {
    position: vec3<f64>
    velocity: vec3<f64>
    phase: FlightPhase = FlightPhase.boost
    fuel: f32
  }

  update {
    let gravity = gravity_at(position)        // 고도별 중력
    let drag = atmospheric_drag(position, velocity)
    let thrust = if phase == FlightPhase.boost and fuel > 0 {
      thrust_vector(heading, pitch) * engine_force
    } else {
      vec3(0)
    }

    velocity += (gravity + drag + thrust) * dt
    position += velocity * dt
    fuel = max(0.0, fuel - fuel_rate * dt)

    // 상태 전이
    if fuel <= 0.0 and phase == FlightPhase.boost {
      phase = FlightPhase.midcourse
    }
    if altitude(position) < 50000.0 and phase == FlightPhase.midcourse {
      phase = FlightPhase.terminal
    }
  }

  visualize {
    entity {
      model: missile_model
      | FlightPhase.boost:tint-orange-500     // 부스트: 주황
      | FlightPhase.midcourse:tint-white      // 중간: 흰색
      | FlightPhase.terminal:tint-red-500     // 종말: 빨강
    }

    // 궤적 잔상
    trail {
      length: 1000                            // 최근 1000 프레임
      | stroke-2
      | FlightPhase.boost:stroke-orange-400
      | FlightPhase.terminal:stroke-red-400
      | opacity-fade-out
    }

    // 예측 착탄점 (현재 속도/방향으로 외삽)
    prediction {
      steps: 500
      | stroke-1  stroke-dash-5-5  stroke-yellow-300  opacity-40
    }
  }
}


// ── 함정 기동 시뮬레이션 ──

simulation ship_maneuver {
  type: agent
  source: fleet_ships

  state {
    position: vec2<f64>
    heading: f32
    speed: f32
    rudder: f32                              // -1 ~ 1
  }

  input waypoints: [Waypoint]                // 경유점 목록
  input formation: FormationType             // 대형 유지

  update {
    // 경유점 추종
    let target = next_waypoint(position, waypoints)
    let desired_heading = bearing_to(position, target)
    let heading_error = angle_diff(heading, desired_heading)

    // 조타 (PID 제어)
    rudder = clamp(heading_error * kp + heading_rate * kd, -1.0, 1.0)
    heading += rudder * turn_rate * dt

    // 추진
    let desired_speed = cruise_speed(target, waypoints)
    speed = lerp(speed, desired_speed, 0.1)

    // 이동
    position += vec2(sin(heading), cos(heading)) * speed * dt

    // 대형 유지 보정
    if formation != FormationType.none {
      let correction = formation_offset(self_index, fleet_ships, formation)
      position += correction * 0.01
    }
  }

  visualize {
    entity {
      model: ship_model
      | scale-[length / 100]
    }
    trail {
      length: 500
      | stroke-1  stroke-white  opacity-30
    }
    // 경유점까지 계획 경로
    connection planned_route {
      points: remaining_waypoints(position, waypoints)
      | stroke-1  stroke-dash-8-4  stroke-cyan-400  opacity-60
    }
  }
}
```

#### 5.6.4 Ray 시뮬레이션 — 가시선, 레이더 커버리지

```
// ── 레이더 커버리지 분석 ──

simulation radar_coverage {
  type: ray
  source: radar_stations

  config {
    rays_per_station: 360                    // 1도 간격
    max_range: 200000.0                      // 200km
    ray_step: 100.0                          // 100m 스텝
  }

  input terrain: grid2d<f32>

  // 각 레이에 대한 판정
  trace(origin, direction, max_range) {
    var pos = origin
    var height = origin.z + antenna_height

    for step in 0..max_steps {
      pos += direction * ray_step
      let ground = sample(terrain, pos.xy)
      let earth_curve = earth_curvature(distance(origin.xy, pos.xy))

      // 지형 차폐 판정
      if ground - earth_curve > height {
        return hit(pos, step)                // 지형에 의해 차단
      }

      // 자유 공간 손실
      height -= ray_step * sin(beam_elevation)
    }
    return miss(max_range)
  }

  // 결과를 커버리지 맵으로 합산
  accumulate: grid(resolution: 512 x 512) {
    coverage = max(coverage, signal_strength_at(distance))
  }

  visualize {
    | fill-[coverage | ramp:greens:0,1]
    | opacity-[coverage | step:0.1:0,0.5]
    | blend-multiply
  }
}


// ── 가시선 분석 (Line of Sight) ──

simulation line_of_sight {
  type: ray
  source: observer_positions

  input terrain: grid2d<f32>

  trace(origin, direction, max_range: 30000.0) {
    var max_angle = -90.0                    // 최대 앙각 추적

    for step in 0..max_steps {
      let pos = origin + direction * f32(step) * ray_step
      let ground = sample(terrain, pos.xy)
      let elevation_angle = atan2(
        ground - origin.z - earth_curvature(distance(origin.xy, pos.xy)),
        distance(origin.xy, pos.xy)
      )

      if elevation_angle > max_angle {
        max_angle = elevation_angle
        mark_visible(pos)
      } else {
        mark_hidden(pos)
      }
    }
  }

  visualize {
    | visible:fill-green-500/30
    | hidden:fill-red-500/20
  }
}
```

#### 5.6.5 시뮬레이션 제어 인터페이스

```
// 시뮬레이션 공통 제어 (선언적)
simulation any_sim {
  // ... state, update, visualize ...

  // 시간 제어
  timestep: 16ms                             // 고정 타임스텝 (60fps)
  timestep: adaptive(min: 1ms, max: 100ms)   // 적응형
  speed: 1x                                  // 재생 속도 (호스트에서 변경 가능)

  // 수명 제어
  lifetime: infinite                         // 무한 (기본)
  lifetime: 30s                              // 30초 후 종료
  trigger: on_event("start_sim")             // 이벤트 트리거
  trigger: immediate                         // 즉시 시작 (기본)

  // 경계 조건
  boundary: wrap                             // 반대편으로 순환
  boundary: clamp                            // 경계에서 정지
  boundary: respawn                          // 리스폰
  boundary: destroy                          // 제거
}

// 호스트에서 제어
// map.simulation('oil_spill').speed = 100    // 100배속
// map.simulation('oil_spill').pause()
// map.simulation('oil_spill').reset()
// map.simulation('oil_spill').step()         // 1스텝만 진행
```

#### 5.6.6 내장 함수 (시뮬레이션 표준 라이브러리)

```
// @xgis/sim 표준 라이브러리

// 그리드 연산
laplacian(field)                             // 2차 미분 (확산)
gradient(field)                              // 기울기 벡터
divergence(field)                            // 발산
curl(field)                                  // 회전
advect(field, velocity, dt)                  // 이류 (semi-Lagrangian)
sample(field, position)                      // 쌍선형 보간 샘플링

// 파티클 연산
random(min, max)                             // 균일 분포 난수
random_in_bounds(bbox)                       // 영역 내 랜덤 위치
random_on_sphere(radius)                     // 구면 위 랜덤 방향
respawn()                                    // 파티클 리스폰 (init 재실행)

// 물리 상수/함수
gravity_at(position)                         // 고도별 중력 벡터
atmospheric_drag(position, velocity)         // 대기 저항
sound_speed_in_water(depth)                  // 수심별 음속
earth_curvature(distance)                    // 지구 곡률 보정값
coriolis(latitude, velocity)                 // 코리올리 힘

// 지형 상호작용
terrain_normal(terrain, position)            // 지형 법선
slope(terrain, position)                     // 경사도
aspect(terrain, position)                    // 경사 방향
```

### 5.7 Analysis — GPU 병렬 분석 파이프라인

#### simulation vs analysis

```
simulation: 시간 축이 있다. 매 프레임 상태가 변한다. "t+1 = f(t)"
analysis:   시간 축이 없다. 입력이 바뀌면 재계산한다. "output = f(input)"
            입력 변화가 없으면 결과 캐싱.
```

**analysis는 GPU compute로 컴파일되지만, 개발자는 "무엇을 찾을지"만 서술한다.**

#### 5.7.1 함정 항로 위험 분석 — 전체 예시

```
// ══════════════════════════════════════════
// 항로를 따라 병렬로 위험 요소를 탐색
// ══════════════════════════════════════════

struct Hazard {
  position: vec2<f64>
  type: HazardType
  severity: f32                              // 0~1
  distance_to_route: f32                     // 항로까지 최근접 거리
  description: string
}

enum HazardType : u8 {
  reef          = 0
  shallow       = 1
  wreck         = 2
  restricted    = 3
  traffic       = 4
  current       = 5
  mine_risk     = 6
}

// ── 분석 파이프라인 정의 ──

analysis route_hazard_scan {
  // 입력: 이 중 하나라도 변하면 자동 재분석
  input route: [vec2<f64>]                   // 계획 항로 (경유점 목록)
  input bathymetry: grid2d<f32>              // 수심 데이터
  input chart_objects: [ChartObject]         // 해도 객체 (암초, 침선 등)
  input vessel_draft: f32                    // 함정 흘수
  input safety_margin: f32 = 500.0           // 안전 여유 거리 (m)
  input vessel_beam: f32                     // 함정 선폭

  // 출력: 타입이 지정된 결과
  output hazards: [Hazard]
  output risk_score: f32                     // 전체 위험도 0~1
  output safe_passage: bool
  output min_clearance: f32                  // 최소 여유 수심

  // ── 단계 1: 항로 버퍼 생성 ──
  // 항로를 따라 탐색 영역을 정의
  step buffer_route {
    parallel: per_segment(route)             // 항로의 각 구간을 병렬 처리

    let segment_start = route[segment_index]
    let segment_end = route[segment_index + 1]
    let buffer_width = safety_margin + vessel_beam / 2

    // 이 구간의 탐색 영역 (직사각형 버퍼)
    emit: search_area(segment_start, segment_end, buffer_width)
  }

  // ── 단계 2: 수심 위험 분석 ──
  step depth_analysis {
    parallel: per_cell(search_areas, resolution: 10.0)  // 10m 간격 그리드

    let depth = sample(bathymetry, cell_position)
    let clearance = depth - vessel_draft

    if clearance < 5.0 {                     // UKC 5m 미만
      emit hazard: Hazard {
        position: cell_position
        type: if clearance < 0.0 { HazardType.reef } else { HazardType.shallow }
        severity: 1.0 - clamp(clearance / 5.0, 0.0, 1.0)
        distance_to_route: distance_to_polyline(cell_position, route)
        description: "Depth {depth | format:'0.1'}m, clearance {clearance | format:'0.1'}m"
      }
    }
  }

  // ── 단계 3: 해도 객체 위험 분석 ──
  step chart_object_scan {
    parallel: per_item(chart_objects)         // 각 해도 객체를 병렬 검사

    let dist = distance_to_polyline(item.position, route)

    if dist < safety_margin {
      emit hazard: Hazard {
        position: item.position
        type: match item.category {
          "rock"     => HazardType.reef
          "wreck"    => HazardType.wreck
          "restrict" => HazardType.restricted
          _          => HazardType.reef
        }
        severity: 1.0 - dist / safety_margin
        distance_to_route: dist
        description: "{item.name}: {dist | round}m from route"
      }
    }
  }

  // ── 단계 4: 해류 위험 분석 ──
  step current_analysis {
    parallel: per_segment(route)

    input currents: grid2d<vec2>             // 해류 데이터

    let current_at = sample(currents, segment_midpoint)
    let cross_current = cross_component(current_at, segment_direction)

    if abs(cross_current) > 2.0 {            // 횡류 2노트 이상
      emit hazard: Hazard {
        position: segment_midpoint
        type: HazardType.current
        severity: clamp(abs(cross_current) / 5.0, 0.0, 1.0)
        distance_to_route: 0.0
        description: "Cross current {cross_current | format:'0.1'} kn"
      }
    }
  }

  // ── 단계 5: 결과 집계 ──
  reduce {
    hazards = collect_all(step.*.hazards)     // 모든 단계의 hazard 합산
    risk_score = max(hazards.map(h => h.severity))
    min_clearance = min(depth_analysis.clearances)
    safe_passage = risk_score < 0.7 and min_clearance > 2.0
  }

  // 실행 조건
  trigger: on_change(route, vessel_draft)    // 입력 변경 시 자동 재실행
  cache: true                                // 입력 불변이면 결과 캐싱
}


// ── 분석 결과 시각화 ──

layer hazard_markers {
  source: route_hazard_scan.hazards          // 분석 출력을 소스로 직접 참조

  | symbol-warning  size-[severity * 16 + 8]
  | HazardType.reef:fill-red-500
  | HazardType.shallow:fill-orange-400
  | HazardType.wreck:fill-purple-500
  | HazardType.restricted:fill-yellow-500
  | HazardType.current:fill-cyan-400
  | animate-pulse-[severity * 2 + 0.5]s     // 위험할수록 빠르게 깜빡

  on hover {
    show: tooltip(hazard.description)
  }
}

// 항로 위험도를 색상으로 표시
connection route_risk_overlay {
  points: route_hazard_scan.route
  | line-w-6
  | stroke-[route_segment_risk | ramp:rdylgn_r:0,1]   // 녹→황→적
  | z-order-90
}

// HUD에 위험 요약 표시
overlay hazard_summary {
  anchor: top-center
  margin: 8
  visible: route_hazard_scan.hazards.count > 0

  | [safe_passage]:bg-green-900/80  bg-red-900/80
  | padding-8-24  rounded-8

  children {
    text {
      content: if route_hazard_scan.safe_passage {
        "ROUTE CLEAR - Min clearance {min_clearance | format:'0.1'}m"
      } else {
        "WARNING: {hazards.count} hazards - Risk {risk_score * 100 | round}%"
      }
      | text-16  text-white  text-bold
    }
  }
}
```

#### 5.7.2 analysis 병렬 처리 패턴

```
// ── per_segment: 항로/폴리라인의 각 구간 병렬 ──
step name {
  parallel: per_segment(polyline)
  // segment_index, segment_start, segment_end 자동 바인딩
  // GPU: 1 thread per segment
}

// ── per_cell: 영역을 그리드로 분할하여 셀별 병렬 ──
step name {
  parallel: per_cell(area, resolution: 10.0)
  // cell_position, cell_index 자동 바인딩
  // GPU: 1 thread per grid cell
}

// ── per_item: 데이터 배열의 각 항목 병렬 ──
step name {
  parallel: per_item(array)
  // item, item_index 자동 바인딩
  // GPU: 1 thread per item
}

// ── per_pair: 두 집합의 조합 병렬 (충돌 감지 등) ──
step name {
  parallel: per_pair(set_a, set_b)
  // a, b, a_index, b_index 자동 바인딩
  // GPU: 1 thread per pair (주의: O(n*m))
}

// ── per_ray: 원점에서 방사형 레이 병렬 ──
step name {
  parallel: per_ray(origin, directions: 360, max_range: 50000)
  // ray_origin, ray_direction, ray_index 자동 바인딩
  // GPU: 1 thread per ray
}
```

#### 5.7.3 더 복잡한 분석 — 다단계 파이프라인

```
// ── 기뢰 위협 평가 + 소해 경로 최적화 ──

analysis mine_threat_assessment {
  input survey_data: grid2d<f32>             // 소나 탐색 결과
  input mine_contacts: [Contact]             // 탐지된 접촉물
  input planned_route: [vec2<f64>]
  input vessel_signature: VesselSignature    // 자함 시그니처 (자기, 음향, 압력)

  output threat_map: grid2d<f32>
  output classified_mines: [ClassifiedMine]
  output safe_corridors: [Corridor]
  output recommended_route: [vec2<f64>]

  // 단계 1: 접촉물 분류 (병렬)
  step classify {
    parallel: per_item(mine_contacts)

    let features = extract_features(item.sonar_image)   // 특징 추출
    let classification = match {
      features.aspect_ratio > 2.0 and features.echo_strength > 0.8
        => MineClass.bottom_mine
      features.depth < 10.0 and features.echo_strength > 0.6
        => MineClass.moored_mine
      features.size < 0.5
        => MineClass.debris                              // 비위협
      _ => MineClass.unknown
    }

    emit classified: ClassifiedMine {
      position: item.position
      class: classification
      confidence: features.confidence
      danger_radius: mine_danger_radius(classification, vessel_signature)
    }
  }

  // 단계 2: 위협 맵 생성 (그리드 병렬)
  step build_threat_map {
    parallel: per_cell(domain, resolution: 5.0)          // 5m 해상도

    var threat = 0.0
    // 모든 분류된 기뢰에 대해 위협 기여도 합산
    for mine in classified_mines {
      let dist = distance(cell_position, mine.position)
      if dist < mine.danger_radius * 3.0 {
        let contribution = mine.confidence * exp(-dist * dist /
                          (2.0 * mine.danger_radius * mine.danger_radius))
        threat = max(threat, contribution)
      }
    }
    threat_map[cell_index] = threat
  }

  // 단계 3: 안전 통로 탐색 (병렬 경로 탐색)
  step find_corridors {
    parallel: per_ray(start: planned_route[0],
                      directions: 72,                    // 5도 간격
                      max_range: route_length)

    // 레이를 따라 위협 맵 샘플링
    var corridor_risk = 0.0
    var path: [vec2<f64>]

    for step in 0..max_steps {
      let pos = ray_origin + ray_direction * f32(step) * step_size
      let local_threat = sample(threat_map, pos)

      // 위협 회피: 기울기 반대 방향으로 경로 굴절
      let grad = gradient(threat_map, pos)
      let deflection = -normalize(grad) * local_threat * avoidance_strength
      let adjusted_pos = pos + deflection

      path.push(adjusted_pos)
      corridor_risk = max(corridor_risk, sample(threat_map, adjusted_pos))
    }

    emit corridor: Corridor {
      path: path
      max_risk: corridor_risk
      length: polyline_length(path)
    }
  }

  // 단계 4: 최적 경로 선택
  reduce {
    safe_corridors = collect(step.find_corridors.corridors)
                     .filter(c => c.max_risk < 0.3)
                     .sort_by(c => c.length)

    recommended_route = safe_corridors[0].path           // 가장 짧은 안전 경로
  }

  trigger: on_change(mine_contacts, planned_route)
}


// 시각화
layer threat_heatmap {
  source: mine_threat_assessment.threat_map
  | fill-[value | ramp:reds:0,1]
  | opacity-50
}

layer mine_markers {
  source: mine_threat_assessment.classified_mines
  | symbol-mine  size-12
  | MineClass.bottom_mine:fill-red-500
  | MineClass.moored_mine:fill-orange-500
  | MineClass.unknown:fill-yellow-500
  | MineClass.debris:fill-gray-400  opacity-40
  | animate-pulse-[confidence * 2]s
}

connection safe_route {
  points: mine_threat_assessment.recommended_route
  | line-w-4  stroke-green-400  stroke-dash-10-5
  | glow-4  glow-green-400
  | z-order-95
}

connection original_route {
  points: planned_route
  | line-w-2  stroke-red-400  opacity-40  stroke-dash-5-5
  | z-order-94
}
```

#### 5.7.4 analysis vs simulation vs @compute

```
개념         시간축    트리거              병렬 패턴           상태
─────────   ──────   ───────────────    ──────────────     ──────
simulation   있음     매 프레임           자동 (grid/particle) 유지 (더블버퍼)
analysis     없음     입력 변경 시        step별 선언         없음 (캐싱만)
@compute     없음     명시적 dispatch     수동 workgroup      수동 관리

// analysis의 step은 DAG (방향 비순환 그래프)로 실행:
//   classify ──→ build_threat_map ──→ find_corridors ──→ reduce
//                                                         ↑
//   (step 간 의존성을 컴파일러가 분석하여 병렬 가능한 것은 동시 실행)
```

#### 5.7.5 analysis 표준 함수

```
// @xgis/analysis 표준 라이브러리

// 공간 탐색
distance_to_polyline(point, polyline)        // 점에서 폴리라인까지 최근접 거리
point_on_polyline(polyline, t)               // 폴리라인 위 보간 점 (0~1)
buffer_polygon(polyline, width)              // 버퍼 폴리곤 생성
intersect_polylines(a, b)                    // 교차점 탐색
nearest_k(point, dataset, k)                 // K-최근접 이웃

// 집계
collect_all(step.*.field)                    // 모든 step 결과 합산
count_where(array, condition)                // 조건 만족 개수
min/max/sum/mean(array.field)                // 통계
group_by(array, key_fn)                      // 그룹핑
sort_by(array, compare_fn)                   // 정렬

// 경로
polyline_length(points)                      // 총 경로 길이
polyline_bearing(points, t)                  // t 위치에서의 방위각
subdivide_polyline(points, interval)         // 등간격 세분화
smooth_polyline(points, tension)             // 경로 스무딩
```

### 5.8 Geometry — 벡터 데이터 정의, 생성, 드로잉

#### 핵심 문제

현재 `layer`는 외부 `source`에서 데이터를 받아오기만 한다.
하지만 실제로는:

```
1. 지오메트리를 코드에서 직접 정의하고 싶다       (작전 구역, 경계선)
2. 분석 결과에서 지오메트리를 생성하고 싶다         (버퍼존, 등치선, 볼록 껍질)
3. 사용자가 지도 위에 그리고 싶다                   (드로잉 도구)
4. 여러 소스의 지오메트리를 조합하고 싶다           (교차, 합집합, 차집합)
```

#### 5.8.1 `geometry` 블록 — 인라인 벡터 데이터

GeoJSON처럼 지오메트리를 선언적으로 정의하되, X-GIS 문법으로:

```
// ── 인라인 지오메트리 정의 ──

// 점
geometry naval_base {
  point(127.0deg, 37.5deg)
}

// 라인
geometry patrol_route {
  line [
    (126.5deg, 37.0deg)
    (126.8deg, 37.2deg)
    (127.1deg, 37.5deg)
    (127.3deg, 37.3deg)
  ]
}

// 폴리곤
geometry operation_area {
  polygon [
    (126.0deg, 36.5deg)
    (127.5deg, 36.5deg)
    (127.5deg, 38.0deg)
    (126.0deg, 38.0deg)
  ]
}

// 다중 폴리곤 (홀 포함)
geometry exclusion_zone {
  polygon [
    outer: [
      (126.5deg, 37.0deg)
      (127.0deg, 37.0deg)
      (127.0deg, 37.5deg)
      (126.5deg, 37.5deg)
    ]
    hole: [
      (126.7deg, 37.2deg)
      (126.8deg, 37.2deg)
      (126.8deg, 37.3deg)
      (126.7deg, 37.3deg)
    ]
  ]
}

// 원 (중심 + 반경)
geometry defense_perimeter {
  circle(center: (127.0deg, 37.5deg), radius: 50km)
}

// 호 (부채꼴)
geometry radar_sector {
  arc(
    center: (127.0deg, 37.5deg)
    radius: 200km
    start_bearing: 30deg
    end_bearing: 150deg
  )
}

// 스타일 적용하여 레이어로
layer op_area_display {
  source: operation_area
  | fill-blue-500/20  stroke-blue-400  stroke-2  stroke-dash-10-5
}

layer defense_ring {
  source: defense_perimeter
  | fill-none  stroke-red-500  stroke-2
  | decorate-arrow-50px                       // 방향 표시
}
```

#### 5.8.2 computed geometry — 분석/계산에서 지오메트리 생성

```
import { buffer, convex_hull, voronoi, contour, intersection,
         union, difference } from "@xgis/geo/ops"

// ── 버퍼 존 (항로에서 500m) ──
geometry safe_corridor = buffer(patrol_route, 500m)

layer safe_corridor_display {
  source: safe_corridor
  | fill-green-500/10  stroke-green-400  stroke-1
}


// ── 함대 볼록 껍질 ──
geometry fleet_boundary = convex_hull(fleet_ships.positions)

layer fleet_area {
  source: fleet_boundary
  | fill-blue-300/10  stroke-blue-300  stroke-dash-5-3
}


// ── 보로노이 다이어그램 (관할 구역 자동 분할) ──
geometry jurisdiction = voronoi(
  points: radar_stations.positions
  bounds: operation_area
)

layer jurisdiction_display {
  source: jurisdiction
  | fill-none  stroke-gray-400  stroke-1  stroke-dash-3-3
}


// ── 등치선 (수심, 오염 농도 등) ──
geometry depth_contours = contour(
  data: bathymetry
  levels: [10, 20, 50, 100, 200, 500, 1000]
  unit: m
)

layer depth_lines {
  source: depth_contours
  | stroke-cyan-300  stroke-1
  | label-["{level}m"]  label-along-line  text-10  text-cyan-200
}


// ── 지오메트리 불리언 연산 ──
geometry restricted = union(zone_a, zone_b, zone_c)       // 합집합
geometry clear_area = difference(operation_area, restricted) // 차집합
geometry overlap = intersection(radar_coverage, enemy_zone)  // 교집합

layer clear_area_display {
  source: clear_area
  | fill-green-500/10  stroke-green-400  stroke-1
}


// ── analysis 결과에서 지오메트리 생성 ──

analysis compute_safe_zones {
  input threat_map: grid2d<f32>
  input operation_area: polygon

  output safe_zones: [polygon]
  output risk_contours: [line]

  step extract {
    // 위협도 0.3 이하 영역을 폴리곤으로 추출
    safe_zones = contour_polygon(threat_map, threshold: 0.3, below: true)

    // 위협도 등치선 추출
    risk_contours = contour(threat_map, levels: [0.3, 0.5, 0.7, 0.9])

    // 작전 구역과 교집합
    safe_zones = safe_zones.map(z => intersection(z, operation_area))
  }
}

// 분석 결과 지오메트리를 바로 렌더링
layer safe_zone_overlay {
  source: compute_safe_zones.safe_zones
  | fill-green-500/15  stroke-green-400  stroke-1
}

layer risk_lines {
  source: compute_safe_zones.risk_contours
  | stroke-[level | ramp:rdylgn_r:0,1]  stroke-2
  | label-["{level * 100 | round}%"]  label-along-line
}
```

#### 5.8.3 동적 지오메트리 — 데이터에 반응하여 변하는 도형

```
// ── 엔티티 위치에 따라 실시간 갱신되는 지오메트리 ──

// 함정 주변 작전 반경
geometry ship_range(ship: entity) {
  circle(center: ship.position, radius: ship.weapon_range)
}

// 함정이 이동하면 자동 갱신
layer weapon_range_display {
  source: ship_range(my_ship)
  | fill-red-500/5  stroke-red-400  stroke-1  stroke-dash-10-5
}

// ── 두 엔티티 사이의 동적 도형 ──

// 함정과 목표 사이의 위험 부채꼴
geometry engagement_zone(ship: entity, target: entity) {
  let bearing = bearing_to(ship.position, target.position)
  let dist = geodetic_distance(ship.position, target.position)
  arc(
    center: ship.position
    radius: dist * 1.2
    start_bearing: bearing - 15deg
    end_bearing: bearing + 15deg
  )
}

layer engagement_display {
  source: engagement_zone(my_ship, tracked_target)
  | fill-red-500/20  stroke-red-500  stroke-2
  visible: tracked_target != none
}


// ── 집합 데이터에서 실시간 지오메트리 ──

// 모든 적 함정의 무기 사거리 합집합 → 위험 구역
geometry enemy_threat_envelope = union(
  for ship in enemy_ships {
    circle(center: ship.position, radius: ship.weapon_range)
  }
)

layer threat_envelope {
  source: enemy_threat_envelope
  | fill-red-500/10  stroke-red-500  stroke-1
  | animate-pulse-3s
}
```

#### 5.8.4 인터랙티브 드로잉 — 사용자가 지도 위에 그리기

```
// ── 드로잉 도구 선언 ──

draw_tool waypoint_placer {
  type: point
  on_place(position) {
    emit: "waypoint_added"(position)
    // 호스트에서: map.on('waypoint_added', (pos) => { ... })
  }
  | symbol-pin  size-16  fill-cyan-400
  | cursor-crosshair
}

draw_tool area_selector {
  type: polygon
  on_complete(polygon) {
    // 그려진 영역으로 분석 실행
    run: route_hazard_scan(route: polygon.boundary)
    emit: "area_selected"(polygon)
  }
  | fill-yellow-500/10  stroke-yellow-400  stroke-2  stroke-dash-5-5
  | vertex-circle-4  vertex-fill-white
  | cursor-crosshair
}

draw_tool measurement {
  type: line
  on_update(points) {
    // 실시간 거리 표시
    let total = polyline_length_geodetic(points)
    show: tooltip("{total | nm | format:'0.0'} NM")
  }
  on_complete(line) {
    emit: "measurement_complete"(line, polyline_length_geodetic(line))
  }
  | stroke-yellow-300  stroke-2
  | decorate-distance-labels                  // 구간별 거리 라벨 자동
  | vertex-circle-4  vertex-fill-yellow-300
}

draw_tool bearing_line {
  type: line
  max_points: 2                               // 시작점, 끝점만
  on_update(points) {
    let brg = bearing_to(points[0], points[1])
    let dist = geodetic_distance(points[0], points[1])
    show: tooltip("{brg | round}° / {dist | nm | format:'0.0'} NM")
  }
  | stroke-green-300  stroke-2
}

// 호스트에서 드로잉 도구 활성화
// map.activateTool('area_selector')
// map.activateTool('measurement')
// map.deactivateTool()
```

#### 5.8.5 GeoJSON 호환

```
// GeoJSON 직접 소스로 사용
source my_geojson {
  type: geojson
  data: "./data/zones.geojson"
}

// 또는 인라인 (소규모 데이터)
source inline_points {
  type: geojson
  data: {
    "type": "FeatureCollection",
    "features": [...]
  }
}

// 호스트에서 GeoJSON 주입
// map.addGeoJSON('dynamic_zones', geojsonObject)

// X-GIS geometry를 GeoJSON으로 내보내기
// const geojson = map.geometry('operation_area').toGeoJSON()
```

#### 5.8.6 전체 흐름 — analysis → geometry → rendering

```
// 전체 파이프라인이 연결되는 예시:

// 1. 데이터
input fleet: [Ship]
input enemy: [Ship]
input bathymetry: grid2d<f32>

// 2. 분석
analysis threat_assessment {
  step ... → output threat_map, classified_threats
}

// 3. 분석 → 지오메트리 생성
geometry safe_zones = contour_polygon(threat_assessment.threat_map, threshold: 0.3, below: true)
geometry enemy_envelope = union(for e in enemy { circle(e.position, e.weapon_range) })
geometry safe_corridor = difference(safe_zones, enemy_envelope)

// 4. 지오메트리 → 추가 분석
analysis corridor_optimization {
  input corridor: safe_corridor
  input fleet_position: fleet[0].position
  input destination: target_port
  step find_route { ... }
  output optimal_route: [vec2<f64>]
}

// 5. 모든 결과 렌더링
layer threat_heat    { source: threat_assessment.threat_map  | fill-[value|ramp:reds] opacity-40 }
layer safe_overlay   { source: safe_corridor  | fill-green-500/15  stroke-green-400 }
layer enemy_zones    { source: enemy_envelope  | fill-red-500/10  stroke-red-400 }
connection opt_route { points: corridor_optimization.optimal_route  | line-w-4  stroke-cyan-400 }

// 6. 사용자 인터랙션
draw_tool edit_route {
  type: line
  initial: corridor_optimization.optimal_route   // 최적 경로를 편집 가능
  on_update(points) {
    // 수정된 경로로 재분석 트리거
    run: route_hazard_scan(route: points)
  }
}
```

### 5.9 Animation — 게임 엔진 수준이 필요한가?

#### 5.9.1 GIS 애니메이션 vs 게임 애니메이션

```
GIS에서의 "애니메이션"                    게임 엔진에서의 "애니메이션"
─────────────────────                    ─────────────────────────
함정이 A에서 B로 이동한다                  캐릭터가 걷는다 (스켈레탈)
데이터가 업데이트되면 부드럽게 전환          폭발 이펙트 (파티클 + 메시 변형)
레이더 스윕이 회전한다                      얼굴 표정이 변한다 (모프 타깃)
경고 아이콘이 깜빡인다                      카메라가 시네마틱 경로를 따른다
과거 항적을 재생한다                        래그돌 물리

→ 대부분 "데이터의 시간적 보간"             → 대부분 "아티스트가 만든 키프레임"
```

**결론: 언리얼 전체를 구현할 필요는 없지만, 4가지 애니메이션 시스템은 필수.**

```
1. state    — 상태 머신 (평시→경계→교전, 각 상태별 비주얼)
2. timeline — 시간 축 재생/녹화 (항적 리플레이, 이벤트 재현)
3. motion   — 데이터 보간 (위치, 속성의 부드러운 전환)
4. model    — 3D 모델 내장 애니메이션 제어 (로터 회전 등)

선택적:
5. keyframe — 수동 키프레임 (훈련 시나리오, 브리핑용 시각화)
6. camera   — 카메라 경로 (시찰, 프레젠테이션)
```

#### 5.9.2 `state` — 상태 머신

**엔티티의 비주얼이 상태에 따라 바뀌고, 전환이 부드러운 것:**

```
// 상태 정의
state_machine ship_combat_state {
  // 상태 선언
  state idle {
    | symbol-ship  fill-blue-400  stroke-blue-300
    | size-12
  }

  state alert {
    | symbol-ship  fill-yellow-400  stroke-yellow-300
    | size-14
    | animate-pulse-2s                       // 경계 상태에서 펄싱
    | glow-4  glow-yellow-300
  }

  state engaged {
    | symbol-ship  fill-red-500  stroke-red-400
    | size-16
    | animate-pulse-500ms                    // 빠른 펄싱
    | glow-8  glow-red-500
  }

  state damaged {
    | symbol-ship  fill-red-800  stroke-red-600
    | size-14  opacity-70
    | animate-shake-200ms                    // 흔들림
  }

  // 전환 규칙 (선언적)
  transition idle -> alert {
    when: threat_level > 0.3
    duration: 500ms
    easing: ease-out
    // 중간 상태: 색상/크기가 보간됨
  }

  transition alert -> engaged {
    when: threat_level > 0.7 or under_attack
    duration: 200ms
    easing: ease-in
  }

  transition any -> damaged {
    when: hull_integrity < 0.5
    duration: 100ms
  }

  transition damaged -> idle {
    when: hull_integrity > 0.8 and threat_level < 0.1
    duration: 2000ms                         // 느리게 회복
  }
}

// 엔티티에 상태 머신 적용
entity warship(data: ShipTrack) {
  position: data.position
  heading: data.heading
  model: ship_model

  state: ship_combat_state(
    threat_level: data.threat_level
    under_attack: data.under_attack
    hull_integrity: data.hull_integrity
  )
}
```

#### 5.9.3 `timeline` — 시간 축 재생

**과거 데이터를 시간순으로 재생, 분석 목적의 리플레이:**

```
// ── 항적 리플레이 ──

timeline track_replay {
  source: historical_tracks                  // 타임스탬프가 있는 데이터
  time_field: timestamp                      // 시간 필드 지정

  // 재생 제어
  range: 2026-04-01T00:00Z .. 2026-04-09T23:59Z
  speed: 60x                                 // 60배속
  loop: false

  // 보간: 데이터 포인트 사이를 부드럽게
  interpolation {
    position: cubic_spline                   // 위치는 스플라인 보간
    heading: angular_lerp                    // 각도는 최단 경로 보간
    speed: linear                            // 속도는 선형
  }

  // 시간에 따른 트레일
  trail {
    duration: 30min                          // 최근 30분 궤적
    | stroke-2  opacity-fade-out
    | stroke-[speed | ramp:viridis]          // 속도에 따른 색상
  }

  // 미래 예측 (현재 속도/방향으로 외삽)
  prediction {
    duration: 10min
    | stroke-1  stroke-dash-5-5  opacity-40
  }
}

// 타임라인 UI
overlay timeline_control {
  anchor: bottom
  height: 60
  width: 100%

  | bg-black/80  padding-8

  bind: track_replay                         // 타임라인에 바인딩

  children {
    // 타임라인 슬라이더 (엔진 내장 위젯)
    timeline_slider {
      | height-4  bg-gray-700  track-green-400
      | marker-events                        // 이벤트 발생 시점에 마커
    }

    // 재생 컨트롤
    button play    { on click { track_replay.toggle_play() } }
    button speed   { on click { track_replay.cycle_speed([1, 10, 60, 600]) } }
    text { content: "{track_replay.current_time | datetime:'HH:mm:ss'}" }
    text { content: "{track_replay.speed}x" }
  }
}

// ── 이벤트 기반 타임라인 ──

timeline incident_replay {
  events: incident_log                       // 이벤트 로그

  // 각 이벤트에 비주얼 액션 매핑
  on_event "contact_detected" {
    spawn: entity(contact_marker, at: event.position)
    camera: fly_to(event.position, zoom: 14, duration: 2s)
    | flash-yellow-500-500ms
  }

  on_event "weapon_fired" {
    run: simulation(explosion_debris, at: event.position)
    | flash-red-500-200ms
    | screen-shake-300ms
  }

  on_event "status_change" {
    // 엔티티 상태 변경은 state machine이 처리
    annotate: "{event.entity_name}: {event.new_status}"
  }
}
```

#### 5.9.4 `motion` — 데이터 보간 (이미 대부분 자동)

```
// 위치 데이터가 업데이트되면 텔레포트 vs 부드러운 이동

entity ship(data: ShipTrack) {
  position: data.position
  heading: data.heading

  // 보간 설정 (선언적)
  motion {
    position: smooth(duration: 1s, easing: ease-out)  // 1초에 걸쳐 부드럽게
    heading: angular(duration: 500ms)                  // 각도 보간 (최단 경로)
    speed: linear(duration: 300ms)
  }

  // 또는 유틸리티 문법
  | motion-smooth-1s                         // 전체 속성 1초 보간
  | motion-position-cubic-2s                 // 위치만 큐빅 보간 2초
}

// 보간 모드
motion {
  position: instant                          // 즉시 (텔레포트)
  position: linear(duration)                 // 선형 보간
  position: smooth(duration, easing)         // 이징 보간
  position: cubic_spline(duration)           // 스플라인 (부드러운 곡선 경로)
  position: predictive(duration)             // 현재 속도/가속도로 예측 보간

  heading: angular(duration)                 // 각도 전용 (최단 경로, 360도 래핑)
}
```

#### 5.9.5 `model_anim` — 3D 모델 내장 애니메이션 제어

**glTF 모델에 내장된 애니메이션을 데이터에 바인딩:**

```
model helicopter {
  src: "./assets/uh60.glb"

  // 모델에 포함된 애니메이션 목록 (glTF에서 자동 검출)
  // - "rotor_spin"
  // - "tail_rotor"
  // - "door_open"
  // - "landing_gear"
}

entity helo(data: HeloTrack) {
  position: data.position
  model: helicopter

  // 모델 애니메이션을 데이터/상태에 바인딩 (선언적)
  model_anim {
    // 로터: 엔진 상태에 따라 속도 조절
    "rotor_spin" {
      play: data.engine_on
      speed: data.rotor_rpm / 300.0          // RPM에 비례
    }

    "tail_rotor" {
      play: data.engine_on
      speed: data.rotor_rpm / 250.0
    }

    // 문: 상태에 따라 열고 닫기
    "door_open" {
      play: data.doors_open
      speed: 1.0
      clamp: true                            // 끝에서 멈춤 (반복 안 함)
    }

    // 착륙 기어: 고도에 따라
    "landing_gear" {
      progress: clamp(1.0 - data.altitude / 50.0, 0.0, 1.0)
      // 고도 50m 이하에서 점진적으로 기어 내림
    }
  }

  state: helo_state_machine(...)
  motion { position: cubic_spline(1s) }
}
```

#### 5.9.6 `keyframe` — 수동 애니메이션 (훈련/브리핑용)

```
// ── 훈련 시나리오 스크립트 ──

keyframe_sequence briefing_scenario {
  // 시간 기반 키프레임 시퀀스

  at 0s {
    camera: { center: (127deg, 37.5deg), zoom: 8, pitch: 0 }
    annotation: "작전 개요"
  }

  at 3s {
    camera: { center: (127deg, 37.5deg), zoom: 12, pitch: 45, duration: 2s }
    show: layer(operation_area)
    annotation: "작전 구역 확인"
  }

  at 8s {
    spawn: entity(enemy_fleet, at: (128deg, 37deg))
    annotation: "적 함대 출현"
    | flash-red-500-1s
  }

  at 12s {
    run: analysis(route_hazard_scan)
    camera: follow(my_ship, distance: 5km, duration: 3s)
    annotation: "항로 위험 분석 시작"
  }

  at 18s {
    run: simulation(ballistic_trajectory, from: enemy_fleet)
    annotation: "적 미사일 발사"
    | screen-shake-500ms
  }

  at 25s {
    camera: { center: result_area, zoom: 14, pitch: 60, duration: 3s }
    show: layer(threat_heat)
    annotation: "결과 분석"
  }

  // 제어
  duration: 30s
  on_complete: pause                         // 끝나면 일시정지
}

// 호스트에서 제어
// map.play('briefing_scenario')
// map.pause()
// map.seek(12)  // 12초 지점으로
```

#### 5.9.7 `camera` — 카메라 애니메이션

```
// ── 카메라 프리셋 ──

camera_action fly_to(target: vec2<f64>, zoom: f32 = 14, duration: f32 = 2s) {
  // 현재 위치에서 목표까지 부드러운 비행
  easing: ease-in-out
  // 줌 아웃 → 이동 → 줌 인 (구글 어스 스타일)
  path: ballistic(peak_zoom: min(current_zoom, zoom) - 2)
}

camera_action follow(entity: entity, distance: f32 = 10km, offset: vec3 = vec3(0)) {
  // 엔티티를 추적, 일정 거리 유지
  tracking: smooth(lag: 0.5s)
  heading: match_entity                      // 엔티티 heading에 맞춤
}

camera_action orbit(center: vec2<f64>, radius: f32, speed: f32 = 10deg/s) {
  // 중심점을 공전
  pitch: 45deg
  loop: true
}

camera_action cinematic_path(waypoints: [CameraKeyframe]) {
  // 수동 경로
  interpolation: cubic_spline
}

// 사용
on click(layer: tracks) {
  camera: fly_to(event.feature.position, zoom: 14, duration: 1.5s)
}

on double_click(entity: submarine) {
  camera: follow(submarine, distance: 2km)
}

// 키프레임에서
at 5s { camera: orbit(base_position, radius: 5km, speed: 15deg/s) }
```

#### 5.9.8 필요한 것 vs 과한 것 — 최종 판단

```
                           X-GIS 제공?   이유
                           ──────────    ──────
필수:
  상태 머신 (state)         ✓            군사 엔티티의 핵심 개념
  데이터 보간 (motion)      ✓            실시간 추적의 기본
  타임라인 재생 (timeline)  ✓            사후 분석, 훈련 필수
  카메라 애니메이션          ✓            UX 기본

필요:
  모델 애니메이션 제어       ✓ (바인딩만)  glTF 내장 애니메이션 재생/속도 제어
  키프레임 시퀀스            ✓ (단순)     훈련/브리핑 시나리오
  화면 효과 (shake, flash)  ✓ (유틸리티)  경고/이벤트 피드백

불필요:
  스켈레탈 리깅/본 편집     ✗            3D 도구(Blender)의 역할
  모프 타깃                 ✗            GIS에서 불필요
  래그돌 물리               ✗            게임 전용
  시네마틱 시퀀서            ✗            영상 도구의 역할
  IK / FK                  ✗            로봇/캐릭터 전용
  파티클 에디터 GUI          ✗            simulation으로 대체

전략:
  X-GIS는 "애니메이션 엔진"이 아니라 "데이터 기반 동적 시각화 엔진"이다.
  애니메이션은 데이터 변화의 부드러운 표현이지, 아티스트의 창작물이 아니다.
  3D 모델 자체의 애니메이션은 glTF에 맡기고, X-GIS는 바인딩만 한다.
```

---

### 5.10 Entity, Overlay, Interaction — 애플리케이션 수준 기능

지도 애플리케이션은 "데이터 레이어 스타일링"만으로 완성되지 않는다.
**5가지 누락된 관심사:**

```
관심사             비유                    좌표계
──────────────    ────────────────       ──────────
layer (기존)       데이터 시각화           지리 좌표 (WGS84)
entity             개별 객체 (3D 모델 등)  지리 좌표
connection         객체 간 관계선          지리 좌표 (동적)
annotation         텍스트/마커             지리 좌표
overlay            HUD / 계기판 UI        화면 좌표 (픽셀)
widget             호스트 UI 임베딩        화면 좌표 (DOM/Qt)
```

#### 5.10.1 Entity — 개별 객체 (3D 모델, 인터랙션)

`layer`는 동질적 데이터 컬렉션. `entity`는 **개별 식별 가능한 객체**:

```
// ── 잠수함 엔티티 정의 ──

import { submarine_model } from "@xgis/models/naval"
// 또는 glTF 직접 로드
model submarine_mesh {
  src: "./assets/submarine.glb"
  scale: 1.0
}

entity submarine(data: SubmarineTrack) {
  // 위치: 데이터 바인딩
  position: data.position                    // WGS84
  altitude: data.depth * -1                  // 수심 → 음수 고도
  heading: data.heading
  pitch: data.pitch

  // 3D 모델
  model: submarine_mesh

  // 스타일 유틸리티 (모델에 적용)
  | scale-[data.length / 100]
  | friendly:tint-blue-300  hostile:tint-red-400
  | selected:outline-yellow-400  selected:outline-2

  // 인터랙션 정의
  on right_click {
    show: submarine_info_panel(data)         // 패널 표시
  }

  on hover {
    show: tooltip("{data.name}\nDepth: {data.depth}m\nSpeed: {data.speed}kn")
  }

  on click {
    select: toggle                           // 선택 토글
    camera: focus(data.position, distance: 5000)  // 카메라 이동
  }

  // 가시성 조건
  visible: zoom >= 8 and data.is_active
}

// ── 호스트에서 엔티티 데이터 주입 ──
// TypeScript:
// map.set('submarine_tracks', trackArrayBuffer)
// map.entity('submarine').update(42, { depth: -120, speed: 15 })

input submarine_tracks: [SubmarineTrack]

// 엔티티를 데이터 배열에 바인딩 → 자동으로 N개 인스턴스 생성
bind submarine to submarine_tracks
```

#### 5.10.2 Connection — 객체 간 동적 관계선

```
// 여러 객체 상태에 따라 연결선 그리기

struct Link {
  from_id: u32
  to_id: u32
  link_type: LinkType
  signal_strength: f32
}

enum LinkType : u8 {
  communication = 0
  targeting     = 1
  escort        = 2
}

input links: [Link]

// 엔티티 간 연결
connection data_links {
  source: links
  from: entities[from_id].position           // 엔티티 위치 참조
  to: entities[to_id].position

  // 라인 스타일 — 유틸리티
  | line-w-2
  | LinkType.communication:stroke-green-400  stroke-dash-5-3
  | LinkType.targeting:stroke-red-500        stroke-solid
  | LinkType.escort:stroke-blue-400          stroke-dash-10-5
  | opacity-[signal_strength]

  // 연결선 위 장식
  | decorate-arrow-50px
  | label-["{signal_strength * 100 | round}%"]  label-center

  // 인터랙션
  on click {
    show: link_detail_panel(data)
  }

  on hover {
    | stroke-w-4  glow-4                     // 호버 시 강조
  }

  // 애니메이션 (데이터 흐름 표시)
  | animate-dash-flow(speed: 2.0)            // 대시가 흐르는 효과
}
```

#### 5.10.3 Annotation — 특정 위치 텍스트/마커

```
// 정적 어노테이션
annotation base_label {
  position: geodetic(127.0deg, 37.5deg)
  text: "Naval Base Alpha"
  | text-16  text-white  text-bold
  | bg-black/70  padding-4-8  rounded-4
  | z10:visible  z0:hidden
}

// 데이터 기반 어노테이션
annotation waypoint_labels {
  source: waypoints

  position: property(position)
  text: "{property(name)}\n{property(altitude)}m"

  | text-12  text-white
  | bg-slate-800/80  padding-2-6  rounded-2
  | stroke-slate-600  stroke-1
  | anchor-bottom  offset-y-[-12]            // 심볼 위에 배치

  // 충돌 회피
  collision: auto                            // 겹치면 우선순위 낮은 것 숨김
  priority: property(importance)
}

// 동적 텍스트 (매 프레임 갱신)
annotation distance_readout {
  // 두 엔티티 간 거리를 실시간 표시
  position: midpoint(entity_a.position, entity_b.position)
  text: "{geodetic_distance(entity_a.position, entity_b.position) / 1000 | round}km"

  | text-14  text-yellow-300  text-bold
  | bg-black/50  padding-2-8
}
```

#### 5.10.4 Overlay — 화면 고정 HUD (군사용 UI)

`overlay`는 **화면 좌표계**에 렌더링. 지도 이동/줌에 영향 받지 않음:

```
// ── 함정 전투 정보 체계 HUD ──

overlay compass_rose {
  // 화면 좌상단 배치
  anchor: top-right
  margin: 16

  // 형상 (SVG 설명)
  symbol {
    circle cx: 0  cy: 0  r: 60
    path "M 0 -55 L -5 -45 L 5 -45 Z"       // 북쪽 삼각형
    // ... 눈금 등
  }

  // 함정 선수 방향에 따라 회전
  rotate: ship.heading

  // 스타일
  | fill-none  stroke-green-400  stroke-1
  | text-green-400  text-12

  // 하위 요소
  children {
    text { content: "N"  y: -48  | text-10  text-green-300 }
    text { content: "{ship.heading | round}°"  y: 20  | text-14  text-green-400  text-bold }
    text { content: "SPD {ship.speed | round} KN"  y: 35  | text-10  text-green-300 }
  }
}

overlay ship_status_bar {
  anchor: bottom
  width: 100%
  height: 48

  | bg-black/85  border-top-green-800  border-1

  layout: row  gap: 24  padding: 8-16  align: center

  children {
    // 각 항목은 화면 고정 텍스트
    text { content: "HDG {ship.heading | round}°"  | text-14  text-green-400 }
    text { content: "SPD {ship.speed | format:'0.0'} KN"  | text-14  text-green-400 }
    text { content: "LAT {ship.lat | dms}"  | text-12  text-green-300 }
    text { content: "LON {ship.lon | dms}"  | text-12  text-green-300 }
    text { content: "DEPTH {ship.depth}m"  | text-12  text-cyan-400 }

    // 상태 표시등
    indicator {
      | circle-8
      | [ship.radar_active]:fill-green-500  fill-red-500
    }
    text { content: "RADAR"  | text-10  text-gray-400 }
  }
}

// 진북 기준 회전 표시
overlay true_north_indicator {
  anchor: top-left
  margin: 16

  symbol {
    // 배의 현재 방향 대비 진북 표시
    path "M 0 -40 L -8 0 L 8 0 Z"           // 삼각형 화살표
  }

  // 진북과 선수 방향의 차이만큼 회전
  rotate: -ship.heading                      // 지도가 회전해도 진북을 가리킴

  | fill-red-500/80  stroke-white  stroke-1
  children {
    text { content: "TN"  y: -50  | text-10  text-red-300 }
  }
}

// 경고/알림 오버레이
overlay alert_banner {
  anchor: top-center
  margin: 8
  visible: alerts.count > 0

  | bg-red-900/90  padding-8-24  rounded-8
  | animate-pulse-2s

  children {
    text {
      content: "WARNING: {alerts.latest.message}"
      | text-16  text-white  text-bold
    }
  }
}
```

#### 5.10.5 Widget — 호스트 UI 프레임워크 연동

스프레드시트, 차트, 폼 같은 복잡한 UI는 X-GIS로 만들지 않는다.
대신 호스트 UI 프레임워크(React, Qt, WPF)로의 **브릿지**를 제공:

```
// X-GIS에서 위젯 슬롯 선언
widget track_table {
  anchor: bottom-right
  width: 400
  height: 300

  // 호스트 프레임워크에 전달할 데이터 바인딩
  props {
    tracks: visible_tracks                   // 현재 화면에 보이는 트랙
    selected: selected_entity_id             // 선택된 엔티티
    on_row_click: fn(id) { select(id) }     // 콜백
  }
}

// 호스트(TypeScript + React)에서 위젯 구현
// map.registerWidget('track_table', TrackTableComponent)

// React 컴포넌트
function TrackTableComponent({ tracks, selected, on_row_click }) {
  return (
    <DataGrid
      rows={tracks}
      selectedRow={selected}
      onRowClick={(id) => on_row_click(id)}
      columns={[
        { field: 'name', header: 'Name' },
        { field: 'speed', header: 'Speed (kn)' },
        { field: 'heading', header: 'HDG' },
      ]}
    />
  )
}

// Qt/C++에서도 동일한 인터페이스
// map.registerWidget("track_table", new TrackTableWidget());
```

**widget은 X-GIS 렌더링 위에 호스트 UI를 오버레이하는 투명 레이어.**
데이터 바인딩과 콜백만 X-GIS가 관리하고, 실제 렌더링은 호스트가 담당.

#### 5.10.6 전체 좌표계/렌더링 스택

```
┌─────────────────────────────────────────────────────┐
│  widget (DOM / Qt / WPF)        ← 호스트 UI 프레임워크 │
├─────────────────────────────────────────────────────┤
│  overlay (화면 좌표)             ← X-GIS GPU 렌더링    │
│    compass, HUD, alerts                              │
├─────────────────────────────────────────────────────┤
│  annotation (지리 좌표 → 화면)   ← X-GIS GPU 렌더링    │
│    labels, tooltips                                  │
├─────────────────────────────────────────────────────┤
│  connection (지리 좌표)          ← X-GIS GPU 렌더링    │
│    entity 간 연결선                                   │
├─────────────────────────────────────────────────────┤
│  entity (지리 좌표)              ← X-GIS GPU 렌더링    │
│    3D 모델, 개별 객체                                  │
├─────────────────────────────────────────────────────┤
│  layer (지리 좌표)               ← X-GIS GPU 렌더링    │
│    벡터 타일, 래스터, 지형                              │
├─────────────────────────────────────────────────────┤
│  X-GIS Engine                                        │
│    Quadtree, 3D Tiles, Projection, WebGPU            │
└─────────────────────────────────────────────────────┘
```

#### 5.10.7 인터랙션 모델 — 통합

모든 렌더링 요소(layer, entity, connection, annotation, overlay)가 동일한 인터랙션 모델:

```
// 공통 이벤트 — 어디서든 동일한 문법

on click      { ... }     // 좌클릭
on right_click { ... }    // 우클릭 → 컨텍스트 메뉴
on hover      { ... }     // 마우스 진입
on hover_end  { ... }     // 마우스 이탈
on drag       { ... }     // 드래그 (entity 이동 등)
on double_click { ... }   // 더블클릭

// 이벤트 컨텍스트
on click {
  event.position           // 클릭 지점 (지리 좌표)
  event.screen_position    // 클릭 지점 (화면 좌표)
  event.feature            // 클릭된 피처 데이터
  event.entity             // 클릭된 엔티티 (entity일 때)
  event.layer              // 소속 레이어
}

// 응답 액션 (선언적)
on click {
  select: toggle                             // 선택 토글
  camera: fly_to(event.position, zoom: 14)   // 카메라 이동
  show: popup(template: "info.html")         // 팝업
  emit: "track_selected"(event.feature.id)   // 커스텀 이벤트 발행
}

on right_click {
  show: context_menu [                       // 컨텍스트 메뉴
    "Info"       => show: info_panel(event.feature)
    "Follow"     => camera: track(event.entity)
    "Delete"     => emit: "delete_request"(event.entity.id)
    "---"                                    // 구분선
    "Properties" => show: widget.property_editor(event.feature)
  ]
}

// 드래그로 엔티티 이동
entity draggable_marker(data: Waypoint) {
  position: data.position
  | symbol-pin  size-24  fill-red-500

  on drag {
    data.position = event.position           // 위치 업데이트
    emit: "waypoint_moved"(data.id, event.position)
  }
}
```

---

## 6. Compilation Pipeline (개정 — 자립형)

### 6.1 전체 파이프라인

```
.xgis + .xgs + .xgl + @xgis/core (표준 라이브러리, X-GIS로 작성됨)
       │
       ▼
   [Parser]  ─────── 문법 분석, AST 생성
       │                (Level A gpu.* 호출 + Level B 유틸리티 모두 파싱)
       ▼
   [Type Checker] ── 타입 검증, GPU 리소스 타입 검증
       │                (gpu.Buffer, gpu.Texture 등의 타입 안전성)
       ▼
   [Utility Lowering] ── Level B → Level A 변환
       │                   | fill-red-500 → render_fill(RED_500, ...) 호출로 변환
       │                   | point-circle → render_circles(...) 호출로 변환
       ▼
   [Analyzer] ────── 정적 분석: 상수 폴딩, 데드 코드 제거,
       │              셰이더 함수 추출, GPU 리소스 최적화
       ▼
   [IR Generation] ─ 2종류의 IR 생성:
       │              (a) Host IR: CPU 측 코드 (버퍼 관리, 렌더 루프)
       │              (b) Shader IR: GPU 측 코드 (@vertex, @fragment, @compute)
       │
       ├──────────────────┬──────────────────┐
       ▼                  ▼                  ▼
   [WebGPU Target]    [Vulkan Target]    [Metal Target]
   Host: WASM/JS      Host: 네이티브     Host: 네이티브
   Shader: WGSL       Shader: SPIR-V    Shader: MSL
       │                  │                  │
       ▼                  ▼                  ▼
   브라우저            Linux/Win/Android  macOS/iOS
```

### 6.2 핵심 변경: Utility Lowering 단계

```
이전: 유틸리티 → WGSL 직접 생성
현재: 유틸리티 → @xgis/core 함수 호출 → (그 함수 안의 gpu.* 코드가) → WGSL 생성

예시:
  | fill-red-500  stroke-2  point-circle  size-8

  → Utility Lowering 후:
    @xgis/core.render_circles(ctx, positions, sizes=[8], colors=[RED_500], ...)
    @xgis/core.render_strokes(ctx, positions, width=2, ...)

  → @xgis/core 함수 내부의 gpu.* 호출이 최종 GPU 코드로 컴파일

이것은 Zig의 std가 OS syscall 위에 구축되는 것과 동일한 패턴.
println()이 write() syscall로 lowering되듯,
fill-red-500이 gpu.render_pass() + gpu.draw()로 lowering됨.
```

### 6.3 셀프 부트스트래핑 경로

```
Phase 1 (현재): 컴파일러는 Rust/TypeScript로 작성
               @xgis/core는 X-GIS로 작성
               → 엔진은 자립적이지만 컴파일러는 외부 언어

Phase 2 (중기): 컴파일러의 일부를 X-GIS로 재작성
               (파서, 타입체커 등 CPU 로직)

Phase 3 (장기): 컴파일러 전체를 X-GIS로 셀프 부트스트래핑
               (Rust가 Rust로 컴파일되듯)
```

---

## 7. Data Model & Module System (데이터 모델 및 모듈 시스템)

### 7.1 핵심 문제

WebGPU에서 데이터를 GPU에 전달하는 방법은 세 가지이며, 각각 한계가 다르다:

| 메커니즘 | 최대 크기 | 접근 패턴 | 적합한 용도 |
|---|---|---|---|
| **Uniform Buffer** | 64KB (보장 16KB) | 전체 드로우콜에 동일 | 뷰 행렬, 줌, 시간 등 글로벌 값 |
| **Storage Buffer** | 128MB~2GB | 인덱스로 랜덤 접근 | 인스턴스 데이터 배열, 피처 속성 |
| **Data Texture** | 8192x8192 (보장) | 텍셀 좌표로 접근, 하드웨어 필터링 | 대규모 인스턴스, 룩업 테이블, 히트맵 |

**문제**: 개발자가 이 구분을 알아야 하는가?

**X-GIS의 답**: **아니다.** 언어가 데이터의 **의미**를 선언하면, 컴파일러가 **백킹 전략**을 결정한다.

### 7.2 데이터 바인딩 모델 — `input` / `uniform` / `buffer`

```
// ── 글로벌 유니폼 (자동으로 uniform buffer) ──
// 프레임마다 변하는 값. 엔진이 자동 제공하는 것도 있음.
uniform time: f32          // 엔진 자동 제공
uniform zoom: f32          // 엔진 자동 제공
uniform custom_threshold: f32 = 0.5   // 외부에서 주입 가능, 기본값 있음

// ── 외부 주입 데이터 (컴파일러가 backing 결정) ──
// 호스트(JS/C++)에서 동적으로 밀어넣는 데이터
input tracks: [Track]      // Track 스키마의 배열 → 컴파일러가 결정
input heatmap_weights: texture2d<f32>   // 명시적 텍스처 힌트
input color_ramp: sampler1d<rgba>       // 1D 색상 룩업 텍스처

// ── 스키마 정의 ──
struct Track {
  position: vec2<f64>     // WGS84 경위도
  altitude: f32
  speed: f32
  heading: f32
  id: u32
  classification: u8
}
```

### 7.3 컴파일러의 백킹 전략 결정

컴파일러가 `input`의 타입과 사용 패턴을 분석하여 자동 결정:

```
                          컴파일 타임 분석
                               │
                     ┌─────────┼─────────┐
                     ▼         ▼         ▼
                  스칼라?    배열?     텍스처 힌트?
                     │         │         │
                     ▼         ▼         ▼
                  Uniform   크기 분석    Data Texture
                  Buffer       │         (명시적)
                          ┌────┴────┐
                          ▼         ▼
                     ≤64KB?     >64KB?
                          │         │
                          ▼         ▼
                     Storage    Data Texture
                     Buffer     (자동 인코딩)
```

**규칙**:
1. 스칼라/작은 구조체 → **Uniform Buffer**
2. 배열, 크기 ≤ 디바이스 storage buffer 제한 → **Storage Buffer**
3. 배열, 크기 > 제한 또는 2D 접근 패턴 → **Data Texture** (자동 인코딩)
4. 명시적 `texture2d`, `sampler1d` 힌트 → **Data Texture** (그대로)
5. 필터링이 필요한 접근 (보간) → **Data Texture** (하드웨어 필터링 활용)

**개발자는 데이터의 의미만 선언**하고, WebGPU의 `@group/@binding`, 버퍼 생성, 텍스처 인코딩은 컴파일된 코드가 처리한다.

### 7.4 외부 동적 데이터 주입

호스트 언어(JS/C++)에서 X-GIS 런타임에 데이터를 밀어넣는 인터페이스:

```
// ── X-GIS 언어에서 선언 ──
input tracks: [Track]
input custom_threshold: f32 = 0.5

// ── 호스트(TypeScript)에서 주입 ──
const map = new XGISMap({ canvas, scene: compiledScene })

// 스칼라 주입 → uniform buffer로 컴파일됨
map.set('custom_threshold', 0.8)

// 배열 주입 → storage buffer 또는 data texture로 컴파일됨
map.set('tracks', trackArrayBuffer)

// 스트리밍 업데이트 (부분 갱신)
map.update('tracks', {
  offset: 42,           // 42번째 Track부터
  data: updatedSlice     // ArrayBuffer
})

// 포인터 모드 (제로카피, 군사/보안용)
map.bind('tracks', {
  pointer: externalGPUBuffer,  // 이미 GPU에 있는 데이터
  layout: Track                // 스키마만 알려줌
})
```

**세 가지 주입 모드**:

| 모드 | 설명 | 용도 |
|---|---|---|
| **`set`** | 전체 데이터 교체. 런타임이 GPU 업로드 처리 | 일반적인 동적 데이터 |
| **`update`** | 부분 갱신 (offset + data). `queue.writeBuffer` 매핑 | 실시간 스트리밍 |
| **`bind`** | 외부 GPU 버퍼/텍스처 직접 바인딩. 제로카피 | 보안 데이터, 대규모 데이터 |

### 7.5 모듈 시스템

```
// ── 파일: @xgis/military/symbols.xgs ──
// 공개 모듈: 군사 심볼 스타일 라이브러리
export style nato_symbol(classification: u8, echelon: u8) {
  shape: match classification {
    0 => friendly_frame(echelon)
    1 => hostile_frame(echelon)
    _ => unknown_frame(echelon)
  }
  // ... 상세 MIL-STD-2525 심볼 정의
}

export struct MilTrack {
  sidc: u64              // Symbol ID Code
  position: vec2<f64>
  speed: f32
  heading: f32
}

export fn sidc_to_classification(sidc: u64) -> u8 {
  return u8((sidc >> 8) & 0xFF)
}

// ── 파일: my-app/scene.xgis ──
import { nato_symbol, MilTrack, sidc_to_classification } from "@xgis/military/symbols"
import { heatmap_style } from "@xgis/viz/heatmap"
import { contour_lines } from "./local-utils"       // 로컬 모듈

input tracks: [MilTrack]

layer track_layer {
  source: tracks
  style: nato_symbol(
    sidc_to_classification(sidc),
    echelon: 4
  )
}
```

**모듈 해석 규칙**:

```
import { X } from "@xgis/pkg"     → 공식 레지스트리 패키지
import { X } from "pkg"           → node_modules 스타일 (npm/bun 레지스트리)
import { X } from "./local"       → 상대 경로
import { X } from "/absolute"     → 절대 경로
```

**모듈이 export할 수 있는 것**:
- `struct` — 데이터 스키마
- `style` — 스타일 정의 (파라미터화 가능)
- `fn` — 순수 함수 (GPU에서 실행됨)
- `source` — 데이터 소스 프리셋
- `layer` — 레이어 프리셋

### 7.6 인스턴싱과 데이터 텍스처 — 언어적 해결

```
// ── 개발자가 작성하는 코드 ──
input particles: [Particle]    // 100만 개 파티클

struct Particle {
  position: vec2<f32>
  velocity: vec2<f32>
  color: rgba
  size: f32
}

layer particles_display {
  source: particles
  | point-circle  size-[size]  fill-[color]
}

// ── 컴파일러가 생성하는 코드 (개발자에게 보이지 않음) ──

// 1. 100만 Particle × 28 bytes = 28MB → storage buffer 한계 내
//    → Storage Buffer + instanced draw 선택

// 또는:

// 2. 100만 Particle × 28 bytes = 28MB이지만 디바이스 제한 초과 시
//    → Data Texture로 자동 패킹:
//    - position(vec2) + velocity(vec2) → RGBA32F 텍스처 (1024x1024)
//    - color(rgba) → RGBA8 텍스처 (1024x1024)
//    - size(f32) → R32F 텍스처 (1024x1024)
//    - vertex shader에서 instance_index → texel 좌표 변환 코드 자동 생성

// 생성되는 WGSL (예시):
// @group(0) @binding(0) var particle_pos_vel: texture_2d<f32>;
// @group(0) @binding(1) var particle_color: texture_2d<f32>;
// @group(0) @binding(2) var particle_size: texture_2d<f32>;
//
// fn load_particle(instance: u32) -> Particle {
//   let tex_width = 1024u;
//   let uv = vec2u(instance % tex_width, instance / tex_width);
//   let pos_vel = textureLoad(particle_pos_vel, uv, 0);
//   let color = textureLoad(particle_color, uv, 0);
//   let size = textureLoad(particle_size, uv, 0).r;
//   return Particle(pos_vel.xy, pos_vel.zw, color, size);
// }
```

### 7.7 명시적 힌트 (Level 4 — GPU 프로그래머용)

컴파일러 결정을 오버라이드하고 싶은 전문가를 위한 어노테이션:

```
// 강제 storage buffer (기본 자동 결정 무시)
@backing(storage)
input tracks: [Track]

// 강제 data texture, 레이아웃 지정
@backing(texture, width: 2048, format: rgba32f)
input positions: [vec4<f32>]

// 강제 uniform (작은 데이터임을 보장)
@backing(uniform)
input config: RenderConfig

// 읽기 전용 힌트 → 컴파일러가 read-only storage buffer 사용
@readonly
input terrain_mesh: [Vertex]

// 하드웨어 필터링 활성화 → 반드시 텍스처
@filtered(linear)
input elevation: grid2d<f32>
```

---

## 8. Cross-Language Data Exchange (언어 간 데이터 교환)

### 8.1 문제

X-GIS의 `struct`는 GPU 렌더링용 스키마이지만, 호스트 언어(TypeScript, C++, Python, Rust)에서 이 데이터를 생성하고 주입해야 한다. 매번 수동으로 바이트 오프셋을 맞추는 것은 비현실적.

**protobuf 모델**: `.proto` 파일 → `protoc` → 타깃 언어 코드 자동 생성
**X-GIS 모델**: `.xgis` 파일의 `struct` → `xgisc` → 타깃 언어 바인딩 자동 생성

### 8.2 코드 생성 파이프라인

```
struct Track {              xgisc --target=ts         export interface Track {
  position: vec2<f64>       ─────────────────►          position: Float64Array  // [lon, lat]
  altitude: f32                                         altitude: number
  speed: f32                                            speed: number
  heading: f32                                          heading: number
  id: u32                                               id: number
  classification: u8                                    classification: number
}                                                     }

                                                      export const TrackLayout = {
                                                        size: 32,  // 패딩 포함
                                                        alignment: 8,
                                                        fields: {
                                                          position: { offset: 0, type: 'f64', count: 2 },
                                                          altitude: { offset: 16, type: 'f32', count: 1 },
                                                          speed: { offset: 20, type: 'f32', count: 1 },
                                                          heading: { offset: 24, type: 'f32', count: 1 },
                                                          id: { offset: 28, type: 'u32', count: 1 },
                                                          classification: { offset: 32, type: 'u8', count: 1 },
                                                        }
                                                      } as const

                                                      export class TrackBuffer {
                                                        private buffer: ArrayBuffer
                                                        constructor(count: number)
                                                        get(index: number): Track
                                                        set(index: number, value: Track): void
                                                        get raw(): ArrayBuffer  // GPU 업로드용
                                                      }
```

### 8.3 지원 타깃 언어

```
xgisc compile scene.xgis --target=ts      → TypeScript 인터페이스 + 버퍼 헬퍼
xgisc compile scene.xgis --target=cpp     → C++ struct (std::byte 정렬 보장) + 헤더
xgisc compile scene.xgis --target=rust    → Rust #[repr(C)] struct + bytemuck 구현
xgisc compile scene.xgis --target=python  → Python dataclass + numpy dtype
xgisc compile scene.xgis --target=csharp  → C# [StructLayout] + Marshal
```

각 타깃은 **동일한 메모리 레이아웃**을 보장한다:
- GPU 정렬 규칙 (WebGPU std140/std430) 자동 적용
- 패딩 바이트 자동 삽입
- 엔디안 명시 (little-endian, GPU 표준)

### 8.4 타입 매핑 테이블

| X-GIS 타입 | TypeScript | C++ | Rust | WGSL |
|---|---|---|---|---|
| `f32` | `number` | `float` | `f32` | `f32` |
| `f64` | `number` | `double` | `f64` | *(CPU only, GPU는 f32 다운캐스트)* |
| `u8` | `number` | `uint8_t` | `u8` | `u32` *(패킹)* |
| `u32` | `number` | `uint32_t` | `u32` | `u32` |
| `vec2<f32>` | `Float32Array` | `glm::vec2` | `[f32; 2]` | `vec2<f32>` |
| `vec2<f64>` | `Float64Array` | `glm::dvec2` | `[f64; 2]` | *(split to high+low f32)* |
| `rgba` | `Uint8Array` | `uint32_t` | `[u8; 4]` | `vec4<f32>` *(normalize)* |
| `bool` | `boolean` | `uint32_t` | `u32` | `u32` |

### 8.5 f64 ↔ GPU 정밀도 문제 해결

WGS84 좌표(f64)는 GPU(f32)에서 정밀도 손실이 발생하므로, 컴파일러가 자동 처리:

```
// 개발자가 작성
struct Track {
  position: vec2<f64>     // WGS84 경위도
}

// 컴파일러가 GPU용으로 자동 변환:
// 1. CPU 측: f64를 RTC 오프셋으로 변환
// 2. GPU 측: f32 상대 좌표로 전달
//
// 생성되는 GPU struct:
// struct Track_GPU {
//   position_relative: vec2<f32>   // 타일 중심 기준 상대 좌표
// }
//
// 생성되는 CPU 코드 (TypeScript):
// function uploadTracks(tracks: Track[], rtcCenter: [f64, f64]) {
//   for (const t of tracks) {
//     gpuBuffer.position_relative = [
//       float32(t.position[0] - rtcCenter[0]),
//       float32(t.position[1] - rtcCenter[1])
//     ]
//   }
// }
```

개발자는 `vec2<f64>`로 선언하기만 하면 RTC 변환은 투명하게 처리된다.

### 8.6 양방향 교환 — 이벤트 & 쿼리

데이터가 호스트→GPU 방향만이 아니라, GPU→호스트 방향도 필요:

```
// ── X-GIS 에서 선언 ──
// GPU에서 계산된 결과를 호스트로 반환
output visible_count: u32           // 가시 피처 수 (atomic counter)
output picked_feature: Track?       // 피킹된 피처 (nullable)
output heatmap_result: grid2d<f32>  // compute shader 결과

// ── 호스트(TypeScript)에서 읽기 ──
// 컴파일러가 readback buffer + mapAsync 코드를 자동 생성
const count = await map.read('visible_count')        // GPU → CPU readback
const picked = await map.read('picked_feature')      // nullable, Pick 시만 유효
const grid = await map.read('heatmap_result')        // ArrayBuffer로 반환
```

### 8.7 직렬화 포맷 — .xgb (X-GIS Binary)

모듈 배포 및 네트워크 전송을 위한 바이너리 포맷:

```
.xgb 파일 구조:
┌──────────────────────────────┐
│ Magic: "XGIS" (4 bytes)     │
│ Version: u16                 │
│ Flags: u16                   │
├──────────────────────────────┤
│ Schema Section               │  struct 정의들의 바이너리 인코딩
│  - struct count              │
│  - field names (string pool) │
│  - field types + offsets     │
│  - alignment info            │
├──────────────────────────────┤
│ IR Section                   │  컴파일된 중간 표현
│  - style definitions         │
│  - function bytecode         │
│  - pipeline configurations   │
├──────────────────────────────┤
│ Shader Section               │  타깃별 셰이더 (선택적)
│  - WGSL source / SPIR-V     │
├──────────────────────────────┤
│ Source Map (optional)        │  디버깅용 원본 매핑
└──────────────────────────────┘
```

`.xgb`는 protobuf의 `.pb` 파일처럼:
- 빌드 결과물 (소스 없이 배포 가능)
- 스키마 정보 포함 (런타임 타입 검증 가능)
- 플랫폼 독립 (타깃 셰이더는 런타임 생성 또는 미리 포함)

---

## 9. Resolved Design Decisions (확정된 설계 결정)

### Q1. 타입 시스템 깊이

**결정: 단순한 정적 타입으로 시작, 점진적 확장**

```
Phase 1 (MVP):
  - 기본 스칼라: bool, u8, u16, u32, i32, f32, f64
  - 벡터: vec2<T>, vec3<T>, vec4<T>
  - 매트릭스: mat2x2<T> ~ mat4x4<T>
  - 특수: rgba, geodetic (= vec2<f64> + 의미)
  - 컬렉션: [T] (배열), grid2d<T> (2D 그리드)
  - struct (명시적 필드, 상속 없음)
  - nullable: T? (피킹 결과 등)
  - enum (정수 매핑)

Phase 2:
  - 제네릭 함수: fn lerp<T: Numeric>(a: T, b: T, t: f32) -> T
  - 유니온 타입: type Shape = Circle | Rect | Polygon
  - trait/interface: trait Renderable { fn bounds() -> BBox }

Phase 3 (필요 시):
  - 유니크니스 타입 (버퍼 소유권)
  - 자동 미분 (ML 통합)
```

**근거**: protobuf도 scalar → message → oneof → map 순으로 확장했다. 초기에 복잡한 타입 시스템은 컴파일러 구현 비용만 높이고 사용자에게 진입 장벽이 됨.

### Q2. 모듈 시스템

**결정: ES Module 스타일 import/export + 패키지 레지스트리**

(7.5 섹션에서 정의됨)

- 파일 단위 모듈
- Named export만 (`export default` 없음 — 명시적)
- 패키지 레지스트리: `@xgis/*` 공식 + 커뮤니티 (npm/bun 레지스트리 활용)
- 컴파일러가 의존성 해석, 트리 셰이킹, 데드 코드 제거

### Q3. 에러 리포팅

**결정: 소스맵 기반 + 타깃 코드에 원본 위치 주석**

```
// 컴파일 에러 예시:
error[E0312]: type mismatch in style 'building_style'
  --> scene.xgs:15:12
   |
15 |   height: property(name)    // name은 string, height는 f32 기대
   |           ^^^^^^^^^^^^^^ expected f32, found string
   |
help: use a type conversion
   |
15 |   height: to_f32(property(name))
```

- 컴파일러 에러: 원본 `.xgis/.xgs/.xgl` 파일의 행/열 번호
- 런타임 GPU 에러: WGSL 소스 내 `// @source(scene.xgs:15)` 주석으로 역추적
- `.xgb`에 소스맵 선택적 포함

### Q4. 디버깅

**결정: 3-tier 디버깅 전략**

```
Tier 1: 컴파일 타임 검증 (대부분의 에러를 여기서 잡음)
  - 타입 검증, 범위 검사, 바인딩 일관성
  - "만약 이 속성이 null이면?" 정적 경고

Tier 2: CPU 시뮬레이션 모드
  - 컴파일 플래그: xgisc compile --debug
  - 셰이더 로직을 CPU에서 실행하는 코드 생성
  - 브레이크포인트, 변수 감시, 스텝 실행 가능
  - 성능은 느리지만 정확한 디버깅

Tier 3: GPU 시각적 디버그
  - @debug 어노테이션으로 특정 값을 색상으로 시각화
  - 예: @debug(color) fn show_speed(s: f32) -> rgba { ... }
  - RenderDoc/PIX 연동을 위한 디버그 마커 자동 삽입
```

### Q5. LSP (Language Server Protocol)

**결정: 컴파일러와 LSP를 동일 코어로 구현**

```
xgisc (컴파일러 코어)
  ├── Parser → AST
  ├── Type Checker → 타입 정보
  ├── Analyzer → 의미 분석
  │
  ├── [CLI 모드] → 코드 생성 (.wgsl, .ts, .cpp, .xgb)
  │
  └── [LSP 모드] → IDE 서비스
       ├── 자동완성 (struct 필드, style 속성, 내장 함수)
       ├── 호버 정보 (타입, 컴파일된 backing 전략)
       ├── 에러/경고 실시간 표시
       ├── Go to Definition (모듈 간 네비게이션)
       ├── Rename Symbol (안전한 리팩토링)
       └── Color Preview (rgba, #hex 리터럴 인라인 미리보기)
```

Rust로 구현하면 CLI와 LSP가 같은 바이너리에서 동작. VS Code / JetBrains 확장은 이 LSP를 래핑.

### Q6. REPL / Hot Reload

**결정: Hot Reload 우선, REPL은 Phase 2**

```
// 개발 서버 모드
xgisc dev scene.xgis --watch --port 3000

// 동작:
// 1. scene.xgis/xgs/xgl 파일 변경 감지
// 2. 증분 재컴파일 (변경된 모듈만)
// 3. WebSocket으로 브라우저에 핫 업데이트 푸시
// 4. GPU 파이프라인 재생성 없이 uniform/스타일만 교체 (가능한 경우)
// 5. 파이프라인 변경 필요 시 전체 재빌드 (0.5초 이내 목표)
```

- Phase 1: `--watch` 모드로 파일 변경 시 자동 재컴파일 + 브라우저 리프레시
- Phase 2: 인터랙티브 REPL (표현식 평가, 스타일 즉시 적용)

### Q7. 표준 라이브러리

**결정: 레이어드 표준 라이브러리**

```
@xgis/core (항상 사용 가능, import 불필요)
  ├── 수학: sin, cos, sqrt, pow, clamp, lerp, step, smoothstep
  ├── 벡터: dot, cross, normalize, length, distance
  ├── 색상: rgb, rgba, hsl, hsla, mix, lighten, darken
  ├── 좌표: wgs84_to_mercator, mercator_to_wgs84, geodetic_distance
  ├── 보간: linear, exponential, cubic_bezier
  └── 시간: time, delta_time, frame_count

@xgis/geo (import 필요)
  ├── 투영: projection_transform, tile_to_lonlat, lonlat_to_tile
  ├── 지형: sample_elevation, slope, aspect, hillshade
  ├── 공간: point_in_polygon, line_intersection, buffer
  └── 타일: tile_key, tile_bounds, tile_zoom

@xgis/viz (import 필요)
  ├── 색상 스케일: sequential, diverging, categorical
  ├── 히트맵: kernel_density, gaussian_kernel
  ├── 등치선: marching_squares, contour_lines
  └── 클러스터: grid_cluster, dbscan (compute shader)

@xgis/military (import 필요, 도메인 특화)
  ├── 심볼: mil_std_2525, nato_app6
  ├── 좌표: mgrs, utm, georef
  └── 데이터: link16, vmf, cursor_on_target
```

### Q8. 3D Tiles / Terrain 통합

**결정: 엔진 수준 프리미티브 + 언어 수준 스타일링**

```
// 엔진이 제공하는 것 (언어 밖):
// - Quadtree 타일 관리, LOD 결정
// - 3D Tiles 로딩/스트리밍
// - 지형 메시 생성, 지형 위 클램핑
// - 좌표 투영 (WGS84 → 화면)

// 언어가 제공하는 것:
layer terrain_display {
  source: terrain_dem
  | hillshade  exaggeration-1.5  lighting-default
}

source buildings_3d {
  type: 3d-tiles
  url: "https://tiles.example.com/buildings/tileset.json"
}

layer buildings_3d_display {
  source: buildings_3d
  filter: height > 5                         // 5m 미만 건물 숨기기
  | [usage=="residential"]:fill-[#4a90d9]
  | [usage=="commercial"]:fill-[#d94a4a]
  | fill-[#cccccc]
}
```

엔진은 타일 로딩/LOD/메시를 처리하고, 언어는 "이 데이터를 어떻게 보여줄 것인가"만 정의한다. 이것이 관심사의 분리.

---

## 10. 3D Geometry — 볼륨, 서피스, 지형 관통

### 10.1 왜 필요한가

2D 지오메트리(`polygon`, `line`, `circle`)만으로는 표현 불가능한 것들:

```
- 터널이 산을 관통하는 경로 (지형 아래/위를 오가는 3D 라인)
- 수중 파이프라인, 해저 케이블 (바다 밑 3D 경로)
- 방공 커버리지 (반구 돔 볼륨)
- 지하 벙커, 지하철 노선 (지형 아래 구조물)
- 핵 낙진 구름 (3D 볼류메트릭)
- 잠수함 작전 수심 제한 (수평 슬라이스가 아닌 3D 공간)
- 비행 회랑 (고도 포함 3D 통로)
```

### 10.2 3D 지오메트리 프리미티브

```
// ── 3D 점 ──
geometry sonar_contact {
  point3d(127.0deg, 37.5deg, -150m)          // 수심 150m 지점
}

// ── 3D 라인 (고도/수심 포함 경로) ──
geometry tunnel_route {
  line3d [
    (127.00deg, 37.50deg, 0m)                // 터널 입구 (지표)
    (127.01deg, 37.50deg, -30m)              // 지하 진입
    (127.02deg, 37.51deg, -50m)              // 최저점
    (127.03deg, 37.52deg, -50m)              // 지하 구간
    (127.04deg, 37.52deg, -20m)              // 상승
    (127.05deg, 37.53deg, 0m)                // 터널 출구 (지표)
  ]
}

// 터널 렌더링: 라인을 따라 원형 단면 돌출
layer tunnel_display {
  source: tunnel_route
  | tube(radius: 5m, segments: 16)           // 원형 튜브로 돌출
  | fill-gray-600  lighting-default
  | terrain-clip: below                      // 지형 아래 부분만 표시
}

// ── 3D 폴리곤 (고도 있는 면) ──
geometry flight_corridor {
  polygon3d [
    (126.5deg, 37.0deg, 3000ft)
    (127.0deg, 37.2deg, 3000ft)
    (127.0deg, 37.2deg, 5000ft)
    (126.5deg, 37.0deg, 5000ft)
  ]
}

// ── 3D 볼륨 프리미티브 ──

// 구 (방공 커버리지)
geometry sam_envelope {
  sphere(center: (127.0deg, 37.5deg, 0m), radius: 30km)
}

// 돔 (반구)
geometry radar_dome {
  hemisphere(center: (127.0deg, 37.5deg, 0m), radius: 200km)
}

// 원기둥 (수직 탐색 영역)
geometry search_cylinder {
  cylinder(
    center: (127.0deg, 37.5deg)
    radius: 5km
    top: 0m                                  // 해수면
    bottom: -300m                            // 수심 300m
  )
}

// 원뿔 (소나 빔)
geometry sonar_beam {
  cone(
    apex: submarine.position                 // 꼭짓점 (잠수함 위치)
    direction: submarine.heading
    angle: 30deg                             // 반각
    length: 10km
  )
}

// 절두체 (레이더 빔, 카메라 시야)
geometry radar_beam {
  frustum(
    origin: radar.position
    direction: radar.bearing
    near: 100m
    far: 50km
    fov_h: 3deg
    fov_v: 15deg
  )
}

// 자유 형태 볼륨 (등치면에서 생성)
geometry contamination_cloud = isosurface(
  data: fallout_simulation.dose_rate_3d
  threshold: 0.1                             // 0.1 Gy/h 등치면
)
```

### 10.3 지형 상호작용

```
// ── 지형과의 관계 ──

// 지형 위에 드레이핑 (2D 폴리곤을 지형에 붙이기)
layer draped_zone {
  source: operation_area                     // 2D 폴리곤
  | drape-on-terrain                         // 지형 표면에 투영
  | fill-blue-500/20  stroke-blue-400
}

// 지형 아래만 표시 (터널, 지하 구조물)
layer underground_pipe {
  source: pipeline_route                     // 3D 라인
  | tube(radius: 1m)
  | terrain-clip: below                      // 지형 아래 부분만 렌더링
  | fill-orange-400  opacity-80
}

// 지형 위만 표시 (교량, 고가도로)
layer overpass {
  source: bridge_route
  | tube(radius: 3m)
  | terrain-clip: above                      // 지형 위 부분만 렌더링
  | fill-gray-500  lighting-default
}

// 지형 관통 시각화 (터널 입출구 강조)
layer tunnel_with_portals {
  source: tunnel_route
  | tube(radius: 5m)

  // 지형 교차점에 입구/출구 마커 자동 생성
  | terrain-intersection-markers {
    symbol: portal_icon
    size: 12
    fill-yellow-400
  }

  // 지상 구간 / 지하 구간 다른 스타일
  | terrain-above:opacity-100  terrain-above:fill-gray-400
  | terrain-below:opacity-60   terrain-below:fill-gray-600
  | terrain-below:stroke-dash-5-3            // 지하는 점선
}

// 수심 기준 클리핑 (수중/수상 구분)
layer subsea_cable {
  source: cable_route
  | line3d-w-3
  | water-above:stroke-blue-300              // 수면 위
  | water-below:stroke-cyan-600              // 수면 아래
}

// ── 지형 단면도 (Cross Section) ──
geometry terrain_section = cross_section(
  terrain: bathymetry
  line: [(126.5deg, 37.0deg), (127.5deg, 37.5deg)]
  vertical_exaggeration: 10x
)

overlay section_view {
  anchor: bottom
  height: 200
  width: 100%

  source: terrain_section
  | fill-gradient-terrain                    // 지형 단면 채우기
  | stroke-brown-600  stroke-1
  | overlay-objects: tunnel_route            // 단면 위에 터널 위치 표시
  | grid-lines  axis-labels
}
```

### 10.4 3D 볼륨 렌더링

```
// ── 반투명 볼륨 (방공망, 위협 공간) ──
layer sam_coverage {
  source: sam_envelope
  | fill-red-500/10                          // 반투명
  | stroke-red-400  stroke-1
  | wireframe-spacing-10deg                  // 와이어프레임 격자
}

// ── 볼륨 불리언 연산 ──
geometry safe_airspace = difference(
  flight_corridor_volume,
  union(for sam in enemy_sams { sphere(sam.position, sam.range) })
)

// ── 3D 등치면 (오염 구름 등) ──
layer fallout_cloud {
  source: contamination_cloud                // isosurface에서 생성된 메시
  | fill-yellow-500/20  lighting-default
  | animate-[time | sin | scale:0.95,1.05]   // 약간 맥동
}

// ── 볼류메트릭 렌더링 (레이 마칭) ──
// 메시 변환 없이 볼륨 데이터를 직접 렌더링
layer volumetric_cloud {
  source: dose_rate_3d                       // grid3d<f32>

  @fragment {
    // 볼륨 레이 마칭
    var accumulated = vec4(0)
    for step in 0..128 {
      let pos = ray_origin + ray_dir * f32(step) * step_size
      let density = sample3d(dose_rate_3d, pos)
      if density > 0.01 {
        let color = ramp(density, "inferno")
        accumulated += vec4(color.rgb * density, density * 0.02) * (1.0 - accumulated.a)
      }
      if accumulated.a > 0.95 { break }
    }
    color = accumulated
  }
}
```

---

## 11. Real-time Streaming — 실시간 데이터 스트리밍

### 11.1 `stream` 소스 타입

```
// ── 스트림 선언 ──

source ais_feed {
  type: stream
  protocol: websocket
  url: "wss://ais.example.com/feed"
  schema: AISMessage

  // 스트림 제어
  buffer: 100                                // 최대 100개 버퍼링
  throttle: 100ms                            // 최소 100ms 간격으로 GPU 업로드
  on_overflow: drop_oldest                   // 버퍼 초과 시 오래된 것 버림
}

source link16 {
  type: stream
  protocol: udp                              // UDP 멀티캐스트
  bind: "239.1.1.1:5000"
  schema: Link16Message

  buffer: 500
  throttle: 50ms
  on_overflow: drop_oldest
  decrypt: link16_key                        // 복호화 키 (보안)
}

source radar_sweep {
  type: stream
  protocol: shared_memory                    // 같은 머신의 레이더 프로세스와 공유 메모리
  key: "/dev/shm/radar_ppi"
  schema: RadarReturn

  throttle: 33ms                             // 30fps
  ring_buffer: true                          // 원형 버퍼
}

// ── 스트림 처리 파이프라인 ──

// 스트림 데이터를 엔티티로 매핑
stream_processor ais_tracker {
  input: ais_feed

  // 키별 최신 상태 유지 (MMSI로 그룹핑)
  group_by: mmsi
  keep: latest                               // 각 MMSI의 최신 메시지만

  // 트랙 생성/갱신
  on_message(msg) {
    upsert entity {
      id: msg.mmsi
      position: (msg.lon, msg.lat)
      heading: msg.cog
      speed: msg.sog
      name: msg.vessel_name
      last_seen: msg.timestamp
    }
  }

  // 타임아웃: 5분간 업데이트 없으면 제거
  timeout: 5min
  on_timeout(id) {
    remove entity(id)
    emit: "track_lost"(id)
  }
}

// ── 스트림 윈도잉 ──

stream_processor radar_integrator {
  input: radar_sweep

  // 최근 10스윕 누적 (시간 윈도우)
  window: sliding(count: 10)

  // 누적 결과를 그리드로
  output: grid2d<f32>(512, 512)

  reduce(returns) {
    // 최근 10스윕의 반사 강도 평균
    return mean(returns.map(r => r.intensity))
  }
}
```

### 11.2 GPU 업로드 전략

```
// 컴파일러가 스트림 특성에 따라 결정:

스트림 패턴          → GPU 업로드 전략
──────────────       ──────────────────
소수 엔티티 갱신     → writeBuffer (부분 갱신)
대량 배치 도착       → 더블 버퍼 스왑
연속 그리드 데이터   → 링 버퍼 텍스처 (RingBuffer Texture)
희소 업데이트        → Sparse update + dirty flag

// 전문가 힌트
@stream_strategy(double_buffer)
source high_rate_sensor { ... }

@stream_strategy(ring_buffer, frames: 60)
source radar_history { ... }                 // 최근 60프레임 이력 유지
```

---

## 12. Multi-user Collaboration — 다중 사용자 협업

### 12.1 공유 상태 모델

```
// ── 씬에서 공유/로컬 구분 선언 ──

scene tactical_display {
  // 공유 상태: 모든 사용자에게 동기화
  shared {
    source ais_tracks { ... }                // 공통 데이터 피드
    layer base_chart { ... }                 // 공통 해도

    // 공유 드로잉 (한 명이 그리면 전원에게 표시)
    draw_layer shared_annotations {
      sync: realtime
      conflict: last_write_wins
    }
  }

  // 사용자별 로컬 상태: 각자만 보임
  local {
    layer my_measurements { ... }            // 내 측정선
    overlay my_hud { ... }                   // 내 HUD 설정

    draw_layer my_sketches {
      sync: none                             // 동기화 안 함
    }
  }

  // 역할별 뷰: 권한에 따라 다른 레이어
  role captain {
    layer command_overlay { ... }
    | z-order-200
  }

  role navigator {
    layer nav_aids { ... }
    layer depth_overlay { ... }
  }

  role weapons_officer {
    layer engagement_zones { ... }
    layer weapon_coverage { ... }
  }
}
```

### 12.2 동기화 프로토콜

```
// 동기화 모드 선언
shared draw_layer tactical_graphics {
  // 충돌 해결 전략
  sync: realtime                             // 실시간 (WebSocket/UDP)
  conflict: operational_merge                // 군사 전술 그래픽 병합 규칙

  // 각 도형에 작성자/시간 메타데이터 자동 부착
  metadata: auto                             // { author, timestamp, classification }

  // 이력 관리
  history: 100                               // 최근 100개 변경 undo 가능

  // 권한
  permissions {
    create: [captain, navigator, weapons_officer]
    edit: owner_or_higher_rank               // 작성자 또는 상위 직급
    delete: captain_only
  }
}

// 호스트에서 동기화 서버 연결
// map.connect('wss://cic-server.local/sync', { role: 'navigator', token: authToken })
```

---

## 13. Server-side & Headless — 서버 렌더링

### 13.1 실행 환경 분류

```
환경              GPU      렌더링       용도
──────────       ──────   ──────────   ──────────────
브라우저           WebGPU   실시간       일반 사용
네이티브 앱        Vulkan   실시간       함정 C2 시스템
서버 (GPU)        Vulkan   헤드리스     타일 생성, 보고서
서버 (CPU-only)   없음     소프트웨어    분석 전용
CI/CD             없음     없음         테스트/검증만
```

### 13.2 컴파일 타깃별 코드 생성

```
// 같은 .xgis가 다른 환경에서 동작

xgisc compile scene.xgis --target=webgpu    // 브라우저 (WGSL 생성)
xgisc compile scene.xgis --target=vulkan    // 네이티브 (SPIR-V 생성)
xgisc compile scene.xgis --target=headless  // 서버 헤드리스 렌더링
xgisc compile scene.xgis --target=cpu       // CPU-only (analysis만, 렌더링 없음)

// ── 서버에서 분석만 실행 ──
// CPU 타깃에서는 @fragment/@vertex 무시, analysis/simulation만 컴파일
// GPU 없이도 분석 결과 생성 가능

// ── 서버에서 헤드리스 렌더링 ──
// Vulkan headless surface로 오프스크린 렌더링

@host fn generate_report(area: GeodeticBBox) -> Image {
  let snapshot = render_to_image(
    scene: tactical_display
    bounds: area
    size: 2048 x 2048
    format: png
    dpi: 300
  )
  return snapshot
}

// 타일 서버: 벡터 타일 → 래스터 타일 변환
@host fn render_tile(z: u32, x: u32, y: u32) -> Image {
  let bounds = tile_bounds(z, x, y)
  return render_to_image(
    scene: basemap_style
    bounds: bounds
    size: 256 x 256
    format: png
  )
}

// PDF 보고서 생성
@host fn threat_report(area: GeodeticBBox) -> PDF {
  let analysis_result = run(threat_assessment, { bounds: area })
  let map_image = render_to_image(scene: tactical_display, bounds: area, size: 4096 x 4096)

  return pdf {
    page {
      title: "Threat Assessment Report"
      image: map_image
      table: analysis_result.hazards
      text: "Total hazards: {analysis_result.hazards.count}"
      text: "Risk score: {analysis_result.risk_score * 100 | round}%"
    }
  }
}
```

---

## 14. Testing — 테스트 프레임워크

### 14.1 단위 테스트

```
// ── analysis 테스트 ──

test "hazard scan detects shallow water" {
  // 테스트용 입력 데이터
  let route = [(126.5deg, 37.0deg), (127.0deg, 37.5deg)]
  let bathymetry = mock_grid(256, 256, fill: 100.0)    // 전부 100m 수심
  bathymetry.set_region(128, 128, 10, 10, value: 3.0)  // 일부 구간 3m (얕은 곳)

  let result = run(route_hazard_scan, {
    route: route
    bathymetry: bathymetry
    vessel_draft: 5.0
    safety_margin: 500.0
  })

  assert result.hazards.count > 0
  assert result.hazards.any(h => h.type == HazardType.shallow)
  assert result.safe_passage == false
  assert result.min_clearance < 0.0                     // 흘수보다 수심이 얕음
}

// ── 함수 테스트 ──

test "MGRS conversion round-trip" {
  let pos = (127.0deg, 37.5deg)
  let mgrs = pos | to_mgrs
  let back = mgrs | from_mgrs

  assert geodetic_distance(pos, back) < 1.0             // 1m 이내 오차
}

// ── constexpr 테스트 ──

test "mercator scale at 60 degrees" {
  assert abs(mercator_scale(60.0) - 2.0) < 0.001
}

// ── 파이프 테스트 ──

test "military coordinate formatting" {
  assert ((127.0deg, 37.5deg) | mgrs) == "52S DG 43010 59100"
  assert (247.3 | compass) == "WSW"
  assert (247.3 | mils | round) == "4396"
}
```

### 14.2 시각적 회귀 테스트

```
// ── 골든 이미지 비교 ──

visual_test "track symbols render correctly" {
  scene: test_tracks_scene
  viewport: 800 x 600
  camera: { center: (127deg, 37.5deg), zoom: 12 }

  // 골든 이미지와 픽셀 비교
  compare: "./golden/track_symbols.png"
  tolerance: 0.01                            // 1% 픽셀 차이 허용 (안티앨리어싱)
}

visual_test "building extrusion at zoom 14" {
  scene: test_buildings_scene
  camera: { center: (127deg, 37.5deg), zoom: 14, pitch: 60deg }
  compare: "./golden/buildings_3d.png"
  tolerance: 0.02
}

// ── 스냅샷 테스트 (처음 실행 시 골든 이미지 자동 생성) ──

snapshot_test "oil spill after 100 steps" {
  // 시뮬레이션 100스텝 실행 후 상태 캡처
  let sim = create(oil_spill_simulation)
  for _ in 0..100 { sim.step() }

  snapshot: sim.state.concentration          // 그리드 데이터 스냅샷
  compare: "./snapshots/oil_spill_100.bin"
  tolerance: 0.001
}
```

### 14.3 테스트 실행

```
xgisc test                                   // 모든 테스트
xgisc test --filter "hazard*"                // 패턴 매칭
xgisc test --visual                          // 시각적 테스트만
xgisc test --update-snapshots                // 골든 이미지 갱신
xgisc test --target=cpu                      // GPU 없이 (analysis 테스트만)
xgisc test --target=webgpu                   // 브라우저에서 (visual 포함)
```

---

## 15. Security & Access Control — 보안

### 15.1 레이어별 보안 등급

```
// ── 보안 분류 선언 ──

classification_levels {
  UNCLASSIFIED = 0
  RESTRICTED   = 1
  CONFIDENTIAL = 2
  SECRET       = 3
  TOP_SECRET   = 4
}

layer base_chart {
  source: open_chart_data
  classification: UNCLASSIFIED
  // ...
}

layer ais_tracks {
  source: ais_feed
  classification: RESTRICTED
  // ...
}

layer sigint_contacts {
  source: sigint_feed
  classification: TOP_SECRET

  // 이 레이어의 데이터는:
  // - TOP_SECRET 이상 인가자만 볼 수 있음
  // - 스크린 캡처 시 자동 마스킹
  // - 로그에 기록 안 됨
  secure {
    screen_capture: mask                     // 캡처 시 블러 처리
    logging: disabled                        // 위치 데이터 로그 금지
    export: disabled                         // GeoJSON 등 내보내기 금지
  }
}

// ── 사용자 인가 수준 ──
// 호스트에서 세션 설정
// map.setClassification({ level: 'SECRET', caveats: ['NATO', 'FVEY'] })
// 인가 수준보다 높은 레이어는 자동으로 숨김/필터링
```

### 15.2 에어갭 환경

```
// ── 오프라인 패키지 ──

// 인터넷 없는 폐쇄망에서:
// 1. 연결된 환경에서 패키지 번들 생성
xgisc bundle scene.xgis --include-deps --output=bundle.xgpkg

// 2. 물리적 매체로 반입
// 3. 폐쇄망에서 설치
xgisc install --from=bundle.xgpkg --offline

// .xgpkg 파일 구조:
// - 모든 의존 모듈 (.xgis, .xgs, .xgl)
// - 컴파일된 .xgb 바이너리
// - 해시 체크섬 (무결성 검증)
// - 서명 (코드 서명 인증서)

// ── 코드 서명 ──

xgisc sign scene.xgb --key=signing_key.pem
xgisc verify scene.xgb --cert=trusted_ca.pem

// 런타임에 서명 검증
map.load('scene.xgb', {
  verify: true,
  trusted_certs: [dod_ca, navy_ca]
  reject_unsigned: true                      // 서명 없으면 로드 거부
})
```

### 15.3 데이터 보호

```
// ── 메모리 보호 ──
// classification: SECRET 이상 데이터는:

secure input sigint_tracks: [SigintTrack] {
  // GPU 버퍼 파괴 시 메모리 제로화
  zero_on_free: true

  // CPU 측 ArrayBuffer도 사용 후 제로화
  zero_on_release: true

  // 다른 input/output으로의 데이터 복사 금지
  copy_protection: true

  // @host 함수에서 접근 시 감사 로그
  audit: true
}

// ── 렌더링 보호 ──
// 보안 레이어가 포함된 화면의 캡처/녹화 방지

scene classified_display {
  watermark: "SECRET // {user.name} // {timestamp | zulu}"
  capture_protection: enabled

  // 보안 등급에 따른 시각적 표시
  overlay classification_banner {
    anchor: top
    | bg-red-700  padding-4  width-100%
    children {
      text { content: "SECRET"  | text-14  text-white  text-bold  text-center }
    }
  }
}
```

---

## 16. Design Gap Analysis — 설계 누락 검토

> **상태: 모두 해결됨.** G1~G4는 Section 17~20에서, G5~G10은 Section 21에서 해결.
> 이 섹션은 원래 식별된 문제의 기록으로 보존.

현재 설계를 냉정하게 검토한 결과, 다음 영역이 미해결 또는 불충분하다.

### 치명적 (구현 전 반드시 해결)

**G1. 에러 처리 모델 — 완전 부재**

데이터가 null이면? 스트림이 끊기면? analysis가 실패하면? 현재 설계에 에러 처리 문법이 전혀 없다.

```
질문:
- null/undefined: Option<T>? nullable T?? 기본값 폴백?
- 런타임 에러: try/catch? Result<T, E>? panic?
- GPU 에러: 셰이더 컴파일 실패, 버퍼 할당 실패 시?
- 데이터 타입 불일치: 스트림에서 예상과 다른 스키마가 오면?
- 분석 실패: analysis step에서 0으로 나누기, 범위 초과 시?
- 부분 실패: 10만 피처 중 5개만 에러면 전체 실패? 건너뛰기?
```

**G2. 스코핑 규칙 — 암묵적**

어디서 무엇을 참조할 수 있는지 명확하지 않다.

```
질문:
- @fragment에서 어떤 변수에 접근 가능? (자동 varying은 설계했지만, 범위는?)
- layer 안에서 다른 layer의 데이터를 참조할 수 있는가?
- analysis step에서 이전 step 결과를 어떻게 참조?
- entity에서 다른 entity를 참조 (connection에서는 했지만, 일반적으로?)
- 중첩 블록의 변수 섀도잉 규칙?
- import한 모듈의 이름 충돌 해결?
```

**G3. 유틸리티 → WGSL 변환 모델 — 블랙박스**

`fill-red-500`이 실제로 어떤 WGSL 코드가 되는지 설계하지 않았다.

```
질문:
- | fill-red-500 stroke-2 는 어떤 IR 노드가 되는가?
- 유틸리티 여러 개가 충돌하면? (fill-red-500 fill-blue-300 동시 지정)
- 모디파이어(hostile:fill-red-500)는 if문으로 컴파일? 셰이더 분기?
  아니면 별도 셰이더 variant?
- z8:opacity-40 z16:opacity-100 의 "자동 보간"은 어떻게 구현?
- preset + 오버라이드의 우선순위 규칙은?
```

**G4. 개념 간 관계 — 통합 모델 없음**

layer, entity, connection, annotation, overlay, widget, simulation,
analysis, geometry, draw_tool, timeline, state_machine, effect,
pipeline, preset, symbol... **이 16개 개념이 어떻게 관계하는지 정의되지 않았다.**

```
질문:
- entity는 layer의 특수한 케이스인가, 별개인가?
- connection은 layer인가? 별개의 렌더링 패스인가?
- simulation의 output은 source와 동일한 타입인가?
- 이 모든 것을 포괄하는 통합 렌더 그래프가 있는가?
- 렌더링 순서는 z-order만으로 결정? 의존성 그래프?
```

### 중요 (초기 구현 시 해결)

**G5. 메모리/리소스 수명 관리**

```
- GPU 버퍼는 누가 언제 해제?
- entity가 사라지면 3D 모델 메시도 해제?
- analysis 캐시는 얼마나 유지? LRU? 명시적?
- simulation의 더블 버퍼는 엔진이 자동 관리?
- 텍스처 아틀라스 (심볼, 아이콘)의 수명?
- 화면 밖으로 나간 타일의 데이터는?
```

**G6. 동시성 모델**

```
- 렌더 루프 중에 analysis가 돌면? 결과가 렌더 중간에 바뀌면?
- 여러 analysis가 동시에 돌 때 GPU 리소스 경합?
- simulation과 analysis가 같은 데이터를 읽으면?
- 스트림 업데이트가 렌더 중간에 도착하면?
- Web Worker와의 관계? analysis는 Worker에서?
```

**G7. 타입 시스템 에지 케이스**

```
- f32와 f64 혼합 연산 시 암묵적 변환? 명시적 캐스트만?
- rgba는 vec4<u8>? vec4<f32>? #ff0000과 rgba(1,0,0,1)의 관계?
- string은 GPU에서 사용 불가 — annotation의 text는 어떻게 처리?
- [T]의 크기를 컴파일 타임에 모르면? 동적 배열 vs 고정 배열?
- enum의 기저 타입이 다른 enum과 비교 가능한가?
- generic 함수의 타입 제약은 어떻게 표현? (Phase 2이지만 설계는 필요)
```

**G8. 좌표계 (CRS) — WGS84 하드코딩**

```
- UTM 존, 국가 좌표계 (TM, Bessel) 는?
- 달, 화성 지도는? (NASA/ESA 미션)
- 실내 지도 (건물 내부)는? 로컬 좌표계?
- 투영 변환은 언어 수준? 엔진 수준?
- 사용자 정의 CRS는 가능?
```

**G9. 텍스트 렌더링 — 과소 설계**

```
- SDF 텍스트? MSDF? 비트맵?
- 다국어 (한국어, 아랍어 RTL, CJK)?
- 라벨 배치 알고리즘 (충돌 회피)는 언어에서 제어? 엔진 내장?
- 라인 따라 흐르는 텍스트 (강 이름 등)?
- 텍스트 크기가 줌에 따라 고정(화면 px) vs 축척 연동?
- 폰트 로딩, 폰트 아틀라스 관리?
```

**G10. 확장/플러그인 시스템**

```
- 서드파티가 새 유틸리티 클래스를 추가할 수 있는가? (Tailwind의 plugin)
- 새로운 geometry 타입을 추가할 수 있는가?
- 새로운 analysis parallel 패턴을 추가할 수 있는가?
- effect만으로 충분한가, 아니면 렌더 파이프라인 자체를 확장?
- 컴파일러 플러그인 (커스텀 lint, 커스텀 최적화)?
```

### 지연 가능 (프로토타입 이후)

**G11. 접근성**: 색각 이상 모드, 스크린 리더, 고대비
**G12. 국제화**: RTL 레이아웃, 좌표 표기 관행 (DMS vs DD)
**G13. 버전 마이그레이션**: 언어 버전 간 호환성, 자동 마이그레이션 도구
**G14. 성능 프로파일링**: 개발자가 "이게 왜 느린지" 알 수 있는 도구
**G15. 시맨틱 버저닝**: .xgb 바이너리의 하위 호환성 보장
**G16. 테마 시스템**: 다크 모드, 인쇄 모드, 색각 이상 모드를 횡단 관심사로

---

## 17. G1 Resolution — 에러 처리 모델

### 17.1 설계 원칙

```
1. GPU 코드에서 예외는 불가능 (콜 스택 없음, try/catch 불가)
2. 데이터 부재는 예외가 아니라 일상 (센서 누락, 스트림 지연)
3. 부분 실패는 전체를 멈추면 안 됨 (10만 피처 중 5개 에러 → 5개만 스킵)
4. 컴파일 타임에 잡을 수 있는 에러는 모두 컴파일 타임에
```

### 17.2 타입 수준 — `T?` (nullable) 과 `Result<T, E>`

```
// ── nullable: 데이터가 없을 수 있는 것 ──

struct ShipTrack {
  position: vec2<f64>
  speed: f32
  name: string?                              // 이름이 없을 수 있음
  destination: vec2<f64>?                    // 목적지 미설정 가능
}

// nullable 접근 — 컴파일러가 강제하는 안전한 접근
let label = track.name ?? "Unknown"          // 기본값 폴백
let dest = track.destination ?? track.position  // 없으면 현재 위치

// 옵셔널 체이닝
let dest_name = track.destination?.reverse_geocode()?.city ?? "N/A"

// 조건부 처리
if let dest = track.destination {
  // dest는 여기서 non-null 보장
  draw_line(track.position, dest)
}

// 유틸리티에서 nullable 처리
| fill-[track.threat_level ?? 0 | ramp:reds]   // null이면 0으로 폴백
| size-[speed ?? 0 | clamp:4,24]


// ── Result<T, E>: 실패할 수 있는 연산 ──

fn parse_mgrs(input: string) -> Result<vec2<f64>, ParseError> {
  // ...
}

// 사용
let pos = parse_mgrs(raw_input) catch {
  log_warning("Invalid MGRS: {raw_input}")
  return default_position                    // 에러 시 대체값
}

// 또는 전파
fn process_coordinate(raw: string) -> Result<vec2<f64>, ParseError> {
  let pos = parse_mgrs(raw)?                 // ? 로 에러 전파 (Rust 스타일)
  return Ok(validate_bounds(pos))
}
```

### 17.3 실행 수준별 에러 처리

```
// ═══ GPU 코드 (@fragment, @vertex, @compute) ═══
// try/catch 불가. 대신:

// 1. 컴파일 타임에 최대한 방지
@fragment {
  let d = distance / range                   // range가 0이면?
}
// 컴파일러 경고: "range may be zero — use safe_div or guard"

// 2. 안전한 내장 함수
@fragment {
  let d = safe_div(distance, range, default: 0.0)   // 0 나누기 시 기본값
  let c = safe_normalize(direction)                   // 영벡터 시 vec3(0,1,0)
  let idx = safe_index(array, i, default: array[0])   // 범위 초과 시 기본값
}

// 3. NaN/Inf 전파 방지
@fragment {
  let result = complex_calculation(data)
  color = if is_nan(result) or is_inf(result) {
    vec4(1, 0, 1, 1)                         // 마젠타 = 에러 시각화
  } else {
    calculate_color(result)
  }
}


// ═══ analysis / simulation ═══

analysis route_scan {
  // step 수준 에러 처리
  step depth_check {
    parallel: per_cell(area, 10m)

    // 개별 셀 에러는 건너뛰기 (부분 실패 허용)
    on_error: skip(log: warning)

    let depth = sample(bathymetry, cell_position)
    // bathymetry에 데이터 없는 영역이면 sample은 null 반환
    let depth_val = depth ?? -9999.0         // 기본값
    // ...
  }

  // 전체 analysis 수준 에러 처리
  on_failure {
    output.hazards = []
    output.risk_score = -1.0                 // 에러 표시값
    output.error = error.message
    emit: "analysis_failed"(error)
  }
}

simulation oil_spill {
  update {
    // NaN 전파 방지 — 시뮬레이션이 발산하면 클램프
    concentration = clamp(concentration, 0.0, 100.0)
  }

  // 시뮬레이션 발산 감지
  on_diverge(field: concentration, threshold: 1000.0) {
    log_error("Simulation diverged at step {step_count}")
    pause()                                  // 자동 일시정지
    emit: "simulation_diverged"
  }
}


// ═══ 스트림 ═══

source ais_feed {
  type: stream
  // ...

  on_disconnect {
    retry: exponential_backoff(initial: 1s, max: 30s)
    after_retries(5) {
      emit: "stream_lost"("ais_feed")
      show: overlay(connection_lost_banner)
    }
  }

  on_malformed_message {
    action: skip                             // 잘못된 메시지 무시
    log: warning
  }

  on_schema_mismatch {
    action: coerce                           // 가능하면 타입 변환 시도
    fallback: skip                           // 불가능하면 스킵
  }
}


// ═══ 호스트 인터페이스 (@host) ═══
// @host 함수는 일반적인 try/catch 사용 가능 (CPU에서 실행)

@host fn load_chart_data(url: string) -> Result<ChartData, IOError> {
  try {
    let response = fetch(url)
    if response.status != 200 {
      return Err(IOError.http(response.status))
    }
    return Ok(parse_chart(response.body))
  } catch(e: NetworkError) {
    return Err(IOError.network(e.message))
  }
}
```

### 17.4 에러 시각화 — 디버그 모드

```
// 컴파일 옵션: --debug-errors
// 에러가 발생한 피처/셀을 시각적으로 표시

// NaN/Inf → 마젠타
// null 데이터 → 투명 + 회색 아웃라인
// 범위 초과 → 노란색 경고
// analysis 실패 셀 → 빨간 X 마크
```

---

## 18. G2 Resolution — 스코핑 규칙

### 18.1 스코프 계층

```
// 스코프는 바깥에서 안으로 상속, 안에서 바깥으로는 접근 불가

Global Scope
├── import된 모듈의 export (struct, fn, style, symbol, enum)
├── source 선언
├── input / uniform 선언
├── constexpr / comptime 상수
│
├── layer / entity / connection / annotation / overlay 스코프
│   ├── source의 스키마 필드 (자동 바인딩)
│   ├── 유틸리티 표현식 내 데이터 필드
│   │
│   ├── @fragment 스코프
│   │   ├── 부모의 데이터 필드 (자동 varying 생성)
│   │   ├── 내장 변수: uv, position, normal, color, time, ...
│   │   └── 로컬 let/var
│   │
│   ├── @vertex 스코프
│   │   ├── 부모의 데이터 필드 (vertex attribute)
│   │   ├── 내장 변수: position, instance_id, vertex_id, ...
│   │   └── 로컬 let/var
│   │
│   └── @compute 스코프
│       ├── 명시적으로 선언된 input만 접근
│       ├── 내장 변수: global_id, local_id, workgroup_id, ...
│       └── 로컬 let/var
│
├── analysis 스코프
│   ├── 자신의 input 선언
│   ├── step 스코프
│   │   ├── parallel 바인딩 변수 (cell_position, item, segment_index, ...)
│   │   ├── 이전 step의 output (명시적 참조만)
│   │   └── 로컬 let/var
│   └── reduce 스코프
│       └── 모든 step의 output 접근 가능 (step.name.field)
│
├── simulation 스코프
│   ├── state 필드 (읽기/쓰기)
│   ├── input 필드 (읽기만)
│   └── update/init 스코프
│       └── state + input + 내장 변수 (dt, time, step_count)
│
└── fn 스코프
    ├── 파라미터
    ├── Global scope의 constexpr/comptime
    ├── import된 fn
    └── 로컬 let/var
```

### 18.2 핵심 규칙

```
// ── 규칙 1: 데이터 필드는 source 바인딩으로 스코프 진입 ──

layer tracks {
  source: military_tracks          // schema: { position, speed, heading, classification }

  // speed, heading 등은 이 layer 스코프 내에서 바로 사용 가능
  | size-[speed / 50]              // OK: speed는 source 스키마의 필드
  | fill-[altitude | ramp:reds]    // ERROR: altitude가 스키마에 없으면 컴파일 에러
}


// ── 규칙 2: layer 간 직접 참조 불가 ──

layer tracks { source: track_data  /* ... */ }
layer buildings { source: building_data
  | fill-[tracks.speed]            // ERROR: 다른 layer의 데이터 접근 불가
}

// 해결: analysis나 공유 input을 통해 간접 참조
input shared_tracks: [Track]
layer tracks { source: shared_tracks /* ... */ }
// analysis에서 shared_tracks 참조 가능


// ── 규칙 3: entity는 이름으로 참조 가능 (connection, annotation에서) ──

entity ship_a(data: ...) { /* ... */ }
entity ship_b(data: ...) { /* ... */ }

connection link {
  from: ship_a.position            // OK: entity는 이름으로 참조 가능
  to: ship_b.position
}


// ── 규칙 4: analysis의 step 간 참조는 명시적 ──

analysis scan {
  step classify {
    // ...
    emit classified: [ClassifiedItem]
  }

  step evaluate {
    // 이전 step 결과 참조: step이름.출력이름
    for item in classify.classified {         // OK: 명시적 참조
      // ...
    }
  }

  // step 순서 = 선언 순서. 순환 참조는 컴파일 에러.
  step bad {
    for x in evaluate.results { }            // ERROR: evaluate는 bad 이후에 선언
  }
}


// ── 규칙 5: @fragment에서 사용된 필드 → 자동 varying ──

layer tracks {
  source: track_data               // { position, speed, heading, classification }

  @fragment {
    let s = speed                  // 컴파일러: speed를 varying으로 자동 전달
    let c = classification         // 컴파일러: classification을 flat varying으로
    let x = some_undefined         // ERROR: some_undefined는 스코프에 없음
  }
}


// ── 규칙 6: 이름 충돌 해결 ──

import { Track } from "@xgis/military"
import { Track } from "./local_types"        // ERROR: Track 이름 충돌

// 해결: 별칭
import { Track as MilTrack } from "@xgis/military"
import { Track as LocalTrack } from "./local_types"

// 블록 내 섀도잉
let x = 10
if condition {
  let x = 20                       // OK: 내부 스코프에서 섀도잉
  // x == 20
}
// x == 10
```

---

## 19. G3 Resolution — 유틸리티 → WGSL 컴파일 모델

### 19.1 유틸리티의 정체 — IR 노드

```
유틸리티 문자열을 파싱하면 각각이 하나의 IR 노드가 된다.
IR 노드는 렌더 파이프라인의 특정 단계에 매핑된다.

| fill-red-500                    → FragmentOutput.color = vec4(0.937, 0.267, 0.267, 1.0)
| stroke-2                        → PipelineConfig.line_width = 2.0
| size-[speed/50|clamp:4,24]      → VertexAttribute.size = clamp(speed / 50.0, 4.0, 24.0)
| hostile:fill-red-500            → Conditional(field: classification, eq: "hostile",
                                      then: FragmentOutput.color = vec4(0.937, ...))
| z8:opacity-40                   → ZoomInterpolation(zoom: 8, property: opacity, value: 0.4)
```

### 19.2 컴파일 단계

```
소스                        파싱                     IR                       최적화                  코드젠
──────                     ──────                   ──────                   ──────                  ──────
| fill-red-500          → Token(fill, red-500)   → SetColor(const)        → (상수 접기)            → WGSL
| hostile:fill-red-500  → Token(cond, fill)      → Branch(field, SetColor) → (variant 분리?)       → WGSL
| z8:op-40 z16:op-100   → Token(zoom, opacity)   → ZoomInterp(8→40,16→100) → (GPU uniform 보간)   → WGSL
| size-[speed/50]       → Token(size, expr)      → DataDriven(speed/50)    → (attribute 생성)      → WGSL
```

### 19.3 모디파이어 컴파일 전략

```
// ── 데이터 모디파이어: if 분기 vs 셰이더 variant ──

// 전략 A: 단일 셰이더 + if 분기 (기본)
// 장점: 셰이더 1개, 단순
// 단점: GPU에서 분기 divergence

| friendly:fill-green-500  hostile:fill-red-500  fill-gray-400

// 생성되는 WGSL:
// var base_color: vec4f;
// if (classification == 0u) { base_color = vec4f(0.34, 0.80, 0.36, 1.0); }
// else if (classification == 1u) { base_color = vec4f(0.94, 0.27, 0.27, 1.0); }
// else { base_color = vec4f(0.62, 0.62, 0.62, 1.0); }


// 전략 B: 셰이더 variant 분리 (컴파일러 최적화)
// 분류 종류가 적고 피처 수가 많으면, 분류별로 별도 셰이더 생성
// 장점: 분기 없음, GPU 효율적
// 단점: 셰이더 수 증가, 추가 드로우콜

// 컴파일러가 자동 판단:
//   분류 종류 <= 4 && 피처 수 > 10000 → variant 분리
//   그 외 → if 분기


// ── 줌 모디파이어: GPU uniform 보간 ──

| z8:opacity-40  z16:opacity-100

// 컴파일러가 생성:
// 1. CPU 측: 줌 레벨에 따른 보간 값 계산 → uniform으로 업로드
// 2. GPU 측: uniform에서 값 읽기 (프레임당 1회)

// CPU 코드 (자동 생성):
// const opacity = interpolate(zoom, [
//   { zoom: 8, value: 0.4 },
//   { zoom: 16, value: 1.0 }
// ]);
// uniformBuffer.opacity = opacity;

// WGSL:
// @group(0) @binding(0) var<uniform> frame: FrameUniforms;
// ...
// color.a *= frame.opacity;


// ── 인터랙션 모디파이어: hover/selected ──

| hover:glow-8  selected:stroke-yellow-400

// 컴파일러가 생성:
// 1. 피킹 패스 (별도 렌더 패스, feature ID를 렌더 타깃에 기록)
// 2. hover/selected 상태를 per-feature 플래그로 관리
// 3. 셰이더에서 플래그 확인

// WGSL:
// let is_hovered = (feature_flags & HOVER_BIT) != 0u;
// let is_selected = (feature_flags & SELECTED_BIT) != 0u;
// if (is_hovered) { /* glow effect */ }
// if (is_selected) { color = mix(color, yellow, 0.5); }
```

### 19.4 유틸리티 충돌 해결

```
// 같은 속성에 여러 값 → 마지막이 이긴다 (CSS cascade와 동일)
| fill-red-500  fill-blue-300
// 결과: fill-blue-300

// 모디파이어와 기본값 → 모디파이어가 더 구체적이므로 우선
| fill-gray-400  hostile:fill-red-500
// hostile일 때: fill-red-500
// 그 외:        fill-gray-400

// preset + 인라인 → 인라인이 preset을 오버라이드
| apply-military_track  fill-cyan-400
// military_track의 fill 값 대신 cyan-400 사용

// 우선순위 (낮은 → 높은):
// 1. preset 기본값
// 2. 인라인 기본값 (모디파이어 없는 유틸리티)
// 3. 줌 모디파이어
// 4. 데이터 모디파이어
// 5. 인터랙션 모디파이어 (hover, selected)
// 6. @fragment/@vertex 오버라이드 (최종)
```

### 19.5 유틸리티 → IR → WGSL 전체 파이프라인

```
layer tracks {                    ┌─────────────────────────┐
  source: track_data              │ 1. Parse utilities       │
  | symbol-arrow                  │    → SymbolRef(arrow)    │
  | size-[speed/50|clamp:4,24]    │    → DataDriven(size)    │
  | rotate-[heading]              │    → DataDriven(rotate)  │
  | friendly:fill-green-500       │    → Conditional(fill)   │
  | hostile:fill-red-500          │    → Conditional(fill)   │
  | fill-gray-400                 │    → Default(fill)       │
  | z8:opacity-40 z16:opacity-100 │    → ZoomInterp(opacity) │
  | hover:glow-8                  │    → Interaction(glow)   │
}                                 └───────────┬─────────────┘
                                              │
                                  ┌───────────▼─────────────┐
                                  │ 2. IR Construction       │
                                  │                          │
                                  │ RenderNode {             │
                                  │   geometry: arrow_mesh   │
                                  │   vertex_attrs: [        │
                                  │     size: clamp(s/50,4,24) │
                                  │     rotation: heading    │
                                  │     position: data.pos   │
                                  │   ]                      │
                                  │   fragment: {            │
                                  │     color: branch [      │
                                  │       class==0 → green   │
                                  │       class==1 → red     │
                                  │       _ → gray           │
                                  │     ]                    │
                                  │     opacity: zoom_interp │
                                  │     effects: [glow(8)]   │
                                  │   }                      │
                                  │   interactions: [hover]  │
                                  │   strategy: instanced    │
                                  │ }                        │
                                  └───────────┬─────────────┘
                                              │
                                  ┌───────────▼─────────────┐
                                  │ 3. Optimize              │
                                  │  - 상수 접기              │
                                  │  - variant 분리 결정     │
                                  │  - 배칭 전략 결정        │
                                  │  - uniform 팩킹          │
                                  └───────────┬─────────────┘
                                              │
                                  ┌───────────▼─────────────┐
                                  │ 4. Code Generation       │
                                  │                          │
                                  │  → vertex.wgsl           │
                                  │  → fragment.wgsl         │
                                  │  → pipeline layout       │
                                  │  → bind group layout     │
                                  │  → CPU host code (TS/C++)│
                                  └─────────────────────────┘
```

---

## 20. G4 Resolution — 통합 객체 모델

### 20.1 모든 개념의 관계도

```
                          ┌──────────────┐
                          │    Scene     │
                          │  (root)      │
                          └──────┬───────┘
                                 │ contains
            ┌────────────┬───────┼────────┬──────────────┐
            ▼            ▼       ▼        ▼              ▼
        ┌───────┐  ┌──────────┐ ┌──────┐ ┌───────────┐ ┌──────────┐
        │Source │  │Renderable│ │Compute│ │  Control  │ │  Bridge  │
        └───┬───┘  └────┬─────┘ └──┬───┘ └─────┬─────┘ └────┬─────┘
            │           │          │            │             │
        ┌───┴───┐   ┌───┴────┐   ┌┴─────┐  ┌──┴──┐      ┌──┴───┐
        │static │   │layer   │   │sim   │  │timeline│   │widget│
        │stream │   │entity  │   │analysis│ │state  │   │draw_ │
        │input  │   │connect │   │       │  │camera │   │ tool │
        │geometry│  │annotate│   │       │  │keyframe│  │      │
        │       │   │overlay │   │       │  │       │   │      │
        └───────┘   └────────┘   └───────┘  └──────┘   └──────┘

Source:     데이터 제공     (외부 데이터, 스트림, 인라인 지오메트리)
Renderable: 화면에 그림     (GPU 렌더링 파이프라인 통과)
Compute:    GPU 계산        (렌더링 아님, 데이터 생성/변환)
Control:    시간/상태 제어   (애니메이션, 상태 머신, 카메라)
Bridge:     호스트 UI 연동   (DOM/Qt 위젯, 드로잉 도구)
```

### 20.2 Renderable 통합 인터페이스

```
// 모든 Renderable이 공유하는 속성:

trait Renderable {
  z_order: i32                               // 렌더링 순서
  visible: bool                              // 가시성
  opacity: f32                               // 불투명도
  blend: BlendMode                           // 블렌딩 모드
  min_zoom: f32?                             // 최소 줌 (이하에서 숨김)
  max_zoom: f32?                             // 최대 줌 (이상에서 숨김)
  classification: SecurityLevel?             // 보안 등급
}

// layer, entity, connection, annotation, overlay 모두 Renderable이다.
// 유틸리티 문법이 동일하게 적용되는 이유.

// 차이점은 "좌표계"와 "데이터 바인딩":

                좌표계          데이터 소스          지오메트리 생성
layer           지리 (WGS84)   외부 소스 ([T])      소스 데이터 타입에 따라
entity          지리 (WGS84)   개별 바인딩           모델/심볼 직접 지정
connection      지리 (WGS84)   entity 위치 참조     from→to 라인 자동
annotation      지리 → 화면     데이터 바인딩         텍스트 + 배경 자동
overlay         화면 (px)       직접 바인딩           layout 기반
```

### 20.3 렌더 그래프 — 실행 순서

```
// 매 프레임 실행 순서:

1. Input Update
   - 스트림 데이터 수신 → 버퍼 업데이트
   - 호스트에서 set/update/bind 호출 처리
   - uniform 값 갱신 (zoom, time, camera)

2. Compute Phase (의존성 DAG 순서)
   - simulation.update() — 상태 갱신
   - analysis.run() — 입력 변경된 것만 재실행
   - computed geometry 재계산 — 입력 변경된 것만
   - state machine 전이 평가

3. Sort Phase
   - 모든 Renderable을 z_order로 정렬
   - 불투명 → 반투명 분리 (back-to-front)
   - 같은 파이프라인 → 배치 그룹핑

4. Render Phase (정렬된 순서대로)
   [Pass: Shadow Map]      — pipeline에서 shadow pass 선언된 경우
   [Pass: Main]
     4a. Opaque (앞에서 뒤로, early-z 활용)
       - layer (지형, 벡터 타일)
       - entity (불투명 모델)
       - geometry (불투명 폴리곤)
     4b. Transparent (뒤에서 앞으로)
       - connection (라인)
       - layer (반투명)
       - simulation 시각화
       - analysis 시각화
       - entity (반투명)
     4c. Screen-space
       - annotation (지리좌표 → 화면 변환 후)
       - overlay (화면 고정)
   [Pass: Post-process]    — pipeline에서 post pass 선언된 경우

5. Interaction Phase
   - 피킹 버퍼 읽기 (hover/click 판정)
   - 이벤트 디스패치

6. Present
   - 스왑체인에 출력

// 의존성이 있는 경우 (analysis 결과를 layer가 참조):
// analysis → computed geometry → layer
// 컴파일러가 의존성 그래프를 분석하여 정확한 실행 순서 보장
```

### 20.4 의존성 그래프 예시

```
input track_data ─────────────┬──→ layer tracks (직접 소스)
                              │
                              ├──→ analysis route_scan
                              │         │
                              │         ├──→ output hazards ──→ layer hazard_markers
                              │         │
                              │         └──→ output safe_zones
                              │                    │
                              │                    ├──→ geometry safe_corridor
                              │                    │         │
                              │                    │         └──→ layer corridor_display
                              │                    │
                              │                    └──→ analysis corridor_opt
                              │                              │
                              │                              └──→ connection opt_route
                              │
input wind_data ──────────────┼──→ simulation wind_flow
                              │         │
                              │         └──→ layer wind_viz (시각화)
                              │
input bathymetry ─────────────┘

// 컴파일러가 이 DAG를 분석하여:
// 1. 실행 순서 결정 (토폴로지 정렬)
// 2. 병렬 가능한 노드 식별 (wind_flow와 route_scan은 독립 → 동시 실행)
// 3. 변경 전파: track_data 변경 → route_scan 재실행 → hazards 갱신 → layer 갱신
//              wind_data 변경 → wind_flow만 재실행 (route_scan은 무관)
```

---

## 21. G5~G10 Resolution — 중요 갭 해결

### 21.1 G5: 메모리/리소스 수명

```
// 원칙: 소유권 기반 자동 관리. 개발자가 free/destroy를 호출하지 않는다.

소유자              자원                      해제 시점
──────             ──────                    ──────────
Scene              모든 Renderable           Scene.destroy()
layer              vertex/index buffer       layer 제거 시 또는 데이터 교체 시
entity             모델 메시, 텍스처          entity 제거 시
simulation         상태 버퍼 (더블 버퍼)      simulation 종료 시
analysis           캐시된 결과               입력 변경 시 (이전 캐시 해제)
TileManager        타일 메시/텍스처           LRU 캐시 정책 (%.화면 밖 + N프레임)

// 엔진이 관리하는 풀:
// - BufferPool: GPU 버퍼 재사용 (usage별 free-list)
// - TexturePool: 텍스처 재사용 (크기/포맷별)
// - MeshPool: 공유 메시 (symbol-arrow → 모든 인스턴스가 같은 메시 참조)
//
// 개발자가 힌트를 줄 수 있는 경우:
@cache(max_size: 100MB)
analysis heavy_computation { ... }

@preload                                     // 씬 로드 시 즉시 로드
model submarine_mesh { src: "submarine.glb" }
```

### 21.2 G6: 동시성 모델

```
// 원칙: 프레임 일관성. 한 프레임 내에서 데이터는 변하지 않는다.

프레임 경계       │ 프레임 N                          │ 프레임 N+1
─────────────    │ ──────────────────────────        │ ──────────
               ──┤                                  ├──
1. 데이터 스왑    │ 스트림 버퍼 → 활성 버퍼 교체        │
                 │ input.set/update 적용              │
                 │                                    │
2. 컴퓨트        │ simulation.step() — 이전 상태 읽기, 새 상태 쓰기 (더블버퍼)
                 │ analysis.run()   — 변경된 입력만   │
                 │ (compute pass)                     │
                 │                                    │
3. 렌더          │ 모든 Renderable 그리기              │
                 │ (render pass)                      │
                 │ 이 시점에서 데이터 변경 불가         │
                 │                                    │
4. 인터랙션      │ 피킹, 이벤트                       │
               ──┤                                  ├──

// 스트림 데이터 도착: 즉시 반영하지 않고 버퍼에 쌓음
// 프레임 시작 시 버퍼 스왑 → 일관된 데이터로 한 프레임 렌더링

// 장시간 analysis: 여러 프레임에 걸쳐 실행 가능
// → 이전 결과를 계속 표시, 새 결과 완료되면 다음 프레임에서 교체

analysis heavy_computation {
  // ...
  async: true                                // 비동기 실행 허용
  // 결과가 나올 때까지 이전 결과 유지
}
```

### 21.3 G7: 타입 시스템 에지 케이스

```
// ── f32 / f64 혼합 ──
// 암묵적 확장 (f32 → f64) 허용, 암묵적 축소 금지
let a: f64 = 3.14
let b: f32 = 2.0
let c = a + b               // OK: b가 f64로 확장, c는 f64
let d: f32 = a              // ERROR: f64 → f32 축소는 명시적 캐스트 필요
let d: f32 = f32(a)          // OK: 명시적 캐스트

// ── rgba ──
// rgba는 내부적으로 vec4<f32> (0.0~1.0)
// #ff0000은 rgba(1.0, 0.0, 0.0, 1.0) 의 리터럴 문법
let c: rgba = #ff0000         // OK
let v: vec4<f32> = c          // OK: rgba는 vec4<f32>의 별칭
let c2 = rgba(255, 0, 0, 255) // OK: u8 값은 자동으로 0~1 정규화

// ── string은 GPU 불가 ──
// string은 @host와 annotation에서만 사용
// GPU 코드 (@fragment 등)에서 string 사용 시 컴파일 에러
@fragment {
  let name = track.name        // ERROR: string cannot be used in GPU code
                               // help: use string fields only in annotation or @host
}

// ── 배열 크기 ──
let fixed: [f32; 16]           // 고정 크기 — GPU에서 사용 가능
let dynamic: [f32]             // 동적 — storage buffer로 매핑
// 동적 배열의 크기는 런타임에 결정 (호스트에서 set/bind 시)

// ── enum 비교 ──
enum A : u8 { x = 0 }
enum B : u8 { y = 0 }
let a = A.x
let b = B.y
a == b                         // ERROR: 다른 enum 타입 비교 불가
a == 0                         // ERROR: enum과 정수 직접 비교 불가
u8(a) == u8(b)                 // OK: 명시적 캐스트 후 비교
```

### 21.4 G8: CRS (좌표 참조 시스템)

```
// ── 기본: WGS84 (EPSG:4326) ──
// 별도 지정 없으면 모든 좌표는 WGS84 경위도 (도 단위)

// ── CRS 선언 ──
scene military_ops {
  crs: epsg(4326)                            // WGS84 (기본)
  // 또는
  crs: epsg(32652)                           // UTM Zone 52N
  crs: epsg(5186)                            // Korea 2000 / Central Belt
  crs: custom {
    type: transverse_mercator
    central_meridian: 127.0deg
    false_easting: 200000
    false_northing: 500000
    scale_factor: 1.0
    ellipsoid: bessel_1841
  }
}

// ── 좌표 변환은 엔진이 투명하게 처리 ──
// 데이터 CRS와 씬 CRS가 다르면 자동 변환

source korean_cadastral {
  type: vector
  crs: epsg(5186)                            // 한국 중부 좌표계
  url: "..."
}
// → 엔진이 5186 → 4326 변환을 자동 수행

// ── 비지구 좌표계 ──
scene mars_map {
  body: mars                                 // 화성 IAU 좌표계
  crs: iau(49901)                            // Mars geographic
  ellipsoid: mars_2000                       // a=3396190, b=3376200
}

scene indoor_map {
  crs: local                                 // 로컬 미터 좌표계
  origin: (127.0deg, 37.5deg)                // 로컬 원점의 WGS84 좌표
  unit: meter
  up: z                                      // Z-up (건물 내부)
}
```

### 21.5 G9: 텍스트 렌더링

```
// ── 엔진 수준 결정 (언어에서 제어하지 않는 것) ──
// - MSDF 텍스트 렌더링 (Multi-channel Signed Distance Field)
// - 폰트 아틀라스 자동 생성/캐싱
// - 글리프 메트릭스 처리

// ── 언어에서 제어하는 것 ──

annotation ship_label {
  source: ships

  text: "{name}\n{speed | format:'0.0'} kn"

  // 텍스트 스타일 (유틸리티)
  | text-14  text-white  text-bold
  | text-font-"Noto Sans KR"                // 다국어 폰트
  | text-align-center
  | text-max-width-200                       // 줄바꿈 기준
  | text-line-height-1.4

  // 배경
  | bg-black/70  padding-4-8  rounded-4

  // 배치
  | anchor-bottom  offset-y-[-20]
  | text-size-mode: screen                   // 줌 무관 고정 크기 (기본)
  // | text-size-mode: map                   // 축척 연동

  // 충돌 회피 (엔진 내장 알고리즘)
  collision {
    enabled: true
    priority: property(importance)            // 높은 것 우선
    padding: 4                               // 라벨 간 최소 간격
    fade_in: 200ms                           // 나타날 때 페이드인
  }

  // 라인 따라 흐르는 텍스트 (강 이름, 도로명)
  // text-placement: line                    // 라인 지오메트리를 따라 배치
  // text-placement: point                   // 포인트에 배치 (기본)
}
```

### 21.6 G10: 확장/플러그인 시스템

```
// ── 유틸리티 확장 (Tailwind 플러그인처럼) ──

// @xgis/plugin-military 패키지
export plugin military_utils {
  // 새 유틸리티 정의
  utility "mil-symbol" {
    params: (sidc: string)
    applies_to: symbol
    resolve: fn(sidc) -> SymbolDef { return decode_mil_std_2525(sidc) }
  }

  utility "threat-color" {
    params: (level: f32)
    applies_to: fill
    resolve: fn(level) -> rgba {
      return if level < 0.3 { green_500 }
             else if level < 0.7 { yellow_500 }
             else { red_500 }
    }
  }

  // 새 모디파이어 정의
  modifier "threat-high" {
    condition: fn(data) -> bool { return data.threat_level > 0.7 }
  }
}

// 사용
import plugin "@xgis/plugin-military"

layer tracks {
  | mil-symbol-[sidc]  threat-color-[threat_level]
  | threat-high:animate-pulse-500ms
}

// ── analysis 패턴 확장 ──

export parallel_pattern per_triangle(mesh: TriangleMesh) {
  // 삼각형 메시의 각 삼각형을 병렬 처리
  thread_count: mesh.triangle_count
  bindings {
    triangle_index: global_id.x
    triangle: mesh.triangles[triangle_index]
    v0: mesh.vertices[triangle.i0]
    v1: mesh.vertices[triangle.i1]
    v2: mesh.vertices[triangle.i2]
  }
}

// ── 컴파일러 플러그인 (lint) ──

export lint_rule no_unbounded_loop {
  check: fn(ast_node) {
    if ast_node.is_loop and !ast_node.has_bound {
      emit warning: "Unbounded loop may cause GPU hang. Add max iteration."
    }
  }
}
```

---

## 22. Embeddable & Reusable Primitives — 게임/외부 엔진 연동

### 22.1 포지셔닝

```
X-GIS는 게임 엔진이 아니다.
게임 엔진 안에서 지도 시스템으로 사용될 수 있다.

┌──────────────────────────┐
│ 게임 엔진 (Unity/Unreal) │  ← 게임 로직, 물리, AI, 넷코드
│   ┌──────────────────┐   │
│   │  X-GIS (임베딩)  │   │  ← 지도 렌더링, 좌표, 타일, 지형
│   └──────────────────┘   │
└──────────────────────────┘

또는:

┌──────────────────────────┐
│      X-GIS (단독)        │  ← 지도 애플리케이션 (군사, GIS, 시각화)
└──────────────────────────┘
```

**X-GIS가 제공하는 것**: 지도, 좌표계, 타일, 지형, 렌더링, 데이터 스트리밍
**X-GIS가 제공하지 않는 것**: 게임 루프, ECS, 패스파인딩, 물리 엔진, 넷코드

### 22.2 GIS에서 재활용되는 프리미티브

게임 엔진 기능은 X-GIS 범위 밖이지만, 일부 프리미티브는 GIS 자체에서 유용하다.
이것들은 `@xgis/core` 또는 별도 확장 패키지로 제공:

```
프리미티브         GIS 용도                              제공 위치
──────────        ──────────────────────               ──────────
공간 오디오        경고음, 근접 알림, 소나 신호            @xgis/audio
공간 충돌 감지     항로 위험 감지, 영역 진입 이벤트        @xgis/core (analysis)
공간 쿼리         반경 검색, 최근접 탐색                   @xgis/core
키보드 단축키     지도 조작, 도구 전환                     @xgis/core
```

#### 오디오 — 경고/알림 용도

```
import { audio, play } from "@xgis/audio"

// 경고음 선언
audio alert_proximity {
  src: "./assets/audio/warning_beep.wav"
  volume: 0.7
  spatial: true                              // 위치 기반 (가까울수록 큼)
  falloff: inverse_distance(ref: 1km, max: 50km)
}

audio alert_critical {
  src: "./assets/audio/alarm.wav"
  volume: 1.0
  loop: true
  spatial: false                             // 전역 (화면 전체)
}

// 사용: analysis 결과에 연동
on analysis_complete(route_hazard_scan) {
  if result.risk_score > 0.7 {
    play(alert_critical)
  }
}

// 사용: entity 이벤트에 연동
on entity_enter_zone(entity: any, zone: exclusion_zone) {
  play(alert_proximity, at: entity.position)
}
```

#### 공간 충돌 감지 — 영역 진입/이탈 이벤트

기존 `analysis`의 `per_pair` 패턴으로 이미 가능하지만, 선언적 단축 문법 제공:

```
// 영역 기반 트리거 (analysis로 컴파일됨)
trigger zone_alert {
  watch: fleet_ships                         // 감시 대상 엔티티
  zone: exclusion_zone                       // 감시 영역

  on enter(entity) {
    play(alert_proximity, at: entity.position)
    emit: "zone_violation"(entity, zone)
    entity | glow-16  glow-red-500           // 시각 강조
  }

  on exit(entity) {
    emit: "zone_cleared"(entity)
  }

  // 근접 경고 (영역 경계에서 N거리 이내)
  on approach(entity, distance: 5km) {
    entity | glow-4  glow-yellow-400
  }
}
```

### 22.3 게임 엔진에서 X-GIS를 지도 시스템으로 사용

```
// X-GIS는 게임 엔진의 "지도 서브시스템"으로 임베딩 가능

// Unity C# 예시:
// var mapView = XGISRuntime.CreateMapView(gameObject);
// mapView.LoadScene("tactical_map.xgb");
// mapView.Set("tracks", trackBuffer);
// mapView.OnEvent("track_selected", (id) => { SelectUnit(id); });

// Unreal C++ 예시:
// UXGISMapComponent* Map = CreateDefaultSubobject<UXGISMapComponent>("TacticalMap");
// Map->LoadScene("tactical_map.xgb");
// Map->Bind("tracks", TrackDataBuffer);

// 호스트 엔진이 제공하는 것: 게임 루프, 물리, AI, 네트워크, 오디오 믹싱
// X-GIS가 제공하는 것: 지도 렌더링, 좌표 변환, 타일 로딩, 데이터 시각화

// X-GIS의 output을 호스트 엔진에서 사용:
// - 렌더 결과를 텍스처로 호스트에 전달 (렌더 투 텍스처)
// - 클릭/이벤트를 호스트에 콜백
// - analysis 결과를 호스트에 반환 (충돌 데이터, 위험 정보 등)
```

---

## 23. Q1 Resolution — 정형 문법 (Core EBNF)

### 23.1 전체 문법 구조

파일 3종류의 최상위 구조:

```ebnf
(* ═══ .xgis — 씬 정의 ═══ *)
SceneFile     = { Import } , { Declaration } ;
Declaration   = SourceDecl | LayerDecl | EntityDecl | ConnectionDecl
              | AnnotationDecl | OverlayDecl | WidgetDecl
              | SimulationDecl | AnalysisDecl | GeometryDecl
              | TriggerDecl | TimelineDecl | DrawToolDecl
              | BindDecl | InputDecl | UniformDecl ;

(* ═══ .xgs — 형상 + 스타일 ═══ *)
StyleFile     = { Import } , { StyleDeclaration } ;
StyleDeclaration = SymbolDecl | PresetDecl | EffectDecl | PipelineDecl
                 | EnumDecl | StructDecl ;

(* ═══ .xgl — 로직 ═══ *)
LogicFile     = { Import } , { LogicDeclaration } ;
LogicDeclaration = FnDecl | TraitDecl | ImplDecl | EnumDecl | StructDecl
                 | StateMachineDecl | ConstDecl | CompTimeDecl ;
```

### 23.2 공통 기초 문법

```ebnf
(* ── 리터럴 ── *)
Literal       = NumberLit | StringLit | BoolLit | ColorLit | NoneLit ;
NumberLit     = ['-'] , Digits , [ '.' , Digits ] , [ Unit ] ;
Unit          = 'deg' | 'm' | 'km' | 'nm' | 'ft' | 'px' | 's' | 'ms'
              | 'kn' | 'MHz' | 'Gy' ;
StringLit     = '"' , { Char } , '"' ;
BoolLit       = 'true' | 'false' ;
ColorLit      = '#' , HexDigit , HexDigit , HexDigit , HexDigit , HexDigit , HexDigit
              , [ HexDigit , HexDigit ]           (* #RRGGBB or #RRGGBBAA *)
              | '#' , HexDigit , HexDigit , HexDigit ;   (* #RGB shorthand *)
NoneLit       = 'none' ;

(* ── 타입 ── *)
Type          = ScalarType | VectorType | MatrixType | ArrayType
              | NullableType | NamedType | GenericType ;
ScalarType    = 'bool' | 'u8' | 'u16' | 'u32' | 'i32' | 'f32' | 'f64'
              | 'rgba' | 'string' | 'geodetic' ;
VectorType    = ('vec2' | 'vec3' | 'vec4') , '<' , ScalarType , '>' ;
MatrixType    = 'mat' , Digit , 'x' , Digit , '<' , ScalarType , '>' ;
ArrayType     = '[' , Type , [ ';' , NumberLit ] , ']' ;   (* [f32] or [f32; 16] *)
NullableType  = Type , '?' ;
NamedType     = Identifier ;
GenericType   = Identifier , '<' , Type , { ',' , Type } , '>' ;

(* ── 식별자 ── *)
Identifier    = Letter , { Letter | Digit | '_' } ;
QualifiedId   = Identifier , { '.' , Identifier } ;

(* ── import ── *)
Import        = 'import' , '{' , ImportList , '}' , 'from' , StringLit ;
ImportList    = ImportItem , { ',' , ImportItem } ;
ImportItem    = Identifier , [ 'as' , Identifier ] ;
```

### 23.3 표현식 문법

```ebnf
(* ── 표현식 (로직 + 유틸리티 바인딩에서 공통) ── *)
Expr          = TernaryExpr ;
TernaryExpr   = LogicalExpr , [ 'if' , LogicalExpr , 'else' , TernaryExpr ] ;
LogicalExpr   = CompareExpr , { ('and' | 'or') , CompareExpr } ;
CompareExpr   = BitwiseExpr , { ('==' | '!=' | '<' | '>' | '<=' | '>=') , BitwiseExpr } ;
BitwiseExpr   = AddExpr , { ('&' | '|' | '^' | '<<' | '>>') , AddExpr } ;
AddExpr       = MulExpr , { ('+' | '-') , MulExpr } ;
MulExpr       = UnaryExpr , { ('*' | '/' | '%') , UnaryExpr } ;
UnaryExpr     = [ '-' | '!' | '~' ] , PostfixExpr ;
PostfixExpr   = PrimaryExpr , { FieldAccess | IndexAccess | FnCall | NullCoalesce | PipeChain } ;
FieldAccess   = '.' , Identifier ;
IndexAccess   = '[' , Expr , ']' ;
FnCall        = '(' , [ ArgList ] , ')' ;
NullCoalesce  = '??' , Expr ;
PipeChain     = '|' , PipeFn , { '|' , PipeFn } ;     (* 유틸리티 파이프 *)
PipeFn        = Identifier , [ ':' , ArgList ] ;       (* clamp:4,24  ramp:viridis *)

PrimaryExpr   = Literal | QualifiedId | '(' , Expr , ')'
              | MatchExpr | IfExpr | ForExpr | ArrayLit | StructLit ;

MatchExpr     = 'match' , [ Expr ] , '{' , { MatchArm } , '}' ;
MatchArm      = Pattern , '=>' , Expr ;
Pattern       = Literal | Identifier | '_' ;

IfExpr        = 'if' , Expr , Block , [ 'else' , (Block | IfExpr) ] ;
ForExpr       = 'for' , Identifier , 'in' , Expr , Block ;
Block         = '{' , { Statement } , [ Expr ] , '}' ;

ArgList       = Expr , { ',' , Expr } ;
ArrayLit      = '[' , [ Expr , { ',' , Expr } ] , ']' ;
StructLit     = Identifier , '{' , { Identifier , ':' , Expr , [','] } , '}' ;
```

### 23.4 유틸리티 스타일 문법 (핵심)

```ebnf
(* ── '|' 접두사 유틸리티 라인 ── *)
UtilityLine   = '|' , UtilityItem , { UtilityItem } ;

UtilityItem   = [ Modifier , ':' ] , UtilityName , [ '-' , UtilityValue ] ;

Modifier      = ZoomMod | DataMod | InteractMod | ThemeMod | CompoundMod ;
ZoomMod       = 'z' , Digits ;                         (* z8, z14 *)
DataMod       = Identifier                              (* friendly, hostile *)
              | '[' , Expr , ']' ;                      (* [speed>500] *)
InteractMod   = 'hover' | 'selected' | 'active' ;
ThemeMod      = 'dark' | 'light' ;
CompoundMod   = Modifier , ':' , Modifier ;             (* z14:hover *)

UtilityName   = Identifier , { '-' , Identifier } ;     (* fill, stroke-dash, animate-pulse *)

UtilityValue  = TokenValue | BracketExpr ;
TokenValue    = Identifier , { '-' , Identifier }       (* red-500, ease-out *)
              | NumberLit                                (* 2, 300ms *)
              | ColorLit ;                              (* #ff0000 *)
BracketExpr   = '[' , Expr , { '|' , PipeFn } , ']' ;  (* [speed/50|clamp:4,24] *)

(* ── 핵심 모호성 해결 ── *)
(* '|' 는 네 가지 의미:
     1. 유틸리티 라인 접두사: 줄 시작에서 '|' → UtilityLine
     2. 파이프 연산자: '[' ... '|' ... ']' → BracketExpr 내부 PipeChain
     3. 비트 OR 연산자: 표현식 내 → BitwiseExpr
     4. enum @flags 조합: Capability.radar | Capability.missile → BitwiseExpr (3과 동일)
   파서 규칙:
     줄 시작의 '|' = UtilityLine (1)
     '[' 이후의 '|' = PipeChain (2)
     그 외의 '|' = 비트 OR / BitwiseExpr (3, 4)
*)
```

### 23.5 주요 선언 문법

```ebnf
(* ── source ── *)
SourceDecl    = 'source' , Identifier , '{' , { SourceProp } , '}' ;
SourceProp    = Identifier , ':' , (Literal | Identifier | StructLit) ;

(* ── layer ── *)
LayerDecl     = 'layer' , Identifier , '{'
              , { LayerProp | UtilityLine | ShaderBlock }
              , '}' ;
LayerProp     = ('source' | 'source-layer' | 'filter' | 'z-order' | 'visible')
              , ':' , Expr ;
ShaderBlock   = ('@fragment' | '@vertex' | '@compute') , [ ParamList ] , Block ;

(* ── entity ── *)
EntityDecl    = 'entity' , Identifier , [ '(' , ParamList , ')' ] , '{'
              , { EntityProp | UtilityLine | EventHandler | ModelAnim }
              , '}' ;
EntityProp    = Identifier , ':' , Expr ;
EventHandler  = 'on' , Identifier , [ '(' , ParamList , ')' ] , Block ;

(* ── symbol ── *)
SymbolDecl    = 'symbol' , Identifier , [ '(' , ParamList , ')' ] , '{'
              , { ShapeElement | SymbolProp | ConditionalShape }
              , '}' ;
ShapeElement  = 'path' , StringLit                      (* SVG path *)
              | 'rect' , { Identifier , ':' , Expr }
              | 'circle' , { Identifier , ':' , Expr }
              | 'arc' , { Identifier , ':' , Expr }
              | 'text' , { Identifier , ':' , Expr }
              | 'svg' , ':' , StringLit ;
ConditionalShape = 'if' , Expr , '{' , { ShapeElement } , '}' ;

(* ── preset ── *)
PresetDecl    = 'preset' , Identifier , '{' , { UtilityLine } , '}' ;

(* ── struct / enum ── *)
StructDecl    = ['export'] , 'struct' , Identifier , '{' , { FieldDecl } , '}' ;
FieldDecl     = Identifier , ':' , Type , [ '=' , Expr ] ;
EnumDecl      = ['export'] , 'enum' , Identifier , [ ':' , ScalarType ] , [ '@flags' ]
              , '{' , EnumVariant , { EnumVariant } , '}' ;
EnumVariant   = Identifier , [ '=' , NumberLit ] ;

(* ── fn ── *)
FnDecl        = ['export'] , ['@host'] , ['constexpr' | 'comptime']
              , 'fn' , Identifier , '(' , [ ParamList ] , ')' , [ '->' , Type ]
              , Block ;
ParamList     = Param , { ',' , Param } ;
Param         = Identifier , ':' , Type , [ '=' , Expr ] ;

(* ── simulation ── *)
SimulationDecl = 'simulation' , Identifier , '{'
               , SimType , DomainDecl? , StateDecl
               , { InputProp } , InitBlock? , UpdateBlock
               , VisualizeBlock? , { SimControl }
               , '}' ;
SimType       = 'type' , ':' , ('grid' | 'particle' | 'agent' | 'ray') ;

(* ── analysis ── *)
AnalysisDecl  = 'analysis' , Identifier , '{'
               , { InputProp } , { OutputProp }
               , { AnalysisStep } , ReduceBlock?
               , { AnalysisControl }
               , '}' ;
AnalysisStep  = 'step' , Identifier , '{' , ParallelDecl , { Statement } , '}' ;
ParallelDecl  = 'parallel' , ':' , ParallelPattern ;
ParallelPattern = 'per_segment' , '(' , Expr , ')'
                | 'per_cell' , '(' , Expr , ',' , 'resolution' , ':' , Expr , ')'
                | 'per_item' , '(' , Expr , ')'
                | 'per_pair' , '(' , Expr , ',' , Expr , ')'
                | 'per_ray' , '(' , { Identifier , ':' , Expr } , ')' ;
```

### 23.6 문법 요약 통계

```
키워드:        ~60개 (layer, entity, simulation, analysis, fn, struct, enum, ...)
연산자:        ~25개 (+, -, *, /, ==, !=, and, or, |, ??, ?, =>, ...)
리터럴 타입:    6종 (숫자, 문자열, 불리언, 색상, none, 단위 접미사)
블록 타입:     16종 (layer, entity, connection, annotation, overlay, ...)
수식 우선순위:  8단계 (단항 > 곱셈 > 덧셈 > 비트 > 비교 > 논리 > 파이프 > 삼항)
```

---

## 24. Q2 Resolution — 기존 도구 마이그레이션

### 24.1 Mapbox Style JSON → X-GIS 자동 변환

```
// Mapbox Style JSON:
{
  "layers": [{
    "id": "buildings",
    "type": "fill",
    "source": "composite",
    "source-layer": "building",
    "paint": {
      "fill-color": ["match", ["get", "type"],
        "residential", "#4a90d9",
        "commercial", "#d94a4a",
        "#cccccc"
      ],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"],
        12, 0.6, 16, 0.9
      ]
    }
  }]
}

// 자동 변환 결과 (xgisc convert mapbox-style.json --output=scene.xgis):
layer buildings {
  source: composite
  source-layer: "building"
  | residential:fill-[#4a90d9]  commercial:fill-[#d94a4a]  fill-[#cccccc]
  | z12:opacity-60  z16:opacity-90
}

// 변환 가능한 것:
//   fill, line, circle, symbol 기본 속성   → 유틸리티
//   match 표현식                           → 데이터 모디파이어
//   interpolate 표현식                     → 줌 모디파이어
//   source/source-layer                    → source 참조

// 변환 불가능한 것 (수동 작업 필요):
//   CustomLayerInterface                   → @fragment/@vertex 수동 작성
//   복잡한 중첩 표현식                      → 로직 함수로 추출
```

### 24.2 데이터 포맷 호환성

```
지원해야 하는 포맷              우선순위    구현 방식
────────────────              ────────   ──────────
GeoJSON                        P0        source { type: geojson }
벡터 타일 (MVT/PBF)            P0        source { type: vector }
래스터 타일 (PNG/JPEG/WebP)    P0        source { type: raster }
래스터 DEM (Mapbox Terrain)    P0        source { type: raster-dem }
3D Tiles (Cesium)              P1        source { type: 3d-tiles }
GeoPackage (.gpkg)             P1        source { type: geopackage }
Shapefile (.shp)               P2        변환 도구 (xgisc convert)
KML/KMZ                        P2        변환 도구
GML                            P2        변환 도구
S-57/S-100 (해도)              P1        source { type: s100 } (별도 섹션 참조)
HDF5 (S-102 등)                P1        source { type: hdf5, schema: ... }
COG (Cloud Optimized GeoTIFF)  P1        source { type: cog }
Arrow/Parquet (GeoArrow)       P1        source { type: arrow } 제로카피
CSV/TSV                        P2        source { type: csv, lat: "y", lon: "x" }
```

### 24.3 기존 프로젝트 점진적 마이그레이션

```
// 기존 Mapbox GL JS 앱에 X-GIS 레이어를 추가 (하이브리드 모드)

// JavaScript:
import mapboxgl from 'mapbox-gl'
import { XGISLayer } from '@xgis/mapbox-bridge'

const map = new mapboxgl.Map({ ... })

// X-GIS 레이어를 Mapbox CustomLayer로 주입
map.addLayer(new XGISLayer({
  scene: 'military_overlay.xgb',
  inputs: { tracks: trackBuffer }
}))

// 반대 방향: X-GIS 앱에서 Mapbox 스타일을 베이스맵으로 사용
scene tactical_display {
  basemap {
    type: mapbox-style
    url: "mapbox://styles/mapbox/dark-v11"
    token: env.MAPBOX_TOKEN
  }
  // X-GIS 레이어를 베이스맵 위에 추가
  layer tracks { ... }
}
```

---

## 25. Q3 Resolution — 개발자 도구 체인

### 25.1 CLI 도구 — `xgisc`

```
xgisc init [project-name]              프로젝트 스캐폴딩
xgisc dev [scene.xgis] --watch         개발 서버 (핫 리로드)
xgisc build [scene.xgis] --target=...  컴파일 (webgpu/vulkan/headless/cpu)
xgisc check [scene.xgis]              타입 체크 + lint (빌드 없이)
xgisc test                             테스트 실행
xgisc convert [input] --output=[out]   포맷 변환 (Mapbox JSON, Shapefile 등)
xgisc codegen [scene.xgis] --target=ts 호스트 바인딩 코드 생성
xgisc bundle --offline                 에어갭용 패키지 번들
xgisc lsp                             Language Server 시작 (IDE용)
xgisc fmt [files...]                  코드 포매터
xgisc doc [files...]                  문서 생성
```

### 25.2 프로젝트 구조

```
my-project/
  xgis.config.json                   프로젝트 설정
  src/
    scene.xgis                       메인 씬
    styles/
      military.xgs                   스타일 + 심볼
      terrain.xgs
    logic/
      analysis.xgl                   분석/로직
      transforms.xgl
    assets/
      models/                        3D 모델 (.glb)
      icons/                         SVG 아이콘
      audio/                         오디오 파일
  tests/
    analysis.test.xgl                테스트
    visual/
      golden/                        골든 이미지
  dist/                              빌드 출력
    scene.xgb                        컴파일된 바이너리
    bindings.ts                      호스트 바인딩
    shaders/                         생성된 WGSL
```

```json
// xgis.config.json
{
  "name": "tactical-display",
  "version": "0.1.0",
  "entry": "src/scene.xgis",
  "target": "webgpu",
  "dependencies": {
    "@xgis/military": "^1.0.0",
    "@xgis/viz": "^1.0.0"
  },
  "tokens": {
    "colors": { "primary": "#1a73e8", "danger": "#d93025" },
    "sizes": { "sm": 4, "md": 8, "lg": 16 }
  }
}
```

### 25.3 비주얼 도구

```
xgisc studio                         비주얼 스타일 에디터 (웹 기반)
xgisc playground                     브라우저 플레이그라운드

// Studio 기능:
// - 유틸리티 실시간 미리보기 (Tailwind Play처럼)
// - 디자인 토큰 에디터 (색상 팔레트, 크기 스케일)
// - 심볼 에디터 (SVG path 시각적 편집)
// - 데이터 소스 미리보기
// - 성능 프로파일러 (프레임 그래프, GPU 메모리)

// Playground 기능:
// - 브라우저에서 .xgis 코드 직접 작성 + 실시간 렌더링
// - 예제 갤러리 (군사, 해양, 도시 등)
// - 공유 URL (코드를 URL로 인코딩)
```

---

## 26. Q4 Resolution — 성능 모델

### 26.1 컴파일 타임 경고

```
// 컴파일러가 비싼 패턴을 감지하여 경고:

warning[P0001]: O(n^2) complexity in analysis
  --> analysis.xgl:15:5
   |
15 |   parallel: per_pair(ships, obstacles)    // 10000 x 50000 = 500M pairs
   |             ^^^^^^^^ this creates 500,000,000 thread invocations
   |
help: consider spatial indexing:
   |   parallel: per_item(ships)
   |   let nearby = query_radius(obstacles, position, 1km)

warning[P0002]: excessive shader variants
  --> scene.xgis:30
   |
30 |   | [type=="a"]:fill-red  [type=="b"]:fill-blue  ... (24 variants)
   |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   |     24 data modifiers on same property generates 24 shader variants
   |
help: use a color ramp instead:
   |   | fill-[type_index | ramp:categorical_24]

warning[P0003]: large uniform buffer
  --> scene.xgis:12
   |
12 |   input config: BigStruct                 // 128KB > 64KB uniform limit
   |                 ^^^^^^^^^
help: will be backed by storage buffer (slower random access)

info[P0004]: render bundle opportunity
  --> scene.xgis:5
   |
5  |   layer basemap { ... }                   // static data, no data modifiers
   |         ^^^^^^^
   |   this layer never changes — consider @strategy(render_bundle) for CPU savings
```

### 26.2 런타임 프로파일러

```
// 개발 모드에서 자동 활성화:
xgisc dev scene.xgis --profile

// 프레임 예산 보기:
// ┌─────────────────────────────────────┐
// │ Frame: 16.7ms (60fps target)       │
// ├─────────────────────────────────────┤
// │ Input update:     0.3ms  ██        │
// │ Simulation:       1.2ms  ████      │
// │ Analysis:         0.0ms  (cached)  │
// │ Compute pass:     2.1ms  ███████   │
// │ Render pass:      8.4ms  █████████████████████████ │
// │   Opaque:         3.1ms                │
// │   Transparent:    4.8ms                │
// │   Annotation:     0.5ms                │
// │ Present:          0.1ms                │
// │ Total:           12.1ms  ✓ budget OK  │
// ├─────────────────────────────────────┤
// │ GPU Memory:      245MB / 4GB        │
// │ Draw calls:      47                 │
// │ Triangles:       1.2M               │
// │ Shader variants: 12                 │
// │ Active tiles:    64                 │
// │ Cached analyses: 3/5               │
// └─────────────────────────────────────┘

// 성능 어노테이션 (소스에서):
@profile("hazard_scan")
analysis route_hazard_scan { ... }

// 프로파일 결과에서 이 이름으로 표시됨
```

### 26.3 성능 가이드라인

```
권장 한계                          값
──────────                        ──────
프레임 예산                        16.7ms (60fps) / 33.3ms (30fps)
GPU 메모리                         디바이스의 50% 이하
드로우콜                           < 200 per frame
셰이더 variant                     < 32
활성 타일                          < 256
파티클 수                          < 1M (instanced)
analysis per_pair 상한             N*M < 10M (경고), < 100M (에러)
simulation grid 해상도             < 4096x4096
스트림 업데이트 빈도               < 60Hz per source
```

---

## 27. Q5 Resolution — 첫 프로토타입 (MVP) 범위

### 27.1 MVP 목표

**"GeoJSON 데이터를 지도 위에 유틸리티 스타일로 렌더링"**

한 문장으로: `source → layer → | fill-red-500 → 화면에 빨간 폴리곤`

### 27.2 MVP에 포함되는 것

```
구성 요소           범위                              이유
──────────         ──────────────────               ──────
파서               scene.xgis 파싱 (source, layer, |) 핵심 문법 검증
타입 체커          struct, 기본 스칼라/벡터, nullable   타입 안전성 최소 검증
IR 생성            유틸리티 → RenderNode IR            컴파일 모델 검증
WGSL 코드젠        fill, stroke, size, opacity → WGSL  셰이더 생성 검증
WebGPU 렌더러      점/선/폴리곤 기본 렌더링              화면 출력 검증
GeoJSON 소스       GeoJSON 파일/URL 로딩               데이터 입력 검증
CLI                xgisc dev --watch                   개발 루프

지원 유틸리티:
  fill-{color}                    채우기 색상
  stroke-{color}                  테두리 색상
  stroke-{width}                  테두리 두께
  opacity-{value}                 불투명도
  size-{value}                    점 크기
  z{N}:*                          줌 모디파이어 (보간)
  {field}={value}:*               데이터 모디파이어 (1단계)
  [field]                         데이터 바인딩 (단순)
```

### 27.3 MVP에 포함되지 않는 것

```
Phase 2:
  entity, connection, annotation, overlay, widget
  simulation, analysis
  3D (extrude, 3D geometry, 3D models)
  @fragment, @vertex, @compute (셰이더 탈출구)
  symbol (커스텀 형상)
  animation (state, timeline, motion)
  stream (실시간 데이터)
  effect, pipeline (고급 렌더링)

Phase 3:
  서버 사이드 / 헤드리스
  멀티 유저 협업
  보안 / 접근 제어
  게임 엔진 임베딩
  S-100 지원
```

### 27.4 MVP 아키텍처

```
my-scene.xgis ──→ [Parser] ──→ [Type Check] ──→ [IR Gen] ──→ [WGSL Gen] ──→ WebGPU
                     │              │                │              │
                  AST 생성       타입 검증        RenderNode     vertex.wgsl
                  (키워드,       (소스 스키마      (geometry,      fragment.wgsl
                   유틸리티,      매칭, 유틸리티    properties,     pipeline config
                   표현식)        타입 해석)       modifiers)

                                                                    │
GeoJSON ──→ [Loader] ──→ GPU Buffers ──→──→──→──→──→──→──→──→──→──→──┘
                │                                              (vertex/index
                Feature tessellation                            buffers)
                (폴리곤 → 삼각형, 라인 → 스트립)
```

### 27.5 MVP 파일 구조

```
xgis-compiler/                    (Rust or TypeScript)
  src/
    parser/
      lexer.rs                    토크나이저
      parser.rs                   재귀 하강 파서
      ast.rs                      AST 노드 타입 정의
    checker/
      types.rs                    타입 시스템
      resolver.rs                 이름 해석 + 스코프
    ir/
      nodes.rs                    IR 노드 타입
      lower.rs                    AST → IR 변환
      optimize.rs                 상수 접기, 데드 코드 제거
    codegen/
      wgsl.rs                     IR → WGSL
      pipeline.rs                 렌더 파이프라인 설정 생성
      bindings.rs                 바인드 그룹 레이아웃 생성
    cli/
      main.rs                     CLI 진입점

xgis-runtime/                     (TypeScript, 브라우저)
  src/
    engine/
      context.ts                  WebGPU 초기화
      renderer.ts                 렌더 루프
      tile-manager.ts             타일 로딩 (향후)
    data/
      geojson-loader.ts           GeoJSON 파싱 + 테셀레이션
      buffer-manager.ts           GPU 버퍼 관리
    runtime/
      scene.ts                    컴파일된 씬 로드 + 실행
      uniform-manager.ts          uniform 갱신 (줌, 시간 등)

apps/playground/                  (Vite + Monaco Editor)
  src/
    editor.ts                     코드 에디터
    preview.ts                    실시간 미리보기
```

---

## 28. S-100 Hydrographic Standard Support — 해도 표준 지원

### 28.1 S-100 프레임워크 개요

```
S-100은 IHO(국제수로기구)의 차세대 해양 데이터 모델 프레임워크.
기존 S-57(전자해도)을 대체하며, 다양한 해양 데이터 제품을 통합 정의.

S-100 (프레임워크)
 ├── S-101: 전자해도 (ENC) — 항해용 벡터 해도
 ├── S-102: 수심 표면 (Bathymetric Surface) — 고해상도 수심 그리드
 ├── S-104: 수위 정보 (Water Level) — 조석/해면 높이
 ├── S-111: 해면 해류 (Surface Currents) — 해류 벡터 필드
 ├── S-121: 해양 경계 (Maritime Limits)
 ├── S-124: 항행 경고 (Navigational Warnings)
 ├── S-127: 해상 교통 관리 (Marine Traffic)
 └── S-201: 항로 표지 (Aids to Navigation)

핵심 기술:
  데이터 인코딩: ISO 8211 (S-101 벡터), HDF5 (S-102/S-104/S-111 그리드)
  좌표계: WGS84 (EPSG:4326)
  피처 모델: ISO 19100 기반 피처-속성 모델
  표현 모델: Portrayal Catalogue (Lua 스크립팅 + SVG 심볼)
```

### 28.2 X-GIS와 S-100의 적합성 분석

```
S-100 요구사항                    X-GIS 대응                     적합성
───────────────                  ──────────                     ──────
벡터 피처 렌더링 (S-101)          layer + utility styling         ✓✓✓ 완벽
그리드 데이터 시각화 (S-102)      layer + fill-[depth|ramp:...]   ✓✓✓ 완벽
해류 벡터 필드 (S-111)           simulation/layer + 화살표        ✓✓✓ 완벽
조건부 심볼라이제이션              데이터 모디파이어 시스템          ✓✓✓ 완벽
SVG 심볼                         symbol { svg: "..." }           ✓✓✓ 완벽
수심 등치선                       geometry = contour(...)          ✓✓ 좋음
Portrayal Catalogue              import "@xgis/s100/portrayal"   ✓✓ 번역 필요
Lua 스크립팅                      X-GIS 로직으로 대체             ✓ 재작성 필요
ISO 8211 파싱                     source { type: s100 } 드라이버  △ 신규 구현
HDF5 파싱                         source { type: hdf5 } 드라이버  △ 신규 구현
SCAMIN (축척 최소 표시)            z-모디파이어와 동일 개념          ✓✓✓ 자연스러움
Safety Contour/Depth              analysis + trigger             ✓✓✓ 완벽 적합
```

### 28.3 S-100이 X-GIS에 가져오는 장점

```
1. Portrayal Catalogue ↔ 유틸리티 시스템의 자연스러운 매핑

   S-100 Portrayal Catalogue:
     IF OBJL == LNDARE AND CATLAS == 1 THEN
       SYMBOL(LNDARE01)
       COLOUR(LANDA)
     ENDIF

   X-GIS 유틸리티:
     layer land_areas {
       source: s101_enc
       source-layer: "LNDARE"
       | [CATLAS==1]:symbol-lndare01  fill-landa
     }

   → S-100의 조건부 심볼 규칙이 X-GIS 모디파이어로 1:1 매핑됨

2. 해양 분석이 analysis와 자연 결합

   // 안전 수심선 계산
   analysis safety_contour {
     input enc: S101Dataset
     input vessel_draft: f32
     output safe_contour: [line]
     output danger_areas: [polygon]

     step extract_depths {
       parallel: per_cell(enc.depth_area, resolution: 10m)
       let depth = sample(enc.bathymetry, cell_position)
       if depth < vessel_draft + 2.0 {
         emit danger: cell_position
       }
     }
   }

3. 실시간 해양 데이터와 stream의 결합

   source tide_data {
     type: stream
     protocol: s104                          // S-104 수위 데이터 스트림
     url: "wss://hydro.example.com/s104"
   }

   source current_data {
     type: stream
     protocol: s111                          // S-111 해류 데이터 스트림
   }

   // 실시간 수위에 따른 수심 보정
   layer dynamic_depth {
     source: s101_enc
     | fill-[depth + tide_data.current_level | ramp:blues]
   }
```

### 28.4 S-100 전환 타임라인과 기회

```
2026.01  S-100 ECDIS "dual-fuel" 허용 (S-57과 S-100 모두 사용 가능)
2029.01  신규 설치 ECDIS는 S-100 필수
미정      S-57 완전 폐지 (아직 날짜 없음)

→ 2026~2029 전환기는 X-GIS에게 기회:
  - 기존 ECDIS는 벤더 종속 (7CS, CARIS — 고가, 폐쇄적)
  - OpenS100 (C++/MFC/Direct2D) — Windows 전용, 확장 어려움
  - GDAL — S-102/S-104/S-111 읽기만 (S-101 미지원)
  - OpenCPN — S-100 미지원 (논의 중)

  X-GIS가 S-100을 지원하면:
  - 크로스플랫폼 (WebGPU/Vulkan/Metal) S-100 뷰어
  - 해도 + 전술 + 분석 통합
  - Lua Portrayal을 X-GIS 유틸리티로 대체 (더 강력)
  - 오픈 생태계 (커스터마이즈 가능)
```

### 28.5 Lua Portrayal → X-GIS 유틸리티 변환

S-100 Part 9a는 Lua 스크립팅으로 피처→심볼 매핑을 정의.
이것을 X-GIS 유틸리티로 번역하는 것이 핵심 과제:

```
// ── S-101 Lua Portrayal (현재 방식) ──

-- Lua: 수심 영역 표현
function DEPARE04(feature, contextParameters)
  local DRVAL1 = feature:GetAttribute("DRVAL1")
  local DRVAL2 = feature:GetAttribute("DRVAL2")
  local safetyContour = contextParameters.SAFETY_CONTOUR

  if DRVAL1 >= safetyContour then
    -- 안전 수심: 밝은 파랑
    feature:AddDrawInstruction("AC(DEPMD)")
  elseif DRVAL2 >= safetyContour then
    -- 위험 수심 경계: 중간 파랑
    feature:AddDrawInstruction("AC(DEPMS)")
  else
    -- 위험 수심: 진한 파랑
    feature:AddDrawInstruction("AC(DEPDW)")
  end
end


// ── X-GIS 유틸리티 (변환 결과) ──

// context parameter는 uniform으로 매핑
uniform safety_contour: f32 = 30.0

layer depth_areas {
  source: s101_enc
  source-layer: "DEPARE"

  // Lua의 if-else 체인 → 데이터 모디파이어
  | [DRVAL1>=safety_contour]:fill-depmd
  | [DRVAL2>=safety_contour]:fill-depms
  | fill-depdw

  // SCAMIN → 줌 모디파이어
  | z[scamin_to_zoom(SCAMIN)]:visible
}

// IHO 색상 팔레트 (S-52 호환)
// @xgis/s100/portrayal 에서 제공
tokens s52_colors {
  depmd: #c8e6ff     // 안전 수심 (밝은 파랑)
  depms: #8cb4d2     // 위험 수심 경계 (중간 파랑)
  depdw: #4a82a6     // 위험 수심 (진한 파랑)
  landa: #f5e6c8     // 육지
  // ... 200+ S-52 색상 코드
}
```

**자동 변환 도구:**
```
xgisc convert-portrayal \
  --catalogue=S-101_Portrayal_Catalogue/ \
  --output=s101_styles.xgs

// 변환 결과:
//   - Lua 함수 → preset/유틸리티 (90% 자동)
//   - SVG 심볼 → symbol { svg: "..." } (100% 자동)
//   - 색상 코드 → tokens (100% 자동)
//   - Context parameters → uniform (100% 자동)
//   - 복잡한 Lua 로직 → @host fn 또는 수동 (10%)
```

### 28.6 S-100 지원의 기술적 과제

```
과제                              난이도    해결 방안
──────────                       ──────   ──────────
1. ISO 8211 파서                  높음     GDAL/OGR의 S-57 파서 래핑
   (S-101 벡터 인코딩)                     또는 Rust ISO 8211 신규 구현
                                          (OpenS100 C++ 참조 가능, LGPL)

2. S-101 Feature Catalogue        중간     560+ 피처, 수천 속성
   → struct 자동 생성                      XML Feature Catalogue → xgisc codegen
                                          protobuf처럼 struct 자동 생성

3. Portrayal Catalogue 번역       중간     Lua → X-GIS 유틸리티 자동 변환
   (Lua → 유틸리티)                        SVG 심볼은 100% 자동
                                          조건 로직은 90% 자동 + 10% 수동

4. HDF5 그리드 로딩               중간     hdf5-wasm (웹) / libhdf5 (네이티브)
   (S-102/S-104/S-111)                    GDAL 드라이버 활용 가능
                                          grid2d<f32> + 불확실성 band 2개

5. S-52 색상/심볼 팔레트           낮음     200+ 색상 코드 → tokens
                                          SVG 심볼 → symbol 직접 참조
                                          주/야간/박모 3가지 색상 세트

6. SCAMIN (축척 최소 표시)         낮음     z-모디파이어로 자연스럽게 매핑
                                          | z[scamin_to_zoom(SCAMIN)]:visible

7. Context Parameters              낮음     uniform으로 직접 매핑
   (안전 수심, 선박 흘수 등)                uniform safety_contour: f32 = 30.0

8. Multi-product 통합              높음     S-101 + S-102 + S-104 + S-111 결합
   (S-98 Interoperability)                S-98이 레이어 순서 규칙 정의
                                          → z-order + 렌더 그래프로 구현

9. 데이터 보호 (S-100 Part 15)     높음     디지털 서명 + 암호화
                                          → 보안 섹션(15장)과 통합

10. ECDIS 인증                     매우높음  IHO 테스트 표준 아직 미완성 (2025 현재)
                                           → 장기 목표, 초기에는 비인증 뷰어/분석 도구
```

### 28.7 S-100 표준 라이브러리

```
// @xgis/s100 — S-100 해양 데이터 표준 지원 패키지

import { S101Loader, S102Loader, S104Stream, S111Stream } from "@xgis/s100"
import { IHOPalette, S52Symbols, PortrayalCatalogue } from "@xgis/s100/portrayal"

// S-101 전자해도 로딩
source enc_chart {
  type: s101
  path: "./charts/KR5A01M0.000"             // ISO 8211 파일
  // 또는
  url: "https://enc-server.example.com/s101/{z}/{x}/{y}"  // 타일 서비스
}

// S-102 수심 표면
source bathymetry_hd {
  type: s102
  path: "./bathy/KR_Busan_harbor.h5"        // HDF5 파일
}

// S-101 해도를 IHO S-52 규격으로 표시
layer enc_display {
  source: enc_chart
  portrayal: S52                             // IHO S-52 표시 규격 적용
  // S-52 규격이 유틸리티 preset으로 번역됨:
  // - DEPARE → 수심 영역: 색상 코드
  // - DEPCNT → 수심 등치선
  // - LNDARE → 육지 영역
  // - BUOYAG → 부표: SVG 심볼
  // - LIGHTS → 등화: 섹터 표시
  // 등 560+ 피처 자동 스타일링
}

// S-52 규격을 커스터마이즈하고 싶을 때:
layer enc_custom {
  source: enc_chart
  portrayal: S52

  // S-52 기본 스타일 위에 오버라이드
  override DEPARE {
    | fill-[DRVAL1 | ramp:ocean:0,200]       // 수심 색상을 커스텀 램프로
  }
  override BUOYAG {
    | size-[zoom | step:12:8,16]             // 부표 크기를 줌에 따라 조절
  }
}

// S-102 고해상도 수심을 분석에 활용
analysis under_keel_clearance {
  input bathy: bathymetry_hd                 // S-102 HDF5 수심
  input route: planned_route
  input draft: vessel_draft
  input tide: tide_data                      // S-104 실시간 조석

  step check_clearance {
    parallel: per_cell(buffer(route, 100m), resolution: 5m)
    let depth = sample(bathy, cell_position)
    let adjusted_depth = depth + tide.current_level
    let ukc = adjusted_depth - draft

    if ukc < 2.0 {
      emit hazard: UKCHazard {
        position: cell_position
        clearance: ukc
        depth: adjusted_depth
      }
    }
  }

  output hazards: [UKCHazard]
  output min_ukc: f32
}
```

### 28.8 S-100과 X-GIS의 시너지

```
기존 ECDIS 방식                           X-GIS 방식
────────────                             ──────────
S-52 Portrayal Catalogue (고정)           유틸리티 스타일 (커스터마이즈 가능)
Lua 스크립팅 (제한적)                     X-GIS 로직 (analysis, simulation)
단일 해도 표시                            해도 + 전술 데이터 + 분석 통합
오프라인 전용                             실시간 스트리밍 (S-104, S-111)
2D 고정                                  2D/3D + 지형 + 볼류메트릭
벤더 종속 (7CS, CARIS 등)                 오픈 표준 + 확장 가능

X-GIS의 고유 가치:
  같은 언어로 해도 표시 + 전술 오버레이 + 위험 분석 + 항로 최적화를
  하나의 통합된 씬에서 처리.
  S-100은 데이터 소스 중 하나일 뿐, 렌더링과 분석은 X-GIS가 통합.
```

---

## 29. OSM Ecosystem Insights — 설계 반영

### 29.1 모든 렌더링 시스템이 수렴하는 패턴

OSM 생태계의 6개 시스템(osm2pgsql, CartoCSS, Overpass, MapCSS, Tangram, Mapnik)을 분석한 결과, **모든 지도 렌더링은 동일한 3단계 파이프라인**으로 수렴한다:

```
Stage 1: Data Extract       Stage 2: Rule Match         Stage 3: Visual Output
데이터 추출/필터             조건 매칭                    시각 속성 결정
─────────────              ──────────                   ──────────────
osm2pgsql Lua              MapCSS selector              Mapnik Symbolizer
Overpass QL                CartoCSS selector            CartoCSS properties
SQL in layer def           Mapnik <Filter>              Tangram draw rules
Tangram source filter      Tangram layer filter         SVG/PNG symbols

X-GIS 대응:
source { ... }             | modifier:utility           유틸리티 값
input / stream             [expression]:*               @fragment
filter: expression         z{N}:*                       symbol / effect
```

**X-GIS는 이미 이 패턴을 따르고 있다.** 하지만 OSM에서 가져올 개선점이 있다:

### 29.2 개선 1: 데이터 전처리 파이프라인 (`transform`)

osm2pgsql Flex의 핵심 강점: **원본 데이터를 렌더링 전에 변환/정제**하는 단계.
현재 X-GIS에는 이 단계가 명시적으로 없다.

```
// ═══ 데이터 전처리 — osm2pgsql Flex에서 영감 ═══

// OSM 원본 태그는 비정형 (key=value 문자열)
// 렌더링 전에 정제/변환이 필요

source osm_roads {
  type: vector
  url: "https://tiles.example.com/osm/{z}/{x}/{y}.pbf"

  // transform 블록: 데이터가 레이어에 도달하기 전에 실행
  transform {
    // 태그 정규화 (OSM의 비일관적 태그 처리)
    let road_class = match tags.highway {
      "motorway" | "motorway_link"  => RoadClass.motorway
      "trunk" | "trunk_link"        => RoadClass.trunk
      "primary" | "primary_link"    => RoadClass.primary
      "secondary" | "secondary_link" => RoadClass.secondary
      "tertiary" | "tertiary_link"  => RoadClass.tertiary
      "residential" | "living_street" => RoadClass.residential
      "service"                     => RoadClass.service
      _                             => RoadClass.other
    }

    // 타입 변환 (문자열 → 숫자)
    let lanes = parse_int(tags.lanes) ?? default_lanes(road_class)
    let speed = parse_speed(tags.maxspeed) ?? default_speed(road_class)
    // parse_speed: "50 mph" → 80.5, "30" → 30.0 (km/h 가정)

    // 파생 속성 계산
    let width = lanes * 3.5
    let is_bridge = tags.bridge == "yes"
    let is_tunnel = tags.tunnel == "yes"
    let is_oneway = tags.oneway == "yes" or road_class == RoadClass.motorway

    // 조건부 필터 (렌더링 불필요 데이터 제거)
    if road_class == RoadClass.other and zoom < 14 {
      discard                                // 이 피처를 버림
    }

    // 출력 스키마 (이후 레이어에서 사용할 수 있는 필드)
    emit {
      road_class: road_class
      lanes: lanes
      speed: speed
      width: width
      is_bridge: is_bridge
      is_tunnel: is_tunnel
      is_oneway: is_oneway
      name: tags.name
    }
  }
}

// transform 이후 → 레이어에서 정제된 데이터를 사용
layer roads {
  source: osm_roads
  | stroke-w-[width]
  | RoadClass.motorway:stroke-red-600
  | RoadClass.primary:stroke-yellow-500
  | RoadClass.residential:stroke-gray-400
  | z8:opacity-40  z14:opacity-100
  | [is_bridge]:stroke-compound [{ w: width+4, color: gray-800 }, { w: width, color: inherit }]
  | [is_tunnel]:stroke-dash-10-5  opacity-60
  | [is_oneway]:decorate-arrow(interval: 100px, size: 6)
}
```

### 29.3 개선 2: 셀렉터 통합 — JOSM MapCSS에서 영감

JOSM MapCSS의 핵심 발견: **같은 셀렉터 문법으로 스타일링 + 데이터 검증 + 쿼리**가 가능.

```
// ═══ X-GIS에서 셀렉터 통합 ═══

// 1. 스타일링에서 (기존 모디파이어와 동일)
layer roads {
  | [highway=="primary" and lanes>2]:stroke-w-6  stroke-red-600
  | [highway=="primary"]:stroke-w-4  stroke-red-400
}

// 2. 데이터 검증에서 (같은 셀렉터 문법)
validate osm_roads {
  warn [highway=="primary" and !name] {
    message: "Primary road without name"
    severity: warning
  }
  warn [maxspeed and parse_int(maxspeed) == none] {
    message: "Invalid maxspeed value: {maxspeed}"
    severity: error
  }
  warn [lanes and parse_int(lanes) > 8] {
    message: "Unusually high lane count: {lanes}"
    severity: info
  }
}

// 3. 공간 쿼리에서 (Overpass QL 영감)
query nearby_hospitals {
  source: osm_data
  select: [amenity=="hospital"]
  within: radius(current_position, 5km)
  sort_by: distance
  limit: 10
}
```

### 29.4 개선 3: 모듈 조합 — osm2pgsql Themepark에서 영감

Themepark 패턴: 관심사별로 독립적인 "토픽"을 정의하고 조합.

```
// ═══ theme 시스템 — 도메인별 독립 모듈을 조합 ═══

// @xgis/osm/themes/roads.xgs
export theme roads {
  transform { /* 도로 태그 정규화 */ }
  layer road_fill { /* 도로 채우기 */ }
  layer road_casing { /* 도로 외곽선 */ }
  layer road_labels { /* 도로 이름 */ }
}

// @xgis/osm/themes/water.xgs
export theme water {
  transform { /* 수체 태그 정규화 */ }
  layer water_area { /* 호수, 바다 */ }
  layer waterway { /* 강, 하천 */ }
  layer water_labels { /* 수체 이름 */ }
}

// @xgis/osm/themes/buildings.xgs
export theme buildings {
  transform { /* 건물 태그 정규화 */ }
  layer building_footprint { /* 건물 면 */ }
  layer building_3d { /* 3D 돌출 (높이 있을 때) */ }
}

// 사용: 테마를 조합하여 지도 구성
scene city_map {
  source osm { type: vector, url: "..." }

  use theme roads from "@xgis/osm/themes/roads"
  use theme water from "@xgis/osm/themes/water"
  use theme buildings from "@xgis/osm/themes/buildings"

  // 테마 위에 커스텀 레이어 추가
  layer custom_overlay { ... }

  // 테마 내부 레이어 오버라이드
  override roads.road_fill {
    | RoadClass.motorway:stroke-blue-600     // 고속도로를 파란색으로
  }
}
```

### 29.5 개선 4: 줌 처리 — CartoCSS의 실패에서 배움

CartoCSS에서 가장 고통스러운 부분: 줌×피처 조합 폭발.
X-GIS의 줌 모디파이어(`z8:`, `z16:`)는 이미 이를 해결하지만, **연속 보간**을 더 명시적으로:

```
// ═══ CartoCSS 방식 (고통) ═══
// 12줄, 수동 반복
#roads[highway='primary'] {
  [zoom >= 8]  { line-width: 1; }
  [zoom >= 10] { line-width: 2; }
  [zoom >= 12] { line-width: 3; }
  [zoom >= 14] { line-width: 4; }
  [zoom >= 16] { line-width: 6; }
  [zoom >= 18] { line-width: 8; }
}

// ═══ X-GIS 방식 (해결) ═══
// 1줄, 자동 보간
| stroke-w-z(8: 1, 12: 3, 18: 8)            // 줌 보간 단축 문법

// 또는 기존 모디파이어 (2줄)
| z8:stroke-w-1  z12:stroke-w-3  z18:stroke-w-8
// → 컴파일러가 중간 줌에서 선형 보간 자동 적용

// 보간 모드 지정
| stroke-w-z(8: 1, 18: 8, easing: exponential(1.5))  // 지수 보간
| stroke-w-z(8: 1, 18: 8, easing: step)               // 계단 (보간 없음)
```

### 29.6 개선 5: 멀티패스 렌더링 — Mapnik/CartoCSS `::` 에서 영감

도로의 경우 외곽선(casing) → 채우기(fill) → 라벨 순서로 렌더링해야 한다.
CartoCSS는 `::casing`, `::fill` 서브레이어로 처리. X-GIS에서는:

```
// ═══ 멀티패스 렌더링 — 같은 데이터를 여러 번 그리기 ═══

// 방법 1: stroke-compound (이미 설계됨)
layer roads {
  source: osm_roads
  | stroke-compound [
      { w: width+4, color: gray-800 }     // casing (먼저)
      { w: width, color: white }           // fill (나중에)
    ]
}

// 방법 2: 명시적 pass 분리 (더 복잡한 경우)
layer roads {
  source: osm_roads

  pass casing {
    z-order: 10
    | stroke-w-[width+4]  stroke-gray-800
  }

  pass fill {
    z-order: 11
    | stroke-w-[width]  stroke-white
    | [is_bridge]:stroke-[#ffffcc]
  }

  pass center_line {
    z-order: 12
    visible: zoom >= 16
    | stroke-w-1  stroke-dash-5-3  stroke-gray-400
  }

  pass labels {
    z-order: 100
    | text-[name]  text-12  text-gray-800
    | text-along-line  text-spacing-300
    | collision-auto  priority-[road_class]
  }
}
```

### 29.7 개선 6: Mapnik filter-mode — first vs all

```
// Mapnik의 통찰: 규칙 매칭 모드를 선택할 수 있다

// first-match (switch/case처럼 — 첫 매칭에서 멈춤)
layer roads {
  source: osm_roads
  match-mode: first                          // 첫 매칭만 적용

  | [highway=="motorway"]:stroke-red-600  stroke-w-6    // 고속도로면 여기서 끝
  | [highway=="primary"]:stroke-yellow-500  stroke-w-4   // 아니면 주요도로 검사
  | stroke-gray-400  stroke-w-2                          // 아무것도 아니면 기본값
}

// all-match (CSS처럼 — 매칭되는 모든 규칙 누적)
layer features {
  source: osm_data
  match-mode: all                            // 모든 매칭 누적 (기본)

  | [highway]:stroke-w-3                     // highway 태그 있으면 두께 3
  | [lit=="yes"]:glow-4  glow-yellow-300     // 조명 있으면 글로우 추가
  | [surface=="unpaved"]:stroke-dash-5-3     // 비포장이면 대시 추가
  // → 모든 조건이 동시에 적용될 수 있음
}
```

### 29.8 요약 — OSM에서 가져온 6가지 개선

```
개선                    출처                     X-GIS 반영
──────                 ──────                   ──────────
1. transform 블록       osm2pgsql Flex          source 내 데이터 전처리 파이프라인
2. 셀렉터 통합          JOSM MapCSS             스타일 + 검증 + 쿼리에 같은 문법
3. theme 조합           osm2pgsql Themepark     독립 테마 모듈 조합 (use theme)
4. 줌 보간 단축          CartoCSS 반면교사       stroke-w-z(8: 1, 18: 8, easing: exp)
5. 멀티패스 (pass)      CartoCSS ::sublayer     layer 내 pass { } 블록
6. match-mode           Mapnik filter-mode      first-match vs all-match 선택
```

---

## 30. Confirmed Decision — 라이선스

**MIT / Apache 2.0 듀얼 라이선스** (Rust 방식)

```
적용 범위:
  컴파일러 (xgisc)          MIT / Apache 2.0
  런타임 (xgis-runtime)     MIT / Apache 2.0
  표준 라이브러리 (@xgis/*)  MIT / Apache 2.0
  언어 스펙 문서             CC BY 4.0

사용자 코드 (.xgis/.xgs/.xgl):
  사용자 소유. 라이선스 전파 없음.
```

근거: 군사/기업 환경에서 GPL 전파 우려 없이 채택 가능. Apache 2.0의 특허 보호 + MIT의 단순함.

---

## 31. Consistency Audit — 전체 일관성 검증

### 31.1 검증 매트릭스

모든 렌더링 가능 개념에 대해 기능 지원 여부를 교차 검증:

```
                  유틸리티  모디파이어  데이터     렌더링     pass   인터랙션  애니메이션  좌표계    transform
                  | ...    z/data/   [expr]    프리미티브  블록    on ...   state/     geo/     적용
                           hover                                          motion     screen   가능

layer             ✓        ✓         ✓         ✓ 전체     ✓      ✓        ✓ partial  geo      ✓
entity            ✓        ✓         ✓         ✓ tint     ✗      ✓        ✓ full     geo      ✗ (직접)
connection        ✓        ✓         ✓         ✓ stroke   ✗      ✓        ✓ dash     geo      ✗
annotation        ✓        ✓ z/data  ✓         ✓ text/bg  ✗      ✗ →수정  ✗ →수정    geo→scr  ✗
overlay           ✓        ✓ data    ✓         ✓ limited  ✗      ✓ child  ✓ animate  screen   ✗
widget            ✗        ✗         ✓ props   ✗         ✗      ✓ callback ✗        screen   ✗
sim.visualize     ✓        ✓ state   ✓         ✓ pt/line  ✗      ✗        ✓ implicit geo      ✗
analysis→layer    ✓        ✓         ✓         ✓ 전체     ✓      ✓        ✓         geo      ✗
geometry→layer    ✓        ✓ z       ✓ computed ✓ 전체    ✗ →수정 ✓        ✗ →수정    geo      ✗
draw_tool         ✓        ✗         ✗         ✓ stroke   ✗      ✓ custom ✗         geo      ✗
```

### 31.2 발견된 불일치 7개 + 수정

**I1. annotation에 인터랙션이 없다**

annotation을 클릭하여 상세 정보를 보고 싶은 것은 자연스러운 요구.
현재 설계: annotation에 `on click`이 명시적으로 없음.

```
// 수정: annotation도 인터랙션 지원
annotation ship_label {
  source: ships
  text: "{name}"
  | text-14  text-white  bg-black/70

  // 추가: 인터랙션
  on click {
    select: event.feature
    show: info_panel(event.feature)
  }
  on hover {
    | bg-blue-900/90                         // 호버 시 배경 강조
  }
}
```

**I2. annotation에 애니메이션이 없다**

경고 어노테이션이 깜빡이거나, 새로 나타날 때 페이드인하는 것은 필수.

```
// 수정: annotation도 transition/animate 지원
annotation warning_label {
  source: warnings
  text: "WARNING: {message}"
  | text-red-500  text-bold  bg-red-900/80
  | animate-pulse-1s                         // 깜빡임
  | transition-opacity-300ms                 // 나타날 때 페이드인
}
```

**I3. geometry→layer에 pass 블록이 없다**

computed geometry (예: 버퍼 존, 등치선)를 렌더링할 때
외곽선 + 채우기를 별도 패스로 분리하고 싶을 수 있음.

```
// 수정: geometry를 소스로 쓰는 layer에서 pass 사용 가능
// (이미 layer가 pass를 지원하므로, geometry가 소스일 때도 동일하게 동작)
layer buffer_zone {
  source: safe_corridor                      // computed geometry

  pass fill {
    z-order: 5
    | fill-green-500/15
  }
  pass outline {
    z-order: 6
    | stroke-green-400  stroke-w-2  stroke-dash-10-5
  }
  pass label {
    z-order: 100
    | text-"Safe Corridor"  text-12  text-green-300  text-along-line
  }
}
```
→ 이 경우 기존 설계에서 이미 가능하지만, 명시적으로 문서화되지 않았음.

**I4. entity에 렌더링 프리미티브(fill/stroke)가 제한적**

entity는 `tint-*`, `outline-*`만 가능하고 `fill-hatch`, `stroke-compound` 등 상세 프리미티브를 쓸 수 없다.
3D 모델 외에 2D 심볼로 렌더링되는 entity도 있으므로 (예: symbol-arrow 사용 시), 프리미티브 전체가 필요.

```
// 수정: entity가 symbol 기반일 때는 layer와 동일한 프리미티브 지원
entity waypoint(data: Waypoint) {
  position: data.position

  // 3D 모델이 아닌 2D 심볼 → 전체 프리미티브 사용 가능
  | symbol-diamond  size-12
  | fill-radial(center, white, blue-500)     // 방사형 그라디언트
  | stroke-2  stroke-blue-600
  | hover:glow-4
}

// 3D 모델일 때는 제한적 (tint, outline만)
entity submarine(data: SubTrack) {
  model: submarine_mesh
  | tint-blue-300                            // 모델 전체 틴트
  | selected:outline-yellow-400  outline-2   // 선택 시 외곽선
}
```
→ symbol 기반 entity = layer 수준 프리미티브, model 기반 entity = tint/outline만.

**I5. connection에 fill 프리미티브가 없다**

connection은 현재 stroke 전용이지만, 두 엔티티 사이의 **면적**(예: 통신 빔, 레이더 커버리지 콘의 2D 투영)을 표현하고 싶을 수 있다.

```
// 수정: connection에 geometry 옵션 추가
connection comm_beam {
  from: ship_a.position
  to: ship_b.position

  // 기본: 라인
  geometry: line
  | stroke-green-400  stroke-w-2

  // 확장: 폴리곤 (빔 형태)
  geometry: beam(width_start: 10m, width_end: 500m)
  | fill-green-500/10  stroke-green-400  stroke-w-1

  // 확장: 호 (곡선 연결)
  geometry: arc(curvature: 0.3)
  | stroke-cyan-400  stroke-w-2
}
```

**I6. transform이 stream 소스에서도 동작해야 한다**

transform은 정적 소스에서만 예시가 있지만, stream(실시간)에서도 비정형 데이터를 정제해야 한다.

```
// 수정: stream + transform
source ais_feed {
  type: stream
  protocol: websocket
  url: "wss://ais.example.com"

  // 스트리밍 데이터도 transform 적용
  transform {
    // AIS 메시지의 비정형 필드 정규화
    let ship_type = match msg.type {
      1 | 2 | 3 => ShipType.cargo
      6 | 7     => ShipType.passenger
      30..37    => ShipType.fishing
      _         => ShipType.other
    }
    let speed_ms = msg.sog * 0.514444         // 노트 → m/s
    let heading = msg.cog ?? msg.true_heading ?? 0

    if msg.mmsi == 0 or msg.lat == 0 { discard }  // 잘못된 데이터 버림

    emit { mmsi: msg.mmsi, position: (msg.lon, msg.lat), ship_type, speed_ms, heading, name: msg.vessel_name }
  }

  buffer: 100
  throttle: 100ms
}
```

**I7. match-mode와 theme의 상호작용이 미정의**

theme 내부 레이어에서 match-mode가 설정되어 있고, 사용하는 씬에서 override할 때 match-mode도 바뀌는가?

```
// 수정: 명확한 규칙 정의
// theme 내부의 match-mode는 해당 레이어의 기본값
// scene에서 override 시 match-mode도 override 가능

export theme roads {
  layer road_fill {
    match-mode: first                        // theme 기본값
    | [highway=="motorway"]:stroke-red-600
    | [highway=="primary"]:stroke-yellow-500
    | stroke-gray-400
  }
}

scene my_map {
  use theme roads
  override roads.road_fill {
    match-mode: all                          // override 가능
    | [lit=="yes"]:glow-2                    // 누적 모드로 추가 규칙
  }
}
```

### 31.3 수정 요약

```
불일치         대상              수정 내용
──────        ──────           ──────────
I1            annotation        on click/hover 인터랙션 추가
I2            annotation        animate/transition 지원 추가
I3            geometry→layer    pass 블록 명시적 문서화 (이미 가능)
I4            entity            symbol 기반 → 전체 프리미티브, model 기반 → tint/outline
I5            connection        geometry 옵션 (line/beam/arc) 추가
I6            transform         stream 소스에서도 동작 확인
I7            match-mode+theme  override 시 match-mode도 변경 가능 명시
```

### 31.4 최종 통합 흐름도 — "지도 위에 무언가를 그린다"

```
개발자의 의도                    X-GIS 개념           경로
───────────────                ──────────          ──────

"벡터 데이터를 스타일링"         layer               source → [transform] → | utilities
"3D 모델을 배치"               entity              input → entity(data) → model + | tint
"두 객체를 잇는 선"             connection          entity refs → from/to → | stroke
"특정 위치에 텍스트"            annotation          position + text → | text utilities
"화면 고정 HUD"               overlay             anchor + children → | layout
"호스트 UI 위젯"              widget              props → React/Qt component
"물리 시뮬레이션 시각화"        simulation          state → update → visualize → | utilities
"GPU 분석 결과 표시"           analysis → layer    input → steps → output → layer.source
"도형을 직접 정의"             geometry → layer    inline/computed → layer.source
"사용자가 그리기"              draw_tool           user input → on_complete → geometry/emit
"도형을 반복 렌더링"           line_pattern/symbol SVG 경로 → 반복/인스턴싱
"OSM 데이터 정제 후 렌더링"    source + transform  tags → normalize → emit → layer

모든 경로에서 공통:
  | utilities (fill/stroke/point/gradient/hatch/pattern)
  modifiers (z8: / hostile: / hover: / dark:)
  [expression] data binding
  | pipe formatting
  pass 블록 (필요 시)
  on click/hover 인터랙션
  animation (state/motion/transition)
```

---

## 32. Remaining Open Questions (남은 미결정 사항)

1. **컴파일러 구현 언어**: Rust (성능 + WASM) vs TypeScript (빠른 프로토타이핑)?
2. **IR 설계**: 자체 바이트코드 vs SPIR-V 확장?
3. **패키지 레지스트리**: 독자 vs npm 기생?
