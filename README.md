# Monte Azur — Architectural Coastal Retreat & Private Residence

An editorial, cinematic digital staycation experience crafted for **Monte Azur**, directly styled after high-end architectural studio aesthetics. Built with an obsessive focus on warm limestone tones, delicate high-contrast display typography, an asymmetric 3-column spaces mosaic, recognition ribbons, accessible interactions, and fluid motion choreography.

---

## 1. Design Reference & Aesthetic Alignment

This website is styled after the provided **Monte Azur Architectural Studio** visual reference:
- **Canvas Color:** Warm architectural limestone / stone oatmeal (`#EAE5DD`).
- **Typography:** High-contrast editorial display serif (`Cormorant Garamond` & `Playfair Display`) paired with a clean, tracked architectural geometric sans (`Plus Jakarta Sans`).
- **Hero Composition:** Full-bleed dusk architectural photography with the centered headline **"Design that lasts"** and signature horizontal rule subline.
- **Asymmetric 3-Column Spaces Mosaic:** "Spaces with purpose." layout featuring an editorial narrative block, tall vertical retreat card, landscape forest pavilion, and stacked suites with bottom-left overlay titles and arrows (`Title →`).
- **Recognition Ribbon:** Clean monochrome line-art awards ribbon showcasing architectural honors.
- **Floating Live Booking Widget:** Sleek dark pill button (`Reserve Your Stay`) floating on the bottom-left for immediate reservation access.

---

## 2. Technology Stack

- **Markup:** Semantic HTML5 with strict ARIA roles, skip-link landmarks, and accessibility compliance.
- **Styling:** Modern Vanilla CSS3 with native CSS nesting, strict BEM methodology, and flat 0,1,0 specificity.
- **Scripting:** Pure Vanilla ES6+ JavaScript organized into modular, single-responsibility services.
- **Motion & Physics:** 
  - **GSAP 3** for choreographed timelines and clip-path entrance reveals.
  - **GSAP ScrollTrigger** for scroll-driven chapter storytelling and image unmasking.
  - **Lenis** for momentum-preserving smooth scrolling synchronized directly to GSAP's RAF ticker.
- **Dependencies:** Zero frontend frameworks (no React, Vue, or Angular), zero heavy icon packages (clean inline SVGs only).

---

## 3. Directory Architecture

```
staycation/
├── index.html                  # Semantic DOM structure with complete BEM hierarchy
├── .gitignore                  # Standard protection for caches, envs, and system files
├── README.md                   # Technical documentation and integration guide
├── assets/
│   └── images/                 # Verified architectural property photography (14 assets)
├── css/
│   ├── style.css               # Design tokens, typography, and BEM component styles
│   ├── animations.css          # Clip-path definitions, Lenis styles, and reduced-motion
│   └── responsive.css          # Fluid breakpoints (375px, 768px, 1024px, 1440px+)
├── js/
│   ├── availability.js         # Availability provider interface & transparent pricing
│   ├── calendar.js             # Vanilla JS calendar engine (leap years, ranges, dates)
│   ├── booking.js              # Guest constraints, quote calculator, and inquiry flow
│   ├── animations.js           # GSAP timelines, Lenis sync, ScrollTrigger, and parallax
│   └── main.js                 # Primary coordinator, lightbox, drawer, and header observer
└── design-system/
    └── staycation/
        └── MASTER.md           # Authoritative design system tokens
```

---

## 4. Verified Image Asset Map

Every visual asset in the application is directly mapped from the authentic high-resolution property photography located in `assets/images/`:

| Section | Architectural Feature | File Path | Resolution |
| :--- | :--- | :--- | :--- |
| **Hero** | Two-Story Stone Architecture & Infinity Pool at Dusk | `assets/images/qRzeQFQqeJjVx...jpg` | 1024 × 1024 |
| **Spaces Col 1** | Courtyard Lounge & Twilight Plunge Pool | `assets/images/NnUId2XtEnNcu...jpg` | 1024 × 576 |
| **Spaces Col 2 (Top)** | Cantilevered Cliffside Infinity Pool | `assets/images/l90OrGwtF__I3...jpg` | 1024 × 1024 |
| **Spaces Col 2 (Bottom)** | Glass Birch Forest Suite with Fireplace | `assets/images/hG4_u95rGinNc...jpg` | 1500 × 1000 |
| **Spaces Col 3 (Top)** | Maple House &bull; Coastal Horizon Suite | `assets/images/D8VG6xF7oivAi...jpg` | 1280 × 720 |
| **Spaces Col 3 (Mid)** | Oak & Stone Villa &bull; Grand Living Pavilion | `assets/images/53lu9u-YwGtEK...jpg` | 2049 × 1153 |
| **Spaces Col 3 (Low)** | Riverbend Residence &bull; Sunset Headland Terrace | `assets/images/zD6IvlaFDZoYp...jpg` | 1376 × 768 |
| **About Section** | Grand Living Pavilion with Handcrafted Teak Walls | `assets/images/53lu9u-YwGtEK...jpg` | 2049 × 1153 |
| **Chapter 01** | Morning Surf Horizon from Sunlit Master Bed | `assets/images/D8VG6xF7oivAi...jpg` | 1280 × 720 |
| **Chapter 02** | Great Room Salon with Woven Lighting | `assets/images/n4wWwDnxAI3g2...jpg` | 1280 × 854 |
| **Chapter 03** | Glass Birch Forest Suite with Fireplace | `assets/images/hG4_u95rGinNc...jpg` | 1500 × 1000 |
| **Chapter 04** | Cantilevered Cliffside Infinity Pool | `assets/images/l90OrGwtF__I3...jpg` | 1024 × 1024 |
| **Final CTA** | Evening Lit Villa & Pool Terrace | `assets/images/zD6IvlaFDZoYp...jpg` | 1376 × 768 |

---

## 5. Booking & Availability Engine

The booking system separates frontend state management from backend transactions:

1. **Calendar Engine (`js/calendar.js`)**:
   - Calculates astronomical leap years and dynamic month start days.
   - Disables past dates automatically.
   - Highlights today's date, reserved blocks, and active range selection.
   - Enforces sequential date selection (prevents check-out earlier than check-in and disallows ranges spanning through reserved dates).
2. **Availability & Pricing Service (`js/availability.js`)**:
   - Base Nightly Rate: **\$850 / night**.
   - Cleaning Fee: **\$250**.
   - Concierge Service Fee: **8%**.
   - Minimum Stay Rule: **2 Nights minimum**.
   - Capacity constraint: **Up to 8 registered guests**.
3. **Production API Replacement**:
   To connect to a real PMS (Guesty, Lodgify, Track, Hostaway) or backend API, simply swap `AvailabilityService.isDateAvailable` and `AvailabilityService.calculateQuote` to fetch live data from your server endpoints.
