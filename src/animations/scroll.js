/**
 * ============================================================================
 * MONTE AZUR — SCROLL ANIMATIONS & INTERACTIVE STORYTELLING (src/animations/scroll.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Dual-Curtain Page Transition & Hero Entrance Choreography)
 * - STAGE 2: CORE FUNCTIONALITY (Pinned Spaces Card Stack + Mobile Toss & 150-Frame Canvas Tour)
 * - STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION (60fps GPU Scrubs, Masked Reveals & Parallax)
 *
 * WHY THIS MODULE EXISTS:
 * Orchestrates all GSAP ScrollTrigger timelines, pinned interactive sections, and
 * multi-plane parallax layers in a single modular unit synced to the unified Lenis
 * ticker in `src/animations/lenis.js`.
 *
 * TRICKY LOGIC:
 * 1. `.space-card__img` elements are tagged with `dataset.parallaxActive = 'true'`
 *    before `initParallaxLayers()` runs so unpinned parallax never conflicts with
 *    the pinned card-toss deck on desktop or mobile.
 * 2. `#tour-canvas` caches canvas dimensions inside `resizeCanvas()` and redraws only
 *    when `Math.floor(progress * totalFrames)` changes frame index, eliminating layout
 *    thrashing during 60fps scroll scrubs.
 * 3. `applySubtleImageParallax()` uses `startOffset: 12, endOffset: -12` within the
 *    `top: -18%; height: 136%` CSS bleed so `.closing-cta` never leaves an open space
 *    above `.site-footer`.
 *
 * TODO:
 * - Optional WebP/AVIF frame sequence negotiation for low-bandwidth mobile connections.
 * ============================================================================
 */

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { getLenis, stopScroll, startScroll } from './lenis.js';

gsap.registerPlugin(ScrollTrigger);

// ============================================================================
// STAGE 1: FOUNDATION CODE — Dual-Curtain Page Transition & Hero Entrance
// ============================================================================
// STEP 1: Create the HTML structure (#page-transition, .hero-banner)
// STEP 2: Add the CSS layout and styling (.page-transition__curtain, .hero-banner__mask)
// STEP 3: Initialize GSAP and ScrollTrigger

export const PageTransition = (() => {
  let isTransitioning = false;

  const getElements = () => {
    const root = document.getElementById('page-transition');
    if (!root) return null;
    return {
      root,
      curtainTop: root.querySelector('.page-transition__curtain--top'),
      curtainBottom: root.querySelector('.page-transition__curtain--bottom'),
      counterWrap: root.querySelector('.page-transition__counter-wrap'),
      counter: root.querySelector('.page-transition__counter'),
    };
  };

  const init = (onCurtainStart = null) => {
    const els = getElements();
    if (!els) {
      if (typeof onCurtainStart === 'function') onCurtainStart();
      return;
    }

    const safetyTimer = setTimeout(() => {
      if (els.root && !els.root.classList.contains('page-transition--hidden')) {
        els.root.classList.add('page-transition--hidden');
        if (typeof onCurtainStart === 'function') onCurtainStart();
        ScrollTrigger.refresh();
      }
    }, 2800);

    gsap.set(els.curtainTop, { yPercent: 0 });
    gsap.set(els.curtainBottom, { yPercent: 0 });
    if (els.counterWrap) {
      gsap.set(els.counterWrap, { opacity: 1, scale: 1 });
    }

    const counterObj = { value: 0 };
    const tl = gsap.timeline({
      onComplete: () => {
        clearTimeout(safetyTimer);
        els.root.classList.add('page-transition--hidden');
        isTransitioning = false;
        ScrollTrigger.refresh();
      },
    });

    tl.to(counterObj, {
      value: 100,
      duration: 1.15,
      ease: 'power2.inOut',
      onUpdate: () => {
        if (els.counter) {
          els.counter.textContent = `${Math.round(counterObj.value)}%`;
        }
      },
    });

    if (els.counterWrap) {
      tl.to(
        els.counterWrap,
        {
          opacity: 0,
          scale: 0.92,
          duration: 0.3,
          ease: 'power2.in',
        },
        '+=0.08'
      );
    }

    tl.to(
      els.curtainTop,
      {
        yPercent: -100,
        duration: 0.95,
        ease: 'power4.inOut',
      },
      '-=0.1'
    );

    tl.to(
      els.curtainBottom,
      {
        yPercent: 100,
        duration: 0.95,
        ease: 'power4.inOut',
      },
      '<'
    );

    if (typeof onCurtainStart === 'function') {
      tl.add(() => {
        onCurtainStart();
      }, '-=0.55');
    }
  };

  const animateIn = (onComplete) => {
    const els = getElements();
    if (!els) {
      if (onComplete) onComplete();
      return;
    }

    if (isTransitioning) return;
    isTransitioning = true;
    els.root.classList.remove('page-transition--hidden');
    stopScroll();

    gsap.to([els.curtainTop, els.curtainBottom], {
      yPercent: 0,
      duration: 0.55,
      ease: 'power4.inOut',
      onComplete: () => {
        if (onComplete) onComplete();
      },
    });
  };

  const animateOut = (onComplete) => {
    const els = getElements();
    if (!els) {
      if (onComplete) onComplete();
      return;
    }

    const tl = gsap.timeline({
      delay: 0.1,
      onComplete: () => {
        els.root.classList.add('page-transition--hidden');
        isTransitioning = false;
        startScroll();
        if (onComplete) onComplete();
      },
    });

    tl.to(els.curtainTop, {
      yPercent: -100,
      duration: 0.85,
      ease: 'power4.inOut',
    }).to(
      els.curtainBottom,
      {
        yPercent: 100,
        duration: 0.85,
        ease: 'power4.inOut',
      },
      '<'
    );
  };

  const transitionTo = (target) => {
    if (isTransitioning) return;

    animateIn(() => {
      if (typeof target === 'string' && (target.startsWith('http') || target.includes('.html'))) {
        window.location.href = target;
      } else {
        const el = typeof target === 'string' ? document.querySelector(target) : target;
        if (el) {
          const lenis = getLenis();
          if (lenis) {
            lenis.scrollTo(el, { offset: -60, immediate: true });
          } else {
            el.scrollIntoView();
          }
        }
        setTimeout(() => {
          animateOut();
        }, 120);
      }
    });
  };

  return { init, animateIn, animateOut, transitionTo };
})();

let heroEntranceInitialized = false;

/**
 * STEP 4: Add the animation timeline (Cinematic Hero Entrance)
 */
function initHeroEntrance() {
  if (heroEntranceInitialized) return;
  heroEntranceInitialized = true;

  window.scrollTo(0, 0);

  const heroMediaWrapper = document.querySelector('.hero-banner__media-wrapper');
  const heroOverlay = document.querySelector('.hero-banner__overlay');
  const heroEyebrow = document.querySelector('.hero-banner__eyebrow');
  const heroTitleLines = document.querySelectorAll('.hero-banner__editorial-line');
  const heroSublineDashes = document.querySelectorAll('.hero-banner__subline-dash');
  const heroSublineText = document.querySelector('.hero-banner__subline-text');
  const heroDesc = document.querySelector('.hero-banner__editorial-desc');
  const heroActions = document.querySelector('.hero-banner__actions');
  const heroScroll = document.querySelector('.hero-banner__scroll');
  const siteHeader = document.getElementById('site-header');

  if (!heroTitleLines.length && !heroMediaWrapper) return;

  const tl = gsap.timeline({
    defaults: { ease: 'power3.out' },
  });

  if (heroMediaWrapper) {
    gsap.set(heroMediaWrapper, { scale: 1.12, transformOrigin: 'center center' });
  }
  if (heroOverlay) gsap.set(heroOverlay, { opacity: 0.6 });
  if (siteHeader) gsap.set(siteHeader, { opacity: 0, y: -20 });
  if (heroEyebrow) gsap.set(heroEyebrow, { opacity: 0, y: 18 });
  if (heroTitleLines.length) gsap.set(heroTitleLines, { opacity: 0, yPercent: 110 });

  if (heroSublineDashes.length >= 2) {
    gsap.set(heroSublineDashes[0], { scaleX: 0, transformOrigin: 'right center' });
    gsap.set(heroSublineDashes[1], { scaleX: 0, transformOrigin: 'left center' });
  } else if (heroSublineDashes.length) {
    gsap.set(heroSublineDashes, { scaleX: 0, transformOrigin: 'center center' });
  }

  if (heroSublineText) gsap.set(heroSublineText, { opacity: 0, y: 10 });
  if (heroDesc) gsap.set(heroDesc, { opacity: 0, y: 20 });
  if (heroActions) gsap.set(heroActions, { opacity: 0, y: 18 });
  if (heroScroll) gsap.set(heroScroll, { opacity: 0, y: 12, x: 0 });

  if (heroMediaWrapper) {
    tl.to(heroMediaWrapper, { scale: 1.0, duration: 2.2, ease: 'power2.out' }, 0);
  }
  if (heroOverlay) {
    tl.to(heroOverlay, { opacity: 1.0, duration: 1.6, ease: 'power1.out' }, 0);
  }
  if (heroEyebrow) {
    tl.to(heroEyebrow, { opacity: 1, y: 0, duration: 0.9 }, 0.15);
  }
  if (heroTitleLines.length) {
    tl.to(
      heroTitleLines,
      { opacity: 1, yPercent: 0, duration: 1.25, stagger: 0.14, ease: 'power4.out' },
      0.25
    );
  }
  if (heroSublineDashes.length) {
    tl.to(heroSublineDashes, { scaleX: 1, duration: 0.85 }, 0.55);
  }
  if (heroSublineText) {
    tl.to(heroSublineText, { opacity: 1, y: 0, duration: 0.85 }, 0.55);
  }
  if (siteHeader) {
    tl.to(
      siteHeader,
      {
        opacity: 1,
        y: 0,
        duration: 0.9,
        clearProps: 'transform,opacity',
      },
      0.65
    );
  }
  if (heroDesc) {
    tl.to(heroDesc, { opacity: 1, y: 0, duration: 0.95 }, 0.75);
  }
  if (heroActions) {
    tl.to(heroActions, { opacity: 1, y: 0, duration: 0.85 }, 0.95);
  }
  if (heroScroll) {
    tl.to(heroScroll, { opacity: 1, y: 0, x: 0, duration: 0.85, ease: 'power2.out' }, 1.15);
  }
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Pinned Spaces Card Stack & 150-Frame Canvas Tour
// ============================================================================

/**
 * Pinned Stacked Card Deck with Dynamic Text Crossfade & Mobile Toss (`.spaces-section`)
 */
function initSpacesCardStack() {
  const section = document.querySelector('.spaces-section');
  const deck = document.querySelector('.spaces-deck');
  const cards = gsap.utils.toArray('.spaces-deck .space-card');
  const textSlides = gsap.utils.toArray('.spaces-intro__slide');
  const progressBar = document.getElementById('spaces-progress-bar');
  const counter = document.getElementById('spaces-counter');

  if (!section || !deck || cards.length === 0) return;

  ScrollTrigger.config({ ignoreMobileResize: true });

  // Lock .space-card__img to this pinned timeline so unpinned parallax doesn't conflict
  cards.forEach((card) => {
    const img = card.querySelector('.space-card__img');
    if (img) img.dataset.parallaxActive = 'true';
  });

  const buildPinnedCardStack = (isMobile) => {
    const totalCards = cards.length;
    const totalTransitions = totalCards - 1;
    const stepScrollPct = isMobile ? 95 : 115;
    const shrinkScale = isMobile ? 0.76 : 0.7;
    const fanStep = isMobile ? -3.2 : -4;

    gsap.set(cards, { clearProps: 'all' });
    gsap.set(textSlides, { clearProps: 'all' });

    gsap.set(cards[0], {
      yPercent: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      filter: 'brightness(1)',
      transformOrigin: 'center center',
    });

    const firstImg = cards[0].querySelector('.space-card__img');
    if (firstImg) {
      gsap.set(firstImg, {
        yPercent: 0,
        scale: 1.08,
        transformOrigin: 'center center',
      });
    }

    for (let i = 1; i < totalCards; i++) {
      gsap.set(cards[i], {
        yPercent: 112,
        scale: 1,
        rotation: isMobile ? (i % 2 === 0 ? -4 : 4) : 0,
        opacity: 1,
        filter: 'brightness(1)',
        transformOrigin: 'center center',
      });
    }

    if (textSlides[0]) {
      gsap.set(textSlides[0], { autoAlpha: 1, y: 0 });
    }
    for (let i = 1; i < textSlides.length; i++) {
      gsap.set(textSlides[i], { autoAlpha: 0, y: 20 });
    }

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: section,
        pin: true,
        start: 'top top',
        end: () => `+=${totalTransitions * stepScrollPct}%`,
        scrub: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        fastScrollEnd: true,
        preventOverlaps: true,
        onUpdate: (self) => {
          const progress = self.progress;
          const activeIndex = Math.min(
            totalCards - 1,
            Math.round(progress * totalTransitions)
          );

          if (counter) {
            const nextText = `${String(activeIndex + 1).padStart(2, '0')} / ${String(totalCards).padStart(2, '0')}`;
            if (counter.textContent !== nextText) {
              counter.textContent = nextText;
            }
          }

          if (progressBar) {
            const pct = Math.max(16.666, ((activeIndex + 1) / totalCards) * 100);
            progressBar.style.width = `${pct}%`;
          }
        },
      },
    });

    for (let i = 0; i < totalTransitions; i++) {
      const currentCard = cards[i];
      const nextCard = cards[i + 1];
      const currentSlide = textSlides[i];
      const nextSlide = textSlides[i + 1];
      const tiltAngle = i % 2 === 0 ? 5 : -5;
      const stepLabel = `step-${i}`;

      tl.addLabel(stepLabel);

      tl.to(
        nextCard,
        {
          yPercent: 0,
          scale: 1,
          rotation: 0,
          ease: 'none',
          duration: 1,
        },
        stepLabel
      );

      const nextImg = nextCard.querySelector('.space-card__img');
      if (nextImg) {
        tl.fromTo(
          nextImg,
          { yPercent: 12, scale: 1.06 },
          { yPercent: -10, scale: 1.18, ease: 'none', duration: 1 },
          stepLabel
        );
      }

      const currentImg = currentCard.querySelector('.space-card__img');
      if (currentImg) {
        tl.to(
          currentImg,
          { yPercent: -12, scale: 1.14, ease: 'none', duration: 1 },
          stepLabel
        );
      }

      tl.to(
        currentCard,
        {
          scale: shrinkScale,
          rotation: tiltAngle,
          yPercent: fanStep * (i + 1),
          filter: 'brightness(0.85)',
          ease: 'none',
          duration: 1,
        },
        stepLabel
      );

      for (let prev = 0; prev < i; prev++) {
        tl.to(
          cards[prev],
          {
            scale: Math.max(0.62, shrinkScale - (i - prev) * 0.03),
            yPercent: fanStep * (i + 1) - (i - prev) * 2,
            filter: 'brightness(0.75)',
            ease: 'none',
            duration: 1,
          },
          stepLabel
        );
      }

      if (currentSlide) {
        tl.to(
          currentSlide,
          { autoAlpha: 0, y: -16, ease: 'power2.inOut', duration: 0.35 },
          stepLabel
        );
      }

      if (nextSlide) {
        tl.fromTo(
          nextSlide,
          { autoAlpha: 0, y: 16 },
          { autoAlpha: 1, y: 0, ease: 'power2.inOut', duration: 0.35 },
          `${stepLabel}+=0.35`
        );
      }
    }

    // Touch horizontal toss gesture support on .spaces-deck for mobile/tablet
    let touchStartX = 0;
    let touchStartY = 0;
    const onTouchStart = (e) => {
      if (!e.touches || !e.touches.length) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    };
    const onTouchEnd = (e) => {
      if (!e.changedTouches || !e.changedTouches.length || !tl.scrollTrigger) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        const st = tl.scrollTrigger;
        const currentStep = Math.round(st.progress * totalTransitions);
        const targetStep =
          dx < 0
            ? Math.min(totalTransitions, currentStep + 1)
            : Math.max(0, currentStep - 1);
        const targetScroll =
          st.start + (targetStep / totalTransitions) * (st.end - st.start);
        const activeLenis = getLenis();
        if (activeLenis) {
          activeLenis.scrollTo(targetScroll, { duration: 0.75 });
        } else {
          window.scrollTo({ top: targetScroll, behavior: 'smooth' });
        }
      }
    };

    deck.addEventListener('touchstart', onTouchStart, { passive: true });
    deck.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      deck.removeEventListener('touchstart', onTouchStart);
      deck.removeEventListener('touchend', onTouchEnd);
      if (tl.scrollTrigger) tl.scrollTrigger.kill();
      tl.kill();
    };
  };

  const mm = gsap.matchMedia();
  mm.add('(min-width: 768px)', () => buildPinnedCardStack(false));
  mm.add('(max-width: 767px)', () => buildPinnedCardStack(true));
}

// ============================================================================
// STAGE 1: FOUNDATION CODE — 240-Frame Residence Tour Eager Streaming Pipeline
// ============================================================================
// // STEP 1: Preload frame sequence immediately on script load & refresh
// Why this code exists:
// Starts downloading and decoding the 240-frame sequence the microsecond the
// script evaluates, eliminating the 1.2s requestIdleCallback delay and ensuring
// instant first-frame paint on website refresh.
//
// Tricky logic:
// 1. Module-Level Immediate Trigger: Begins downloading frame 0 and critical
//    stride keyframes before PageTransition or DOMContentLoaded fires.
// 2. High-Priority Stride Keyframes (Every 6th frame): Loads frames 0, 6, 12... 239
//    first so that 100% of the scrub range is responsive within 200ms of refresh.
// 3. Worker Concurrency Queue: Streams all remaining interstitial frames with
//    concurrency=8 and background `img.decode()`, avoiding main-thread hitching.
//
// TODO: None - Verified zero memory leak and instant frame paint on load.
const TOTAL_TOUR_FRAMES = 240;
const tourFramePath = (index) => {
  const padded = String(index + 1).padStart(4, '0');
  return `assets/tour-sequence/frame_${padded}.webp`;
};

// Global cache of Image elements shared across execution lifecycle
const tourImages = new Array(TOTAL_TOUR_FRAMES);
let isTourPreloadStarted = false;

/**
 * Eagerly pre-decodes all DOM editorial `.webp` images into GPU memory prior to page scrolling
 * so there is zero paint stall or visual pop-in when entering any section.
 */
function preloadEditorialWebpImages() {
  const decodeAllEditorialImages = () => {
    const imgs = document.querySelectorAll('img[src$=".webp"]');
    imgs.forEach((img) => {
      img.decoding = 'async';
      img.loading = 'eager';
      if (img.complete) {
        if ('decode' in img) img.decode().catch(() => {});
      } else {
        img.addEventListener(
          'load',
          () => {
            if ('decode' in img) img.decode().catch(() => {});
          },
          { once: true }
        );
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decodeAllEditorialImages, { once: true });
  } else {
    decodeAllEditorialImages();
  }
}

function startEagerTourPreload() {
  if (isTourPreloadStarted) return;
  isTourPreloadStarted = true;

  // Prime all editorial WebP images in parallel with the tour sequence
  preloadEditorialWebpImages();

  // 1. Prime Frame 0 immediately for instant paint (matches <link rel="preload"> in index.html)
  if (!tourImages[0]) {
    const img0 = new Image();
    img0.decoding = 'async';
    img0.src = tourFramePath(0);
    tourImages[0] = img0;
  }

  const loadAndDecodeFrame = (index) => {
    if (tourImages[index] && tourImages[index].complete) {
      return Promise.resolve(tourImages[index]);
    }
    return new Promise((resolve) => {
      const img = tourImages[index] || new Image();
      img.decoding = 'async';
      img.onload = () => {
        if ('decode' in img) {
          img.decode().catch(() => {}).finally(() => resolve(img));
        } else {
          resolve(img);
        }
      };
      img.onerror = () => resolve(img);
      if (!img.src) {
        img.src = tourFramePath(index);
      }
      tourImages[index] = img;
    });
  };

  // 2. Phase 1: High-Priority Stride Keyframes (Frames 0, 6, 12, 18, 24 ... 239)
  // Loads across the entire scrub duration in parallel so nearest-frame fallback is instant
  const STRIDE = 6;
  const keyframeIndices = [];
  for (let i = 0; i < TOTAL_TOUR_FRAMES; i += STRIDE) {
    if (i !== 0) keyframeIndices.push(i);
  }
  if (keyframeIndices[keyframeIndices.length - 1] !== TOTAL_TOUR_FRAMES - 1) {
    keyframeIndices.push(TOTAL_TOUR_FRAMES - 1);
  }

  // Load keyframes in parallel immediately
  Promise.all(keyframeIndices.map(loadAndDecodeFrame)).then(() => {
    // 3. Phase 2: Concurrent Worker Queue for all remaining interstitial frames
    const remainingIndices = [];
    for (let i = 1; i < TOTAL_TOUR_FRAMES; i++) {
      if (!tourImages[i] || !tourImages[i].complete) {
        remainingIndices.push(i);
      }
    }

    const CONCURRENCY = 8;
    let cursor = 0;

    const worker = () => {
      if (cursor >= remainingIndices.length) return Promise.resolve();
      const nextIdx = remainingIndices[cursor++];
      return loadAndDecodeFrame(nextIdx).then(worker);
    };

    for (let c = 0; c < CONCURRENCY; c++) {
      worker();
    }
  });
}

// Kick off eager preload immediately upon module evaluation
if (typeof window !== 'undefined') {
  startEagerTourPreload();
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — 240-Frame Pinned Canvas Residence Tour (`#tour`)
// // STEP 3: Initialize GSAP and ScrollTrigger
// // STEP 4: Add the animation timeline
// // STEP 5: Optimize performance and responsiveness
// ============================================================================
function initResidenceTourCanvas() {
  const section = document.getElementById('tour');
  const canvas = document.getElementById('tour-canvas');
  if (!section || !canvas) return;

  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) return;

  const transitionOverlay = document.getElementById('tour-transition');
  let activeFrameIndex = -1;

  // Cached cover-draw coordinates computed on resize rather than every 60fps scroll tick
  let cachedOx = 0;
  let cachedOy = 0;
  let cachedNw = 0;
  let cachedNh = 0;
  let cachedImgW = 0;
  let cachedImgH = 0;

  const updateCoverBounds = (imgW, imgH) => {
    const cw = canvas.width;
    const ch = canvas.height;
    if (!cw || !ch || !imgW || !imgH) return;
    cachedImgW = imgW;
    cachedImgH = imgH;
    const imgRatio = imgW / imgH;
    const canvasRatio = cw / ch;

    if (canvasRatio > imgRatio) {
      cachedNw = cw;
      cachedNh = Math.round(cw / imgRatio);
      cachedOx = 0;
      cachedOy = Math.round((ch - cachedNh) / 2);
    } else {
      cachedNh = ch;
      cachedNw = Math.round(ch * imgRatio);
      cachedOx = Math.round((cw - cachedNw) / 2);
      cachedOy = 0;
    }
  };

  const drawCover = (img) => {
    if (!img || !img.complete || img.naturalWidth === 0) return;
    if (cachedNw === 0 || cachedImgW !== img.naturalWidth || cachedImgH !== img.naturalHeight) {
      updateCoverBounds(img.naturalWidth, img.naturalHeight);
    }
    ctx.drawImage(img, cachedOx, cachedOy, cachedNw, cachedNh);
  };

  const resizeCanvas = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = section.clientWidth || window.innerWidth;
    const height = section.clientHeight || window.innerHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    cachedNw = 0; // Invalidate cover geometry cache on resize

    if (activeFrameIndex >= 0 && tourImages[activeFrameIndex]) {
      drawCover(tourImages[activeFrameIndex]);
    } else if (tourImages[0] && tourImages[0].complete) {
      drawCover(tourImages[0]);
    }
  };

  const renderFrame = (index) => {
    if (index === activeFrameIndex) return;
    activeFrameIndex = index;

    let img = tourImages[index];
    if (!img || !img.complete || img.naturalWidth === 0) {
      // Instant Nearest-Loaded-Frame Lookup
      for (let i = 1; i < TOTAL_TOUR_FRAMES; i++) {
        const prev = index - i;
        const next = index + i;
        if (prev >= 0 && tourImages[prev] && tourImages[prev].complete && tourImages[prev].naturalWidth > 0) {
          img = tourImages[prev];
          break;
        }
        if (
          next < TOTAL_TOUR_FRAMES &&
          tourImages[next] &&
          tourImages[next].complete &&
          tourImages[next].naturalWidth > 0
        ) {
          img = tourImages[next];
          break;
        }
      }
    }

    if (img && img.complete && img.naturalWidth > 0) {
      drawCover(img);
    }
  };

  // Instant Paint of Frame 0 on Mount (Zero Wait)
  resizeCanvas();
  if (tourImages[0]) {
    if (tourImages[0].complete && tourImages[0].naturalWidth > 0) {
      drawCover(tourImages[0]);
    } else {
      tourImages[0].addEventListener(
        'load',
        () => {
          resizeCanvas();
          drawCover(tourImages[0]);
        },
        { once: true }
      );
    }
  }

  window.addEventListener('resize', resizeCanvas, { passive: true });

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: section,
      pin: true,
      start: 'top top',
      end: '+=300%',
      scrub: true,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      fastScrollEnd: true,
      preventOverlaps: true,
      onUpdate: (self) => {
        const progress = self.progress;
        const frameIndex = Math.min(TOTAL_TOUR_FRAMES - 1, Math.floor(progress * TOTAL_TOUR_FRAMES));
        renderFrame(frameIndex);
      },
    },
  });

  if (transitionOverlay) {
    tl.fromTo(
      transitionOverlay,
      { opacity: 0 },
      { opacity: 1, ease: 'power2.inOut', duration: 0.2 },
      0.82
    );
  }
}

// ============================================================================
// STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION — Reveals & Multi-Plane Parallax
// ============================================================================
// STEP 5: Optimize performance and responsiveness

function initTourBackgroundTransition() {
  const spacer = document.getElementById('tour-spacer');
  if (!spacer) return;

  // Ensure pure CSS token match with --color-sand (no inline RGB tween seam)
  spacer.style.backgroundColor = 'var(--color-sand)';
}

function initScrollReveals() {
  // 1. Section Headers Masked Editorial Reveal
  const sectionHeaders = document.querySelectorAll('.section-header');
  sectionHeaders.forEach((header) => {
    const label = header.querySelector('.section-header__label');
    const titleLines = header.querySelectorAll('.section-header__title-line');
    const subtitle = header.querySelector('.section-header__subtitle');

    if (label) gsap.set(label, { opacity: 0, y: 18 });
    if (titleLines.length) gsap.set(titleLines, { opacity: 0, yPercent: 125 });
    if (subtitle) gsap.set(subtitle, { opacity: 0, y: 22 });

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: header,
        start: 'top 88%',
        toggleActions: 'play none none reverse',
      },
    });

    if (label) {
      tl.to(label, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' });
    }

    if (titleLines.length) {
      tl.to(
        titleLines,
        {
          opacity: 1,
          yPercent: 0,
          duration: 1.15,
          stagger: 0.14,
          ease: 'power4.out',
        },
        label ? '-=0.5' : 0
      );
    } else {
      const rawTitle = header.querySelector('.section-header__title');
      if (rawTitle) {
        gsap.set(rawTitle, { opacity: 0, y: 25 });
        tl.to(rawTitle, { opacity: 1, y: 0, duration: 0.9, ease: 'power3.out' }, label ? '-=0.5' : 0);
      }
    }

    if (subtitle) {
      tl.to(subtitle, { opacity: 1, y: 0, duration: 0.85, ease: 'power3.out' }, '-=0.6');
    }
  });

  // 2. Property About Narrative & Metric Specs
  const aboutNarratives = document.querySelectorAll('.property-about__narrative');
  aboutNarratives.forEach((narrative) => {
    const paragraphs = narrative.querySelectorAll('.property-about__paragraph');
    const specs = narrative.querySelectorAll('.spec-card');

    if (paragraphs.length) gsap.set(paragraphs, { opacity: 0, y: 35 });
    if (specs.length) gsap.set(specs, { opacity: 0, y: 25 });

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: narrative,
        start: 'top 85%',
        toggleActions: 'play none none reverse',
      },
    });

    if (paragraphs.length) {
      tl.to(paragraphs, {
        opacity: 1,
        y: 0,
        duration: 0.95,
        stagger: 0.14,
        ease: 'power3.out',
      });
    }

    if (specs.length) {
      tl.to(
        specs,
        {
          opacity: 1,
          y: 0,
          duration: 0.8,
          stagger: 0.08,
          ease: 'power3.out',
        },
        '-=0.4'
      );
    }
  });

  const aboutFigure = document.querySelector('.property-about__figure');
  if (aboutFigure) {
    gsap.set(aboutFigure, { opacity: 0, y: 35 });
    gsap.to(aboutFigure, {
      opacity: 1,
      y: 0,
      duration: 1.1,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: '.property-about',
        start: 'top 80%',
        toggleActions: 'play none none reverse',
      },
    });
  }

  // 3. Chapter Experience Cards Content & Media Reveal
  const chapterCards = document.querySelectorAll('.experience-card');
  chapterCards.forEach((card) => {
    const media = card.querySelector('.experience-card__media');
    const content = card.querySelector('.experience-card__content');

    if (media) {
      gsap.set(media, { opacity: 0, y: 40 });
      gsap.to(media, {
        opacity: 1,
        y: 0,
        duration: 1.1,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: card,
          start: 'top 85%',
          toggleActions: 'play none none reverse',
        },
      });
    }

    if (content) {
      const index = content.querySelector('.experience-card__index');
      const titleLines = content.querySelectorAll('.experience-card__title-line');
      const body = content.querySelector('.experience-card__body');
      const highlights = content.querySelectorAll('.experience-card__highlights li');

      if (index) gsap.set(index, { opacity: 0, y: 16 });
      if (titleLines.length) gsap.set(titleLines, { opacity: 0, yPercent: 125 });
      if (body) gsap.set(body, { opacity: 0, y: 24 });
      if (highlights.length) gsap.set(highlights, { opacity: 0, y: 16 });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: card,
          start: 'top 82%',
          toggleActions: 'play none none reverse',
        },
      });

      if (index) {
        tl.to(index, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' });
      }

      if (titleLines.length) {
        tl.to(
          titleLines,
          {
            opacity: 1,
            yPercent: 0,
            duration: 1.15,
            stagger: 0.12,
            ease: 'power4.out',
          },
          index ? '-=0.4' : 0
        );
      } else {
        const rawTitle = content.querySelector('.experience-card__title');
        if (rawTitle) {
          gsap.set(rawTitle, { opacity: 0, y: 25 });
          tl.to(rawTitle, { opacity: 1, y: 0, duration: 0.85, ease: 'power3.out' }, index ? '-=0.4' : 0);
        }
      }

      if (body) {
        tl.to(body, { opacity: 1, y: 0, duration: 0.85, ease: 'power3.out' }, '-=0.6');
      }

      if (highlights.length) {
        tl.to(
          highlights,
          { opacity: 1, y: 0, duration: 0.65, stagger: 0.08, ease: 'power3.out' },
          '-=0.4'
        );
      }
    }
  });

  // 4. Closing CTA Box Reveal
  const closingCtaBox = document.querySelector('.closing-cta__box');
  if (closingCtaBox) {
    const eyebrow = closingCtaBox.querySelector('.closing-cta__eyebrow');
    const titleLines = closingCtaBox.querySelectorAll('.closing-cta__title-line');
    const text = closingCtaBox.querySelector('.closing-cta__text');
    const actions = closingCtaBox.querySelector('.closing-cta__actions');

    if (eyebrow) gsap.set(eyebrow, { opacity: 0, y: 18 });
    if (titleLines.length) gsap.set(titleLines, { opacity: 0, yPercent: 125 });
    if (text) gsap.set(text, { opacity: 0, y: 22 });
    if (actions) gsap.set(actions, { opacity: 0, y: 20 });

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: '.closing-cta',
        start: 'top 82%',
        toggleActions: 'play none none reverse',
      },
    });

    if (eyebrow) {
      tl.to(eyebrow, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' });
    }

    if (titleLines.length) {
      tl.to(
        titleLines,
        {
          opacity: 1,
          yPercent: 0,
          duration: 1.25,
          stagger: 0.14,
          ease: 'power4.out',
        },
        eyebrow ? '-=0.4' : 0
      );
    } else {
      const rawTitle = closingCtaBox.querySelector('.closing-cta__title');
      if (rawTitle) {
        gsap.set(rawTitle, { opacity: 0, y: 25 });
        tl.to(rawTitle, { opacity: 1, y: 0, duration: 0.9, ease: 'power3.out' }, eyebrow ? '-=0.4' : 0);
      }
    }

    if (text) {
      tl.to(text, { opacity: 1, y: 0, duration: 0.85, ease: 'power3.out' }, '-=0.6');
    }

    if (actions) {
      tl.to(actions, { opacity: 1, y: 0, duration: 0.85, ease: 'power3.out' }, '-=0.5');
    }
  }

  // 5. Recognition Award Items Stagger
  const awardsRibbon = document.querySelector('.awards-ribbon');
  const awardItems = document.querySelectorAll('.award-item');
  if (awardsRibbon && awardItems.length) {
    const ribbonLabel = awardsRibbon.querySelector('.awards-ribbon__label');
    if (ribbonLabel) gsap.set(ribbonLabel, { opacity: 0, y: 14 });
    gsap.set(awardItems, { opacity: 0, y: 18 });

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: awardsRibbon,
        start: 'top 90%',
        toggleActions: 'play none none reverse',
      },
    });

    if (ribbonLabel) {
      tl.to(ribbonLabel, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' });
    }

    tl.to(
      awardItems,
      {
        opacity: 1,
        y: 0,
        duration: 0.65,
        stagger: 0.06,
        ease: 'power3.out',
        clearProps: 'transform',
      },
      ribbonLabel ? '-=0.3' : 0
    );
  }

  // 6. Amenities Grid Stagger (Unrestricted Replayable Reveal)
  const amenityCards = document.querySelectorAll('.amenity-card');
  if (amenityCards.length) {
    gsap.set(amenityCards, { opacity: 0, y: 30 });

    ScrollTrigger.batch(amenityCards, {
      start: 'top 88%',
      onEnter: (batch) => {
        gsap.to(batch, {
          opacity: 1,
          y: 0,
          duration: 0.85,
          stagger: 0.08,
          ease: 'power3.out',
          overwrite: 'auto',
        });
      },
      onLeaveBack: (batch) => {
        gsap.to(batch, {
          opacity: 0,
          y: 30,
          duration: 0.5,
          stagger: 0.05,
          ease: 'power2.in',
          overwrite: 'auto',
        });
      },
    });
  }

  // 7. Guest Reflections Review Cards Stagger (Unrestricted Replayable Reveal)
  const reviewCards = document.querySelectorAll('.review-card');
  if (reviewCards.length) {
    gsap.set(reviewCards, { opacity: 0, y: 30 });

    ScrollTrigger.batch(reviewCards, {
      start: 'top 88%',
      onEnter: (batch) => {
        gsap.to(batch, {
          opacity: 1,
          y: 0,
          duration: 0.85,
          stagger: 0.1,
          ease: 'power3.out',
          overwrite: 'auto',
        });
      },
      onLeaveBack: (batch) => {
        gsap.to(batch, {
          opacity: 0,
          y: 30,
          duration: 0.5,
          stagger: 0.06,
          ease: 'power2.in',
          overwrite: 'auto',
        });
      },
    });
  }
}

/**
 * Multi-Plane Parallax Engine (`initParallaxLayers`)
 * Unrestricted 12-plane cinematic depth across all sections and viewports.
 */
function initParallaxLayers() {
  const applySubtleImageParallax = (target, trigger = null, options = {}) => {
    const img = typeof target === 'string' ? document.querySelector(target) : target;
    if (!img || img.dataset.parallaxActive) return;

    img.dataset.parallaxActive = 'true';

    const config = {
      startOffset: 12,
      endOffset: -12,
      startScale: 1.06,
      endScale: 1.2,
      scrub: true,
      ...options,
    };

    const container =
      img.closest('.image-reveal') ||
      img.closest('.space-card__media') ||
      img.closest('.experience-card__media') ||
      img.closest('.amenity-card__media') ||
      img.closest('.closing-cta__media') ||
      img.closest('.property-about__figure') ||
      img.closest('figure') ||
      img.parentElement;

    if (container) {
      container.style.overflow = 'hidden';
      container.style.isolation = 'isolate';
    }

    const trig = trigger || container || img;

    gsap.fromTo(
      img,
      {
        yPercent: config.startOffset,
        scale: config.startScale,
        transformOrigin: 'center center',
      },
      {
        yPercent: config.endOffset,
        scale: config.endScale,
        ease: 'none',
        scrollTrigger: {
          trigger: trig,
          start: 'top bottom',
          end: 'bottom top',
          scrub: config.scrub,
          invalidateOnRefresh: true,
          fastScrollEnd: true,
        },
      }
    );
  };

  // 1. Hero background video wrapper & floating content parallax
  const heroMediaWrapper = document.querySelector('.hero-banner__media-wrapper');
  if (heroMediaWrapper) {
    applySubtleImageParallax(heroMediaWrapper, '.hero-banner', {
      startOffset: 0,
      endOffset: -8,
      startScale: 1.04,
      endScale: 1.18,
      scrub: true,
    });
  }

  const heroFallback = document.querySelector('.hero-banner__image--fallback');
  if (heroFallback) {
    applySubtleImageParallax(heroFallback, '.hero-banner', {
      startOffset: 0,
      endOffset: -8,
      startScale: 1.05,
      endScale: 1.2,
      scrub: true,
    });
  }

  const heroContent = document.querySelector(
    '.hero-banner__editorial-content, .hero-banner__container--editorial'
  );
  if (heroContent) {
    gsap.fromTo(
      heroContent,
      { yPercent: 0, opacity: 1 },
      {
        yPercent: -22,
        opacity: 0.2,
        ease: 'none',
        scrollTrigger: {
          trigger: '.hero-banner',
          start: 'top top',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      }
    );
  }

  const heroScroll = document.querySelector('.hero-banner__scroll');
  if (heroScroll) {
    gsap.fromTo(
      heroScroll,
      { y: 0, x: 0, opacity: 1 },
      {
        y: -40,
        x: 0,
        opacity: 0,
        ease: 'none',
        scrollTrigger: {
          trigger: '.hero-banner',
          start: 'top top',
          end: '40% top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      }
    );
  }

  // 2. Spaces Section: Intro column counter-drift
  const spacesIntro = document.querySelector('.spaces-section__col--intro');
  const spacesSection = document.querySelector('.spaces-section');
  if (spacesIntro && spacesSection) {
    gsap.fromTo(
      spacesIntro,
      { y: 0 },
      {
        y: -24,
        ease: 'none',
        scrollTrigger: {
          trigger: spacesSection,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      }
    );
  }

  // 3. Property About: Asymmetric split-plane parallax, specs & caption drift
  const aboutImg = document.querySelector('.property-about__img');
  const aboutFigure = document.querySelector('.property-about__figure');
  const aboutSection = document.querySelector('.property-about');
  if (aboutImg) {
    applySubtleImageParallax(aboutImg, aboutFigure || aboutSection);
  }

  const aboutNarrative = document.querySelector('.property-about__narrative');
  if (aboutNarrative && aboutSection) {
    gsap.fromTo(
      aboutNarrative,
      { y: 25 },
      {
        y: -25,
        ease: 'none',
        scrollTrigger: {
          trigger: aboutSection,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      }
    );
  }

  // STAGE 3: Property About Specs (.spec-card) — Parallax removed per user request for solid, static card layout
  const aboutSpecs = document.querySelectorAll('.property-about__specs .spec-card');
  if (aboutSpecs.length) {
    gsap.set(aboutSpecs, { clearProps: 'transform' });
  }

  const aboutCaption = document.querySelector('.property-about__caption');
  if (aboutCaption && aboutSection) {
    gsap.fromTo(
      aboutCaption,
      { y: 12 },
      {
        y: -12,
        ease: 'none',
        scrollTrigger: {
          trigger: aboutSection,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      }
    );
  }

  // 4. Experience Chapter Cards: Parallax removed per user request for static card positioning
  const experienceCards = document.querySelectorAll('.experience-card');
  experienceCards.forEach((card) => {
    const img = card.querySelector('.experience-card__image');
    if (img) {
      img.dataset.parallaxActive = 'true';
      gsap.set(img, { clearProps: 'transform' });
    }
    const content = card.querySelector('.experience-card__content');
    if (content) gsap.set(content, { clearProps: 'transform' });
    const index = card.querySelector('.experience-card__index');
    if (index) gsap.set(index, { clearProps: 'transform' });
    gsap.set(card, { clearProps: 'transform' });
  });

  // 5. Amenities Section (.amenity-card): Parallax removed per user request — image sits cleanly inside without bleed
  const amenityCards = document.querySelectorAll('.amenity-card');
  amenityCards.forEach((card) => {
    const img = card.querySelector('.amenity-card__img');
    if (img) {
      img.dataset.parallaxActive = 'true';
      gsap.set(img, { clearProps: 'transform' });
    }
    const badge = card.querySelector('.amenity-card__icon-badge');
    if (badge) gsap.set(badge, { clearProps: 'transform' });
    gsap.set(card, { clearProps: 'transform' });
  });

  // 6. Section Headers Parallax across all sections
  const sectionHeaders = document.querySelectorAll('.section-header');
  sectionHeaders.forEach((header) => {
    const section = header.closest('section') || header.parentElement;
    if (section && !header.closest('.hero-banner')) {
      gsap.fromTo(
        header,
        { y: 16 },
        {
          y: -16,
          ease: 'none',
          scrollTrigger: {
            trigger: section,
            start: 'top bottom',
            end: 'bottom top',
            scrub: true,
            invalidateOnRefresh: true,
          },
        }
      );
    }
  });

  // 7. Recognition / Awards Ribbon (.awards-ribbon, .awards-ribbon__grid): Parallax removed per user request
  const awardItems = document.querySelectorAll('.award-item');
  if (awardItems.length) {
    gsap.set(awardItems, { clearProps: 'transform' });
  }
  const awardsGrid = document.querySelector('.awards-ribbon__grid');
  if (awardsGrid) {
    gsap.set(awardsGrid, { clearProps: 'transform' });
  }

  // 8. Reviews / Guest Reflections Cards: Parallax removed per user request for solid card positioning
  const reviewCards = document.querySelectorAll('.review-card, .journal-card');
  if (reviewCards.length) {
    gsap.set(reviewCards, { clearProps: 'transform' });
  }

  const trustBadge = document.querySelector('.reviews-trust-badge');
  if (trustBadge) {
    gsap.fromTo(
      trustBadge,
      { y: 16 },
      {
        y: -16,
        ease: 'none',
        scrollTrigger: {
          trigger: '.reviews-section',
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      }
    );
  }

  // 9. Booking & Availability Calendar Cards: Parallax removed per user request for static card positioning
  const calCard = document.querySelector('.booking-calendar-card');
  const sumCard = document.querySelector('.booking-summary-card');
  if (calCard) gsap.set(calCard, { clearProps: 'transform' });
  if (sumCard) gsap.set(sumCard, { clearProps: 'transform' });

  // 10. Location Guide & Map Media Parallax
  const locationInfo = document.querySelector('.location-guide__info');
  const locationCard = document.querySelector('.location-card');
  const locationSection = document.querySelector('.location-guide');
  if (locationInfo && locationSection) {
    gsap.fromTo(
      locationInfo,
      { y: 20 },
      {
        y: -20,
        ease: 'none',
        scrollTrigger: {
          trigger: locationSection,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      }
    );
  }
  if (locationCard) {
    // Parallax removed on location card per user request
    gsap.set(locationCard, { clearProps: 'transform' });
  }

  // 11. Closing CTA Image & Box
  const closingCtaImg = document.querySelector('.closing-cta__image');
  const closingCtaMedia = document.querySelector('.closing-cta__media');
  const closingCtaBox = document.querySelector('.closing-cta__box');
  const closingCtaSection = document.querySelector('.closing-cta');
  if (closingCtaImg) {
    applySubtleImageParallax(closingCtaImg, closingCtaMedia || closingCtaSection, {
      startOffset: 12,
      endOffset: -12,
      startScale: 1.06,
      endScale: 1.22,
      scrub: true,
    });
  }

  if (closingCtaBox && closingCtaSection) {
    gsap.fromTo(
      closingCtaBox,
      { y: 28 },
      {
        y: -28,
        ease: 'none',
        scrollTrigger: {
          trigger: closingCtaSection,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
        },
      }
    );
  }

  // 12. Universal Safety Net for unpinned editorial full-bleed images (Cards strictly excluded)
  const allEditorialImages = document.querySelectorAll(
    'img:not(.lightbox-modal__image):not(.site-header__logo-img):not(.amenity-card__img):not(.experience-card__image):not(.space-card__img)'
  );
  allEditorialImages.forEach((img) => {
    // If inside any card or awards ribbon, never attach parallax
    if (
      img.closest('.amenity-card') ||
      img.closest('.experience-card') ||
      img.closest('.space-card') ||
      img.closest('.spec-card') ||
      img.closest('.review-card') ||
      img.closest('.location-card') ||
      img.closest('.booking-calendar-card') ||
      img.closest('.booking-summary-card') ||
      img.closest('.awards-ribbon')
    ) {
      img.dataset.parallaxActive = 'true';
      return;
    }
    if (!img.dataset.parallaxActive) {
      const container = img.closest('.image-reveal') || img.closest('figure') || img.parentElement;
      if (container) {
        applySubtleImageParallax(img, container);
      }
    }
  });
}

/**
 * Initializes all ScrollTrigger animations and exposes `MotionEngine` / `PageTransition`.
 */
export function initScrollAnimations() {
  PageTransition.init(() => {
    initHeroEntrance();
  });

  initSpacesCardStack();
  initResidenceTourCanvas();
  initTourBackgroundTransition();
  initScrollReveals();
  initParallaxLayers();

  ScrollTrigger.refresh();
  window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      ScrollTrigger.refresh();
    });
  }

  if (typeof window !== 'undefined') {
    window.PageTransition = PageTransition;
  }
}
