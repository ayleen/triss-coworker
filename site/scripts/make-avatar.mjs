import sharp from 'sharp';
const size = 256;
const circleSvg = `<svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/></svg>`;
await sharp('public/triss-mascot.webp').resize(size, size, { fit: 'cover', position: 'center' }).composite([{ input: Buffer.from(circleSvg), blend: 'dest-in' }]).png().toFile('public/triss-avatar.png');
console.log('avatar ok');
