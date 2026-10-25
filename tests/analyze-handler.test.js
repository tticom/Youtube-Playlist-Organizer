// tests/analyze-handler.test.js
// Drives the ANALYZE, LIST_MODELS and YT_PAGE handlers in background/service-worker.js
// through a mocked `chrome` global and a stubbed global `fetch`. See
// resort-handler.test.js for why swapping globalThis.chrome between calls works.
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function createChromeMock({ local = {}, sync = {} } = {}) {
  const localStore = { ...local };
  const syncStore = { ...sync };
  const iconCalls = [];
  let messageListener;

  const pick = (store, keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  };

  const chrome = {
    action: { setIcon: (args) => { iconCalls.push(args); return Promise.resolve(); } },
    runtime: { onMessage: { addListener: (fn) => { messageListener = fn; } } },
    storage: {
      sync: {
        get: (keys) => Promise.resolve(pick(syncStore, keys)),
        set: (obj) => { Object.assign(syncStore, obj); return Promise.resolve(); },
        remove: (key) => { delete syncStore[key]; return Promise.resolve(); },
      },
      local: {
        get: (keys) => Promise.resolve(pick(localStore, keys)),
        set: (obj) => { Object.assign(localStore, obj); return Promise.resolve(); },
      },
    },
  };

  return { chrome, localStore, syncStore, iconCalls, getListener: () => messageListener };
}

function video(overrides = {}) {
  return {
    id: 'v', setVideoId: 'S', title: 'T', channel: 'C',
    duration: 600, percentWatched: 0, category: null,
    description: null, unavailable: false,
    ...overrides,
  };
}

function stubFetch(reply, { ok = true, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return { ok, status, json: async () => reply, text: async () => JSON.stringify(reply) };
  };
  return calls;
}

let getListener;
const realFetch = globalThis.fetch;
before(async () => {
  const bootstrap = createChromeMock();
  globalThis.chrome = bootstrap.chrome;
  await import('../background/service-worker.js');
  getListener = bootstrap.getListener;
});
afterEach(() => { globalThis.fetch = realFetch; });

function sendMessage(chrome, message, sender = {}) {
  globalThis.chrome = chrome;
  const listener = getListener();
  return new Promise((resolve) => {
    const keepAlive = listener(message, sender, resolve);
    assert.equal(keepAlive, true, 'listener must return true to keep the async channel open');
  });
}

describe('ANALYZE', () => {
  const videos = [video({ id: 'a' }), video({ id: 'b' }), video({ id: 'ghost', unavailable: true })];

  it('refuses without a key when the provider needs one, and never fetches', async () => {
    const calls = stubFetch({});
    const { chrome } = createChromeMock({ sync: { settings: { provider: 'anthropic', apiKey: '' } } });

    const response = await sendMessage(chrome, { type: 'ANALYZE', videos, playlistId: 'WL' });

    assert.equal(response.success, false);
    assert.equal(response.error, "No API key configured. Open the extension's settings.");
    assert.equal(calls.length, 0);
  });

  it('classifies with local rules by default without API configuration or network calls', async () => {
    const calls = stubFetch({});
    const subjects = [
      { id: 'physics', source: 'custom', name: 'Physics', priority: 0, rules: { includePhrases: ['quantum entanglement'] } },
      { id: 'other', source: 'custom', name: 'Other / Uncategorised', priority: 1 },
    ];
    const { chrome } = createChromeMock({ sync: { settings: { subjects, taxonomy: subjects.map(s => s.name), fallbackSubjectId: 'other' } } });
    const response = await sendMessage(chrome, { type: 'ANALYZE', videos: [video({ id: 'v', title: 'Quantum entanglement explained' })], playlistId: 'WL' });
    assert.equal(response.success, true, response.error);
    assert.equal(response.method, 'local-rules');
    assert.equal(response.sortOrder[0].cluster, 'Physics');
    assert.equal(calls.length, 0);
  });

  it('uses the selected AI provider only for uncertain hybrid classifications', async () => {
    const calls = stubFetch({ choices: [{ message: { content: '{"clusters":[{"name":"Physics","videoIds":["unknown"]}]}' } }] });
    const subjects = [
      { id: 'physics', source: 'custom', name: 'Physics', priority: 0, rules: { includePhrases: ['quantum entanglement'] } },
      { id: 'other', source: 'custom', name: 'Other / Uncategorised', priority: 1 },
    ];
    const { chrome } = createChromeMock({ sync: { settings: { classificationMethod: 'hybrid', provider: 'ollama', subjects, taxonomy: subjects.map(s => s.name), fallbackSubjectId: 'other' } } });
    const response = await sendMessage(chrome, { type: 'ANALYZE', videos: [video({ id: 'known', title: 'Quantum entanglement explained' }), video({ id: 'unknown', title: 'A quiet walk' })], playlistId: 'WL' });
    assert.equal(response.success, true, response.error);
    assert.equal(calls.length, 1);
    const prompt = calls[0].body.messages[0].content;
    assert.ok(prompt.includes('unknown'));
    assert.ok(!prompt.includes('id: "known"'));
  });

  it('refuses local AI with a cloud provider without making a request', async () => {
    const calls = stubFetch({});
    const { chrome } = createChromeMock({ sync: { settings: { classificationMethod: 'local-ai', provider: 'openai', apiKey: 'configured' } } });
    const response = await sendMessage(chrome, { type: 'ANALYZE', videos: [video()], playlistId: 'WL' });
    assert.equal(response.success, false);
    assert.match(response.error, /requires the Ollama provider/);
    assert.equal(calls.length, 0);
  });

  it('keeps an explicitly confirmed video label authoritative after rule changes without an AI request', async () => {
    const calls = stubFetch({});
    const subjects = [
      { id: 'physics', source: 'custom', name: 'Physics', priority: 0, rules: {} },
      { id: 'other', source: 'custom', name: 'Other / Uncategorised', priority: 1, rules: {} },
    ];
    const { chrome, syncStore, localStore } = createChromeMock({ sync: { settings: { subjects, taxonomy: subjects.map(s => s.name), fallbackSubjectId: 'other' } } });
    const item = video({ id: 'v-confirmed', title: 'Quantum notes' });
    const first = await sendMessage(chrome, { type: 'ANALYZE', videos: [item], playlistId: 'WL' });
    assert.equal(first.sortOrder[0].cluster, 'Other / Uncategorised');
    await sendMessage(chrome, { type: 'CLASSIFICATION_FEEDBACK', videoId: item.id, confirmed: true });
    syncStore.settings = { ...syncStore.settings, subjects: [{ ...subjects[0], rules: { includePhrases: ['quantum'] } }, subjects[1]] };
    const second = await sendMessage(chrome, { type: 'ANALYZE', videos: [item], playlistId: 'WL' });
    assert.equal(second.sortOrder[0].cluster, 'Other / Uncategorised');
    assert.equal(second.sortOrder[0].classificationSource, 'user-confirmed');
    assert.equal(calls.length, 0);
    assert.equal(localStore.learningState.examples[0].confirmed, true);
  });

  it('proceeds without a key for a provider that does not need one', async () => {
    const calls = stubFetch({ choices: [{ message: { content: '{"clusters":[{"name":"Music","videoIds":["a","b"]}]}' } }] });
    const { chrome } = createChromeMock({ sync: { settings: { provider: 'ollama' } } });

    const response = await sendMessage(chrome, { type: 'ANALYZE', videos, playlistId: 'WL' });

    assert.equal(response.success, true, response.error);
    assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  });

  it('uses the configured provider, sends only classifiable videos, and sorts by the custom taxonomy', async () => {
    const calls = stubFetch({ content: [{ text: '{"clusters":[{"name":"Knitting","videoIds":["a"]},{"name":"Woodwork","videoIds":["b"]}]}' }] });
    const { chrome, localStore } = createChromeMock({
      sync: { settings: { provider: 'anthropic', apiKey: 'k', taxonomy: ['Woodwork', 'Knitting'] } },
    });

    const response = await sendMessage(chrome, { type: 'ANALYZE', videos, playlistId: 'WL' });

    assert.equal(response.success, true, response.error);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    const prompt = calls[0].body.messages[0].content;
    assert.ok(prompt.includes('- Woodwork\n- Knitting'));
    assert.ok(!prompt.includes('ghost'));
    assert.deepEqual(response.sortOrder.map(v => v.id), ['b', 'a', 'ghost']);
    assert.equal(localStore.cachedClusters.playlistId, 'WL');
  });

  it('migrates a legacy apiKey on the way in', async () => {
    stubFetch({ content: [{ text: '{"clusters":[]}' }] });
    const { chrome, syncStore } = createChromeMock({ sync: { apiKey: 'sk-ant-legacy' } });

    const response = await sendMessage(chrome, { type: 'ANALYZE', videos, playlistId: 'WL' });

    assert.equal(response.success, true, response.error);
    assert.equal(syncStore.settings.apiKey, 'sk-ant-legacy');
    assert.equal(syncStore.apiKey, undefined);
  });

  it('surfaces provider errors as a failed response', async () => {
    stubFetch({ error: 'nope' }, { ok: false, status: 401 });
    const { chrome } = createChromeMock({ sync: { settings: { provider: 'openai', apiKey: 'bad' } } });

    const response = await sendMessage(chrome, { type: 'ANALYZE', videos, playlistId: 'WL' });

    assert.equal(response.success, false);
    assert.match(response.error, /OpenAI API error \(401\)/);
  });
});

describe('LIST_MODELS', () => {
  it('lists models using the settings in the message, not the saved ones', async () => {
    const calls = stubFetch({ data: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }] });
    const { chrome } = createChromeMock({ sync: { settings: { provider: 'anthropic', apiKey: 'saved' } } });

    const response = await sendMessage(chrome, {
      type: 'LIST_MODELS', settings: { provider: 'gemini', apiKey: 'unsaved' },
    });

    assert.equal(response.success, true, response.error);
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer unsaved');
    assert.deepEqual(response.models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('returns the error text on failure', async () => {
    stubFetch({});
    const { chrome } = createChromeMock();
    const response = await sendMessage(chrome, { type: 'LIST_MODELS', settings: { provider: 'openai', apiKey: '' } });
    assert.equal(response.success, false);
    assert.match(response.error, /no API key/);
  });
});

describe('YT_PAGE', () => {
  it('sets the active icon on the sending tab and answers synchronously', async () => {
    const { chrome, iconCalls } = createChromeMock();
    globalThis.chrome = chrome;
    const keepAlive = getListener()({ type: 'YT_PAGE' }, { tab: { id: 42 } }, () => {});
    assert.equal(keepAlive, false);
    assert.equal(iconCalls.length, 1);
    assert.equal(iconCalls[0].tabId, 42);
    assert.match(iconCalls[0].path[16], /active/);
  });

  it('ignores a message with no tab', async () => {
    const { chrome, iconCalls } = createChromeMock();
    globalThis.chrome = chrome;
    getListener()({ type: 'YT_PAGE' }, {}, () => {});
    assert.equal(iconCalls.length, 0);
  });
});

describe('ANALYZE sort options', () => {
  const videos = [
    video({ id: 'a', duration: 100, percentWatched: 50 }),
    video({ id: 'b', duration: 900 }),
    video({ id: 'c', duration: 300 }),
  ];
  const reply = { choices: [{ message: { content: '{"clusters":[{"name":"Music","videoIds":["a","b","c"]}]}' } }] };

  it('sorts with settings.sort by default and caches the options for RESORT', async () => {
    stubFetch(reply);
    const { chrome, localStore } = createChromeMock({
      sync: { settings: { provider: 'ollama', sort: { inProgress: 'within', withinGroup: 'duration-desc' } } },
    });

    const response = await sendMessage(chrome, { type: 'ANALYZE', videos, playlistId: 'WL' });

    assert.equal(response.success, true, response.error);
    assert.deepEqual(response.sortOrder.map(v => v.id), ['a', 'b', 'c']);
    assert.deepEqual(response.sortOptions, { withinGroup: 'duration-desc', secondaryWithinGroup: 'playlist', inProgress: 'within', groupOrder: 'taxonomy' });
    assert.deepEqual(localStore.cachedClusters.sortOptions, response.sortOptions, 'cached clusters retain the options used for subsequent overrides');
    assert.deepEqual(localStore.sortState.sortOptions, response.sortOptions);
  });

  it('prefers sortOptions carried by the message', async () => {
    stubFetch(reply);
    const { chrome } = createChromeMock({
      sync: { settings: { provider: 'ollama', sort: { inProgress: 'within' } } },
    });

    const response = await sendMessage(chrome, {
      type: 'ANALYZE', videos, playlistId: 'WL', sortOptions: { inProgress: 'top' },
    });

    assert.equal(response.sortOrder[0].id, 'a');
    assert.equal(response.sortOrder[0].cluster, null);
  });
});

describe('classification overrides', () => {
  it('persists per-video subject IDs, applies them after analysis, and removes them back to automatic', async () => {
    const subjects = [
      { id: 'custom:music', source: 'custom', name: 'Music', priority: 0 },
      { id: 'custom:physics', source: 'custom', name: 'Physics', priority: 1 },
    ];
    const { chrome, localStore } = createChromeMock({ sync: { settings: { provider: 'ollama', subjects, taxonomy: ['Music', 'Physics'] } } });
    const calls = stubFetch({ choices: [{ message: { content: '{"clusters":[{"name":"Music","videoIds":["v"]}]}' } }] });
    const first = await sendMessage(chrome, { type: 'ANALYZE', videos: [video()], playlistId: 'WL' });
    assert.equal(first.sortOrder[0].cluster, 'Music');
    const changed = await sendMessage(chrome, { type: 'SET_CLASSIFICATION_OVERRIDE', videoId: 'v', subjectId: 'custom:physics', playlistId: 'WL' });
    assert.equal(changed.sortOrder[0].cluster, 'Physics');
    assert.equal(localStore.classificationOverrides.v, 'custom:physics');
    assert.equal(localStore.learningState.examples[0].subjectId, 'custom:physics');
    assert.equal(localStore.learningState.examples[0].confirmed, true);
    const rerun = await sendMessage(chrome, { type: 'ANALYZE', videos: [video()], playlistId: 'WL' });
    assert.equal(rerun.sortOrder[0].cluster, 'Physics');
    assert.equal(calls.length, 1, 'unchanged metadata reused the classification cache');
    const reverted = await sendMessage(chrome, { type: 'SET_CLASSIFICATION_OVERRIDE', videoId: 'v', subjectId: '', playlistId: 'WL' });
    assert.equal(reverted.sortOrder[0].cluster, 'Music');
    assert.equal('v' in localStore.classificationOverrides, false);
  });

  it('keeps manual overrides when learned examples are reset', async () => {
    const { chrome, localStore, syncStore } = createChromeMock({
      local: {
        classificationOverrides: { v: 'custom:physics' },
        learningState: { examples: [{ videoId: 'v', corrected: true, confirmed: true }], sortingPreferences: [{ id: 'sort:History:withinGroup:duration-desc:asc', type: 'sorting', group: 'History', slot: 'withinGroup', field: 'duration-desc', previousValue: 'duration-asc', enabled: true }] },
      },
      sync: {
        settings: {
          sort: {
            subjectSorts: { History: { withinGroup: 'duration-desc' } },
          },
        },
      },
    });
    const reset = await sendMessage(chrome, { type: 'RESET_LEARNED_PREFERENCES' });
    assert.equal(reset.success, true);
    assert.equal(localStore.classificationOverrides.v, 'custom:physics');
    assert.deepEqual(localStore.learningState.examples, []);
    assert.deepEqual(syncStore.settings.sort.subjectSorts.History, { withinGroup: 'duration-asc' });
  });
});

describe('classification cache bounds and invalidation', () => {
  it('removes entries from a stale taxonomy configuration', async () => {
    const staleKey = JSON.stringify(['v', 'T', 'C', null, null, 'old-taxonomy']);
    const { chrome, localStore } = createChromeMock({
      local: { classificationCache: { [staleKey]: 'Old category' } },
      sync: { settings: { provider: 'ollama' } },
    });
    stubFetch({ choices: [{ message: { content: '{"clusters":[{"name":"Music","videoIds":["v"]}]}' } }] });
    const response = await sendMessage(chrome, { type: 'ANALYZE', videos: [video()], playlistId: 'WL' });
    assert.equal(response.success, true, response.error);
    assert.equal(staleKey in localStore.classificationCache, false);
  });

  it('bounds the AI cache without evicting manual overrides', async () => {
    const cache = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`stale-${i}`, 'Old']));
    const { chrome, localStore } = createChromeMock({
      local: { classificationCache: cache, classificationOverrides: { retained: 'custom:music' } },
      sync: { settings: { provider: 'ollama' } },
    });
    stubFetch({ choices: [{ message: { content: '{"clusters":[{"name":"Music","videoIds":["v"]}]}' } }] });
    const response = await sendMessage(chrome, { type: 'ANALYZE', videos: [video()], playlistId: 'WL' });
    assert.equal(response.success, true, response.error);
    assert.ok(Object.keys(localStore.classificationCache).length <= 2000);
    assert.equal(localStore.classificationOverrides.retained, 'custom:music');
  });
});

describe('on-open preview mode', () => {
  it('shows read-only preview before authorization and only enables writes after unattended consent', async () => {
    const { chrome } = createChromeMock({ sync: { settings: { automation: { mode: 'on-open' }, classificationMethod: 'local-rules' } } });
    const before = await sendMessage(chrome, { type: 'AUTO_PREVIEW_STATUS' });
    assert.equal(before.enabled, true);
    assert.equal(before.onOpenMode, true);
    assert.equal(before.autoOrganize, false);
    assert.equal(before.autoPreviewAllowed, true);
    assert.equal(before.manualDryRunCompleted, false);
  });
});
