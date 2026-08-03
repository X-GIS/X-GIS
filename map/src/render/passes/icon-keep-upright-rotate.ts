// Extracted VERBATIM from label-pass.ts (LOC-ceiling payment for the #1046
// F3b RHI origination) — the pure icon-rotation resolver dispatchIcon calls.

/** #777 I-B — resolve a line-placed icon's rotation (radians) for dispatchIcon,
 *  applying the Mapbox `icon-keep-upright` half-plane fold. Under
 *  icon-rotation-alignment=map the icon follows the per-segment `lineTangentDeg`
 *  (0° for point / viewport placement). `icon-keep-upright: true` keeps the icon
 *  facing up by flipping a DOWNWARD tangent 180° — the icon twin of the text
 *  keep-upright flip (text-stage.ts:1500-1530, `midAngle > π/2`). A tangent
 *  outside (-90°, 90°] screen-space gets +180°, so the resolved angle lands in
 *  the upright half-plane. The fold activates ONLY on an EXPLICITLY authored
 *  `keepUpright === true`; absent/false leaves the tangent untouched, so the
 *  rotation is byte-identical to today's always-follow-tangent render (the
 *  icon-allow-overlap absent-default convention). Not map-aligned → tangent is 0,
 *  so the fold is inert (icon-rotate alone).
 *  Exported for unit coverage — dispatchIcon is an anon closure. */
export function resolveIconRotateRad(
  iconRotateDeg: number,
  lineTangentDeg: number,
  rotationAlignmentMap: boolean,
  keepUpright: boolean | undefined,
): number {
  let tangent = rotationAlignmentMap ? lineTangentDeg : 0
  // Upright half-plane fold: on an EXPLICITLY authored keep-upright, a tangent
  // pointing down (outside (-90°, 90°]) gets +180° so the resolved rotation
  // lands upright — the icon twin of the text angle fold (label-pass.ts text
  // arm / text-stage.ts midAngle test).
  if (rotationAlignmentMap && keepUpright === true && (tangent > 90 || tangent < -90)) {
    tangent += 180
  }
  return ((iconRotateDeg + tangent) * Math.PI) / 180
}
