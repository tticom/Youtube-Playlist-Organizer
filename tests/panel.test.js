// tests/panel.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load-global.js';

// content/panel.js runs side-effecting code at load time: it sets up a
// MutationObserver, a yt-navigate-finish listener, and calls syncTrigger() once.
// syncTrigger() reads location.pathname/href and, on a playlist page, calls
// WLModal.mountTrigger — so the sandbox must stub `document`, `location`,
// `MutationObserver`, `window`, and `WLModal` even for tests that only want to
// drive WLPanel's methods directly.

const locationStub = {
  href: 'https://www.youtube.com/playlist?list=WL',
  pathname: '/not-playlist', // keeps load-time syncTrigger() from mounting the trigger
  search: '?list=WL',
};

const documentStub = {
  body: {},
  readyState: 'loading',
  querySelector: () => null,
  createElement: () => ({}),
  addEventListener: () => {},
};

class MutationObserverStub {
  observe() {}
  disconnect() {}
}

function loadPanel(sandbox = {}) {
  return loadGlobal('content/panel.js', 'WLPanel', {
    document: documentStub,
    location: locationStub,
    MutationObserver: MutationObserverStub,
    window: { addEventListener: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    WLModal: {
      mountTrigger() {},
      removeTrigger() {},
      syncHeadingsToggle() {},
      verifyTrigger() { return { present: false }; },
      close() {},
      open() {},
      showBusy() {},
      showPreview() {},
      showError() {},
      setStatus() {},
    },
    WLViewSort: { ensureManual: async () => 'manual', current: () => 'Manual' },
    WLInnerTube: { resetConfig() {} },
    WLPlaylist: {},
    WLEnrich: {},
    WLStorage: {
      getGroupMap: async () => ({}),
      setGroupMap: async () => {},
      getUndo: async () => ({}),
      setUndo: async () => {},
    },
    WLHeadings: {
      boundariesFrom: () => [],
      hashIds: () => '',
      watch() {},
      stop() {},
      clear() {},
    },
    chrome: { runtime: { sendMessage: async () => ({ success: true, sortOrder: [] }), onMessage: { addListener() {} } } },
    ...sandbox,
  });
}

/**
 * Loads WLPanel wired with stubs for chrome.runtime.sendMessage,
 * WLPlaylist.read/applyOrder, WLEnrich.enrich, WLStorage.toggleOverride, and a
 * spyable WLModal — everything runSort()/applySort()/toggleUnwatched() touch.
 *
 * `reload` stubs `location.reload` (needed by applySort's post-sort reload).
 * `runTimers`, when set, makes the sandboxed `setTimeout` invoke its callback
 * synchronously instead of scheduling a real 1.2s wait.
 * `sortOrder`/`playlistId`, when set, seed WLPanel state so applySort()/
 * toggleUnwatched() can be called directly without going through runSort() first.
 * `setGroupMap`, when set, replaces the default no-op WLStorage.setGroupMap —
 * used by the post-sort persistence tests to observe ordering/timing.
 * `mode` seeds currentMode (default 'ai', the only mode whose session accepts
 * toggleUnwatched()/changeSortOptions()); runSort() overwrites it.
 */
function loadPanelWithStubs({ sendMessage, enrich, videos, readSnapshot, applyOrder, toggleOverride, reload, runTimers, sortOrder, playlistId, setGroupMap, setSortOptions, sortOptions, ensureManual, getUndo, setUndo, mode = 'ai', location, document }) {
  const modalCalls = { showBusy: [], showPreview: [], showPreviewOptions: [], showPreviewMeta: [], showError: [], setStatus: [], headingsToggle: [] };
  const runtimeMessages = { listener: null };
  const sandbox = {
    chrome: { runtime: { sendMessage, onMessage: { addListener(listener) { runtimeMessages.listener = listener; } } } },
    WLViewSort: { ensureManual: ensureManual || (async () => 'manual'), current: () => 'Manual' },
    WLPlaylist: { read: async () => videos, readSnapshot: readSnapshot || (async () => ({ videos: videos || [], complete: true })), applyOrder },
    WLEnrich: { enrich },
    WLStorage: {
      toggleOverride,
      setGroupMap: setGroupMap || (async () => {}),
      setSortOptions: setSortOptions || (async () => {}),
      getGroupMap: async () => ({}),
      getUndo: getUndo || (async () => ({})),
      setUndo: setUndo || (async () => {}),
    },
    WLHeadings: {
      boundariesFrom: (order) => order,
      hashIds: () => 'hash',
      watch() {},
      stop() {},
      clear() {},
    },
    WLModal: {
      mountTrigger() {},
      removeTrigger() {},
      syncHeadingsToggle(state) { modalCalls.headingsToggle.push(state); },
      verifyTrigger() { return { present: false }; },
      close() {},
      open() {},
      showBusy(text) { modalCalls.showBusy.push(text); },
      showPreview(order, options, subjects, meta) { modalCalls.showPreview.push(order); modalCalls.showPreviewOptions.push(options); modalCalls.showPreviewMeta.push(meta); },
      showError(msg) { modalCalls.showError.push(msg); },
      setStatus(text) { modalCalls.setStatus.push(text); },
    },
  };
  if (reload) {
    sandbox.location = { ...locationStub, reload };
  }
  if (location) sandbox.location = location;
  if (document) sandbox.document = document;
  if (runTimers) {
    sandbox.setTimeout = (fn) => { fn(); return 0; };
  }
  const WLPanel = loadPanel(sandbox);
  if (sortOrder) WLPanel.currentSortOrder = sortOrder;
  if (playlistId) WLPanel.currentPlaylistId = playlistId;
  if (sortOptions) WLPanel.currentSortOptions = sortOptions;
  if (sortOrder) WLPanel.currentCanApply = true;
  WLPanel.currentMode = mode;
  return { WLPanel, modalCalls, WLModal: sandbox.WLModal, runtimeMessages };
}

describe('runSort mode selection', () => {
  it('sends SORT_BY_DURATION and never enriches in duration mode', async () => {
    const sent = [];
    let enriched = false;
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [] }; },
      enrich: async () => { enriched = true; },
      videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 0 }],
    });

    await WLPanel.runSort('duration');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'SORT_BY_DURATION');
    assert.equal(enriched, false, 'duration mode must not pay for enrichment');
  });

  it('sends SORT_BY_DURATION with by: duration and the unchanged busy text in duration mode', async () => {
    const sent = [];
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [] }; },
      enrich: async () => {},
      videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 0 }],
      mode: null,
    });

    await WLPanel.runSort('duration');

    assert.equal(sent[0].by, 'duration');
    assert.ok(modalCalls.showBusy.includes('Sorting by duration...'));
    assert.equal(WLPanel.currentMode, 'duration');
  });

  for (const mode of ['title', 'channel']) {
    it(`sends SORT_BY_DURATION with by: ${mode} and never enriches in ${mode} mode`, async () => {
      const sent = [];
      let enriched = false;
      const { WLPanel, modalCalls } = loadPanelWithStubs({
        sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [] }; },
        enrich: async () => { enriched = true; },
        videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 0 }],
        mode: null,
      });

      await WLPanel.runSort(mode);

      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'SORT_BY_DURATION');
      assert.equal(sent[0].by, mode);
      assert.equal(enriched, false);
      assert.ok(modalCalls.showBusy.includes(`Sorting by ${mode}...`));
      assert.equal(WLPanel.currentMode, mode);
    });
  }

  it('enriches and sends ANALYZE with a playlistId in ai mode', async () => {
    const sent = [];
    let enriched = false;
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [] }; },
      enrich: async () => { enriched = true; },
      videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 0 }],
    });

    await WLPanel.runSort('ai');

    assert.equal(enriched, true);
    assert.equal(sent[0].type, 'ANALYZE');
    assert.ok(sent[0].playlistId, 'ANALYZE must carry the playlistId');
    assert.equal(WLPanel.currentMode, 'ai');
  });
});

describe('background unattended content handler', () => {
  function accountDocument() {
    return { ...documentStub, querySelector: () => ({ getAttribute: () => '/@example' }) };
  }
  function invoke(listener, message) {
    return new Promise(resolve => {
      const keepAlive = listener(message, {}, resolve);
      assert.equal(keepAlive, true, 'asynchronous automation handler keeps the response channel open');
    });
  }

  it('classifies available entries but refuses a write when completeness is unverified', async () => {
    const videos = [{ id: 'a', setVideoId: 'A', title: 'A', unavailable: false }];
    let writes = 0;
    const loc = { href: 'https://www.youtube.com/playlist?list=WL#wl-organizer-automation', pathname: '/not-playlist', search: '?list=WL', hash: '#wl-organizer-automation' };
    const { runtimeMessages } = loadPanelWithStubs({
      sendMessage: async message => message.type === 'ANALYZE' ? { success: true, sortOrder: videos, classifiedCount: 1 } : { success: true },
      enrich: async () => {}, videos, location: loc, document: accountDocument(),
      readSnapshot: async () => ({ videos, complete: false, reason: 'header count mismatched', diagnostics: { pageCount: 1 } }),
      applyOrder: async () => { writes++; return { applied: true, moveCount: 1 }; },
    });
    loc.pathname = '/playlist';
    const result = await invoke(runtimeMessages.listener, { type: 'RUN_UNATTENDED_AUTOMATION', apply: true, expectedAccountId: '/@example' });
    assert.equal(result.success, false);
    assert.equal(result.requiresAttention, true);
    assert.equal(result.classifiedCount, 1);
    assert.equal(writes, 0);
  });

  it('skips the reorder call entirely when the validated order is already current', async () => {
    const videos = [{ id: 'a', setVideoId: 'A', title: 'A', unavailable: false }];
    let writes = 0;
    const loc = { href: 'https://www.youtube.com/playlist?list=WL#wl-organizer-automation', pathname: '/not-playlist', search: '?list=WL', hash: '#wl-organizer-automation' };
    const { runtimeMessages } = loadPanelWithStubs({
      sendMessage: async message => message.type === 'ANALYZE' ? { success: true, sortOrder: videos, classifiedCount: 0 } : { success: true },
      enrich: async () => {}, videos, location: loc, document: accountDocument(),
      readSnapshot: async () => ({ videos, complete: true, diagnostics: { pageCount: 1 } }),
      applyOrder: async () => { writes++; return { applied: true, moveCount: 1 }; },
    });
    loc.pathname = '/playlist';
    const result = await invoke(runtimeMessages.listener, { type: 'RUN_UNATTENDED_AUTOMATION', apply: true, expectedAccountId: '/@example' });
    assert.equal(result.success, true);
    assert.equal(result.alreadyOrdered, true);
    assert.equal(writes, 0);
  });

  it('stores a recovery backup before invoking the mocked reorder and reports verified persistence', async () => {
    const a = { id: 'a', setVideoId: 'A', title: 'A', unavailable: false };
    const b = { id: 'b', setVideoId: 'B', title: 'B', unavailable: false };
    const videos = [a, b]; const target = [b, a]; const backups = []; const events = [];
    const loc = { href: 'https://www.youtube.com/playlist?list=WL#wl-organizer-automation', pathname: '/not-playlist', search: '?list=WL', hash: '#wl-organizer-automation' };
    const { runtimeMessages } = loadPanelWithStubs({
      sendMessage: async message => message.type === 'ANALYZE' ? { success: true, sortOrder: target, classifiedCount: 1 } : { success: true, enabled: true, authorized: true, accountId: '/@example', mode: 'scheduled' },
      enrich: async () => {}, videos, location: loc, document: accountDocument(),
      readSnapshot: async () => ({ videos, complete: true, diagnostics: { pageCount: 1 } }),
      ensureManual: async () => 'manual',
      setUndo: async value => { backups.push(value); events.push(`backup:${value.status}`); },
      applyOrder: async (_playlistId, order, options) => { events.push('write'); assert.deepEqual(order, ['B', 'A']); assert.deepEqual(options.originalOrder, ['A', 'B']); return { applied: true, moveCount: 1, waitedMs: 25 }; },
    });
    loc.pathname = '/playlist';
    const result = await invoke(runtimeMessages.listener, { type: 'RUN_UNATTENDED_AUTOMATION', apply: true, expectedAccountId: '/@example' });
    assert.equal(result.success, true);
    assert.equal(result.applied, true);
    assert.deepEqual(events, ['backup:pending', 'write', 'backup:verified']);
    assert.deepEqual(backups[0].previous, ['A', 'B']);
  });
});

describe('RESORT is AI-only', () => {
  // The background answers RESORT from the last AI run's cache, so a resort
  // requested from a simple-sort preview would repaint it with that grouping.
  for (const mode of ['duration', 'title', 'channel', null]) {
    it(`toggleUnwatched sends nothing and touches nothing when the mode is ${mode}`, async () => {
      const sent = [];
      let toggled = false;
      const { WLPanel, modalCalls } = loadPanelWithStubs({
        sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [] }; },
        toggleOverride: async () => { toggled = true; return ['v1']; },
        playlistId: 'PL1',
        sortOrder: [{ id: 'a', setVideoId: 'A' }],
        mode,
      });

      await WLPanel.toggleUnwatched('v1');

      assert.deepEqual(sent, []);
      assert.equal(toggled, false, 'the stored override must not flip either');
      assert.deepEqual(modalCalls.setStatus, []);
      assert.deepEqual(modalCalls.showPreview, []);
      assert.deepEqual(WLPanel.currentSortOrder.map(v => v.id), ['a']);
    });

    it(`changeSortOptions sends nothing and saves nothing when the mode is ${mode}`, async () => {
      const sent = [];
      const saved = [];
      const { WLPanel, modalCalls } = loadPanelWithStubs({
        sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [] }; },
        setSortOptions: async (opts) => { saved.push(opts); },
        playlistId: 'PL1',
        mode,
      });

      await WLPanel.changeSortOptions({ withinGroup: 'title', inProgress: 'top', groupOrder: 'alpha' });

      assert.deepEqual(sent, []);
      assert.deepEqual(saved, []);
      assert.deepEqual(modalCalls.setStatus, []);
    });
  }

  it('a duration run after an AI run closes the door: the next toggle sends nothing', async () => {
    const sent = [];
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [] }; },
      enrich: async () => {},
      toggleOverride: async () => ['v1'],
      videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 50 }],
    });

    await WLPanel.runSort('ai');
    await WLPanel.runSort('duration');
    await WLPanel.toggleUnwatched('v1');

    assert.deepEqual(sent.map(m => m.type), ['ANALYZE', 'SORT_BY_DURATION']);
  });
});

describe('runSort — stale run supersession (run token)', () => {
  // Both scenarios below drive the SAME WLPanel instance through two overlapping
  // runSort() calls, the way a real Cancel-then-switch-modes or navigate-mid-sort
  // sequence would. Run A is parked on a controllable deferred promise so run B can
  // start, finish, and render before A is allowed to resume — proving A's late
  // arrival is a no-op rather than a race that sometimes passes.

  it('a superseded run does not call WLModal.showPreview — the newer run\'s order wins', async () => {
    let resolveA;
    let signalReachedA;
    const deferredA = new Promise((resolve) => { resolveA = resolve; });
    const reachedA = new Promise((resolve) => { signalReachedA = resolve; });

    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async (msg) => {
        if (msg.type === 'ANALYZE') {
          // Run A (ai mode) blocks here until the test lets it through.
          signalReachedA();
          await deferredA;
          return { success: true, sortOrder: [{ id: 'a', setVideoId: 'A', cluster: 'Topic', duration: 60 }] };
        }
        // Run B (duration mode) resolves immediately.
        return { success: true, sortOrder: [{ id: 'b', setVideoId: 'B', cluster: null, duration: 30, percentWatched: 0 }] };
      },
      enrich: async () => {},
      videos: [{ id: 'x', setVideoId: 'X', duration: 60, percentWatched: 0 }],
    });

    const runA = WLPanel.runSort('ai'); // starts; will park inside the ANALYZE sendMessage call
    await reachedA; // wait until A is actually parked, not just "started"
    await WLPanel.runSort('duration'); // supersedes A (bumps _runId) and completes fully

    assert.deepEqual(
      modalCalls.showPreview.map(order => order.map(v => v.setVideoId)),
      [['B']],
      'only run B\'s order should have been shown'
    );

    resolveA(); // let A resume — its runId no longer matches WLPanel._runId
    await runA;

    assert.deepEqual(
      modalCalls.showPreview.map(order => order.map(v => v.setVideoId)),
      [['B']],
      'a superseded run must not call showPreview once it resolves'
    );
  });

  it('a superseded run does not call WLModal.showError when it fails after being superseded', async () => {
    let rejectA;
    let signalReachedA;
    const deferredA = new Promise((_resolve, reject) => { rejectA = reject; });
    const reachedA = new Promise((resolve) => { signalReachedA = resolve; });

    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async (msg) => {
        if (msg.type === 'ANALYZE') {
          signalReachedA();
          await deferredA; // will reject once the test triggers it
        }
        return { success: true, sortOrder: [{ id: 'b', setVideoId: 'B', cluster: null, duration: 30, percentWatched: 0 }] };
      },
      enrich: async () => {},
      videos: [{ id: 'x', setVideoId: 'X', duration: 60, percentWatched: 0 }],
    });

    const runA = WLPanel.runSort('ai'); // starts; will park inside the ANALYZE sendMessage call
    await reachedA; // wait until A is actually parked, not just "started"
    await WLPanel.runSort('duration'); // supersedes A (bumps _runId) and completes fully

    rejectA(new Error('boom')); // A's sendMessage now throws, caught by runSort's catch block
    await runA;

    assert.equal(
      modalCalls.showError.length,
      0,
      'a superseded run must not paint an error over a newer run\'s preview'
    );
  });
});

describe('applySort — post-sort reload', () => {
  it('reloads after a confirmed sort', async () => {
    let reloaded = false;
    const { WLPanel } = loadPanelWithStubs({
      applyOrder: async () => ({ applied: true, waitedMs: 1200 }),
      reload: () => { reloaded = true; },
      runTimers: true,
      sortOrder: [{ id: 'a', setVideoId: 'A' }],
      playlistId: 'WL',
    });

    await WLPanel.applySort();
    assert.equal(reloaded, true);
  });

  it('does NOT reload when the order never converged', async () => {
    let reloaded = false;
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      applyOrder: async () => ({ applied: false, waitedMs: 10000 }),
      reload: () => { reloaded = true; },
      runTimers: true,
      sortOrder: [{ id: 'a', setVideoId: 'A' }],
      playlistId: 'WL',
    });

    await WLPanel.applySort();
    assert.equal(reloaded, false, 'a failed sort must leave the error on screen');
    assert.equal(modalCalls.showError.length, 1);
  });

  it('does NOT reload when applyOrder throws', async () => {
    let reloaded = false;
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      applyOrder: async () => { throw new Error('network blew up'); },
      reload: () => { reloaded = true; },
      runTimers: true,
      sortOrder: [{ id: 'a', setVideoId: 'A' }],
      playlistId: 'WL',
    });

    await WLPanel.applySort();
    assert.equal(reloaded, false, 'a thrown apply error must leave the error on screen');
    assert.deepEqual(modalCalls.showError, ['network blew up']);
  });

  it('a superseded apply does not reload and does not announce success', async () => {
    let resolveApply;
    let signalReachedApply;
    const deferredApply = new Promise((resolve) => { resolveApply = resolve; });
    const reachedApply = new Promise((resolve) => { signalReachedApply = resolve; });

    let reloaded = false;
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      applyOrder: async () => {
        signalReachedApply();
        await deferredApply;
        return { applied: true, waitedMs: 1200 };
      },
      reload: () => { reloaded = true; },
      runTimers: true,
      sortOrder: [{ id: 'a', setVideoId: 'A' }],
      playlistId: 'WL',
    });

    const apply = WLPanel.applySort(); // parks inside applyOrder
    await reachedApply;

    // Simulate navigating away mid-apply, exactly what resetForNavigation() does
    // to the run token.
    WLPanel._runId++;

    resolveApply(); // let the stale apply resolve now that a newer session owns the token
    await apply;

    assert.equal(reloaded, false, 'a superseded apply must not reload the page out from under a newer session');
    assert.ok(
      !modalCalls.showBusy.some(text => text.startsWith('Sort complete')),
      'a superseded apply must not announce success into a newer session'
    );
  });

  it('does not reload when the run token changes before the reload timer fires', async () => {
    // The ownership check that gates scheduling the timer is not enough: if
    // the user clicks into a video within the 1.2s window (bumping _runId the
    // same way resetForNavigation() does), the timer must not fire a reload
    // for the page the user already left.
    let reloaded = false;
    let scheduledFn;

    const WLPanel = loadPanel({
      WLPlaylist: { readSnapshot: async () => ({ videos: [{ setVideoId: 'A' }], complete: true }), applyOrder: async () => ({ applied: true, waitedMs: 1200 }) },
      WLHeadings: {
        boundariesFrom: () => [],
        hashIds: () => 'hash',
        watch() {}, stop() {}, clear() {},
      },
      WLStorage: { setGroupMap: async () => {}, getGroupMap: async () => ({}), setUndo: async () => {} },
      location: { ...locationStub, reload: () => { reloaded = true; } },
      setTimeout: (fn) => { scheduledFn = fn; return 1; },
    });
    WLPanel.currentSortOrder = [{ id: 'a', setVideoId: 'A' }];
    WLPanel.currentPlaylistId = 'WL';
    WLPanel.currentCanApply = true;

    await WLPanel.applySort();
    assert.ok(scheduledFn, 'setup: applySort must schedule a reload timer');

    WLPanel._runId++; // simulate navigating within the 1.2s window
    scheduledFn(); // the timer fires now that a newer session owns the token

    assert.equal(reloaded, false, 'the reload callback must re-check ownership when it fires, not just when scheduled');
  });
});

describe('applySort — group map persistence', () => {
  it('persists the group map before scheduling the reload, and awaits the write', async () => {
    const events = [];
    let persistedMap;

    const { WLPanel } = loadPanelWithStubs({
      applyOrder: async () => ({ applied: true, waitedMs: 1200 }),
      reload: () => { events.push('reload'); },
      runTimers: true,
      sortOrder: [{ id: 'a', setVideoId: 'A', cluster: 'Music' }],
      playlistId: 'WL',
      setGroupMap: async (map) => {
        persistedMap = map;
        events.push('setGroupMap-called');
        // A real (unstubbed) delay: setTimeout here is the test file's own
        // Node global, not the sandbox's overridden one, so this genuinely
        // yields. If applySort scheduled the reload without awaiting this
        // promise, 'reload' would land before 'setGroupMap-resolved'.
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push('setGroupMap-resolved');
      },
    });

    await WLPanel.applySort();

    assert.deepEqual(events, ['setGroupMap-called', 'setGroupMap-resolved', 'reload']);
    assert.equal(persistedMap.playlistId, 'WL');
  });

  it('clears the stored group map in duration mode, where boundariesFrom returns an empty array', async () => {
    // Regression: this used to SKIP the write when boundaries were empty, which
    // is not neutral — a previous AI sort's grouping survived it, and
    // restoreHeadings() re-injected those headings after the reload, scattered
    // through the new duration order. Its staleness check does not catch that,
    // because hashIds is order-independent: re-sorting the same set of videos
    // leaves the hash identical. The write must therefore clear the map.
    //
    // buildDurationSortOrder videos carry no `cluster` key at all, so the real
    // WLHeadings.boundariesFrom(...) returns []. Uses loadPanel() directly (not
    // loadPanelWithStubs, whose default WLHeadings.boundariesFrom stub just
    // echoes the order back) so the empty-boundaries case is actually exercised.
    const stored = [];
    const headingCalls = [];

    const WLPanel = loadPanel({
      WLPlaylist: { readSnapshot: async () => ({ videos: [{ setVideoId: 'A' }], complete: true }), applyOrder: async () => ({ applied: true, waitedMs: 1200 }) },
      WLHeadings: {
        boundariesFrom: () => [],
        hashIds: () => 'hash',
        watch() {},
        stop() { headingCalls.push('stop'); },
        clear() { headingCalls.push('clear'); },
      },
      WLStorage: {
        setGroupMap: async (map) => { stored.push(map); },
        getGroupMap: async () => ({}),
        setUndo: async () => {},
      },
      location: { ...locationStub, reload: () => {} },
      setTimeout: (fn) => { fn(); return 0; },
    });
    WLPanel.currentSortOrder = [{ id: 'a', setVideoId: 'A', duration: 60 }];
    WLPanel.currentPlaylistId = 'WL';
    WLPanel.currentCanApply = true;

    // Loading the module runs onPageChange('load-time'), and locationStub is
    // not a playlist URL, so syncTrigger's not-a-playlist-page branch already
    // called stop()/clear() once. Drop those so the assertion below is about
    // applySort and nothing else.
    headingCalls.length = 0;

    await WLPanel.applySort();

    assert.equal(stored.length, 1, 'a duration-mode apply must write, not skip');
    assert.deepEqual({ ...stored[0] }, {}, 'the write must clear the stored grouping');
    // The reload normally destroys these anyway; they matter when it is
    // cancelled or fails, which would otherwise leave stale headings on screen.
    assert.deepEqual([...headingCalls], ['stop', 'clear'], 'live headings must be torn down too');
  });

  it('persists nothing when the apply did not converge', async () => {
    let setGroupMapCalled = false;

    const { WLPanel } = loadPanelWithStubs({
      applyOrder: async () => ({ applied: false, waitedMs: 10000 }),
      reload: () => {},
      runTimers: true,
      sortOrder: [{ id: 'a', setVideoId: 'A', cluster: 'Music' }],
      playlistId: 'WL',
      setGroupMap: async () => { setGroupMapCalled = true; },
    });

    await WLPanel.applySort();

    assert.equal(setGroupMapCalled, false, 'a failed apply must not persist a group map');
  });

  it('a superseded apply does not announce success or reload when navigation happens during the persistence write', async () => {
    // Regression test: the ownership check right after applyOrder() resolves
    // does NOT cover the later `await WLStorage.setGroupMap(...)` — that is a
    // second await, and resetForNavigation()'s synchronous _runId bump can land
    // inside it just as easily as inside applyOrder(). Without a re-check after
    // the persistence await, a navigate-away here would still announce "Sort
    // complete" and reload the page out from under the session the user left.
    let resolveSetGroupMap;
    let signalReachedSetGroupMap;
    const deferred = new Promise((resolve) => { resolveSetGroupMap = resolve; });
    const reached = new Promise((resolve) => { signalReachedSetGroupMap = resolve; });

    let reloaded = false;
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      applyOrder: async () => ({ applied: true, waitedMs: 1200 }),
      reload: () => { reloaded = true; },
      runTimers: true,
      sortOrder: [{ id: 'a', setVideoId: 'A', cluster: 'Music' }],
      playlistId: 'WL',
      setGroupMap: async () => {
        signalReachedSetGroupMap();
        await deferred;
      },
    });

    const apply = WLPanel.applySort(); // parks inside setGroupMap
    await reached;

    // Simulate navigating away mid-persist, exactly what resetForNavigation()
    // does to the run token.
    WLPanel._runId++;

    resolveSetGroupMap(); // let the stale apply's persistence write resolve
    await apply;

    assert.equal(reloaded, false, 'a superseded apply must not reload after navigating away mid-persist');
    assert.ok(
      !modalCalls.showBusy.some(text => text.startsWith('Sort complete')),
      'a superseded apply must not announce success after navigating away mid-persist'
    );
  });

  it('still reloads when persisting the group map fails', async () => {
    // A storage failure must not turn into a stuck modal: applySort() is
    // invoked fire-and-forget from the modal's onApply, so an uncaught
    // rejection here would be an unhandled rejection with no visible error and
    // no reload. The sort itself already succeeded — headings are a
    // convenience on top of it.
    const originalWarn = console.warn;
    console.warn = () => {}; // expected warning; silence it for this assertion
    let reloaded = false;
    try {
      const { WLPanel, modalCalls } = loadPanelWithStubs({
        applyOrder: async () => ({ applied: true, waitedMs: 1200 }),
        reload: () => { reloaded = true; },
        runTimers: true,
        sortOrder: [{ id: 'a', setVideoId: 'A', cluster: 'Music' }],
        playlistId: 'WL',
        setGroupMap: async () => { throw new Error('storage quota exceeded'); },
      });

      await assert.doesNotReject(() => WLPanel.applySort());

      assert.equal(reloaded, true, 'a persistence failure must not block the reload');
      assert.ok(
        modalCalls.showBusy.some(text => text.startsWith('Sort complete')),
        'success should still be announced even when headings fail to persist'
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('restoreHeadings', () => {
  it('performs at most one playlist read even when called repeatedly', async () => {
    let readCalls = 0;
    let watchCalls = 0;

    const WLPanel = loadPanel({
      WLStorage: {
        getGroupMap: async () => ({
          playlistId: 'WL',
          boundaries: [{ videoId: 'a', name: 'Music', count: 1 }],
          videoIdsHash: 'match',
        }),
        setGroupMap: async () => {},
      },
      WLPlaylist: { read: async () => { readCalls++; return [{ id: 'a' }]; } },
      WLHeadings: {
        boundariesFrom: () => [],
        hashIds: () => 'match',
        watch: () => { watchCalls++; },
        stop() {},
        clear() {},
      },
    });

    await WLPanel.restoreHeadings();
    await WLPanel.restoreHeadings();
    await WLPanel.restoreHeadings();

    assert.equal(readCalls, 1, 'restoreHeadings must guard against repeated calls for the same playlist');
    assert.equal(watchCalls, 1, 'headings should only be (re)watched once per playlist');
  });

  it('clears the stored map and injects nothing when the video-set hash differs', async () => {
    let persistedMap;
    let watchCalled = false;

    const WLPanel = loadPanel({
      WLStorage: {
        getGroupMap: async () => ({
          playlistId: 'WL',
          boundaries: [{ videoId: 'a', name: 'Music', count: 1 }],
          videoIdsHash: 'stale-hash',
        }),
        setGroupMap: async (map) => { persistedMap = map; },
      },
      WLPlaylist: { read: async () => [{ id: 'b' }] },
      WLHeadings: {
        boundariesFrom: () => [],
        hashIds: () => 'fresh-hash',
        watch: () => { watchCalled = true; },
        stop() {},
        clear() {},
      },
    });

    await WLPanel.restoreHeadings();

    // persistedMap is a vm-sandbox-realm object; spread into a main-realm
    // plain object before deepEqual, or the comparison fails on prototype
    // identity even when every field matches (see tests/headings.test.js).
    assert.deepEqual({ ...persistedMap }, {}, 'a hash mismatch must clear the stored group map');
    assert.equal(watchCalled, false, 'stale groupings must not be injected');
  });

  it('does not throw when the stored group map cannot be read', async () => {
    // restoreHeadings() is called unawaited from syncTrigger(), so a rejected
    // await here would be an unhandled rejection rather than a visible error.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const WLPanel = loadPanel({
        WLStorage: {
          getGroupMap: async () => { throw new Error('storage broken'); },
          setGroupMap: async () => {},
        },
      WLPlaylist: { read: async () => { throw new Error('must not be called'); } },
        WLHeadings: {
          boundariesFrom: () => [],
          hashIds: () => 'x',
          watch: () => { throw new Error('must not be called'); },
          stop() {},
          clear() {},
        },
      });

      await assert.doesNotReject(() => WLPanel.restoreHeadings());
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not throw when clearing a stale group map fails', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const WLPanel = loadPanel({
        WLStorage: {
          getGroupMap: async () => ({
            playlistId: 'WL',
            boundaries: [{ videoId: 'a', name: 'Music', count: 1 }],
            videoIdsHash: 'stale-hash',
          }),
          setGroupMap: async () => { throw new Error('storage broken'); },
        },
        WLPlaylist: { read: async () => [{ id: 'b' }] },
        WLHeadings: {
          boundariesFrom: () => [],
          hashIds: () => 'fresh-hash',
          watch: () => { throw new Error('must not be called'); },
          stop() {},
          clear() {},
        },
      });

      await assert.doesNotReject(() => WLPanel.restoreHeadings());
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not call WLHeadings.watch when the run token changes while WLPlaylist.read is pending', async () => {
    // restoreHeadings() is fire-and-forget from syncTrigger() and awaits a
    // multi-page network call (WLPlaylist.read) before re-arming the
    // observer. resetForNavigation() bumps _runId but has no way to cancel
    // this in-flight call, so restoreHeadings must re-check ownership itself
    // right before watch() — otherwise a late continuation re-arms the
    // observer with a stale (or, after navigating off the playlist entirely,
    // permanently dangling) boundaries set.
    let watchCalled = false;
    let resolveRead;
    let signalReachedRead;
    const deferredRead = new Promise((resolve) => { resolveRead = resolve; });
    const reachedRead = new Promise((resolve) => { signalReachedRead = resolve; });

    const WLPanel = loadPanel({
      WLStorage: {
        getGroupMap: async () => ({
          playlistId: 'WL',
          boundaries: [{ videoId: 'a', name: 'Music', count: 1 }],
          videoIdsHash: 'match',
        }),
        setGroupMap: async () => {},
      },
      WLPlaylist: {
        read: async () => {
          signalReachedRead();
          return deferredRead;
        },
      },
      WLHeadings: {
        boundariesFrom: () => [],
        hashIds: () => 'match',
        watch: () => { watchCalled = true; },
        stop() {},
        clear() {},
      },
    });

    const restore = WLPanel.restoreHeadings(); // parks inside WLPlaylist.read
    await reachedRead;

    // Simulate resetForNavigation() firing mid-flight.
    WLPanel._runId++;

    resolveRead([{ id: 'a' }]);
    await restore;

    assert.equal(watchCalled, false, 'a stale restoreHeadings must not re-arm the observer after navigation');
  });
});

describe('toggleUnwatched', () => {
  it('sends RESORT with the current playlistId and never triggers a Claude call', async () => {
    const sent = [];
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [{ id: 'b', setVideoId: 'B', cluster: null, duration: 10, percentWatched: 0 }] }; },
      toggleOverride: async () => ['v1'],
      playlistId: 'PL123',
    });

    await WLPanel.toggleUnwatched('v1');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'RESORT');
    assert.equal(sent[0].playlistId, 'PL123');
    assert.deepEqual(sent[0].overrides, ['v1']);
    assert.deepEqual(
      modalCalls.showPreview[0].map(v => v.setVideoId),
      ['B']
    );
  });

  it('surfaces an error via WLModal.showError when RESORT fails', async () => {
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: false, error: 'stale clusters' }),
      toggleOverride: async () => ['v1'],
      playlistId: 'PL123',
    });

    await WLPanel.toggleUnwatched('v1');

    assert.deepEqual(modalCalls.showError, ['stale clusters']);
  });

  it('a superseded toggle does not call WLModal.showPreview or mutate currentSortOrder', async () => {
    let resolveResort;
    let signalReachedResort;
    const deferredResort = new Promise((resolve) => { resolveResort = resolve; });
    const reachedResort = new Promise((resolve) => { signalReachedResort = resolve; });

    const staleOrder = [{ id: 'stale', setVideoId: 'STALE' }];
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async (msg) => {
        if (msg.type === 'RESORT') {
          signalReachedResort();
          await deferredResort;
          return { success: true, sortOrder: [{ id: 'a', setVideoId: 'A', cluster: null, duration: 10, percentWatched: 0 }] };
        }
        throw new Error(`unexpected message ${msg.type}`);
      },
      toggleOverride: async () => ['v1'],
      playlistId: 'PL-A',
      sortOrder: staleOrder,
    });

    const toggle = WLPanel.toggleUnwatched('v1'); // parks inside the RESORT sendMessage call
    await reachedResort;

    // Simulate navigating away mid-toggle, exactly what resetForNavigation() does
    // to the run token.
    WLPanel._runId++;

    resolveResort(); // let the stale RESORT resolve now that a newer session owns the token
    await toggle;

    assert.deepEqual(modalCalls.showPreview, [], 'a superseded toggle must not render into a newer session');
    assert.deepEqual(WLPanel.currentSortOrder, staleOrder, 'a superseded toggle must not overwrite currentSortOrder');
  });

  it('shows an error and does not throw when sendMessage rejects', async () => {
    // toggleUnwatched() was the only orchestration method without a
    // try/catch, and the modal invokes it fire-and-forget — a rejection
    // (e.g. "Extension context invalidated" after an extension reload) would
    // otherwise be an unhandled rejection with the modal stuck on
    // "Re-sorting..." forever.
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => { throw new Error('Extension context invalidated'); },
      toggleOverride: async () => ['v1'],
      playlistId: 'PL123',
    });

    await assert.doesNotReject(() => WLPanel.toggleUnwatched('v1'));

    assert.deepEqual(modalCalls.showError, ['Extension context invalidated']);
  });
});

/**
 * Minimal document stub for loading content/modal.js directly — same shape as
 * documentStub above (body/createElement/querySelector), just stateful enough
 * to let #wl-trigger's presence flip after mountTrigger appends it.
 */
function makeTriggerDocument() {
  let mounted = null;
  return {
    body: { appendChild: (el) => { mounted = el; } },
    createElement: () => ({ setAttribute() {}, addEventListener() {} }),
    querySelector: (selector) => (selector === '#wl-trigger' ? mounted : null),
  };
}

describe('mountTrigger return value', () => {
  it('reports true when it creates the trigger and false when one exists', () => {
    const created = [];
    const doc = makeTriggerDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', {
      document: doc,
      getComputedStyle: () => ({ position: 'fixed', zIndex: '1', display: 'block', visibility: 'visible' }),
    });

    assert.equal(modal.mountTrigger({ onOpen: () => created.push(1) }), true);
    assert.equal(modal.mountTrigger({ onOpen: () => created.push(1) }), false, 'second call must not create a duplicate');
  });
});

describe('sort options plumbing', () => {
  const OPTS = { withinGroup: 'title', inProgress: 'within', groupOrder: 'alpha' };

  it('runSort passes the options ANALYZE used to the preview and remembers them', async () => {
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true, sortOrder: [], sortOptions: OPTS }),
      enrich: async () => {},
      videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 0 }],
    });

    await WLPanel.runSort('ai');

    assert.deepEqual({ ...modalCalls.showPreviewOptions[0] }, OPTS);
    assert.deepEqual({ ...WLPanel.currentSortOptions }, OPTS);
  });

  it('runSort in duration mode shows the preview without an options row', async () => {
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true, sortOrder: [] }),
      enrich: async () => {},
      videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 0 }],
    });

    await WLPanel.runSort('duration');

    assert.equal(modalCalls.showPreviewOptions[0], null);
  });

  it('shows the incomplete-read warning and prevents Apply for an unverified preview', async () => {
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true, sortOrder: [] }),
      videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 0 }],
      readSnapshot: async () => ({ videos: [{ id: 'a', setVideoId: 'A', duration: 60, percentWatched: 0 }], complete: false }),
    });
    await WLPanel.runSort('duration');
    assert.equal(modalCalls.showPreviewMeta[0].canApply, false);
    assert.match(modalCalls.showPreviewMeta[0].warning, /completeness could not be verified/);
  });

  it('automatically applies only a complete changed order when explicitly requested', async () => {
    const source = [
      { id: 'a', setVideoId: 'A', title: 'A', duration: 10, percentWatched: 0 },
      { id: 'b', setVideoId: 'B', title: 'B', duration: 20, percentWatched: 0 },
    ];
    const writes = [];
    const { WLPanel } = loadPanelWithStubs({
      videos: source,
      enrich: async () => {},
      readSnapshot: async () => ({ videos: source, complete: true }),
      sendMessage: async (message) => message.type === 'AUTO_PREVIEW_STATUS'
        ? { autoOrganize: true, manualDryRunCompleted: true }
        : { success: true, sortOrder: [source[1], source[0]], subjects: [] },
      applyOrder: async (...args) => { writes.push(args); return { applied: true, waitedMs: 0 }; },
      reload: () => {},
      runTimers: true,
    });
    await WLPanel.runSort('ai', { automatic: true, applyAutomatically: true });
    assert.equal(writes.length, 1);
  });

  it('keeps automatic organisation preview-only when completeness is unverified', async () => {
    const source = [{ id: 'a', setVideoId: 'A', title: 'A', duration: 10, percentWatched: 0 }];
    let writes = 0;
    const { WLPanel } = loadPanelWithStubs({
      videos: source,
      enrich: async () => {},
      readSnapshot: async () => ({ videos: source, complete: false, reason: 'Count mismatch.' }),
      sendMessage: async () => ({ success: true, sortOrder: source, subjects: [] }),
      applyOrder: async () => { writes++; return { applied: true, waitedMs: 0 }; },
    });
    await WLPanel.runSort('ai', { automatic: true, applyAutomatically: true });
    assert.equal(writes, 0);
  });

  it('changeSortOptions sends RESORT with sortOptions and no overrides key, then persists what came back', async () => {
    const sent = [];
    const saved = [];
    const echoed = { ...OPTS, groupOrder: 'size' };
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [{ id: 'a', setVideoId: 'A' }], sortOptions: echoed }; },
      setSortOptions: async (opts) => { saved.push(opts); },
      playlistId: 'PL1',
      sortOptions: OPTS,
    });

    await WLPanel.changeSortOptions({ ...OPTS, groupOrder: 'size' });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'RESORT');
    assert.equal(sent[0].playlistId, 'PL1');
    assert.deepEqual({ ...sent[0].sortOptions }, echoed);
    assert.equal('overrides' in sent[0], false, 'must not clobber the stored treat-as-unwatched list');
    assert.deepEqual(modalCalls.showPreview[0].map(v => v.setVideoId), ['A']);
    assert.deepEqual({ ...modalCalls.showPreviewOptions[0] }, echoed);
    assert.deepEqual(saved.map(o => ({ ...o })), [echoed]);
    assert.deepEqual({ ...WLPanel.currentSortOptions }, echoed);
  });

  it('changeSortOptions surfaces a RESORT failure and saves nothing', async () => {
    const saved = [];
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: false, error: 'stale' }),
      setSortOptions: async (opts) => { saved.push(opts); },
      playlistId: 'PL1',
    });

    await WLPanel.changeSortOptions(OPTS);

    assert.deepEqual(modalCalls.showError, ['stale']);
    assert.deepEqual(saved, []);
  });

  it('changeSortOptions still shows the preview when persisting fails', async () => {
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true, sortOrder: [], sortOptions: OPTS }),
      setSortOptions: async () => { throw new Error('quota'); },
      playlistId: 'PL1',
    });

    await assert.doesNotReject(() => WLPanel.changeSortOptions(OPTS));

    assert.equal(modalCalls.showPreview.length, 1);
    assert.deepEqual(modalCalls.showError, []);
  });

  it('a superseded changeSortOptions neither renders nor saves', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const saved = [];
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => { await gate; return { success: true, sortOrder: [], sortOptions: OPTS }; },
      setSortOptions: async (opts) => { saved.push(opts); },
      playlistId: 'PL1',
    });

    const pending = WLPanel.changeSortOptions(OPTS);
    WLPanel._runId++;
    release();
    await pending;

    assert.deepEqual(modalCalls.showPreview, []);
    assert.deepEqual(saved, []);
  });

  it('toggleUnwatched carries the current sort options so the toggle keeps the chosen layout', async () => {
    const sent = [];
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async (msg) => { sent.push(msg); return { success: true, sortOrder: [], sortOptions: OPTS }; },
      toggleOverride: async () => ['v1'],
      playlistId: 'PL1',
      sortOptions: OPTS,
    });

    await WLPanel.toggleUnwatched('v1');

    assert.deepEqual(sent[0].overrides, ['v1']);
    assert.deepEqual({ ...sent[0].sortOptions }, OPTS);
  });
});

describe('headings toggle', () => {
  const storedMap = () => ({
    playlistId: 'WL',
    boundaries: [{ videoId: 'a', name: 'Music', count: 1 }],
    videoIdsHash: 'match',
  });

  function loadWithMap(map, extra = {}) {
    const calls = { watch: 0, clear: 0, saved: [], toggle: [] };
    const WLPanel = loadPanel({
      WLStorage: {
        getGroupMap: async () => map,
        setGroupMap: async (next) => { calls.saved.push({ ...next }); },
      },
      WLPlaylist: { read: async () => [{ id: 'a' }] },
      WLHeadings: {
        boundariesFrom: () => [],
        hashIds: () => 'match',
        watch: () => { calls.watch++; },
        stop() {},
        clear: () => { calls.clear++; },
      },
      WLModal: {
        mountTrigger() {},
        removeTrigger() {},
        syncHeadingsToggle(state) { calls.toggle.push(state); },
        verifyTrigger() { return { present: false }; },
        close() {},
        open() {},
        showBusy() {},
        showPreview() {},
        showError() {},
        setStatus() {},
      },
      ...extra,
    });
    return { WLPanel, calls };
  }

  it('restoreHeadings shows the chip as "shown" after injecting', async () => {
    const { WLPanel, calls } = loadWithMap(storedMap());
    await WLPanel.restoreHeadings();
    assert.equal(calls.watch, 1);
    assert.deepEqual(calls.toggle, ['shown']);
    assert.equal(WLPanel._headingsState, 'shown');
  });

  it('restoreHeadings honours a hidden map: no injection, chip reads "hidden"', async () => {
    const { WLPanel, calls } = loadWithMap({ ...storedMap(), hidden: true });
    await WLPanel.restoreHeadings();
    assert.equal(calls.watch, 0, 'hidden headings stay out of the page');
    assert.deepEqual(calls.toggle, ['hidden']);
  });

  it('restoreHeadings offers no chip when the stored map is for another playlist', async () => {
    const { WLPanel, calls } = loadWithMap({ ...storedMap(), playlistId: 'PLother' });
    await WLPanel.restoreHeadings();
    assert.deepEqual(calls.toggle, []);
    assert.equal(WLPanel._headingsState, null);
  });

  it('toggleHeadings hides shown headings and persists hidden: true', async () => {
    const { WLPanel, calls } = loadWithMap(storedMap());
    await WLPanel.restoreHeadings();
    const clearsBefore = calls.clear; // load-time syncTrigger() clears once
    await WLPanel.toggleHeadings();
    assert.equal(calls.clear, clearsBefore + 1);
    assert.equal(WLPanel._headingsState, 'hidden');
    assert.equal(calls.saved.at(-1).hidden, true);
    assert.deepEqual(calls.saved.at(-1).boundaries.map(b => b.name), ['Music'], 'the map survives');
  });

  it('toggleHeadings re-injects hidden headings and persists hidden: false', async () => {
    const { WLPanel, calls } = loadWithMap({ ...storedMap(), hidden: true });
    await WLPanel.restoreHeadings();
    await WLPanel.toggleHeadings();
    assert.equal(calls.watch, 1);
    assert.equal(WLPanel._headingsState, 'shown');
    assert.equal(calls.saved.at(-1).hidden, false);
  });

  it('toggleHeadings drops the chip when the stored map has gone', async () => {
    let map = storedMap();
    const { WLPanel, calls } = loadWithMap(map, {
      WLStorage: { getGroupMap: async () => map, setGroupMap: async () => {} },
    });
    await WLPanel.restoreHeadings();
    map = {};
    await WLPanel.toggleHeadings();
    assert.equal(WLPanel._headingsState, null);
    assert.equal(calls.toggle.at(-1), null);
  });

  it('toggleHeadings survives a storage failure without throwing', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const { WLPanel } = loadWithMap(storedMap(), {
        WLStorage: {
          getGroupMap: async () => storedMap(),
          setGroupMap: async () => { throw new Error('storage broken'); },
        },
      });
      await WLPanel.restoreHeadings();
      await assert.doesNotReject(() => WLPanel.toggleHeadings());
      assert.equal(WLPanel._headingsState, 'hidden', 'the page state changed even though the save failed');
    } finally {
      console.warn = originalWarn;
    }
  });

});

describe('undo', () => {
  const order = [{ id: 'a', setVideoId: 'A' }, { id: 'b', setVideoId: 'B' }];
  const read = [{ id: 'b', setVideoId: 'B' }, { id: 'a', setVideoId: 'A' }];

  it('stores a pending backup before the write and marks it verified after read-back succeeds', async () => {
    const saved = [];
    const events = [];
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      ensureManual: async () => { events.push('ensureManual'); return 'switched'; },
      videos: read,
      applyOrder: async () => { events.push('applyOrder'); return { applied: true, waitedMs: 1 }; },
      setUndo: async (state) => { saved.push({ ...state, previous: [...state.previous], current: [...state.current] }); },
      reload: () => {},
      runTimers: true,
      sortOrder: order,
      playlistId: 'WL',
    });
    await WLPanel.applySort();
    assert.equal(saved.length, 2);
    assert.deepEqual(saved[0].previous, ['B', 'A']);
    assert.deepEqual(saved[0].current, ['A', 'B']);
    assert.equal(saved[0].playlistId, 'WL');
    assert.equal(saved[0].status, 'pending');
    assert.equal(saved.at(-1).status, 'verified');
    assert.deepEqual(events, ['ensureManual', 'applyOrder']);
  });

  it('retains the backup but disables Undo when the write does not verify', async () => {
    const saved = [];
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      videos: read,
      applyOrder: async () => ({ applied: false, waitedMs: 10000 }),
      setUndo: async (state) => { saved.push({ ...state }); },
      sortOrder: order,
      playlistId: 'WL',
    });
    await WLPanel.applySort();
    assert.equal(saved.at(-1).status, 'not-applied');
    assert.deepEqual(saved[0].previous, ['B', 'A'], 'the original sequence is saved before the write');
    assert.equal(modalCalls.showError.length, 1);
  });

  it('retains any existing backup when the current playlist cannot be validated', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const saved = [];
      const { WLPanel } = loadPanelWithStubs({
        sendMessage: async () => ({ success: true }),
        ensureManual: async () => 'switched',
        // The permanent reorder safety check must stop before writing without
        // a validated current snapshot. Existing backups are left untouched.
        readSnapshot: async () => { throw new Error('playlist read failed'); },
        applyOrder: async () => ({ applied: true, waitedMs: 1 }),
        setUndo: async (state) => { saved.push({ ...state }); },
        reload: () => {},
        runTimers: true,
        sortOrder: order,
        playlistId: 'WL',
      });
      await WLPanel.applySort();
      assert.deepEqual(saved, []);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('openModal offers Undo only for the playlist the undo state belongs to', async () => {
    const opened = [];
    const load = (undo) => loadPanel({
      WLStorage: { getGroupMap: async () => ({}), setGroupMap: async () => {}, getUndo: async () => undo, setUndo: async () => {} },
      WLModal: {
        mountTrigger() {}, removeTrigger() {}, syncHeadingsToggle() {}, verifyTrigger() { return { present: false }; },
        close() {}, open(handlers, options) { opened.push(options.canUndo); }, showBusy() {}, showPreview() {}, showError() {}, setStatus() {},
      },
    });
    await load({ playlistId: 'WL', previous: ['A'], current: ['A'] }).openModal();
    await load({ playlistId: 'PLother', previous: ['A'], current: ['A'] }).openModal();
    await load({ playlistId: 'WL', previous: ['A'], current: ['A'], status: 'uncertain' }).openModal();
    await load({}).openModal();
    assert.deepEqual(opened, [true, false, false, false]);
  });

  it('openModal offers Clear headings whenever headings are stored, shown or hidden', async () => {
    const opened = [];
    const WLPanel = loadPanel({
      WLModal: {
        mountTrigger() {}, removeTrigger() {}, syncHeadingsToggle() {}, verifyTrigger() { return { present: false }; },
        close() {}, open(handlers, options) { opened.push(options.hasHeadings); }, showBusy() {}, showPreview() {}, showError() {}, setStatus() {},
      },
    });
    await WLPanel.openModal();
    WLPanel._headingsState = 'shown';
    await WLPanel.openModal();
    WLPanel._headingsState = 'hidden';
    await WLPanel.openModal();
    assert.deepEqual(opened, [false, true, true]);
  });

  it('clearHeadings drops the headings, the chip and the stored map, then closes the dialog', async () => {
    const calls = { clear: 0, saved: [], toggle: [], closed: 0 };
    const WLPanel = loadPanel({
      WLStorage: { getGroupMap: async () => ({}), setGroupMap: async (m) => { calls.saved.push({ ...m }); }, getUndo: async () => ({}), setUndo: async () => {} },
      WLHeadings: { boundariesFrom: () => [], hashIds: () => '', watch() {}, stop() {}, clear: () => { calls.clear++; } },
      WLModal: {
        mountTrigger() {}, removeTrigger() {}, syncHeadingsToggle(state) { calls.toggle.push(state); }, verifyTrigger() { return { present: false }; },
        close() { calls.closed++; }, open() {}, showBusy() {}, showPreview() {}, showError() {}, setStatus() {},
      },
    });
    WLPanel._headingsState = 'shown';
    const clears = calls.clear;
    WLPanel.clearHeadings();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.clear, clears + 1);
    assert.equal(WLPanel._headingsState, null);
    assert.equal(calls.toggle.at(-1), null);
    assert.deepEqual(calls.saved.at(-1), {});
    assert.ok(calls.closed >= 1);
  });

  it('openModal does not open after the session changed during the storage read', async () => {
    let opened = 0;
    const WLPanel = loadPanel({
      WLStorage: {
        getGroupMap: async () => ({}), setGroupMap: async () => {}, setUndo: async () => {},
        getUndo: async () => { WLPanel._runId++; return {}; },
      },
      WLModal: {
        mountTrigger() {}, removeTrigger() {}, syncHeadingsToggle() {}, verifyTrigger() { return { present: false }; },
        close() {}, open() { opened++; }, showBusy() {}, showPreview() {}, showError() {}, setStatus() {},
      },
    });
    await WLPanel.openModal();
    assert.equal(opened, 0);
  });

  it('undoSort writes the stored previous order, then clears headings and the undo state', async () => {
    const writes = [];
    const cleared = { undo: [], map: [] };
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      ensureManual: async () => 'manual',
      videos: order,
      applyOrder: async (playlistId, ordered) => { writes.push([...ordered]); return { applied: true, waitedMs: 1 }; },
      getUndo: async () => ({ playlistId: 'WL', previous: ['B', 'A'], current: ['A', 'B'] }),
      setUndo: async (state) => { cleared.undo.push({ ...state }); },
      setGroupMap: async (map) => { cleared.map.push({ ...map }); },
      reload: () => {},
      runTimers: true,
    });
    await WLPanel.undoSort();
    assert.deepEqual(writes, [['B', 'A']]);
    assert.deepEqual(cleared.map, [{}]);
    assert.deepEqual(cleared.undo, [{}]);
    assert.ok(modalCalls.showBusy.some(t => t.startsWith('Sort complete')));
    assert.equal(modalCalls.showError.length, 0);
  });

  it('undoSort refuses when the playlist was reordered by hand since the sort', async () => {
    let wrote = false;
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      videos: read, // B, A — same entries as `current`, different order
      applyOrder: async () => { wrote = true; return { applied: true, waitedMs: 1 }; },
      getUndo: async () => ({ playlistId: 'WL', previous: ['B', 'A'], current: ['A', 'B'] }),
    });
    await WLPanel.undoSort();
    assert.equal(wrote, false, 'a hand reorder is work Undo must not discard');
    assert.match(modalCalls.showError[0], /changed since/);
  });

  it('undoSort refuses when entries changed and marks the retained backup stale', async () => {
    let wrote = false;
    const cleared = [];
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      videos: [{ id: 'a', setVideoId: 'A' }, { id: 'c', setVideoId: 'C' }],
      applyOrder: async () => { wrote = true; return { applied: true, waitedMs: 1 }; },
      getUndo: async () => ({ playlistId: 'WL', previous: ['B', 'A'], current: ['A', 'B'] }),
      setUndo: async (state) => { cleared.push({ ...state }); },
    });
    await WLPanel.undoSort();
    assert.equal(wrote, false);
    assert.deepEqual(cleared, [{ playlistId: 'WL', previous: ['B', 'A'], current: ['A', 'B'], status: 'stale' }]);
    assert.match(modalCalls.showError[0], /changed since/);
  });

  it('undoSort reports when nothing is stored for this playlist', async () => {
    let wrote = false;
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      videos: order,
      applyOrder: async () => { wrote = true; return { applied: true, waitedMs: 1 }; },
      getUndo: async () => ({ playlistId: 'PLother', previous: ['B', 'A'] }),
    });
    await WLPanel.undoSort();
    assert.equal(wrote, false);
    assert.match(modalCalls.showError[0], /Nothing to undo/);
  });

  it('undoSort abandons the write when the session changes during the read', async () => {
    let wrote = false;
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      applyOrder: async () => { wrote = true; return { applied: true, waitedMs: 1 }; },
      getUndo: async () => { WLPanel._runId++; return { playlistId: 'WL', previous: ['A'] }; },
      videos: [{ id: 'a', setVideoId: 'A' }],
    });
    await WLPanel.undoSort();
    assert.equal(wrote, false);
  });

  it('undoSort names Manual sort when the restored order never appears', async () => {
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      ensureManual: async () => 'failed',
      videos: order,
      applyOrder: async () => ({ applied: false, waitedMs: 10000 }),
      getUndo: async () => ({ playlistId: 'WL', previous: ['B', 'A'], current: ['A', 'B'] }),
    });
    await WLPanel.undoSort();
    assert.match(modalCalls.showError[0], /Manual/);
  });
});

describe('view sort change drops the headings', () => {
  const storedMap = (extra = {}) => ({
    playlistId: 'WL',
    boundaries: [{ videoId: 'a', name: 'Music', count: 1 }],
    videoIdsHash: 'match',
    viewSortLabel: 'Manual',
    ...extra,
  });

  function loadWith(map, chipLabel) {
    const calls = { watch: 0, clear: 0, saved: [], toggle: [] };
    const chip = { label: chipLabel };
    const WLPanel = loadPanel({
      WLStorage: { getGroupMap: async () => map, setGroupMap: async (next) => { calls.saved.push({ ...next }); }, getUndo: async () => ({}), setUndo: async () => {} },
      WLPlaylist: { read: async () => [{ id: 'a' }] },
      WLViewSort: { ensureManual: async () => 'manual', current: () => chip.label },
      WLHeadings: { boundariesFrom: () => [], hashIds: () => 'match', watch: () => { calls.watch++; }, stop() {}, clear: () => { calls.clear++; } },
      WLModal: {
        mountTrigger() {}, removeTrigger() {}, syncHeadingsToggle(state) { calls.toggle.push(state); }, verifyTrigger() { return { present: false }; },
        close() {}, open() {}, showBusy() {}, showPreview() {}, showError() {}, setStatus() {},
      },
    });
    return { WLPanel, calls, chip };
  }

  it('restoreHeadings injects when the chip still reads the recorded Manual label', async () => {
    const { WLPanel, calls } = loadWith(storedMap(), 'Manual');
    await WLPanel.restoreHeadings();
    assert.equal(calls.watch, 1);
    assert.equal(WLPanel._headingsState, 'shown');
  });

  it('restoreHeadings drops the map instead of injecting when the view sort changed', async () => {
    const { WLPanel, calls } = loadWith(storedMap(), 'Date added (newest)');
    await WLPanel.restoreHeadings();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.watch, 0, 'headings would sit on the wrong videos');
    assert.deepEqual(calls.saved.at(-1), {});
    assert.equal(WLPanel._headingsState, null);
  });

  it('works in any language: only the recorded label matters', async () => {
    const { WLPanel, calls } = loadWith(storedMap({ viewSortLabel: 'Manuell' }), 'Manuell');
    await WLPanel.restoreHeadings();
    assert.equal(calls.watch, 1);
  });

  it('a map stored without a label restores as before', async () => {
    const { WLPanel, calls } = loadWith(storedMap({ viewSortLabel: undefined }), 'Date added (newest)');
    await WLPanel.restoreHeadings();
    assert.equal(calls.watch, 1);
  });

  it('checkViewSort drops shown headings live when the chip label changes', async () => {
    const { WLPanel, calls, chip } = loadWith(storedMap(), 'Manual');
    await WLPanel.restoreHeadings();
    const clears = calls.clear;
    WLPanel.checkViewSort();
    assert.equal(WLPanel._headingsState, 'shown', 'no change yet');
    chip.label = 'Most popular';
    WLPanel.checkViewSort();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.clear, clears + 1);
    assert.equal(WLPanel._headingsState, null);
    assert.equal(calls.toggle.at(-1), null, 'the chip goes too');
    assert.deepEqual(calls.saved.at(-1), {});
  });

  it('checkViewSort also drops hidden headings, so the Show chip does not linger', async () => {
    const { WLPanel, calls, chip } = loadWith(storedMap({ hidden: true }), 'Manual');
    await WLPanel.restoreHeadings();
    assert.equal(WLPanel._headingsState, 'hidden');
    chip.label = 'Most popular';
    WLPanel.checkViewSort();
    assert.equal(WLPanel._headingsState, null);
    assert.equal(calls.toggle.at(-1), null);
  });

  it('checkViewSort ignores a page without the chip', async () => {
    const { WLPanel, chip } = loadWith(storedMap(), 'Manual');
    await WLPanel.restoreHeadings();
    chip.label = null;
    WLPanel.checkViewSort();
    assert.equal(WLPanel._headingsState, 'shown');
  });

  it('applySort records the chip label with the group map', async () => {
    let saved;
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      videos: [{ id: 'a', setVideoId: 'A' }],
      applyOrder: async () => ({ applied: true, waitedMs: 1 }),
      setGroupMap: async (map) => { saved = { ...map }; },
      reload: () => {},
      runTimers: true,
      sortOrder: [{ id: 'a', setVideoId: 'A', cluster: 'Music' }],
      playlistId: 'WL',
    });
    await WLPanel.applySort();
    assert.equal(saved.viewSortLabel, 'Manual');
  });
});

describe('applySort — Manual view sort', () => {
  const order = [{ id: 'a', setVideoId: 'A' }, { id: 'b', setVideoId: 'B' }];

  it('switches the playlist to Manual before sending the reorder', async () => {
    const events = [];
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      ensureManual: async () => { events.push('ensureManual'); return 'switched'; },
      applyOrder: async () => { events.push('applyOrder'); return { applied: true, waitedMs: 10 }; },
      reload: () => {},
      runTimers: true,
      sortOrder: order,
      playlistId: 'WL',
    });
    await WLPanel.applySort();
    assert.deepEqual(events, ['ensureManual', 'applyOrder']);
  });

  it('still applies when the switch fails, and names Manual sort if the order never appears', async () => {
    let applied = false;
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      ensureManual: async () => 'failed',
      applyOrder: async () => { applied = true; return { applied: false, waitedMs: 10000 }; },
      sortOrder: order,
      playlistId: 'WL',
    });
    await WLPanel.applySort();
    assert.equal(applied, true, 'a failed switch must not block the apply');
    assert.match(modalCalls.showError[0], /Manual/);
  });

  it('keeps the plain message when the playlist was already Manual', async () => {
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      ensureManual: async () => 'manual',
      applyOrder: async () => ({ applied: false, waitedMs: 10000 }),
      sortOrder: order,
      playlistId: 'WL',
    });
    await WLPanel.applySort();
    assert.doesNotMatch(modalCalls.showError[0], /Manual/);
  });

  it('names Manual sort when the page had no sort chip to switch', async () => {
    const { WLPanel, modalCalls } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      ensureManual: async () => 'no-chip',
      applyOrder: async () => ({ applied: false, waitedMs: 10000 }),
      sortOrder: order,
      playlistId: 'WL',
    });
    await WLPanel.applySort();
    assert.match(modalCalls.showError[0], /Manual/);
  });

  it('treats a thrown check like a failed one', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      let applied = false;
      const { WLPanel } = loadPanelWithStubs({
        sendMessage: async () => ({ success: true }),
        ensureManual: async () => { throw new Error('no DOM'); },
        applyOrder: async () => { applied = true; return { applied: true, waitedMs: 1 }; },
        reload: () => {},
        runTimers: true,
        sortOrder: order,
        playlistId: 'WL',
      });
      await WLPanel.applySort();
      assert.equal(applied, true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('abandons the apply when the session changes during the check', async () => {
    let applied = false;
    const { WLPanel } = loadPanelWithStubs({
      sendMessage: async () => ({ success: true }),
      ensureManual: async () => { WLPanel._runId++; return 'switched'; },
      applyOrder: async () => { applied = true; return { applied: true, waitedMs: 1 }; },
      sortOrder: order,
      playlistId: 'WL',
    });
    await WLPanel.applySort();
    assert.equal(applied, false, 'a superseded session must not write to the playlist');
  });
});
