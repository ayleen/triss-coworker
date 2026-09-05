# Triss Website Product Requirements

## Purpose

Build a fast, credible, public website that explains Triss to developers,
helps them install it, and routes them to the right documentation and project
resources.

The website is a presentation and documentation surface for the existing
open-source project. It is not a hosted Triss service.

## Positioning (owner decision, 2026-09-05)

Triss is a **managed delegation layer for AI development**: a local,
open-source CLI and MCP server. Users delegate bounded parts of AI
development — codebase research, second reviews, and limited implementation —
choose the models and coding engines for that work, and inspect the result
before accepting it.

Cost savings are a secondary, route-dependent benefit. They must never be
presented as the product definition or as a universal guarantee.

## Primary audiences

1. Developers already using Claude Code or Codex who need to delegate
   research, a second opinion on changes, or a bounded implementation task
   through tools they choose.
2. Maintainers and small teams who want repeatable workflows and one common
   interface to supported models, engines, and trackers.
3. Existing Triss users looking for installation, configuration, provider, or
   integration documentation.

This revision does not extend the audience to marketers, non-developers,
enterprise fleet management, or hosted-service buyers.

## Product goals

- Communicate the managed-delegation promise within the first screen:
  delegate research, review, and implementation; choose your models and
  engines; keep control of what ships.
- Show one real, recorded, manually verified example of delegated research
  instead of invented demo output.
- Make the three workflows (research, review, implementation) the primary
  navigation metaphor, each explaining what to provide, what to inspect, and
  when to keep the work in the main agent.
- Provide a copyable installation command without requiring navigation.
- Present model/engine choice, data boundaries, execution isolation, and
  acceptance honestly, including current limitations.
- Keep cost content available with its methodology, clearly scoped as one
  part of the decision.
- Provide direct paths to documentation, commands reference, npm, GitHub,
  releases, and issues.

## Non-goals

- Authentication, user accounts, dashboards, billing, or payments.
- Running Triss or accepting API keys in the browser.
- Contact forms or other server-side features.
- A custom content management system or a full migration of `docs/` onto the
  site.
- Automated model selection, schedulers, parallel agent teams, or automatic
  task chains (product runtime scope, not website scope).
- Event-level funnels, session replay, visitor profiling, or advertising
  analytics.
- Comparative quality benchmarks across models. A single recorded case study
  is not a benchmark.

## Information architecture

| Route | Content |
| --- | --- |
| `/` | Hero with category, headline, CTAs, copyable install, and a real recorded example; three workflow cards; how it works; why add Triss; controls and boundaries; cost summary; commands and install sections |
| `/workflows/` | Catalog of the three delegation workflows |
| `/workflows/research/` | Understand unfamiliar code: provide, run, inspect, recorded example, limits |
| `/workflows/review/` | Second review: prerequisites, run variants (branch, PR, stdin), inspect, use the result, limits |
| `/workflows/implementation/` | Bounded change: define, run isolated, locate and inspect the worktree, verify, accept or cleanly reject |
| `/docs/getting-started/` | Short quickstart with Claude Code / Codex / Terminal instructions; advanced setup in optional disclosures below |
| `/docs/` | Documentation entry point grouped by task |
| `/coder/` | Coding engines, worktree isolation, execution results, verification |
| `/integrations/` | Project context reading and explicit operations with setup links |
| `/security/` | Trust-boundary summary and precise data-flow, logging, and credential documentation |
| `/cost/` | Calculator, methodology, and the recorded historical usage example |
| `/commands/` | Searchable command reference |
| 404 | A real 404 response |

Do not rename existing URLs. Homepage anchors `#top`, `#how`, `#commands`,
and `#install` must remain meaningful.

## Content principles

- Use clear developer-oriented English.
- Prefer verifiable capability statements over broad marketing claims; the
  public-claims contract in the managed-delegation implementation plan is
  binding for wording.
- Recorded model output is published only as verified excerpts labeled as
  excerpts, with source links to a public commit, and honest limitations.
- Keep installation commands and compatibility requirements synchronized with
  the repository's canonical documentation.
- Present current technical limitations as limitations of the current version,
  never as permanent prohibitions, and never silently replace a user's
  provider or engine choice in examples.
- Never publish provider keys, local paths, session IDs, unpublished roadmap
  details, or private operational information.

## Visual and interaction requirements

- Mobile-first responsive behavior from 320 px through large desktop
  displays, with an explicit disclosure reset when the viewport crosses the
  900 px navigation breakpoint.
- No horizontal overflow at 320 px, 375 px, 768 px, 900 px, or desktop widths.
- Keyboard-accessible navigation and controls with semantic screen-reader
  names, state (`aria-expanded` / `aria-pressed`) and visible focus states.
- Layout must remain usable at 200% text zoom and preserve safe-area insets on
  notched mobile devices.
- Touch targets should follow Apple HIG guidance (at least 44 CSS px where a
  control is intended for touch).
- Semantic HTML with a logical heading hierarchy and exactly one `h1` per
  page.
- Contrast and focus indicators must meet WCAG 2.2 AA targets.
- Respect `prefers-reduced-motion`; core comprehension must not depend on
  animation.
- User-provided strings (including search queries) must be inserted with safe
  DOM APIs such as `textContent`, never as executable HTML.
- Copy buttons must report success only after a successful clipboard write
  and remain usable without JavaScript through manual text selection.
- All meaningful content, commands, and links must be present in the built
  HTML without JavaScript. Client scripts are progressive enhancement only.

## Performance requirements

- Static build-time rendering (Astro); no server runtime.
- Avoid unnecessary client-side JavaScript and third-party scripts.
- Optimize images and fonts; do not ship large uncompressed media.
- Target a Lighthouse score of at least 90 for Performance, Accessibility,
  Best Practices, and SEO on the production build, while treating specific
  audit findings rather than the score alone as the acceptance evidence.
- Fonts must be self-hosted; no runtime third-party font service.

## SEO and sharing requirements

- Unique title and description for every public page.
- Canonical URLs on `https://triss.work` for production and previews.
- Open Graph and social-card metadata, with a reproducible social card image
  that matches the current positioning.
- `robots.txt` and an XML sitemap for production, covering new routes.
- A useful 404 page served with HTTP 404.
- Workers version previews are public by default; keep the production
  canonical URL in their HTML and keep workers.dev hosts out of the index
  with a host-specific `X-Robots-Tag: noindex` rule.

## Analytics requirements

Cloudflare Web Analytics only, as configured for the first release:
page-level visits, paths, referring hosts, device dimensions, and performance.
It must not add cookies, fingerprinting, session replay, or storage of visitor
personal data. Add another analytics product only after a concrete
event-level reporting requirement is approved.

## Security and privacy requirements

- No secrets in source, build arguments, generated HTML, or client-visible
  environment variables.
- No user-supplied HTML or runtime content ingestion.
- No forms, API routes, Worker scripts, or third-party embeds unless
  separately reviewed.
- External scripts are limited to the Cloudflare Web Analytics beacon unless
  another script is explicitly approved.
- Security headers configured and verified on the deployed site.
- HTTPS for all public origins.

## Acceptance (managed-delegation revision)

The repositioned site is ready when:

- the three workflow routes, the catalog, and the reworked home and
  quickstart pages exist and build cleanly;
- the recorded research example is real, manually verified against its public
  source commit, and its source links open;
- every removed calculator/preview behavior is gone from the homepage while
  the `/cost/` calculator keeps working;
- automated site suites, browser acceptance (viewports, zoom, keyboard, touch,
  reduced motion, hostile input), and Lighthouse >= 90 pass on the production
  build, including the new routes;
- the social card image is regenerated reproducibly and no old cheap-DeepSeek
  messaging remains in metadata, manifest, or imagery;
- no-JS rendering exposes all content, commands, and setup variants;
- documentation pages, README, and CHANGELOG state one consistent
  positioning;
- production deployment itself still requires the owner's approval.
