# @xgis/compiler

X-GIS의 순수 TypeScript 프론트엔드. `.xgis` 스타일 소스 문자열을 받아 IR(`Scene`),
런타임용 `SceneCommands`, WGSL `ShaderVariant[]`, 그리고 GPU-ready 벡터 타일 데이터로
변환한다. **GPU 의존성이 없다** — WGSL은 문자열로 *방출(emit)*될 뿐 컴파일되지 않으므로
브라우저나 `navigator.gpu` 없이 Node/Bun에서 결정적으로 동작하고 단위 테스트가 가능하다.

모노레포 안에서의 역할은 "컴파일러": `@xgis/runtime`이 GPU에 올릴 모든 재료(셰이더,
유니폼/팔레트, 타일 지오메트리)를 오프라인 또는 런타임에 생성한다. Mapbox/MapLibre
스타일 임포터와 데이터-사이드 벡터 타일러도 이 패키지가 호스트한다.

전체 모노레포 개요는 루트 [`README.md`](../README.md), 패키지 내부 구조는
[`AGENTS.md`](./AGENTS.md)와 [`src/AGENTS.md`](./src/AGENTS.md)를 참고. 이 문서는
진입점이며 그 내용을 복제하지 않고 링크한다.

## Install / Import

워크스페이스 내부 패키지(`private`, `workspace:*`)다. 별도 설치 없이 import한다.

```ts
import { Lexer, Parser, lower, optimize, emitCommands } from '@xgis/compiler'
import type { ShaderVariant, Scene } from '@xgis/compiler'
```

소비자는 항상 패키지 배럴(`@xgis/compiler`)에서 import한다. 유일한 deep-path 예외는
`package.json` `exports`에 선언된 `@xgis/compiler/tiler/geodesic`이다. `main`/`exports`는
`src/index.ts`(TS 직접 소비)를 가리킨다.

## Pipeline

```
.xgis source
  │
  Lexer ─→ Parser ─→ AST
                      │
                    lower()        AST → IR (Scene)
                      │
                   optimize()      const-fold · classify · IR passes (CSE/dead-code/merge)
                      │
          emitCommands │ codegen
         /                       \
   SceneCommands            ShaderVariant[] · ComputeKernel · Palette
         \                       /
          @xgis/runtime + WebGPU
```

각 스테이지의 1줄 요약 — 상세는 디렉터리별 AGENTS.md로 링크한다.

| Stage | 역할 | Detail |
|-------|------|--------|
| `convert/` | Mapbox/MapLibre 스타일 → `.xgis` 소스 임포터 (`convertMapboxStyle`) | [convert/AGENTS.md](./src/convert/AGENTS.md) |
| `lexer/` · `parser/` | 토크나이저 + 재귀하강 파서, AST 노드 타입 생성 | [parser/AGENTS.md](./src/parser/AGENTS.md) |
| `ir/` | AST→IR `lower()`, `optimize()`, 표현식 분류(`classify`), const-fold, deps, `emitCommands` | [ir/AGENTS.md](./src/ir/AGENTS.md) · [ir/passes/AGENTS.md](./src/ir/passes/AGENTS.md) |
| `tiler/` | GeoJSON → GPU-ready 타일 피라미드 (clip · simplify · earcut · geodesic · DSFUN/ECEF pack) | [tiler/AGENTS.md](./src/tiler/AGENTS.md) · [geojsonvt/AGENTS.md](./src/tiler/geojsonvt/AGENTS.md) |
| `input/` | MVT(.pbf) 타일 디코더 — 타일러 파이프라인 입력 (`decodeMvtTile`) | [input/AGENTS.md](./src/input/AGENTS.md) |
| `codegen/` | WGSL `ShaderVariant` + compute 커널 + 팔레트 방출 | [codegen/AGENTS.md](./src/codegen/AGENTS.md) |
| `eval/` · `format/` | 컴파일/런타임 표현식 평가기, 값 포매터/텍스트 템플릿 파서 | [eval/AGENTS.md](./src/eval/AGENTS.md) · [format/AGENTS.md](./src/format/AGENTS.md) |

표현식은 세 가지 실행 클래스로 나뉘어 대부분의 설계를 결정한다: `constant`(컴파일 타임
폴딩), `zoom-dependent`(유니폼/팔레트로 프레임당 CPU 보간), `per-feature-gpu/cpu`(WGSL
코드젠 또는 스토리지 버퍼 업로드). 자세한 분류는 `src/ir/classify.ts`.

## Public Surface

모든 공개 심볼은 [`src/index.ts`](./src/index.ts) 배럴에서 재노출된다. 무언가를 찾을 때
가장 먼저 읽을 파일이다. 주요 export:

- **Front-end** — `Lexer`, `Parser`, `TokenType`, AST 타입(`export type * from parser/ast`)
- **IR** — `lower`, `optimize`, `emitCommands`, `Scene` · `SourceDef` · `RenderNode` 등 타입,
  `PropertyShape`, 색/투명도/크기 헬퍼(`hexToRgba`, `colorConstant`, `sizeConstant` …)
- **Eval / Format** — `evaluate`, 예약 키(`CAMERA_ZOOM_KEY` …), `formatValue`,
  `parseFormatSpec`, `parseTextTemplate`, `formatDMS`/`formatDM`/`formatBearing` …
- **Codegen** — `ShaderVariant`, `wgslRaw`/`NodeLike`, `collectPalette`/`Palette`,
  compute 커널 방출기(`emitMatchComputeKernel`, `emitInterpolateComputeKernel`,
  `planComputeKernels`, `buildPerShowMergedVariant` …)
- **Tiler** — `compileGeoJSONToTiles(Async)`, `compileSingleTile`, `decomposeFeatures`,
  Morton `tileKey`/`tileKeyParent`/`tileKeyChildren`, `clipPolygonToRect`, `simplify`,
  `interpolateGreatCircle`, ECEF/DSFUN 패커(`packECEFPolygonVertices`,
  `packDSFUNLineVertices` …), `geojsonvt`/`encodeMVT`, 타일 인덱스 타입(`XGVTIndex` …)
- **Input** — `decodeMvtTile`
- **Convert / Diagnostics** — `convertMapboxStyle`, `MAPBOX_COVERAGE`, `getStyleProfile`,
  IR-pass 리포트(`analyzeCSE`, `annotateDeps`, `Dep` …)
- **Binary / Schema / Tokens** — `serializeXGB`/`deserializeXGB`, blueprint용
  `LANGUAGE_SCHEMA`/`SOURCE_TYPES`/`ANCHORS`, `resolveColor`(Tailwind 토큰)

> 새 공개 심볼은 deep-path가 아니라 `index.ts`에서 export한다. 시그니처/타입 변경은
> `src/AGENTS.md`의 그룹 순서를 유지할 것.

## The .xgvt Format

`.xgvt`(X-GIS Vector Tile)은 COG에서 영감을 받은 단일 파일 벡터 타일 포맷으로, 희소 타일
피라미드와 HTTP Range 인덱스에 사전 테셀레이션된 GPU-ready 지오메트리를 담는다. 헤더(40B),
Morton 키 정렬 타일 인덱스, 프로퍼티 테이블, 타일 데이터의 레이아웃 명세는 루트
[`SPEC.md`](../SPEC.md)에 있다.

현재 모든 X-GIS 소스는 MVT/PBF를 거치므로(GeoJSON은 in-worker geojson-vt 포트로 인-메모리
타일링) **on-disk `.xgvt` 바이너리 컨테이너와 그 직렬화기/역직렬화기는 제거됐다**.
`src/tiler/tile-format.ts`에는 런타임 `TileCatalog`와 공유하는 인-메모리 타일 인덱스 *형태*
(`XGVTIndex`, `XGVTHeader`, `TileIndexEntry`, `TILE_FLAG_FULL_COVER`)만 남아 있다.

earcut은 의도적으로 **Mercator-투영 좌표계**에서 실행되어 CPU 삼각분할 에지가 GPU 렌더링과
일치한다(lon/lat-직선 에지가 Mercator에서 휘어 해안선을 넘는 fill 아티팩트 방지).

## Build / Test

`package.json` scripts:

```bash
bun run build    # tsc --build  (타입 체크 + 빌드)
bun run test     # vitest run
```

- Vitest는 **타입 체크를 하지 않는다.** export 타입이나 테스트 로컬을 건드린 변경은 커밋
  전 `bun run build`(`tsc --build`)로 검증한다.
- 테스트는 소스 옆 `*.test.ts`와 `src/__tests__/`(~200개 spec/coverage/regression)에 있다.
  lexer·parser·evaluator·clip·simplify·geodesic·mvt-decoder·colors·tile-key·dsfun
  precision의 `*-fuzz.test.ts`는 항상 green을 유지한다.

런타임 의존성: `@mapbox/vector-tile`, `pbf`(MVT decode), `@xgis/shader-dsl`(codegen IR),
`@xgis/shared`. dev/포트 레퍼런스: `@maplibre/maplibre-gl-style-spec`, `geojson-vt`, `vt-pbf`,
`earcut`.

## Related Docs

- 파이프라인 UML — [docs/architecture/diagrams/class-compiler-pipeline.md](../docs/architecture/diagrams/class-compiler-pipeline.md)
- ADR-0001 ECEF 타일 파이프라인(단일 MVP, 타원체 정점 pack) — [docs/adr/0001-ecef-tile-pipeline.md](../docs/adr/0001-ecef-tile-pipeline.md)
- ADR-0003 Shader DSL single-emit + PROJECTIONS 테이블 = source of truth — [docs/adr/0003-shader-dsl-single-emit.md](../docs/adr/0003-shader-dsl-single-emit.md)
- 모노레포 모듈 DAG — [docs/architecture/MODULES.md](../docs/architecture/MODULES.md)
