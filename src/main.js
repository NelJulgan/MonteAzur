/**
 * ============================================================================
 * MONTE AZUR — SINGLE VITE APPLICATION ENTRY POINT (src/main.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Modular CSS Entry Import & Smooth Scroll Bootstrapping)
 * - STAGE 2: CORE FUNCTIONALITY (UI Navigation, Lightbox & Reservation Calendar Hydration)
 * - STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION (60fps GSAP ScrollTrigger Choreography)
 *
 * WHY THIS MODULE EXISTS:
 * Serves as the single ES module entry point for Vite (`<script type="module" src="/src/main.js">`).
 * Orchestrates deterministic initialization so the unified Lenis + GSAP ticker bridge
 * is active before any `ScrollTrigger` pins or parallax timelines are created.
 *
 * TRICKY LOGIC:
 * 1. `initLenis()` runs FIRST inside `bootstrapApplication()` after the DOM is ready
 *    so `Lenis` attaches to `document.documentElement` and binds to `gsap.ticker`
 *    before downstream ScrollTriggers measure the DOM.
 * 2. Logs startup verification (`document.documentElement.classList.contains('lenis')`)
 *    and the first wheel/scroll tick once to prove Lenis is actively intercepting scroll.
 *
 * TODO:
 * - Remove temporary debug verification console logs once verified in production.
 * ============================================================================
 */

// STEP 1: Create the HTML structure (index.html semantic landmarks)
// STEP 2: Add the CSS layout and styling (Imported via Vite CSS pipeline including lenis/dist/lenis.css)
import './style.css';

// STEP 3: Initialize GSAP, ScrollTrigger, Lenis, and UI modules
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { lenis, initLenis, getLenis } from './animations/lenis.js';
import { initScrollAnimations } from './animations/scroll.js';
import { initNavbarAndUI } from './components/navbar.js';
import { initCalendarAndBooking } from './components/calendar.js';

gsap.registerPlugin(ScrollTrigger);

// Export singleton lenis instance getter for external consumers
export { lenis, getLenis };

// STEP 4: Add the animation timeline & interactive controllers in deterministic order
// STEP 5: Optimize performance and responsiveness (refresh after load & fonts.ready)
function bootstrapApplication() {
  // 1. Initialize unified Lenis + GSAP ticker bridge FIRST
  const activeLenis = initLenis();

  // Temporary Debug Proof: Verify Lenis class on <html> and first wheel scroll tick
  console.log('✅ Lenis initialized:', document.documentElement.classList.contains('lenis'));

  let hasLoggedFirstScrollTick = false;
  activeLenis.on('scroll', ({ scroll, velocity, isScrolling }) => {
    if (!hasLoggedFirstScrollTick) {
      hasLoggedFirstScrollTick = true;
      console.log('✅ Lenis first scroll tick intercepted:', {
        scroll: Math.round(scroll * 100) / 100,
        velocity: Math.round(velocity * 100) / 100,
        mode: isScrolling,
      });
    }
  });

  // 2. Initialize zero-reflow navigation, delegated smooth anchors, lightbox & hero video loop
  initNavbarAndUI();

  // 3. Initialize interactive availability calendar & Stripe-ready booking controller
  initCalendarAndBooking();

  // 4. Initialize GSAP ScrollTrigger timelines, pinned card toss & 150-frame canvas tour
  initScrollAnimations();

  // 5. Recalculate exact pin-spacer & parallax pixel heights after assets & webfonts settle
  window.addEventListener(
    'load',
    () => {
      activeLenis.resize();
      ScrollTrigger.refresh();
    },
    { once: true }
  );

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      activeLenis.resize();
      ScrollTrigger.refresh();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApplication, { once: true });
} else {
  bootstrapApplication();
}
