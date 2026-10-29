# Orbital — Astro landing page (visual prototype)

This is an actual HTML/CSS/SVG landing page for the current **Orbital** visual direction: square mark; black, white and royal blue; geometric orbital artwork; no human photography. The dynamic graphics and hover effects are implemented without external images, fonts, JS libraries, or API calls.

**This package has NOT modified the user's `F:\Jobs\Job_Search\job-hunter` worktree.** It is a safe, standalone addition designed for that existing Astro app. The repo's auth code and exact route mapping are not supplied here, so verify them locally before publishing this at `/`.

## Files
- `web/src/pages/orbital.astro` — standalone Astro route intended for `/orbital` in the real project.
- `preview/orbital.html` — static browser preview, equivalent markup/CSS.
- `preview/desktop.png` / `preview/mobile.png` — rendered visual QA screenshots.
- `design-reference.png` — user's approved human-free design reference.

## Install in current development worktree
From Windows PowerShell, once this zip has been extracted:

```powershell
$repo = 'F:\Jobs\Job_Search\job-hunter\.claude\worktrees\universal-job-discovery'
$package = 'C:\PATH\TO\EXTRACTED\orbital-landing'

# Creates /orbital without overwriting existing home/auth logic
Copy-Item "$package\web\src\pages\orbital.astro" "$repo\web\src\pages\orbital.astro"

cd "$repo\web"
npm run dev
```

Visit http://127.0.0.1:4321/orbital (or the Astro port shown in terminal). This public preview renders without Fastify. The "Get started", "My workspace", and résumé CTAs link to `/resumes`, and role CTAs link to `/roles`. Those routes must be verified in the actual repository. Working upload, fact review and role approval remain on their existing S1/S2 pages; the homepage **does not pretend to upload a file itself**.

## Publishing at `/` safely

1. Inspect `web/src/pages/index.astro`, current `/api/v1/session` authentication behavior and route ownership. The current `/` includes session logic and has been observed to render blank while Fastify is down. Preserve login/logout flows when replacing it.
2. After verifying `/resumes` and `/roles`, copy the landing's content to `index.astro`, or extract it into a component and render that component from `/`. If the current root owns login/session, relocate that UI to a verified working path first; update navigation and browser tests accordingly. **Do not blindly overwrite `index.astro`**.
3. Start the PostgreSQL/Python/Fastify services for S1/S2 functionality separately. The landing itself must still render when API is down.
4. Run the project's `npm run typecheck`, targeted Astro/browser tests, `npm run pipeline:offline`, and full Vitest with compatible `--maxWorkers=1 --minWorkers=1` (known machine localhost flakes are a separate issue).
5. Verify public-page accessibility, real route destinations, API-down empty/error behavior, mobile navigation, no horizontal overflow, reduced motion and zero unhandled JS errors.
6. Keep current work uncommitted until reviewed. No S3, application submission, real user data or unauthenticated private API calls are part of this landing.

## Design and content guardrails

- No fictional customer metrics, hiring percentages, trust badges, user testimonials, salary bands, or fake user-specific match percentages.
- Illustrative role-family cards describe concepts, not verified job openings.
- The fourth "Find openings" step explicitly says **S3 in development** because S3 has not been reported complete.
- Blue variants are tonal derivatives of royal blue, not additional palette accents. Core colors: `#101116`, `#FFFFFF`, `#2855E8`.
- Brand "Orbital" remains subject to brand/trademark/domain clearance separately from this implementation.

## Visual QA performed in packaging environment
Rendered in Chromium using in-memory HTML (`page.set_content`) at desktop (1440), tablet (768), mobile (390) and small mobile (360). No overflow, page exceptions, or duplicate HTML IDs; mobile menu opened and closed correctly. **The Astro worktree build and authenticated handoff are NOT verified here** because the Windows source tree was not provided.
