import { defineConfig } from "astro/config";

// SITE_URL is the canonical production URL.
// Initially the assigned *.pages.dev URL; after custom domain, the final HTTPS hostname.
// Preview builds reuse the production canonical URL (not the preview hostname).
const SITE_URL = process.env.SITE_URL || "https://triss.pages.dev";

export default defineConfig({
  site: SITE_URL,
  output: "static",
  build: {
    format: "directory",
  },
});
