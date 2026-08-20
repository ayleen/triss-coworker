import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// SITE_URL is the canonical production URL.
// The custom domain is the repository default; Workers Builds may override it explicitly.
// Preview builds reuse the production canonical URL (not the preview hostname).
const SITE_URL = process.env.SITE_URL || "https://triss.work";

export default defineConfig({
  site: SITE_URL,
  output: "static",
  integrations: [sitemap()],
  build: {
    format: "directory",
  },
});
