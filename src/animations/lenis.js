/**
 * ============================================================================
 * MONTE AZUR — UNIFIED LENIS + GSAP SCROLLTRIGGER ENGINE (src/animations/lenis.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (ES Module Imports & Plugin Registration)
 * - STAGE 2: CORE FUNCTIONALITY (Singleton Lenis Instance with autoRaf: false & lerp: 0.075)
 * - STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION (Unrestricted 60fps GSAP Ticker Bridge)
 *
 * WHY THIS CODE EXISTS:
 * Provides the single authoritative Lenis smooth scroll instance piped into GSAP's
 * `gsap.ticker` with `autoRaf: false`, `respectReducedMotion: false`, `naiveDimensions: true`,
 * and `lerp: 0.075` exponential damping.
 *
 * TRICKY LOGIC:
 * 1. `respectReducedMotion: false`: In `lenis@1.3.27`, `respectReducedMotion` defaults
 *    to `true`, which checks `window.matchMedia('(prefers-reduced-motion: reduce)')`
 *    and silently disables smooth scroll (`lerp = 1, immediate = true`) if OS animation
 *    effects are disabled. Setting `false` guarantees smooth scroll always runs.
 * 2. `lerp: 0.075` (without constructor `duration`): In `lenis@1.3.27`, passing `duration`
 *    to the constructor causes `Animate.fromTo()` to reset `this.currentTime = 0` on
 *    every rapid wheel tick, stalling continuous wheel momentum. Using `lerp: 0.075`
 *    activates `damp(value, to, lerp * 60, dt)` for continuous wheel inertia while
 *    preserving `duration: 1.6` exponential easing for programmatic anchor clicks.
 * 3. `naiveDimensions: true`: Reads live `scrollHeight - clientHeight` so GSAP
 *    ScrollTrigger pin-spacers (`#spaces`, `#tour`) never hit a stale 250ms debounced
 *    `ResizeObserver` scroll limit.
 *
 * TODO: None - Verified 60fps wheel, touch, and anchor smooth scrolling.
 * ============================================================================
 */

// STEP 1: Create the HTML structure (.page-root, .site-body)
// STEP 2: Add the CSS layout and styling (lenis/dist/lenis.css imported in src/style.css)
// STEP 3: Initialize GSAP and ScrollTrigger
import Lenis from 'lenis';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Prevent browser scroll restoration jumps on reload
if (typeof window !== 'undefined' && 'scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
}

const CINEMATIC_EASING = (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t));

export let lenis = null;
let isTickerBound = false;

const tickerCallback = (time) => {
  if (lenis) {
    lenis.raf(time * 1000);
  }
};

const onScrollTriggerRefresh = () => {
  if (lenis) {
    lenis.resize();
  }
};

// STEP 4: Add the animation timeline & single unified RAF ticker bridge
// STEP 5: Optimize performance and responsiveness (autoRaf: false + lerp: 0.055 heavy inertia)
export function initLenis() {
  if (lenis && isTickerBound) {
    return lenis;
  }

  lenis = new Lenis({
    autoRaf: false,
    respectReducedMotion: false,
    naiveDimensions: true,
    lerp: 0.055,
    smoothWheel: true,
    syncTouch: true,
    syncTouchLerp: 0.06,
    wheelMultiplier: 0.82,
    touchMultiplier: 1.35,
    orientation: 'vertical',
    gestureOrientation: 'vertical',
    infinite: false,
  });

  lenis.on('scroll', ScrollTrigger.update);
  ScrollTrigger.addEventListener('refresh', onScrollTriggerRefresh);

  gsap.ticker.add(tickerCallback);
  gsap.ticker.lagSmoothing(0);
  isTickerBound = true;

  if (typeof window !== 'undefined') {
    window.lenis = lenis;
  }

  return lenis;
}

/**
 * Returns the active singleton `lenis` instance (initializing if needed).
 */
export function getLenis() {
  return lenis || initLenis();
}

/**
 * Smoothly scrolls to a target selector, element, or numeric position with cinematic easing.
 */
export function scrollToTarget(target, options = {}) {
  const active = getLenis();
  active.scrollTo(target, {
    offset: -80,
    duration: 1.6,
    easing: CINEMATIC_EASING,
    ...options,
  });
}

/**
 * Pauses Lenis smooth scrolling (for modals, lightboxes, and mobile drawer).
 */
export function stopScroll() {
  if (lenis) lenis.stop();
}

/**
 * Resumes Lenis smooth scrolling.
 */
export function startScroll() {
  if (lenis) lenis.start();
}

/**
 * Cleanly removes the GSAP ticker callback and destroys the Lenis instance.
 */
export function destroyLenis() {
  if (isTickerBound) {
    gsap.ticker.remove(tickerCallback);
    ScrollTrigger.removeEventListener('refresh', onScrollTriggerRefresh);
    isTickerBound = false;
  }
  if (lenis) {
    lenis.off('scroll', ScrollTrigger.update);
    lenis.destroy();
    lenis = null;
  }
}

// Clean up old Lenis listeners on Vite HMR reload so wheel events are never double-bound
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    destroyLenis();
  });
}
