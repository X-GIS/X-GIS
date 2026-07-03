# @xgis/blueprint

X-GIS 맵을 **노드 그래프로 저작**하는 비주얼 에디터. Unreal Blueprint 스타일의 캔버스에서
소스/레이어/프리셋/심볼/함수 노드를 배선하면, 그 그래프가 `@xgis/compiler`가 소비하는
`.xgis` 소스 텍스트로 코드 생성된다. 즉 이 패키지는 렌더러가 아니라 **저작 도구**다 —
그래프를 그리고(editor), `.xgis`로 내보내고(codegen), 기존 스타일을 다시 그래프로
들여오는(import) 일을 한다.

루트 개요는 [`../README.md`](../README.md)를 참고. 이 패키지가 생성하는 `.xgis`를 컴파일하는
파이프라인(Lexer → Parser → IR → WGSL)은 `@xgis/compiler`가 담당한다.

## 역할 (monorepo 내 위치)

```
BlueprintEditor (그래프 저작)
      │  graphToXgis()
      ▼
  .xgis source  ──►  @xgis/compiler  ──►  IR / 셰이더 / 타일  ──►  @xgis/runtime
      ▲
      │  xgisToGraph() / styleToGraph()   (역방향 import)
  .xgis 또는 MapLibre/Mapbox style.json
```

- 출력은 컴파일러가 그대로 파싱하는 `.xgis` 텍스트다. 노드 카탈로그(`NODE_SPECS`)는
  `@xgis/compiler`의 `LANGUAGE_SCHEMA`에서 **모듈 로드 시점에 파생**되므로 언어가
  바뀌면 에디터가 자동으로 따라간다 (드리프트는 `contract.test.ts`가 잡는다).
- **런타임 의존성 없음.** 에디터는 순수 vanilla DOM + SVG로 동작하며 GPU나
  `@xgis/runtime`을 import하지 않는다. 따라서 그래프를 그 자리에서 렌더 미리보기하는
  기능은 이 패키지 안에 없다 — 호스트 앱이 생성된 `.xgis`를 컴파일러/런타임에 넘겨야 한다.

> 정직하게: 이 패키지는 단일 워크스페이스 의존성(`@xgis/compiler`)만 두고, `private: true`,
> `version 0.0.1` 상태다. 게시되지 않은 내부 저작 도구이며 `main`은 빌드 산출물이 아니라
> `./src/index.ts`(TS 소스)를 직접 가리킨다.

## 설치 / import

워크스페이스 내부 패키지다 (npm 미게시). 같은 monorepo에서 사용:

```ts
import { BlueprintEditor, graphToXgis, starterGraph } from '@xgis/blueprint'
import '@xgis/blueprint/blueprint.css' // 에디터 chrome 스타일 (필수)

const editor = new BlueprintEditor({
  viewport: document.getElementById('canvas')!,
  inspector: document.getElementById('inspector')!,
  onChange: () => {
    /* 그래프 변경 시 호출 */
  },
})
```

## 공개 표면 (`src/index.ts`)

`index.ts`는 네 모듈을 re-export 한다: `types`, `codegen`, `import`, `editor`.

| 심볼                                                                | 출처         | 설명                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BlueprintEditor`                                                   | `editor.ts`  | 에디터 클래스. 생성자는 `{ viewport, inspector, onChange }`. 팬/줌, 와이어 드래그, marquee 다중선택, 노드 CRUD, comment frame, reroute knot, snap-to-grid, align/distribute, copy-paste, undo/redo, inspector를 전부 vanilla DOM/SVG로 처리. |
| `graphToXgis(g: BPGraph): string`                                   | `codegen.ts` | 그래프를 언어 정의 순서(imports → sources → symbols → styles → fns → presets → background → layers)로 걸어 `.xgis` 소스를 emit. reroute knot은 와이어 해석 시 투명하게 통과.                                                                 |
| `xgisToGraph(src: string): BPGraph`                                 | `import.ts`  | codegen의 역방향. raw `.xgis` 텍스트를 brace/문자열/주석 인식 스캐너로 블록 분할해 그래프로 복원.                                                                                                                                            |
| `styleToGraph(style: unknown): BPGraph`                             | `import.ts`  | MapLibre/Mapbox `style.json`을 `convertMapboxStyle`로 `.xgis`화한 뒤 `xgisToGraph`로 변환.                                                                                                                                                   |
| `importText(text: string): BPGraph`                                 | `import.ts`  | 붙여넣기 박스용 휴리스틱 디스패치 — `{`로 시작하면 style JSON, 아니면 raw `.xgis`.                                                                                                                                                           |
| `BPNode` / `BPEdge` / `BPGraph` / `BPFrame`                         | `types.ts`   | 그래프 모델 타입. JSON round-trippable (undo/redo 스냅샷·localStorage 영속화에 의존).                                                                                                                                                        |
| `NODE_SPECS`                                                        | `types.ts`   | `LANGUAGE_SCHEMA`에서 파생된 노드 카탈로그.                                                                                                                                                                                                  |
| `PinType` / `PinSpec` / `FieldSpec` / `PIN_COLOR` / `pinCompatible` | `types.ts`   | 타입드 핀 모델과 Unreal 스타일 와이어 색.                                                                                                                                                                                                    |
| `uid(prefix)` / `defaultData(type)` / `starterGraph()`              | `types.ts`   | 노드 ID 생성, 노드 zero-value 필드 맵, `map + source + layer` 최소 시작 그래프.                                                                                                                                                              |

## 주요 내부 모듈

자세한 파일별 책임과 작업 규칙은 [`src/AGENTS.md`](src/AGENTS.md) 및 패키지 루트
[`AGENTS.md`](AGENTS.md) 참고. 요약:

| 파일                 | 한 줄 설명                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/types.ts`       | 그래프 모델 + `LANGUAGE_SCHEMA` 파생 `NODE_SPECS` + 핀/필드 스펙 + 헬퍼.                                  |
| `src/editor.ts`      | `BlueprintEditor` — 모든 포인터 상호작용을 담은 대형 단일 클래스. drag 상태는 discriminated union `Drag`. |
| `src/codegen.ts`     | `graphToXgis` — 그래프 → `.xgis`. 와이어 해석은 reroute 투명 `incoming()` 헬퍼 사용.                      |
| `src/import.ts`      | `.xgis` / style.json → `BPGraph`. brace/문자열/주석 인식 `splitBlocks` 스캐너.                            |
| `src/diagnostics.ts` | `computeNodeIssues` — 순수 per-node lint (빈 이름, 미연결 source, 중복 이름 등), DOM 없음.                |
| `src/history.ts`     | `History` — 100 entry 상한 undo/redo 스택 (불투명 string 스냅샷).                                         |
| `src/minimap.ts`     | `renderMinimap` — 노드 ≥12개일 때만 그리는 코너 오버뷰 캔버스.                                            |
| `src/palette.ts`     | `openSearchPalette` — 컨텍스트 검색/생성 오버레이 (순수 view).                                            |
| `src/geometry.ts`    | `bezier` — 와이어용 수평 탄젠트 cubic Bézier SVG path 문자열.                                             |
| `src/datapeek.ts`    | `peekData` — GeoJSON source URL을 fetch해 feature 수/속성 키를 inspector에 표시.                          |
| `src/blueprint.css`  | 에디터 chrome 스타일. JS와 함께 import 필요.                                                              |

`codegen.ts`와 `import.ts`는 **항상 동기화**되어야 한다 — 새 노드 타입은 codegen emitter와
import 블록 인식기를 둘 다 요구한다 (`src/AGENTS.md` 참고).

## 빌드 / 테스트

`package.json` 스크립트:

```bash
bun run build    # tsc --build
bun run test     # vitest run
```

테스트(`src/__tests__/`, 상세는 [`src/__tests__/AGENTS.md`](src/__tests__/AGENTS.md)):

- `contract.test.ts` — 1차 게이트. `NODE_SPECS` 필드 키와 핀 ID를 codegen 계약에 고정하고,
  `graphToXgis(starterGraph())` 결과가 컴파일러의 `Lexer` + `Parser`로 round-trip 파싱되는지 검증.
  `types.ts` / `codegen.ts` / `LANGUAGE_SCHEMA` 변경 후 반드시 통과해야 한다.
- `diagnostics.test.ts` — 순수 lint 함수 커버리지.
- `import-skip.test.ts` — 블록 스캐너의 malformed 입력 가드.
- `deserialize-unknown-node.test.ts` / `load-history-reset.test.ts` / `wire-undo-reconnect.test.ts` —
  에디터 시즘 가드 (untrusted JSON paste/undo, load 시 history reset, 와이어 재연결 undo 부기). 라이브
  DOM 없이 `BlueprintEditor`를 `Object.create`해 검증.

## 관련 문서

- [`../README.md`](../README.md) — X-GIS 루트 개요 (언어 + 렌더 엔진).
- [`AGENTS.md`](AGENTS.md) / [`src/AGENTS.md`](src/AGENTS.md) — 패키지·소스 디렉터리 상세 (생성된 그래프 모델, drag union, codegen/import 동기화 규칙).
- [`../docs/architecture/OVERVIEW.md`](../docs/architecture/OVERVIEW.md) — C4 시스템 개요.
- [`../docs/architecture/MODULES.md`](../docs/architecture/MODULES.md) — 패키지 의존 DAG.
- [`../docs/architecture/diagrams/class-compiler-pipeline.md`](../docs/architecture/diagrams/class-compiler-pipeline.md) — 이 에디터가 내보낸 `.xgis`를 받는 컴파일러 파이프라인.

- [`../compiler/README.md`](../compiler/README.md) — 이 에디터가 내보낸 `.xgis`를 받는 컴파일러 패키지.
