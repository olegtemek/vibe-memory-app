import { onActivated, onBeforeUnmount, onDeactivated, onMounted, type Ref } from 'vue'

export interface Point {
  x: number
  y: number
}

/** Fingers closer than this share of the start distance: pinch in (zoom out). */
export const PINCH_IN_SCALE = 0.75
/** Fingers farther than this share: pinch out (zoom in). */
export const PINCH_OUT_SCALE = 1.3

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** What a finished pinch means for the given finger distance ratio. */
export function pinchOutcome(scale: number): 'in' | 'out' | null {
  if (scale <= PINCH_IN_SCALE) return 'in'
  if (scale >= PINCH_OUT_SCALE) return 'out'
  return null
}

/** How much the content follows the fingers: damped and clamped, so it only hints at the zoom. */
export function feedbackScale(scale: number): number {
  return Math.min(1.25, Math.max(0.8, 1 + (scale - 1) * 0.5))
}

export interface PinchHandlers {
  /** Fingers moved together. */
  onPinchIn?: (center: Point) => void
  /** Fingers moved apart. */
  onPinchOut?: (center: Point) => void
}

const touchPoint = (t: Touch): Point => ({ x: t.clientX, y: t.clientY })

/**
 * Two-finger pinch on an element, used instead of the browser page zoom.
 * The element follows the fingers a little; a pinch past the threshold calls the handler.
 * Also blocks iOS page zoom while the view is shown (gesturestart is Safari-only).
 */
export function usePinch(target: Ref<HTMLElement | undefined>, handlers: PinchHandlers) {
  let start: { distance: number; center: Point } | null = null
  let scale = 1
  let pinched = false

  function setFeedback(value: number | null, center?: Point) {
    const el = target.value
    if (!el) return
    if (value === null) {
      el.style.transform = ''
      el.style.transformOrigin = ''
      el.style.transition = ''
      return
    }
    if (center) {
      const rect = el.getBoundingClientRect()
      el.style.transformOrigin = `${center.x - rect.left}px ${center.y - rect.top}px`
    }
    el.style.transition = 'none'
    el.style.transform = `scale(${value})`
  }

  function onStart(ev: TouchEvent) {
    if (ev.touches.length !== 2) return
    const a = touchPoint(ev.touches[0]!)
    const b = touchPoint(ev.touches[1]!)
    start = { distance: distance(a, b) || 1, center: midpoint(a, b) }
    scale = 1
    pinched = true
    setFeedback(1, start.center)
  }

  function onMove(ev: TouchEvent) {
    if (!start || ev.touches.length !== 2) return
    ev.preventDefault()
    scale = distance(touchPoint(ev.touches[0]!), touchPoint(ev.touches[1]!)) / start.distance
    setFeedback(feedbackScale(scale))
  }

  function onEnd(ev: TouchEvent) {
    if (!start || ev.touches.length > 1) return
    const { center } = start
    start = null
    const outcome = pinchOutcome(scale)
    const handler = outcome === 'in' ? handlers.onPinchIn : outcome === 'out' ? handlers.onPinchOut : undefined
    if (handler) {
      setFeedback(null)
      handler(center)
      return
    }
    // Not far enough: spring back.
    const el = target.value
    if (el) {
      el.style.transition = 'transform 0.25s var(--ease-out)'
      el.style.transform = ''
      setTimeout(() => setFeedback(null), 260)
    }
  }

  const blockPageZoom = (ev: Event) => ev.preventDefault()

  function attach() {
    const el = target.value
    if (!el) return
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    document.addEventListener('gesturestart', blockPageZoom)
    document.addEventListener('gesturechange', blockPageZoom)
  }

  function detach() {
    const el = target.value
    start = null
    setFeedback(null)
    if (el) {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
    document.removeEventListener('gesturestart', blockPageZoom)
    document.removeEventListener('gesturechange', blockPageZoom)
  }

  // Views may be kept alive: listen only while shown.
  let attached = false
  const on = () => {
    if (!attached) attach()
    attached = true
  }
  const off = () => {
    if (attached) detach()
    attached = false
  }
  onMounted(on)
  onActivated(on)
  onDeactivated(off)
  onBeforeUnmount(off)

  return {
    /** True if the current touch sequence had two fingers; resets on read once all fingers are up. */
    consumePinch(): boolean {
      const was = pinched
      pinched = false
      return was
    },
  }
}
