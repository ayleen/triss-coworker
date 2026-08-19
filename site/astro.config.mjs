import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// SITE_URL is the canonical production URL.
// Initially the assigned *.pages.dev URL; after custom domain, the final HTTPS hostname.
// Preview builds reuse the production canonical URL (not the preview hostname).
const SITE_URL = process.env.SITE_URL || "https://triss.pages.dev";

export default defineConfig({
  site: SITE_URL,
  output: "static",
  integrations: [sitemap()],
  build: {
    format: "directory",
  },
});
