/**
 * ============================================================================
 * MONTE AZUR — NAVIGATION, DRAWER, LIGHTBOX & VIDEO LOOP (src/components/navbar.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Zero-Reflow Sticky Header & Cached Section Coordinates)
 * - STAGE 2: CORE FUNCTIONALITY (Mobile Drawer, Smooth Anchor Travel & Lightbox)
 * - STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION (Seamless Dual-Video Dissolve Loop)
 *
 * WHY THIS MODULE EXISTS:
 * Coordinates sticky header transitions, active navigation link tracking, mobile
 * off-canvas drawer focus management, high-res space card photo lightbox, and the
 * dual-buffer hero video dissolve loop.
 *
 * TRICKY LOGIC:
 * 1. Eliminates layout thrashing during scroll by caching `top` and `bottom` coordinates
 *    of all navigation target sections in `cacheSectionBounds()` on `load`, `resize`,
 *    and `ScrollTrigger.refresh`. Scroll ticks only compare cached numbers.
 * 2. Ping-pongs `#hero-video-a` and `#hero-video-b` with a 450ms top-layer optical
 *    dissolve right before stream completion so the hero video loops with zero black frames.
 *
 * TODO:
 * - Add swipe-left/right touch gesture support inside `#lightbox-modal`.
 * ============================================================================
 */

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { lenis, getLenis, stopScroll, startScroll } from '../animations/lenis.js';

let isProgrammaticNav = false;
let programmaticNavTimeout = null;

// ============================================================================
// STAGE 1: FOUNDATION CODE — Zero-Reflow Sticky Header & Active Section Spy
// ============================================================================
// STEP 1: Create the HTML structure (#site-header, .nav-list__link)
// STEP 2: Add the CSS layout and styling (.site-header--scrolled, .site-header--hidden)
// STEP 3: Cache section geometry outside the scroll loop

function initNavigation() {
  const header = document.getElementById('site-header');
  if (!header) return;

  const headerLinks = Array.from(header.querySelectorAll('.nav-list__link'));
  const sections = headerLinks.map((link) => {
    const hash = link.getAttribute('href');
    return hash && hash.startsWith('#') ? document.querySelector(hash) : null;
  });

  // Cached section geometry: [{ top, bottom }]
  let sectionBounds = [];
  let activeIdx = -1;

  const cacheSectionBounds = () => {
    const scrollY = window.scrollY || 0;
    sectionBounds = sections.map((section) => {
      if (!section) return null;
      const rect = section.getBoundingClientRect();
      const top = rect.top + scrollY;
      return { top, bottom: top + rect.height };
    });
  };

  const updateActiveNavLinks = (currentY) => {
    const scrollPos = currentY + 160;
    let nextActiveIdx = -1;

    for (let idx = 0; idx < sectionBounds.length; idx++) {
      const bound = sectionBounds[idx];
      if (bound && scrollPos >= bound.top && scrollPos < bound.bottom) {
        nextActiveIdx = idx;
      }
    }

    if (nextActiveIdx !== activeIdx) {
      activeIdx = nextActiveIdx;
      headerLinks.forEach((link, idx) => {
        link.classList.toggle('nav-list__link--active', idx === activeIdx);
      });
    }
  };

  let lastScrollY = window.scrollY || 0;
  let isHeaderScrolled = false;
  let isHeaderHidden = false;
  const SCROLL_DOWN_THRESHOLD = 2.5;
  const SCROLL_UP_THRESHOLD = 4;
  const TOP_THRESHOLD = 50;

  const setHeaderScrolled = (scrolled) => {
    if (isHeaderScrolled !== scrolled) {
      isHeaderScrolled = scrolled;
      header.classList.toggle('site-header--scrolled', scrolled);
    }
  };

  const setHeaderHidden = (hidden) => {
    if (isHeaderHidden !== hidden) {
      isHeaderHidden = hidden;
      header.classList.toggle('site-header--hidden', hidden);
    }
  };

  const handleScroll = (currentY, direction = 0) => {
    updateActiveNavLinks(currentY);

    if (currentY <= TOP_THRESHOLD) {
      setHeaderHidden(false);
      setHeaderScrolled(false);
      lastScrollY = currentY <= 0 ? 0 : currentY;
      return;
    }

    setHeaderScrolled(true);

    if (isProgrammaticNav) {
      if (currentY > lastScrollY) {
        setHeaderHidden(true);
      }
      lastScrollY = currentY;
      return;
    }

    const delta = currentY - lastScrollY;

    if (direction === 1 || delta > SCROLL_DOWN_THRESHOLD) {
      setHeaderHidden(true);
    } else if (direction === -1 || delta < -SCROLL_UP_THRESHOLD) {
      setHeaderHidden(false);
    }

    lastScrollY = currentY <= 0 ? 0 : currentY;
  };

  cacheSectionBounds();
  window.addEventListener('resize', cacheSectionBounds, { passive: true });
  window.addEventListener('load', cacheSectionBounds, { once: true });
  ScrollTrigger.addEventListener('refresh', cacheSectionBounds);

  const activeLenis = getLenis();
  if (activeLenis) {
    activeLenis.on('scroll', ({ scroll, direction }) => {
      handleScroll(scroll, direction);
    });
  } else {
    window.addEventListener(
      'scroll',
      () => {
        handleScroll(window.scrollY || document.documentElement.scrollTop || 0, 0);
      },
      { passive: true }
    );
  }
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Mobile Drawer, Lightbox & Smooth Anchors
// ============================================================================

function initMobileDrawer() {
  const toggleBtn = document.getElementById('menu-toggle');
  const drawer = document.getElementById('mobile-drawer');
  const closeBtn = document.getElementById('drawer-close');
  const backdrop = document.getElementById('drawer-backdrop');
  const navLinks = drawer
    ? drawer.querySelectorAll('.mobile-nav-list__link, .mobile-drawer__cta')
    : [];

  if (!toggleBtn || !drawer) return;

  const openDrawer = () => {
    drawer.classList.add('mobile-drawer--open');
    drawer.setAttribute('aria-hidden', 'false');
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.classList.add('menu-toggle--active');
    document.body.style.overflow = 'hidden';
    stopScroll();
    if (closeBtn) closeBtn.focus();
  };

  const closeDrawer = () => {
    drawer.classList.remove('mobile-drawer--open');
    drawer.setAttribute('aria-hidden', 'true');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.classList.remove('menu-toggle--active');
    document.body.style.overflow = '';
    startScroll();
    if (toggleBtn) toggleBtn.focus();
  };

  toggleBtn.addEventListener('click', () => {
    if (drawer.classList.contains('mobile-drawer--open')) {
      closeDrawer();
    } else {
      openDrawer();
    }
  });

  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  navLinks.forEach((link) => {
    link.addEventListener('click', closeDrawer);
  });

  document.addEventListener('keydown', (e) => {
    if (!drawer.classList.contains('mobile-drawer--open')) return;

    if (e.key === 'Escape') {
      closeDrawer();
    } else if (e.key === 'Tab') {
      const focusables = drawer.querySelectorAll(
        'button, [href], input, [tabindex]:not([tabindex="-1"])'
      );
      const visible = Array.from(focusables).filter(
        (el) => !el.disabled && el.offsetParent !== null
      );
      if (!visible.length) return;

      const first = visible[0];
      const last = visible[visible.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  });
}

function initLightbox() {
  const modal = document.getElementById('lightbox-modal');
  const backdrop = document.getElementById('lightbox-backdrop');
  const closeBtn = document.getElementById('lightbox-close');
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  const imageEl = document.getElementById('lightbox-image');
  const captionEl = document.getElementById('lightbox-caption');

  const cardTriggers = document.querySelectorAll('.space-card__trigger');
  if (!modal || !cardTriggers.length) return;

  const photos = Array.from(cardTriggers).map((trigger) => {
    const img = trigger.querySelector('.space-card__img');
    const title = trigger.querySelector('.space-card__title');
    return {
      src: img ? img.getAttribute('src') : '',
      alt: img ? img.getAttribute('alt') : '',
      title: title ? title.textContent.replace('→', '').replace('•', '—').trim() : '',
    };
  });

  let currentIndex = 0;
  let lastActiveTrigger = null;

  const updateLightboxPhoto = (index) => {
    if (index < 0) index = photos.length - 1;
    if (index >= photos.length) index = 0;
    currentIndex = index;

    const photo = photos[currentIndex];
    imageEl.src = photo.src;
    imageEl.alt = photo.alt;
    captionEl.textContent = photo.title;
  };

  const openLightbox = (index, triggerElement) => {
    lastActiveTrigger = triggerElement;
    updateLightboxPhoto(index);
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    stopScroll();
    if (closeBtn) closeBtn.focus();
  };

  const closeLightbox = () => {
    modal.hidden = true;
    document.body.style.overflow = '';
    startScroll();
    imageEl.src = '';
    if (lastActiveTrigger) {
      lastActiveTrigger.focus();
    }
  };

  cardTriggers.forEach((trigger, idx) => {
    trigger.addEventListener('click', () => openLightbox(idx, trigger));
  });

  if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
  if (backdrop) backdrop.addEventListener('click', closeLightbox);
  if (prevBtn) prevBtn.addEventListener('click', () => updateLightboxPhoto(currentIndex - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => updateLightboxPhoto(currentIndex + 1));

  document.addEventListener('keydown', (e) => {
    if (modal.hidden) return;

    if (e.key === 'Escape') {
      closeLightbox();
    } else if (e.key === 'ArrowLeft') {
      updateLightboxPhoto(currentIndex - 1);
    } else if (e.key === 'ArrowRight') {
      updateLightboxPhoto(currentIndex + 1);
    } else if (e.key === 'Tab') {
      const focusables = modal.querySelectorAll(
        'button, [href], [tabindex]:not([tabindex="-1"])'
      );
      const visible = Array.from(focusables).filter(
        (el) => !el.disabled && el.offsetParent !== null
      );
      if (!visible.length) return;

      const first = visible[0];
      const last = visible[visible.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  });
}

function initSmoothAnchors() {
  const revealTargetSection = (target) => {
    if (!target) return;
    target.classList.remove('section-reveal--active');
    const revealEl = target.querySelector(
      '.section-header, .booking-section__container, .spaces-section__container'
    );
    if (revealEl) {
      gsap.fromTo(
        revealEl,
        { y: 24, opacity: 0.8 },
        { y: 0, opacity: 1, duration: 0.9, ease: 'power3.out', overwrite: 'auto' }
      );
    }
    target.classList.add('section-reveal--active');
  };

  // Delegated click handler for all internal anchor links and CTA buttons
  document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a[href^="#"], [data-scroll-to]');
    if (!anchor) return;

    const href = anchor.getAttribute('data-scroll-to') || anchor.getAttribute('href');
    if (!href || href === '#' || href === '#!') return;

    const target = document.querySelector(href);
    if (!target) return;

    e.preventDefault();

    const drawer = document.getElementById('mobile-drawer');
    const toggleBtn = document.getElementById('menu-toggle');
    if (drawer && drawer.classList.contains('mobile-drawer--open')) {
      drawer.classList.remove('mobile-drawer--open');
      drawer.setAttribute('aria-hidden', 'true');
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.classList.remove('menu-toggle--active');
      }
      document.body.style.overflow = '';
      startScroll();
    }

    isProgrammaticNav = true;
    if (programmaticNavTimeout) clearTimeout(programmaticNavTimeout);
    programmaticNavTimeout = setTimeout(() => {
      isProgrammaticNav = false;
    }, 1500);

    const activeLenis = getLenis();
    if (activeLenis) {
      activeLenis.scrollTo(target, {
        offset: -80,
        duration: 1.6,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      });
    } else {
      target.scrollIntoView({ behavior: 'smooth' });
    }

    revealTargetSection(target);
  });
}

// ============================================================================
// STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION — Seamless Dual-Video Dissolve
// ============================================================================
// STEP 4: Add top-layer 450ms crossfade between #hero-video-a and #hero-video-b
// STEP 5: Pause backgrounded video streams via Page Visibility API

function initSeamlessVideoLoop() {
  const videoA = document.getElementById('hero-video-a');
  const videoB = document.getElementById('hero-video-b');
  const fallbackImg = document.getElementById('hero-fallback-image');

  if (!videoA || !videoB) return;

  videoA.muted = true;
  videoA.defaultMuted = true;
  videoA.playsInline = true;

  videoB.muted = true;
  videoB.defaultMuted = true;
  videoB.playsInline = true;

  let activeVideo = videoA;
  let standbyVideo = videoB;
  let isCrossfading = false;
  const FADE_DURATION = 0.45;

  activeVideo.style.zIndex = '1';
  activeVideo.style.opacity = '1';
  standbyVideo.style.zIndex = '2';
  standbyVideo.style.opacity = '0';

  const hideFallback = () => {
    if (fallbackImg) {
      fallbackImg.classList.add('hero-banner__image--hidden');
      fallbackImg.style.opacity = '0';
      fallbackImg.style.visibility = 'hidden';
    }
  };

  videoA.addEventListener('playing', hideFallback, { once: true });
  videoA.addEventListener(
    'timeupdate',
    () => {
      if (videoA.currentTime > 0.05) hideFallback();
    },
    { once: true }
  );

  const playSafe = (vid) => {
    vid.muted = true;
    const playPromise = vid.play();
    if (playPromise !== undefined) {
      playPromise.then(hideFallback).catch(() => {});
    }
  };

  playSafe(activeVideo);

  const unlockOnInteraction = () => {
    if (activeVideo.paused) {
      playSafe(activeVideo);
    }
    ['pointerdown', 'touchstart', 'scroll', 'keydown'].forEach((evt) => {
      window.removeEventListener(evt, unlockOnInteraction);
    });
  };

  ['pointerdown', 'touchstart', 'scroll', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, unlockOnInteraction, { once: true, passive: true });
  });

  // Event-driven timeupdate check instead of an extra infinite requestAnimationFrame loop
  const onTimeUpdate = () => {
    if (!activeVideo || !activeVideo.duration || isCrossfading) return;
    const timeLeft = activeVideo.duration - activeVideo.currentTime;

    if (timeLeft <= FADE_DURATION && timeLeft > 0.04) {
      isCrossfading = true;

      const outgoing = activeVideo;
      const incoming = standbyVideo;

      incoming.style.zIndex = '2';
      incoming.style.opacity = '0';
      incoming.currentTime = 0;
      playSafe(incoming);

      outgoing.style.zIndex = '1';
      outgoing.style.opacity = '1';

      gsap.to(incoming, {
        opacity: 1,
        duration: FADE_DURATION,
        ease: 'power1.inOut',
        onComplete: () => {
          outgoing.pause();
          outgoing.currentTime = 0;
          outgoing.style.opacity = '0';

          activeVideo = incoming;
          standbyVideo = outgoing;
          activeVideo.style.zIndex = '1';
          standbyVideo.style.zIndex = '2';
          isCrossfading = false;
        },
      });
    }
  };

  videoA.addEventListener('timeupdate', onTimeUpdate);
  videoB.addEventListener('timeupdate', onTimeUpdate);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      activeVideo.pause();
      standbyVideo.pause();
    } else {
      playSafe(activeVideo);
    }
  });
}

export function initNavbarAndUI() {
  initSeamlessVideoLoop();
  initNavigation();
  initMobileDrawer();
  initLightbox();
  initSmoothAnchors();
}
