# Triss Website Product Requirements

## Purpose

Build a fast, credible, public website that explains Triss to developers,
helps them install it, and routes them to the right documentation and project
resources.

The website is a presentation and documentation surface for the existing
open-source project. It is not a hosted Triss service.

## Primary audiences

1. Developers using Codex, Claude Code, or another coding agent who want to
   reduce expensive model-token usage.
2. Existing Triss users looking for installation, configuration, provider, or
   integration documentation.
3. Contributors evaluating the project's capabilities, maintenance quality,
   security posture, and source code.

## Product goals

- Explain the core value proposition within the first screen.
- Provide a copyable installation command without requiring navigation.
- Show how Triss fits between a coding agent and a cheaper delegated model.
- Make supported workflows, providers, and integrations easy to discover.
- Provide direct paths to documentation, npm, GitHub, releases, and issues.
- Establish an official canonical web presence that can use a custom domain.
- Collect privacy-oriented traffic and performance analytics.

## Non-goals for the first release

- Authentication, user accounts, dashboards, billing, or payments.
- Running Triss or accepting API keys in the browser.
- Contact forms or other server-side features.
- A custom content management system.
- Replacing every Markdown document in `docs/` on the first release.
- Event-level funnels, session replay, visitor profiling, or advertising
  analytics.

## Initial information architecture

### Home (`/`)

The home page must include:

- a concise headline and supporting description;
- a primary install command: `npm install -g triss-coworker`;
- primary calls to action for getting started and viewing the GitHub project;
- a short explanation of delegation and token savings;
- capability sections for bulk reading, reviews, content generation, coding
  delegation, and tracker integrations;
- a simple architecture or workflow explanation;
- links to npm, GitHub, documentation, changelog, and license;
- a clear statement that Triss is an open-source CLI/MCP tool, not a hosted
  service.

### Getting started (`/docs/getting-started/`)

The first documentation page must cover:

- Node.js requirements;
- npm, standalone, and source installation paths;
- basic provider configuration;
- `triss status` verification;
- one minimal `triss ask` example;
- links to deeper configuration and MCP documentation.

The instructions must remain consistent with the canonical repository
`README.md` and must not introduce a second, contradictory installation
contract.

### Documentation index (`/docs/`)

The documentation index must group links by task:

- installation and configuration;
- agent and MCP setup;
- model/provider guides;
- coding delegation;
- GitHub, GitLab, Jira, Linear, and Confluence integrations;
- usage accounting;
- extension and contribution guidance.

For the first release, pages that have not been migrated may link to their
canonical Markdown source on GitHub.

### Project links

The site must expose stable links to:

- GitHub repository: `https://github.com/ayleen/triss-coworker`;
- npm package: `https://www.npmjs.com/package/triss-coworker`;
- GitHub releases, issues, license, and changelog.

## Content principles

- Use clear developer-oriented English for the initial release.
- Prefer verifiable capability statements over broad marketing claims.
- Keep installation commands and compatibility requirements synchronized with
  the repository's canonical documentation.
- Do not present historical token savings as a universal guarantee. When the
  existing `60-70%` result is used, describe it as the project's observed or
  intended savings claim and link to its supporting context.
- Never publish provider keys, local paths, unpublished roadmap details, or
  private operational information.

## Visual and interaction requirements

- Responsive from 320 px mobile widths through large desktop displays.
- Keyboard-accessible navigation and controls.
- Semantic HTML with a logical heading hierarchy and visible focus states.
- Text and interactive-control contrast meeting WCAG 2.2 AA targets.
- Respect `prefers-reduced-motion`; core comprehension must not depend on
  animation.
- Copy buttons must provide visible success feedback and remain usable without
  JavaScript through manual text selection.
- Avoid a generic dashboard aesthetic. The site should feel like a focused
  developer tool with a distinct but restrained identity.

## Performance requirements

- Static output with no server runtime required for the first release.
- Avoid unnecessary client-side JavaScript and third-party scripts.
- Optimize images and fonts; do not ship large uncompressed media.
- Target a Lighthouse score of at least 90 for Performance, Accessibility,
  Best Practices, and SEO on the production build, while treating specific
  audit findings rather than the score alone as the acceptance evidence.

## SEO and sharing requirements

- Unique title and description for every public page.
- Canonical URL support configurable before the custom domain is attached.
- Open Graph and social-card metadata for the home page.
- `robots.txt` and an XML sitemap for production.
- A useful 404 page.
- Preview deployments must not be treated as canonical production content.
  Cloudflare Pages adds `X-Robots-Tag: noindex` to previews by default; verify
  the header on the real preview before launch.

## Analytics requirements

Enable Cloudflare Web Analytics after the initial Pages project is deployed.
The first release needs only:

- visits and page views;
- entry pages and paths;
- referring hosts;
- country, device, browser, and operating-system dimensions;
- page-load performance and Core Web Vitals.

Cloudflare Web Analytics does not currently provide custom events or UTM
parameter reporting. Consequently, outbound install, npm, and GitHub clicks
are not conversion metrics in the first release. Add another analytics product
only after a concrete event-level reporting requirement is approved.

Analytics implementation must not add cookies, fingerprinting, session replay,
or storage of visitor personal data in the first release.

## Security and privacy requirements

- No secrets in source, build arguments, generated HTML, or client-visible
  environment variables.
- No user-supplied HTML or runtime content ingestion.
- No forms, API routes, Pages Functions, or third-party embeds in the first
  release unless separately reviewed.
- External scripts are limited to the Cloudflare Web Analytics beacon unless
  another script is explicitly approved.
- Configure appropriate security headers and verify them on the deployed site.
- Use HTTPS for the default and custom domains.

## Launch criteria

The first production release is ready when:

- the required home, documentation index, and getting-started routes exist;
- repository, npm, installation, and documentation links are valid;
- the production build succeeds from a clean install;
- relevant automated tests, linting, type checks, and link checks pass;
- mobile and desktop layouts are visually inspected;
- keyboard navigation and visible focus behavior are verified;
- the Lighthouse target is checked against a production build;
- the pull-request preview is reviewed and approved;
- Cloudflare Pages deploys the merge commit from `main`;
- HTTPS works on the production hostname;
- Cloudflare Web Analytics receives a verified page view;
- sitemap, robots directives, canonical metadata, social metadata, and the 404
  page are verified on the deployed site.

Attaching the final custom domain may follow the first successful
`*.pages.dev` deployment, but the selected custom domain must become the
canonical hostname before public promotion begins.
