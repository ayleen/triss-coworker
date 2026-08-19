# Triss Website

This directory contains the product and engineering documentation for the
official Triss project website.

## Current status

The website is in the planning stage. No production site or custom domain is
configured yet.

The agreed delivery model is:

- keep the website source in `site/` in this repository;
- develop changes on short-lived branches and review them through pull
  requests;
- use Cloudflare Pages preview deployments for pull requests;
- deploy the `main` branch to production;
- enable Cloudflare Web Analytics for privacy-oriented, page-level analytics;
- attach a custom domain after the default `*.pages.dev` deployment is
  validated.

The repository is public. Website source, build configuration, and client-side
environment values must therefore be treated as public. Secrets must never be
stored in the repository or exposed to browser code.

## Documents

- [Product requirements](product-requirements.md) defines the audience,
  initial scope, content, quality requirements, and launch criteria.
- [Implementation plan](implementation-plan.md) defines the repository
  structure, technical architecture, Cloudflare configuration, validation,
  and delivery sequence.
- [Brand direction](brand-direction.md) records the initial logo, favicon, and
  mascot concept, including its production-readiness limitations.

## Development workflow

The production source belongs in `main`, but implementation work must not be
performed directly on `main`.

1. Create a short-lived branch from the latest `origin/main` in an isolated
   worktree.
2. Implement and validate the change locally.
3. Push the branch and, once the Pages integration exists, inspect its
   Cloudflare Pages preview deployment.
4. Open a pull request and wait for required repository checks and review.
5. Merge only after approval. A merge to `main` triggers the production site
   deployment.

The initial planning worktree is:

```text
Branch:   codex/project-website
Worktree: .claude/worktrees/project-website
Base:     origin/main
```

Do not commit generated site output. Cloudflare Pages must build it from the
reviewed source.

Before the Cloudflare project is configured, a clean local production build
and the website CI workflow replace the preview-deployment step. The first
Cloudflare preview becomes a mandatory launch gate after the separately
approved GitHub integration is installed.

## Decisions

- **Visual identity — decided 2026-08-19:** adopt the prototype design from
  `/Volumes/Orange/tmp/triss-site-draft.zip` (7 `*.dc.html` pages,
  `uploads/index.css` Tailwind v4 tokens, `uploads/Untitled-2.fig`).
  Production palette is the prototype palette (`#0b0d10` background,
  `#5fb464` accent) with `IBM Plex Sans` / `IBM Plex Mono` (fallbacks
  `Outfit` / `Source Code Pro` from the Tailwind build). The copper/cyan
  palette in `brand-direction.md` v2 remains the character/mascot
  direction but is not the website palette.
- **Logos and marks — decided 2026-08-19:** regenerate all production
  logos, marks, and favicons with `agy` (do not copy
  `brand-concepts/*.png` into `site/public` unchanged). See
  `brand-direction.md` for the agy brief and export checklist.

## Decisions still required

These decisions do not block local implementation:

- final custom domain and canonical hostname;
- whether a later phase needs event-level product analytics in addition to
  Cloudflare Web Analytics;
- whether the public documentation should eventually become a complete
  website-native copy of the repository documentation.
