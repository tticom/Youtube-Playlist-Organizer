import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const shared = [
  'content/announce.js', 'content/selectors.js', 'content/viewsort.js', 'content/innertube.js',
  'content/playlist.js', 'content/enrich.js', 'content/storage.js', 'content/modal.js',
  'content/headings.js', 'content/panel.js', 'styles/content.css', 'styles/panel.css',
  'styles/modal.css', 'styles/headings.css', 'popup/popup.html', 'popup/popup.css', 'popup/popup.js',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png', 'icons/active/icon16.png',
  'icons/active/icon48.png', 'icons/active/icon128.png',
];
const libraries = ['lib/taxonomy.js', 'lib/providers.js', 'lib/sort.js', 'lib/configuration.js', 'lib/local-classify.js', 'lib/learning.js', 'lib/automation.js', 'lib/settings.js', 'lib/classify.js'];
const copyInto = (file, destination) => {
  const target = join(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target);
};

rmSync('dist', { recursive: true, force: true });
for (const browser of ['chrome', 'firefox']) {
  const destination = `dist/${browser}`;
  mkdirSync(destination, { recursive: true });
  for (const file of shared) copyInto(file, destination);
  const manifest = JSON.parse(readFileSync(`manifest.${browser}.json`, 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(`${destination}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of libraries) copyInto(file, destination);
}

mkdirSync('dist/chrome/background', { recursive: true });
cpSync('background/service-worker.js', 'dist/chrome/background/service-worker.js');

const bundleParts = [...libraries, 'background/service-worker.js'].map(file => readFileSync(file, 'utf8'));
const bundle = bundleParts.join('\n')
  .replace(/^import .* from .*;\s*$/gm, '')
  .replace(/^export async function/gm, 'async function')
  .replace(/^export function/gm, 'function')
  .replace(/^export const/gm, 'const');
mkdirSync('dist/firefox/background', { recursive: true });
writeFileSync('dist/firefox/background/background.bundle.js', bundle);
const check = spawnSync(process.execPath, ['--check', 'dist/firefox/background/background.bundle.js'], { stdio: 'inherit' });
if (check.error) throw check.error;
if (check.status !== 0) process.exit(check.status ?? 1);

console.log(`Built version ${pkg.version}: dist/chrome and dist/firefox`);
console.log(`web-ext ${existsSync('node_modules/.bin/web-ext') ? 'is available for optional XPI packaging' : 'not installed; Firefox temporary add-on output is available'}`);
