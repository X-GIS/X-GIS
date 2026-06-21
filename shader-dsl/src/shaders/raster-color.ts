// ═══ Shader DSL — raster colour-adjustment helpers ═══
//
// WGSL implementation of Mapbox's `raster-*` colour paint properties applied
// to the sampled tile texel: hue-rotate, brightness-min/max, saturation, and
// contrast. The math is byte-for-byte MapLibre's `raster.fragment.glsl`
// (spinWeights + brightness mix + saturation + contrast), but the per-show
// FACTORS are derived on the GPU from the RAW Mapbox param values so the
// renderer's uniform carries `[hueRotateDeg, brightnessMin, brightnessMax,
// saturation]` + `[contrast, …]` directly — no CPU-side factor precompute.
//
// DEFAULTS are a hard no-op: hue=0 (spin weights = identity), bmin=0/bmax=1
// (mix(0,1,rgb) == rgb), saturation=0 (factor 0 → rgb unchanged), contrast=0
// (factor 1 → rgb unchanged). So a raster show that authors none of these
// produces a result byte-identical to sampling the texel directly.

/** WGSL fn: apply Mapbox raster colour adjustments to an RGB texel.
 *
 *  `p0 = vec4(hueRotateDeg, brightnessMin, brightnessMax, saturation)`
 *  `p1.x = contrast`
 *
 *  Order mirrors MapLibre: hue spin → brightness remap → saturation →
 *  contrast. Result is clamped to [0,1] like MapLibre's final fragment. */
export const RASTER_COLOR_WGSL_FNS = /* wgsl */`
fn raster_spin_weights(angle_rad: f32) -> vec3<f32> {
  let s: f32 = sin(angle_rad);
  let c: f32 = cos(angle_rad);
  let sqrt3: f32 = 1.7320508075688772;
  let w0: f32 = (2.0 * c + 1.0) / 3.0;
  let w1: f32 = (-sqrt3 * s - c + 1.0) / 3.0;
  let w2: f32 = (sqrt3 * s - c + 1.0) / 3.0;
  return vec3<f32>(w0, w1, w2);
}

fn raster_color_adjust(rgb_in: vec3<f32>, p0: vec4<f32>, p1: vec4<f32>) -> vec3<f32> {
  let hue_deg: f32 = p0.x;
  let brightness_low: f32 = p0.y;
  let brightness_high: f32 = p0.z;
  let saturation: f32 = p0.w;
  let contrast: f32 = p1.x;

  var rgb: vec3<f32> = rgb_in;

  // Hue rotate — spin the RGB vector by hue_deg (MapLibre spinWeights).
  let w: vec3<f32> = raster_spin_weights(hue_deg * DEG2RAD_F);
  rgb = vec3<f32>(
    dot(rgb, w.xyz),
    dot(rgb, w.zxy),
    dot(rgb, w.yzx),
  );

  // Brightness remap — mix(low, high, rgb). Default (0,1) is the identity.
  rgb = mix(vec3<f32>(brightness_low), vec3<f32>(brightness_high), rgb);

  // Saturation — MapLibre: rgb += (average - rgb) * factor. factor 0
  // (default) leaves rgb unchanged.
  let sat_factor: f32 = select(-saturation, 1.0 - 1.0 / (1.001 - saturation), saturation > 0.0);
  let avg: f32 = (rgb.r + rgb.g + rgb.b) / 3.0;
  rgb = rgb + (vec3<f32>(avg) - rgb) * sat_factor;

  // Contrast — factor 1 (default) leaves rgb unchanged.
  let contrast_factor: f32 = select(1.0 + contrast, 1.0 / (1.0 - contrast), contrast > 0.0);
  rgb = (rgb - vec3<f32>(0.5)) * contrast_factor + vec3<f32>(0.5);

  return clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
}
`
