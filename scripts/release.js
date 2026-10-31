#!/usr/bin/env node
// Releases rdrive: one command, and the desktop apps (Windows, Mac) and the Android app update themselves.
//
//   npm run release -- 0.5.1              bump the version everywhere, commit, tag v0.5.1, push
//   npm run release -- 0.5.1 --dry-run    show what it would change, change nothing
//   npm run release -- 0.5.1 --no-android skip the Android app (e.g. releasing from a computer without its key)
//   node scripts/release.js --notes 0.5.1 print the release notes (the release workflow uses this)
//
// Before running it, write what changed under "## 0.5.1" at the top of docs/CHANGELOG.md. It refuses to go on
// without that, with uncommitted changes, off main, or out of sync with GitHub.
//
// The Android app is built and signed here, with your own key (~/.rdrive-android), and attached to a draft
// release: the key never leaves this computer, and phones only accept updates signed with it. Pushing the tag
// then starts .github/workflows/release.yml, which builds the Windows installer and the Mac .dmg files, writes
// SHA256SUMS.txt (the updaters check every download against it) and publishes the release. Installed copies see
// it within a few hours and update. Uses only Node's standard library plus git, gh and Gradle.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REPO = 'CloudCorpRecords/rdrive';
const GRADLE_FILE = 'android/app/build.gradle.kts';
// Every place the version is written: [file, regex with the version in group 1].
const PLACES = [
  ['package.json', /^ {2}"version": "([^"]+)"/m],
  ['package-lock.json', /^ {2}"version": "([^"]+)"/m],
  ['package-lock.json', /^ {4}"": \{\r?\n {6}"name": "rdrive",\r?\n {6}"version": "([^"]+)"/m],
  ['desktop/package.json', /^ {2}"version": "([^"]+)"/m],
  ['desktop/package-lock.json', /^ {2}"version": "([^"]+)"/m],
  ['desktop/package-lock.json', /^ {4}"": \{\r?\n {6}"name": "rdrive-desktop",\r?\n {6}"version": "([^"]+)"/m],
  [GRADLE_FILE, /versionName = "([^"]+)"/],
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const current = () => JSON.parse(read('package.json')).version;

// The lines under "## <version>" up to the next "## " heading (plain text matching, no regex from input).
function changelogSection(version) {
  const lines = read('docs/CHANGELOG.md').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

function notes(version) {
  const base = `https://github.com/${REPO}/releases`;
  const dl = (f) => `[${f}](${base}/download/v${version}/${f})`;
  return `## Download

| | |
|---|---|
| **Windows** (10 or 11, 64-bit) | ${dl(`rdrive-${version}-x64-setup.exe`)} |
| **Mac** (Apple silicon) | ${dl(`rdrive-${version}-arm64.dmg`)} |
| **Mac** (Intel) | ${dl(`rdrive-${version}-x64.dmg`)} |
| **Android** (8 or newer) | ${dl(`rdrive-${version}.apk`)} |
| **Server** (Docker) | \`docker pull ghcr.io/cloudcorprecords/rdrive:${version}\` |

Links that always give the newest version: [Windows](${base}/latest/download/rdrive-Windows-Setup.exe) · [Mac (Apple silicon)](${base}/latest/download/rdrive-Mac-AppleSilicon.dmg) · [Mac (Intel)](${base}/latest/download/rdrive-Mac-Intel.dmg) · [Android](${base}/latest/download/rdrive-Android.apk)

**Already have rdrive?** It updates itself. The desktop app checks every few hours (tray → *Check for updates* to check now); a drive hosted on the computer updates and restarts on its own. The Android app offers the update when you open it (⋮ → *Check for updates*).

**New install:** Windows: run the setup .exe; if SmartScreen warns (the installer isn't code-signed yet), click *More info → Run anyway*. Mac: open the .dmg, drag rdrive to Applications, then the first time go to System Settings → Privacy & Security → *Open Anyway*. Android: open the .apk on the phone and allow installing from your browser.

## What's new

${changelogSection(version) || 'See the changelog.'}

Every file is listed in \`SHA256SUMS.txt\`; the updaters refuse a download that doesn't match it.
`;
}

function sh(cmd, args, opts = {}) {
  // Windows runs npm/gradlew as .cmd/.bat scripts, which need a shell; git and gh don't (and their
  // arguments, like commit messages, contain spaces a shell would split).
  const shell = process.platform === 'win32' && /^(npm|gradlew\.bat)$/.test(cmd);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell, ...opts });
  if (opts.check !== false && r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  }
  return (r.stdout || '').trim();
}
const git = (...args) => sh('git', args);

function fail(msg) {
  console.error(`✋ ${msg}`);
  process.exit(1);
}

function bump(version, dry) {
  const changed = [];
  const files = {};
  for (const [rel, re] of PLACES) {
    const text = files[rel] ?? read(rel);
    const m = re.exec(text);
    if (!m) fail(`couldn't find the version in ${rel}; update PLACES in scripts/release.js`);
    const start = m.index + m[0].lastIndexOf(m[1]); // the version is the last thing in each pattern
    files[rel] = text.slice(0, start) + version + text.slice(start + m[1].length);
    if (m[1] !== version) changed.push(`${rel}: ${m[1]} → ${version}`);
  }
  // Android also needs an ever-increasing integer.
  const gradle = files[GRADLE_FILE];
  const code = Number(/versionCode = (\d+)/.exec(gradle)[1]);
  files[GRADLE_FILE] = gradle.replace(/versionCode = \d+/, `versionCode = ${code + 1}`);
  changed.push(`${GRADLE_FILE}: versionCode ${code} → ${code + 1}`);
  if (!dry) for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(ROOT, rel), text);
  return changed;
}

// Builds and signs the APK with the local key; returns its path.
function buildAndroid(version) {
  if (!fs.existsSync(path.join(os.homedir(), '.rdrive-android', 'keystore.properties'))) {
    fail('no Android signing key (~/.rdrive-android/keystore.properties). Release with --no-android, or from the computer that has the key.');
  }
  const env = { ...process.env };
  if (!env.JAVA_HOME) {
    for (const p of ['C:\\Program Files\\Android\\Android Studio\\jbr', '/Applications/Android Studio.app/Contents/jbr/Contents/Home']) {
      if (fs.existsSync(p)) env.JAVA_HOME = p;
    }
  }
  if (!env.ANDROID_HOME && !fs.existsSync(path.join(ROOT, 'android', 'local.properties'))) {
    const guess = process.platform === 'win32' ? path.join(env.LOCALAPPDATA || '', 'Android', 'Sdk') : path.join(os.homedir(), 'Library', 'Android', 'sdk');
    if (fs.existsSync(guess)) env.ANDROID_HOME = guess;
  }
  console.log('  building the Android app (signed with your key)…');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  sh(gradlew, ['--console=plain', '-q', 'testDebugUnitTest', 'assembleRelease'], { cwd: path.join(ROOT, 'android'), env });
  const built = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  const out = path.join(os.tmpdir(), `rdrive-${version}.apk`);
  fs.copyFileSync(built, out);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const args = argv.filter((a) => !a.startsWith('--'));
  if (argv.includes('--notes')) {
    process.stdout.write(notes(args[0] || current()));
    return;
  }
  const version = args[0];
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail('usage: npm run release -- 1.2.3 [--dry-run] [--no-android]');
  const dry = argv.includes('--dry-run');
  const android = !argv.includes('--no-android');
  const old = current();
  const problems = [];
  const n = (v) => v.split('.').map(Number);
  const [a, b] = [n(version), n(old)];
  if (!(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]))))) problems.push(`${version} isn't newer than the current version, ${old}`);
  if (!changelogSection(version)) problems.push(`docs/CHANGELOG.md has no "## ${version}" section yet: write what changed first`);
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') problems.push('releases are made from main');
  if (git('status', '--porcelain')) problems.push('there are uncommitted changes: commit them first (the changelog too)');
  git('fetch', '-q', 'origin');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) problems.push("main isn't the same as GitHub's: pull or push first");
  if (git('tag', '-l', `v${version}`)) problems.push(`the tag v${version} already exists`);
  if (problems.length && !dry) fail(['Not releasing:', ...problems].join('\n  '));

  for (const line of bump(version, dry)) console.log(`  ${line}`);
  if (dry) {
    console.log(`\nDry run: nothing changed.${problems.length ? problems.map((p) => `\n  ✋ ${p}`).join('') : ` It would commit "Release ${version}", tag v${version}${android ? ', build the Android app' : ''} and push.`}`);
    return;
  }
  let apk = null;
  try {
    console.log('  running the tests…');
    sh('npm', ['test', '--silent']);
    if (android) apk = buildAndroid(version);
  } catch (e) {
    git('checkout', '--', '.');
    fail(`${e.message}\nThe version bump was undone.`);
  }
  git('add', ...new Set(PLACES.map(([rel]) => rel)));
  git('commit', '-q', '-m', `Release ${version}`);
  git('tag', `v${version}`);
  git('push', '-q', 'origin', 'main');
  // The draft release (with the Android app) exists before the tag arrives, so the workflow adds to it.
  const tag = `v${version}`;
  sh('gh', ['release', 'create', tag, '--repo', REPO, '--draft', '--title', `rdrive ${version}`, '--notes', 'Building…']);
  if (android) {
    console.log('  attaching the Android app…');
    sh('gh', ['release', 'upload', tag, apk, '--repo', REPO, '--clobber']);
  }
  git('push', '-q', 'origin', tag);
  console.log(`\n✓ Released ${version}. GitHub is building the Windows and Mac apps and will publish everything (about 10 minutes).`);
  console.log(`  Follow it: https://github.com/${REPO}/actions/workflows/release.yml`);
}

if (require.main === module) main();
module.exports = { notes, changelogSection, PLACES };
