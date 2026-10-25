import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCHEDULE_MINUTES, appendRunHistory, automationFingerprint, lockIsStale, normalizeAutomation, sanitizeAutomationError } from '../lib/automation.js';

describe('automation settings and persisted run state', () => {
  it('defaults scheduled operation to every six hours and unattended mode off', () => {
    assert.equal(normalizeAutomation().mode, 'manual');
    assert.equal(normalizeAutomation({ mode: 'scheduled' }).scheduleMinutes, DEFAULT_SCHEDULE_MINUTES);
  });
  it('accepts supported custom intervals and clamps unsafe values', () => {
    assert.equal(normalizeAutomation({ mode: 'scheduled', scheduleMinutes: 90 }).scheduleMinutes, 90);
    assert.equal(normalizeAutomation({ scheduleMinutes: 10 }).scheduleMinutes, 60);
    assert.equal(normalizeAutomation({ scheduleMinutes: 99999 }).scheduleMinutes, 10080);
  });
  it('rejects unknown operating modes', () => {
    assert.equal(normalizeAutomation({ mode: 'background-everywhere' }).mode, 'manual');
  });
  it('fingerprints subject and sorting safety configuration', () => {
    const settings = { classificationMethod: 'local-rules', subjects: [{ id: 'a', name: 'A' }], taxonomy: ['A'], sort: { withinGroup: 'duration-asc' } };
    const initial = automationFingerprint(settings, {});
    assert.equal(automationFingerprint(settings, {}), initial);
    assert.notEqual(automationFingerprint({ ...settings, sort: { withinGroup: 'duration-desc' } }, {}), initial);
  });
  it('recognizes expired locks but retains recent locks', () => {
    assert.equal(lockIsStale({ startedAt: 10 }, 10 + 45 * 60 * 1000 - 1), false);
    assert.equal(lockIsStale({ startedAt: 10 }, 10 + 45 * 60 * 1000 + 1), true);
    assert.equal(lockIsStale({ startedAt: 10 + 6 * 60 * 1000 }, 10), true);
    assert.equal(lockIsStale(null), true);
  });
  it('keeps only bounded local run summaries and excludes private playlist metadata', () => {
    const history = appendRunHistory([{ id: 'old' }], { id: 'run', status: 'success', classifiedCount: 2, reorderedCount: 1, alreadyOrdered: false, title: 'private title', videoIds: ['private-id'] }, 1);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, 'run');
    assert.equal('videoIds' in history[0], false);
    assert.equal('title' in history[0], false);
  });
  it('redacts authentication strings and URL API keys from stored errors', () => {
    const sanitized = sanitizeAutomationError('SAPISIDHASH secret Authorization: Bearer secret https://x.test/?key=api-secret SAPISID=cookie-secret');
    assert.equal(sanitized.includes('secret'), false);
    assert.equal(sanitized.includes('cookie-secret'), false);
    assert.match(sanitized, /\[redacted\]/);
  });
});
