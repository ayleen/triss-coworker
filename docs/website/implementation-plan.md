# Triss Website Implementation Plan

## Technical decision

Use Astro to generate a static website and deploy the generated output with
Cloudflare Workers Static Assets through Workers Builds.

Astro is an implementation dependency of the website only. The CLI package and
its release dependencies must remain isolated from website dependencies.

## Prototype source and porting strategy — adopted 2026-08-19

The prototype in `/Volumes/Orange/tmp/triss-site-draft.zip` is **not** Astro.
It is 7 `*.dc.html` pages (`Triss Landing`, `Quickstart`, `Commands`, `Coder`,
`Cost`, `Security`, `Integrations`) rendered by `support.js` (dc-runtime on
`window.React`) with a Tailwind v4 build in `uploads/index.css` and a Figma
source `uploads/Untitled-2.fig` / `uploads/Figma Make App.png`.

Decision: keep the prototype's visual design as the production design (see
`brand-direction.md` for tokens) and port it to Astro:

- extract design tokens (`#0b0d10` bg, `#5fb464` accent, `#1a1d23` borders,
  `IBM Plex Sans/Mono`) into `site/src/styles/tokens.css`;
- recreate the header, hero, bill calculator, copy buttons, tabs, and
  command search as Astro components + minimal `client:load` islands;
- generate all logos/marks/favicons with `agy` (do not copy
  `brand-concepts/*.png` into `site/public`);
- port strictly from the `*.dc.html` content to avoid re-specifying the
  information architecture.

## Repository layout

Create the website as a nested, independently installed package:

```text
site/
  package.json
  package-lock.json
  astro.config.mjs
  tsconfig.json
  wrangler.jsonc
  public/
    _headers
    favicon.svg
  src/
    components/
    content/
    layouts/
    pages/
      robots.txt.ts
    styles/
```

Do not add `site/` to the root npm `workspaces` array for the first release.
The separation is intentional:

- the root `npm ci`, CLI tests, and npm release remain unchanged;
- Astro dependencies do not enter the CLI package lock or published tarball;
- Cloudflare Workers Builds can install and build from `site/` independently;
- site-specific CI can run only when relevant files change.

The site must have a committed `site/package-lock.json`. Generated `site/dist/`
output must be ignored and must not be committed.

## Build contract

The initial `site/package.json` must expose:

```text
npm run dev       # local development server
npm run build     # production static build
npm run preview   # preview the production build locally
npm run check     # Astro/type validation
npm run lint      # site source linting
npm test          # focused site tests
```

Exact tool versions must be selected during implementation, committed to the
site lockfile, and compatible with the active Node.js LTS releases used by the
repository. The initial deployment contract uses Node.js 24 and npm 11.6.2 in
both CI and Workers Builds. Record `packageManager: npm@11.6.2` and a Node.js
engine in `site/package.json`, and add a `site/.node-version` file containing
`24`. Do not reference unpinned remote scripts or runtime CDN libraries.

## Application architecture

- Produce static HTML for every public route.
- Use Astro components by default and add client-side JavaScript only for
  interaction that requires it, such as copying an install command.
- Keep global navigation, footer, SEO metadata, and page shell in shared
  components/layouts.
- Store repeated product capabilities and navigation data in typed local data
  modules rather than duplicating markup.
- Keep content that is migrated from repository documentation traceable to its
  canonical source.
- Do not read arbitrary repository Markdown during the Cloudflare build in the
  first release. Explicitly migrated website content avoids accidental
  publication of internal planning documents.
- Use pinned, self-hosted `IBM Plex Sans` / `IBM Plex Mono` WOFF2 assets in
  `site/public/fonts/`, with the OFL license shipped beside them. Define the
  local `@font-face` rules in the build so page rendering never depends on a
  third-party font service at runtime.

## Content synchronization

The repository `README.md` remains canonical for installation and the high-level
CLI contract until a separate documentation-source migration is approved.

During implementation:

1. Copy only the content needed for the initial pages.
2. Add tests or structured checks for critical values that must stay aligned,
   including the package name, Node.js minimum, repository URL, npm URL, and
   primary install command.
3. Update the website in the same pull request whenever a user-visible CLI
   change makes its content stale.

Do not make a build-time network request to npm or GitHub to render ordinary
page content. The generated content must be deterministic once dependencies
are installed; dependency installation itself still requires registry access.

## Canonical URL and robots contract

Use one non-secret `SITE_URL` build variable as the source for Astro's `site`
configuration, canonical metadata, sitemap URLs, and the generated
`robots.txt` response.

- Initially, production uses
  `https://triss.ikar-autobridge.workers.dev`.
- Preview builds use the current production canonical URL, not their temporary
  preview hostname.
- When the custom domain is attached, update `SITE_URL` to the final HTTPS
  hostname and redeploy before public promotion.
- Generate `robots.txt` from `SITE_URL`; do not commit a hostname-specific
  static file.

Workers version previews are public by default. Preview HTML must retain the
production canonical URL and preview URLs must not be published as permanent
links. After a custom domain becomes canonical, add a host-specific rule to
`site/public/_headers` that applies `X-Robots-Tag: noindex` to the workers.dev
host while leaving the custom domain indexable.

The base `site/public/_headers` file must also define and document the selected
static-site security headers. Validate the effective deployed headers; do not
assume the committed file alone proves Cloudflare applied them.

## Cloudflare Workers Builds configuration

Connect the existing `triss` Worker to the public GitHub repository with:

```text
Production branch:             main
Root directory:                site
Build command:                 npm run build
Deploy command:                npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
Node version:                  24 (NODE_VERSION=24 and site/.node-version)
Canonical URL:                 SITE_URL, defaulting to the production workers.dev URL
```

Expected deployment behavior:

- pushes to `main` create production deployments;
- enabled non-production branch builds create version preview deployments;
- build status is reported to the connected GitHub commit;
- the initial production hostname uses `*.workers.dev`;
- the custom domain is attached only after the default deployment passes the
  launch checks;
- HTTPS is required;
- Cloudflare Web Analytics is enabled after the first deployment and verified
  after the next deployment.

Cloudflare configuration performed in the dashboard must be recorded in this
document or a later operations document so that the deployment can be
reproduced. Never place Cloudflare API tokens in the repository.

Official references:

- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Workers preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [Enable Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/get-started/)
- [Workers Static Assets limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets)

## CI plan

Add a separate `.github/workflows/site.yml` workflow for the website. It should
run for pull requests and pushes to `main` when any of these paths change:

```text
site/**
docs/website/**
.github/workflows/site.yml
package.json
README.md
CHANGELOG.md
```

Including the root metadata and documentation is required so site consistency
checks run when their canonical inputs change, not only when site output is
already being edited.

The workflow must:

1. check out the repository;
2. set up the selected Node.js version with npm caching for
   `site/package-lock.json`;
3. install and verify npm 11.6.2, then run `npm ci` in `site/`;
4. reject high/critical npm advisories, then run linting, Astro checks, tests,
   and the production build;
5. validate internal links, metadata, security headers, local runtime assets,
   image dimensions, source-map exclusion, and explicit HTML/JS/CSS/font/image
   size budgets against `site/dist/`;
6. install a pinned Playwright Chromium and run the complete route set through
   the 320/375/768/900/1440 px responsive matrix, axe WCAG 2.2 AA checks,
   keyboard/mobile-menu behavior, hostile search input, coarse-pointer touch
   targets, reduced motion, local font loading, browser console errors, and
   failed resource requests;
7. run Lighthouse on the home page, command reference, and getting-started
   page with a blocking score floor of 90 for Performance, Accessibility, Best
   Practices, and SEO;
8. upload the static build, Playwright traces/screenshots/report, and Lighthouse
   reports only on failure as short-lived diagnostic artifacts; it must not
   publish production independently of Cloudflare Workers Builds.

The workflow also supports manual dispatch, cancels superseded runs for the
same branch or pull request, and has a 25-minute timeout so a browser process
cannot occupy a runner indefinitely.

The existing root workflow remains responsible for CLI and package tests.
Website-only changes must not weaken or bypass the existing repository checks.

## Validation strategy

### Automated

- Astro/type validation.
- Source linting and formatting checks.
- Focused component or behavior tests for interactive controls.
- Regression tests for hostile search strings and for mobile disclosure reset
  across the 900 px breakpoint.
- Critical-content consistency checks against repository metadata.
- Production build from `npm ci`.
- Internal-link and missing-asset checks against `site/dist/`.
- HTML accessibility checks where reliable automation is available.
- Browser acceptance checks at 320/375/768/900 px and desktop, including no
  horizontal overflow, keyboard/screen-reader semantics, text zoom, safe
  areas, reduced motion, touch-target sizing, and focus visibility.
- Verify generated CSS/assets contain only the pinned local font files and no
  third-party runtime font URL.
- Verification that preview deployments retain production canonical URLs and
  that host-specific noindex rules are applied after a custom domain exists.

### Manual

- Inspect home, documentation index, getting started, and 404 pages at mobile
  and desktop widths.
- Navigate the complete site using only the keyboard.
- Open the mobile menu at 375 px, resize above 900 px, and confirm the nav,
  icon, `aria-expanded`, and disclosure state reset.
- Enter `<img src=x onerror=alert(1)>` in command search and confirm it is
  rendered as text with no created element or handler.
- Verify copy-button state and manual-selection fallback.
- Inspect dark/light presentation if both themes are implemented.
- Run Lighthouse against a production build and investigate individual
  failures.
- Verify the Cloudflare preview before merge and the production deployment
  after merge as separate gates.

### Deployment acceptance

- Confirm the production deployment references the expected merge commit.
- Check HTTPS, redirects, headers, canonical metadata, social metadata,
  `robots.txt`, sitemap, and 404 behavior over the public hostname.
- Check every primary outbound link.
- Confirm a real page view and Web Vitals data reach Cloudflare Web Analytics.
- After attaching a custom domain, verify both the canonical hostname and the
  intended redirect behavior from any alternate hostname.

## Delivery phases

### Phase 1: Foundation

- Scaffold the isolated Astro package in `site/`.
- Add shared layout, global styles, navigation, footer, and metadata support.
- Add site-specific CI and clean-build validation.
- Establish the visual tokens and responsive layout primitives.

Exit condition: a clean install builds a minimal accessible site and all new
CI checks pass.

### Phase 2: Initial content — port the 7 prototype pages

- Port `Triss Landing.dc.html` → `src/pages/index.astro` (home, per
  `product-requirements.md` home section).
- Port `Triss Quickstart.dc.html` → `src/pages/docs/getting-started.astro`
  and `Triss Commands.dc.html` / `Coder` / `Integrations` / `Cost` /
  `Security` → corresponding `src/pages/*.astro` routes.
- Keep `src/pages/docs/index.astro` as the documentation index that groups
  the above by task (as required by `product-requirements.md`).
- Add the 404 page, sitemap, generated robots directives, security headers,
  and social metadata.
- Add critical-content consistency checks (package name, Node ≥22,
  `npm install -g triss-coworker`, repo/npm URLs).

Exit condition: all requirements for the initial routes are satisfied locally.

### Phase 3: Preview and quality pass

- Connect the GitHub repository to the existing Cloudflare Worker.
- Review the pull-request preview at required viewport sizes.
- Run accessibility, link, metadata, and Lighthouse checks.
- Fix issues and obtain pull-request approval.

Exit condition: the preview satisfies the launch criteria and the change is
approved for merge.

### Phase 4: Production launch

- Merge the approved pull request to `main`.
- Verify the Cloudflare production deployment and merge commit.
- Enable and verify Cloudflare Web Analytics.
- Attach and verify the custom domain when selected.
- Update the root package `homepage` field and public repository links only
  after the canonical domain is live.

Exit condition: the public production site passes deployment acceptance and
uses the canonical hostname intended for promotion.

## Explicit approval gates

The following are separate actions and must not be inferred from completion of
the documentation or implementation:

- pushing the feature branch;
- opening a pull request;
- installing or authorizing the Cloudflare GitHub application;
- creating or replacing a Cloudflare Worker;
- changing DNS or attaching a custom domain;
- merging the pull request;
- publicly announcing the website.
