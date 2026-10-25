import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSubject, normalizeSubjects, CURATED_TOPICS, FALLBACK_VIDEO_CATEGORIES, PERSONAL_PRESET, exportConfiguration, importConfiguration, fetchVideoCategories } from '../lib/configuration.js';

describe('source-aware subjects', () => {
  it('keeps category IDs, topic IDs and custom IDs in separate namespaces', () => {
    const category = createSubject('category', 'News', '25');
    const topic = createSubject('topic', 'News', '/m/05qt0');
    const custom = createSubject('custom', 'News');
    assert.deepEqual([category.id, topic.id].map(x => x.split(':')[0]), ['youtube-category', 'youtube-topic']);
    assert.match(custom.id, /^custom:/);
  });
  it('normalizes, deduplicates and preserves user priority ordering', () => {
    const subjects = normalizeSubjects([{ id: 'custom:a', source: 'custom', name: 'A' }, { id: 'custom:b', source: 'custom', name: 'B' }, { id: 'custom:a', source: 'custom', name: 'duplicate' }]);
    assert.deepEqual(subjects.map(x => [x.id, x.priority]), [['custom:a', 0], ['custom:b', 1]]);
  });
  it('persists editable inclusion/exclusion and metadata weight rules with bounded values', () => {
    const [subject] = normalizeSubjects([{ id: 'custom:rules', source: 'custom', name: 'Research', rules: { includePhrases: [' quantum ', 'quantum'], excludePhrases: ['fiction'], metadataWeights: { title: { phrases: ['research'], weight: 99 }, invalid: { weight: 50 } } } }]);
    assert.deepEqual(subject.rules.includePhrases, ['quantum']);
    assert.deepEqual(subject.rules.excludePhrases, ['fiction']);
    assert.equal(subject.rules.metadataWeights.title.weight, 10);
    assert.equal(subject.rules.metadataWeights.invalid, undefined);
  });
  it('ships a clearly limited topic catalogue and offline category fallback', () => {
    assert.ok(CURATED_TOPICS.some(x => x.id === '/m/05qt0'));
    assert.ok(FALLBACK_VIDEO_CATEGORIES.some(x => x.externalId === '25'));
  });
});

describe('preset import/export and API category refresh', () => {
  it('provides the editable Niall example with the requested duration order', () => {
    assert.equal(PERSONAL_PRESET.name, 'Niall — Watch Later');
    assert.deepEqual(PERSONAL_PRESET.subjects.map(s => s.name), ['News', 'Music History / Commentary', 'Biblical History / Documentary', 'Biblical Explanation', 'Physics', 'AI Skills & News', 'Other / Uncategorised']);
    assert.equal(PERSONAL_PRESET.sort.withinGroup, 'duration-asc');
    assert.equal(PERSONAL_PRESET.sort.inProgress, 'sort');
  });
  it('round-trips settings through JSON and rejects other formats', () => {
    const value = { subjects: PERSONAL_PRESET.subjects, apiKey: 'secret' };
    assert.deepEqual(importConfiguration(exportConfiguration(value)), { subjects: PERSONAL_PRESET.subjects });
    assert.throws(() => importConfiguration('{"settings":{}}'), /not a supported/);
  });
  it('fetches only assignable categories and requires a key to refresh', async () => {
    await assert.rejects(fetchVideoCategories(''), /API key is required/);
    const result = await fetchVideoCategories('key', { fetchImpl: async () => ({ ok: true, json: async () => ({ items: [
      { id: '25', snippet: { title: 'News', assignable: true } }, { id: '0', snippet: { title: 'Unavailable', assignable: false } },
    ] }) }) });
    assert.deepEqual(result.map(x => x.externalId), ['25']);
  });
});
