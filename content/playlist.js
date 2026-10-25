// content/playlist.js
// Depends on: content/innertube.js (loaded first via manifest)

const WLPlaylist = {
  browseIdFor(playlistId) {
    return playlistId === 'WL' ? 'VLWL' : `VL${playlistId}`;
  },

  /** First text run anywhere under `field`, or null. */
  _text(field) {
    if (!field) return null;
    if (typeof field.simpleText === 'string') return field.simpleText;
    if (Array.isArray(field.runs)) return field.runs.map(run => String(run?.text ?? '')).join('');
    const runs = WLInnerTube.findAll(field, 'text');
    return runs.length ? String(runs[0]) : null;
  },

  /**
   * Read only playlist header count fields. These are a separate total field
   * supplied alongside the item pages (including unavailable entries), unlike
   * the number of playable renderers in the current page. Abbreviations reject.
   */
  _reportedCount(page) {
    const headers = [
      ...WLInnerTube.findAll(page, 'playlistHeaderRenderer'),
      ...WLInnerTube.findAll(page, 'playlistSidebarPrimaryInfoRenderer'),
    ];
    for (const header of headers) {
      const fields = [
        { field: header.numVideosText, semantic: true },
        ...(Array.isArray(header.stats) ? header.stats.map(field => ({ field, semantic: false })) : []),
        { field: header.videoCountText, semantic: true },
      ];
      for (const { field, semantic } of fields) {
        const value = this._text(field);
        if (!value || (!semantic && !/\bvideos?\b/i.test(value)) || /\d\s*[KMB]\b/i.test(value)) continue;
        const match = value.match(/\d[\d,\.\u00a0\u202f ]*/);
        if (!match) continue;
        const digits = match[0].replace(/\D/g, '');
        if (digits) return Number(digits);
      }
    }
    return null;
  },

  _visibleHeaderCount() {
    if (typeof document === 'undefined') return null;
    const headers = document.querySelectorAll('ytd-playlist-header-renderer, yt-page-header-renderer');
    for (const header of headers) {
      const text = String(header.innerText || '');
      const match = text.match(/(?:^|\n)\s*(\d[\d,\.\u00a0\u202f ]*)\s+videos?\b/i)
        || text.match(/\b(\d[\d,\.\u00a0\u202f ]*)\s+videos?\b/i);
      if (!match || /\d\s*[KMB]\b/i.test(match[1])) continue;
      const digits = match[1].replace(/\D/g, '');
      const count = Number(digits);
      if (Number.isSafeInteger(count)) return count;
    }
    return null;
  },

  /**
   * Turn a playlistVideoRenderer into a Video.
   * Returns null when there is no setVideoId — reorder is impossible without it.
   */
  normalize(renderer) {
    if (!renderer || !renderer.setVideoId) return null;

    const title = this._text(renderer.title);
    const resume = WLInnerTube.findAll(renderer, 'percentDurationWatched');

    // Two signals, both kept: `isPlayable: false` is YouTube's explicit marker for
    // deleted/private entries, but the field is omitted on many normal entries, so
    // the check must be strict `=== false` and cannot stand alone. A falsy title
    // stays as the fallback for ghosts that arrive with the field missing.
    const unavailable = renderer.isPlayable === false || !title;

    return {
      id: renderer.videoId || '',
      setVideoId: renderer.setVideoId,
      title: title || '[Unavailable]',
      channel: this._text(renderer.shortBylineText) || 'Unknown',
      duration: Number(renderer.lengthSeconds) || 0,
      percentWatched: resume.length ? Number(resume[0]) : 0,
      category: null,
      description: null,
      unavailable,
    };
  },

  async read(playlistId) {
    return (await this.readSnapshot(playlistId)).videos;
  },

  async readSnapshot(playlistId) {
    const pages = await WLInnerTube.pageAll({ browseId: this.browseIdFor(playlistId) });

    const videos = [];
    const seen = new Set();
    let rawEntryCount = 0;
    let duplicateEntry = false;

    for (const page of pages) {
      for (const renderer of WLInnerTube.findAll(page, 'playlistVideoRenderer')) {
        rawEntryCount++;
        const video = this.normalize(renderer);
        if (!video) continue;
        if (seen.has(video.setVideoId)) { duplicateEntry = true; continue; }
        seen.add(video.setVideoId);
        videos.push(video);
      }
    }
    // Pagination termination is insufficient on its own. Compare every
    // renderer against the exact playlist-header total returned separately
    // from the item pages; the public Data API cannot list Watch Later.
    const expectedCount = this._reportedCount(pages[0]);
    const visibleHeaderCount = this._visibleHeaderCount();
    const ids = videos.map(v => v.setVideoId);
    const unique = new Set(ids);
    const integrityValid = !duplicateEntry && ids.length === unique.size && rawEntryCount === ids.length;
    const headerCountsAgree = Number.isSafeInteger(expectedCount) && Number.isSafeInteger(visibleHeaderCount) && expectedCount === visibleHeaderCount;
    const complete = headerCountsAgree && expectedCount >= 0 && integrityValid && ids.length === expectedCount;
    const reason = !integrityValid
      ? 'Playlist response contained duplicate or unidentified entries; complete retrieval cannot be verified.'
      : expectedCount == null
        ? 'YouTube did not provide an exact playlist header count; complete retrieval cannot be verified.'
        : visibleHeaderCount == null
          ? 'The rendered playlist header did not expose an exact video count; complete retrieval cannot be independently verified.'
          : visibleHeaderCount !== expectedCount
            ? `The rendered header reports ${visibleHeaderCount}, but the playlist response reports ${expectedCount}; complete retrieval cannot be verified.`
        : ids.length !== expectedCount
          ? `YouTube reports ${expectedCount} playlist entries, but ${ids.length} distinct entries were retrieved; complete retrieval cannot be verified.`
          : null;
    const diagnostics = {
      headerCount: expectedCount,
      renderedHeaderCount: visibleHeaderCount,
      retrievedEntryCount: rawEntryCount,
      distinctReorderableEntryCount: ids.length,
      pageCount: pages.length,
      paginationTerminated: true,
      completenessVerified: complete,
      outcome: complete ? 'verified' : reason,
    };
    // Intentionally omit playlist/video IDs, cookies, and request credentials.
    console.info('[WL] Playlist completeness diagnostics', diagnostics);
    return { videos, complete, expectedCount, visibleHeaderCount, paginationTerminated: true, rawEntryCount, uniqueEntryCount: ids.length, reason, integrityValid, diagnostics };
  },

  /**
   * Chain each entry after its predecessor. Every action MUST carry an anchor —
   * an action with neither predecessor nor successor is a silent no-op that
   * still returns STATUS_SUCCEEDED.
   */
  buildMoveActions(ordered, originalOrder = null) {
    if (ordered.length < 2) return [];
    let moving = new Set(ordered);
    if (Array.isArray(originalOrder) && originalOrder.length === ordered.length) {
      const positions = new Map(originalOrder.map((id, index) => [id, index]));
      // Longest increasing subsequence identifies the largest relative-order
      // set that can stay put; only entries outside it need a move.
      const tails = [], tailIndices = [], previous = new Array(ordered.length).fill(-1);
      ordered.forEach((id, index) => {
        const value = positions.get(id);
        if (value === undefined) return;
        let low = 0, high = tails.length;
        while (low < high) { const mid = (low + high) >> 1; if (tails[mid] < value) low = mid + 1; else high = mid; }
        tails[low] = value; previous[index] = low ? tailIndices[low - 1] : -1; tailIndices[low] = index;
      });
      const keep = new Set();
      let cursor = tailIndices[tails.length - 1];
      while (cursor !== undefined && cursor >= 0) { keep.add(ordered[cursor]); cursor = previous[cursor]; }
      if (keep.size) moving = new Set(ordered.filter(id => !keep.has(id)));
    }
    return ordered.flatMap((setVideoId, index) => {
      if (!moving.has(setVideoId)) return [];
      return [index === 0
        ? { action: 'ACTION_MOVE_VIDEO_BEFORE', setVideoId, movedSetVideoIdSuccessor: ordered[1] }
        : { action: 'ACTION_MOVE_VIDEO_AFTER', setVideoId, movedSetVideoIdPredecessor: ordered[index - 1] }];
    });
  },

  async _currentOrder(playlistId) {
    const videos = await this.read(playlistId);
    return videos.map(v => v.setVideoId);
  },

  /**
   * Apply an order in one call, then poll until it is visible.
   * Reads are cached server-side, so an immediate read returns stale data.
   */
  async applyOrder(playlistId, ordered, { timeoutMs = 10000, intervalMs = 500, originalOrder, complete = false, maxAttempts = 3 } = {}) {
    if (!complete) throw new Error('Permanent reorder stopped: playlist completeness has not been verified.');
    if (new Set(ordered).size !== ordered.length) throw new Error('Permanent reorder stopped: target order contains duplicate playlist entries.');
    if (!Array.isArray(originalOrder) || new Set(originalOrder).size !== originalOrder.length || originalOrder.length !== ordered.length || ordered.some(id => !originalOrder.includes(id))) {
      throw new Error('Permanent reorder stopped: target order does not match the validated original playlist entries.');
    }
    const before = await this.readSnapshot(playlistId);
    if (!before.complete || before.videos.map(v => v.setVideoId).join(',') !== originalOrder.join(',')) {
      throw new Error(before.reason || 'Playlist changed since preview; refusing a stale reorder.');
    }
    if (ordered.join(',') === originalOrder.join(',')) return { applied: true, unchanged: true, moveCount: 0, waitedMs: 0 };
    const actions = this.buildMoveActions(ordered, originalOrder);
    if (actions.length === 0) return { applied: true, moveCount: 0, waitedMs: 0 };
    const target = ordered.join(',');
    const started = Date.now();

    for (let attempt = 0; attempt < Math.max(1, Math.min(3, maxAttempts)); attempt++) {
      const state = await this.readSnapshot(playlistId);
      if (!state.complete) throw new Error(state.reason);
      const current = state.videos.map(v => v.setVideoId);
      if (current.join(',') === target) return { applied: true, moveCount: actions.length, waitedMs: Date.now() - started };
      if (current.join(',') !== originalOrder.join(',')) throw new Error('Playlist changed during reorder; stopped without retrying. Check the playlist and restore from the saved backup if needed.');

      try {
        await WLInnerTube.call('browse/edit_playlist', { playlistId, actions });
      } catch (writeError) {
        // A network error does not tell us whether YouTube applied the edit.
        // Read back before deciding whether a retry is safe.
        const afterError = await this.readSnapshot(playlistId);
        if (!afterError.complete) throw new Error(`Reorder outcome is unknown after a write error (${writeError.message}); playlist readback is incomplete. Check Watch Later and use Undo only after inspecting its order.`);
        const afterIds = afterError.videos.map(v => v.setVideoId).join(',');
        if (afterIds === target) return { applied: true, moveCount: actions.length, waitedMs: Date.now() - started };
        if (afterIds !== originalOrder.join(',')) throw new Error(`Reorder outcome is uncertain and playlist changed after the write error (${writeError.message}). Do not retry automatically; inspect the playlist and restore from the backup if needed.`);
      }

      const deadline = Date.now() + Math.min(timeoutMs, intervalMs * (2 ** attempt));
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
        const snapshot = await this.readSnapshot(playlistId);
        if (!snapshot.complete) throw new Error(snapshot.reason);
        const currentIds = snapshot.videos.map(v => v.setVideoId).join(',');
        if (currentIds === target) return { applied: true, moveCount: actions.length, waitedMs: Date.now() - started };
        if (currentIds !== originalOrder.join(',')) throw new Error('Playlist changed during reorder; stopped without retrying. Inspect its current order and use the saved backup to recover if needed.');
      }
      if (attempt + 1 < Math.min(3, maxAttempts)) await new Promise(resolve => setTimeout(resolve, intervalMs * (2 ** attempt)));
    }
    return { applied: false, moveCount: actions.length, waitedMs: Date.now() - started, retrySafe: true, originalOrderUnchanged: true, completenessVerified: true, error: 'YouTube did not confirm the new order. The playlist still matches its original order; no further write was attempted.' };
  },
};
