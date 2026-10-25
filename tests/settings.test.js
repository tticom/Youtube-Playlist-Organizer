// tests/settings.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings, loadSettings, saveSettings,
} from '../lib/settings.js';
import { TAXONOMY } from '../lib/taxonomy.js';
import { SORT_DEFAULTS } from '../lib/sort.js';

/** Fake chrome.storage.sync: promise-based get/set/remove over a plain object. */
function fakeSync(initial = {}) {
  const store = { ...initial };
  return {
    store,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    async set(values) { Object.assign(store, values); },
    async remove(key) { delete store[key]; },
  };
}

describe('DEFAULT_SETTINGS', () => {
  it('starts on Anthropic with the built-in taxonomy and no key', () => {
    assert.equal(DEFAULT_SETTINGS.provider, 'anthropic');
    assert.equal(DEFAULT_SETTINGS.autoPreviewWatchLater, false);
    assert.equal(DEFAULT_SETTINGS.apiKey, '');
    assert.equal(DEFAULT_SETTINGS.classificationMethod, 'local-rules');
    assert.deepEqual(DEFAULT_SETTINGS.taxonomy, TAXONOMY);
    assert.equal(DEFAULT_SETTINGS.maxNewCategories, 2);
    assert.equal(DEFAULT_SETTINGS.autoOrganizeWatchLater, false);
  });
});

describe('normalizeSettings', () => {
  it('defaults new configurations to local rules and keeps legacy configured providers on their previous AI path', () => {
    assert.equal(normalizeSettings({}).classificationMethod, 'local-rules');
    assert.equal(normalizeSettings({ provider: 'openai', apiKey: 'legacy' }).classificationMethod, 'cloud-ai');
    assert.equal(normalizeSettings({ classificationMethod: 'local-ai' }).classificationMethod, 'local-ai');
  });
  it('fills every default from an empty object, resolving URL and model from the provider', () => {
    const s = normalizeSettings({});
    assert.equal(s.provider, 'anthropic');
    assert.equal(s.baseUrl, 'https://api.anthropic.com');
    assert.equal(s.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(s.taxonomy, TAXONOMY);
    assert.equal(s.extraInstructions, '');
    assert.equal(s.autoOrganizeWatchLater, false);
    assert.equal(normalizeSettings({ autoOrganizeWatchLater: true }).autoOrganizeWatchLater, true);
  });

  it('tolerates garbage input', () => {
    assert.equal(normalizeSettings(null).provider, 'anthropic');
    assert.equal(normalizeSettings('nope').provider, 'anthropic');
    assert.equal(normalizeSettings({ provider: 'bogus' }).provider, 'anthropic');
  });

  it('keeps a user-supplied base URL and model, trimming a trailing slash', () => {
    const s = normalizeSettings({ provider: 'ollama', baseUrl: 'http://box:11434/v1/', model: ' qwen ' });
    assert.equal(s.baseUrl, 'http://box:11434/v1');
    assert.equal(s.model, 'qwen');
  });

  it('leaves the custom provider with an empty URL and model when none given', () => {
    const s = normalizeSettings({ provider: 'custom' });
    assert.equal(s.baseUrl, '');
    assert.equal(s.model, '');
  });

  it('coerces the taxonomy to trimmed, de-duplicated, non-empty strings', () => {
    const s = normalizeSettings({ taxonomy: [' Music ', '', 'music', 'Tech', null, 'Tech', 42] });
    assert.deepEqual(s.taxonomy, ['Music', 'Tech', '42']);
  });

  it('drops the reserved Other and Unavailable names in any case', () => {
    assert.deepEqual(normalizeSettings({ taxonomy: ['Music', 'other', 'UNAVAILABLE', 'Tech'] }).taxonomy, ['Music', 'Tech']);
  });

  it('accepts a newline-separated taxonomy string', () => {
    assert.deepEqual(normalizeSettings({ taxonomy: 'A\n\n B \nA' }).taxonomy, ['A', 'B']);
  });

  it('falls back to the default taxonomy when the list would be empty', () => {
    assert.deepEqual(normalizeSettings({ taxonomy: ['', '  '] }).taxonomy, TAXONOMY);
  });

  it('clamps maxNewCategories to 0–10 and defaults non-numbers', () => {
    assert.equal(normalizeSettings({ maxNewCategories: -3 }).maxNewCategories, 0);
    assert.equal(normalizeSettings({ maxNewCategories: 99 }).maxNewCategories, 10);
    assert.equal(normalizeSettings({ maxNewCategories: '4' }).maxNewCategories, 4);
    assert.equal(normalizeSettings({ maxNewCategories: 'lots' }).maxNewCategories, 2);
  });

  it('trims the key and extra instructions', () => {
    const s = normalizeSettings({ apiKey: ' k ', extraInstructions: ' be brief \n' });
    assert.equal(s.apiKey, 'k');
    assert.equal(s.extraInstructions, 'be brief');
  });
});

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', async () => {
    const sync = fakeSync();
    const s = await loadSettings(sync);
    assert.equal(s.provider, 'anthropic');
    assert.equal(s.apiKey, '');
    assert.deepEqual(sync.store, {}, 'a plain load does not write');
  });

  it('normalizes what is stored', async () => {
    const sync = fakeSync({ [SETTINGS_KEY]: { provider: 'openai', apiKey: 'k', maxNewCategories: 50 } });
    const s = await loadSettings(sync);
    assert.equal(s.provider, 'openai');
    assert.equal(s.model, 'gpt-5-mini');
    assert.equal(s.maxNewCategories, 10);
  });

  it('migrates a legacy top-level apiKey into settings and removes it', async () => {
    const sync = fakeSync({ apiKey: 'sk-ant-old' });
    const s = await loadSettings(sync);
    assert.equal(s.provider, 'anthropic');
    assert.equal(s.apiKey, 'sk-ant-old');
    assert.equal(sync.store.apiKey, undefined, 'legacy key removed');
    assert.equal(sync.store[SETTINGS_KEY].apiKey, 'sk-ant-old');
  });

  it('prefers stored settings over a lingering legacy key', async () => {
    const sync = fakeSync({ apiKey: 'old', [SETTINGS_KEY]: { provider: 'openai', apiKey: 'new' } });
    const s = await loadSettings(sync);
    assert.equal(s.apiKey, 'new');
    assert.equal(sync.store.apiKey, 'old', 'untouched: migration only runs when settings are absent');
  });
});

describe('saveSettings', () => {
  it('merges a partial over the stored settings and normalizes', async () => {
    const sync = fakeSync({ [SETTINGS_KEY]: { provider: 'openai', apiKey: 'k', model: 'gpt-5-nano' } });
    const saved = await saveSettings({ maxNewCategories: 3, taxonomy: ['A', 'B'] }, sync);
    assert.equal(saved.model, 'gpt-5-nano');
    assert.equal(saved.maxNewCategories, 3);
    assert.deepEqual(sync.store[SETTINGS_KEY].taxonomy, ['A', 'B']);
  });

  it('does not carry the old provider URL and model across a provider switch', async () => {
    const sync = fakeSync({ [SETTINGS_KEY]: { provider: 'ollama', baseUrl: 'http://box:11434/v1', model: 'llama3.2' } });
    const saved = await saveSettings({ provider: 'openai', apiKey: 'k' }, sync);
    assert.equal(saved.baseUrl, 'https://api.openai.com/v1');
    assert.equal(saved.model, 'gpt-5-mini');
  });

  it('keeps an explicitly supplied model across a provider switch', async () => {
    const sync = fakeSync();
    const saved = await saveSettings({ provider: 'openrouter', apiKey: 'k', model: 'openai/gpt-5-nano' }, sync);
    assert.equal(saved.model, 'openai/gpt-5-nano');
  });
});

describe('settings.sort', () => {
  it('defaults to the sorter\'s defaults', () => {
    assert.deepEqual(DEFAULT_SETTINGS.sort, SORT_DEFAULTS);
    assert.deepEqual(normalizeSettings({}).sort, SORT_DEFAULTS);
  });

  it('keeps whitelisted values and drops anything else back to the default', () => {
    const s = normalizeSettings({ sort: { withinGroup: 'title', inProgress: 'nope', groupOrder: 'size' } });
    assert.deepEqual(s.sort, { withinGroup: 'title', secondaryWithinGroup: 'playlist', inProgress: 'top', groupOrder: 'size' });
    assert.deepEqual(normalizeSettings({ sort: 'garbage' }).sort, SORT_DEFAULTS);
  });

  it('round-trips through saveSettings and loadSettings', async () => {
    const sync = fakeSync();
    await saveSettings({ sort: { inProgress: 'within' } }, sync);
    const s = await loadSettings(sync);
    assert.deepEqual(s.sort, { ...SORT_DEFAULTS, inProgress: 'within' });
  });
});
