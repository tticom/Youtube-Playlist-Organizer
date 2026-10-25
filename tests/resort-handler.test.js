// tests/resort-handler.test.js
// Exercises the RESORT message handler in background/service-worker.js through a
// mocked `chrome` global, since the handler functions are not exported (the file is
// bundled for Firefox by raw concatenation — see background/service-worker.js header
// comment in task-9-brief.md). `chrome` is a free identifier inside the handler
// closures, resolved against globalThis at call time, so swapping globalThis.chrome
// between calls to the same captured listener works without re-importing the module.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/** Build a minimal chrome mock backed by a plain object for storage.local/sync. */
function createChromeMock({ local = {}, sync = {} } = {}) {
  const localStore = { ...local };
  const syncStore = { ...sync };
  let messageListener;

  const chrome = {
    action: { setIcon: () => Promise.resolve() },
    runtime: {
      onMessage: {
        addListener: (fn) => { messageListener = fn; },
      },
    },
    storage: {
      sync: {
        get: (key) => Promise.resolve(
          typeof key === 'string' ? { [key]: syncStore[key] } : { ...syncStore }
        ),
      },
      local: {
        get: (key) => Promise.resolve(
          typeof key === 'string' ? { [key]: localStore[key] } : { ...localStore }
        ),
        set: (obj) => {
          Object.assign(localStore, obj);
          return Promise.resolve();
        },
      },
    },
  };

  return { chrome, localStore, getListener: () => messageListener };
}

function video(overrides = {}) {
  return {
    id: 'v', setVideoId: 'S', title: 'T', channel: 'C',
    duration: 600, percentWatched: 0, category: null,
    description: null, unavailable: false,
    ...overrides,
  };
}

// Import the module once with a bootstrap chrome mock in place (top-level code in
// service-worker.js registers the message listener immediately on load).
let getListener;
before(async () => {
  const bootstrap = createChromeMock();
  globalThis.chrome = bootstrap.chrome;
  await import('../background/service-worker.js');
  getListener = bootstrap.getListener;
});

function sendMessage(chrome, message) {
  globalThis.chrome = chrome;
  const listener = getListener();
  return new Promise((resolve) => {
    const keepAlive = listener(message, {}, resolve);
    assert.equal(keepAlive, true, 'listener must return true to keep the async channel open');
  });
}

describe('RESORT playlist scoping', () => {
  const videos = [
    video({ id: 'a', percentWatched: 100 }),
    video({ id: 'b', percentWatched: 0 }),
  ];
  const clusters = { clusters: [{ name: 'Music', videoIds: ['a', 'b'] }] };

  it('errors when the cache belongs to a different playlist, without falling back', async () => {
    const { chrome, localStore } = createChromeMock({
      local: { cachedClusters: { playlistId: 'WL', clusters, videos } },
    });

    const response = await sendMessage(chrome, { type: 'RESORT', overrides: ['a'], playlistId: 'OTHER' });

    assert.equal(response.success, false);
    assert.match(response.error, /different playlist/i);
    assert.equal(response.sortOrder, undefined);
    // Must not silently recompute and must not mutate overrides on a rejected resort.
    assert.equal(localStore.unwatchedOverrides, undefined);
  });

  it('succeeds and returns a recomputed order when the playlistId matches', async () => {
    const { chrome } = createChromeMock({
      local: { cachedClusters: { playlistId: 'WL', clusters, videos } },
    });

    const response = await sendMessage(chrome, { type: 'RESORT', overrides: ['a'], playlistId: 'WL' });

    assert.equal(response.success, true);
    assert.equal(response.sortOrder.every(v => v.cluster === 'Music'), true);
  });

  it('refreshes the persisted sortState so GET_SORT_STATE is not stale', async () => {
    const { chrome, localStore } = createChromeMock({
      local: {
        cachedClusters: { playlistId: 'WL', clusters, videos },
        sortState: { videos, clusters, sortOrder: [], timestamp: 1 },
      },
    });

    const response = await sendMessage(chrome, { type: 'RESORT', overrides: ['a'], playlistId: 'WL' });

    assert.equal(response.success, true);
    assert.ok(localStore.sortState, 'sortState should be written');
    assert.deepEqual(localStore.sortState.sortOrder, response.sortOrder);
    assert.ok(localStore.sortState.timestamp > 1);
  });
});

describe('RESORT sort options', () => {
  const videos = [
    video({ id: 'a', duration: 100, percentWatched: 50 }),
    video({ id: 'b', duration: 900 }),
    video({ id: 'c', duration: 300 }),
  ];
  const clusters = { clusters: [{ name: 'Music', videoIds: ['a', 'b', 'c'] }] };
  const cache = (extra = {}) => ({ playlistId: 'WL', clusters, videos, ...extra });

  it('uses settings.sort when the message carries no sortOptions, and echoes what it used', async () => {
    const { chrome, localStore } = createChromeMock({
      local: { cachedClusters: cache() },
      sync: { settings: { provider: 'ollama', sort: { withinGroup: 'duration-desc', inProgress: 'within' } } },
    });

    const response = await sendMessage(chrome, { type: 'RESORT', overrides: [], playlistId: 'WL' });

    assert.equal(response.success, true, response.error);
    assert.deepEqual(response.sortOrder.map(v => v.id), ['a', 'b', 'c']);
    assert.deepEqual(response.sortOptions, { withinGroup: 'duration-desc', secondaryWithinGroup: 'playlist', inProgress: 'within', groupOrder: 'taxonomy' });
    assert.equal(localStore.cachedClusters.sortOptions, undefined, 'a resort never rewrites the cluster cache');
    assert.deepEqual(localStore.sortState.sortOptions, response.sortOptions);
  });

  it('prefers sortOptions from the message over the saved settings', async () => {
    const { chrome } = createChromeMock({
      local: { cachedClusters: cache({ sortOptions: { withinGroup: 'title' } }) },
      sync: { settings: { provider: 'ollama', sort: { withinGroup: 'duration-desc' } } },
    });

    const response = await sendMessage(chrome, {
      type: 'RESORT', overrides: [], playlistId: 'WL', sortOptions: { inProgress: 'within', withinGroup: 'duration-asc' },
    });

    assert.deepEqual(response.sortOrder.map(v => v.id), ['a', 'c', 'b']);
    assert.equal(response.sortOptions.inProgress, 'within');
  });

  it('keeps the stored overrides when the message omits them', async () => {
    const { chrome, localStore } = createChromeMock({
      local: { cachedClusters: cache(), unwatchedOverrides: ['a'] },
      sync: { settings: { provider: 'ollama' } },
    });

    const response = await sendMessage(chrome, { type: 'RESORT', playlistId: 'WL', sortOptions: { groupOrder: 'alpha' } });

    assert.equal(response.success, true, response.error);
    assert.deepEqual(localStore.unwatchedOverrides, ['a'], 'a sort-option change must not clear the toggle');
    assert.equal(response.sortOrder.find(v => v.id === 'a').cluster, 'Music', 'override still applied');
  });

  it('still stores overrides sent explicitly (the treat-as-unwatched toggle)', async () => {
    const { chrome, localStore } = createChromeMock({
      local: { cachedClusters: cache(), unwatchedOverrides: ['a'] },
      sync: { settings: { provider: 'ollama' } },
    });

    await sendMessage(chrome, { type: 'RESORT', overrides: [], playlistId: 'WL' });

    assert.deepEqual(localStore.unwatchedOverrides, []);
  });

  it('whitelists unknown option values back to the defaults', async () => {
    const { chrome } = createChromeMock({
      local: { cachedClusters: cache() },
      sync: { settings: { provider: 'ollama' } },
    });

    const response = await sendMessage(chrome, {
      type: 'RESORT', overrides: [], playlistId: 'WL', sortOptions: { withinGroup: 'random', inProgress: 'top' },
    });

    assert.equal(response.sortOptions.withinGroup, 'duration-asc');
  });
});

describe('SORT_BY_DURATION `by`', () => {
  const videos = [
    video({ id: 'b', duration: 9, title: 'Beta', channel: 'Zed' }),
    video({ id: 'a', duration: 1, title: 'Alpha', channel: 'Yak' }),
    video({ id: 'c', duration: 5, title: 'Gamma', channel: 'Yak' }),
  ];
  const ids = (response) => response.sortOrder.map(v => v.id);

  it('sorts by duration when the message carries no `by`', async () => {
    const { chrome, localStore } = createChromeMock();
    const response = await sendMessage(chrome, { type: 'SORT_BY_DURATION', videos });
    assert.equal(response.success, true);
    assert.deepEqual(ids(response), ['a', 'c', 'b']);
    assert.equal(localStore.sortState, undefined, 'the simple sorts never wrote sortState');
  });

  it('sorts by title and by channel-then-title on request', async () => {
    const { chrome } = createChromeMock();
    assert.deepEqual(ids(await sendMessage(chrome, { type: 'SORT_BY_DURATION', videos, by: 'title' })), ['a', 'b', 'c']);
    assert.deepEqual(ids(await sendMessage(chrome, { type: 'SORT_BY_DURATION', videos, by: 'channel' })), ['a', 'c', 'b']);
  });

  it('answers an unknown `by` with an error instead of dropping the message', async () => {
    const { chrome } = createChromeMock();
    const response = await sendMessage(chrome, { type: 'SORT_BY_DURATION', videos, by: 'views' });
    assert.equal(response.success, false);
    assert.match(response.error, /Unknown sort/);
  });
});
