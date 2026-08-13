import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToMarkdown, fetchUrl, fetchAsMarkdown } from '../src/web.js';
import { requestSequence } from './helpers/http-request.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('htmlToMarkdown turns headings, paragraphs, lists into markdown', () => {
  const html = `
    <html><body>
      <h1>Title</h1>
      <p>Hello <strong>world</strong>.</p>
      <ul><li>one</li><li>two</li></ul>
    </body></html>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /^# Title/m);
  assert.match(md, /Hello \*\*world\*\*\./);
  assert.match(md, /-\s+one/);
  assert.match(md, /-\s+two/);
});

test('htmlToMarkdown drops nav/aside/footer/script/style noise', () => {
  const html = `
    <html><body>
      <nav>navnoise</nav>
      <aside>asidenoise</aside>
      <footer>footernoise</footer>
      <script>alert(1)</script>
      <style>.x{}</style>
      <main><p>Real content.</p></main>
    </body></html>`;
  const md = htmlToMarkdown(html);
  assert.equal(md.includes('navnoise'), false);
  assert.equal(md.includes('asidenoise'), false);
  assert.equal(md.includes('footernoise'), false);
  assert.equal(md.includes('alert(1)'), false);
  assert.equal(md.includes('.x{}'), false);
  assert.match(md, /Real content/);
});

test('htmlToMarkdown prefers <main> or <article> when present', () => {
  const html = `
    <html><body>
      <header>headernoise</header>
      <article><h2>Article</h2><p>Body.</p></article>
      <p>Outside paragraph that should be ignored.</p>
    </body></html>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /## Article/);
  assert.match(md, /Body\./);
  assert.equal(md.includes('Outside paragraph'), false);
});

test('fetchUrl rejects non-http(s) URLs', async () => {
  await assert.rejects(() => fetchUrl('file:///etc/passwd'), /non-http\(s\)/);
  await assert.rejects(() => fetchUrl('ftp://example.com/'), /non-http\(s\)/);
});

test('fetchUrl raises with status on non-2xx', async () => {
  const requestImpl = requestSequence([{
    status: 404,
    statusText: 'Not Found',
    headers: { 'content-type': 'text/html' },
    body: '<html>not here</html>',
  }]);
  await assert.rejects(
    () => fetchUrl('https://example.com/missing', { requestImpl, lookupImpl: publicLookup }),
    /HTTP 404/,
  );
});

test('fetchAsMarkdown returns text verbatim for non-html content', async () => {
  const requestImpl = requestSequence([{
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  }]);
  const out = await fetchAsMarkdown('https://example.com/data.json', {
    requestImpl,
    lookupImpl: publicLookup,
  });
  assert.equal(out.markdown, '{"a":1}');
  assert.match(out.contentType, /json/);
});

test('fetchAsMarkdown converts html content', async () => {
  const requestImpl = requestSequence([{
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<html><body><h1>X</h1><p>p</p></body></html>',
  }]);
  const out = await fetchAsMarkdown('https://example.com/x', {
    requestImpl,
    lookupImpl: publicLookup,
  });
  assert.match(out.markdown, /^# X/m);
  assert.match(out.markdown, /\np$/);
});
