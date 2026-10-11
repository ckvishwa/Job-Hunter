# Orbital UI integration (Phase A + B)

Evidence for applying the approved Orbital landing design to the working S1/S2 application. Dated 2026-10-09. Everything below was run locally; nothing was committed or pushed.

## Phase A: design system extracted from `/orbital`

The source of truth was the local `web/src/pages/orbital.astro` (kept as a route). Its CSS and markup were split, not rewritten:

| New file | Contents |
|---|---|
| `web/src/styles/orbital.css` | Tokens (ink `#101116`, white, royal `#2855E8`, blue wash, hairline), base reset, `.eyebrow`, `.section-number`, `.display`, `.btn*`, `.brand`, `.brand-mark`, `[hidden]`, reduced-motion rule. Shared by landing and app. |
| `web/src/styles/landing.css` | Hero, sections, career cards, marketing header/footer, landing media queries. Public landing only. |
| `web/src/styles/app.css` | Authenticated shell, page header, cards, forms, tables, status chips, alerts, skeletons, gate states, S1/S2 class names (kept: `badge`, `role-card`, `grid`, `actions`, `row`, ...), responsive rules. Loaded only by the app layout. |
| `web/src/components/OrbitalLogo.astro` | The square angled ink/white/blue tile (no circle, no character). |
| `web/src/components/OrbitalTile.astro` | The hero's angular tile with thin orbit path and nodes, as a small vector empty-state mark. |
| `web/src/components/PageHead.astro` | Numbered eyebrow, heavyweight headline, lead copy, actions slot. |
| `web/src/components/OrbitalLanding.astro` | The landing body (header, hero, sections, footer, menu script). |
| `web/src/layouts/Public.astro` | Public shell. CSP `connect-src 'none'`: it cannot call the API. |
| `web/src/layouts/Base.astro` | App shell: brand, route nav with active state, breadcrumb, the session gate (loading / unavailable / offline / error / sign-in / expired), `#app` private container. |

Palette note: status never relies on colour alone (icon + text + border style). One functional red (`#B3261E`) is used only for error text/borders; there is no mint, pink, teal, neon or gradient-dominated surface.

### Visual checkpoint: `/orbital` unchanged

Full-page screenshots with reduced motion, before vs after extraction, compared pixel by pixel (Pillow):

| Width | Size before / after | Different pixels | Where |
|---|---|---|---|
| 1440 | 1440x2723 / 1440x2723 | 6,799 (0.173 %) | header "My workspace" -> "Log in", footer links row |
| 768 | 768x4246 / same | 1,696 (0.052 %) | footer links row only |
| 390 | 390x4649 / same | 1,679 (0.093 %) | footer links row only |

The first attempt after extraction was 84 px shorter (the footer had been sliced off by my extraction). The pixel diff caught it; it was fixed before moving on.

## Phase B: route map and the public/private boundary

| Route | Audience | Notes |
|---|---|---|
| `/` | public | Orbital landing. Makes **no API request**; renders with Fastify stopped (verified: zero `/api` requests, every `href` resolves, none is `#`). |
| `/orbital` | public | Same landing (kept until the root transition is accepted). |
| `/dashboard` | private | The former `/` dashboard, restyled. Sign-in lives here (and on every private route). |
| `/resumes` | private | Upload + list (the former `/` upload page; it is a different route than before). |
| `/review?id=` | private | Fact review, unchanged behaviour, Orbital shell, stacked layout on phones. |
| `/roles` | private | Career paths; adds a legend separating *suggested*, *approved target* and *selected for discovery*. |
| `/profile` | private | Explicit statements (citizenship, clearance, work authorization, sponsorship), unchanged semantics. |
| `/jobs` | private | S3 (see `s3-official-discovery.md`). |

Private routes request nothing but `GET /api/v1/session` until signed in (asserted for all six). Signed out, `#app` is hidden and contains no private text.

Intentional changes to previously working behaviour (tests updated, behaviour preserved):
- Sign-in moved from `/` to `/dashboard` (the gate form keeps its ids). Sign-out now returns to `/dashboard`.
- The upload page moved from `/` to `/resumes`.
- Nav label "Explicit statements" is "Statements" (the page title is unchanged).

## Regressions found and fixed while doing this

| Found by | Defect | Fix |
|---|---|---|
| pixel diff | footer missing after extraction | included the footer in the landing component |
| screenshot | `.brand` styles lived in landing.css, so the app logo was broken | moved to `orbital.css` |
| screenshot | "Sign out" showed while signed out (`button{display:inline-flex}` beat `[hidden]`) | `[hidden]{display:none!important}` |
| overflow test | `/resumes` overflowed by 278 px at 390 px; `/review` by 228 px | tables scroll inside their card; review facts table stacks on phones; grid children `min-width:0` |
| screenshot | review action buttons were off-screen on phones | stacked layout (all buttons visible) |

## Automated evidence

- `tests/e2e/offline/orbital-s3.e2e.test.ts` (headed Chrome, real Astro build -> Fastify -> Python -> PostgreSQL, synthetic data): public landing with Fastify stopped; signed-out private routes; the S1 -> S2 -> S3 path; Fastify stopped on `/jobs`; blocked employers; **7 routes x 4 widths (1440, 768, 390, 360) with a no-horizontal-overflow assertion**, keyboard Tab reaching the Start control with a >= 2 px focus ring, and `prefers-reduced-motion` stopping the landing's orbit and pill animations. All non-loopback requests are aborted and asserted empty.
- Existing `s1-ui`, `s2-ui` and `dashboard` browser tests still pass (after the route moves above).
- Screenshots (synthetic résumé "Jordan Rivers", invented employers) are in `docs/evidence/orbital-screens/` (`landing-*`, `dashboard-*`, `resumes-*`, `review-*`, `roles-*`, `jobs-*`, `profile-*` at each width; `jobs-before-run-1440.png`, `jobs-after-run-1440.png`, `jobs-fastify-stopped-1440.png`, `landing-fastify-stopped.png`).

## Known limits

- Contrast was checked by design (ink on white, white on royal), not by an automated contrast tool.
- Only keyboard reachability and focus ring were automated; a full screen-reader pass was not done.
- The landing's decorative "SIEM / Python / Identity & access" pills are the design's illustration, not product data.
