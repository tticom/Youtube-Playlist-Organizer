# YouTube Playlist Organizer

A browser extension that organizes YouTube playlists — most usefully **Watch Later** — by configurable subjects and sorting rules. Local rules are the default; optional AI requires explicit configuration. Manual and unattended reordering use a fail-closed completeness gate. Works in Firefox and Chrome.

## What it does

- Adds an **Organize** button at the end of the playlist's filter-chip row (floating at the bottom right if that row is missing)
- **Analyze & sort** — local weighted rules group videos into your categories by default; optional local Ollama or explicitly enabled cloud AI is available
- **Sort by duration** — shortest first. Local, instant, no API key
- **Sort by title** — A to Z. Local, instant, no API key
- **Sort by channel** — channel name A to Z, then title. Local, instant, no API key
- Preview the result and, in AI mode, correct a video's subject or mark a started video as unwatched so it sorts with the rest of its group
- Preview labels whether all entries can be verified. Permanent Apply requires YouTube's exact playlist header count to match the distinct identified entries read across all pages; it remains disabled when that evidence is missing or inconsistent
- A **Hide headings / Show headings** chip after Organize toggles the headings; they are dropped on their own once the playlist's videos change or you pick another sort in YouTube's own sort menu
- **Clear headings** in the Organize dialog removes the headings for good
- A verified backup can be retained for recovery; Undo is offered only when the backup and current playlist can be validated
- Three automation modes: Manual, Automatic on opening Watch Later, and Scheduled unattended. Unattended writes are off until a verified manual reorder and explicit one-time consent

Videos less than 10% watched count as unwatched. YouTube marks a video partially watched after roughly two seconds, so a stricter threshold promoted far too many videos.

## Screenshots

![The preview after Analyze & sort: group headings with counts and time left, started videos with their position and the eye control, sort options above the list](docs/screenshots/modal.png)

![A playlist after applying: group headings drawn into the list, Organize and Hide headings chips in the filter row](docs/screenshots/headings.png)

<img src="docs/screenshots/popup.png" width="444" alt="The settings popup: provider, model list, categories and sort defaults">

## Install from a release

Store listings are planned. Until then, each [GitHub Release](https://github.com/dancormier/youtube-playlist-organizer/releases) carries two files:

- `youtube-playlist-organizer-chrome-<version>.zip` — unzip it, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder.
- `youtube-playlist-organizer-firefox-<version>-unsigned.xpi` — **not signed by Mozilla**, so release Firefox only loads it as a temporary add-on (`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**), which is removed on restart. For a permanent install, sign it yourself (below) or wait for the store listing.

## Install from source

Or build it yourself:

```powershell
npm install
npm run build
```

That produces `dist/chrome/` and `dist/firefox/`. The build script is Node-based and works from PowerShell. Firefox can load the unpacked folder temporarily; `web-ext` is not installed by default, so an `.xpi` is not produced.

### Chrome

1. Open `chrome://extensions` and turn on **Developer mode**
2. **Load unpacked** and pick `dist/chrome/`

Chrome grants the existing YouTube host access at install. Scheduling uses the `alarms` permission; notification permission is optional and requested only when notifications are enabled. Scheduled work uses the YouTube tab APIs scoped by the existing YouTube host permission.

### Firefox — temporary add-on (quickest)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** and pick any file inside `dist/firefox/`

This is wiped every time Firefox restarts.

### Firefox — permanent install (signed, unlisted)

Release Firefox only installs add-ons Mozilla has signed. Signing on the **unlisted** channel gets a signed `.xpi` without publishing it. Get API credentials at <https://addons.mozilla.org/developers/addon/api/key/> and pass them as environment variables:

```sh
AMO_JWT_ISSUER=... AMO_JWT_SECRET=... ./sign.sh
```

The script builds first, then uploads `dist/firefox/` for signing; the signed `.xpi` lands in `dist/`. Install it via `about:addons` → gear icon → **Install Add-on From File…**. If both variables are unset and the 1Password CLI is installed, the script instead reads the maintainer's own 1Password item (the names are at the top of `sign.sh`); set the variables to skip that.

Two rules that matter:

- **Bump `version` in `package.json` before re-signing.** AMO rejects a version it has already seen.
- **If you fork this, change the gecko id** in `manifest.firefox.json` before signing. Firefox treats the id as the add-on's identity.

Self-distributed add-ons do not auto-update — a new version means signing and installing again.

### Firefox: grant access to YouTube

Firefox MV3 treats declared `host_permissions` as opt-in, so the content script does not inject until you allow the site — the Organize button simply never appears otherwise. Either:

- Open the extension's popup and click **Grant access to YouTube**, or
- Extensions menu (puzzle piece) → this add-on → **Always Allow on www.youtube.com**

Then reload any YouTube tabs that were already open. The grant does not apply retroactively to them.

## Setup

Local rules, duration, title and channel sorts work out of the box without a provider or key. Click the toolbar icon to open the popup:

1. **Classification method** — Local rules is the default and makes no network requests. Local AI requires Ollama and never falls back to a paid service. Cloud AI sends classifications to the selected provider only after you select it. Hybrid runs local rules first and sends uncertain items to that explicitly selected provider.
2. **Provider and credentials** — relevant only to an AI method. Credentials are not required to configure or use local rules.
3. **Subjects and rules** — search the offline YouTube category fallback and limited curated topic catalogue, select subjects, set their priority, and add custom subjects. Each subject can have descriptions plus inclusion and exclusion phrases.
4. **Niall — Watch Later** is an editable example preset. Save, Load, Remove and import/export manage settings and presets; API keys are excluded from exports.
5. **Learned Preferences** — changing a video's subject records a confirmed example locally. Repeated confirmed corrections sharing a title phrase can suggest a rule once evidence and consistency thresholds are met. Suggestions require approval; channel-wide rules are not inferred. Preview rows show evidence and provide Confirm, Uncertain and an optional note.
6. **Sorting feedback** — repeated explicit changes to the within-group sort control can suggest a global default. Existing YouTube playlist order is never treated as preference evidence. Approval changes the current sort configuration but does not rewrite the Niall preset. Subject-specific learned sort choices are not currently inferred.
7. **Privacy and backup** — examples and learned rules remain in local extension storage, are excluded from provider prompts, and can be exported or reset. Reset does not erase explicit per-video overrides. These heuristic scores rank evidence; they are not probabilities or neural-model training.
8. **Sort** — choose primary and secondary within-group keys; preview changes reuse classification results.
9. **Save**.

| Sort option | Choices | Notes |
|---|---|---|
| Primary within-group sort | Shortest first (default), Longest first, Original playlist position, Title A–Z/Z–A | Unknown durations sort last. Original position is the final stable tie-breaker |
| Secondary within-group sort | Original playlist position (default), duration ascending/descending, title A–Z/Z–A | Applied when the primary keys tie |
| Group in progress | Own group on top (default), Inside category, Follow selected sort | Follow selected sort strictly applies the selected duration/title/position keys to partially watched videos too |
| Group order | My category order (default), Largest group first, Smallest group first, Alphabetical | Size ties keep your category order. **Other** is always the last group and **Unavailable** always comes after it, whichever you pick |

## Providers

| Provider | Where to get a key | Notes |
|---|---|---|
| Anthropic | <https://console.anthropic.com/settings/keys> | Default. Uses a Haiku-class model. The request carries `anthropic-dangerous-direct-browser-access`, which Anthropic requires for browser-originated calls — fine for your own key on your own machine |
| OpenAI | <https://platform.openai.com/api-keys> | A "mini" or "nano" model is plenty |
| Google Gemini | <https://aistudio.google.com/apikey> | Uses Google's OpenAI-compatible endpoint; pick a "flash" model |
| OpenRouter | <https://openrouter.ai/settings/keys> | One key for many vendors; model ids look like `anthropic/claude-haiku-4.5` |
| Ollama (local) | none — <https://ollama.com/download> | Runs on your machine. The browser is only allowed to call it if `OLLAMA_ORIGINS` includes `chrome-extension://*` and `moz-extension://*` (e.g. `OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve`) |
| OpenAI-compatible (custom URL) | depends on the server | Anything that speaks the OpenAI chat-completions API: LM Studio, vLLM, LiteLLM, a proxy. Enter its base URL (usually ending in `/v1`) |

Your key is stored in the browser's extension sync storage and is only ever sent to the provider you picked. Note that sync storage replicates it to other browser profiles signed into the same browser account.

## Taxonomy sources and playlist safety

YouTube video categories and topics are different sources. A video category has an API category ID such as `25`; category labels are broad and are returned by the official `videoCategories.list` method. The popup can refresh assignable categories with an optional YouTube Data API key, and includes an offline fallback. A curated topic uses a legacy Freebase-derived ID such as `/m/05qt0`. YouTube documents only a small curated set, says videos are not guaranteed to have topics, and deprecated the old general topic mapping. The offline list is therefore explicitly partial. Custom subjects receive extension-owned stable IDs. Duplicate display names across sources are suppressed in the selected list. Internal subject IDs are extension keys; category IDs and Freebase-derived topic IDs remain source identifiers and are not interchangeable.

References: [YouTube `videoCategories.list`](https://developers.google.com/youtube/data/reference/rest/v3/videoCategories/list), [YouTube video `topicDetails`](https://developers.google.com/youtube/data/reference/rest/v3/videos), [YouTube topic ID revision history](https://developers.google.com/youtube/v3/revision_history), [YouTube `playlistItems.list` response and Watch Later errors](https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list).

The Niall example sorts all subjects by duration ascending, including partially watched items, with `Follow selected sort`. Classification uses title, channel, description and YouTube category as combined evidence; uncertain classifications fall through to the selected fallback. A classification can be manually overridden per video in the AI preview; overrides are stored by video ID separately from AI results and survive ordinary reanalysis.

## Limitations

- **It uses YouTube's unofficial InnerTube API**, the one the page itself calls. Google does not endorse this, and YouTube can change it and break the extension at any time.
- **Permanent reordering uses a strict completeness gate.** The extension requires an exact playlist header total, a matching count of distinct identified entries (including unavailable videos), terminated pagination, and a fresh matching sequence before writing. Missing or inconsistent evidence disables Apply. No live reorder has been verified.
- **Group headings exist only in your browser.** The extension draws them in the current YouTube page; they are not saved to the playlist.
- **Large playlist reads are bounded.** Pagination detects repeated continuation tokens and stops with an error if a continuation remains after 20 pages. Termination alone does not prove completeness. The exact total comes from YouTube's playlist header count field, separate from the paginated item renderers; unavailable/private entries count toward the total and must still have reorderable playlist-entry IDs. Counts are never inferred from generic nested `videoCount` fields or abbreviations. The official Data API does not expose Watch Later, so a read is rejected unless the header total exactly matches every distinct identified entry. A reported 200-video cap for an older InnerTube client is further reason to retain this count check. Duplicate and unidentified entries are rejected.
- **Automatic organisation is opt-in and gated.** On-open mode previews until unattended sorting has been authorized. After authorization it applies only when the current playlist read passes the exact-count integrity check, backs up before writing, skips an unchanged order, verifies the resulting order, and stops on concurrent changes.
- **Unattended operation requires setup and consent.** Choose on-open or scheduled mode, complete a verified manual reorder that changes at least one entry, then select **Enable unattended sorting** and confirm that future runs may permanently reorder Watch Later. The authorization is tied to the YouTube channel shown in the Watch Later header and the saved subject/sort configuration. A changed account or safety configuration requires a fresh manual acceptance run.
- **Scheduled operation runs only while Chrome is running.** `chrome.alarms` may be delayed while the computer sleeps, Chrome is closed, or the browser is under resource pressure. On browser startup, a missed due alarm is caught up once. Chrome's MV3 service worker is event-driven and may be terminated; the durable lock and run record let the next event recover safely. Live background-tab behavior has not yet been acceptance-tested.
- **Automation fails closed.** It refuses writes when header counts or entry integrity fail, account identity changes, the playlist changes during the run, backup storage fails, or YouTube cannot verify the resulting order. Integrity or ambiguous-write failures pause automation and require inspection. Transient failures use bounded exponential backoff, then pause. The recent-results panel is local, bounded, and stores no cookies or tokens.
- **Automation previews remain available before authorization.** Run now and Preview only return the intended order without writing. New learned rules remain suggestions until approved; approved learned rules and manual video overrides are applied on later runs.
- **Notifications are optional.** Grant notification permission from the popup to receive completion and attention notices; run status and history remain in settings if notifications are off.
- **Category refresh needs a YouTube Data API key.** The key is entered for that refresh and is not required to configure sorting. The built-in catalogue works offline.
- **The Manual sort switch relies on YouTube's menu order.** Before applying, the extension opens the playlist's sort menu and picks its first entry, which YouTube lists as Manual in every language. If YouTube ever reorders that menu, pick Manual yourself before applying.
- **"Treat as unwatched" only affects sorting.** It cannot clear YouTube's red progress bar (see [ARCHITECTURE.md](ARCHITECTURE.md) for why).
- **Cloud transmission is opt-in by method.** In Cloud AI or uncertain Hybrid classification, video title, channel, description and category metadata are sent to the selected provider. Local rules send nothing externally; learned examples and preference history are never included in prompts.
- **Classification cache:** unchanged metadata and classification configuration reuse local or AI results. Relevant rule/taxonomy changes invalidate derived entries; the cache is bounded to 2,000 entries. Provenance is retained. Manual overrides and learning examples are stored separately and are not evicted with derived cache entries.
- **Several Google accounts in one browser profile:** the extension reads the account index from the page (`SESSION_INDEX`) and addresses that account. Brand/channel accounts go through `DELEGATED_SESSION_ID`. If a playlist ever shows another account's videos, open an issue with the account setup.
- **Self-distributed Firefox builds do not auto-update.**

For the staged read-only, manual-write, authorization, and scheduled-cycle walkthrough, see [the manual acceptance procedure](docs/manual-acceptance.md).

## Privacy

The extension has no server and collects nothing. Settings (including your API key) stay in browser extension storage; learning examples stay in local extension storage. Video metadata is sent to an AI provider only in an explicitly selected AI mode; YouTube calls use your existing session. Details in [PRIVACY.md](PRIVACY.md).

## Development

```sh
npm test        # node --test tests/*.test.js
npm run build   # cross-platform Chrome and Firefox unpacked builds
```

No test framework and no test dependencies — plain `node:test` and `node:assert`, deliberately. See [CONTRIBUTING.md](CONTRIBUTING.md) for the manual test checklist and conventions.

### Layout

```
content/     globals, NOT ES modules, load-ordered by the manifest
  announce.js    (no global)  tells the background this tab is YouTube
  selectors.js   SELECTORS   the only YouTube selectors in the project
  viewsort.js    WLViewSort  switches the playlist's own sort chip to Manual
  innertube.js   WLInnerTube config scrape, SAPISIDHASH, call(), paging
  playlist.js    WLPlaylist  read() -> Video[], applyOrder()
  enrich.js      WLEnrich    player calls, concurrency 6, best-effort
  storage.js     WLStorage   overrides + group map, serialized writes
  modal.js       WLModal     Organize trigger (chip row or floating) and modal, all UI
  headings.js    WLHeadings  group heading injection
  panel.js       WLPanel     orchestration, SPA lifecycle
lib/         ES modules, shared by the background and the popup
  taxonomy.js    default categories
  providers.js   PROVIDERS table, model recommendation
  settings.js    defaults, normalization, storage, legacy-key migration
  sort.js        ordering
  classify.js    prompt, response parsing, provider requests
background/
  service-worker.js
popup/
  popup.html  popup.js (module)  popup.css
```

### Constraints worth knowing before editing

These break the extension at runtime while the tests still pass:

1. **`content/` files are not ES modules.** One global each, load-ordered by the manifest. Adding `import`/`export` breaks them in the browser.
2. **`lib/` files are ES modules.** The Firefox background script is built by concatenating them and stripping module syntax with `sed`. `build.sh` handles `export function`, `export async function`, `export const`, and `import` — any other export form silently produces a broken background script. A new `lib/` file must be added to the `LIB` list in `build.sh`, in dependency order.
3. **Nothing may become a child of the playlist's `DIV#contents` except playlist items.** YouTube's drag-to-reorder indexes a rect cache by child position, so a single foreign sibling breaks dragging for the whole list. Group headings mount *inside* their anchor item for exactly this reason.
4. **No DOM fallback.** The reorder API needs `setVideoId`, which only ever appears in API responses and never in the DOM, so there is nothing to fall back to. InnerTube failures surface as errors.

[ARCHITECTURE.md](ARCHITECTURE.md) carries the full context: measured InnerTube behaviour, decisions and their reasoning, and the failure modes that cost real time.

## How it works

The extension talks to **InnerTube**, YouTube's own internal API, from a content script. The `SAPISID` cookie is readable there, so requests are authenticated with a `SAPISIDHASH` header and no extra permissions are required.

Reordering sends every move in a single `browse/edit_playlist` call. Reads are cached server-side and lag a successful write by around a second, so `applyOrder` polls until the new order appears.

Classification is one prompt per playlist: titles, channel names and YouTube's own category label, plus your category list and instructions. The background sends it to the configured provider (Anthropic's Messages API or any OpenAI-compatible chat endpoint), parses the JSON clusters, and orders the result: in-progress videos first, then your categories top to bottom, then anything the model invented, then **Other** and **Unavailable**.

**Marking a video unwatched cannot clear YouTube's red progress bar.** That needs a `feedbackToken` from the watch-history feed, and neither paging nor searching that feed can reach an arbitrary video. The toggle only affects how this extension sorts.

## Licence

[MIT](LICENSE).
