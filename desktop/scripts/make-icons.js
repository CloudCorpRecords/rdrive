// Regenerates the PNG icons from the rdrive logo. Only needed when the logo changes:
//   npm install --no-save sharp && npm run icons
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const logo = fs.readFileSync(path.join(root, '..', 'public', 'icon.svg'));

// Monochrome folder-with-arrow for the macOS menu bar (template images must be black + transparent).
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path fill-rule="evenodd" d="M4 9a3 3 0 0 1 3-3h6l3 3h9a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z
    M16 23.5a1.4 1.4 0 0 0 1.4-1.4v-4.7l1.9 1.9a1.4 1.4 0 1 0 2-2l-4.3-4.3a1.4 1.4 0 0 0-2 0l-4.3 4.3a1.4 1.4 0 1 0 2 2l1.9-1.9v4.7a1.4 1.4 0 0 0 1.4 1.4z" fill="#000"/>
</svg>`;

async function png(svg, size, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(svg), { density: 1200 }).resize(size, size).png().toFile(out);
  console.log('wrote', path.relative(root, out));
}

(async () => {
  await png(logo, 1024, path.join(root, 'build', 'icon.png'));
  await png(logo, 256, path.join(root, 'assets', 'icon.png'));
  await png(logo, 32, path.join(root, 'assets', 'tray.png'));
  await png(template, 16, path.join(root, 'assets', 'trayTemplate.png'));
  await png(template, 32, path.join(root, 'assets', 'trayTemplate@2x.png'));
})();
