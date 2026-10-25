# Architecture

What the extension is built on, what was measured rather than assumed, and which decisions are settled. Read this before changing anything under `content/` or `lib/`.

## The finding that made it possible

**InnerTube** is YouTube's own internal API, the one the page itself calls. It is reachable from an MV3 content script. Everything below was **measured against the live service on 2026-07-25**, not assumed. Do not "correct" these.

| Fact | Detail |
|---|---|
| Auth | Existing InnerTube calls authenticate in the YouTube content script using its page session. The extension never copies cookies into storage or diagnostic records. Scheduling uses alarms and YouTube-host-scoped tab operations; notification access is optional |
| Unauthenticated | 404 on private playlists — the auth header is mandatory |
| Reorder | `browse/edit_playlist` accepts **every move in one call**: 205ms regardless of playlist size. Sequential was 8 calls / 4355ms |
| **Unanchored moves are a silent no-op** | An action with no `movedSetVideoIdPredecessor`/`movedSetVideoIdSuccessor` returns `STATUS_SUCCEEDED` and changes nothing. This cost a full debugging cycle |
| Read-after-write | Reads are cached. A read 99ms after a successful write returns the OLD order. Convergence ~1.2s. This is why `applyOrder` polls |
| `setVideoId` | The playlist-entry id, required for reorder. **Exists only in API responses, never in the DOM.** This is why the DOM path was deleted |
| Watch state | `percentDurationWatched`, an integer 0–100 |
| Descriptions / category | Absent from `browse`; present in `player`. Both arrive in the same response |
| Continuations | Prefer the token under `continuationItemRenderer`. Taking the last `continuationCommand` in the tree makes paging stall |
| **History deletion** | **Not feasible.** See below |

### Why "mark as unwatched" can't clear YouTube's red bar

It needs a `feedbackToken` from the watch-history feed. Both routes failed:
- **Paging:** history returns tiny day-sliced chunks — measured `[4, 0, 5, 3, 0, 1, 0, 3, 0, 6, 5, 3, 4, 3, 3]` across 15 pages for 40 entries. Target videos sit hundreds deep.
- **Search:** `query` on `browseId: FEhistory` returned 0 hits across three variants. Not a supported shape.

History is enabled on the account, so a sparse feed isn't the explanation. **Don't retry this** — it was investigated thoroughly and abandoned deliberately.

## Module map

```

content/     (globals, NOT ES modules, load-ordered by manifest)
  announce.js    —           — one YT_PAGE message so the background can colour this tab's icon
  selectors.js   SELECTORS   — the ONLY YouTube selectors in the project
  viewsort.js    WLViewSort  — switches the playlist's sort chip to Manual before an apply
  innertube.js   WLInnerTube — config scrape, SAPISIDHASH, call(), paging
  playlist.js    WLPlaylist  — read() → Video[], applyOrder(playlistId, setVideoIds)
  enrich.js      WLEnrich    — player calls, concurrency 6, best-effort
  storage.js     WLStorage   — overrides + group map, serialized writes
  modal.js       WLModal     — Organize trigger (chip row, floating fallback) + modal, all UI
  headings.js    WLHeadings  — heading injection into the real playlist
  panel.js       WLPanel     — orchestration, SPA lifecycle
lib/         (ES modules; imported by the background and the popup)
  taxonomy.js    — default category list and group names
  configuration.js — source-aware subjects, limited topic catalogue, example preset and import/export
  providers.js   — PROVIDERS table, MODEL_GUIDANCE, pickRecommended()
  settings.js    — DEFAULT_SETTINGS, normalizeSettings(), load/save over storage.sync
  sort.js        — buildSortOrder(videos, clusters, overrides, taxonomy, options), SORT_CHOICES, normalizeSortOptions()
  classify.js    — buildPrompt(), parseClusters(), categorizeVideos(), listModels()
  local-classify.js — weighted local rules, evidence explanations and deterministic fallback
  learning.js    — locally stored confirmed examples, reviewed rule suggestions and explicit sort feedback
  automation.js  — validated schedule bounds, safety fingerprint, stale-lock and bounded-history helpers
background/
  service-worker.js — classification and learning handlers plus MV3 alarms, persistent run locks, authorization, tab orchestration, status and run history
popup/
  popup.html popup.js popup.css — settings form (module script) and the Firefox host-permission banner
```

`configuration.js` keeps category external IDs (`youtube-category:<id>`), curated topic IDs (`youtube-topic:/m/...`) and custom IDs (`custom:<id>`) distinct. Existing string taxonomies migrate to custom subjects so prior settings remain usable. The topic list follows YouTube's documented small curated set, not the discontinued comprehensive Freebase catalogue.

Permanent writes require an exact playlist-header total, one identified renderer per reported entry (including unavailable videos), terminated pagination, no duplicates, and a fresh matching pre-write sequence. InnerTube paging termination alone is not treated as completeness. The supported Data API explicitly excludes Watch Later, so the extension uses the exact playlist header count when YouTube supplies it and fails closed when the count is absent, abbreviated, mismatched, or the entry set has integrity issues. Generic `videoCount` fields remain ignored because they may describe nested widgets.

### Message flow

1. `WLPanel.runSort('ai')` reads the playlist through InnerTube, enriches it via `player` calls, and sends `ANALYZE` to the background.
2. New settings use weighted local rules and make no network requests. Local AI requires Ollama. Cloud AI is explicit; Hybrid sends only uncertain local results to the selected provider. AI prompt calls use Anthropic's Messages API for `kind: 'anthropic'` or `POST {baseUrl}/chat/completions` for `kind: 'openai'`.
3. `buildSortOrder` orders the result — by default in-progress first, then the user's categories in their order, then model-invented names, then Other and Unavailable; `settings.sort` (or the message's `sortOptions`) changes the in-group order, where in-progress videos go, and the group order — and caches the clusters so `RESORT` (toggling "treat as unwatched", or changing a sort option in the preview) never calls the model again.
4. Classification cache keys include video ID, title, channel, video category, description, method, taxonomy/instructions and approved learned-rule versions. Cache values retain provenance and local evidence. The 2,000-entry LRU-like cache evicts oldest touched entries; per-video manual subject IDs and learning examples are stored separately and never evicted with derived results. Preview sort changes and overrides reuse cached classifications.
5. Subject override selectors in the preview persist by video ID. Choosing Automatic restores the cached AI assignment (or explicit fallback), then immediately recomputes the order without another model call.
6. Automation has Manual, on-open, and scheduled modes. On-open previews until separately authorized. Scheduled runs use `chrome.alarms` in the MV3 service worker, reuse an already open Watch Later tab or create an inactive temporary one, and ask the content script to perform DOM-dependent InnerTube reads and validated sorting. The service worker closes only a temporary tab it created. Host access is already limited to YouTube; the extension does not request the broad `tabs` permission. Notifications use optional permission.
7. Unattended writes require a verified manual reorder with a real move, then a separate explicit consent action. Authorization stores the YouTube channel path, Watch Later ID, and subject/sort safety fingerprint in local extension storage. Account or safety-configuration mismatch stops writes until renewed manual acceptance. Approved learned rules apply automatically; pending suggestions never do.
8. Every automation run checks the account, complete exact-count snapshot, entry identity and calculated permutation. Unchanged order skips the write. Before mutation, a complete preflight read must still match and the original order is backed up. `applyOrder` performs its own fresh completeness and sequence check, applies a minimal LIS-based move plan, reads back the exact order, and retains recovery data on uncertainty. No mutation retry happens after an ambiguous result.
9. The lock and run summaries are persisted locally; summaries are bounded and omit cookies, tokens, video IDs and titles. Stale locks are recovered conservatively and marked for inspection. Transient errors back off exponentially up to five attempts; integrity/account/ambiguous-write failures pause automation. Failure notifications can be enabled optionally; status and history remain in the popup.
10. Scheduled work requires Chrome to be running. `chrome.alarms` can be delayed while the computer sleeps or Chrome is resource-constrained. The worker is event-driven; startup recreates missing alarms and catches up one overdue cycle. Inactive YouTube tab rendering and full unattended behavior still require live acceptance; mocked tests do not establish that behavior.
11. Corrections and confirmations stay in `chrome.storage.local`; they are excluded from provider prompts. Suggestions require repeated confirmed corrections, configurable evidence and consistency thresholds, and explicit approval. Channel-wide suggestions are not generated. Explicit changes to within-group sorting can suggest a global preference; existing playlist order is never used as evidence. Sorting suggestions do not modify the personal preset.

### Hard constraints

Violating these breaks the extension at runtime, not at test time:

1. **`content/` files are NOT ES modules.** One global each (`const WLThing = {...}`), load-ordered by the manifest. Adding `import`/`export` breaks them in the browser while tests still pass.
2. **`lib/` files ARE ES modules.** Firefox's background is built by **concatenating** them and stripping module syntax. `npm run build` uses the cross-platform `build.mjs`; `build.sh` remains the Unix equivalent. Both must include every new `lib/` file in dependency order and strip `export function`, `export async function`, `export const`, and `import`. **Any other export form can break Firefox's background script.** `node --check` on the bundle catches syntax but not missing runtime references.
3. **No DOM fallback.** InnerTube failures surface as errors. Deliberate: one path to maintain.
4. **Only our own UI avoids YouTube selectors.** The trigger and modal are elements we create. Heading injection must attach to YouTube's list, and the Manual-sort switch must click YouTube's sort chip — both dependencies are confined to `content/selectors.js`. No InnerTube endpoint for the view-sort preference has been identified; if one is, `WLViewSort` is the only thing to replace.
5. **Nothing may become a child of `DIV#contents` except playlist items.** YouTube's `handleDragMove_` indexes a rect cache by child position, so one foreign sibling breaks drag-to-reorder for the whole list. Headings therefore mount *inside* their anchor item (see "Headings and drag-to-reorder" below).
6. **The extension's chips go AFTER YouTube's in the chip row, never before.** The chip bar resolves a click by the chip's child index too: with Organize as the first child, every sort choice applied one click late (the previous pick took effect on the next click or on reload; measured 2026-09-11). Appending keeps YouTube's indices intact.

## Decisions already made

| Decision | Why |
|---|---|
| No DOM fallback | `setVideoId` is API-only, so reorder needs the API anyway |
| Enrich via `player` | Category and description come in the same response; "category only" costs the same for less |
| `percentWatched < 10` = unwatched | YouTube marks a video partially watched after ~2 seconds. 11 of 31 real videos were being promoted to the top |
| Overrides are **global**, not per-playlist | An override asserts "YouTube's watch data for this video is wrong" — a property of the video, not the list |
| Configurable subject list with a user-defined fallback | Users can mix YouTube video categories, the partial curated Topics list, and custom subjects while preserving stable source-aware IDs |
| Classification overrides are separate from AI cache | Manual choices persist by video ID and are never evicted with cached model output |
| One settings key in `storage.sync` | The popup and background share `lib/settings.js`; a legacy top-level `apiKey` is migrated on first read |
| Non-streaming provider calls | The whole response is parsed as JSON at the end, so streaming bought nothing but code |
| No `tabs` permission | The per-tab icon is set when the content script sends `YT_PAGE`; watching every navigation was the only thing `tabs` did |
| Version in `package.json` only | Injected into both manifests at build. Source manifests read `0.0.0` deliberately |

### Headings and drag-to-reorder

Injected headings once broke YouTube's drag-to-reorder. The headings were `<h2>` **siblings** of `ytd-playlist-video-renderer` inside `DIV#contents`. YouTube's `handleDragMove_` caches one rect per child of that container and indexes it by child position, so a foreign sibling made an index resolve to `undefined` (`can't access property "top", q is undefined`) on every mousemove. Polymer also wiped the foreign siblings during its own re-render mid-drag.

Each heading is now the **first child of the item that starts its group**, so assistive tech reads the heading before the video it introduces. `ytd-playlist-video-renderer` has **no shadow root** (probed 2026-07-27; light children are `DIV#index-container`, `DIV#content`, `DIV#menu`; `position: static`), so a light-DOM child renders normally. The anchor item gets a `wl-group-anchor` class supplying `position: relative` and `margin-top`, and the heading is absolutely positioned into that gap with `top: 0; transform: translateY(-100%)`. Being out of flow, it cannot disturb the item's internal flex row. Two tests guard this (`assertChildListIsPureItems` in the inject suite, and the stray-sibling case in drift repair).

### Unavailable videos

`content/playlist.js` treats an entry as unavailable when `renderer.isPlayable === false` **or** the title is falsy. Both signals are kept on purpose — `isPlayable` is YouTube's explicit marker but is omitted from many normal entries, so the check must be strict `=== false` and cannot stand alone; the falsy-title check remains the fallback. Unavailable entries are never sent to the model and always sort last.

## Testing notes

- `npm test` → `node --test tests/*.test.js`. In restricted Windows sandboxes the runner can fail before test execution with worker `spawn EPERM`; run each file directly with `node tests/<name>.test.js` to distinguish that environment limitation from application failures.
- **Content-script globals** are evaluated in a `node:vm` sandbox by `tests/helpers/load-global.js`. That helper is shared by every test; keep it small.
- **vm-realm gotcha:** arrays and objects created inside the sandbox carry the sandbox's constructors, so `assert.deepEqual` rejects them against outer-realm literals. **Normalise at the assertion** by spreading: `assert.deepEqual([...result], [...])` or `{ ...obj }`. This will bite you; it is not the implementation's fault.
- **Background handlers** are not exported (the file is concatenated for Firefox). `tests/resort-handler.test.js` and `tests/analyze-handler.test.js` capture the `onMessage` listener through a mocked `chrome` global and stub `globalThis.fetch`.

## Known rough edges

- Upstream `pageAll` stopped silently on a repeated continuation and returned whatever pages it had accumulated; it had no page cap or completeness status. This fork now rejects a repeated continuation and a continuation remaining after 20 pages. It also compares distinct identified entries against the exact playlist-header total; the read still fails closed if YouTube omits or abbreviates that count. A reported older WEB client regression stopped supplying continuation tokens after 200 videos, which is why termination alone never passes the completeness gate.
- Each `applyOrder` poll re-pages the whole playlist — up to ~12 re-reads in the 10s window on a multi-page playlist.
- A storage write queued behind a failing one inherits that rejection rather than retrying.

## Guidance from past defects

Patterns that produced real bugs here, worth checking for in any change:

- **A guard present in one method and absent in its neighbour.** The run token existed in `runSort` but not in `toggleUnwatched` or `applySort`; a reload `setTimeout` checked before scheduling but not inside the callback; `toGroups` handled three cluster states while `boundariesFrom` handled two, producing `data-wl-heading="undefined"` and duplicated headings. When adding a guard, look for every sibling that needs the same one.
- **Green tests over untested files.** `content/panel.js` had no tests and hosted two serious defects, one of which rendered `NaN:NaN left` to the user by reading a field a migration had deleted. Coverage-looking code is not covered code; the orchestration layer needs tests as much as the pure functions.
- **`Array.prototype.every` on an empty array is `true`.** The heading observer's loop guard used it on `addedNodes`, so removal-only batches were classified as the extension's own mutations and skipped.
- **Fixtures that don't exercise the failure they name.** A `nextToken` test passed against both the correct implementation and the exact bug it existed to catch, because traversal order made the decoy unreachable. Verify a new regression test fails against the old code.
- **Whole-file review after several changes to one file** found what per-change review structurally could not.
