// content/panel.js
// Depends on: content/selectors.js, content/viewsort.js, content/innertube.js, content/playlist.js, content/enrich.js, content/modal.js, content/storage.js, content/headings.js

const WLPanel = {
  _runId: 0,
  _sortSeq: 0,
  currentSortOrder: [],
  currentPlaylistId: null,
  currentSortOptions: null,
  currentSubjects: [],
  currentReadWarning: null,
  currentReadDiagnostics: null,
  currentCanApply: false,
  // The mode of the run that produced currentSortOrder; only 'ai' has a cached
  // analysis for RESORT to work from.
  currentMode: null,
  // 'shown' or 'hidden' while this playlist has stored headings, else null.
  // Drives the Show/Hide headings chip beside Organize.
  _headingsState: null,

  /**
   * Undo is offered only when the stored undo state belongs to this playlist.
   * The storage read is local and fast; a failure just opens without Undo.
   */
  async openModal() {
    const runId = this._runId;
    const playlistId = new URL(location.href).searchParams.get('list');
    let canUndo = false;
    try {
      const undo = await WLStorage.getUndo();
      canUndo = Array.isArray(undo.previous) && undo.playlistId === playlistId && (!undo.status || undo.status === 'verified');
    } catch (err) {
      console.warn('WLPanel: failed to read the undo state', err);
    }
    // Navigating away during the read must not open a modal on the new page.
    if (runId !== this._runId) return;
    WLModal.open({
      onSort: (mode) => this.runSort(mode),
      onApply: () => this.applySort(),
      onUndo: () => this.undoSort(),
      onClearHeadings: () => this.clearHeadings(),
      onCancel: () => { this._runId++; this.currentSortOrder = []; this.currentMode = null; },
      onToggleUnwatched: (videoId) => this.toggleUnwatched(videoId),
      onSortOptionsChange: (sortOptions) => this.changeSortOptions(sortOptions),
      onClassificationOverride: (videoId, subjectId) => this.changeClassification(videoId, subjectId),
      onClassificationFeedback: (videoId, feedback) => this.recordClassificationFeedback(videoId, feedback),
    }, { canUndo, hasHeadings: this._headingsState !== null });
  },

  /** The dialog's Clear headings button: drop them for good and close. */
  clearHeadings() {
    this._dropHeadings();
    WLModal.close();
  },

  _setHeadingsState(state) {
    this._headingsState = state;
    WLModal.syncHeadingsToggle(state, { onToggle: () => this.toggleHeadings() });
  },

  // The sort chip's label while the view was Manual, recorded with the group
  // map. Language-independent: whatever the label was, a different one means
  // the user picked another view sort.
  _viewSortLabel: null,

  _viewSortChanged() {
    if (!this._viewSortLabel) return false;
    const label = WLViewSort.current();
    return label !== null && label !== this._viewSortLabel;
  },

  /**
   * A view sort other than Manual reorders the list under the headings, so
   * the grouping no longer describes what is on screen: treat the sort as
   * having undone ours. Called from syncTrigger on every mutation batch, so
   * it is one querySelector when nothing is stored.
   */
  checkViewSort() {
    if (!this._headingsState || !this._viewSortChanged()) return;
    this._dropHeadings();
  },

  _dropHeadings() {
    WLHeadings.stop();
    WLHeadings.clear();
    this._viewSortLabel = null;
    this._setHeadingsState(null);
    WLStorage.setGroupMap({}).catch((err) => {
      console.warn('WLPanel: failed to clear the group map after a view sort change', err);
    });
  },

  /**
   * The chip beside Organize: hide the headings but keep the stored map, or
   * put them back. The `hidden` flag on the map makes the choice survive a
   * reload, where restoreHeadings() reads it.
   */
  async toggleHeadings() {
    const runId = this._runId;
    const playlistId = new URL(location.href).searchParams.get('list');
    let stored;
    try {
      stored = await WLStorage.getGroupMap();
    } catch (err) {
      console.warn('WLPanel: failed to read stored group map', err);
      return;
    }
    if (runId !== this._runId) return;
    if (!stored.boundaries || stored.playlistId !== playlistId) {
      this._setHeadingsState(null);
      return;
    }

    const hidden = this._headingsState === 'shown';
    if (hidden) {
      WLHeadings.stop();
      WLHeadings.clear();
    } else {
      WLHeadings.watch(stored.boundaries);
    }
    this._setHeadingsState(hidden ? 'hidden' : 'shown');
    try {
      await WLStorage.setGroupMap({ ...stored, hidden });
    } catch (err) {
      console.warn('WLPanel: failed to save the headings visibility; it will reset on reload', err);
    }
  },

  /**
   * @param {'ai'|'duration'|'title'|'channel'} mode
   * The non-AI modes sort locally and never call the model — no API key
   * needed, and they skip enrichment since nothing consumes the metadata.
   */
  async runSort(mode, { automatic = false, applyAutomatically = false } = {}) {
    const runId = ++this._runId;
    this.currentMode = mode;

    try {
      const playlistId = new URL(location.href).searchParams.get('list');
      if (!playlistId) { WLModal.showError('No playlist found in the URL.'); return; }
      this.currentPlaylistId = playlistId;

      WLModal.showBusy('Reading playlist...');
      const snapshot = await WLPlaylist.readSnapshot(playlistId);
      const videos = snapshot.videos;
      if (runId !== this._runId) return;
      this.currentCanApply = snapshot.complete === true;
      this.currentReadDiagnostics = snapshot.diagnostics || null;
      this.currentReadWarning = snapshot.complete
        ? null
        : `${snapshot.reason || 'Playlist completeness could not be verified.'} ${snapshot.expectedCount == null ? '' : `Retrieved ${snapshot.uniqueEntryCount} of ${snapshot.expectedCount}. `}Apply is disabled.`;

      if (!videos || videos.length === 0) {
        WLModal.showError('No videos found on this playlist.');
        return;
      }

      let result;
      if (mode === 'ai') {
        WLModal.showBusy('Fetching video details...');
        await WLEnrich.enrich(videos);
        if (runId !== this._runId) return;

        WLModal.showBusy('Classifying videos...');
        result = await chrome.runtime.sendMessage({ type: 'ANALYZE', videos, playlistId, manualPreview: !automatic });
      } else {
        WLModal.showBusy(`Sorting by ${mode}...`);
        result = await chrome.runtime.sendMessage({ type: 'SORT_BY_DURATION', videos, by: mode });
      }
      if (runId !== this._runId) return;

      if (!result.success) { WLModal.showError(result.error); return; }

      this.currentSortOrder = result.sortOrder;
      this.currentSortOptions = result.sortOptions ?? null;
      this.currentSubjects = result.subjects || [];
      WLModal.showPreview(result.sortOrder, this.currentSortOptions, this.currentSubjects, { warning: this.currentReadWarning, canApply: this.currentCanApply, diagnostics: this.currentReadDiagnostics });
      if (applyAutomatically && this.currentCanApply) {
        const originalIds = videos.map(video => video.setVideoId);
        const orderedIds = result.sortOrder.map(video => video.setVideoId);
        if (originalIds.length === orderedIds.length && originalIds.every((id, index) => id === orderedIds[index])) {
          WLModal.setStatus('Watch Later is already in the configured order. No changes were made.');
        } else {
          await this.applySort({ automatic: true });
        }
      }
    } catch (err) {
      if (runId === this._runId) WLModal.showError(err.message);
    }
  },

  /**
   * Recompute against cached clusters. Never re-calls Claude.
   *
   * Captures (does not bump) the run token: this belongs to the session already
   * in progress, not a new one, so it must not invalidate a concurrent runSort().
   * The check exists because navigating away (resetForNavigation() bumps _runId)
   * while this is in flight must stop it from painting a stale order over
   * whatever session owns the modal by the time it resolves.
   *
   * Outside AI mode there is nothing to recompute: the background would answer
   * RESORT from the last AI run's cache and repaint a simple-sort preview with
   * that grouping.
   */
  async toggleUnwatched(videoId) {
    if (this.currentMode !== 'ai') return;
    const runId = this._runId;
    WLModal.setStatus('Re-sorting...');

    try {
      const overrides = await WLStorage.toggleOverride(videoId);
      if (runId !== this._runId) return;

      const result = await chrome.runtime.sendMessage({
        type: 'RESORT', overrides, playlistId: this.currentPlaylistId,
        sortOptions: this.currentSortOptions ?? undefined,
      });
      if (runId !== this._runId) return;

      if (!result.success) { WLModal.showError(result.error); return; }

      this.currentSortOrder = result.sortOrder;
      this.currentSortOptions = result.sortOptions ?? this.currentSortOptions;
      WLModal.showPreview(result.sortOrder, this.currentSortOptions, this.currentSubjects, { warning: this.currentReadWarning, canApply: this.currentCanApply, diagnostics: this.currentReadDiagnostics });
    } catch (err) {
      // The modal invokes this fire-and-forget, so an uncaught rejection here
      // is invisible to the user — the everyday trigger is "Extension context
      // invalidated" after an extension reload, which would otherwise leave
      // the modal stuck on "Re-sorting..." forever.
      if (runId === this._runId) WLModal.showError(err.message);
    }
  },

  /**
   * Re-sort the cached analysis with different options and remember them as
   * the default for next time. Same run-token discipline as toggleUnwatched():
   * this belongs to the session that owns the modal and never bumps _runId.
   * The overrides are deliberately not sent — the background keeps the stored
   * ones, so this cannot undo a "treat as unwatched" toggle in flight.
   */
  async changeSortOptions(sortOptions) {
    if (this.currentMode !== 'ai') return;
    if (sortOptions.withinGroup && sortOptions.withinGroup !== this.currentSortOptions?.withinGroup) chrome.runtime.sendMessage({ type: 'RECORD_SORTING_CHOICE', field: sortOptions.withinGroup, group: '*' }).catch(() => {});
    const runId = this._runId;
    // Firefox fires `change` per arrow-key step, so replies can arrive out of
    // order; only the newest request may paint or persist.
    const seq = ++this._sortSeq;
    WLModal.setStatus('Re-sorting...');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'RESORT', sortOptions, playlistId: this.currentPlaylistId,
      });
      if (runId !== this._runId || seq !== this._sortSeq) return;

      if (!result.success) { WLModal.showError(result.error); return; }

      this.currentSortOrder = result.sortOrder;
      this.currentSortOptions = result.sortOptions ?? sortOptions;
      WLModal.showPreview(result.sortOrder, this.currentSortOptions, this.currentSubjects, { warning: this.currentReadWarning, canApply: this.currentCanApply, diagnostics: this.currentReadDiagnostics });

      // The preview is already correct; failing to remember the choice for next
      // time is not worth an error state in the modal.
      try {
        await WLStorage.setSortOptions(this.currentSortOptions);
      } catch (err) {
        console.warn('WLPanel: failed to save sort options; they will reset next time', err);
      }
    } catch (err) {
      if (runId === this._runId && seq === this._sortSeq) WLModal.showError(err.message);
    }
  },

  /**
   * Switch the view to Manual, then write `ordered` and wait for it to show.
   * Shared by applySort() and undoSort(). Captures (does not bump) the run
   * token: a superseded write must not announce anything into the modal.
   * @returns {{ result, viewSort, previous } | null} null when superseded or
   *   when the write threw (already shown as an error).
   */
  async changeClassification(videoId, subjectId) {
    if (this.currentMode !== 'ai') return;
    const runId = this._runId;
    WLModal.setStatus('Updating classification...');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SET_CLASSIFICATION_OVERRIDE', videoId, subjectId, playlistId: this.currentPlaylistId });
      if (runId !== this._runId) return;
      if (!result.success) { WLModal.showError(result.error); return; }
      this.currentSortOrder = result.sortOrder;
      WLModal.showPreview(result.sortOrder, this.currentSortOptions, this.currentSubjects, { warning: this.currentReadWarning, canApply: this.currentCanApply, diagnostics: this.currentReadDiagnostics });
    } catch (err) {
      if (runId === this._runId) WLModal.showError(err.message);
    }
  },

  async recordClassificationFeedback(videoId, feedback) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'CLASSIFICATION_FEEDBACK', videoId, ...feedback });
      if (!result?.success) { WLModal.showError(result?.error || 'Could not save classification feedback.'); return; }
      const item = this.currentSortOrder.find(video => video.id === videoId);
      if (item) { if ('confirmed' in feedback) item.classificationConfirmed = feedback.confirmed; if ('uncertain' in feedback) item.classificationUncertain = feedback.uncertain; }
      WLModal.showPreview(this.currentSortOrder, this.currentSortOptions, this.currentSubjects, { warning: this.currentReadWarning, canApply: this.currentCanApply, diagnostics: this.currentReadDiagnostics });
      WLModal.setStatus(feedback.uncertain ? 'Marked uncertain; preference saved locally.' : 'Classification feedback saved locally.');
    } catch (err) { WLModal.showError(err.message); }
  },

  async _writeOrder(runId, playlistId, ordered, { saveBackup = true } = {}) {
    // The reorder only shows through the Manual view (content/viewsort.js).
    // Still cancellable: nothing has been written yet.
    WLModal.showBusy('Checking the playlist sort...');
    let viewSort;
    try {
      viewSort = await WLViewSort.ensureManual();
    } catch (err) {
      console.warn('WLPanel: could not check the playlist sort', err);
      viewSort = 'failed';
    }
    if (runId !== this._runId) return null;

    // The order Undo falls back to, read right before the write: the session's
    // earlier read may predate a view switch or a drag the user made since.
    WLModal.showBusy('Reading playlist...');
    let previous;
    try {
      const snapshot = await WLPlaylist.readSnapshot(playlistId);
      if (!snapshot.complete) throw new Error(snapshot.reason);
      previous = snapshot.videos.map(v => v.setVideoId);
    } catch (err) {
      WLModal.showError(`Cannot safely reorder this playlist: ${err.message}`);
      return null;
    }
    if (runId !== this._runId) return null;

    // Keep a restorable snapshot durably before the first remote mutation.
    if (saveBackup) {
      try {
        await WLStorage.setUndo({ playlistId, previous, current: ordered, status: 'pending' });
      } catch (err) {
        WLModal.showError(`Cannot safely reorder this playlist because its backup could not be saved: ${err.message}`);
        return null;
      }
    }
    if (runId !== this._runId) {
      if (saveBackup) {
        try { await WLStorage.setUndo({ playlistId, previous, current: ordered, status: 'not-applied' }); }
        catch (err) { console.warn('WLPanel: could not mark a cancelled reorder backup', err); }
      }
      return null;
    }

    // Uninterruptible from here: applyOrder() sends the reorder immediately, so
    // "cancelling" would only hide the modal and skip the reload while the
    // playlist changed underneath.
    WLModal.showBusy(`Applying ${ordered.length} moves...`, { cancellable: false });

    let result;
    try {
      result = await WLPlaylist.applyOrder(playlistId, ordered, { complete: true, originalOrder: previous });
    } catch (err) {
      if (saveBackup) {
        try { await WLStorage.setUndo({ playlistId, previous, current: ordered, status: 'uncertain' }); }
        catch (backupErr) { console.warn('WLPanel: failed to mark the retained backup uncertain', backupErr); }
      } else {
        try {
          const prior = await WLStorage.getUndo();
          if (prior?.playlistId === playlistId && Array.isArray(prior.previous)) await WLStorage.setUndo({ ...prior, status: 'uncertain' });
        } catch (backupErr) { console.warn('WLPanel: failed to mark the recovery backup uncertain', backupErr); }
      }
      if (runId === this._runId) WLModal.showError(err.message);
      return null;
    }
    if (saveBackup) {
      try { await WLStorage.setUndo({ playlistId, previous, current: ordered, status: result.applied ? 'verified' : 'not-applied' }); }
      catch (err) { console.warn('WLPanel: could not update the retained backup status', err); }
    }
    if (runId !== this._runId) return null;
    return { result, viewSort, previous, completenessVerified: true };
  },

  /**
   * Keep the original sequence for recovery, but do not expose Undo until a
   * later read establishes which sequence is currently stored.
   */
  async _writeNotApplied(runId, viewSort) {
    if (runId !== this._runId) return;
    // Anything but a confirmed Manual view is the likeliest cause, including
    // a chip the selector no longer finds.
    const manualUnconfirmed = viewSort !== 'manual' && viewSort !== 'switched';
    WLModal.showError(manualUnconfirmed
      ? 'Sort was sent but the new order did not appear. This playlist is not on Manual sort: pick Manual in the sort menu above the list, then try again.'
      : 'YouTube did not confirm the requested order. The original sequence backup was retained, but Undo is unavailable until you inspect the playlist and verify its current order.');
  },

  /**
   * YouTube's DOM does not reflect the reordered playlist, so a successful
   * write otherwise looks like nothing happened. Ownership is re-checked
   * inside the callback itself, not just when scheduling it — the 1.2s window
   * is long enough for the user to click into a video and navigate away, and
   * without this the timer would reload the page they just opened.
   */
  _announceAndReload(runId, waitedMs, { unchanged = false } = {}) {
    const message = unchanged
      ? 'Playlist already matches this sort. Complete read verified; no playlist mutation was made. A successful live reorder is still required to enable unattended writes.'
      : `Sort complete in ${(waitedMs / 1000).toFixed(1)}s. Refreshing...`;
    WLModal.showBusy(message, { cancellable: false });
    setTimeout(() => { if (runId === this._runId) location.reload(); }, 1200);
  },

  async applySort({ automatic = false } = {}) {
    const runId = this._runId;
    if (automatic) {
      const status = await chrome.runtime.sendMessage({ type: 'AUTO_PREVIEW_STATUS' }).catch(() => null);
      if (!status?.autoOrganize || !status.manualDryRunCompleted || runId !== this._runId) return;
    }
    if (!this.currentCanApply) {
      WLModal.showError('Cannot apply this preview because playlist completeness is not verified.');
      return;
    }
    const playlistId = this.currentPlaylistId;
    const orderedSetVideoIds = this.currentSortOrder.map(v => v.setVideoId);

    const written = await this._writeOrder(runId, playlistId, orderedSetVideoIds);
    if (!written) return;
    const { result, viewSort, previous, completenessVerified } = written;

    if (!result.applied) {
      await this._writeNotApplied(runId, viewSort);
      return;
    }

    const noOpVerified = result.unchanged === true && previous.length === orderedSetVideoIds.length && previous.every((id, index) => id === orderedSetVideoIds[index]);
    const writeVerified = !noOpVerified && Number(result.moveCount) > 0;
    const accountId = playlistAccountIdentity();
    if (accountId && completenessVerified && (noOpVerified || writeVerified)) await chrome.runtime.sendMessage({
      type: 'RECORD_MANUAL_ACCEPTANCE', playlistId, accountId,
      evidenceKind: noOpVerified ? 'read-noop' : 'write',
      moveCount: Number(result.moveCount) || 0,
      completenessVerified, verifiedRead: true, orderMatched: true,
      verifiedWrite: writeVerified,
      readbackVerified: writeVerified && result.applied === true,
    }).catch(err => { console.warn('WLPanel: could not record manual validation evidence', err); return null; });

    // Persist BEFORE the reload — the reload is what makes headings necessary,
    // and it destroys any in-memory state that isn't written first.
    // Headings are a convenience; the reorder above is the actual work and it
    // already succeeded — so a storage failure here must not block the reload
    // or leave the modal stuck. It gets its own try/catch rather than joining
    // the applyOrder one, and failure is logged but otherwise swallowed.
    // Duration-mode sorts yield an empty boundaries array (no `cluster` key
    // at all on any video — see WLHeadings.boundariesFrom).
    const boundaries = WLHeadings.boundariesFrom(this.currentSortOrder);
    try {
      if (boundaries.length > 0) {
        await WLStorage.setGroupMap({
          playlistId,
          boundaries,
          videoIdsHash: WLHeadings.hashIds(this.currentSortOrder),
          viewSortLabel: WLViewSort.current(),
        });
      } else {
        // The stored map must be CLEARED here, not left alone. Skipping the
        // write is not neutral: a previous AI sort's grouping survives it,
        // and restoreHeadings() then re-injects those headings after the
        // reload, scattered through the new duration order. Its staleness
        // check does not catch this — hashIds is order-independent, so
        // reordering the same set of videos never trips it.
        WLHeadings.stop();
        WLHeadings.clear();
        this._setHeadingsState(null);
        await WLStorage.setGroupMap({});
      }
    } catch (err) {
      console.warn('WLPanel: failed to persist group map; headings may be stale after reload', err);
    }
    // Re-check ownership: the awaits above are a window resetForNavigation()'s
    // synchronous _runId bump can land in, same as every other await in this
    // method. Without this, a navigate-away mid-persist would still announce
    // "Sort complete" and reload the page the user already left.
    if (runId !== this._runId) return;

    this._announceAndReload(runId, result.waitedMs, { unchanged: noOpVerified });
  },

  /**
   * Put the playlist back in the order it had before the last apply. Headings
   * describe the order that is being undone, so the stored map goes with it.
   * Refuses unless the playlist still reads exactly as that apply left it: an
   * added or removed video means a stale setVideoId list, and a hand
   * reorder since is work Undo must not throw away.
   */
  async undoSort() {
    const runId = this._runId;
    const playlistId = new URL(location.href).searchParams.get('list');
    this.currentPlaylistId = playlistId;

    WLModal.showBusy('Reading playlist...');
    let undo;
    let videos;
    try {
      undo = await WLStorage.getUndo();
      if (runId !== this._runId) return;
      if (!Array.isArray(undo.previous) || undo.playlistId !== playlistId) {
        WLModal.showError('Nothing to undo for this playlist.');
        return;
      }
      if (undo.status && undo.status !== 'verified') {
        WLModal.showError('A backup is retained, but the previous reorder was not verified. Inspect the playlist before attempting recovery.');
        return;
      }
      const snapshot = await WLPlaylist.readSnapshot(playlistId);
      if (!snapshot.complete) throw new Error(snapshot.reason);
      videos = snapshot.videos;
    } catch (err) {
      if (runId === this._runId) WLModal.showError(err.message);
      return;
    }
    if (runId !== this._runId) return;

    const unchanged = Array.isArray(undo.current)
      && videos.length === undo.current.length
      && videos.every((v, i) => v.setVideoId === undo.current[i]);
    if (!unchanged) {
      try { await WLStorage.setUndo({ ...undo, status: 'stale' }); }
      catch (err) { console.warn('WLPanel: failed to mark the retained backup stale', err); }
      if (runId === this._runId) {
        WLModal.showError('The playlist has changed since that sort, so it cannot be undone.');
      }
      return;
    }
    const written = await this._writeOrder(runId, playlistId, undo.previous, { saveBackup: false });
    if (!written) return;
    const { result, viewSort } = written;

    if (!result.applied) {
      await this._writeNotApplied(runId, viewSort);
      return;
    }

    try {
      WLHeadings.stop();
      WLHeadings.clear();
      this._setHeadingsState(null);
      await WLStorage.setGroupMap({});
      await WLStorage.setUndo({});
    } catch (err) {
      console.warn('WLPanel: failed to clear state after undo', err);
    }
    if (runId !== this._runId) return;

    this._announceAndReload(runId, result.waitedMs);
  },

  _headingsRestoredFor: null,

  /**
   * Re-apply stored headings after a reload. Discards them when the playlist's
   * contents have changed, since stale groupings are worse than none.
   *
   * Called from syncTrigger(), which fires on every DOM mutation batch, so it
   * must do its work at most once per playlist — hence the guard. Without it
   * this would issue an InnerTube read per mutation. Note the guard is set
   * (above) before any of the awaits below: if a read or storage call fails,
   * it stays set for this playlistId, so restoration does not retry until the
   * next navigation resets it in resetForNavigation(). That is intentional —
   * retrying on every mutation batch is exactly what the guard exists to
   * prevent — but it does mean a transient failure costs the rest of this
   * page load's headings, not just one attempt.
   *
   * syncTrigger() calls this unawaited (fire-and-forget), so every await here
   * must not throw — an unhandled rejection is the only other outcome.
   */
  async restoreHeadings() {
    const runId = this._runId;
    const playlistId = new URL(location.href).searchParams.get('list');
    if (!playlistId || this._headingsRestoredFor === playlistId) return;
    this._headingsRestoredFor = playlistId;

    let stored;
    try {
      stored = await WLStorage.getGroupMap();
    } catch (err) {
      console.warn('WLPanel: failed to read stored group map', err);
      return;
    }
    if (runId !== this._runId) return;
    if (!stored.boundaries || stored.playlistId !== playlistId) return;

    let videos;
    try {
      videos = await WLPlaylist.read(playlistId);
    } catch {
      return; // Offline or API broken — headings simply don't restore.
    }
    if (runId !== this._runId) return;

    if (WLHeadings.hashIds(videos) !== stored.videoIdsHash) {
      try {
        await WLStorage.setGroupMap({});
      } catch (err) {
        console.warn('WLPanel: failed to clear stale group map', err);
      }
      return;
    }
    // Final re-check immediately before re-arming the observer: this is a
    // multi-page network call (WLPlaylist.read), and resetForNavigation() can
    // bump _runId at any point during it. Without this, a late continuation
    // could watch() with the previous playlist's boundaries, or re-attach a
    // document.body observer after navigating to a non-playlist page — one
    // that would then survive the rest of the session.
    if (runId !== this._runId) return;
    this._viewSortLabel = stored.viewSortLabel || null;
    if (this._viewSortChanged()) {
      this._dropHeadings();
      return;
    }
    if (stored.hidden) {
      this._setHeadingsState('hidden');
      return;
    }
    WLHeadings.watch(stored.boundaries);
    this._setHeadingsState('shown');
  },
};

function onPlaylistPage() {
  return location.pathname.startsWith('/playlist') &&
         Boolean(new URL(location.href).searchParams.get('list'));
}

const WL_LOG = '[WL]';

// Tracks whether the previous syncTrigger call found us on a playlist page,
// so the observer path (see below) can tell a steady state from a transition.
// `undefined` initially guarantees the very first call always looks like a
// transition and gets logged.
let lastOnPlaylistPage;
let lastPlaylistId;
let automaticPreviewTimer = null;
let automaticPreviewRunning = false;

/**
 * The trigger is a fixed-position element we own, so there is no YouTube
 * selector to wait for and nothing to retry — mount it whenever we are on a
 * playlist page, remove it when we are not.
 *
 * The MutationObserver fires continuously for the life of a YouTube tab, on
 * every page, so logging unconditionally here would drown the one-shot paths
 * (load-time, navigation events, the backstop) under a wall of identical
 * "observer" lines — and calling WLModal.verifyTrigger() on every one of
 * those would mean a forced-layout getComputedStyle() read on every DOM
 * mutation while parked on a playlist page. So `source === 'observer'` calls
 * only log when something actually happened: the trigger was (re)created, or
 * the on-playlist-page/not-on-playlist-page state changed since the last
 * call. Everything else (the one-shot event sources, and every console.warn)
 * still logs unconditionally. Do not "fix" this back to logging every call.
 */
function syncTrigger(source) {
  let onPage;
  try {
    onPage = onPlaylistPage();
  } catch (err) {
    console.warn(WL_LOG, 'onPlaylistPage threw', { source, href: location.href }, err);
    return;
  }

  const stateChanged = onPage !== lastOnPlaylistPage;
  const playlistId = onPage ? new URL(location.href).searchParams.get('list') : null;
  const playlistChanged = playlistId !== lastPlaylistId;
  lastOnPlaylistPage = onPage;
  lastPlaylistId = playlistId;
  const noteworthy = source !== 'observer' || stateChanged;

  if (!onPage) {
    if (noteworthy) {
      console.info(WL_LOG, 'syncTrigger: not a playlist page', { source, href: location.href });
    }
    WLModal.removeTrigger();
    WLModal.close();
    WLHeadings.stop();
    WLHeadings.clear();
    return;
  }

  let created;
  try {
    created = WLModal.mountTrigger({ onOpen: () => WLPanel.openModal() });
  } catch (err) {
    console.warn(WL_LOG, 'mountTrigger threw', { source }, err);
    return;
  }

  if (noteworthy || created) {
    console.info(WL_LOG, 'syncTrigger: playlist page', {
      source,
      href: location.href,
      created,
      state: WLModal.verifyTrigger(),
    });
  }

  WLPanel.checkViewSort();
  if (playlistId === 'WL' && location.hash !== '#wl-organizer-automation' && (stateChanged || playlistChanged) && !automaticPreviewRunning) {
    clearTimeout(automaticPreviewTimer);
    automaticPreviewTimer = setTimeout(async () => {
      const status = await chrome.runtime.sendMessage({ type: 'AUTO_PREVIEW_STATUS' }).catch(() => null);
      if (!status?.enabled || (!status.manualDryRunCompleted && !status.autoPreviewAllowed) || !onPlaylistPage() || new URL(location.href).searchParams.get('list') !== 'WL' || automaticPreviewRunning) return;
      automaticPreviewRunning = true;
      try {
        if (status.autoOrganize) {
          const result = await chrome.runtime.sendMessage({ type: 'AUTOMATION_ON_OPEN' });
          if (!result?.success) console.warn('[WL] On-open unattended run failed', result?.error || 'No result');
          return;
        }
        await WLPanel.openModal();
        await WLPanel.runSort('ai', { automatic: true, applyAutomatically: status.autoOrganize === true });
      } finally { automaticPreviewRunning = false; }
    }, 900);
  }
  WLModal.syncHeadingsToggle(WLPanel._headingsState, { onToggle: () => WLPanel.toggleHeadings() });
  WLPanel.restoreHeadings();
}

function resetForNavigation() {
  WLPanel._runId++;
  WLPanel.currentSortOrder = [];
  WLPanel.currentPlaylistId = null;
  WLPanel.currentSortOptions = null;
  WLPanel.currentSubjects = [];
  WLPanel.currentReadWarning = null;
  WLPanel.currentReadDiagnostics = null;
  WLPanel.currentCanApply = false;
  WLPanel.currentMode = null;
  WLModal.close();
  WLInnerTube.resetConfig();
  WLHeadings.stop();
  WLHeadings.clear();
  WLPanel._headingsRestoredFor = null;
  WLPanel._headingsState = null;
  WLPanel._viewSortLabel = null;
}

let lastUrl = location.href;

console.info(WL_LOG, 'content script loaded', {
  href: location.href,
  readyState: document.readyState,
  hasBody: Boolean(document.body),
});

function onPageChange(source) {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    resetForNavigation();
  }
  syncTrigger(source);
}

const pageObserver = new MutationObserver(() => onPageChange('observer'));

try {
  pageObserver.observe(document.body, { childList: true, subtree: true });
} catch (err) {
  // H1: no body yet. Retry once the document is ready rather than dying here.
  console.warn(WL_LOG, 'observer attach failed; will retry on DOMContentLoaded', err);
  document.addEventListener('DOMContentLoaded', () => {
    try {
      pageObserver.observe(document.body, { childList: true, subtree: true });
      console.info(WL_LOG, 'observer attached on DOMContentLoaded');
    } catch (retryErr) {
      console.warn(WL_LOG, 'observer attach failed again', retryErr);
    }
  });
}

window.addEventListener('yt-navigate-finish', () => onPageChange('yt-navigate-finish'));
document.addEventListener('DOMContentLoaded', () => onPageChange('DOMContentLoaded'));
window.addEventListener('load', () => onPageChange('load'));

onPageChange('load-time');

function playlistAccountIdentity() {
  const owner = document.querySelector('ytd-playlist-header-renderer #owner a[href], ytd-playlist-header-renderer #owner ytd-channel-name a[href]');
  const href = owner?.getAttribute('href') || '';
  return href.startsWith('/@') || href.startsWith('/channel/') ? href.split(/[?#]/)[0] : null;
}

async function runUnattendedContent(message) {
  const playlistId = new URL(location.href).searchParams.get('list');
  const accountId = playlistAccountIdentity();
  if (location.pathname !== '/playlist' || playlistId !== 'WL') return { success: false, error: 'The automation tab is not Watch Later.' };
  if (!accountId) return { success: false, requiresAttention: true, error: 'Could not identify the signed-in YouTube account from the Watch Later owner header.' };
  if (message.expectedAccountId && accountId !== message.expectedAccountId) return { success: false, requiresAttention: true, accountId, error: 'The signed-in YouTube account does not match the account authorized for unattended sorting.' };

  let snapshot;
  try { snapshot = await WLPlaylist.readSnapshot('WL'); }
  catch (error) {
    const requiresAttention = /count|complete|duplicate|entry|continuation|page limit/i.test(error.message);
    return { success: false, requiresAttention, retrySafe: !requiresAttention, accountId, error: error.message };
  }
  const diagnostics = snapshot.diagnostics || {};
  if (!snapshot.videos.length) return { success: false, requiresAttention: true, accountId, pageCount: diagnostics.pageCount, completenessVerified: snapshot.complete === true, error: snapshot.complete ? 'The validated playlist was empty; refusing unattended sorting.' : (snapshot.reason || 'Playlist completeness could not be verified; refusing to write.') };

  try {
    await WLEnrich.enrich(snapshot.videos);
    const analysis = await chrome.runtime.sendMessage({ type: 'ANALYZE', videos: snapshot.videos, playlistId: 'WL', manualPreview: false });
    if (!analysis?.success) return { success: false, retrySafe: true, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, error: analysis?.error || 'Classification failed.' };
    if (!snapshot.complete) return { success: false, requiresAttention: true, accountId, pageCount: diagnostics.pageCount, completenessVerified: false, classifiedCount: analysis.classifiedCount || 0, error: snapshot.reason || 'Playlist completeness could not be verified; classification was saved but no write was attempted.', preview: analysis.sortOrder.map(video => ({ title: video.title, subject: video.cluster || video.category || '' })) };
    const target = analysis.sortOrder.map(video => video.setVideoId);
    const original = snapshot.videos.map(video => video.setVideoId);
    if (target.length !== original.length || new Set(target).size !== target.length || original.some(id => !target.includes(id))) return { success: false, requiresAttention: true, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, error: 'Calculated order does not preserve every distinct playlist entry.' };
    const alreadyOrdered = target.every((id, index) => id === original[index]);
    if (alreadyOrdered || message.apply !== true) return { success: true, previewOnly: message.apply !== true, alreadyOrdered, applied: false, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, classifiedCount: analysis.classifiedCount || 0, moveCount: 0, preview: analysis.sortOrder.map(video => ({ title: video.title, subject: video.cluster || video.category || '' })) };

    const permit = await chrome.runtime.sendMessage({ type: 'GET_AUTOMATION_PERMIT' });
    if (!permit?.authorized || permit.accountId !== message.expectedAccountId) return { success: false, requiresAttention: true, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, error: 'Unattended authorization changed during analysis; no write was sent.' };
    if (!permit.enabled) return { success: true, previewOnly: true, alreadyOrdered: false, applied: false, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, classifiedCount: analysis.classifiedCount || 0, moveCount: 0, preview: analysis.sortOrder.map(video => ({ title: video.title, subject: video.cluster || video.category || '' })) };

    if (!message.expectedAccountId || playlistAccountIdentity() !== message.expectedAccountId) return { success: false, requiresAttention: true, accountId: playlistAccountIdentity(), pageCount: diagnostics.pageCount, completenessVerified: true, error: 'The YouTube account changed before the reorder. No write was sent.' };
    const viewSort = await WLViewSort.ensureManual();
    if (viewSort !== 'manual') return { success: false, retrySafe: true, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, error: 'Could not confirm YouTube Manual playlist view; no reorder was sent.' };
    const immediate = await WLPlaylist.readSnapshot('WL');
    const immediateOrder = immediate.videos.map(video => video.setVideoId);
    if (!immediate.complete || immediateOrder.join(',') !== original.join(',')) return { success: false, requiresAttention: true, accountId, pageCount: immediate.diagnostics?.pageCount || diagnostics.pageCount, completenessVerified: immediate.complete, error: immediate.reason || 'Watch Later changed since inspection; no reorder was sent.' };
    await WLStorage.setUndo({ playlistId: 'WL', previous: original, current: target, status: 'pending' });
    try {
      const finalPermit = await chrome.runtime.sendMessage({ type: 'GET_AUTOMATION_PERMIT' });
      if (!finalPermit?.enabled || !finalPermit.authorized || finalPermit.accountId !== message.expectedAccountId) {
        await WLStorage.setUndo({ playlistId: 'WL', previous: original, current: target, status: 'not-applied' });
        return { success: true, previewOnly: true, alreadyOrdered: false, applied: false, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, classifiedCount: analysis.classifiedCount || 0, moveCount: 0, preview: analysis.sortOrder.map(video => ({ title: video.title, subject: video.cluster || video.category || '' })) };
      }
      if (playlistAccountIdentity() !== message.expectedAccountId) {
        await WLStorage.setUndo({ playlistId: 'WL', previous: original, current: target, status: 'not-applied' });
        return { success: false, requiresAttention: true, accountId: playlistAccountIdentity(), pageCount: diagnostics.pageCount, completenessVerified: true, error: 'The YouTube account changed immediately before the reorder. No write was sent.' };
      }
      const write = await WLPlaylist.applyOrder('WL', target, { complete: true, originalOrder: original });
      if (!write.applied) {
        await WLStorage.setUndo({ playlistId: 'WL', previous: original, current: target, status: 'not-applied' });
        const retrySafe = write.retrySafe === true && write.originalOrderUnchanged === true && write.completenessVerified === true;
        return { success: false, retrySafe, requiresAttention: !retrySafe, applied: false, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, error: write.error || 'YouTube did not verify the reordered playlist.' };
      }
      await WLStorage.setUndo({ playlistId: 'WL', previous: original, current: target, status: 'verified' });
      return { success: true, applied: true, alreadyOrdered: false, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, classifiedCount: analysis.classifiedCount || 0, moveCount: write.moveCount || 0 };
    } catch (error) {
      await WLStorage.setUndo({ playlistId: 'WL', previous: original, current: target, status: 'uncertain' }).catch(() => {});
      return { success: false, requiresAttention: true, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, error: `Reorder result is uncertain; inspect Watch Later and the saved recovery backup. ${error.message}` };
    }
  } catch (error) {
    return { success: false, retrySafe: true, accountId, pageCount: diagnostics.pageCount, completenessVerified: true, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'AUTOMATION_PING') { sendResponse({ ready: true }); return false; }
  if (message?.type === 'RUN_UNATTENDED_AUTOMATION') { runUnattendedContent(message).then(sendResponse); return true; }
});

// A 20s polling backstop used to live here. It was diagnostic scaffolding for
// "the trigger never mounts on page load", whose root cause turned out to be
// Firefox MV3 host permissions being opt-in — not a missed event path. Its
// secondary job (remount if something removes the trigger) is already covered
// by pageObserver, which fires on any mutation and calls syncTrigger. Removed
// 2026-07-27; see ARCHITECTURE.md.
