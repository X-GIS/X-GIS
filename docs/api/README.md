# X-GIS Public API Reference — `XGISMap`

`XGISMap` (`runtime/src/engine/map.ts`)는 `@xgis/runtime`의 최상위 진입점입니다. 컴파일된 `.xgis`/`.xgb`를 받아 카메라·인터랙션·소스 관리·WebGPU 프레임 루프를 한데 묶습니다. 이 문서는 **앱 개발자가 호출하도록 의도된 public 메서드만** 다룹니다 — 모든 시그니처는 `map.ts`에서 그대로 읽어 확인했고, private / `_`-prefixed 내부 진단 메서드와 프레임 루프 내부(`renderFrame`, `renderLoop`, `rebuildLayers` 등)는 제외했습니다.

> **WebGPU 전용.** `navigator.gpu`나 GPU 어댑터가 없으면 `initGPU`가 `WebGPUUnavailableError`를 던지고, `run()`/`load()`는 `onWebGPUUnavailable()` 훅을 호출한 뒤 **조용히 마운트하지 않습니다** (throw하지 않음). Canvas 2D 폴백은 없습니다. ADR: [`docs/adr/README.md`](../adr/README.md)의 WebGPU-only 노트.

관련 문서:
- 패키지 개요 + 배럴(`src/index.ts`) export 표 — [`runtime/README.md`](../../runtime/README.md)
- 렌더 서브시스템 클래스 다이어그램 — [`docs/architecture/diagrams/class-render-subsystem.md`](../architecture/diagrams/class-render-subsystem.md)
- 프레임 렌더 시퀀스 — [`docs/architecture/diagrams/sequence-frame-render.md`](../architecture/diagrams/sequence-frame-render.md)
- 투영 모드 상태도 — [`docs/architecture/diagrams/state-projection-modes.md`](../architecture/diagrams/state-projection-modes.md)
- ADR: [ECEF 타일 파이프라인](../adr/0001-ecef-tile-pipeline.md) · [synthetic earth-surface background](../adr/0005-synthetic-earth-surface-background.md) · [world-copy rendering](../adr/0006-world-copy-rendering.md)

---

## Quick start

```ts
import { XGISMap } from '@xgis/runtime'

const canvas = document.querySelector('canvas')!
const map = new XGISMap(canvas, {
  // 전부 선택사항 — new XGISMap(canvas) 만으로도 동작
  glyphs: { url: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf' },
  spriteUrl: 'https://demotiles.maplibre.org/styles/sprites/ofm',
})

// 1) .xgis 소스 문자열을 컴파일 + 로드 + 렌더
await map.run(xgisSource, baseUrl)

// 2) 또는 URL에서 가져와 .xgis vs .xgb 자동 판별
await map.load('/styles/bright.xgis')

// 카메라 제어 (Mapbox/MapLibre 호환 형태)
map.jumpTo({ center: [126.978, 37.566], zoom: 11 })

// 언마운트 시 — GPU/워커/리스너 누수 방지
map.destroy()
```

`new XGISMap(...)`는 카메라·컨트롤러·소스 매니저만 배선합니다. GPU 컨텍스트·렌더러·프레임 루프는 **첫 `run()`/`load()`에서 lazy 생성**되며, WebGPU가 없으면 그 시점에 처리됩니다.

HTML 호스트는 `<xgis-map>` 커스텀 엘리먼트(`XGISMapElement`, `registerXGISElement` — 배럴에서 export)로 `XGISMap`을 감쌀 수 있습니다.

---

## 1. Lifecycle & mount

| Member | Signature | 설명 |
|--------|-----------|------|
| constructor | `new XGISMap(canvas: HTMLCanvasElement, options?: XGISMapOptions)` | 카메라·컨트롤러·소스/인터랙션 매니저 배선. GPU는 생성하지 않음(첫 `run`에서). `options`는 전부 선택사항. |
| `run` | `run(source: string, baseUrl?: string): Promise<void>` ⏳ | `.xgis` 소스를 lex→parse→IR→commands로 컴파일하고, `import` 해소(fetch)·소스 병렬 로드·GPU init·프레임 루프 시작까지 수행. `baseUrl`은 상대 `import`/데이터 URL 해소 기준. |
| `load` | `load(url: string): Promise<void>` ⏳ | `url`을 fetch해 확장자로 분기: `.xgb`면 `runBinary`, 그 외엔 `run`. `baseUrl`은 URL의 디렉터리로 자동 도출. |
| `runBinary` | `runBinary(buffer: ArrayBuffer, baseUrl?: string): Promise<void>` ⏳ | 직렬화된 `.xgb`(`deserializeXGB`)를 로드. EPSG 재투영 없음(모든 소스 EPSG:4326 가정). |
| `resize` | `resize(): void` | 컨테이너 리사이즈 통지. 실제 버퍼 픽업은 매 프레임 canvas 크기를 읽어 자동 처리되므로 이 호출은 다음 프레임을 즉시 무효화(invalidate)만 함. |
| `destroy` | `destroy(): void` | **전체 teardown** — 컨트롤러/DOM 리스너 detach, 소스별 GPU 렌더러·텍스트/아이콘 스테이지·팔레트·`ctx.device` 파괴. 멱등; 이후 map은 inert. (주의: GeoJSON 컴파일 워커 풀은 프로세스 공유 싱글톤이라 종료하지 않음.) |
| `stop` | `stop(): void` | 컨트롤러 detach + 렌더 루프 정지. `destroy`와 달리 GPU 리소스는 보존. |
| `loaded` | `loaded(): boolean` | 초기 로드를 마치고 렌더 루프에 진입했으면 `true`(MapLibre `map.loaded()` 대응). |
| `onWebGPUUnavailable` | `onWebGPUUnavailable(cb: () => void): void` | WebGPU/어댑터 부재로 마운트 불가 시 1회 발화하는 호스트 훅. `run` 전에 설정 가능. |
| `onDeviceLost` | `onDeviceLost(cb: (info: GPUDeviceLostInfo) => void): void` | GPU 디바이스 손실(드라이버 리셋/탭 백그라운딩/OOM) 시 1회 발화. 명시적 `destroy`에는 발화하지 않음. init 전/후 모두 설정 가능. |
| `getCanvas` | `getCanvas(): HTMLCanvasElement` | 내부 캔버스 엘리먼트 반환(스크린샷·제스처 리스너 부착용). init 전엔 생성자 캔버스로 폴백. |
| `getContainer` | `getContainer(): HTMLElement \| null` | 캔버스의 부모 엘리먼트. 부모가 없으면 `null`. |
| `setLogSink` | `setLogSink(sink: LogSink \| null): void` | 엔진 로그를 콘솔 대신 커스텀 sink로 라우팅. `null`이면 콘솔 기본값 복원. |

`XGISMapOptions` (`map-types.ts`): `glyphs?: { url?: string; inline?: NonNullable<TextStageOptions['inlineGlyphs']> }`, `spriteUrl?: string`, `glyphProviders?: GlyphProvider[]`, `fonts?: XGISFontResource[]`, `enableComputePath?: boolean`(P4 opt-in, 기본 false), `graticule?: boolean`(기본 false).

> ⏳ = async(`Promise` 반환).

---

## 2. Camera

대부분 `CameraController`에 위임됩니다(`camera-controller.ts`에 검증/클램프 로직). 입력은 검증되며 non-finite 값은 `xlog.warn` 후 무시됩니다. lat은 Mercator-safe 한계로 클램프, pitch는 `[0, 85]`로 클램프됩니다.

| Member | Signature | 설명 |
|--------|-----------|------|
| `jumpTo` | `jumpTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void` | 즉시 카메라 갱신(벌크). center는 maxBounds·Mercator-lat 클램프, bearing은 0–360 정규화, pitch는 0–85 클램프. |
| `easeTo` | `easeTo(opts: { center?; zoom?; bearing?; pitch?; duration?; easing? }): void` | ⚠️ **현재 `jumpTo` 별칭(즉시).** 트랜지션 인프라 미구현 — `duration`/`easing`은 무시되고 보간 없이 즉시 점프. |
| `flyTo` | `flyTo(opts: { center?; zoom?; bearing?; pitch?; duration?; speed?; curve? }): void` | ⚠️ **현재 `jumpTo` 별칭(즉시).** `duration`/`speed`/`curve` 무시. |
| `fitBounds` | `fitBounds(bounds: [[number, number], [number, number]], opts?: { padding?: number; bearing?: number; pitch?: number }): void` | lon/lat bbox에 맞게 카메라 fit. 내부적으로 `jumpTo` 호출. |
| `panBy` | `panBy(offset: [number, number]): void` | CSS 픽셀 오프셋만큼 팬. 현재 bearing 반영. |
| `setCenter` | `setCenter(lon: number, lat: number): void` | 중심 좌표 설정(maxBounds·Mercator-lat 클램프). |
| `setZoom` | `setZoom(zoom: number): void` | 줌 설정(min/max 클램프). |
| `setBearing` | `setBearing(bearing: number): void` | 베어링(도) 설정. |
| `setPitch` | `setPitch(pitch: number): void` | 피치(도) 설정. |
| `setMinZoom` / `setMaxZoom` | `setMinZoom(z: number): void` / `setMaxZoom(z: number): void` | 줌 한계 설정(0–22 범위). |
| `getMinZoom` / `getMaxZoom` | `(): number` | 현재 줌 한계. |
| `zoomIn` / `zoomOut` | `(): void` | 한 단계 줌 인/아웃. |
| `setMaxBounds` | `setMaxBounds(bounds: [[number, number], [number, number]] \| null): void` | 카메라 중심을 가둘 bbox. `null`로 해제. |
| `getMaxBounds` | `(): [[number, number], [number, number]] \| null` | 현재 maxBounds. |
| `getBounds` | `getBounds(): [[number, number], [number, number]]` | 현재 뷰포트의 lon/lat bbox. |
| `getCenter` | `getCenter(): [number, number]` | 현재 중심 `[lon, lat]`(역 Mercator). |
| `getZoom` / `getBearing` / `getPitch` | `(): number` | 현재 줌 / 베어링 / 피치. |
| `getCameraState` | `getCameraState(): { center: [number, number]; zoom: number; bearing: number; pitch: number }` | 카메라 상태 1회 스냅샷(`jumpTo`로 라운드트립 가능). |
| `getCamera` | `getCamera(): Camera` | 내부 `Camera` 인스턴스(URL 해시 동기화 등 저수준 용도). |
| `markCameraPositioned` | `markCameraPositioned(): void` | 카메라를 "사용자 위치 지정됨"으로 표시 — 워커 컴파일 완료 후 자동 bounds-fit이 뷰를 덮어쓰지 않게 함(딥링크 해시 적용 후 호출). |

> **public project/unproject는 없습니다.** CSS↔경위도 변환(`clientToLngLat`)은 private이며 Mercator-only입니다. `pickAt`만이 공개된 좌표→피처 질의 경로입니다(§6).

---

## 3. Sources & layers

런타임 스타일 변형은 **컴파일 타임 IR 기반**입니다 — Mapbox GL JS의 `setStyle`/`addLayer`/`addSource`/`addImage`는 **warn-once 스텁**(미구현). 데이터 주입과 레이어 스타일 변형은 아래 X-GIS 고유 API로 합니다.

### 외부 데이터 주입

| Member | Signature | 설명 |
|--------|-----------|------|
| `setSourceData` | `setSourceData(sourceId: string, data: GeoJSONFeatureCollection): void` | GeoJSON 소스 전체 교체 + 해당 소스만 재타일/재업로드. `.xgis`에 선언되지 않은 `sourceId`면 throw. |
| `setSourcePoints` | `setSourcePoints(sourceId: string, data: PointPatch): void` | 포인트 소스 전용 typed-array fast path. 병렬 `Float32Array`(lon/lat) + 선택적 `Uint32Array` id. 길이 불일치 시 throw. |
| `updateFeature` | `updateFeature(sourceId: string, featureId: number, patch: { geometry?; properties? }): void` | 피처 단위 변형. 같은 rAF 내 패치를 소스별 단일 재타일로 코얼레싱. 미지의 소스/피처는 warn-once 후 드롭. |

### 레이어 스타일 (DOM 영감 API)

`getLayer`가 반환하는 `XGISLayer` 래퍼는 `.style`(CSS-like 세터)과 `.addEventListener`를 노출합니다. 래퍼는 `setProjection()`/씬 재빌드 시 무효화되므로 그때 재해소해야 합니다.

| Member | Signature | 설명 |
|--------|-----------|------|
| `getLayer` | `getLayer(name: string): XGISLayer \| null` | DSL 레이어명으로 래퍼 조회(`document.getElementById` 유사). 한 씬 내 동일 인스턴스 반환. |
| `getLayers` | `getLayers(): readonly XGISLayer[]` | 등록 순서의 모든 래퍼 정적 스냅샷. |
| `setPaintProperty` | `setPaintProperty(layerId: string, property: string, value: unknown): boolean` | Mapbox 스타일 페인트 변형. 인식된 (layer, property)면 `true`. 지원: `fill-color`/`line-color`/`fill-opacity`/`line-opacity`/`opacity`/`line-width`/`visibility`. 상수 스칼라/hex만 — 표현식 값은 범위 외. |
| `getPaintProperty` | `getPaintProperty(layerId: string, property: string): unknown` | `setPaintProperty` 대응 조회. 미지의 layer/property면 `undefined`. |

`XGISLayer.style` 세터(`XGISLayerStyle`): `opacity`(0–1 클램프), `fill`/`stroke`(hex; 잘못된 hex는 no-op), `strokeWidth`(≥0), `visible`(boolean), `extrude`/`extrudeBase`(미터, `null`로 평탄화), `pointerEvents`(`'auto'`|`'none'`). `XGISLayer.resetStyle(key?)`로 컴파일 기본값 복원.

### 저수준 도트표기 프로퍼티 API

`.style`을 권장하지만, 임의 레이어 프로퍼티용 저수준 경로도 있습니다(`"layerName.property"` 형식).

| Member | Signature | 설명 |
|--------|-----------|------|
| `set` | `set(path: string, value: unknown): void` | `"world.fill"` 같은 경로로 프로퍼티 설정(다음 프레임 적용). |
| `get` | `get(path: string): unknown` | 현재 값(오버라이드 포함). |
| `reset` | `reset(path: string): void` | 컴파일 기본값으로 복원. |
| `listProperties` | `listProperties(): Record<string, string[]>` | 설정 가능한 모든 프로퍼티 목록. |

### Mapbox-API 미지원 스텁 (warn-once, no-op)

`setStyle(style)` · `addLayer(layer, beforeId?)` · `removeLayer(id)` · `addSource(id, source)` · `removeSource(id)` · `addImage(id, image)` — 전부 1회 `xlog.warn` 후 no-op. MapLibre 코드 포팅 시 조용히 무시되지 않고 올바른 대체 API를 가리키는 경고를 냅니다.

---

## 4. Projection & rendering

| Member | Signature | 설명 |
|--------|-----------|------|
| `setProjection` | `setProjection(name: string): void` | 런타임 투영 변경(GPU uniform만, 재테셀레이션 없음). 유효값: `mercator`, `equirectangular`, `natural_earth`, `orthographic`, `azimuthal_equidistant`, `stereographic`, `oblique_mercator`, `globe`. 별칭(`equirect`, `natural-earth`, …) 정규화. 미지의 값은 warn 후 현재 투영 유지. |
| `getProjectionName` | `getProjectionName(): string` | 현재 투영명. |
| `setBackgroundFill` | `setBackgroundFill(rgba: [number, number, number, number] \| null): void` | 스타일 배경 fill을 런타임에 갱신(synthetic earth-surface 폴리곤 ECEF 파이프라인). `[r,g,b,a]` 0..1 floats. `null`이면 synthetic 소스 teardown(canvas clearValue가 지배). 멱등. |
| `setGraticuleEnabled` | `setGraticuleEnabled(on: boolean): void` | lat/lon 그리드 오버레이 토글. 기본 off. |
| `isGraticuleEnabled` | `isGraticuleEnabled(): boolean` | 현재 그리드 on/off. |
| `setQuality` | `setQuality(patch: Partial<QualityConfig>): void` | 품질 노브 런타임 변경. `maxDpr`/`interactionDpr`는 다음 resize에 적용; `msaa`/`picking`은 렌더러 파이프라인 재빌드 + RT 재할당 유발(picking 활성화 시 `msaa=1` 강제). |
| `getQuality` | `getQuality(): QualityConfig` | 현재 품질 설정의 얕은 복사본. |
| `invalidate` | `invalidate(): void` | 명시적 렌더 트리거(카메라 외 상태 변경 시). `destroy` 후 no-op. |
| `markInteracting` | `markInteracting(): void` | 활성 제스처 플래그 — `QUALITY.interactionDpr` opt-in 시 제스처 중 DPR 다운. 기본 설정에선 inert. |
| `setPolarCapsEnabled` | `setPolarCapsEnabled(on: boolean): void` | ⚠️ **`@deprecated` no-op + warn-once.** 폴라캡 합성은 더 이상 렌더러 주도가 아님 — 배럴 export `injectPolarCaps`/`synthesizePolarCaps`로 데이터를 전처리하세요. |
| `isPolarCapsEnabled` | `isPolarCapsEnabled(): boolean` | ⚠️ **`@deprecated`** — Phase 1a 이후 항상 `false`. |

### 텍스트/스프라이트 리소스

| Member | Signature | 설명 |
|--------|-----------|------|
| `setGlyphsUrl` | `setGlyphsUrl(url: string \| null): void` | glyph PBF URL 템플릿 설정. 첫 라벨 프레임 전에 호출. |
| `setInlineGlyphs` | `setInlineGlyphs(seed: …InlineGlyphs \| null): void` | 사전 로드된 PBF range 바이트 시드(에어갭 배포용). |
| `addGlyphProvider` | `addGlyphProvider(provider: GlyphProvider): void` | 커스텀 glyph provider(IndexedDB/S3/IPFS 등)를 체인에 추가. 순서대로 우선순위. |
| `setSpriteUrl` | `setSpriteUrl(url: string \| null): void` | 스프라이트 아틀라스 URL prefix(`${url}.json`+`${url}.png`). 첫 라벨 프레임 전에 설정. |
| `addFonts` | `addFonts(fonts: XGISFontResource[]): Promise<void>` ⏳ | CSS FontFace로 폰트 등록(생성자 `fonts` 옵션과 동형). 반환 promise를 await. |
| `fontsReady` | `readonly fontsReady: Promise<void>` (속성) | 생성자 `fonts` 전부 로드 완료 시 resolve. 첫 라벨 프레임 전에 await 권장. |

### 텍스트 오버레이

| Member | Signature | 설명 |
|--------|-----------|------|
| `addOverlay` | `addOverlay(opts: TextOverlayOptions): TextOverlayHandle` | 지리 좌표에 앵커된 텍스트 오버레이 추가(매 프레임 재투영). 반환 핸들의 `.remove()`로 제거. |
| `clearOverlays` | `clearOverlays(): void` | 모든 텍스트 오버레이 제거. |

`TextOverlayOptions`: `text`(필수), `anchor: [lon, lat]`(필수), `size?`(기본 14), `color?`(RGBA 0..1, 기본 흰색), `halo?`, `font?`, `transform?: 'none'|'uppercase'|'lowercase'`.

---

## 5. Events

`XGISMap`은 DOM 위임(delegation)식 맵 레벨 이벤트와, `XGISLayer.addEventListener`를 통한 레이어 레벨 이벤트를 제공합니다. 레이어 레벨 리스너가 먼저 실행되고, 그중 `preventDefault`를 호출하지 않으면 맵 레벨이 발화합니다.

| Member | Signature | 설명 |
|--------|-----------|------|
| `addEventListener` | `addEventListener(type: XGISFeatureEventType, listener: XGISFeatureListener, options?: { signal?: AbortSignal; once?: boolean }): void` | 맵 레벨 위임 리스너. 어떤 레이어든 hit되면 발화(`event.target`=hit된 레이어). |
| `removeEventListener` | `removeEventListener(type: XGISFeatureEventType, listener: XGISFeatureListener): void` | 맵 레벨 리스너 제거. |
| `on` | `on(type, listener): void` | `addEventListener` 별칭(Mapbox/MapLibre 형태). |
| `off` | `off(type, listener): void` | `removeEventListener` 별칭. |
| `once` | `once(type, listener): void` | `{ once: true }`로 등록 — 첫 발화 후 자동 제거. |

- **`XGISFeatureEventType`**: `'click' | 'mouseenter' | 'mouseleave' | 'mousemove' | 'pointerdown' | 'pointerup' | 'wheel'`
- **`XGISFeatureListener`**: `(event: XGISFeatureEvent) => void`
- **`XGISFeatureEvent`** 페이로드: `type`, `target`/`currentTarget`(`XGISLayer`), `feature`(`XGISFeature`: `id`/`source`/`layer`/`properties`), `coordinate: [lon, lat]`, `pixel: [x, y]`, `clientX`/`clientY`, `originalEvent`, `timeStamp`. `preventDefault()`/`stopPropagation()`로 전파 차단.

> 카메라 move/zoom 등 **viewport 이벤트는 아직 없습니다** — 이벤트 표면은 위 피처 픽 이벤트로 한정됩니다.

---

## 6. Query (picking)

| Member | Signature | 설명 |
|--------|-----------|------|
| `pickAt` | `pickAt(clientX: number, clientY: number): Promise<{ featureId: number; layerId: number; instanceId: number } \| null>` ⏳ | CSS 픽셀 좌표 아래의 feature/instance ID 읽기. **`?picking=1`(또는 `setQuality({ picking: true })`) 필요** — 아니면 즉시 `null`. GPU 텍스처 readback이라 ~1프레임 지연(async). 픽셀이 (0,0)이면 `null`(피처 없음). `instanceId`는 WORLD_COPIES 인스턴싱 전까지 0. |

> `queryRenderedFeatures` 같은 영역 질의는 없습니다. 픽 경로는 1×1 GPU pick 텍스처 readback 기반 단일 픽셀 질의입니다.

---

## 7. Diagnostics & inspection (선택)

엄밀히는 public이지만 주로 DevTools 콘솔(`window.__xgisMap`)·Playwright 스펙·CPU 테스트용입니다. 앱 통합에는 보통 불필요합니다.

- `inspectPipeline(): PipelineInspection` — 카메라/소스별 캐시·예산/draw 스탯/최근 FLICKER 히스토리 스냅샷.
- `get stats(): RenderStats` (속성) — fps/draws/tris/tiles 메트릭.
- `showInspector(show?: boolean): void` — 스탯 패널 DOM 오버레이 토글.
- `getCameraDebugSnapshot(canvasWidth, canvasHeight, dpr?): {...}` — 해석된 4×4 RTC 행렬 + near/far/altitude.
- `getTileLoadDiagnostic(): Record<string, {...}>` — 소스별 needed/missed/cache/upload 진단.
- `captureSnapshot(): Promise<MapSnapshot>` ⏳ / `replaySnapshot(snap, opts?): Promise<ReplayResult>` ⏳ — 결정론적 씬 스냅샷/리플레이.
- `captureNextFrameTrace(): Promise<FrameTrace>` ⏳ — 다음 프레임 렌더 트레이스 캡처.
- 라벨/아이콘 덤프·카운트 류: `getMissingIconNames`, `getDispatchedIconNames`, `getDispatchedLabelTexts`, `getLastLabelCounts`, `getAtlasGeneration`, `getDumpedLabels`/`setLabelDumpFilter`, `getDumpedIcons`/`setIconDumpEnabled`, `getHaloDebug`, `getLastDrawIconCount`, `getLastDrawSample`, `getLabelDispatchStats`, `getLayoutCacheStats`, `setLabelDebugHook`, `setTraceRecorder` 등 — 전부 진단용이며 안정 API로 의존하지 마세요.

---

## 안정성 / 정직한 caveats

- **`setStyle` / `addLayer` / `addSource` / `removeLayer` / `removeSource` / `addImage`** — Mapbox-API 패리티 **warn-once 스텁이며 no-op**. X-GIS는 런타임 스타일 변형이 아니라 컴파일 타임 IR을 씁니다. 스타일을 바꾸려면 `.xgis`를 재컴파일해 다시 로드하세요(`addImage`는 sprite atlas 로드맵 미구현 항목).
- **`easeTo` / `flyTo`** — 트랜지션 인프라 미구현으로 현재 **`jumpTo` 별칭(즉시 점프)**. `duration`/`easing`/`speed`/`curve` 인자는 받지만 무시됩니다. 최종 카메라 상태는 동일, 중간 보간만 없음.
- **`setPolarCapsEnabled` / `isPolarCapsEnabled`** — `@deprecated`. 전자는 no-op + warn-once, 후자는 항상 `false`. 폴라캡은 배럴 export `injectPolarCaps`/`synthesizePolarCaps`로 데이터를 전처리하는 방식으로 이동했습니다.
- **`pickAt`** — `picking` 품질이 켜진 경우에만 동작(아니면 항상 `null`). `instanceId`는 인스턴싱 도입 전까지 항상 0이고, 좌표→경위도 역변환(내부 `clientToLngLat`)은 Mercator-only입니다.
- **WebGPU 부재 시 `run`/`load`는 throw하지 않고 조용히 마운트 실패**합니다 — 반드시 `onWebGPUUnavailable` 훅으로 폴백 UI를 띄우세요. 비-Mercator/globe 투영의 일부 렌더 정확도 항목은 활발히 진행 중입니다(프로젝트 메모리의 OFM-Bright 렌더 스윕 참조).
