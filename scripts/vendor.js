#!/usr/bin/env node
// Copies the prebuilt browser bundles of the document/spreadsheet format libraries into
// public/vendor/. They're devDependencies, so the server itself keeps a single runtime
// dependency; the browser loads these files on demand (only when importing/exporting).
//   npm run vendor          refresh public/vendor after updating a library
//   npm run vendor -- --check   fail if public/vendor is out of date (used by the tests)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');

// [published file name, package, file inside the package]
const BUNDLES = [
  ['exceljs.min.js', 'exceljs', 'dist/exceljs.min.js'],
  ['jszip.min.js', 'jszip', 'dist/jszip.min.js'],
  ['mammoth.browser.min.js', 'mammoth', 'mammoth.browser.min.js'],
  ['docx.iife.js', 'docx', 'dist/index.iife.js'],
  ['qrcode.js', 'qrcode-generator', 'dist/qrcode.js'],
];

function source(pkg, file) {
  return path.join(root, 'node_modules', pkg, file);
}

function versionOf(pkg) {
  return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;
}

function licenseText(pkg) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.markdown', 'LICENSE.txt', 'license']) {
    const f = path.join(root, 'node_modules', pkg, name);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  }
  return '(see the package on npm)';
}

function expectedFiles() {
  const files = {};
  const notices = ['# Third-party browser bundles', '', 'Copied from npm by `npm run vendor`. Loaded only when importing or exporting files.', ''];
  for (const [name, pkg, file] of BUNDLES) {
    files[name] = fs.readFileSync(source(pkg, file));
    notices.push(`## ${pkg} ${versionOf(pkg)} → ${name}`, '', '```', licenseText(pkg), '```', '');
  }
  files['LICENSES.md'] = Buffer.from(notices.join('\n'));
  return files;
}

const check = process.argv.includes('--check');
const files = expectedFiles();
let stale = [];
for (const [name, buf] of Object.entries(files)) {
  const target = path.join(out, name);
  if (check) {
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(buf)) stale.push(name);
  } else {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(target, buf);
    console.log(`wrote public/vendor/${name} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
}
if (check && stale.length) {
  console.error(`public/vendor is out of date (${stale.join(', ')}). Run: npm run vendor`);
  process.exit(1);
}
module.exports = { BUNDLES };
