# @xgis/shader-dsl — public API surface

GENERATED FILE — do not hand-edit. Re-bake with `bun run bake:api-surface` and commit the diff.

Every symbol a consumer can import, per `package.json` `exports` subpath, followed by one
line of shape per definition. `shader-dsl/src/api-surface.test.ts` fails when this file and
the tree disagree, so a public-surface change cannot land without appearing in a diff —
which is what the changelog, filing one entry per commit SUBJECT, cannot show (#1842).

This is not a version. A mirror consumer pins a SHA (#1681), and `git diff` over two SHAs
of this file is the exact list of what changed for them.

## `.` — 363 exports

```
abs
acos
acosh
AddressSpace
ALL_CAPABILITIES
ArithArg
arrayLit
arrayOf
arrayT
asin
asinh
ASSEMBLED_AS
atan
atan2
atanh
autoVars
AxisValues
Backend
BindEntry
BindGroup
BindingDecl
bindingRef
BinOp
bitcastF32
bitcastU32
bool
boolT
Break
Builder
buildRegistry
BuildRegistryOptions
builtin
BuiltRegistry
callFn
Capabilities
Capability
capabilityMatrix
CapabilityRow
CapProfile
CapSupport
CapSupportKind
ceil
clamp
ClassifiedSemanticDiff
CmpArg
CmpOp
compileModule
compileModuleJs
composeModule
ComposeOptions
condExpr
constDecl
ConstDecl
constExpr
ConstHandle
constRef
construct
Continue
cos
cosh
CpuModule
CpuPrecision
CpuStruct
CpuValue
cross
cse
DeclarableCapability
degrees
Diagnostic
Discard
distance
dot
dpdx
dpdy
ElemKey
emitBinding
emitConst
emitExpr
emitFragment
EmitFragment
emitFunc
emitFuncs
emitFuncsCsed
emitGlslFragment
emitGlslModule
emitGlslStages
emitIdentity
EmitIdentityInput
emitModule
emitModuleAt
EmitOptions
EmitPlugin
emitStruct
EmitTarget
EntryInfo
EntryIo
EntryIoField
EntryParam
enumU32
EnumU32
exp
exp2
ExplainedDiffEntry
Expr
externFn
ExternFn
externRef
ExternRequirement
externVar
ExternVarDecl
ExternVarHandle
f32
f32Lit
f32T
f64
f64FromParts
f64GuardOne
f64Parts
f64T
FieldLayout
FieldSpec
Float64Key
FloatKey
floor
fma
fn
FnHandle
FnParamSpec
FP64_GUARD_NAME
Fp64Flavor
Fp64FlavorSignals
fp64Guard
Fp64GuardHandle
fp64Lower
Fp64LowerOptions
fract
FragmentDeclares
FuncDecl
fwidth
GlLinker
GlslEmitOptions
glslEs300Backend
GuardDefines
HandleArray
hostBlock
hostFeaturesFor
hostUniform
i32
i32T
If
IfChain
ifExpr
insideRange
installStmtSink
IntKey
intLit
INTRINSIC_BINDING_REFS
INTRINSIC_HELPERS
INTRINSICS
IntrinsicTarget
inverseSqrt
ioStruct
IoStruct
isAppleGpu
isF64
isKnownIntrinsic
isMat
isMat64
isNodeValue
isScalar
isSemanticallyEqual
isVec
isVec64
KeyOf
LayoutKind
length
Let
lift
linkVariants
location
log
log2
LogOp
Loop
lowerComputeToFragment
lowerModule
lowerWgsl
madd
mat2f64
mat2f64T
mat3f64
mat3f64T
mat4f64
mat4f64T
mat4x4fT
matchEnum
matchExpr
max
member
min
mix
mod
module
ModuleDecl
ModuleParts
mulMat64
Node
NODE_BRAND
NodeLike
NonComposite
normalize
optBarrier
OptLevel
ORACLE_BUILTIN_NAMES
ORACLE_GPU_STUB_NAMES
outsideRange
overrideConst
OverrideDecl
OverrideHandle
OverrideInfo
overrideRef
pack2x16float
pack2x16snorm
pack2x16unorm
pack4x8unorm
param
ParamSpec
PlainStruct
PORTABLE_INTRINSICS
pow
PRE_EMIT_INTRINSICS
radians
RawPayload
rawStmt
RawStmt
ReadonlyNode
recommendFp64Flavor
reduce
reflect
Reflection
ReflectOptions
RegistryEntry
renameVarrefsInFunc
resource
Resource
ResourceKind
Return
ReturnIf
rewriteExprsInFunc
round
samplerT
saturate
Scalar
ScalarKey
select
selectGuardedArm
SemanticAspect
semanticDiff
SemanticDiff
SemanticDiffBucket
SemanticDiffOptions
ShaderDslError
ShaderType
sign
sin
sinh
smoothstep
spellIntrinsic
splitF64
sqrt
stageOf
step
Stmt
storageBuffer
StorageBuffer
structDecl
StructDecl
StructField
StructLayout
structT
Switch
SwitchChain
SwizzleKey
tan
tanh
TexelKey
texture2dArrayfT
texture2dArrayiT
texture2dArrayuT
texture2dfT
texture2diT
texture2dMsfT
texture2duT
textureDimensions
TextureElem
textureLoad
TextureLoad2dKey
TextureLoadArrayKey
textureNumLayers
textureSample
textureSampleLevel
toF32
toF64
toI32
toU32
transformMat4
transformMat64
transpose64
trunc
TypeArray
typeEq
typeKey
u32
u32T
uniformStruct
UniformStruct
unpack2x16float
unpack2x16snorm
unpack2x16unorm
unpack4x8unorm
UnsupportedFeatureError
UsesHandle
validate
validateVariantsWgsl
ValidationError
Var
Variant
variantFamily
VariantFamily
VariantFamilySpec
VariantLinkResult
VariantWgslResult
vec2
vec2f64
vec2f64T
vec2fT
vec2i
vec2iT
vec2u
vec2uT
vec3
vec3f64
vec3f64T
vec3fT
vec3uT
vec4
vec4f64
vec4f64T
vec4fT
vec4iT
vec4uT
VertexAttr
VertexLayout
voidT
wgslBackend
WgslBuiltinName
WgslCompiled
wgslLayout
WgslMessage
wgslType
WgslValidator
when
workgroupSizeOf
```

## `./dev` — 37 exports

```
assertCaps
checkSingleExit
CODES
constFold
countOps
DEFAULT_PASSES
diagnose
DiagnoseOptions
DiagnosticReport
dslError
emitModuleWithReflection
EmitProfile
emitSize
EmitSize
ErrorCode
ErrorCodeDef
fixpoint
formatDiagnostics
formatLoc
formatReport
isSourceTracing
LintConfig
lintModule
LintSummary
lowerForBackend
OpCount
optimize
optimizerReport
OptimizerReport
PassTiming
profileEmit
requiredCaps
setSourceTracing
Severity
SourceLoc
StageTiming
summarize
```

## `./emit-prod` — 19 exports

```
aliasShaderTypes
aliasTypes
DecodedName
decodeShaderLog
EmitOptions
EmitPlugin
inline
InlineDecision
InlineOpaque
invertRenames
mangle
mangleModule
MangleResult
minify
MinifyOptions
minifyShaderText
obfuscate
prune
pruneRedundantPrototypes
```

## `./core/ir` — 223 exports

```
abs
acos
acosh
AddressSpace
ALL_CAPABILITIES
ArithArg
arrayLit
arrayT
asin
asinh
ASSEMBLED_AS
atan
atan2
atanh
BindingDecl
bindingRef
BinOp
bitcastF32
bitcastU32
bool
boolT
Break
Builder
callFn
Capability
ceil
clamp
CmpArg
CmpOp
condExpr
ConstDecl
constExpr
constRef
construct
Continue
cos
cosh
cross
DeclarableCapability
degrees
Discard
distance
dot
dpdx
dpdy
ElemKey
EntryParam
enumU32
EnumU32
exp
exp2
Expr
externFn
ExternFn
externRef
externVar
ExternVarDecl
ExternVarHandle
f32
f32T
f64
f64FromParts
f64GuardOne
f64Parts
f64T
Float64Key
FloatKey
floor
fma
fn
FnHandle
FnParamSpec
fract
FuncDecl
fwidth
i32
i32T
If
IfChain
ifExpr
insideRange
installStmtSink
IntKey
inverseSqrt
isF64
isMat
isMat64
isNodeValue
isScalar
isVec
isVec64
KeyOf
length
Let
lift
log
log2
LogOp
Loop
madd
mat2f64
mat2f64T
mat3f64
mat3f64T
mat4f64
mat4f64T
mat4x4fT
matchEnum
matchExpr
max
member
min
mix
mod
module
ModuleDecl
ModuleParts
mulMat64
Node
NODE_BRAND
NodeLike
NonComposite
normalize
optBarrier
outsideRange
overrideConst
OverrideDecl
OverrideHandle
overrideRef
pack2x16float
pack2x16snorm
pack2x16unorm
pack4x8unorm
param
ParamSpec
pow
radians
RawPayload
rawStmt
RawStmt
ReadonlyNode
reduce
Return
ReturnIf
round
samplerT
saturate
Scalar
ScalarKey
select
ShaderType
sign
sin
sinh
smoothstep
sqrt
stageOf
step
Stmt
StructDecl
StructField
structT
Switch
SwitchChain
SwizzleKey
tan
tanh
TexelKey
texture2dArrayfT
texture2dArrayiT
texture2dArrayuT
texture2dfT
texture2diT
texture2dMsfT
texture2duT
textureDimensions
TextureElem
textureLoad
TextureLoad2dKey
TextureLoadArrayKey
textureNumLayers
textureSample
textureSampleLevel
toF32
toF64
toI32
toU32
transformMat4
transformMat64
transpose64
trunc
typeEq
typeKey
u32
u32T
unpack2x16float
unpack2x16snorm
unpack2x16unorm
unpack4x8unorm
UsesHandle
Var
vec2
vec2f64
vec2f64T
vec2fT
vec2i
vec2iT
vec2u
vec2uT
vec3
vec3f64
vec3f64T
vec3fT
vec3uT
vec4
vec4f64
vec4f64T
vec4fT
vec4iT
vec4uT
voidT
when
workgroupSizeOf
```

## Shapes — 417 definitions

```
src/core/backend.ts#Backend  interface  { absentBuiltins?: ReadonlyMap<string, string>; capProfile: Readonly<Partial<Record<Capability, CapSupport>>>; caseBreak?: string; caseLabel: (value: number, scrutType: ShaderType) => string; constDecl: (name: string, type: ShaderType, value: string) => string; emitBinding: (b: BindingDecl) => string; emitConst: (c: ConstDecl) => string; emitFunc: (f: FuncDecl, parens?: ParenMode) => string; emitOverride?: (o: OverrideDecl) => string; emitStruct: (s: StructDecl) => string; floatMod?: (a: string, b: string) => string; id: string; intrinsic: (name: string, args: string[]) => string; literal: (value: number | boolean, t: ShaderType) => string; localLet: (name: string, type: ShaderType, init: string) => string; localVar: (name: string, type: ShaderType, init?: string) => string; modulePreamble?: (m: ModuleDecl) => string; optimize: (lowered: ModuleDecl) => ModuleDecl; placeholderStmt: (tag: string) => string; rawStmt: (s: RawStmt) => string; switchHead: (scrut: string) => string; typeName: (t: ShaderType) => string }
src/core/backend.ts#CapProfile  type  { compute?: <no-declaration>; f16?: <no-declaration>; float32Blend?: <no-declaration>; float32Filterable?: <no-declaration>; floatRenderTarget?: <no-declaration>; msaaTextureLoad?: <no-declaration>; multiview?: <no-declaration>; storageBuffer?: <no-declaration>; subgroups?: <no-declaration> }
src/core/backend.ts#CapSupport  interface  { directive?: string; hostFeature?: string }
src/core/backend.ts#CapSupportKind  type  "native" | "directive" | "host-feature" | "unsupported"
src/core/backend.ts#Capabilities  class  { covers: (reqs: Iterable<Capability>) => boolean; has: (c: Capability) => boolean; missing: (reqs: Iterable<Capability>) => Capability[]; set: ReadonlySet<Capability> }
src/core/backend.ts#CapabilityRow  interface  { capability: Capability; declarable: boolean; support: Readonly<Record<string, CapSupportKind>> }
src/core/backend.ts#UnsupportedFeatureError  class  { cause?: unknown; code: string; hint?: string; loc?: SourceLoc; message: string; name: string; stack?: string }
src/core/backend.ts#capabilityMatrix  function  (backends: readonly Backend[]) => readonly CapabilityRow[]
src/core/backend.ts#hostFeaturesFor  function  (be: Backend, caps: readonly Capability[]) => readonly string[]
src/core/backends/glsl.ts#GlslEmitOptions  interface  { emulateCompute?: boolean; floatPrecision?: "highp" | "mediump"; fp64Flavor?: Fp64Flavor; overrideValues?: Readonly<Record<string, number | boolean>>; parens?: ParenMode; plugins?: readonly EmitPlugin[] }
src/core/backends/glsl.ts#emitGlslFragment  function  (m: ModuleDecl, stage?: "vertex" | "fragment", opts?: GlslEmitOptions & { entryPoints?: boolean; }) => EmitFragment
src/core/backends/glsl.ts#emitGlslModule  function  (m: ModuleDecl, stage?: "vertex" | "fragment", opts?: GlslEmitOptions) => string
src/core/backends/glsl.ts#emitGlslStages  function  (m: ModuleDecl, opts?: GlslEmitOptions & { vertexEntry?: string; fragmentEntry?: string; }) => { vertex: string; fragment: string; }
src/core/backends/glsl.ts#glslEs300Backend  const  Backend
src/core/backends/glsl.ts#lowerComputeToFragment  function  (m: ModuleDecl) => ModuleDecl
src/core/backends/wgsl.ts#emitBinding  const  (b: BindingDecl) => string
src/core/backends/wgsl.ts#emitConst  const  (c: ConstDecl) => string
src/core/backends/wgsl.ts#emitExpr  const  (e: Expr) => string
src/core/backends/wgsl.ts#emitFragment  const  (m: ModuleDecl, opts?: EmitOptions & { entryPoints?: boolean; }) => EmitFragment
src/core/backends/wgsl.ts#emitFunc  const  (f: FuncDecl) => string
src/core/backends/wgsl.ts#emitFuncs  function  (funcs: readonly FuncDecl[]) => string
src/core/backends/wgsl.ts#emitFuncsCsed  const  (funcs: readonly FuncDecl[]) => string
src/core/backends/wgsl.ts#emitModule  const  (m: ModuleDecl, opts?: EmitOptions) => string
src/core/backends/wgsl.ts#emitModuleAt  const  (m: ModuleDecl, level: OptLevel) => string
src/core/backends/wgsl.ts#emitStruct  const  (s: StructDecl) => string
src/core/backends/wgsl.ts#f32Lit  function  (v: number) => string
src/core/backends/wgsl.ts#intLit  function  (v: number, scalar: "i32" | "u32") => string
src/core/backends/wgsl.ts#lowerWgsl  const  (m: ModuleDecl, level: OptLevel) => ModuleDecl
src/core/backends/wgsl.ts#wgslBackend  const  Backend
src/core/backends/wgsl.ts#wgslType  function  (t: ShaderType) => string
src/core/cpu-codegen.ts#compileModuleJs  function  (m: ModuleDecl, opts?: { gpuStubs?: boolean; precision?: CpuPrecision; }) => CpuModule
src/core/cpu-runtime.ts#CpuStruct  interface  CpuStruct
src/core/cpu-runtime.ts#CpuValue  type  number | boolean | number[] | CpuStruct
src/core/cpu-runtime.ts#ORACLE_BUILTIN_NAMES  const  ReadonlySet<string>
src/core/cpu-runtime.ts#ORACLE_GPU_STUB_NAMES  const  ReadonlySet<string>
src/core/decode-log.ts#DecodedName  interface  { authored: readonly string[]; emitted: string }
src/core/decode-log.ts#decodeShaderLog  function  (log: string, renames: ReadonlyMap<string, string>) => string
src/core/decode-log.ts#invertRenames  function  (renames: ReadonlyMap<string, string>) => ReadonlyMap<string, DecodedName>
src/core/diagnostics/codes.ts#CODES  const  { readonly SD0001: { readonly code: "SD0001"; readonly summary: "matrix × vector size mismatch"; readonly hint: "a matN can only multiply a vecN of the same N"; }; readonly SD0002: { readonly code: "SD0002"; readonly summary: "binary op on mismatched vectors"; readonly hint: "both operands must be the same vector type, or one must be a scalar"; }; readonly SD0003: { readonly code: "SD0003"; readonly summary: "arithmetic op on a bool operand"; readonly hint: "bool is not a numeric type — use a comparison/logical op, or cast first"; }; readonly SD0004: { readonly code: "SD0004"; readonly summary: "binary op on incompatible types"; }; readonly SD0005: { readonly code: "SD0005"; readonly summary: "bitwise op requires a u32/i32 left operand"; readonly hint: "cast the operand with toU32()/toI32() before a bitwise op"; }; readonly SD0006: { readonly code: "SD0006"; readonly summary: "component access on a non-vector"; }; readonly SD0007: { readonly code: "SD0007"; readonly summary: "vector component out of range"; readonly hint: ".z/.w need a vec3/vec4 respectively"; }; readonly SD0008: { readonly code: "SD0008"; readonly summary: "swizzle on a non-vector"; }; readonly SD0009: { readonly code: "SD0009"; readonly summary: ".select() on a non-bool condition"; readonly hint: "the receiver of .select(a, b) must be a Node<bool>"; }; readonly SD0010: { readonly code: "SD0010"; readonly summary: "select branches have differing types"; readonly hint: "both branches of a select/ifExpr must share a type"; }; readonly SD0011: { readonly code: "SD0011"; readonly summary: "matchExpr case type does not match the default"; readonly hint: "every case value and the default must share one type"; }; readonly SD0012: { readonly code: "SD0012"; readonly summary: "statement sink not installed"; readonly hint: "import @xgis/shader-dsl from its entry, not a deep path"; }; readonly SD0013: { readonly code: "SD0013"; readonly summary: "no active builder"; readonly hint: "call Let/Var/If/Loop/… inside an fn / If / Loop body"; }; readonly SD0014: { readonly code: "SD0014"; readonly summary: "override (specialization constant) must be a WGSL scalar type"; readonly hint: "overrideConst supports bool/i32/u32/f32 only — WGSL forbids vec/matrix/array/struct overrides; decompose into per-component scalar overrides"; }; readonly SD0015: { readonly code: "SD0015"; readonly summary: "array-texture layer must be an integer"; readonly hint: "a fractional layer literal is a naga compile error in WGSL but silently rounds in GLSL (layer = floor(z + 0.5), so 1.5 reads layer 2) — the backends would diverge; pass an integer, or an i32/u32 node"; }; readonly SD0016: { readonly code: "SD0016"; readonly summary: "host-owned resource has a shape the target cannot spell"; readonly hint: "hostUniform takes a scalar/vector/matrix — a host-owned STRUCT is hostBlock, which chooses its GLSL spelling with `glsl: \"loose\" | \"std140-block\"`; a loose block flattens to one uniform per member, so its members must themselves be scalar/vector/matrix"; }; readonly SD0017: { readonly code: "SD0017"; readonly summary: "literal cannot be spelled by the target"; readonly hint: "an i32/u32 literal must be an integer inside its 32-bit range and a float literal must be finite — neither WGSL nor GLSL has a NaN/Infinity spelling, and an out-of-range integer literal is a driver compile error; clamp or wrap the host-side value before it becomes a literal (#2276)"; }; readonly SD0020: { readonly code: "SD0020"; readonly summary: "module validation failed"; }; readonly SD0030: { readonly code: "SD0030"; readonly summary: "unsupported feature for this backend"; readonly hint: "see AUTHORING.md §10 (Capabilities & extensions) for the per-backend support table; a capability the target has no capProfile row for fails closed by design"; }; readonly SD0040: { readonly code: "SD0040"; readonly summary: "f64 type leaked past fp64Lower into a backend emitter"; readonly hint: "internal invariant — the fp64 lowering pass must rewrite every f64 before emit; report a shader-dsl bug"; }; readonly SD0041: { readonly code: "SD0041"; readonly summary: "unsupported operation on f64 operands"; readonly hint: "only + - * / compare, abs, min, max, sqrt, mix, floor, fract (and on vectors dot, length, distance, normalize) are emulated — narrow explicitly with toF32(x) first"; }; readonly SD0042: { readonly code: "SD0042"; readonly summary: "conflicting fp64 guard declaration"; readonly hint: "the '_fp64' binding is reserved for the auto-injected guard texture (texture_2d<f32>) — remove the conflicting declaration, or pin the slot with fp64Guard({ group, binding })"; }; readonly SD0043: { readonly code: "SD0043"; readonly summary: "reserved fp64 name"; readonly hint: "fp64Lower injects df64_* emulation fns and DF64VecN structs under those names — rename the colliding declaration"; }; readonly SD0044: { readonly code: "SD0044"; readonly summary: "f64 in an interpolated @location IO field"; readonly hint: "interpolating hi/lo pairs is numerically wrong — narrow with toF32, or carry two f32 varyings explicitly"; }; readonly SD0107: { readonly code: "SD0107"; readonly summary: "assignment to an immutable 'let' binding"; readonly hint: "declare the binding with Var() instead of Let() to mutate it"; }; readonly SD0108: { readonly code: "SD0108"; readonly summary: "smoothstep with constant edge0 >= edge1 (undefined in GLSL ES)"; readonly hint: "write 1 − smoothstep(lo, hi, x) instead of reversing the edges"; }; readonly SD0109: { readonly code: "SD0109"; readonly summary: "a fragment-only builtin is reachable from a vertex or compute entry"; readonly hint: "the fix is per-builtin and named in the diagnostic message itself — the fragment-only-builtin rule table (FRAGMENT_ONLY_IDS) is the single fix-authority"; }; readonly SD0110: { readonly code: "SD0110"; readonly summary: "portable declared on a non-compute entry"; readonly hint: "portable is the compute-tier declaration — it needs stage: 'compute'"; }; readonly SD0111: { readonly code: "SD0111"; readonly summary: "portable kernel outside the gather-only tier"; readonly hint: "the portable tier is out[gid.x] = f(reads): 1-D gid, one u32 storage output written once at the invocation index, a vec4<u32> dispatch uniform, no raw statements — restructure or drop `portable` to keep the kernel WebGPU-only"; }; readonly SD0112: { readonly code: "SD0112"; readonly summary: "a local name is declared twice in one function"; readonly hint: "rename one of the two bindings, or omit the name (b.let(value) / b.var(type)) to take a function-unique auto name — the optimizer keys its per-function maps on the name alone, so two bindings sharing one name collapse into one (#2341)"; }; }
src/core/diagnostics/codes.ts#ErrorCode  type  "SD0001" | "SD0002" | "SD0003" | "SD0004" | "SD0005" | "SD0006" | "SD0007" | "SD0008" | "SD0009" | "SD0010" | "SD0011" | "SD0012" | "SD0013" | "SD0014" | "SD0015" | "SD0016" | "SD0017" | "SD0020" | "SD0030" | "SD0040" | "SD0041" | "SD0042" | "SD0043" | "SD0044" | "SD0107" | "SD0108" | "SD0109" | "SD0110" | "SD0111" | "SD0112"
src/core/diagnostics/codes.ts#ErrorCodeDef  interface  { code: string; hint?: string; summary: string }
src/core/diagnostics/error.ts#ShaderDslError  class  { cause?: unknown; code: string; hint?: string; loc?: SourceLoc; message: string; name: string; stack?: string }
src/core/diagnostics/error.ts#SourceLoc  interface  { col: number; file: string; line: number }
src/core/diagnostics/error.ts#dslError  function  (code: "SD0001" | "SD0002" | "SD0003" | "SD0004" | "SD0005" | "SD0006" | "SD0007" | "SD0008" | "SD0009" | "SD0010" | "SD0011" | "SD0012" | "SD0013" | "SD0014" | "SD0015" | "SD0016" | "SD0017" | "SD0020" | "SD0030" | "SD0040" | "SD0041" | "SD0042" | "SD0043" | "SD0044" | "SD0107" | "SD0108" | "SD0109" | "SD0110" | "SD0111" | "SD0112", detail?: string, opts?: { hint?: string; loc?: SourceLoc; }) => ShaderDslError
src/core/diagnostics/error.ts#formatLoc  const  (loc: SourceLoc) => string
src/core/diagnostics/loc.ts#isSourceTracing  const  () => boolean
src/core/diagnostics/loc.ts#setSourceTracing  const  (on: boolean) => void
src/core/diagnostics/report.ts#DiagnoseOptions  interface  { backend?: Backend; config?: LintConfig; rules?: "core" | "all" }
src/core/diagnostics/report.ts#DiagnosticReport  interface  { diagnostics: readonly Diagnostic[]; summary: LintSummary }
src/core/diagnostics/report.ts#diagnose  function  (m: ModuleDecl, opts?: DiagnoseOptions) => DiagnosticReport
src/core/diagnostics/report.ts#formatReport  function  (report: DiagnosticReport) => string
src/core/emit-alias.ts#aliasShaderTypes  function  (src: string, renames?: Map<string, string>) => string
src/core/emit-identity.ts#EmitIdentityInput  interface  { emulateCompute?: boolean; fp64Flavor?: Fp64Flavor; overrideValues?: Readonly<Record<string, number | boolean>>; parens?: ParenMode; plugins?: readonly EmitPlugin[] }
src/core/emit-identity.ts#EmitTarget  type  "wgsl" | "glsl-es300"
src/core/emit-identity.ts#emitIdentity  function  (target: EmitTarget, opts?: EmitIdentityInput, m?: ModuleDecl) => string
src/core/emit-minify.ts#MinifyOptions  interface  { numbers?: boolean | "f32" }
src/core/emit-minify.ts#minifyShaderText  function  (src: string, opts?: MinifyOptions) => string
src/core/emit-prune.ts#pruneRedundantPrototypes  function  (src: string) => string
src/core/emit.ts#EmitOptions  interface  { fp64Flavor?: Fp64Flavor; parens?: ParenMode; plugins?: readonly EmitPlugin[] }
src/core/emit.ts#EmitPlugin  interface  { identity?: string; name: string; transformIR?: (lowered: ModuleDecl) => ModuleDecl; transformText?: (code: string) => string }
src/core/emit.ts#emitModuleWithReflection  function  (m: ModuleDecl, be: Backend) => { code: string; reflection: Reflection; }
src/core/emit.ts#lowerForBackend  function  (m: ModuleDecl, be: Backend, level?: OptLevel, fp64Flavor?: Fp64Flavor, onStage?: StageSink) => ModuleDecl
src/core/fp64/df64-lib.ts#FP64_GUARD_NAME  const  "_fp64"
src/core/fp64/df64-lib.ts#Fp64GuardHandle  interface  { binding: BindingDecl; type: ShaderType }
src/core/fp64/df64-lib.ts#fp64Guard  function  (at: { group: number; binding: number; }) => Fp64GuardHandle
src/core/fp64/df64-lib.ts#splitF64  function  (x: number) => [hi: number, lo: number]
src/core/fp64/flavor-select.ts#Fp64FlavorSignals  interface  { adapterInfo?: { readonly vendor?: string; readonly architecture?: string; }; rendererString?: string; userAgent?: string }
src/core/fp64/flavor-select.ts#isAppleGpu  function  (s: Fp64FlavorSignals) => boolean
src/core/fp64/flavor-select.ts#recommendFp64Flavor  function  (s: Fp64FlavorSignals) => Fp64Flavor
src/core/fragment.ts#EmitFragment  interface  { declares: FragmentDeclares; preamble: readonly string[]; requires: readonly string[]; source: string }
src/core/fragment.ts#FragmentDeclares  interface  { bindings: readonly string[]; consts: readonly string[]; entryPoints: readonly string[]; functions: readonly string[]; overrides: readonly string[]; structs: readonly string[] }
src/core/intrinsics.ts#INTRINSICS  const  Readonly<Record<string, Spelling>>
src/core/intrinsics.ts#INTRINSIC_BINDING_REFS  const  Readonly<Record<string, readonly string[]>>
src/core/intrinsics.ts#INTRINSIC_HELPERS  const  Readonly<Record<string, { readonly fn: string; readonly def: string; }>>
src/core/intrinsics.ts#IntrinsicTarget  type  "wgsl" | "glsl"
src/core/intrinsics.ts#PORTABLE_INTRINSICS  const  ReadonlySet<string>
src/core/intrinsics.ts#PRE_EMIT_INTRINSICS  const  ReadonlySet<string>
src/core/intrinsics.ts#isKnownIntrinsic  const  (name: string) => boolean
src/core/intrinsics.ts#spellIntrinsic  function  (target: IntrinsicTarget, name: string, args: readonly string[]) => string
src/core/ir/builder.ts#Break  const  () => void
src/core/ir/builder.ts#Builder  class  { addAssign: <K extends string>(target: Node<K>, value: ArithArg<K>) => void; assign: <K extends string>(target: ReadonlyNode<K>, value: ReadonlyNode<K>) => void; assignOp: <K extends string>(target: ReadonlyNode<K>, bop: BinOp, value: ArithArg<K>) => void; autoName: () => string; autoNames: { n: number; }; break: () => void; child: () => Builder; continue: () => void; discard: () => void; forRange: { <K extends string>(init: ReadonlyNode<K>, cond: (i: Node<K>) => ReadonlyNode<"bool">, body: (b: Builder, i: Node<K>) => void | ReadonlyNode<string>, step?: number | ReadonlyNode<ScalarKey>): void; <K extends string>(name: string, init: ReadonlyNode<K>, cond: (i: Node<K>) => ReadonlyNode<"bool">, body: (b: Builder, i: Node<K>) => void | ReadonlyNode<string>, step?: number | ReadonlyNode<ScalarKey>): void; }; if: (cond: ReadonlyNode<"bool">, body: (b: Builder) => void | ReadonlyNode<string>) => IfChain; inferredVar: () => { ref: (type: ShaderType) => Node<string>; commit: (type: ShaderType) => void; cancel: () => void; }; let: { <K extends string>(value: ReadonlyNode<K>): ReadonlyNode<K>; <K extends string>(name: string, value: ReadonlyNode<K>): ReadonlyNode<K>; }; placeholder: (tag: string) => void; push: (s: Stmt) => void; raw: (payload: RawPayload) => void; ret: (value?: ReadonlyNode<string>) => void; stmts: Stmt[]; switch: (scrut: ReadonlyNode<"i32" | "u32">, cases: [number, (b: Builder) => void | ReadonlyNode<string>][], defaultBody?: (b: Builder) => void | ReadonlyNode<string>) => void; var: { <T extends ShaderType>(type: T, init?: ReadonlyNode<KeyOf<T>>): Node<KeyOf<T>>; <T extends ShaderType>(name: string, type: T, init?: ReadonlyNode<KeyOf<T>>): Node<KeyOf<T>>; } }
src/core/ir/builder.ts#Continue  const  () => void
src/core/ir/builder.ts#Discard  const  () => void
src/core/ir/builder.ts#ExternFn  type  { (args: { readonly [K in keyof P]: number | ReadonlyNode<KeyOf<P[K]>>; }): Node<KeyOf<R>>; (...args: NodeLike[]): Node<KeyOf<R>>; }
src/core/ir/builder.ts#ExternVarHandle  interface  { decl: ExternVarDecl; node: ReadonlyNode<K> }
src/core/ir/builder.ts#FnHandle  type  FuncDecl & { (args: { readonly [K in keyof P]: number | ReadonlyNode<KeyOf<ParamTypeOf<P[K]>>> | (P[K] extends StructParamHandle ? StructArg : never); }): Node<R>; (...args: (NodeLike | StructArg)[]): Node<R>; } & { readonly decl: FuncDecl; }
src/core/ir/builder.ts#FnParamSpec  type  { [x: string]: ShaderType | ParamAttr | StructParamHandle; }
src/core/ir/builder.ts#If  const  (cond: ReadonlyNode<"bool">, body: () => void | ReadonlyNode<string>) => IfChain
src/core/ir/builder.ts#IfChain  class  { arms: { cond: Expr; body: Stmt[]; }[]; elif: (cond: ReadonlyNode<"bool">, body: (b: Builder) => void | ReadonlyNode<string>) => IfChain; else: (body: (b: Builder) => void | ReadonlyNode<string>) => void; parent: Builder; setElse: (body: Stmt[]) => void }
src/core/ir/builder.ts#Let  function  { <K extends string>(value: ReadonlyNode<K>): ReadonlyNode<K>; <K extends string>(name: string, value: ReadonlyNode<K>): ReadonlyNode<K>; }
src/core/ir/builder.ts#Loop  function  { <K extends string>(init: ReadonlyNode<K>, cond: (i: Node<K>) => ReadonlyNode<"bool">, body: (i: Node<K>) => void | ReadonlyNode<string>, step?: number | ReadonlyNode<ScalarKey>): void; <K extends string>(name: string, init: ReadonlyNode<K>, cond: (i: Node<K>) => ReadonlyNode<"bool">, body: (i: Node<K>) => void | ReadonlyNode<string>, step?: number | ReadonlyNode<ScalarKey>): void; }
src/core/ir/builder.ts#ModuleParts  interface  { bindings?: readonly BindingDecl[]; consts?: readonly ConstDecl[]; enables?: readonly DeclarableCapability[]; externs?: readonly ExternVarDecl[]; funcs?: readonly FuncDecl[] | Readonly<Record<string, FuncDecl>>; overrides?: readonly OverrideDecl[]; structs?: readonly StructDecl[]; uses?: readonly UsesHandle[] }
src/core/ir/builder.ts#OverrideHandle  interface  { decl: OverrideDecl; node: ReadonlyNode<K> }
src/core/ir/builder.ts#ParamSpec  type  { [x: string]: ShaderType; }
src/core/ir/builder.ts#Return  const  (value?: ReadonlyNode<string>) => void
src/core/ir/builder.ts#ReturnIf  const  (cond: ReadonlyNode<"bool">, value?: ReadonlyNode<string>) => void
src/core/ir/builder.ts#Switch  function  (scrut: ReadonlyNode<"i32" | "u32">) => SwitchChain
src/core/ir/builder.ts#SwitchChain  class  { case: (value: number, body: () => void) => SwitchChain; cases: [number, () => void][]; default: (body?: () => void) => void; scrut: ReadonlyNode<"i32" | "u32"> }
src/core/ir/builder.ts#UsesHandle  type  { readonly struct: StructDecl; readonly binding: BindingDecl; } | { readonly decl: ConstDecl | StructDecl; } | { readonly binding: BindingDecl; readonly elementDecl?: StructDecl; }
src/core/ir/builder.ts#Var  function  { <K extends string>(init: ReadonlyNode<K>): Node<K>; <T extends ShaderType>(type: T, init?: ReadonlyNode<KeyOf<T>>): Node<KeyOf<T>>; <T extends ShaderType>(name: string, type: T, init?: ReadonlyNode<KeyOf<T>>): Node<KeyOf<T>>; <K extends string>(name: string, init: ReadonlyNode<K>): Node<K>; }
src/core/ir/builder.ts#condExpr  function  <K extends string>(arms: readonly (readonly [ReadonlyNode<"bool">, () => ReadonlyNode<K>])[], elseVal: () => ReadonlyNode<K>) => Node<K>
src/core/ir/builder.ts#constExpr  function  (name: string, type: ShaderType, value: Node<string>) => ConstDecl
src/core/ir/builder.ts#externFn  function  <P extends ParamSpec, R extends ShaderType>(name: string, params: P, ret: R) => ExternFn<P, R>
src/core/ir/builder.ts#externVar  function  <T extends ShaderType>(name: string, type: T, opts?: { spelling?: { wgsl?: string; glsl?: string; }; stage?: "vertex" | "fragment" | "compute"; }) => ExternVarHandle<KeyOf<T>>
src/core/ir/builder.ts#fn  function  { <P extends FnParamSpec, R extends string>(params: P, body: FnBody<P, R>, opts?: FnOpts): FnHandle<P, R>; <P extends FnParamSpec, R extends string>(name: string, params: P, body: FnBody<P, R>, opts?: FnOpts): FnHandle<P, R>; <P extends FnParamSpec, T extends ShaderType>(params: P, ret: T, body: FnBody<P, KeyOf<T>>, opts?: FnOpts): FnHandle<P, KeyOf<T>>; <P extends FnParamSpec, T extends ShaderType>(name: string, params: P, ret: T, body: FnBody<P, KeyOf<T>>, opts?: FnOpts): FnHandle<P, KeyOf<T>>; }
src/core/ir/builder.ts#ifExpr  function  <K extends string>(cond: ReadonlyNode<"bool">, thenVal: () => ReadonlyNode<K>, elseVal: () => ReadonlyNode<K>) => Node<K>
src/core/ir/builder.ts#module  function  (parts: ModuleParts) => ModuleDecl
src/core/ir/builder.ts#overrideConst  function  <T extends ShaderType>(name: string, type: T, defaultValue: number | boolean) => OverrideHandle<KeyOf<T>>
src/core/ir/builder.ts#rawStmt  function  (payload: RawPayload) => RawStmt
src/core/ir/builder.ts#reduce  function  <K extends string, J extends string>(init: ReadonlyNode<K>, loopInit: ReadonlyNode<J>, cond: (i: Node<J>) => ReadonlyNode<"bool">, body: (acc: Node<K>, i: Node<J>) => ReadonlyNode<K>, step?: number | ReadonlyNode<ScalarKey>) => Node<K>
src/core/ir/builder.ts#when  function  { <K extends string>(cond: ReadonlyNode<"bool">, thenVal: () => ReadonlyNode<K>, elseVal: () => ReadonlyNode<K>): Node<K>; <K extends string>(arms: readonly (readonly [ReadonlyNode<"bool">, () => ReadonlyNode<K>])[], elseVal: () => ReadonlyNode<K>): Node<K>; }
src/core/ir/node.ts#ArithArg  type  K extends `vec${number}<${infer E}>` ? number | ReadonlyNode<K> | ReadonlyNode<KindScalar<E>> : number | ReadonlyNode<KindScalar<K>>
src/core/ir/node.ts#CmpArg  type  number | ReadonlyNode<KindScalar<K>>
src/core/ir/node.ts#EnumU32  interface  { members: { readonly [K in keyof M]: Node<"u32">; }; values: M }
src/core/ir/node.ts#Float64Key  type  "f64" | `vec${number}<f64>`
src/core/ir/node.ts#FloatKey  type  "f32" | `vec${number}<f32>`
src/core/ir/node.ts#IntKey  type  "i32" | "u32" | `vec${number}<i32>` | `vec${number}<u32>`
src/core/ir/node.ts#NODE_BRAND  const  typeof NODE_BRAND
src/core/ir/node.ts#Node  class  { __k?: K; a: Node<ElemKey<K>>; add: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (this: ReadonlyNode<"f32">, o: ReadonlyNode<"f64">): Node<"f64">; (o: ArithArg<K>): Node<K>; }; and: (o: ReadonlyNode<"bool">) => Node<"bool">; assign: (value: ArithArg<K>) => void; at: <T extends ShaderType>(idx: number | ReadonlyNode<ScalarKey>, elem: T) => Node<KeyOf<T>>; b: Node<ElemKey<K>>; bgr: Node<`vec3<${ElemKey<K>}>`>; bgra: Node<`vec4<${ElemKey<K>}>`>; bin: (bop: BinOp, o: NodeLike) => Node<string>; bitAnd: (o: number | ReadonlyNode<K & ("i32" | "u32")>) => Node<K>; bitBin: (bop: BinOp, o: NodeLike) => Node<string>; bitOr: (o: number | ReadonlyNode<K & ("i32" | "u32")>) => Node<K>; bitXor: (o: number | ReadonlyNode<K & ("i32" | "u32")>) => Node<K>; cmp: (cop: CmpOp, o: NodeLike) => Node<"bool">; comp: (field: "x" | "y" | "z" | "w") => Node<ElemKey<K>>; div: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (this: ReadonlyNode<"f32">, o: ReadonlyNode<"f64">): Node<"f64">; (o: ArithArg<K>): Node<K>; }; eq: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; expr: Expr; g: Node<ElemKey<K>>; ge: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; gt: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; le: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; liftArg: (o: NodeLike) => ReadonlyNode<string>; logical: (lop: "&&" | "||", o: ReadonlyNode<"bool">) => Node<"bool">; lt: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; mod: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (o: ArithArg<K>): Node<K>; }; mul: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (this: ReadonlyNode<"f32">, o: ReadonlyNode<"f64">): Node<"f64">; (o: ArithArg<K>): Node<K>; }; ne: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; neg: () => Node<K>; or: (o: ReadonlyNode<"bool">) => Node<"bool">; r: Node<ElemKey<K>>; rgb: Node<`vec3<${ElemKey<K>}>`>; select: { (this: ReadonlyNode<"bool">, a: number, b: number): Node<"f32">; <R extends string>(this: ReadonlyNode<"bool">, a: number | ReadonlyNode<R>, b: number | ReadonlyNode<R>): Node<R>; }; shl: (o: number | ReadonlyNode<"u32">) => Node<K>; shr: (o: number | ReadonlyNode<"u32">) => Node<K>; sub: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (this: ReadonlyNode<"f32">, o: ReadonlyNode<"f64">): Node<"f64">; (o: ArithArg<K>): Node<K>; }; swizzle: { <S extends string>(comps: S): Node<SwizzleKey<K, S>>; <R extends string>(comps: string): Node<R>; }; type: ShaderType; w: Node<ElemKey<K>>; x: Node<ElemKey<K>>; xy: Node<`vec2<${ElemKey<K>}>`>; xyz: Node<`vec3<${ElemKey<K>}>`>; y: Node<ElemKey<K>>; yzx: Node<`vec3<${ElemKey<K>}>`>; z: Node<ElemKey<K>>; zxy: Node<`vec3<${ElemKey<K>}>`>; zyx: Node<`vec3<${ElemKey<K>}>`> }
src/core/ir/node.ts#NodeLike  type  number | ReadonlyNode<any>
src/core/ir/node.ts#NonComposite  type  K extends `vec${string}` | `mat${string}` ? never : K
src/core/ir/node.ts#ReadonlyNode  class  { __k?: K; a: Node<ElemKey<K>>; add: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (this: ReadonlyNode<"f32">, o: ReadonlyNode<"f64">): Node<"f64">; (o: ArithArg<K>): Node<K>; }; and: (o: ReadonlyNode<"bool">) => Node<"bool">; at: <T extends ShaderType>(idx: number | ReadonlyNode<ScalarKey>, elem: T) => Node<KeyOf<T>>; b: Node<ElemKey<K>>; bgr: Node<`vec3<${ElemKey<K>}>`>; bgra: Node<`vec4<${ElemKey<K>}>`>; bin: (bop: BinOp, o: NodeLike) => Node<string>; bitAnd: (o: number | ReadonlyNode<K & ("i32" | "u32")>) => Node<K>; bitBin: (bop: BinOp, o: NodeLike) => Node<string>; bitOr: (o: number | ReadonlyNode<K & ("i32" | "u32")>) => Node<K>; bitXor: (o: number | ReadonlyNode<K & ("i32" | "u32")>) => Node<K>; cmp: (cop: CmpOp, o: NodeLike) => Node<"bool">; comp: (field: "x" | "y" | "z" | "w") => Node<ElemKey<K>>; div: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (this: ReadonlyNode<"f32">, o: ReadonlyNode<"f64">): Node<"f64">; (o: ArithArg<K>): Node<K>; }; eq: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; expr: Expr; g: Node<ElemKey<K>>; ge: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; gt: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; le: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; liftArg: (o: NodeLike) => ReadonlyNode<string>; logical: (lop: "&&" | "||", o: ReadonlyNode<"bool">) => Node<"bool">; lt: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; mod: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (o: ArithArg<K>): Node<K>; }; mul: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (this: ReadonlyNode<"f32">, o: ReadonlyNode<"f64">): Node<"f64">; (o: ArithArg<K>): Node<K>; }; ne: (this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>) => Node<"bool">; neg: () => Node<K>; or: (o: ReadonlyNode<"bool">) => Node<"bool">; r: Node<ElemKey<K>>; rgb: Node<`vec3<${ElemKey<K>}>`>; select: { (this: ReadonlyNode<"bool">, a: number, b: number): Node<"f32">; <R extends string>(this: ReadonlyNode<"bool">, a: number | ReadonlyNode<R>, b: number | ReadonlyNode<R>): Node<R>; }; shl: (o: number | ReadonlyNode<"u32">) => Node<K>; shr: (o: number | ReadonlyNode<"u32">) => Node<K>; sub: { <K2 extends `vec${number}<${K}>`>(this: ReadonlyNode<NonComposite<K>>, o: ReadonlyNode<K2>): Node<K2>; (this: ReadonlyNode<"f32">, o: ReadonlyNode<"f64">): Node<"f64">; (o: ArithArg<K>): Node<K>; }; swizzle: { <S extends string>(comps: S): Node<SwizzleKey<K, S>>; <R extends string>(comps: string): Node<R>; }; type: ShaderType; w: Node<ElemKey<K>>; x: Node<ElemKey<K>>; xy: Node<`vec2<${ElemKey<K>}>`>; xyz: Node<`vec3<${ElemKey<K>}>`>; y: Node<ElemKey<K>>; yzx: Node<`vec3<${ElemKey<K>}>`>; z: Node<ElemKey<K>>; zxy: Node<`vec3<${ElemKey<K>}>`>; zyx: Node<`vec3<${ElemKey<K>}>`> }
src/core/ir/node.ts#SwizzleKey  type  StrLen<S, []> extends 1 ? ElemKey<K> : `vec${StrLen<S, []> & number}<${ElemKey<K>}>`
src/core/ir/node.ts#TexelKey  type  K extends `${string}<${infer E}>` ? `vec4<${E}>` : never
src/core/ir/node.ts#TextureLoad2dKey  type  "texture_multisampled_2d<f32>" | "texture_2d<f32>" | "texture_2d<u32>" | "texture_2d<i32>"
src/core/ir/node.ts#TextureLoadArrayKey  type  "texture_2d_array<f32>" | "texture_2d_array<u32>" | "texture_2d_array<i32>"
src/core/ir/node.ts#abs  const  <K extends FloatKey | Float64Key | IntKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#acos  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#acosh  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#arrayLit  const  (elem: ShaderType, ...items: ReadonlyNode<string>[]) => Node<string>
src/core/ir/node.ts#asin  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#asinh  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#atan  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#atan2  const  <K extends FloatKey>(y: ReadonlyNode<K>, x: NoInfer<ArithArg<K>>) => Node<K>
src/core/ir/node.ts#atanh  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#bindingRef  function  <T extends ShaderType>(name: string, type: T) => Node<KeyOf<T>>
src/core/ir/node.ts#bitcastF32  const  (v: ReadonlyNode<"u32">) => Node<"f32">
src/core/ir/node.ts#bitcastU32  const  (v: ReadonlyNode<"f32">) => Node<"u32">
src/core/ir/node.ts#bool  const  (v: boolean) => Node<"bool">
src/core/ir/node.ts#callFn  function  <T extends ShaderType>(name: string, ret: T, ...args: NodeLike[]) => Node<KeyOf<T>>
src/core/ir/node.ts#ceil  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#clamp  const  <K extends FloatKey | IntKey>(x: ReadonlyNode<K>, lo: NoInfer<ArithArg<K>>, hi: NoInfer<ArithArg<K>>) => Node<K>
src/core/ir/node.ts#constRef  function  <T extends ShaderType = { readonly kind: "scalar"; readonly scalar: "f32"; }>(name: string, type?: T) => ReadonlyNode<KeyOf<T>>
src/core/ir/node.ts#construct  const  (type: ShaderType, args: NodeLike[]) => Node<string>
src/core/ir/node.ts#cos  const  <K extends FloatKey | Float64Key>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#cosh  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#cross  const  (a: ReadonlyNode<"vec3<f32>">, b: ReadonlyNode<"vec3<f32>">) => Node<"vec3<f32>">
src/core/ir/node.ts#degrees  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#distance  function  { <K extends `vec${number}<f64>`>(a: ReadonlyNode<K>, b: NoInfer<ReadonlyNode<K>>): Node<"f64">; <K extends `vec${number}<f32>`>(a: ReadonlyNode<K>, b: NoInfer<ReadonlyNode<K>>): Node<"f32">; }
src/core/ir/node.ts#dot  function  { <K extends `vec${number}<f64>`>(a: ReadonlyNode<K>, b: NoInfer<ReadonlyNode<K>>): Node<"f64">; <K extends `vec${number}<f32>`>(a: ReadonlyNode<K>, b: NoInfer<ReadonlyNode<K>>): Node<"f32">; }
src/core/ir/node.ts#dpdx  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#dpdy  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#enumU32  function  <const M extends Record<string, number>>(values: M) => EnumU32<M>
src/core/ir/node.ts#exp  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#exp2  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#externRef  function  <T extends ShaderType>(name: string, type: T) => ReadonlyNode<KeyOf<T>>
src/core/ir/node.ts#f32  const  (v: number) => Node<"f32">
src/core/ir/node.ts#f64  const  (v: number) => Node<"f64">
src/core/ir/node.ts#f64FromParts  const  (hi: number | ReadonlyNode<"f32">, lo: number | ReadonlyNode<"f32">) => Node<"f64">
src/core/ir/node.ts#f64GuardOne  const  () => Node<"f32">
src/core/ir/node.ts#f64Parts  const  (x: ReadonlyNode<"f64">) => Node<"vec2<f32>">
src/core/ir/node.ts#floor  const  <K extends FloatKey | Float64Key>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#fma  const  <K extends FloatKey>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>, c: NoInfer<ArithArg<K>>) => Node<K>
src/core/ir/node.ts#fract  const  <K extends FloatKey | Float64Key>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#fwidth  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#i32  const  (v: number) => Node<"i32">
src/core/ir/node.ts#insideRange  const  (x: ReadonlyNode<ScalarKey>, lo: number | ReadonlyNode<ScalarKey>, hi: number | ReadonlyNode<ScalarKey>) => Node<"bool">
src/core/ir/node.ts#installStmtSink  const  (s: StmtSink) => void
src/core/ir/node.ts#inverseSqrt  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#isNodeValue  const  (v: unknown) => v is ReadonlyNode<string>
src/core/ir/node.ts#length  function  { <K extends `vec${number}<f64>`>(v: ReadonlyNode<K>): Node<"f64">; <K extends `vec${number}<f32>`>(v: ReadonlyNode<K>): Node<"f32">; }
src/core/ir/node.ts#lift  function  (x: NodeLike) => ReadonlyNode<string>
src/core/ir/node.ts#log  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#log2  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#madd  const  <K extends string>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>, c: NoInfer<ArithArg<K>>) => Node<K>
src/core/ir/node.ts#mat2f64  const  (cols_0: Mat64Col<2>, cols_1: Mat64Col<2>) => Node<"mat2x2<f64>">
src/core/ir/node.ts#mat3f64  const  (cols_0: Mat64Col<3>, cols_1: Mat64Col<3>, cols_2: Mat64Col<3>) => Node<"mat3x3<f64>">
src/core/ir/node.ts#mat4f64  const  (cols_0: Mat64Col<4>, cols_1: Mat64Col<4>, cols_2: Mat64Col<4>, cols_3: Mat64Col<4>) => Node<"mat4x4<f64>">
src/core/ir/node.ts#matchEnum  function  <M extends Record<string, number>, R extends string>(scrutinee: ReadonlyNode<ScalarKey>, e: EnumU32<M>, arms: { readonly [K in keyof M]: () => ReadonlyNode<R>; }) => Node<R>
src/core/ir/node.ts#matchExpr  function  <S extends ScalarKey, R extends string>(scrutinee: ReadonlyNode<S>, cases: readonly (readonly [caseValue: number, value: ReadonlyNode<R> | (() => ReadonlyNode<R>)])[], default_: ReadonlyNode<R> | (() => ReadonlyNode<R>)) => Node<R>
src/core/ir/node.ts#max  const  <K extends FloatKey | Float64Key | IntKey>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>) => Node<K>
src/core/ir/node.ts#member  const  <T extends ShaderType>(base: ReadonlyNode<string>, name: string, type: T) => Node<KeyOf<T>>
src/core/ir/node.ts#min  const  <K extends FloatKey | Float64Key | IntKey>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>) => Node<K>
src/core/ir/node.ts#mix  const  <K extends FloatKey | Float64Key>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>, t: number | ReadonlyNode<"f32">) => Node<K>
src/core/ir/node.ts#mod  const  <K extends FloatKey>(x: ReadonlyNode<K>, y: NoInfer<ArithArg<K>>) => Node<K>
src/core/ir/node.ts#mulMat64  const  <N extends 2 | 3 | 4>(a: ReadonlyNode<`mat${N}x${N}<f64>`>, b: ReadonlyNode<`mat${N}x${N}<f64>`>) => Node<`mat${N}x${N}<f64>`>
src/core/ir/node.ts#normalize  const  <K extends `vec${number}<f32>` | `vec${number}<f64>`>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#optBarrier  const  (v: number | ReadonlyNode<"f32">) => Node<"f32">
src/core/ir/node.ts#outsideRange  const  (x: ReadonlyNode<ScalarKey>, lo: number | ReadonlyNode<ScalarKey>, hi: number | ReadonlyNode<ScalarKey>) => Node<"bool">
src/core/ir/node.ts#overrideRef  function  <T extends ShaderType>(name: string, type: T) => ReadonlyNode<KeyOf<T>>
src/core/ir/node.ts#pack2x16float  const  (v: ReadonlyNode<"vec2<f32>">) => Node<"u32">
src/core/ir/node.ts#pack2x16snorm  const  (v: ReadonlyNode<"vec2<f32>">) => Node<"u32">
src/core/ir/node.ts#pack2x16unorm  const  (v: ReadonlyNode<"vec2<f32>">) => Node<"u32">
src/core/ir/node.ts#pack4x8unorm  const  (v: ReadonlyNode<"vec4<f32>">) => Node<"u32">
src/core/ir/node.ts#param  function  <T extends ShaderType>(name: string, type: T) => ReadonlyNode<KeyOf<T>>
src/core/ir/node.ts#pow  const  <K extends FloatKey>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>) => Node<K>
src/core/ir/node.ts#radians  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#round  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#saturate  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#select  function  { (cond: ReadonlyNode<"bool">, ifTrue: number, ifFalse: number): Node<"f32">; <R extends string>(cond: ReadonlyNode<"bool">, ifTrue: number | ReadonlyNode<R>, ifFalse: number | ReadonlyNode<R>): Node<R>; }
src/core/ir/node.ts#sign  const  <K extends "i32" | FloatKey | `vec${number}<i32>`>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#sin  const  <K extends FloatKey | Float64Key>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#sinh  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#smoothstep  function  { <K extends `vec${number}<f32>`>(e0: ReadonlyNode<K>, e1: ReadonlyNode<K>, x: ReadonlyNode<K>): Node<K>; (e0: number | ReadonlyNode<"f32">, e1: number | ReadonlyNode<"f32">, x: number | ReadonlyNode<"f32">): Node<"f32">; }
src/core/ir/node.ts#sqrt  const  <K extends "f64" | FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#step  const  <K extends FloatKey>(edge: NoInfer<ArithArg<K>>, x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#tan  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#tanh  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#textureDimensions  const  (tex: ReadonlyNode<TextureLoad2dKey | TextureLoadArrayKey>) => Node<"vec2<u32>">
src/core/ir/node.ts#textureLoad  function  { <K extends TextureLoad2dKey>(tex: ReadonlyNode<K>, coord: NodeLike, level: NodeLike): Node<TexelKey<K>>; <K extends TextureLoadArrayKey>(tex: ReadonlyNode<K>, coord: NodeLike, layer: number | ReadonlyNode<"i32" | "u32">, level: NodeLike): Node<TexelKey<K>>; }
src/core/ir/node.ts#textureNumLayers  const  (tex: ReadonlyNode<TextureLoadArrayKey>) => Node<"u32">
src/core/ir/node.ts#textureSample  function  { (tex: ReadonlyNode<"texture_2d<f32>">, smp: ReadonlyNode<"sampler">, uv: ReadonlyNode<"vec2<f32>">): Node<"vec4<f32>">; (tex: ReadonlyNode<"texture_2d_array<f32>">, smp: ReadonlyNode<"sampler">, uv: ReadonlyNode<"vec2<f32>">, layer: number | ReadonlyNode<"i32" | "u32">): Node<"vec4<f32>">; }
src/core/ir/node.ts#textureSampleLevel  function  { (tex: ReadonlyNode<"texture_2d<f32>">, smp: ReadonlyNode<"sampler">, uv: ReadonlyNode<"vec2<f32>">, level: number | ReadonlyNode<"f32">): Node<"vec4<f32>">; (tex: ReadonlyNode<"texture_2d_array<f32>">, smp: ReadonlyNode<"sampler">, uv: ReadonlyNode<"vec2<f32>">, layer: number | ReadonlyNode<"i32" | "u32">, level: number | ReadonlyNode<"f32">): Node<"vec4<f32>">; }
src/core/ir/node.ts#toF32  const  (x: number | ReadonlyNode<string>) => Node<"f32">
src/core/ir/node.ts#toF64  const  (x: number | ReadonlyNode<"f32">) => Node<"f64">
src/core/ir/node.ts#toI32  const  (x: number | ReadonlyNode<string>) => Node<"i32">
src/core/ir/node.ts#toU32  const  (x: number | ReadonlyNode<string>) => Node<"u32">
src/core/ir/node.ts#transformMat4  const  (m: ReadonlyNode<"mat4x4<f32>">, v: ReadonlyNode<"vec4<f32>">) => Node<"vec4<f32>">
src/core/ir/node.ts#transformMat64  const  <N extends 2 | 3 | 4>(m: ReadonlyNode<`mat${N}x${N}<f64>`>, v: ReadonlyNode<`vec${N}<f64>`>) => Node<`vec${N}<f64>`>
src/core/ir/node.ts#transpose64  const  <N extends 2 | 3 | 4>(m: ReadonlyNode<`mat${N}x${N}<f64>`>) => Node<`mat${N}x${N}<f64>`>
src/core/ir/node.ts#trunc  const  <K extends FloatKey>(x: ReadonlyNode<K>) => Node<K>
src/core/ir/node.ts#u32  const  (v: number) => Node<"u32">
src/core/ir/node.ts#unpack2x16float  const  (v: ReadonlyNode<"u32">) => Node<"vec2<f32>">
src/core/ir/node.ts#unpack2x16snorm  const  (v: ReadonlyNode<"u32">) => Node<"vec2<f32>">
src/core/ir/node.ts#unpack2x16unorm  const  (v: ReadonlyNode<"u32">) => Node<"vec2<f32>">
src/core/ir/node.ts#unpack4x8unorm  const  (v: ReadonlyNode<"u32">) => Node<"vec4<f32>">
src/core/ir/node.ts#vec2  const  (...a: NodeLike[]) => Node<"vec2<f32>">
src/core/ir/node.ts#vec2f64  const  (...a: Vec64Arg[]) => Node<"vec2<f64>">
src/core/ir/node.ts#vec2i  const  (...a: NodeLike[]) => Node<"vec2<i32>">
src/core/ir/node.ts#vec2u  const  (...a: NodeLike[]) => Node<"vec2<u32>">
src/core/ir/node.ts#vec3  const  (...a: NodeLike[]) => Node<"vec3<f32>">
src/core/ir/node.ts#vec3f64  const  (...a: Vec64Arg[]) => Node<"vec3<f64>">
src/core/ir/node.ts#vec4  const  (...a: NodeLike[]) => Node<"vec4<f32>">
src/core/ir/node.ts#vec4f64  const  (...a: Vec64Arg[]) => Node<"vec4<f64>">
src/core/ir/nodes.ts#ALL_CAPABILITIES  const  readonly ["storageBuffer", "compute", "msaaTextureLoad", "f16", "subgroups", "floatRenderTarget", "float32Blend", "float32Filterable", "multiview"]
src/core/ir/nodes.ts#ASSEMBLED_AS  const  typeof ASSEMBLED_AS
src/core/ir/nodes.ts#AddressSpace  type  "uniform" | "storage"
src/core/ir/nodes.ts#BinOp  type  "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>"
src/core/ir/nodes.ts#BindingDecl  interface  { access?: "read" | "read_write"; binding: number; glsl?: "std140-block" | "loose"; group: number; name: string; owner?: "module" | "host"; precision?: "highp" | "mediump" | "lowp"; space: AddressSpace; type: ShaderType }
src/core/ir/nodes.ts#Capability  type  "compute" | "storageBuffer" | "msaaTextureLoad" | "f16" | "subgroups" | "floatRenderTarget" | "float32Blend" | "float32Filterable" | "multiview"
src/core/ir/nodes.ts#CmpOp  type  "<" | ">" | "<=" | ">=" | "==" | "!="
src/core/ir/nodes.ts#ConstDecl  interface  { cpuValue: number; name: string; type: ShaderType; valueExpr?: Expr; wgslValue: number }
src/core/ir/nodes.ts#DeclarableCapability  type  "f16" | "subgroups" | "floatRenderTarget" | "float32Blend" | "float32Filterable" | "multiview"
src/core/ir/nodes.ts#EntryParam  interface  { builtin?: string; location?: number; name: string; type: ShaderType }
src/core/ir/nodes.ts#Expr  type  { readonly op: "lit"; readonly type: ShaderType; readonly value: number | boolean; } | { readonly op: "constref"; readonly type: ShaderType; readonly name: string; } | { readonly op: "overrideref"; readonly type: ShaderType; readonly name: string; } | { readonly op: "externref"; readonly type: ShaderType; readonly name: string; } | { readonly op: "param"; readonly type: ShaderType; readonly name: string; } | { readonly op: "varref"; readonly type: ShaderType; readonly name: string; } | { readonly op: "binop"; readonly type: ShaderType; readonly bop: BinOp; readonly a: Expr; readonly b: Expr; } | { readonly op: "unop"; readonly type: ShaderType; readonly a: Expr; } | { readonly op: "compare"; readonly type: ShaderType; readonly cop: CmpOp; readonly a: Expr; readonly b: Expr; } | { readonly op: "logical"; readonly type: ShaderType; readonly lop: LogOp; readonly a: Expr; readonly b: Expr; } | { readonly op: "call"; readonly type: ShaderType; readonly fn: string; readonly args: readonly Expr[]; readonly declRef?: FuncDecl; } | { readonly op: "member"; readonly type: ShaderType; readonly base: Expr; readonly field: string; } | { readonly op: "construct"; readonly type: ShaderType; readonly args: readonly Expr[]; } | { readonly op: "select"; readonly type: ShaderType; readonly cond: Expr; readonly ifTrue: Expr; readonly ifFalse: Expr; } | { readonly op: "index"; readonly type: ShaderType; readonly base: Expr; readonly idx: Expr; } | { readonly op: "matchExpr"; readonly type: ShaderType; readonly scrutinee: Expr; readonly cases: readonly (readonly [number, Expr])[]; readonly default: Expr; }
src/core/ir/nodes.ts#ExternVarDecl  interface  { name: string; spelling?: { readonly wgsl?: string; readonly glsl?: string; }; stage?: "vertex" | "fragment" | "compute"; type: ShaderType }
src/core/ir/nodes.ts#FuncDecl  interface  { [ASSEMBLED_AS]?: string; allowEarlyReturn?: boolean; attrs?: readonly string[]; body: readonly Stmt[]; lintDisable?: readonly string[]; name: string; opaque?: boolean; params: readonly { name: string; type: ShaderType; builtin?: string; location?: number; interpolate?: string; attr?: string; }[]; portable?: boolean; ret: ShaderType; retAttr?: string; retBuiltin?: string; stage?: "vertex" | "fragment" | "compute"; workgroupSize?: number }
src/core/ir/nodes.ts#LogOp  type  "&&" | "||"
src/core/ir/nodes.ts#ModuleDecl  interface  { bindings: readonly BindingDecl[]; consts: readonly ConstDecl[]; enables?: readonly DeclarableCapability[]; externs?: readonly ExternVarDecl[]; funcs: readonly FuncDecl[]; overrides?: readonly OverrideDecl[]; structs: readonly StructDecl[] }
src/core/ir/nodes.ts#OverrideDecl  interface  { default: number | boolean; name: string; type: ShaderType }
src/core/ir/nodes.ts#RawPayload  type  { readonly wgsl: string; readonly glsl?: string; } | { readonly wgsl?: string; readonly glsl: string; }
src/core/ir/nodes.ts#RawStmt  type  { readonly s: "raw"; readonly wgsl: string; readonly glsl?: string; } | { readonly s: "raw"; readonly wgsl?: string; readonly glsl: string; }
src/core/ir/nodes.ts#Stmt  type  { readonly s: "let"; readonly name: string; readonly expr: Expr; } | { readonly s: "var"; readonly name: string; readonly type: ShaderType; readonly init?: Expr; } | { readonly s: "assign"; readonly target: Expr; readonly expr: Expr; } | { readonly s: "assignOp"; readonly target: Expr; readonly bop: BinOp; readonly expr: Expr; } | { readonly s: "if"; readonly arms: readonly { readonly cond: Expr; readonly body: readonly Stmt[]; }[]; readonly elseBody?: readonly Stmt[]; } | { readonly s: "return"; readonly expr?: Expr; } | { readonly s: "for"; readonly init: Stmt; readonly cond: Expr; readonly update: Stmt; readonly body: readonly Stmt[]; } | { readonly s: "switch"; readonly scrut: Expr; readonly cases: readonly { readonly value: number; readonly body: readonly Stmt[]; }[]; readonly defaultBody?: readonly Stmt[]; } | { readonly s: "break"; } | { readonly s: "continue"; } | { readonly s: "discard"; } | { readonly s: "placeholder"; readonly tag: string; } | { readonly s: "raw"; readonly wgsl: string; readonly glsl?: string; } | { readonly s: "raw"; readonly wgsl?: string; readonly glsl: string; }
src/core/ir/nodes.ts#StructDecl  interface  { fields: readonly StructField[]; name: string }
src/core/ir/nodes.ts#StructField  interface  { attr?: string; builtin?: string; interpolate?: string; location?: number; name: string; type: ShaderType }
src/core/ir/nodes.ts#stageOf  const  (f: Pick<FuncDecl, "stage" | "attrs">) => "vertex" | "fragment" | "compute"
src/core/ir/nodes.ts#workgroupSizeOf  const  (f: Pick<FuncDecl, "attrs" | "workgroupSize">) => number
src/core/ir/types.ts#ElemKey  type  K extends `vec${number}<${infer E}>` ? E : K
src/core/ir/types.ts#KeyOf  type  T extends { kind: "scalar"; scalar: infer S extends string; } ? S : T extends { kind: "f64"; } ? "f64" : T extends { kind: "vec64"; n: infer N extends number; } ? `vec${N}<f64>` : T extends { kind: "vec"; n: infer N extends number; elem: infer E extends string; } ? `vec${N}<${E}>` : T extends { kind: "mat"; n: infer N extends number; elem: infer E extends string; } ? `mat${N}x${N}<${E}>` : T extends { kind: "texture"; dim: "2d-ms"; } ? "texture_multisampled_2d<f32>" : T extends { kind: "texture"; dim: "2d-array"; elem: infer E extends string; } ? `texture_2d_array<${E}>` : T extends { kind: "texture"; dim: "2d"; elem: infer E extends string; } ? `texture_2d<${E}>` : T extends { kind: "sampler"; } ? "sampler" : string
src/core/ir/types.ts#Scalar  type  "f32" | "i32" | "u32" | "bool"
src/core/ir/types.ts#ScalarKey  type  "f32" | "i32" | "u32"
src/core/ir/types.ts#ShaderType  type  { readonly kind: "scalar"; readonly scalar: Scalar; } | { readonly kind: "f64"; } | { readonly kind: "vec64"; readonly n: 2 | 3 | 4; } | { readonly kind: "vec"; readonly n: 2 | 3 | 4; readonly elem: "f32" | "i32" | "u32"; } | { readonly kind: "mat"; readonly n: 2 | 3 | 4; readonly elem: "f64" | "f32"; } | { readonly kind: "struct"; readonly name: string; } | { readonly kind: "array"; readonly elem: ShaderType; readonly size?: number; } | { readonly kind: "texture"; readonly dim: "2d" | "2d-array"; readonly elem: TextureElem; } | { readonly kind: "texture"; readonly dim: "2d-ms"; readonly elem: "f32"; } | { readonly kind: "sampler"; } | { readonly kind: "void"; }
src/core/ir/types.ts#TextureElem  type  "f32" | "i32" | "u32"
src/core/ir/types.ts#arrayT  const  (elem: ShaderType, size?: number) => ShaderType
src/core/ir/types.ts#boolT  const  { readonly kind: "scalar"; readonly scalar: "bool"; }
src/core/ir/types.ts#f32T  const  { readonly kind: "scalar"; readonly scalar: "f32"; }
src/core/ir/types.ts#f64T  const  { readonly kind: "f64"; }
src/core/ir/types.ts#i32T  const  { readonly kind: "scalar"; readonly scalar: "i32"; }
src/core/ir/types.ts#isF64  const  (t: ShaderType) => t is { readonly kind: "f64"; }
src/core/ir/types.ts#isMat  const  (t: ShaderType) => t is { readonly kind: "mat"; readonly n: 2 | 3 | 4; readonly elem: "f64" | "f32"; }
src/core/ir/types.ts#isMat64  const  (t: ShaderType) => t is { readonly kind: "mat"; readonly n: 2 | 3 | 4; readonly elem: "f64" | "f32"; } & { elem: "f64"; }
src/core/ir/types.ts#isScalar  const  (t: ShaderType) => t is { readonly kind: "scalar"; readonly scalar: Scalar; }
src/core/ir/types.ts#isVec  const  (t: ShaderType) => t is { readonly kind: "vec"; readonly n: 2 | 3 | 4; readonly elem: "f32" | "i32" | "u32"; }
src/core/ir/types.ts#isVec64  const  (t: ShaderType) => t is { readonly kind: "vec64"; readonly n: 2 | 3 | 4; }
src/core/ir/types.ts#mat2f64T  const  { readonly kind: "mat"; readonly n: 2; readonly elem: "f64"; }
src/core/ir/types.ts#mat3f64T  const  { readonly kind: "mat"; readonly n: 3; readonly elem: "f64"; }
src/core/ir/types.ts#mat4f64T  const  { readonly kind: "mat"; readonly n: 4; readonly elem: "f64"; }
src/core/ir/types.ts#mat4x4fT  const  { readonly kind: "mat"; readonly n: 4; readonly elem: "f32"; }
src/core/ir/types.ts#samplerT  const  { readonly kind: "sampler"; }
src/core/ir/types.ts#structT  const  (name: string) => ShaderType
src/core/ir/types.ts#texture2dArrayfT  const  { readonly kind: "texture"; readonly dim: "2d-array"; readonly elem: "f32"; }
src/core/ir/types.ts#texture2dArrayiT  const  { readonly kind: "texture"; readonly dim: "2d-array"; readonly elem: "i32"; }
src/core/ir/types.ts#texture2dArrayuT  const  { readonly kind: "texture"; readonly dim: "2d-array"; readonly elem: "u32"; }
src/core/ir/types.ts#texture2dMsfT  const  { readonly kind: "texture"; readonly dim: "2d-ms"; readonly elem: "f32"; }
src/core/ir/types.ts#texture2dfT  const  { readonly kind: "texture"; readonly dim: "2d"; readonly elem: "f32"; }
src/core/ir/types.ts#texture2diT  const  { readonly kind: "texture"; readonly dim: "2d"; readonly elem: "i32"; }
src/core/ir/types.ts#texture2duT  const  { readonly kind: "texture"; readonly dim: "2d"; readonly elem: "u32"; }
src/core/ir/types.ts#typeEq  function  (a: ShaderType, b: ShaderType) => boolean
src/core/ir/types.ts#typeKey  function  (t: ShaderType) => string
src/core/ir/types.ts#u32T  const  { readonly kind: "scalar"; readonly scalar: "u32"; }
src/core/ir/types.ts#vec2f64T  const  { readonly kind: "vec64"; readonly n: 2; }
src/core/ir/types.ts#vec2fT  const  { readonly kind: "vec"; readonly n: 2; readonly elem: "f32"; }
src/core/ir/types.ts#vec2iT  const  { readonly kind: "vec"; readonly n: 2; readonly elem: "i32"; }
src/core/ir/types.ts#vec2uT  const  { readonly kind: "vec"; readonly n: 2; readonly elem: "u32"; }
src/core/ir/types.ts#vec3f64T  const  { readonly kind: "vec64"; readonly n: 3; }
src/core/ir/types.ts#vec3fT  const  { readonly kind: "vec"; readonly n: 3; readonly elem: "f32"; }
src/core/ir/types.ts#vec3uT  const  { readonly kind: "vec"; readonly n: 3; readonly elem: "u32"; }
src/core/ir/types.ts#vec4f64T  const  { readonly kind: "vec64"; readonly n: 4; }
src/core/ir/types.ts#vec4fT  const  { readonly kind: "vec"; readonly n: 4; readonly elem: "f32"; }
src/core/ir/types.ts#vec4iT  const  { readonly kind: "vec"; readonly n: 4; readonly elem: "i32"; }
src/core/ir/types.ts#vec4uT  const  { readonly kind: "vec"; readonly n: 4; readonly elem: "u32"; }
src/core/ir/types.ts#voidT  const  { readonly kind: "void"; }
src/core/measure.ts#EmitProfile  interface  { passes: readonly PassTiming[]; stages: readonly StageTiming[]; target: "wgsl" | "glsl-es300"; totalMs: number }
src/core/measure.ts#EmitSize  interface  { chars: number; lines: number }
src/core/measure.ts#OpCount  interface  { arith: number; calls: number; total: number }
src/core/measure.ts#OptimizerReport  interface  { ops: { readonly o0: OpCount; readonly o2: OpCount; readonly savedCalls: number; readonly savedArith: number; }; size: { readonly o0: EmitSize; readonly o2: EmitSize; readonly savedChars: number; readonly savedLines: number; } }
src/core/measure.ts#PassTiming  interface  { ms: number; pass: string; runs: number }
src/core/measure.ts#StageTiming  interface  { ms: number; stage: string }
src/core/measure.ts#countOps  function  (m: ModuleDecl) => OpCount
src/core/measure.ts#emitSize  function  (code: string) => EmitSize
src/core/measure.ts#optimizerReport  function  (m: ModuleDecl) => OptimizerReport
src/core/measure.ts#profileEmit  function  (m: ModuleDecl, target?: "wgsl" | "glsl-es300") => EmitProfile
src/core/oracle.ts#CpuModule  interface  { fns: Record<string, (...args: CpuValue[]) => CpuValue>; setBinding: (name: string, value: CpuValue) => void }
src/core/oracle.ts#CpuPrecision  type  "f64" | "f32"
src/core/oracle.ts#compileModule  function  (m: ModuleDecl, opts?: { gpuStubs?: boolean; precision?: CpuPrecision; }) => CpuModule
src/core/passes/compose.ts#ComposeOptions  interface  { allowUnswapped?: boolean }
src/core/passes/compose.ts#composeModule  function  (m: ModuleDecl, swaps: Record<string, readonly Stmt[]>, opts?: ComposeOptions) => ModuleDecl
src/core/passes/force-inline.ts#InlineDecision  interface  { callSites: number; fn: string; growth: number; inlined: boolean; ops: number; reason: "inlined" | "over-budget" | "not-inlinable" }
src/core/passes/force-inline.ts#InlineOpaque  type  "all" | "keep" | "single-call"
src/core/passes/fp64-lower.ts#Fp64Flavor  type  "float" | "integer"
src/core/passes/fp64-lower.ts#Fp64LowerOptions  interface  { flavor?: Fp64Flavor }
src/core/passes/fp64-lower.ts#fp64Lower  function  (m: ModuleDecl, opts?: Fp64LowerOptions) => ModuleDecl
src/core/passes/lint/engine.ts#Diagnostic  interface  { code?: string; fn?: string; hint?: string; loc?: SourceLoc; message: string; ruleId: string; severity: "error" | "warning" }
src/core/passes/lint/engine.ts#LintConfig  interface  { options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>; severity?: Readonly<Record<string, Severity>> }
src/core/passes/lint/engine.ts#LintSummary  interface  { byRule: Readonly<Record<string, number>>; errors: number; total: number; warnings: number }
src/core/passes/lint/engine.ts#Severity  type  "error" | "warning" | "off"
src/core/passes/lint/engine.ts#formatDiagnostics  function  (diags: readonly Diagnostic[]) => string
src/core/passes/lint/engine.ts#summarize  function  (diags: readonly Diagnostic[]) => LintSummary
src/core/passes/mangle.ts#MangleResult  interface  { module: ModuleDecl; renames: ReadonlyMap<string, string> }
src/core/passes/mangle.ts#mangleModule  function  (m: ModuleDecl) => MangleResult
src/core/passes/match-lower.ts#lowerModule  function  (m: ModuleDecl) => ModuleDecl
src/core/passes/opt/auto-vars.ts#autoVars  function  (m: ModuleDecl) => ModuleDecl
src/core/passes/opt/const-fold.ts#constFold  function  (m: ModuleDecl) => ModuleDecl
src/core/passes/opt/cse.ts#cse  function  (m: ModuleDecl) => ModuleDecl
src/core/passes/opt/optimize.ts#DEFAULT_PASSES  const  readonly OptPass[]
src/core/passes/opt/optimize.ts#OptLevel  type  "O0" | "O1" | "O2"
src/core/passes/opt/optimize.ts#fixpoint  function  (m: ModuleDecl, passes?: readonly OptPass[], maxIters?: number, onPass?: PassSink) => ModuleDecl
src/core/passes/opt/optimize.ts#optimize  function  (m: ModuleDecl, passes?: readonly OptPass[], onPass?: PassSink) => ModuleDecl
src/core/passes/rename-varrefs.ts#renameVarrefsInFunc  function  (f: FuncDecl, rename: (name: string) => string) => FuncDecl
src/core/passes/rename-varrefs.ts#rewriteExprsInFunc  function  (f: FuncDecl, rewrite: (e: Expr) => Expr) => FuncDecl
src/core/passes/required-caps.ts#assertCaps  function  (backend: Backend, m: ModuleDecl) => void
src/core/passes/required-caps.ts#requiredCaps  function  (m: ModuleDecl) => Capability[]
src/core/passes/single-exit.ts#checkSingleExit  function  (f: FuncDecl) => string[]
src/core/passes/validate.ts#ValidationError  class  { cause?: unknown; code: string; diagnostics: readonly Diagnostic[]; hint?: string; loc?: SourceLoc; message: string; name: string; stack?: string }
src/core/passes/validate.ts#lintModule  function  (m: ModuleDecl, config?: LintConfig) => Diagnostic[]
src/core/passes/validate.ts#validate  function  (m: ModuleDecl) => void
src/core/reflect.ts#BindEntry  interface  { access?: "read" | "read_write"; binding: number; glslSpelling?: "std140-block" | "loose"; group: number; name: string; owner: "module" | "host"; resourceKind: ResourceKind; space: AddressSpace; stages: readonly ("vertex" | "fragment" | "compute")[]; structName?: string; textureDim?: "2d" | "2d-array" | "2d-ms"; textureElem?: TextureElem }
src/core/reflect.ts#BindGroup  interface  { entries: readonly BindEntry[]; group: number }
src/core/reflect.ts#EntryInfo  interface  { inputs: readonly string[]; io: EntryIo; name: string; output: string; portable?: true; stage: "vertex" | "fragment" | "compute"; workgroupSize?: number }
src/core/reflect.ts#EntryIo  interface  { inputs: readonly EntryIoField[]; outputs: readonly EntryIoField[] }
src/core/reflect.ts#EntryIoField  interface  { builtin?: string; location?: number; name: string; type: string }
src/core/reflect.ts#ExternRequirement  interface  { glsl: string; name: string; stage?: "vertex" | "fragment" | "compute"; type: string; wgsl: string }
src/core/reflect.ts#FieldLayout  interface  { align: number; name: string; offset: number; size: number; type: string }
src/core/reflect.ts#LayoutKind  type  "std140" | "std430"
src/core/reflect.ts#OverrideInfo  interface  { default: number | boolean; name: string; type: string }
src/core/reflect.ts#ReflectOptions  interface  { fp64Flavor?: Fp64Flavor }
src/core/reflect.ts#Reflection  interface  { bindGroups: readonly BindGroup[]; entries: readonly EntryInfo[]; overrides: readonly OverrideInfo[]; requiredFeatures: readonly Capability[]; requires: readonly ExternRequirement[]; storage: readonly StructLayout[]; uniforms: readonly StructLayout[]; vertex?: VertexLayout }
src/core/reflect.ts#ResourceKind  type  "texture" | "sampler" | "uniform-buffer" | "storage-buffer"
src/core/reflect.ts#StructLayout  interface  { align: number; fields: readonly FieldLayout[]; name: string; size: number }
src/core/reflect.ts#VertexAttr  interface  { location: number; name: string; offset: number; type: string }
src/core/reflect.ts#VertexLayout  interface  { arrayStride: number; attributes: readonly VertexAttr[] }
src/core/reflect.ts#reflect  function  (m: ModuleDecl, opts?: ReflectOptions) => Reflection
src/core/reflect.ts#wgslLayout  function  (struct: StructDecl, layout: LayoutKind, structs?: ReadonlyMap<string, StructDecl>) => StructLayout
src/core/registry.ts#BuildRegistryOptions  interface  { imports?: readonly string[]; order?: readonly string[]; recordName?: string; regenerateWith?: string; stamp?: string; typeName?: string; valueType?: string }
src/core/registry.ts#BuiltRegistry  interface  { ids: readonly string[]; source: string }
src/core/registry.ts#RegistryEntry  interface  { exportName: string; id: string; importPath: string }
src/core/registry.ts#buildRegistry  function  (entries: readonly RegistryEntry[], opts?: BuildRegistryOptions) => BuiltRegistry
src/core/semantic-diff.ts#ClassifiedSemanticDiff  interface  { constants: readonly string[]; controlFlow: readonly string[]; explained: readonly ExplainedDiffEntry[]; interface: readonly string[]; resources: readonly string[] }
src/core/semantic-diff.ts#ExplainedDiffEntry  interface  { bucket: keyof SemanticDiff; line: string; transform: string }
src/core/semantic-diff.ts#SemanticAspect  type  "names" | "declOrder"
src/core/semantic-diff.ts#SemanticDiff  interface  { constants: readonly string[]; controlFlow: readonly string[]; interface: readonly string[]; resources: readonly string[] }
src/core/semantic-diff.ts#SemanticDiffBucket  type  keyof SemanticDiff
src/core/semantic-diff.ts#SemanticDiffOptions  interface  { ignore?: readonly SemanticAspect[]; transforms?: readonly EmitPlugin[] }
src/core/semantic-diff.ts#isSemanticallyEqual  const  (d: SemanticDiff) => boolean
src/core/semantic-diff.ts#semanticDiff  function  { (a: ModuleDecl, b: ModuleDecl, opts: SemanticDiffOptions & { readonly transforms: readonly EmitPlugin[]; }): ClassifiedSemanticDiff; (a: ModuleDecl, b: ModuleDecl, opts?: SemanticDiffOptions): SemanticDiff; }
src/core/sot.ts#ConstHandle  interface  { decl: ConstDecl; node: ReadonlyNode<KeyOf<T>> }
src/core/sot.ts#FieldSpec  interface  { attr: string; builtin?: string; interpolate?: string; location?: number; type: T }
src/core/sot.ts#HandleArray  interface  { count: number; element: H }
src/core/sot.ts#IoStruct  interface  { construct: (values: { readonly [K in keyof F]: ReadonlyNode<KeyOf<NonNullable<F[K]>["type"]>>; }) => Node<string>; decl: StructDecl; of: { (node: Node<string>): { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>["type"]>>; } & { readonly $: ReadonlyNode<string>; }; (node: ReadonlyNode<string>): { readonly [K in keyof F]-?: ReadonlyNode<KeyOf<NonNullable<F[K]>["type"]>>; } & { readonly $: ReadonlyNode<string>; }; }; type: ShaderType; var: (name?: string) => { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>["type"]>>; } & { readonly $: ReadonlyNode<string>; } }
src/core/sot.ts#PlainStruct  interface  { construct: (values: { readonly [K in keyof F]: ReadonlyNode<KeyOf<F[K]>>; }) => Node<string>; decl: StructDecl; get: <K extends keyof F & string>(node: ReadonlyNode<string>, field: K) => ReadonlyNode<KeyOf<F[K]>>; of: { (node: Node<string>): { readonly [K in keyof F]: Node<KeyOf<F[K]>>; } & { readonly $: ReadonlyNode<string>; }; (node: ReadonlyNode<string>): { readonly [K in keyof F]: ReadonlyNode<KeyOf<F[K]>>; } & { readonly $: ReadonlyNode<string>; }; }; type: ShaderType; var: (name?: string) => { readonly [K in keyof F]: Node<KeyOf<F[K]>>; } & { readonly $: ReadonlyNode<string>; } }
src/core/sot.ts#Resource  interface  { binding: BindingDecl; node: Node<KeyOf<T>> }
src/core/sot.ts#StorageBuffer  interface  { at: (i: number | ReadonlyNode<ScalarKey>) => A; binding: BindingDecl; elementDecl?: StructDecl; node: Node<string> }
src/core/sot.ts#TypeArray  interface  { count: number; elemType: T }
src/core/sot.ts#UniformStruct  interface  { binding: BindingDecl; decl: StructDecl; field: { readonly [K in keyof F]: UniformFieldNode<F[K]>; }; node: Node<string>; struct: StructDecl; type: ShaderType }
src/core/sot.ts#WgslBuiltinName  type  "vertex_index" | "instance_index" | "position" | "front_facing" | "frag_depth" | "sample_index" | "sample_mask" | "local_invocation_id" | "local_invocation_index" | "global_invocation_id" | "workgroup_id" | "num_workgroups" | "subgroup_invocation_id" | "subgroup_size" | "clip_distances"
src/core/sot.ts#arrayOf  function  { <H extends StructHandle>(element: H, count: number): HandleArray<H>; <T extends ShaderType>(element: T, count: number): TypeArray<T>; }
src/core/sot.ts#builtin  const  <T extends ShaderType>(name: WgslBuiltinName, type: T) => FieldSpec<T>
src/core/sot.ts#constDecl  function  <T extends ShaderType>(name: string, type: T, values: { readonly wgsl: number; readonly cpu: number; }) => ConstHandle<T>
src/core/sot.ts#hostBlock  function  <F extends Record<string, UniformFieldSpec>>(typeName: string, at: { group: number; binding: number; as: string; }, fields: F, opts?: { glsl?: "std140-block" | "loose"; precision?: "highp" | "mediump" | "lowp"; }) => UniformStruct<F>
src/core/sot.ts#hostUniform  function  <T extends ShaderType>(name: string, type: T, at: { group: number; binding: number; }, opts?: { precision?: "highp" | "mediump" | "lowp"; }) => Resource<T>
src/core/sot.ts#ioStruct  function  <F extends Record<string, FieldSpec>>(name: string, fields: F) => IoStruct<F>
src/core/sot.ts#location  const  <T extends ShaderType>(n: number, type: T, interpolate?: string) => FieldSpec<T>
src/core/sot.ts#resource  function  <T extends ShaderType>(name: string, type: T, at: { group: number; binding: number; space?: AddressSpace; }) => Resource<T>
src/core/sot.ts#storageBuffer  function  { <H extends StructHandle>(name: string, element: H, at: { group: number; binding: number; access: "read"; }): StorageBuffer<ReturnType<H["of"]>>; <H extends StructHandle>(name: string, element: H, at: { group: number; binding: number; access: "read_write"; }): StorageBuffer<MutableView<ReturnType<H["of"]>>>; <T extends ShaderType>(name: string, element: T, at: { group: number; binding: number; access: "read"; }): StorageBuffer<ReadonlyNode<KeyOf<T>>>; <T extends ShaderType>(name: string, element: T, at: { group: number; binding: number; access: "read_write"; }): StorageBuffer<Node<KeyOf<T>>>; }
src/core/sot.ts#structDecl  function  <F extends Record<string, ShaderType>>(name: string, fields: F) => PlainStruct<F>
src/core/sot.ts#uniformStruct  function  <F extends Record<string, UniformFieldSpec>>(typeName: string, at: { group: number; binding: number; as: string; }, fields: F) => UniformStruct<F>
src/core/variant-family.ts#AxisValues  type  { readonly [K in keyof A]: A[K][number]; }
src/core/variant-family.ts#GuardDefines  type  { readonly [K in keyof A]: string | Readonly<Record<string, string>>; }
src/core/variant-family.ts#Variant  interface  { axes: AxisValues<A>; key: string; module: ModuleDecl; reflection: Reflection }
src/core/variant-family.ts#VariantFamily  interface  { emit: { (target: "wgsl", opts?: EmitOptions): ReadonlyMap<string, string>; (target: "glsl-es300", opts?: GlslEmitOptions & { stage?: "vertex" | "fragment"; }): ReadonlyMap<string, string>; }; emitGuarded: (defines: GuardDefines<A>, opts?: GlslEmitOptions & { stage?: "vertex" | "fragment"; }) => string; emitGuardedFragment: (defines: GuardDefines<A>, opts?: GlslEmitOptions & { stage?: "vertex" | "fragment"; }) => EmitFragment; get: (key: string) => Variant<A>; keys: readonly string[]; variants: readonly Variant<A>[] }
src/core/variant-family.ts#VariantFamilySpec  interface  { axes: A; build: (axes: AxisValues<A>) => ModuleDecl; key: (axes: AxisValues<A>) => string }
src/core/variant-family.ts#selectGuardedArm  function  (source: string, defined: Iterable<string>) => string
src/core/variant-family.ts#variantFamily  function  <A extends Record<string, readonly unknown[]>>(spec: VariantFamilySpec<A>) => VariantFamily<A>
src/core/variant-link.ts#GlLinker  interface  { COMPILE_STATUS: number; FRAGMENT_SHADER: number; LINK_STATUS: number; VERTEX_SHADER: number; attachShader: (program: Program, shader: Shader) => void; compileShader: (shader: Shader) => void; createProgram: () => Program; createShader: (type: number) => Shader; deleteProgram: (program: Program) => void; deleteShader: (shader: Shader) => void; getProgramInfoLog: (program: Program) => string; getProgramParameter: (program: Program, pname: number) => unknown; getShaderInfoLog: (shader: Shader) => string; getShaderParameter: (shader: Shader, pname: number) => unknown; linkProgram: (program: Program) => void; shaderSource: (shader: Shader, source: string) => void }
src/core/variant-link.ts#VariantLinkResult  interface  { failedAt?: "emit" | "vertex" | "fragment" | "link"; key: string; log?: string; ok: boolean }
src/core/variant-link.ts#VariantWgslResult  interface  { errors?: readonly string[]; failedAt?: "emit" | "validate"; key: string; ok: boolean }
src/core/variant-link.ts#WgslCompiled  interface  { getCompilationInfo: () => Promise<{ readonly messages: readonly WgslMessage[]; }> }
src/core/variant-link.ts#WgslMessage  interface  { lineNum?: number; message: string; type: string }
src/core/variant-link.ts#WgslValidator  interface  { createShaderModule: (descriptor: { code: string; }) => Module }
src/core/variant-link.ts#linkVariants  function  <A extends Record<string, readonly unknown[]>>(gl: GlLinker<unknown, unknown>, family: VariantFamily<A>, opts?: EmitOptions) => readonly VariantLinkResult[]
src/core/variant-link.ts#validateVariantsWgsl  function  <A extends Record<string, readonly unknown[]>>(device: WgslValidator<unknown>, family: VariantFamily<A>, opts?: EmitOptions) => Promise<readonly VariantWgslResult[]>
src/emit-prod.ts#aliasTypes  function  (opts?: { renames?: Map<string, string>; }) => EmitPlugin
src/emit-prod.ts#inline  function  (opts?: { opaque?: InlineOpaque; maxGrowth?: number; report?: InlineDecision[]; }) => EmitPlugin
src/emit-prod.ts#mangle  function  (opts?: { renames?: Map<string, string>; }) => EmitPlugin
src/emit-prod.ts#minify  function  (opts?: MinifyOptions) => EmitPlugin
src/emit-prod.ts#obfuscate  function  (opts?: { renames?: Map<string, string>; }) => EmitPlugin[]
src/emit-prod.ts#prune  function  () => EmitPlugin
```
