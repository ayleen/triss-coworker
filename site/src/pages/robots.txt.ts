import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const s = site?.toString().replace(/\/$/, "") || "https://triss.work";
  const body = `User-agent: *\nAllow: /\nSitemap: ${s}/sitemap-index.xml\n`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
