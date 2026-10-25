#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VERSION=$(node -p "require('./package.json').version")
echo "Building version $VERSION"

# Clean
rm -rf dist
mkdir -p dist/chrome dist/firefox

# Shared files
SHARED=(
  content/announce.js
  content/selectors.js
  content/viewsort.js
  content/innertube.js
  content/playlist.js
  content/enrich.js
  content/storage.js
  content/modal.js
  content/headings.js
  content/panel.js
  styles/content.css
  styles/panel.css
  styles/modal.css
  styles/headings.css
  popup/popup.html
  popup/popup.css
  popup/popup.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
  icons/active/icon16.png
  icons/active/icon48.png
  icons/active/icon128.png
)

# The popup is a module script that imports from lib/, so lib/ ships in both
# layouts even though Firefox's background gets a concatenated bundle instead.
LIB=(
  lib/taxonomy.js
  lib/providers.js
  lib/sort.js
  lib/configuration.js
  lib/local-classify.js
  lib/learning.js
  lib/automation.js
  lib/settings.js
  lib/classify.js
)

copy_lib() {
  local dest="$1"
  mkdir -p "$dest/lib"
  for file in "${LIB[@]}"; do
    cp "$file" "$dest/$file"
  done
}

copy_shared() {
  local dest="$1"
  for file in "${SHARED[@]}"; do
    mkdir -p "$dest/$(dirname "$file")"
    cp "$file" "$dest/$file"
  done
}

# ── Chrome ──
copy_shared dist/chrome
node -e "
  const m = require('./manifest.chrome.json');
  m.version = process.argv[1];
  require('fs').writeFileSync('dist/chrome/manifest.json', JSON.stringify(m, null, 2));
" "$VERSION"
# Chrome uses ES module service worker — copy lib/ and background/ as-is
mkdir -p dist/chrome/background
cp background/service-worker.js dist/chrome/background/
copy_lib dist/chrome

# ── Firefox ──
copy_shared dist/firefox
node -e "
  const m = require('./manifest.firefox.json');
  m.version = process.argv[1];
  require('fs').writeFileSync('dist/firefox/manifest.json', JSON.stringify(m, null, 2));
" "$VERSION"
copy_lib dist/firefox
# Firefox needs a bundled background script (no ES module support in background).
# LIB is in dependency order, which is what the concatenation needs.
mkdir -p dist/firefox/background
cat "${LIB[@]}" background/service-worker.js \
  | sed 's/^export function/function/' \
  | sed 's/^export async function/async function/' \
  | sed 's/^export const/const/' \
  | sed "s/^import.*from.*$//" \
  > dist/firefox/background/background.bundle.js

# Catches syntax defects in the bundle (e.g. an unstripped `export`). It cannot
# catch linkage bugs — a lib/ module imported by the service worker but missing
# from the `cat` list above still parses fine and only throws ReferenceError at
# message-handling time in the real browser — but it's a cheap, automated floor.
node --check dist/firefox/background/background.bundle.js

# ── Package Firefox .xpi ──
if command -v web-ext >/dev/null 2>&1; then
  web-ext build --source-dir dist/firefox --artifacts-dir dist --filename youtube-playlist-organizer.xpi --overwrite-dest 2>/dev/null
else
  echo "web-ext not found — skipping .xpi packaging" >&2
fi

echo ""
echo "Build complete:"
echo "  dist/chrome/                    — load as unpacked in chrome://extensions"
echo "  dist/firefox/                   — load as temporary add-on in about:debugging"
if [ -f dist/youtube-playlist-organizer.xpi ]; then
echo "  dist/youtube-playlist-organizer.xpi   — installable Firefox add-on (unsigned)"
fi
