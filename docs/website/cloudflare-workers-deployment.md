# Cloudflare Workers deployment runbook

This runbook describes the current Cloudflare Workers Builds deployment for
the static Astro site in `site/`. It replaces the legacy Cloudflare Pages
setup instructions.

## Deployment contract

```text
Worker name:                  triss
Production URL:               https://triss.work/
Technical Worker URL:         https://triss.ikar-autobridge.workers.dev/
Git repository:               ayleen/triss-coworker
Production branch:            main
Root directory:               site
Build command:                npm run build
Deploy command:               npx wrangler deploy
Non-production deploy command:npx wrangler versions upload
Node version:                 24
Package manager:              npm 11.6.2
Build watch include paths:    *
Build watch exclude paths:    (empty)
Static asset directory:       site/dist/
```

The committed `site/wrangler.jsonc` is authoritative for the Worker name,
compatibility date, preview URLs, asset directory, HTML routing, and custom
404 behavior. `SITE_URL` controls Astro canonical URLs, sitemap output, and
`robots.txt`; its repository default is the canonical custom domain.

## Connect the existing Worker to GitHub

Keep the existing `triss` Worker. Connecting it to the repository will replace
the starter `Hello world` implementation on the next successful production
deployment.

1. Open Cloudflare Dashboard and select **Workers & Pages**.
2. Select the **triss** Worker.
3. Open **Settings** and then **Build**.
4. In the repository/build section, choose **Connect to Git** or **Add build**.
   The exact button label may differ depending on whether the Worker has ever
   had a build configuration.
5. Authorize the Cloudflare GitHub application for
   `ayleen/triss-coworker` if it is not already authorized.
6. Set the build fields exactly as follows:

   ```text
   Git repository:                    ayleen/triss-coworker
   Git branch:                        main
   Root directory:                    site
   Build command:                     npm run build
   Deploy command:                    npx wrangler deploy
   Non-production branch command:     npx wrangler versions upload
   ```

7. If the Build variables section is present, add `NODE_VERSION=24`. If
   `SITE_URL` is present, set it to `https://triss.work`; do not set
   `SKIP_DEPENDENCY_INSTALL`, because Workers Builds must install the locked
   site dependencies before running Astro.
8. Set the build watch **Include paths** to the single value `*` and leave
   **Exclude paths** empty. Cloudflare uses `*` as the default match-all rule;
   an empty include list or several space-separated globs entered as one value
   can suppress production builds.
9. Save the build configuration. Updated settings affect the next build.
10. Open **Deployments**, then **View build history**, and retry the latest
   `main` build or push a new reviewed commit to `main`.

Do not use **Edit code** to paste generated HTML into the starter Worker. The
repository build and Wrangler upload are the reproducible deployment path.

## Expected build behavior

Workers Builds runs in `site/`, installs dependencies from
`site/package-lock.json`, runs `npm run build`, and then runs
`npx wrangler deploy`. Wrangler reads `site/wrangler.jsonc` and uploads
`site/dist/` as Workers Static Assets to the existing `triss` Worker.

For enabled non-production branch builds, Cloudflare uses
`npx wrangler versions upload`. This creates a version without promoting it to
production. Its URL has the form:

```text
https://<version-prefix>-triss.ikar-autobridge.workers.dev/
```

Find it in **Workers & Pages → triss → Deployments**, then select the version.
Preview URLs are public by default. Do not treat them as canonical production
content or publish them as permanent links.

## Verify a production deployment

In **Workers & Pages → triss → Deployments**, confirm that the active
production version came from the expected `main` commit and that both build
and deployment completed successfully.

Then verify:

```sh
curl -fsS https://triss.work/ | grep -q '<title>'
curl -fsSI https://triss.work/
curl -fsS https://triss.work/robots.txt
curl -fsS https://triss.work/sitemap-index.xml
curl -fsS -o /dev/null -w '%{http_code}\n' \
  https://triss.work/this-route-must-not-exist
```

Acceptance requires:

- the home page returns HTML, not `Hello world`;
- `/cost/`, `/commands/`, `/coder/`, `/integrations/`, `/security/`, and
  `/docs/` return 200;
- an unknown route returns the custom 404 page with status 404;
- canonical, Open Graph, `robots.txt`, and sitemap URLs use
  `https://triss.work`;
- `_headers` rules are present on HTML responses;
- fonts, images, CSS, and JavaScript load without failed requests;
- the deployed pages pass the same responsive, accessibility, and Lighthouse
  acceptance used by `.github/workflows/site.yml`.

## Custom domain

The canonical custom domain is `triss.work`. To reproduce or repair its
configuration after the workers.dev deployment passes acceptance:

1. Open **Settings → Domains & Routes** for `triss`.
2. Add `triss.work` as the custom domain.
3. Set the Workers Builds variable `SITE_URL` to `https://triss.work` with no
   trailing slash.
4. Redeploy `main`.
5. Verify canonicals, sitemap, robots directives, HTTPS, and redirect behavior.
6. Add a host-specific `X-Robots-Tag: noindex` rule for the workers.dev host
   only after the custom domain has become canonical.

Changing DNS or attaching a custom domain remains a separate production
action and requires explicit authorization.

## Web Analytics

Enable Cloudflare Web Analytics only after the production site serves the
expected Astro build. Verify that a real page view and Web Vitals appear after
the next deployment. No analytics token or secret belongs in the repository.

## Rollback

If a production build is broken, open **Deployments**, select the last known
good version, and use the dashboard rollback/promote action. Record the
restored version and commit. Then fix the repository and deploy a new reviewed
commit; do not leave dashboard-only code as the long-term production source.

## Local verification

From `site/`:

```sh
npm ci
npm run check
npm run lint
npm run build
npm test
npm run cloudflare:check
```

`cloudflare:check` performs a Wrangler dry run against the committed static
asset configuration and does not publish anything.

## Official references

- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers Builds watch paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/)
- [Workers Static Assets SSG and 404 routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
- [Workers Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Workers preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/get-started/)
