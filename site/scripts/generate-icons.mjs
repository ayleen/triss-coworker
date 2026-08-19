import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');
async function svgToPng(svgPath, pngPath, size) {
  const svg = await fs.promises.readFile(svgPath, 'utf8');
  await sharp(Buffer.from(svg)).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(pngPath);
  console.log('ok ' + path.basename(pngPath) + ' ' + size + 'x' + size);
}
async function faviconIco() {
  const faviconSvg = path.join(publicDir, 'favicon.svg');
  for (const s of [16, 32, 48]) {
    await svgToPng(faviconSvg, path.join(publicDir, 'favicon-' + s + 'x' + s + '.png'), s);
  }
  const fav32 = await fs.promises.readFile(path.join(publicDir, 'favicon-32x32.png'));
  await fs.promises.writeFile(path.join(publicDir, 'favicon.ico'), fav32);
  console.log('ok favicon.ico');
}
async function appleAndPwa() {
  const faviconSvg = path.join(publicDir, 'favicon.svg');
  await svgToPng(faviconSvg, path.join(publicDir, 'apple-touch-icon.png'), 180);
  await svgToPng(faviconSvg, path.join(publicDir, 'icon-192.png'), 192);
  await svgToPng(faviconSvg, path.join(publicDir, 'icon-512.png'), 512);
}
async function variants() {
  const mark = await fs.promises.readFile(path.join(publicDir, 'triss-mark.svg'), 'utf8');
  const monoWhite = mark.replace(/#D97757/g, '#ffffff').replace(/#61D7EF/g, '#ffffff');
  await fs.promises.writeFile(path.join(publicDir, 'triss-mark-mono-white.svg'), monoWhite);
  console.log('ok triss-mark-mono-white.svg');
  const monoDark = mark.replace(/#D97757/g, '#111C29').replace(/#61D7EF/g, '#111C29');
  await fs.promises.writeFile(path.join(publicDir, 'triss-mark-mono-dark.svg'), monoDark);
  console.log('ok triss-mark-mono-dark.svg');
  const logo = await fs.promises.readFile(path.join(publicDir, 'triss-logo.svg'), 'utf8');
  const logoLight = logo.replace('fill="#111C29"', 'fill="#ffffff"');
  await fs.promises.writeFile(path.join(publicDir, 'triss-logo-light.svg'), logoLight);
  console.log('ok triss-logo-light.svg');
  await fs.promises.writeFile(path.join(publicDir, 'triss-logo-dark.svg'), logo);
  console.log('ok triss-logo-dark.svg');
}
await faviconIco();
await appleAndPwa();
await variants();
console.log('All icons generated');
