# X-GIS 아키텍처 최종 결산 (Architecture Reckoning)

*최종 결산 보고서 — 2026-06-09. 리드 아키텍트 작성, 소유자(owner) 의사결정용. 모든 주요 주장은 1차 코드 증거(A1–A6, file:line 직접 확인) 또는 외부 권위(B1 Blender, B2 Unreal, B3 MapLibre, B4 deck.gl/three.js, B5 엔지니어링 원칙)에 근거한다. 두 건의 레드팀(기술 적합성 / 동기·정체 렌즈)이 제기한 모든 blocking·major 도전을 §6.2에서 명시적으로 응답한다. 위로하지 않는다. 정직한 답이 "구조가 곤경에 처했다"이면 증거와 함께 그대로 말한다.*

근거 디렉터리: `docs/research/arch-reckoning-2026-06-08/` (A1–A6, B1–B5, S1–S6, RED-TEAM-technical, RED-TEAM-motivation).

---

## 0. 한 페이지 냉혹 요약 (The Verdict)

- **현 구조는 5년 / 3D-tiles / 4D 목표를 그대로는 버티지 못한다 — 그러나 실패의 원인은 "잘못된 목적지"가 아니라 "잘못된 이주(migration) 방법과 미실행"이다. 종합 점수 2/5 (냉정하게 읽으면 1.5/5).** 진단 자체는 정확하고 1차 증거로 뒷받침된다(A1/A2/A5 verified). 진짜 자산은 단 하나 — 비순환 *패키지* DAG(compiler가 runtime을 import하는 횟수 0; `@xgis/shared`는 진짜 leaf — A1 §5). 그러나 그 위의 *모듈* 구조는 정반대다: 5,440 LOC VTR 안의 단일 2,054줄 `render()` 메서드(A1 §2.1), 126개 메서드·8책임의 3,431 LOC `map.ts` 갓오브젝트(A2 §1)가 *이를 줄이려던 로드맵 기간에 오히려 +604줄(+21%) 늘었고*(A5 §2.2), `map ↔ render-loop`는 실제 양방향 import 사이클이다(A1 §3.1, 본인이 `render-loop.ts:36`의 value import + `:597/:610/:611`의 static-constant 사용으로 직접 재확인).

- **가장 큰 단일 리스크는 "정체(stall)의 자기영속화"다 — 기술 부채가 아니라 *작업 패턴*이다.** 이 브랜치의 최근 12개 커밋은 100% `docs(research)`이고, 브랜치 전체의 비-문서 소스 델타는 단 383줄이다(RED-TEAM-motivation B1, git log 검증). S1–S6 종합 문서 자체가 "S19를 커밋하기 전엔 새 `.md` 금지"(A5 §5)를 권고하면서 동시에 6개의 `.md`를 추가했다 — 즉 **이 결산 묶음 자체가 그것이 비판하는 audit-instead-of-execute 패턴의 13–18번째 사례다.** 이것을 인정하지 않으면 어떤 권고도 같은 운명을 맞는다.

- **두 번째로 큰 리스크는 "전방(forward) 축이 다뤄진 게 아니라 *미정의(unscoped)*"라는 점이다.** 5개 종합 문서가 "4D는 additive하게 떨어져 나온다", "3D-tiles는 S20과 같은 상처"라고 단언하지만 *어느 것도 증거가 없다*(RED-TEAM-technical B-1). A6 ε의 1차 증거는 정반대를 말한다: feature에 대한 시간 축이 *전혀 없다*(`TimeStop<T>`는 paint 보간 stop일 뿐, `valid_time/epoch`는 데이터 경로에 grep-0). "4D는 additive"는 소유자가 가장 싫어하는 trivialize-and-patch 그 자체다. 헤드라인에서 4D를 빼거나 실제로 spike로 scope하라 — 둘 중 하나.

- **세 번째 리스크 — 키스톤(GPU-CI golden-master)이 자신이 보호해야 할 면을 *증명된 채로* 못 본다.** 모든 종합이 "GPU-CI를 세우고 matrix를 golden gate로 승격"을 1순위로 두면서 동시에 A5 §4.5를 인용한다: flat fill은 56.75% 렌더되지만 *같은 지오메트리를 extrude하면 0.00%*다. 그런데 matrix의 oracle 종류는 `ink_family`/`disc_fraction`/perceptual-diff — 전부 2D coverage 검사뿐, depth-ordering·wall·silhouette·height oracle은 repo 어디에도 없다(RED-TEAM-technical B-2). 즉 Phase 0은 "하나"가 아니라 "둘"이다: (a) 조달 미확인 GPU 러너, (b) *존재하지 않는* 3D/extrusion oracle 신규 설계. 이것을 인정하지 않으면 "net 먼저"는 무한 yak-shave가 된다.

- **그러나 방향(method) 자체는 옳다 — "위험한 편집 전에 안전망부터, 갓파일은 in-place로 절대 편집하지 않고 Strangler-Fig/Branch-by-Abstraction으로"** (B5 §c, "이 문서 전체에서 가장 가치 있는 transfer"). 그리고 가장 가까운 peer는 Blender가 아니라 MapLibre다 — *같은 언어, 같은 런타임, 같은 문제* — 이는 100k+ LOC를 10년간 유지보수 가능하게 유지하며 X-GIS의 모든 축에서 정반대를 한다(B3 §10). Blender-DNA 명명은 category error다(B1 §5).

- **FIRST MOVE는 audit를 멈추는 것 — 구체적으로: 새 `.md` 금지를 *이 문서부터* 발효하고, 다음 커밋을 S19(중복된 `quantizeAxis`/`tileEcefCenterFromMerc` 3복사본을 `@xgis/shared`로 삭제-통합)로 한다.** 기계적이고 컴파일타임에 전부 잡히며(blast-radius 최소), #1로 꼽힌 CPU↔GPU drift 버그 클래스를 닫고, 무엇보다 "우리는 실행한다"는 신뢰를 은행에 적립한다. 동시에 — 또는 그 직전에 — 두 개의 가장 싼 CRITICAL을 앞으로 당긴다: 패키징(α, npm install 자체가 불가능 — A6 §α)과 `map.on('error')`+device-loss 복구(E1/E2). 이 셋은 다개월짜리 갓파일 분해보다 목표에 더 직접적이고 렌더 리스크가 0이다.

- **소유자의 핵심 우려(유지보수 비용 + 버그 위치추적성)에 대한 직답: 현재 비용 곡선은 잘못된 모양이다.** 지출이 *부패하는* 연구·비활성 substrate를 생산하는 동안(A5 §3.3, 강제장치 부재로 결과가 누수됨 — A1 §6), 비싼 리스크(S20)는 영구 연기된다. 안전망을 먼저 사면 곡선이 뒤집힌다: 리팩터가 matrix를 green으로 유지하면 ship, 아니면 한 번의 revert — 이것이 "fix가 안 붙는다"의 문자 그대로의 해독제다(B5 §c).

---

## 1. 축별 진단 (Cold, Specific, Grounded)

각 축은 1차 file:line과 외부 권위로 접지한다. 위로하는 표현은 없다.

### 1.1 구조 (Structure) — 2/5, 부패 중

**진단: 자산은 *패키지* 레벨에만 있고, *모듈* 레벨은 정반대로 가고 있으며, 부패를 막는 강제장치가 0이다.**

유일한 진짜 구조 자산은 비순환 패키지 DAG다 — compiler→runtime import 0회, `@xgis/shared`는 진짜 leaf(A1 §5). 그 위는 무너지고 있다:

- VTR `vector-tile-renderer.ts` 5,440 LOC, 그 안의 **단일 `render()` 2,054줄**(A1 §2.1 item 7) — "코드만 봐서는 안 보이는 버그"의 구체적 정체.
- `map.ts` 3,431 LOC, 126 메서드 / 8 책임(A2 §1); 줄이려던 로드맵 기간에 2827→3431로 **+604줄(+21%) 증가, 무차단**(A5 §2.2).
- `map ↔ render-loop` **실제 양방향 사이클**: `render-loop.ts:36`의 `import { XGISMap } from './map'`는 type-only가 아니라 runtime value import이며 `:597/:610/:611`에서 `XGISMap.FLICKER_GRACE_FRAMES`/`FLICKER_LOG_CAP` static 상수를 읽는다(본인 직접 재확인). render pass는 `host.<field>`를 **89회** reach(A2 §4); 43개 reach-through 중 ~20개가 private `_` 내부(A1 §3.1). 리디자인 헤더 스스로 "RELOCATION, not a decoupling"이라 인정한다(A1 §3.1).
- 권위 역전(#1 부채)이 ~40%만 닫혔다: `camera.ts:982,1064`가 원통형 계열을 `=== 1 || === 2 || === 6`으로 *한 파일에서 두 번* open-code; `camera.ts:917`의 매직 `=== 3`; `vector-tile-renderer.ts:2715`의 `1..6` 범위(A1 §3.2). `isCylindrical/isFlat/isOrtho` 멤버십이 export되지 않아 투영 하나 추가에 37-file cone 안의 ~6–10 file 실제 로직을 건드린다(A1 §4a).

**근본 원인(증상 아님):** R1 — 강제장치 부재(LOC budget gate 없음, `projType ===` lint 없음, module-cycle gate 없음 — A1 §6). 이게 master root다: ratchet이 없으면 *모든 분해가 평균으로 되돌아간다*. Unreal 자신이 이 실패를 증언한다 — "경계는 *강제*해야만 유지된다… 강제 없이 패턴만 추가한 작은 라이브러리는 양쪽의 최악을 얻는다"(B2 §6).

**MapLibre가 같은 언어·런타임에서 정반대로 증명하는 것**: 갓파일 대신 단일 소유자 서브시스템(B3 §10.2), call-graph 대신 contract seam(B3 §10.1), 병렬 권위 대신 단일 선언적 권위(B3 §1). X-GIS는 지도가 없어 실패하는 게 아니다 — **계획이 편한 활동이고 갓파일 분해(S20)가 불편한 활동이며, 부패를 막을 구조적 강제가 없기 때문**에 실패한다.

### 1.2 데이터플로우 + 이벤트 + 무효화 (Dataflow / Events / Invalidation) — 2/5, "controls malfunction"의 진원지

**진단: 상태 모델이 단일 갓오브젝트 중심의 *가변 공유 참조의 별(star)*이고, 이를 안전하게 만들 무효화 시스템은 *지어졌으나 죽어 있다*.**

- `state/dirty.ts`는 깔끔한 8-domain bitset이고 producer 쪽은 완전히 배선됐다(~15 dispatch 사이트). 그런데 **production consumer는 단 하나** — `map.ts:454 consumeLabelDirty()`의 LABEL domain 1개뿐(본인 grep 직접 확인: `.consume(`의 production 히트는 `map.ts:454` 하나, 나머지는 전부 `dirty.test.ts`). 7/8 domain이 write-only(A2 §2). 프레임 게이트는 여전히 `_needsRender` boolean + 손으로 짠 diff를 읽는다.
- gesture 레인은 `camera.pan/rotate/zoomAt/pitch=`를 *직접* 호출 — `_ops`도 `_dirty`도 거치지 않는다(A2 §4). render loop *또한* 매 프레임 camera를 쓴다. 따라서 op-log/bitset은 변경의 완전한 기록이 될 수 없다.
- 같은 camera scalar 5개가 **4–5개의 독립 shadow cache**(`_lastSig*`, `_evtSig*`, `camera._cache*`+`_ecefCache*`, `_prevLabelDispatchSig`)에 미러되고 **공유 generation counter가 없어** 조용히 desync 가능(A2 §1).
- camera 동사는 façade다: `easeTo`/`flyTo`는 `duration/curve/easing`을 버리고 `jumpTo`로 alias — 애니메이션 이동이 `movestart→move→moveend`를 한 tick에 발사한다(A2 §3). **이것이 가시적 "basic controls malfunction"이다.** 입력 레이어는 projection-blind(disc/globe에서 `clientToLngLat`가 `null`), pinch-rotate에 hysteresis 없음(A2 §3).

**근본 원인:** 단일 소유자 부재(Root 1) + camera 병렬 write 경로 2개(Root 2) + 무효화 비활성(Root 3) + camera 동사/입력 façade(Root 4). 모든 가시 버그가 이 넷 중 하나로 추적된다(A2 §2 데미지 분석). MapLibre의 `_styleDirty/_sourcesDirty/_placementDirty` + 단일 `_update()` funnel + idle 수렴(B3 §5)이 정확히 이 클래스를 제거하는 검증된 패턴이다.

### 1.3 메모리 + 네트워크 (Memory / Network) — 3/5 상승 중, 그러나 thrash 축 미답

**진단: 척추(tile scheduler + GPUArena + `map.destroy()`)는 이미 레퍼런스가 처방한 그대로다 — 소유자의 "네트워크 홍수" 공포는 tile에 대해선 이미 해결됐다. 그러나 소유자가 *지목하지 않은* 경로들이 장기 세션에서 가장 세게 문다.**

- tile fetch는 교과서적 bounded-concurrency + priority-queue + abort-on-intent + byte-aware eviction(A3 §1.1, §2.1, §2.3) — B5 §e의 5불변과 정확히 일치. GPUArena가 이 축 최강 모듈.
- 그러나 (a) **glyph-PBF/sprite fetch는 concurrency cap·cancellation 0**(A3 §1.2) — 다국어 뷰에서 실제 uncapped burst; (b) **glyph atlas GPU texture가 탭 수명 내내 monotonic leak**(A3 §2.2, `pageCountInternal`는 increment-only) — three.js "remove ≠ free" 안티패턴(B4 §2.3); (c) **worker pool은 crash 후 respawn 안 함**(A3 §3).
- 근본 원인: 라이프사이클 소유가 서브시스템별로 비일관(R1) + producer→consumer 계약이 단방향(R2). 각 서브시스템은 작성자가 깜빡한 차원에서 정확히 누수한다.

**레드팀이 정당하게 깬 지점(B-3, 본인 grep 검증):** GPU-tile-cache thrash는 "out of scope"가 아니라 *live*다. `vector-tile-renderer-helpers.ts:16` `MAX_GPU_TILES_DESKTOP=256`인데 `globe.ts:422` `MAX_TILES=300` — **가시 집합이 GPU cache cap을 이미 초과**하며 FLICKER 로그가 `gpuCache=315/375`를 보인다(RED-TEAM-technical B-3). 이것은 leak이 아니라 *재업로드 churn*(CPU↔GPU 대역폭·발열)이고, "massive data"와 "3D-tiles"(더 크고 계층적 — B5 §e)는 working set을 *키우므로* 이미 넘치는 256-tile cap이 목표 하에서 가장 먼저 깨진다. S3는 이를 waving off했다 — 본 결산은 이를 sized finding으로 승격한다(§4 참조).

### 1.4 셰이더 + 렌더 + 테스트 안전망 (Shader / Render / Test Net) — 3/5(설계) but 게이트 비자동

**진단: 행위를 관측하는 oracle이 자동 lane에 *없다*. 이것이 "fix가 안 붙는다"와 "버그가 컴파일·유닛-통과하고도 잘못 렌더된다"의 단일 공통 원인이다.**

- 262개 runtime 유닛 테스트 중 **260개가 CPU 수학, 정확히 1개가 GPU device, 정확히 1개가 픽셀, 0개가 `.render()` 호출**(A4 §3a). CI는 4개 spec(`_shader-math-parity`/`_wgsl-compile-gate`/`_vs-clip-parity`/`_dequant-parity`)만 돌리고 **어느 것도 픽셀을 칠하지 않는다**(A4 §3b). 이건 게으름이 아니라 강제다 — GitHub runner엔 GPU가 없고 SwiftShader는 X-GIS를 raster하지 못한다(ADR-0004).
- 행위 관측 가능한 real-GPU matrix(45 cell)는 **로컬 전용·수동**(A4 §3b ④) — 회귀 목적으로는 "게이트가 아니라 디버깅 도구"다. 게다가 26/45 cell이 `expected_red`(known-broken)이고 flip-alert가 없다(A4 §3c).
- 이것이 S20을 영구 연기시킨 메커니즘이다: 갓파일 분해의 행위 보존을 *증명할 수 없으므로* 너무 위험하다(A5 §3.2). "컴파일+유닛-green ≠ 올바른 렌더"는 그래픽스 테스트의 *구조적* 속성이지 규율 실패가 아니다(B5 §c) — 더 많은 유닛 테스트로는 못 고친다.

**안전망 명제는 VALIDATED다(S4):** "리팩터가 위험하게 느껴지는 이유"(RC-2: 변경 전 행위 lock 부재)와 "버그가 숨는 이유"(RC-1: 자동 행위 관측자 부재)는 *같은 누락 산출물*의 두 면이다.

### 1.5 계약·관측가능성·전방 축 (Contracts / Observability / Forward Axes) — 2/5, "팔 수 없는" 상태

**진단: compiler↔runtime seam이 코드베이스에서 가장 type-unsafe한 경계이며, 그것은 *구조적*이다(producer가 타입을 가졌는데 경계가 고의로 버린다).**

- `ShowCommand`가 **두 번, 독립적으로, 공유 타입 없이** 정의됨(`emit-commands.ts:41` vs `renderer-types.ts:52`); `LoadCommand`/`SceneCommands`도 동일(A6 C1/C2). 주석이 hand-sync 체제를 자백한다("Mirrors the compiler-side …"). expr payload는 `{ ast: unknown }`로 ×7 건넌 뒤 `as unknown as RuntimeExpr`로 이중 캐스트(A6 C3, `renderer.ts:97,101`). producer는 타입을 *가지고 있다*(`render-node.ts:658-661 DataExpr.ast: Expr`) — 경계가 *고의로 버린다*. 버전 핸드셰이크도 없다(A6 C4, grep-0).
- **device loss는 감지 후 영구 사망**(A6 E1, CRITICAL): `gpu.ts:214-223`이 flag만 세우고 `render-loop.ts:128`이 reschedule 없이 halt; `requestDevice`는 init에서 단 1회(`gpu.ts:140/177/195`). 복구 경로 없음.
- **`'error'` 이벤트 부재**(A6 E2, CRITICAL): `layer.ts:437-441`의 이벤트 union에 error 없음. device loss·validation·worker crash가 `console.error`에만 도달.
- **패키징 — 라이브러리를 literally `npm install` 못 함**(A6 §α, CRITICAL): `runtime/package.json:32-33`이 `@xgis/compiler`/`@xgis/shared`를 `workspace:*`로 의존하는데 둘 다 `private:true` + `main: ./src/index.ts`(raw TS). 공개 레지스트리가 해소 불가.
- **plugin/extension seam 부재**(A6 §β): `registerLayer|registerSource|CustomLayer` grep-0. 3D-tiles를 추가하려면 엔진을 fork해야 한다.
- **determinism**(A6 §δ): `Date.now()/performance.now()/Math.random`이 eval 경로 포함 18 file에 42회 — 시간 축을 deterministic하게 golden-test할 수 없다.
- **4D 데이터 rigor**(A6 §ε): 공간은 강하지만(`shared/src/ecef.ts`, proj4) 시간은 styling afterthought — feature 위 `valid_time/epoch` 없음(grep-0). 4D-city는 데이터 위 시간 좌표를 요구하는데 그게 없다.

### 1.6 추가 축 — 깊이/투명도(Depth/OIT)와 두 번째 remediation 트랙 (미분석, BLOCKING)

**어느 S-file도 depth precision이나 OIT compositing을 분석하지 않았다 — 그런데 둘 다 live task이고 depth는 모든 3D/extrusion/3D-tiles 프레임의 substrate다.** repo엔 *두 번째* remediation 계획(06-08 rendering audit)이 있어 reversed-Z depth + RTC f64-matrix precision을 "Tier 1"로 재우선순위화한다 — S0–S20 시퀀스에 *없는* 작업이다(task #8 "reversed-Z", task #9 "decide OIT fate"). 본 결산은 §4에서 이를 명시적으로 adjudicate한다. 3D-forward 목표에서 depth-buffer 아키텍처와 order-independent transparency를 무시하는 것은 사소한 누락이 아니다.

---

## 2. Blender-DNA 로드맵 재검증 — MODIFY (framing은 REJECT, 부품은 salvage)

**판정: MODIFY. ~4개 increment를 유지하되, 전체를 rename하고 "Blender-DNA" framing은 category error로 outright 기각.**

이 로드맵은 *직전 AI 세션*이 작성했다는 사실을 명시적으로 다룬다. 그것이 권고를 약화시키지도 강화시키지도 않는다 — 증거가 결정한다. 다만 두 가지 *세션 산물* 특유의 실패 양식이 보인다: (a) 가까운 peer(MapLibre) 대신 *웅장한* peer(Blender)를 골라 native-app 어휘(DNA/RNA, operator-undo, depsgraph engine)를 들여온 점(RC1), (b) 8개 실제 단위에 21 increment·"5 authorities"를 부과해 *세리머니가 미실행을 가린* 점(RC2). 둘 다 "그럴듯한 서사"를 선호하는 생성 편향의 흔적이며, 본 결산이 §6.1에서 인정하듯 *이 문서 자체도* 같은 위험에 노출돼 있다.

**FOR의 가장 강한 논거:** core 진단은 옳고 1차-인용으로 뒷받침된다 — 단일 `_needsRender` boolean이 under-invalidation 버그를 구조적으로 숨긴다는 통찰(S16 staleness 버그 `c2ca9842`가 실제 사례). depsgraph의 *패턴*(dependency-scoped invalidation)은 진짜 transfer된다(B1 §3, PARTIAL). 로드맵의 명명된 권위 중 DirtyDomains·projections-table·thin command bus는 *방어 가능한 부분집합* 안에 있다(B1 §5).

**AGAINST의 가장 강한 논거(B1, 결정적):** X-GIS는 TypeScript로 *이미 표준화된 외부 포맷*(PMTiles/MVT/GeoJSON/style-JSON) 위에서 도는 stateless-per-session 스트리밍 뷰다. Blender의 DNA serialization·ID-library-linking·RNA introspection·COW datablock·operator-undo·global `bContext`는 *X-GIS에 없는 문제를 푼다*(B1 §2, §5). 더구나 그중 여러 개는 Blender 자신의 유지보수자들이 *벗어버리고 싶어하는 부채*다(2026-04 "Future of DNA & RNA" 워크숍, B1 §2). `bContext`는 B1이 "actively harmful"로 명시 — X-GIS의 explicit `FrameContext`/`SceneView`가 *더 낫다*. 그리고 A5의 측정: 5개 권위 중 ~1.8개만 실재(OperatorBus는 27줄 side-log, DirtyDomains는 consumer 1개, EvaluatedTile은 0% — A5 §2.3); 21 increment 중 god-file을 줄이는 S17/S18/S19/S20은 0% 실행, 그동안 worst god-file은 +21% 커졌다(A5 §2.2).

**권고와 이유:** framing을 죽이고 "Invalidation + Decomposition (MapLibre-shaped)"로 rename, 5-authority/21-increment 형식주의를 ~8개 plain unit으로 collapse(B1 §5; A5 §4; B5 §b Rule-of-Three). **그러나 — 중요 — 이 8개 단위는 *2D 부채* 분해이지 *전방 아키텍처*가 아니다**(RED-TEAM-technical m-2). 3D-tiles source, temporal layer, depth/OIT 서브시스템, plugin registry는 *추가적이고 미scope*다. "leaner plan"은 *어제의 문제에 대해* leaner할 뿐임을 명시한다. REJECT 리스트(DNA 포맷·ID-datablock·RNA·COW·auto-undo·`bContext`)는 B1 §5 그대로 확정한다.

---

## 3. 5년 목표 아키텍처 — "Good"의 모습 (transfer되는 것만)

Blender 클론이 아니다. MapLibre/deck.gl의 *계약 형태*에, Blender/Unreal/deck.gl에서 *실제로 transfer되는* 패턴만 layering한 것이다.

1. **명시적 lifetime scope 위의 단일 소유자 서브시스템**(헤드라인 transfer, B2 §2). Unreal을 그대로 거울로: *device*(GPU/adapter/pipeline-cache/atlas — `setStyle` 생존 ≈ `UEngineSubsystem`), *map-session*(camera/projection/source-registry/tile-cache ≈ `UGameInstance`, B2 §4), *frame*(기존 `FrameContext`). 각 서브시스템은 `initialize(deps)`/`deinitialize()` 필수 — `map.destroy()`가 "역순 deinitialize"가 되어 갓오브젝트 + 누락-`destroy()` 부채를 동시에 치료. **DI 프레임워크 금지(zero-deps 준수), 타입드 registry로 충분**(B2 §5).

2. **VTR를 MapLibre의 검증된 3-way seam으로 분해**(B3 §2/§7/§11): `Bucket`(geom→buffer) / `WorkerTile`(orchestration) / `ProgramConfiguration`(buffer→shader). 로드맵이 이미 올바른 하위단위를 명명했다(GPUTileCache/TileUploadScheduler/TileBindGroupFactory/TileVisibilitySelector — A1 §2.1) — 단지 미실행. **단, threading은 1:1로 transfer되지 않는다**(§6.2 B-4): WebGPU `GPUBuffer` 생성은 per-worker device 없이 worker에서 불가하므로 worker=CPU-typed-array, main=`writeBuffer`를 유지(B3 §3).

3. **단일 선언적 권위 + registration-over-reference**(B3 §1 + B2 §5): `projections-table`이 *유일* 권위; `isCylindrical/isFlat/isOrtho`는 *export된 accessor*; 새 projection/source-type/layer-type은 core가 import하지 않는 registry로 *register*. 이것이 R3(권위 역전)을 닫고 AXIS β(plugin seam)를 동시에 연다.

4. **call-graph가 아니라 contract**(B3 §10.1, B2 §1): 양 패키지가 import하는 단일 `ShowCommand`/`LoadCommand` 타입(팀은 `ShaderVariant`로 *이미 이 move를 증명*했다 — A6 C-good), versioned·`.parse()`-validated artifact. `map ↔ render-loop` 사이클은 immutable frame-state를 아래로 넘겨 끊는다(B1 §3: mutable back-reference보다 낫다; `bContext`로의 퇴행은 "actively harmful").

5. **per-domain dirty + idle 수렴**(B3 §5, "정확히 그대로 복사할 최고가치 패턴"): 단일 `_needsRender`를 `style/sources/placement` domain으로 분할, 단일 `_update()`로 funnel, `idle` 발사, 루프 정지. 이것이 로드맵의 DirtyDomains의 *진짜* 형태다(현재 write-only, consumer 1개).

6. **hot path는 DOD, control plane은 가독 OOP**(B5 §a). tile/vertex/label packing은 typed-array SoA(이미 X-GIS의 현실); map/style/lifecycle은 plain readable class. **일반 ECS 기각** — X-GIS core 데이터는 공간형(quadtree/R-tree/tile cache)으로 ECS가 문서화된 약점인 워크로드. **단, 4D-city scene-graph는 별개 미정의 문제로 자체 Rule-of-Three gate를 가진다**(§6.2 M-3) — "ECS 기각"이 아직 명세되지 않은 서브시스템에 대한 판결로 읽혀선 안 된다.

7. **모든 구조 변경은 Strangler-Fig/Branch-by-Abstraction seam 뒤에서, golden-master matrix를 먼저 lock**(B5 §c). render path의 big-bang 재작성 *금지*; 구·신이 flag 뒤 공존; 각 커밋은 green·revertible; 5,440줄 VTR은 *절대 in-place 편집 금지*(Sprout — 새 단위를 *호출*).

**"Good"이 명시적으로 포함하지 *않는* 것**(B1 §5 확정): 자체 "DNA" 파일 포맷, ID-datablock+library-linking 문서 모델, RNA introspection, COW datablock, auto operator undo, global `bContext`.

---

## 4. 안전한 마이그레이션 순서 (Bounded Blast-Radius, Cannot Stall)

원칙(B5 §c + 위 root): **위험한 편집 전에 안전망을 짓되, 안전망 자체가 무한 yak-shave가 되지 않도록 *go/no-go 기한*으로 묶는다. 신뢰 적립을 위해 기계적·zero-risk 삭제를 먼저. 갓파일은 절대 in-place 편집 금지. consumer당 revertible 커밋 하나.** 각 단계는 *무엇이 다음을 gate하는지*와 *blast-radius를 어떻게 bound하는지*를 명시한다.

### Phase 0a — FIRST CONCRETE MOVE: `.md` 동결 + S19 dedup (gates 신뢰, near-zero risk)
**Move:** *이 문서 이후 새 연구 `.md` 금지를 즉시 발효*하고(§6.1 자기-인정의 직접 귀결), 다음 커밋을 S19로 한다 — `quantizeAxis`/`tileEcefCenterFromMerc`의 3복사본(VTR + synthetic-earth-backend + compiler tiler)을 `@xgis/shared`로 삭제-통합(A5 §2.4). 본인이 직접 확인한 dedup의 안전성: shared는 leaf라 DAG가 깨끗하게 유지된다(A1 §5).
**왜 첫째:** research-to-execution 비율이 역전됐고(A5 §3.3), 이 결산 자체가 그 패턴의 일부다(RED-TEAM-motivation B1). S19는 #1 drift 버그 클래스를 닫는 가장 싼 승리이며 **"우리는 실행한다"를 증명**한다. 기존 byte-equal drift gate(US-010)가 characterization test 역할.
**Blast-radius:** 3 source file + 1 shared module + 테스트. 모든 call site가 *컴파일타임*에 잡힘 — 가장 안전한 클래스. **Stall 불가 이유: 기계적이고 며칠짜리이며, 미루면 그 자체가 §6.1 자기-모순의 증거가 된다.**

### Phase 0b — 두 개의 가장 싼 CRITICAL을 앞으로 (gates 목표 자체, render risk 0)
**Move:** (1) 패키징(α): `@xgis/compiler`/`@xgis/shared`를 JS로 build, runtime이 필요로 하는 것의 `private:true` 제거, `workspace:*`를 publishable spec으로 — 또는 dist에 번들(A6 §α). (2) `map.on('error')` 이벤트(E2) + device-loss 복구 루프(E1, WebGPU spec: fresh adapter→device→rebuild→`configure`)(A6 E1/E2). (3) E3 validation-rejection un-swallow(이미 task #2 in-flight).
**왜 여기:** α는 "sellable library" 목표를 *오늘* literally 불가능하게 만드는 유일한 finding이고(RED-TEAM-technical M-1), 다개월짜리 갓파일 작업보다 목표에 더 직접적이며 렌더 리스크 0이다. E1은 desktop 고-GPU-부하(소유자 명시 우려)에서 *가장 높은 심각도의 런타임 실패*다 — massive data + 3D-tiles = 더 많은 device-loss = 첫 driver reset에 영구 사망하는 렌더러는 갓파일이 아무리 깨끗해도 5년 viable 아님(RED-TEAM-technical M-2).
**Blast-radius:** α는 빌드 설정 + package.json; E1/E2는 additive 이벤트 + 복구 루프. render path 비변경.

### Phase 1 — 강제 ratchet (gates 비-회귀; 저렴)
**Move:** 3개 CI gate(A1 §6): (a) `render/` 하 신규/성장 file >800 LOC 실패; (b) `projType === <int>`를 `projections-table.ts` 밖에서 금지(grep-lint); (c) `map → render-loop → map` 사이클 금지. **현 LOC를 ceiling으로 lock.**
**중요 — 사이클 gate 메커니즘 교정(§6.2 M-3, 본인 직접 검증):** 43개 `host.<field>` reach-through를 제거해도 사이클은 *살아남는다*. `render-loop.ts:36`의 value import는 `:597/:610/:611`의 `XGISMap.FLICKER_GRACE_FRAMES`/`FLICKER_LOG_CAP` static 상수 읽기 때문에 남는다. 따라서 사이클을 끊으려면 **이 두 상수를 공유 constants 모듈로 relocate**해야 한다. 그리고 gate (c)는 사이클이 끊기기 전엔 hard-fail로 못 land하므로 **warn-then-fail**로 — 현 사이클을 allowlist한 warn으로 land, relocate+host-struct 완료 시 fail로 flip(S1 §5.1).
**Blast-radius:** lint/CI-only(상수 relocate 제외). 누수를 멈춘다.

### Phase 2 — 비-tile 신뢰성 fix (Sprout-shaped, 언제든 병렬)
**Move:** glyph-PBF를 기존 PriorityQueue로 throttle + AbortController(A3 §1.2, 소유자의 명시적 공포에 부합하는 유일한 uncapped 경로); worker-pool crash respawn + per-job timeout + respawn-rate circuit breaker(A3 §3); glyph-atlas `shrinkPages()` byte-aware hysteresis(A3 §2.2, monotonic GPU leak). **clock 주입 seam 추가(δ)** — golden/metamorphic oracle의 전제조건(§6.2 M-6): `Date.now()/performance.now()`를 단일 injectable source로(42 사이트, A6 §δ).
**Blast-radius:** 각각 isolated 단위. gate하지도 gate되지도 않음 — 신뢰성 sprint 때 아무 때나.

### Phase 3 — 안전망 = 실제 spike (gates Phase 4·5, 그러나 *기한으로 묶음*)
**Move(두 갈래, 병렬):**
- (3a) **GPU-CI 조달을 time-boxed go/no-go spike로** — Phase-0 *가정*이 아니라 명시적 기한 결정(§6.2 B-2). 기존 matrix(45 cell)를 perceptual-tolerance diff로 wire. `expected_red` flip-alert 추가(A4, ~1줄, task #6).
- (3b) **3D/extrusion/OIT oracle 신규 설계** — matrix의 현 oracle(`ink_family`/`disc_fraction`/perceptual-diff)은 전부 2D이고 depth-ordering oracle은 repo에 *없다*(§6.2 B-2, 본인 grep 검증). extrusion이 0.00% 렌더되는 면(A5 §4.5)을 보려면 height/silhouette/depth oracle을 *발명*해야 한다.
**FALLBACK 분기(필수, §6.2 B-2):** 만약 3a spike가 "infeasible"을 반환하면 — S20은 무기한 park, **cheap win(Phase 0a/0b/1/2)만 ship**하고 갓파일 분해는 "execution capability가 Phase 3 seam으로 증명될 때까지" 보류한다. 수동 real-GPU 실행은 A4 §3b가 이미 "게이트가 아니다"라 했으므로 fallback gate로 약하다. **이 모순을 솔직히 적는 것이 핵심이다: 수동 실행이 viable gate면 GPU-CI는 load-bearing이 아니고 S20을 지금 시도할 수 있다 — 둘 중 하나만 참이다.**
**Blast-radius:** 인프라·테스트-only, 엔진 소스 0 변경.

### Phase 4 — ONE seam을 Branch-by-Abstraction으로 (method-change 증명; 한 서브시스템)
**Move:** 가장 덜 결합된 갓파일 책임을 골라 BbA+Sprout로 추출. 후보: VTR에서 `GPUTileCache`/`TileUploadScheduler`(A1 §2.1) 또는 tile scheduler 불변(B5 §e, 3D-tiles 하에서 중요성 증가). 절차: (1) 현 supplier 위 abstraction 도입; (2) client 이동; (3) 새 supplier 구축; (4) flag 뒤 전환; (5) 구 삭제. **VTR in-place 편집 금지 — Sprout.**
**왜 여기:** 이것이 *method가 바뀌었다는 증명*이다(R1). **그리고 §6.2 M-2의 정직한 인정: 팀의 S20 execution-capability 증거는 빈약하다 — 유일한 in-window behavior-change(S16)가 staleness 버그를 냈다(`c2ca9842`). net은 작성된 *후*의 회귀를 잡지, 작성을 올바르게 만들지 않는다.** Phase 4는 S20 전에 capability를 *증명하는* 게이트다. 통과 못 하면 S20은 보류가 정직한 판정이다.
**Blast-radius:** 한 책임, flag 뒤. 롤백 = flag flip / 한 revert.

### Phase 5 — S20 (헤드라인) — Phase 3b(extrusion oracle) + Phase 4 통과 후에만
**Move:** `evaluated-tile.ts` + `tile-upload-service.ts` 추가(A5 §1.2 S20), upload 경로를 VTR에서 Sprout, arena-compaction-vs-upload ordering 보존(GPU UAF, A5 Risk #5).
**Gate:** real-GPU lane에 *extrusion cell*이 존재하고 green이어야 함(Phase 3b 없이는 시도 불가). depth/OIT 트랙 adjudication(§6.2 B-5)이 여기 fold-in.
**Blast-radius:** 시퀀스 최대 — Sprout + flag 공존 + extrusion cell green + one-consumer-at-a-time로 bound.

### Phase 6 — 전방 아키텍처 (목표 정의 작업, 별도 scope)
4D 데이터 모델 spike(`ShowCommand`/tile-key/vertex-buffer에 `valid_time`이 무엇을 요구하는지, GPU working-set budget에 무엇을 하는지 — §6.2 B-1); 3D-tiles plugin/registration 계약(β, S20의 *내부* seam과 *별개*인 external·versioned·sandboxed 계약 — §6.2 M-5); depth/OIT 아키텍처. **이들은 "addressed"가 아니라 "unscoped"임을 명시한다.**

### 소유자를 위한 비용/예측가능성 framing (다음 절)

---

## 5. 비용 / 예측가능성 framing (소유자의 핵심 우려)

소유자는 두 가지를 동시에 두려워한다 — 갓파일 *그리고* 투기적 추상화 — 그리고 반복되는 고통은 "fix가 안 붙는다"이다. 구조를 비용에 직접 연결한다:

- **오늘의 비용 곡선은 잘못된 모양이다.** 지출이 *부패하는* 산출물을 만든다: research(이 결산 포함)와 inert substrate(7/8 write-only dirty domain — 본인 grep 검증)가 강제장치 부재로 누수된다(A1 §6). 한편 비싼 리스크(S20)는 영구 연기. 따라서 비용은 *높고 반복적*이며 예측가능성은 *낮다*("fix가 안 붙는다", R1). map.ts가 줄이려던 로드맵 동안 +604줄 큰 게 증거다(A5 §2.2).

- **버그 위치추적성(bug-locatability)이 구조에 직접 묶인다.** 2,054줄 `render()` 안의 버그는 *코드만 봐서는 안 보인다*(A4의 측정: 0개 테스트가 `.render()` 호출). 갓파일이 클수록 한 sub-phase 변경의 local blast radius가 없어 "fix A가 bug B를 재개방"한다(label-pass 980줄 메서드의 반복 버그 이력 — CJK box-out, bearingY collapse, anchor parity — 이 정확히 이 메커니즘 — A4 §2b). **단일 소유자 서브시스템은 버그를 한 파일로 가둔다 — 이것이 위치추적성의 구조적 정의다.**

- **시퀀스가 곡선을 뒤집는다.** Phase 0a/1이 *부패하지 않는* 승리를 적립한다(dedup은 ratchet이 잡아두므로 decay 불가; 재발 버그 클래스를 제거하므로 미래 디버깅 비용을 *영구* 감소). Phase 3의 안전망이 들어오면 *모든* 구조 변경의 비용이 *bounded·predictable*해진다: matrix green 유지면 ship, 아니면 한 revert. 이것이 "fix가 안 붙는다"의 문자 그대로의 해독제다(B5 §c TRANSFER VERDICT).

- **소유자의 이중 공포가 존중된다.** 갓파일은 *구체적 collaborator로* 분해되고(A1 §2.1의 명명된 단위), **투기적 추상화는 도입되지 않는다** — 모든 seam은 ≥3 consumer를 얻거나 현 버그 클래스를 죽인다(B5 §b Rule-of-Three). ECS/5-authority/21-increment 세리머니는 명시적으로 기각. PROJECTIONS table은 추상화를 *번다*(7+ projection, 실제 버그 클래스); one-impl `ITileFetchStrategy`는 못 번다.

- **가장 정직한 비용 진실:** 안전망(Phase 3)이 조달 불가로 판명되면 비용 곡선을 뒤집을 수 없고, "net 먼저"는 *영구히 아무 구조도 ship되지 않는 이유*가 된다 — 정체 패턴이 전략으로 축성된 꼴이다(§6.2 B-2). 그래서 Phase 3을 *기한으로 묶고 fallback을 명시*하는 것이 비용 관점에서 가장 load-bearing한 결정이다.

---

## 6. 정직한 불확실성

### 6.1 내가 확신하지 못하는 것 (그리고 이 문서 자체의 한계)

1. **이 문서가 정체의 일부다.** RED-TEAM-motivation B1이 옳다: 이 결산은 비-실행 audit 패턴의 13–18번째 사례이며, "S19 전엔 새 `.md` 금지"를 권고하면서 스스로 `.md`를 추가했다. 나는 이를 *예외라 변명하지 않는다*. 유일한 정직한 출구는 §4 Phase 0a 그대로 — 동결을 *지금* 발효하고 다음 커밋을 S19로 하는 것이다. 이 문서가 또 다른 audit 라운드로 이어지면 명제는 그 존재로 falsify된다.

2. **GPU-CI 조달 가능성은 내 증거 밖이다.** A4/A5/A6 모두 이를 "the unlock"으로 명명하나 *가격을 매기지 않았다*. 이것이 전체 시퀀스의 #1 미해결 리스크다(§4 Phase 3은 그래서 spike).

3. **golden-master가 fused god-method에 충분한지 모른다.** 2,054줄 `render()`의 출력이 너무 entangled해 coarse baseline이 *wrong-but-consistent* 행위를 lock할 수 있다(matrix는 이미 26/45 known-broken — A4 §3c). metamorphic(R5)으로 보강하나 충분성은 증명 못 한다 — necessary임은 확실, sufficient는 불확실(§6.2 B-3).

4. **4D를 로드맵에 대해 validate할 수 없다.** 어느 source도 4D-city 렌더가 "데이터 위 시간 좌표" 이상으로 무엇을 요구하는지 구체화하지 않았다(A6 ε는 부재만 증명). 헤드라인의 "4D" 주장은 §6.2 B-1대로 *spike로 scope되기 전엔* 평가 불가다. 이를 헤드라인 verdict에서 약화시켜 적었다.

5. **OperatorBus — 본인 grep으로 27줄 side-log 확인.** 외부 권위(B3/B4)는 렌더러의 op-log/undo를 지지하지 않는다. 증거는 *delete*를 가리킨다(§6.2 m-3에서 입장 확정). dirty *bitset*은 잘 지지되나(B3 §5), op-*log*는 아니다.

6. **점수의 일부가 "좋은 진단"으로 floor를 떠받친다.** RED-TEAM-motivation M4가 옳다: credit된 자산 3개 중 2개(shader-DSL, 진단 자체)는 팀 자신의 연구·추상화 산물이다. "좋은 진단"을 *sustainability* 점수에 세는 것은 순환적이다. 냉정한 read는 1.5/5에 가깝다 — 유일한 진짜 구조 자산(DAG)이 모듈 레벨에서 종합 스스로의 설명으로 undermine되기 때문. 나는 2/5를 적되 이 비판을 받아들인다.

### 6.2 레드팀 대응 (모든 blocking·major 도전에 명시적 응답)

**[기술 적합성 레드팀]**

- **B-1 ("4D는 additive" — 0 증거, BLOCKING) — 수용.** S2/S5/S6의 "additive" 주장을 본 결산에서 *철회*한다. A6 ε의 1차 증거가 정반대(feature 시간 축 부재, grep-0). §4 Phase 6에 4D를 *additive가 아닌 미scope spike*로 재배치했고, §3·§6.1·§0에서 4D를 헤드라인에서 약화시켰다. "pick one" 요구에 응답: **4D는 spike로 scope되기 전엔 평가 불가**로 명시한다.

- **B-2 (GPU-CI 키스톤이 보호 대상 면을 못 본다 — BLOCKING 내부 비정합) — 수용.** 본인 grep으로 oracle이 2D뿐임을 확인. §4 Phase 3을 *두 개의 미구축 항목*으로 분리했다: 3a(조달 미확인 러너) + 3b(*존재하지 않는* 3D/extrusion/OIT oracle 신규 설계). S20(Phase 5)은 "GPU-CI"로 unblock되지 않으며 Phase 3b를 명시적 선행으로 둔다.

- **B-3 (cache-thrash가 "out of scope"가 아니라 live — BLOCKING missed subsystem) — 수용, 직접 검증.** 본인 grep: `MAX_GPU_TILES_DESKTOP=256`(`vector-tile-renderer-helpers.ts:16`) vs `MAX_TILES=300`(`globe.ts:422`), FLICKER 로그 `gpuCache=315/375`. §1.3에서 sized finding으로 승격. **256-tile cap은 3D-tiles/4D working set 하에서 가장 먼저 깨진다 — eviction/cap 정책이 screen-coverage-aware가 되어야 한다.** 이는 leak이 아니라 churn(대역폭·발열)임을 명시.

- **B-4 (deck.gl/MapLibre 계약을 X-GIS 제약 없이 endorse — BLOCKING overclaim) — 수용.** §3 item 2에서 worker/GPU-creation 경계(worker=CPU-typed-array, main=writeBuffer; B3 §3)를 first-class 제약으로 격상. 192-byte-stride packed tile buffer는 shallow-comparable prop이 *아니므로* deck.gl의 "diff 위 persistent GPU state forward" 모델은 binary-attribute escape hatch로만 transfer됨을 명시. deck.gl의 geo-layer/camera-ownership 머신은 X-GIS가 자체 ECEF/projection을 소유하므로 off-limits.

- **B-5 (두 remediation 계획 미조정 + depth/OIT 미분석 — BLOCKING) — 수용, adjudicate.** §1.6에서 누락을 명시했고 §4 Phase 5에서 판정한다: **reversed-Z depth + RTC f64-precision + OIT는 S20(extrusion-heavy) 전에 적어도 *분석*되어야 한다** — depth는 모든 extrusion 프레임의 substrate이므로. 구체적으로 Phase 3b의 extrusion oracle은 depth-ordering 정확성을 검사해야 하고, 이는 reversed-Z 결정을 *강제*한다. 따라서 depth-precision 트랙은 Phase 5의 선행으로 fold-in한다(별도 트랙이 아니라 Phase 3b/5의 일부). task #8/#9가 이를 확인.

- **M-1 (패키징 α 매장 — priority inversion) — 수용.** §4 Phase 0b로 *앞당겼다*. α는 다개월 갓파일 작업보다 목표에 직접적인 유일 finding이며 가장 싼 CRITICAL.

- **M-2 (device-loss terminal + no error event — render-centric 명제가 구조적으로 못 봄) — 수용.** §4 Phase 0b로 격상. S4의 "ONE net" framing은 *overstate*임을 §6.1에서 인정 — net은 둘이다(visual/metamorphic + type/contract). E1을 "전체 결산 최고 심각도 런타임 실패"로 §1.5에 명시.

- **M-3 (ECS 기각이 4D-city에 대해 settled로 단언 — under-examined) — 수용.** §3 item 6에서 ECS 기각을 *tile/raster core로 명시적 scope*하고, 4D dynamic-object scene-graph를 자체 Rule-of-Three gate를 가진 *open design question*으로 표시.

- **M-4 (단일 funnel을 per-event 비용 미해결로 권고 — perf 부채 재도입 위험) — 수용.** §4에서 funnel 권고를 *측정된 fast-path 조건부*로 만든다: 고빈도 gesture(pointer-move at device rate)는 op를 기록하지 않고 domain만 tag하는 fast-path. 측정 spike 없이 keystone으로 제시하지 않는다(MEMORY의 adaptive-DPR dead code·label hot path 이력 고려).

- **M-5 (plugin β를 S20의 corollary로 취급 — 실제 3D-tiles 질문) — 수용.** §4 Phase 6에서 β(external·versioned·sandboxed·stable-type 계약)를 S20(internal eval→draw seam)과 *명시적으로 분리*. eval→draw seam 구축이 publishable extension point를 자동 산출하지 않음을 인정. β는 자체 typed·versioned registration 설계 필요 — 목표에 가장 직접적이나 가장 덜 명세된 deliverable.

- **M-6 (injectable clock이 test net의 전제인데 모든 권고에서 누락 — net을 못 지음) — 수용.** §4 Phase 2에 "단일 injectable clock seam"을 `idle`/`error`와 동급 전제로 추가(42 사이트, A6 §δ). metamorphic/golden oracle은 이것 없이는 non-functional.

- **m-1 (사이클 gate 순서 자기모순) — 수용.** §4 Phase 1에서 S1의 warn-then-fail을 명시 채택.
- **m-2 (8-unit collapse가 3D/4D 면에 대해 unvalidated) — 수용.** §2에서 8 unit이 "remediation backlog이지 forward-architecture가 아님"을 명시.
- **m-3 (`as unknown as` ×354가 증거로 인용되나 migration 리스크로 미평가) — 수용.** 352개를 모든 구조 변경(S20, deck.gl descriptor)의 latent cost로 §1.5에 인지. 유명한 2개만 고치는 게 아님.

**[동기·정체 레드팀]**

- **B1 (이 종합이 audit-stall의 일부 — 중심 자기-반박) — 수용, 정면 대응.** §0·§6.1·§4 Phase 0a 참조. 동결을 *이 문서부터* 발효, S19를 literal 다음 액션으로, 추가 종합 없음. "owner가 red-team을 요청했다"는 충분한 변명이 아님을 인정.
- **B2 (GPU-CI 조달 미검증 → 전체 시퀀스가 "S20 영구 park"로 붕괴) — 수용.** §4 Phase 3을 time-boxed go/no-go spike로 전환, 명시적 fallback 분기 작성, "수동 실행이 gate인가 아닌가" 모순을 §4·§5에서 정면 기술.
- **B3 (fused god-method 위 golden-master는 circular, bug-preserving by construction) — 수용.** §6.1 #3에서 necessary-not-sufficient 인정; §4 Phase 5는 Phase 3b의 extrusion+OIT cell 존재를 명시 선행으로 둬 무한 yak-shave를 bound.
- **M1 (6× restatement, ~5 move로 collapse) — 수용.** 이 결산은 6개 REC set이 아니라 *단일 ranked 시퀀스*(Phase 0a→6)로 제시. "6 테마 합의"는 shared-prior echo이지 독립 corroboration이 아님을 인정.
- **M2 (S20 execution-capability 증거 — S16 hotfix가 반증) — 수용.** §4 Phase 4에서 정직히 기술: 가장 쉬운 behavior-change(S16)가 피를 봤으므로 S20 capability는 unearned. Phase 4가 capability를 *증명하는* gate이며, 통과 못 하면 "cheap win만 ship, S20 보류"가 정직한 판정.
- **M3 (REC-3 메커니즘 오류 — static 상수가 사이클을 살림) — 수용, 직접 검증.** 본인이 `render-loop.ts:597/610/611`의 `XGISMap.FLICKER_*` 상수 사용을 확인. §4 Phase 1에 "두 static 상수를 공유 모듈로 relocate"를 추가.
- **M4 ("2/5 not 1" framing이 rhetorical work) — 수용.** §6.1 #6에서 1.5/5에 가깝다 인정, "좋은 진단"을 sustainability 자산으로 세는 순환성 인정.
- **M5 (OperatorBus kill-vs-complete 4회 deferral) — 수용, 입장 확정 → m-3 참조.**
- **m-1 (live task list가 "still only auditing"을 반증) — 수용.** task #2/#3(validation un-swallow, glyph re-arm)은 concrete fix work임을 인정; 순수-마비 그림은 rhetorical force였음. 그래서 §4 Phase 0b가 이 in-flight 작업을 흡수한다.
- **m-2 (MapLibre seam의 WebGPU worker-device transfer 미검증) — 수용 → §3 item 2 + B-4 응답에서 제약화.**
- **m-3 (OperatorBus 입장 미확정) — 입장 확정: DELETE.** 외부 권위가 렌더러 op-log를 지지하지 않고(B3/B4 silent), 본인 grep으로 27줄 side-log·consumer 0 확인. 구체적 undo consumer가 나타날 때까지 *삭제*한다(B5 §b Rule-of-Three). dirty bitset은 §4 Phase 5에서 *consume하게* 완성하되, op-*log*는 유지하지 않는다.
- **m-3(score), m4(4D headline) — 수용 → §6.1 #6, B-1 응답 참조.**

**레드팀이 옳게 본 것(integrator가 over-correct하지 않도록):** core 진단(갓파일 성장, invalidation inert, relocation-not-decoupling, research-to-execution 역전)은 옳고 1차이며 잘 접지됐다 — 할인하지 말 것. "위험한 편집 전 안전망"은 옳은 *method*. 강제-ratchet-first는 진짜 keystone이고 저위험 — 앞에 유지. Blender-DNA framing 기각은 옳고 증거-뒷받침.

---

### 증거 원장 (Evidence Ledger)
A1 §2.1/2.3/§3.1/§3.2/§4a/§5/§6 (VTR 5440·render() 2054; map↔render-loop 사이클; 권위역전 40%; 패키지 DAG; CI gate 부재). A2 §1/§2/§3/§4 (갓오브젝트 3431; dirty 7/8 write-only; easeTo=jumpTo; 89 host reach). A3 §1.1/§1.2/§2.1/§2.2/§2.3/§3 (tile scheduler 견고; glyph uncapped; atlas monotonic leak; worker no-respawn). A4 §2b/§3a/§3b/§3c (262 테스트 중 260 CPU·1 GPU·0 render; CI 4 spec 0 픽셀; matrix 로컬·수동; 26/45 expected_red). A5 §2.2/§2.3/§2.4/§3.1/§3.2/§3.3/§4.5/§4 (map.ts +604; 권위 1.8/5; quantize 3복사본; S20 deferred; extrusion 0.00%; research 역전). A6 C1/C2/C3/C4/E1/E2/§α/β/γ/δ/ε (ShowCommand 이중정의; ast:unknown ×7; device-loss terminal; no error event; npm-impossible; no plugin seam; 42 clock 사이트; no feature time axis). B1 §2/§3/§5 (Blender-DNA category error; depsgraph PARTIAL transfer; reject list). B2 §2/§4/§5/§6 (lifetime subsystem; registration-over-reference; 강제 없으면 경계 무너짐). B3 §1/§2/§5/§7/§10/§11 (단일 권위; Bucket/WorkerTile/ProgramConfiguration; per-domain dirty + idle; contracts not call-graphs; WebGPU worker-device 비-transfer). B4 §1.1/§2.2/§2.3/§3 (reactive recompute; async-arrival re-invalidate; remove≠free reject; binary-buffer escape hatch). B5 §a/§b/§c/§d/§e (DOD hot/OOP control; Rule-of-Three; Strangler/BbA/golden-master-first; four-oracle real-GPU; 5 scheduler invariant). 직접 검증(본 세션): `map.ts:454`가 유일 production `.consume()`; `render-loop.ts:36/597/610/611` value-import + static-constant 사이클; `MAX_GPU_TILES_DESKTOP=256` vs `MAX_TILES=300`.
