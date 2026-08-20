import fs from 'node:fs';
import path from 'node:path';
const dist = 'dist';
const htmlFiles = [...fs.readdirSync(dist, { recursive: true })].filter(f => f.endsWith('.html'));
console.log('built', htmlFiles.length, 'pages');
if (!fs.existsSync(path.join(dist, 'sitemap-index.xml'))) { console.error('missing sitemap'); process.exit(1); }
if (!fs.existsSync(path.join(dist, 'robots.txt'))) { console.error('missing robots'); process.exit(1); }
let broken = 0;
for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(dist, f), 'utf8');
  const hrefs = [...html.matchAll(/href="(\/[^"#?]*)"/g)].map(m => m[1]);
  for (const href of hrefs) {
    if (href.startsWith('/_astro') || href.startsWith('/favicon') || href.startsWith('/triss') || href.startsWith('/apple') || href.startsWith('/icon') || href.startsWith('/og-image') || href.startsWith('/site.webmanifest')) continue;
    const target = href === '/' ? 'index.html' : href.replace(/^\//, '') + '/index.html';
    const alt = href.replace(/^\//, '');
    if (!fs.existsSync(path.join(dist, target)) && !fs.existsSync(path.join(dist, alt)) && !fs.existsSync(path.join(dist, href.replace(/^\//, '')))) {
      console.error('broken link', href, 'in', f);
      broken++;
    }
  }
}
if (broken > 0) { console.error(broken, 'broken links'); process.exit(1); }
console.log('link check passed');
