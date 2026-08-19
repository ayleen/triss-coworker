# Triss Website Implementation Plan

## Technical decision

Use Astro to generate a static website and deploy the generated output with
Cloudflare Pages.

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
- Cloudflare Pages can install and build from `site/` independently;
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
both CI and Cloudflare Pages. Record `packageManager: npm@11.6.2` and a Node.js
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
- Use `IBM Plex Sans` / `IBM Plex Mono` as in the prototype (loaded via
  `link` with self-host fallback). Do not make page rendering depend on a
  third-party font service at runtime; pin or self-host the font assets.

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

- Initially, production uses the assigned `https://<project>.pages.dev` URL.
- Preview builds use the current production canonical URL, not their temporary
  preview hostname.
- When the custom domain is attached, update `SITE_URL` to the final HTTPS
  hostname and redeploy before public promotion.
- Generate `robots.txt` from `SITE_URL`; do not commit a hostname-specific
  static file.

Cloudflare Pages adds `X-Robots-Tag: noindex` to preview deployments by default.
Verify that header on the pull-request preview. After a custom domain becomes
canonical, add host-specific rules to `site/public/_headers` to keep both the
production and versioned `*.pages.dev` hostnames out of search results while
leaving the custom domain indexable.

The base `site/public/_headers` file must also define and document the selected
static-site security headers. Validate the effective deployed headers; do not
assume the committed file alone proves Cloudflare applied them.

## Cloudflare Pages configuration

Connect the public GitHub repository to Cloudflare Pages with:

```text
Production branch: main
Root directory:    site
Build command:     npm install --global npm@11.6.2 && npm ci && npm run build
Build output:      dist
Node version:      24 (NODE_VERSION=24 and site/.node-version)
Canonical URL:     SITE_URL, initially the assigned production pages.dev URL
```

Expected deployment behavior:

- pushes to `main` create production deployments;
- pull requests from branches in this repository create preview deployments;
- preview deployment status is reported to the GitHub pull request;
- the initial production hostname uses `*.pages.dev`;
- the custom domain is attached only after the default deployment passes the
  launch checks;
- HTTPS is required;
- Cloudflare Web Analytics is enabled after the first deployment and verified
  after the next deployment.

Cloudflare configuration performed in the dashboard must be recorded in this
document or a later operations document so that the deployment can be
reproduced. Never place Cloudflare API tokens in the repository.

Official references:

- [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
- [Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- [Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare Pages preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
- [Enable Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/get-started/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

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
4. run formatting/linting, Astro checks, tests, and the production build;
5. run an internal-link check against the generated site;
6. upload the static build only as a diagnostic artifact when useful; it must
   not publish production independently of Cloudflare Pages.

The existing root workflow remains responsible for CLI and package tests.
Website-only changes must not weaken or bypass the existing repository checks.

## Validation strategy

### Automated

- Astro/type validation.
- Source linting and formatting checks.
- Focused component or behavior tests for interactive controls.
- Critical-content consistency checks against repository metadata.
- Production build from `npm ci`.
- Internal-link and missing-asset checks against `site/dist/`.
- HTML accessibility checks where reliable automation is available.
- Verification that preview deployments expose `X-Robots-Tag: noindex` once
  the Cloudflare integration exists.

### Manual

- Inspect home, documentation index, getting started, and 404 pages at mobile
  and desktop widths.
- Navigate the complete site using only the keyboard.
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

- Connect the GitHub repository to Cloudflare Pages.
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
- creating the Cloudflare Pages project;
- changing DNS or attaching a custom domain;
- merging the pull request;
- publicly announcing the website.
