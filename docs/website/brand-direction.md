# Triss Brand Direction

## Status

Version 2 is the current visual direction for review. It corrects version 1,
which was created without first inspecting the existing Triss promo identity.
Version 1 is superseded and must not be used as a source for the website.

The version 2 concepts were generated through the Antigravity CLI with Gemini
3.1 Pro High after inspecting a minimized set of five approved references:

- the user-provided red-haired mage reference;
- `docs/promo/triss.jpeg`, including its established Triss character and mark;
- `docs/promo/reddit-card-grass-2026-07.png`, including its fire-orange
  character motif;
- the existing dark Medium cover and DeepSeek field-report promo card.

All concept files remain raster references under
`docs/website/brand-concepts/`. They are not production-ready website assets.

### Adopted website design — 2026-08-19

For the website implementation the prototype in
`/Volumes/Orange/tmp/triss-site-draft.zip` is adopted as the visual source
of truth. It defines the production website palette, typography, and layout
tokens (see prototype audit below). The v2 copper/cyan palette and the
mage-character traits remain the direction for mascot/illustration work but
are **not** the website chrome palette.

Prototype design tokens (extracted from `Triss Landing.dc.html` and
`uploads/index.css`):

| Token | Value | Usage |
| --- | --- | --- |
| Page background | `#0b0d10` | body, header, sections |
| Raised surface | `#0f1114` / `#08090b` | cards, code blocks |
| Border | `#1a1d23` / `#252830` / `#1e2128` | section dividers, inputs |
| Primary accent | `#5fb464` | CTA, links, highlights, slider thumb |
| Accent hover | `#74c479` / `#9ad39e` | button hover, link hover |
| Primary text | `#fbfcfd` / `#f4f6f8` / `#e2e8f0` | headings, body |
| Secondary text | `#a3adbc` / `#8b95a5` | descriptions |
| Muted text | `#78828f` / `#5f6874` | labels, captions |
| Danger / strikethrough | `#f87171` | old cost comparison |
| Typography | self-hosted `IBM Plex Sans` 400/500/600/700 + `IBM Plex Mono` 400/500/600 | system fallback only; pinned WOFF2 assets and OFL license in `site/public/fonts/` |
| Layout | `max-width: 1140px`, 32px gutter, 60px sticky header | all pages |

## Brand idea

Triss is an adult red-haired female mage and a calm, capable developer-tool
coworker. She takes repetitive, token-heavy work away from the primary coding
agent while keeping the handoff visible and controlled.

The identity combines:

- long, curly copper-red hair as the primary character identifier;
- teal or emerald practical fantasy clothing with restrained leather details;
- cyan-blue magic representing delegated work;
- the dark graphite surfaces and clear typography already used in Triss promo
  materials;
- a compact copper curl or flame around a cyan spark as the product mark.

The character should follow the supplied attributes and established promo
identity without being a pixel copy of the reference image.

## Personality

- Intelligent, composed, confident, and slightly knowing.
- Helpful without being childish or subservient.
- Magical without excessive medieval ornament.
- Technical without becoming a generic AI-brain or cyberpunk character.

## Character anchor

The stable character traits are:

- adult woman;
- long curly copper-red hair;
- green, teal, or emerald eyes;
- teal or emerald clothing;
- practical leather trim rather than ceremonial armor;
- cyan-blue magical flame or spell light;
- warm, capable expression.

Avoid purple-dominant cyber styling, anime styling, generic witch hats, and
unrelated character redesigns.

## Core mark

The version 2 mark uses a copper-red hair curl or flame wrapped around a small
cyan magical spark. It can be read as:

- Triss's red hair without requiring a detailed portrait;
- a focused magical action;
- a subtle `T` or circular handoff in negative space;
- a compact symbol that can survive favicon-scale reduction.

The mark should remain recognizable without the wordmark and at 16 pixels.

## Palette

The palette starts from the existing promo materials and the corrected
character direction:

| Role | Color | Hex |
| --- | --- | --- |
| Primary page background | Near-black | `#080A0F` |
| Raised promo surface | Graphite | `#151817` |
| Primary text and light surface | Warm off-white | `#F7F4EC` |
| Hair and flame mark | Copper red | `#D97757` |
| Magic and active accent | Cyan | `#61D7EF` |
| Supporting success accent | Mint green | `#57D79B` |
| Dark wordmark | Ink | `#111C29` |

Production assets should use flat, explicitly sampled colors. Raster concept
shading must not become an implicit color specification.

## Current concept files

| Asset | File | Dimensions | Current limitation |
| --- | --- | ---: | --- |
| Project mascot v2 | `brand-concepts/triss-mascot-concept-v2.png` | 1024 × 1024 | RGB on white; no alpha channel |
| Horizontal logo v2 | `brand-concepts/triss-logo-horizontal-concept-v2.png` | 1024 × 1024 | Horizontal lockup inside a square RGB canvas; no alpha |
| Favicon source v2 | `brand-concepts/triss-favicon-concept-v2.png` | 1024 × 1024 | RGB concept; needs deterministic small-size exports |

The older `*-v1.png` files are retained only for traceability and are
superseded.

## Productionization requirements

Do not copy the concept files into `site/public/` unchanged. Generate
production assets with `agy` (the project image-generation CLI) — do not
use `triss` in this worktree.

Before website integration:

1. Approve or revise the version 2 visual direction.
2. Reconstruct the curl-and-spark mark as deterministic SVG geometry.
3. Select a redistribution-safe wordmark typeface or draw a custom wordmark.
4. Produce horizontal, mark-only, monochrome, light-surface, and dark-surface
   SVG variants.
5. Produce real transparent mascot artwork if the character is retained in the
   website hero.
6. Export and visually inspect favicon variants at 16, 32, 48, 180, 192, and
   512 pixels; provide `favicon.ico` where required.
7. Verify contrast, small-size legibility, and browser-tab appearance.
8. Perform a basic visual and trademark collision search before final adoption.

## Generation brief (for `agy`)

Create a coherent identity for Triss as an adult red-haired female mage:
long curly copper-red hair, an intelligent composed expression, teal or emerald
practical fantasy clothing, subtle leather details, and cyan-blue magic. Keep
her warm, capable, and appropriate for an open-source developer-tool coworker.

Generate three related assets:

- a polished bust or three-quarter mascot portrait with no text;
- a minimal horizontal logo with the exact wordmark `Triss` and a copper curl
  or flame wrapped around a cyan spark;
- a mark-only favicon using the same curl and spark on a dark graphite tile.

Avoid purple-dominant styling, anime, AI brains, portal brackets, flower or leaf
logos, witch hats, excessive ornament, photorealistic faces, mockups,
watermarks, extra text, and misspelled wordmarks.
