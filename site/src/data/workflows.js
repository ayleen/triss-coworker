// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Single source for the three delegation workflow cards shared by the
// homepage and the /workflows/ catalog. Order: research, review, implementation.
export const WORKFLOWS = [
  {
    slug: "research",
    title: "Understand unfamiliar code",
    description:
      "Ask a focused question about selected files and bring source-backed findings into your main agent's context.",
    href: "/workflows/research/",
    cta: "Explore research workflow",
  },
  {
    slug: "review",
    title: "Get a second review",
    description:
      "Review a branch or pull request, inspect each finding, and decide what needs to change.",
    href: "/workflows/review/",
    cta: "Explore review workflow",
  },
  {
    slug: "implementation",
    title: "Delegate a bounded change",
    description:
      "Run an implementation task through a coding engine, inspect the resulting changes, and accept only what you have verified.",
    href: "/workflows/implementation/",
    cta: "Explore implementation workflow",
  },
];
