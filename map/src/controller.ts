// ═══ Map Controllers — 프로젝션에 따른 카메라 조작 ═══

import type { Camera } from './camera'
import { unprojectGlobeFromCamera } from './camera'
import { promotesToGlobeWhenTilted } from '@xgis/geo'
import { getMaxDpr } from '@xgis/engine'
import { xlog } from '@xgis/shared'

export interface Controller {
  name: string
  attach(
    canvas: HTMLCanvasElement,
    camera: Camera,
    getState: () => ControllerState,
    events?: ControllerEvents,
  ): void
  detach(): void
}

export interface ControllerState {
  projectionName: string
}

/** Optional event callbacks the map wires into the controller so the
 *  layer-level event dispatcher can hook pointer activity. None of the
 *  callbacks block the controller's own pan/zoom/rotate handling — they
 *  fire on the same events with filtering applied (click only when no
 *  drag/rotate happened). */
export interface ControllerEvents {
  /** Fires from `pointerup` when the press-release was a click — i.e.
   *  the pointer never travelled past the click deadzone since
   *  `pointerdown`, and no rotation gesture was activated. */
  onClick?: (clientX: number, clientY: number, ev: PointerEvent) => void
  /** Fires on every `pointermove`, regardless of whether a drag is in
   *  progress. Hover dispatch lives downstream and rAF-coalesces. */
  onPointerMove?: (clientX: number, clientY: number, ev: PointerEvent) => void
  /** Fires when the pointer leaves the canvas. Lets hover dispatch
   *  emit a final `mouseleave` so layers don't get stuck thinking the
   *  cursor is still on them. */
  onPointerLeave?: (ev: PointerEvent) => void
  /** Fires on every `pointerdown`. Unlike `onClick`, no eligibility
   *  filtering — a press that turns into a drag still fires this. */
  onPointerDown?: (clientX: number, clientY: number, ev: PointerEvent) => void
  /** Fires on every `pointerup`. Pairs with `onPointerDown`. */
  onPointerUp?: (clientX: number, clientY: number, ev: PointerEvent) => void
  /** Fires on every wheel event. Listeners receive the wheel deltas via
   *  `event.originalEvent.deltaY` etc. The controller's own zoom logic
   *  still runs — listeners should not call `preventDefault` on the
   *  underlying browser event. */
  onWheel?: (clientX: number, clientY: number, ev: WheelEvent) => void
  /** Fires on `pointercancel` (OS/gesture steal, capture loss). Pairs
   *  with `onPointerUp` for state that must be reset when a gesture ends
   *  without a clean release. */
  onPointerCancel?: (ev: PointerEvent) => void
}

/** Movement distance (CSS px) at which a press-release stops being a
 *  click. 4px matches the threshold most browsers use for the synthetic
 *  `click` event after pointer events. */
const CLICK_DEADZONE_PX = 4

// ═══ PanZoom Controller — 평면 지도용 (Mercator, Equirectangular, Natural Earth) ═══

export class PanZoomController implements Controller {
  name = 'panzoom'
  private cleanup: (() => void) | null = null

  attach(
    canvas: HTMLCanvasElement,
    camera: Camera,
    _getState: () => ControllerState,
    events?: ControllerEvents,
  ): void {
    // Wrap event handlers so any throw inside them surfaces with the real
    // stack via console.error instead of bubbling to window.onerror as the
    // useless cross-origin "Script error. @ :0:0" placeholder iOS WebKit
    // substitutes for opaque error events.
    const safe = <T extends (...a: never[]) => unknown>(label: string, fn: T): T =>
      ((...args: never[]) => {
        try {
          return fn(...args)
        } catch (e) {
          xlog.error('[ctrl ' + label + ']', (e as Error)?.stack ?? e)
        }
      }) as T

    let isDragging = false
    // World anchor for perspective-correct pan — captured at drag start.
    // For projType 3/4/5 (disc projections) this is a GEOGRAPHIC lon/lat
    // (tag: kind='disc') consumed by camera.panDiscToScreenAnchor.
    // For all other paths it is a Mercator-metres absolute point (tag:
    // kind='merc') consumed by camera.panToScreenAnchor, OR null when the
    // ray missed the ground plane (fallback to delta-based pan).
    type DiscAnchor = { kind: 'disc'; lon: number; lat: number }
    type MercAnchor = { kind: 'merc'; x: number; y: number }
    let dragAnchor: DiscAnchor | MercAnchor | null = null
    let lastX = 0
    let lastY = 0

    // Touch state for pinch-to-zoom
    const activePointers = new Map<number, { x: number; y: number }>()
    let lastPinchDist = 0

    // RAF lifecycle: the inertia + smooth-zoom loops self-reschedule via
    // requestAnimationFrame and both mutate the shared camera. detach()
    // (switchController reload / map.stop() / map.destroy()) must cancel any
    // in-flight loop, else a frame queued before teardown keeps writing the
    // camera after the controller is gone. Store the pending handles + a
    // `detached` guard so a frame already queued at cancel time bails.
    let inertiaRaf: number | null = null
    let zoomRaf: number | null = null
    let detached = false

    // Click detection: track press location + cumulative pointer travel
    // since pointerdown. Click fires from pointerup when travel stays
    // under the deadzone AND no rotation gesture activated.
    let pressX = 0
    let pressY = 0
    let pressTravel = 0
    let pressEligible = false // single-pointer + left-button press only

    // Double-tap zoom
    let lastTapTime = 0
    let lastTapX = 0
    let lastTapY = 0

    const onPointerDown = (e: PointerEvent) => {
      // #12: register pointer BEFORE any early-return so every pointerdown
      // has a paired setPointerCapture + activePointers entry, keeping
      // down/up symmetric even when we bail early (e.g. double-tap zoom).
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      canvas.setPointerCapture(e.pointerId)

      // Double-tap detection (single finger only)
      if (activePointers.size === 1) {
        const now = performance.now()
        const dt = now - lastTapTime
        const dist = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY)
        if (dt < 300 && dist < 30) {
          // Double tap → zoom in
          const rDt = canvas.getBoundingClientRect()
          camera.zoomAt(1, e.clientX - rDt.left, e.clientY - rDt.top, canvas.width, canvas.height)
          lastTapTime = 0
          return
        }
        lastTapTime = now
        lastTapX = e.clientX
        lastTapY = e.clientY
      }
      events?.onPointerDown?.(e.clientX, e.clientY, e)

      if (activePointers.size === 1) {
        // Click eligibility: only single-pointer left-button presses
        // count. Right-click (rotate) and multi-touch are excluded.
        pressEligible = e.button === 0 && !e.ctrlKey
        pressX = e.clientX
        pressY = e.clientY
        pressTravel = 0

        // Right-click or Ctrl+click → prepare rotate mode (activated on move)
        if (e.button === 2 || e.ctrlKey) {
          isRotatePending = true
          isRotating = false
          isDragging = false
          rotateStartX = e.clientX
          rotateStartY = e.clientY
          rotateActivated = false
        } else {
          isDragging = true
          isRotating = false
          lastX = e.clientX
          lastY = e.clientY
          lastMoveTime = performance.now()
          panVelX = 0
          panVelY = 0
          inertiaAnimating = false
          // Capture the ABSOLUTE world point under the cursor at drag
          // start. panToScreenAnchor uses this to keep that exact world
          // location under the cursor as it moves — perspective-correct
          // at any pitch / bearing, idempotent against repeated calls.
          // `null` = ray missed the ground plane (e.g. cursor above
          // horizon at high pitch); fall back to delta-based pan in
          // that case.
          //
          // Convert clientX/Y (VIEWPORT-relative) to canvas-local via
          // bounding rect — the canvas may not sit at viewport (0,0)
          // (header / editor pane / etc), and unprojectToZ0 expects
          // coords in [0, canvas.width / canvas.height].
          const dprNow =
            typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
          const r0 = canvas.getBoundingClientRect()
          const sxA = (e.clientX - r0.left) * dprNow,
            syA = (e.clientY - r0.top) * dprNow
          if (camera.globeMode) {
            // Globe: anchor the GEOGRAPHIC point under the cursor on the
            // RENDERED SPHERE (ray↔sphere inverse) — panToScreenAnchor's globe
            // branch rotates the centre so this lon/lat stays under the cursor.
            // null = pressed off the limb → delta-pan fallback.
            const gAnchor = unprojectGlobeFromCamera(
              camera,
              sxA,
              syA,
              canvas.width,
              canvas.height,
              dprNow,
            )
            dragAnchor = gAnchor ? { kind: 'merc', x: gAnchor[0], y: gAnchor[1] } : null
          } else if (promotesToGlobeWhenTilted(camera.projType)) {
            // #2 Disc projections (orthographic/azimuthal-eq/stereographic):
            // unproject to GEOGRAPHIC lon/lat via the disc inverse so the
            // grabbed point stays under the cursor through panDiscToScreenAnchor.
            const geoAnchor = camera.discDragAnchorAt(sxA, syA, canvas.width, canvas.height, dprNow)
            dragAnchor = geoAnchor ? { kind: 'disc', lon: geoAnchor.lon, lat: geoAnchor.lat } : null
          } else if (camera.projType === 1 || camera.projType === 2 || camera.projType === 6) {
            // Flat non-merc (#8): the drag anchor must be the Mercator metres of
            // the TRUE geographic point under the cursor, not `mercCentre +
            // nonMercRel` (which mixes spaces). panToScreenAnchor consumes
            // Mercator metres and composes the cursor through the same inverse.
            const mAnchor = camera.unprojectToMercatorAnchor(
              sxA,
              syA,
              canvas.width,
              canvas.height,
              dprNow,
            )
            dragAnchor = mAnchor ? { kind: 'merc', x: mAnchor[0], y: mAnchor[1] } : null
          } else {
            // Mercator (projType 0) and globe (projType 7 when globeMode=false edge cases)
            const rel = camera.unprojectToZ0(sxA, syA, canvas.width, canvas.height, dprNow)
            dragAnchor = rel
              ? { kind: 'merc', x: camera.centerX + rel[0], y: camera.centerY + rel[1] }
              : null
          }
        }
      } else if (activePointers.size === 2) {
        // #4: entering two-pointer mode must clear any pending rotate state
        // so lifting back to one finger does not wrongly activate rotation.
        isDragging = false
        isRotating = false
        isRotatePending = false
        rotateActivated = false
        lastPinchDist = getPinchDistance(activePointers)
        // Seed angle/centerY with the real current pose so the FIRST two-pointer
        // move computes a delta against it (no wasted seed frame). #13: NaN is
        // the "no prior frame" sentinel only at declaration + size 0/1 reset —
        // never here — so a real value of 0 (fingers horizontal / at top edge)
        // is processed by the !isNaN() guards rather than skipped.
        lastPinchAngle = getPinchAngle(activePointers)
        lastPinchCenterY = getPinchCenter(activePointers).y
      }
    }

    // Prevent context menu on right-click
    const sContextMenu = safe('contextmenu', (e: Event) => e.preventDefault())
    canvas.addEventListener('contextmenu', sContextMenu)

    // Pan inertia
    let panVelX = 0,
      panVelY = 0
    let lastMoveTime = 0
    let inertiaAnimating = false

    const MAX_INERTIA_VEL = 15 // cap velocity (CSS px/frame)

    const applyInertia = safe('inertia', () => {
      // Bail if the controller was detached after this frame was queued but
      // before it ran — otherwise we'd mutate a camera the map no longer owns.
      if (detached) {
        inertiaAnimating = false
        inertiaRaf = null
        return
      }
      if (Math.abs(panVelX) < 0.5 && Math.abs(panVelY) < 0.5) {
        inertiaAnimating = false
        inertiaRaf = null
        return
      }
      camera.pan(panVelX, panVelY, canvas.width, canvas.height)
      panVelX *= 0.9
      panVelY *= 0.9
      inertiaRaf = requestAnimationFrame(applyInertia)
    })

    let isRotatePending = false // right-click down, waiting for movement
    let isRotating = false // actively rotating (after deadzone)
    let rotateActivated = false
    let rotateStartX = 0
    let rotateStartY = 0
    let lastRotateX = 0
    let lastRotateY = 0
    // #13: NaN = "no prior frame" sentinel; 0 is a valid real value
    // (fingers horizontal / centre at top edge) and must not be skipped.
    let lastPinchAngle = NaN
    let lastPinchCenterY = NaN

    const onPointerMove = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      // Hover dispatch — fires every move regardless of drag/rotate state.
      // Downstream rAF coalesces, so a fast drag still only spends one
      // pickAt per frame.
      events?.onPointerMove?.(e.clientX, e.clientY, e)

      // Update press travel so pointerup can decide click vs drag.
      if (pressEligible) {
        pressTravel = Math.max(pressTravel, Math.hypot(e.clientX - pressX, e.clientY - pressY))
      }

      // Right-click pending → check deadzone to activate
      if (isRotatePending && !isRotating && activePointers.size === 1) {
        const dist = Math.hypot(e.clientX - rotateStartX, e.clientY - rotateStartY)
        if (dist < 3) return
        // Passed deadzone: activate rotation
        isRotatePending = false
        isRotating = true
        rotateActivated = true
        lastRotateX = e.clientX
        lastRotateY = e.clientY
      }

      // Active rotation: bearing (horizontal) + pitch (vertical)
      if (isRotating && activePointers.size === 1) {
        const dx = e.clientX - lastRotateX
        const dy = e.clientY - lastRotateY
        lastRotateX = e.clientX
        lastRotateY = e.clientY

        // Horizontal cursor delta → bearing change. Drag right
        // (dx > 0) increases bearing — the user's "drag the compass
        // needle right" / "grab and twist clockwise" intuition.
        // Previous sign rotated the world the opposite direction;
        // reported as inverted. Matches the two-finger pinch
        // direction below.
        camera.rotate(dx * 0.5)
        // Vertical → pitch (drag up = increase pitch, drag down = decrease)
        camera.pitch = Math.max(0, Math.min(85, camera.pitch - dy * 0.3))
        return
      }

      if (activePointers.size === 2) {
        // Two-finger: rotation + pinch zoom + pitch (vertical drag).
        // Pinch uses the "grab the map and twist it" intuition: when
        // the user rotates their fingers CW, the map content rotates
        // CW with the fingers. getPinchAngle is screen-Y-down atan2
        // so CW finger motion produces a positive delta; bearing
        // must DECREASE to make the world rotate CW from the user's
        // POV (Mapbox/MapLibre convention has bearing+ = camera
        // turns CW, which makes the world appear to rotate CCW).
        // Mouse drag rotation up there uses the opposite "drag the
        // compass needle" intuition (drag right = needle rotates CW
        // = bearing+) because a single contact point reads as
        // pointing an indicator, not grabbing the surface.
        const angle = getPinchAngle(activePointers)
        // #13: use !isNaN() to distinguish "no prior frame" (NaN) from a
        // real value of 0 (fingers perfectly horizontal).
        if (!isNaN(lastPinchAngle)) {
          let delta = angle - lastPinchAngle
          if (delta > 180) delta -= 360
          if (delta < -180) delta += 360
          camera.rotate(-delta)
        }
        lastPinchAngle = angle

        // Snapshot the PREVIOUS frame's pinch distance BEFORE the zoom block
        // overwrites lastPinchDist — the pitch disambiguation below needs the
        // frame-over-frame distance delta. Reading lastPinchDist after the
        // overwrite made distChange structurally 0, so the parallel-vs-pinch
        // guard degenerated to centerMove > 2 and an asymmetric pinch (center
        // drifting vertically) wrongly tilted the map.
        const prevDist = lastPinchDist
        const dist = getPinchDistance(activePointers)
        if (lastPinchDist > 0) {
          // #11: use log2 so pinch-out then pinch-back returns to original
          // zoom. Linear (scale-1)*k is asymmetric: out by 2× gives +k but
          // back by 0.5× gives -k/2 → net +k/2. log2 is symmetric by
          // definition: log2(2) + log2(0.5) = 1 - 1 = 0.
          const SENS = 1.5 // log2 units feel ~comparable to old (scale-1)*3
          const delta = Math.log2(dist / lastPinchDist) * SENS
          const center = getPinchCenter(activePointers)
          const rPin = canvas.getBoundingClientRect()
          camera.zoomAt(
            delta,
            center.x - rPin.left,
            center.y - rPin.top,
            canvas.width,
            canvas.height,
          )
        }
        lastPinchDist = dist

        // Two-finger vertical drag → pitch
        // Only apply when both fingers move in same direction (parallel drag),
        // not during pinch-to-zoom (distance change dominates)
        const center = getPinchCenter(activePointers)
        // #13: NaN sentinel for lastPinchCenterY (set at two-pointer entry)
        // so a real center.y of 0 (fingers at canvas top) is not skipped.
        if (!isNaN(lastPinchCenterY) && prevDist > 0) {
          const dy = center.y - lastPinchCenterY
          const distChange = Math.abs(dist - prevDist)
          const centerMove = Math.abs(dy)
          // Only pitch if vertical center movement >> distance change (parallel drag)
          if (centerMove > 2 && centerMove > distChange * 2) {
            camera.pitch = Math.max(0, Math.min(85, camera.pitch - dy * 0.3))
          }
        }
        lastPinchCenterY = center.y
      } else if (isDragging && activePointers.size === 1) {
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        const now = performance.now()
        const dt = Math.max(1, now - lastMoveTime)

        lastX = e.clientX
        lastY = e.clientY
        lastMoveTime = now

        const r1 = canvas.getBoundingClientRect()
        const dprMove =
          typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
        const sxM = (e.clientX - r1.left) * dprMove,
          syM = (e.clientY - r1.top) * dprMove

        if (dragAnchor) {
          if (dragAnchor.kind === 'disc') {
            // #2 Disc projections: keep the grabbed geo point under the cursor
            // via the iterative disc inverse (mirrors zoomAt's converge loop).
            camera.panDiscToScreenAnchor(
              dragAnchor.lon,
              dragAnchor.lat,
              sxM,
              syM,
              canvas.width,
              canvas.height,
              dprMove,
            )
          } else {
            // Perspective-correct pan: keep the world point captured at
            // drag start under the cursor. unprojectToZ0 walks the live
            // MVP, so pitch + bearing are both honoured.
            camera.panToScreenAnchor(
              dragAnchor.x,
              dragAnchor.y,
              e.clientX - r1.left,
              e.clientY - r1.top,
              canvas.width,
              canvas.height,
            )
          }

          // Inertia velocity = the SCREEN-px cursor velocity (px/frame at 60fps) —
          // the basis camera.pan() consumes and MAX_INERTIA_VEL caps. A straight
          // north→south drag then glides straight south, continuing the drag.
          // #614: the old flat-Mercator arm captured velocity from
          // unprojectToZ0(cursor) AFTER panToScreenAnchor had already tracked the
          // FIXED drag anchor under the cursor — so that per-frame delta was ~0 at
          // pitch 0 (the anchor is, by construction, under the cursor every frame)
          // and a perspective-vs-flat-plane residual at pitch>0 — NOT the pan
          // velocity — and it fed camera.pan Mercator METRES where it wants px, so
          // the flat-pan glide died / went off-axis. Disc + globe already used the
          // screen-px velocity here (issue #582); all three now share it. (The
          // pitch>0 foreshortening the old world-velocity arm chased is a separate
          // glide-speed tuning follow-up — screen-px slightly over-speeds at high
          // pitch but tracks the drag direction, which the residual did not.)
          panVelX = dx * (16 / dt)
          panVelY = dy * (16 / dt)
        } else {
          // Anchor missed ground (cursor above horizon at drag start)
          // — fall back to delta-based pan so the user can still drag
          // out of the no-ray-hit region.
          camera.pan(dx, dy, canvas.width, canvas.height)
          panVelX = dx * (16 / dt)
          panVelY = dy * (16 / dt)
        }
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      events?.onPointerUp?.(e.clientX, e.clientY, e)

      // Click dispatch: fires before any rotate snap / inertia logic so
      // listener handlers see the most recent camera state. Eligibility
      // gate filters out drags (travel > deadzone) and rotation gestures.
      if (
        pressEligible &&
        activePointers.has(e.pointerId) &&
        pressTravel < CLICK_DEADZONE_PX &&
        !rotateActivated
      ) {
        events?.onClick?.(e.clientX, e.clientY, e)
      }
      pressEligible = false

      activePointers.delete(e.pointerId)
      if (activePointers.size === 0) {
        // Start inertia only for fast flicks, cap velocity
        panVelX = Math.max(-MAX_INERTIA_VEL, Math.min(MAX_INERTIA_VEL, panVelX))
        panVelY = Math.max(-MAX_INERTIA_VEL, Math.min(MAX_INERTIA_VEL, panVelY))
        if (isDragging && (Math.abs(panVelX) > 2 || Math.abs(panVelY) > 2)) {
          if (!inertiaAnimating) {
            inertiaAnimating = true
            applyInertia()
          }
        }
        // Snap bearing on release (pitch is left as-is for smooth control)
        if (isRotating && rotateActivated) {
          // Bearing: snap to nearest 15°
          const SNAP = 15
          // Number.isFinite gate: if camera.bearing got into NaN/Infinity
          // upstream (a bug we should fix at the source, but defensively
          // catch here so the snap doesn't lock NaN into camera state),
          // reset to 0 before the modulo math.
          let b = Number.isFinite(camera.bearing) ? ((camera.bearing % 360) + 360) % 360 : 0
          let target = Math.round(b / SNAP) * SNAP
          if (target === 360) target = 0
          camera.bearing = target

          // Pitch: only snap to 0 if very close (< 5°)
          if (camera.pitch < 2) camera.pitch = 0
        }
        isDragging = false
        dragAnchor = null
        isRotatePending = false
        isRotating = false
        rotateActivated = false
        pressEligible = false
        lastPinchDist = 0
        lastPinchAngle = NaN
        lastPinchCenterY = NaN
      } else if (activePointers.size === 1) {
        // #4: lifting back to one finger after a two-pointer gesture must
        // clear pending/active rotate state so the remaining finger pans
        // instead of activating rotation on the next move.
        isDragging = true
        isRotating = false
        isRotatePending = false
        rotateActivated = false
        const remaining = activePointers.values().next().value!
        lastX = remaining.x
        lastY = remaining.y
        lastMoveTime = performance.now()
        lastPinchDist = 0
        lastPinchAngle = NaN
        lastPinchCenterY = NaN
        panVelX = 0
        panVelY = 0
        // Re-capture the world anchor under the remaining finger.
        // Without this, dragAnchor is whatever was captured at the
        // original 1-finger drag start (before pinch), so the next
        // pointermove asks panToScreenAnchor to place that stale
        // world point under the lifted-to position — a visible jump
        // to the remaining finger's location.
        const dprUp =
          typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
        const rUp = canvas.getBoundingClientRect()
        const sxU = (remaining.x - rUp.left) * dprUp,
          syU = (remaining.y - rUp.top) * dprUp
        if (camera.globeMode) {
          // Same globe anchor space as the drag-start capture.
          const gAnchorUp = unprojectGlobeFromCamera(
            camera,
            sxU,
            syU,
            canvas.width,
            canvas.height,
            dprUp,
          )
          dragAnchor = gAnchorUp ? { kind: 'merc', x: gAnchorUp[0], y: gAnchorUp[1] } : null
        } else if (promotesToGlobeWhenTilted(camera.projType)) {
          // Disc projections: same geo-anchor space as drag-start.
          const geoUp = camera.discDragAnchorAt(sxU, syU, canvas.width, canvas.height, dprUp)
          dragAnchor = geoUp ? { kind: 'disc', lon: geoUp.lon, lat: geoUp.lat } : null
        } else if (camera.projType === 1 || camera.projType === 2 || camera.projType === 6) {
          // Same flat non-merc (#8) anchor space as the drag-start capture.
          const mAnchorUp = camera.unprojectToMercatorAnchor(
            sxU,
            syU,
            canvas.width,
            canvas.height,
            dprUp,
          )
          dragAnchor = mAnchorUp ? { kind: 'merc', x: mAnchorUp[0], y: mAnchorUp[1] } : null
        } else {
          const relUp = camera.unprojectToZ0(sxU, syU, canvas.width, canvas.height, dprUp)
          dragAnchor = relUp
            ? { kind: 'merc', x: camera.centerX + relUp[0], y: camera.centerY + relUp[1] }
            : null
        }
      }
    }

    const onPointerCancel = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size === 0) {
        // #3: mirror onPointerUp's full reset so an OS gesture-steal does not
        // leave rotateActivated=true, which would suppress the next click via
        // the `!rotateActivated` gate in onPointerUp's click-dispatch block.
        isDragging = false
        dragAnchor = null
        isRotatePending = false
        isRotating = false
        rotateActivated = false
        pressEligible = false
        lastPinchDist = 0
        lastPinchAngle = NaN
        lastPinchCenterY = NaN
      }
      events?.onPointerCancel?.(e)
    }

    // Smooth zoom — lerp to target, no spring overshoot
    let targetZoom = camera.zoom
    let zoomScreenX = 0,
      zoomScreenY = 0
    let animating = false

    const animateZoom = safe('animateZoom', () => {
      // Bail if detached after this frame was queued (see applyInertia).
      if (detached) {
        animating = false
        zoomRaf = null
        return
      }
      const diff = targetZoom - camera.zoom
      if (Math.abs(diff) < 0.005) {
        if (diff !== 0) camera.zoomAt(diff, zoomScreenX, zoomScreenY, canvas.width, canvas.height)
        animating = false
        zoomRaf = null
        return
      }
      camera.zoomAt(diff * 0.2, zoomScreenX, zoomScreenY, canvas.width, canvas.height)
      zoomRaf = requestAnimationFrame(animateZoom)
    })

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      events?.onWheel?.(e.clientX, e.clientY, e)
      const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.003)
      // CRITICAL: when no zoom animation is running, the cached
      // `targetZoom` may be stale. The controller captures it once
      // at attach time as `camera.zoom` (which is 0 — the default
      // Camera constructor value) BEFORE the demo runner applies
      // the URL hash camera state. So a freshly loaded `#15/...`
      // demo has camera.zoom=15 but targetZoom=0; the first wheel
      // computes diff=-15 and animateZoom does diff*0.2=-3 PER
      // FRAME, dropping the camera straight to z=0 in 5 frames.
      // User reported "초기 로드 줌이 15에서 처음 화면이 시작하고
      // 줌 아웃을 하면 바로 줌 0레벨로 이동" — that's this path.
      // Resync target to the live camera every time a wheel fires
      // and no animation is in flight.
      if (!animating) targetZoom = camera.zoom
      // If the wheel direction reversed relative to the pending animation,
      // drop any overshoot targetZoom accumulated past camera.zoom so the
      // user feels an immediate reversal instead of having to "un-wind" the
      // pending zoom-in before the zoom-out starts.
      const pending = targetZoom - camera.zoom
      if (pending * delta < 0) {
        targetZoom = camera.zoom
      }
      targetZoom = Math.max(
        camera.minZoom,
        Math.min(camera.maxZoom, targetZoom + Math.max(-1, Math.min(1, delta))),
      )
      // Canvas-local cursor coords — same reason as the drag anchor
      // above: clientX/Y is viewport-relative, canvas may be offset
      // (header / panel above), and unprojectToZ0 needs coords in
      // canvas-local space to compute the zoom anchor correctly.
      const rWheel = canvas.getBoundingClientRect()
      zoomScreenX = e.clientX - rWheel.left
      zoomScreenY = e.clientY - rWheel.top
      if (!animating) {
        animating = true
        animateZoom()
      }
    }

    const onPointerLeave = (e: PointerEvent) => {
      events?.onPointerLeave?.(e)
    }

    const sPointerDown = safe('pointerdown', onPointerDown)
    const sPointerMove = safe('pointermove', onPointerMove)
    const sPointerUp = safe('pointerup', onPointerUp)
    const sPointerCancel = safe('pointercancel', onPointerCancel)
    const sPointerLeave = safe('pointerleave', onPointerLeave)
    const sWheel = safe('wheel', onWheel)

    canvas.addEventListener('pointerdown', sPointerDown)
    canvas.addEventListener('pointermove', sPointerMove)
    canvas.addEventListener('pointerup', sPointerUp)
    canvas.addEventListener('pointercancel', sPointerCancel)
    canvas.addEventListener('pointerleave', sPointerLeave)
    canvas.addEventListener('wheel', sWheel, { passive: false })

    this.cleanup = () => {
      // Stop the self-rescheduling RAF loops: flip the guard (so any frame
      // already queued bails before touching the camera), clear the animating
      // flags, and cancel the pending handles. cancelAnimationFrame is guarded
      // for non-DOM hosts (node/test), matching the window guards above.
      detached = true
      inertiaAnimating = false
      animating = false
      if (typeof cancelAnimationFrame !== 'undefined') {
        if (inertiaRaf !== null) cancelAnimationFrame(inertiaRaf)
        if (zoomRaf !== null) cancelAnimationFrame(zoomRaf)
      }
      inertiaRaf = null
      zoomRaf = null
      canvas.removeEventListener('contextmenu', sContextMenu)
      canvas.removeEventListener('pointerdown', sPointerDown)
      canvas.removeEventListener('pointermove', sPointerMove)
      canvas.removeEventListener('pointerup', sPointerUp)
      canvas.removeEventListener('pointercancel', sPointerCancel)
      canvas.removeEventListener('pointerleave', sPointerLeave)
      canvas.removeEventListener('wheel', sWheel)
    }
  }

  detach(): void {
    this.cleanup?.()
    this.cleanup = null
  }
}

function getPinchDistance(pointers: Map<number, { x: number; y: number }>): number {
  const pts = [...pointers.values()]
  if (pts.length < 2) return 0
  const dx = pts[1].x - pts[0].x
  const dy = pts[1].y - pts[0].y
  return Math.sqrt(dx * dx + dy * dy)
}

function getPinchAngle(pointers: Map<number, { x: number; y: number }>): number {
  const pts = [...pointers.values()]
  if (pts.length < 2) return 0
  return (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI
}

function getPinchCenter(pointers: Map<number, { x: number; y: number }>): { x: number; y: number } {
  const pts = [...pointers.values()]
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 }
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
}
