import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../lib/settings.js';
import { automationFingerprint, AUTOMATION_ALARM } from '../lib/automation.js';

function chromeMock({ settings = {}, local = {}, tabs = [{ id: 7, status: 'complete', url: 'https://www.youtube.com/playlist?list=WL' }], contentResult = { success: true, alreadyOrdered: true, applied: false, completenessVerified: true, pageCount: 1 }, delayMs = 0 } = {}) {
  const localStore = { ...local };
  const syncStore = { settings };
  const alarms = new Map();
  const removedTabs = [];
  const dispatched = [];
  let messageListener, alarmListener, startupListener, installListener, storageListener;
  const api = {
    action: { setIcon: () => Promise.resolve() },
    runtime: { onMessage: { addListener: fn => { messageListener = fn; } }, onStartup: { addListener: fn => { startupListener = fn; } }, onInstalled: { addListener: fn => { installListener = fn; } } },
    storage: {
      onChanged: { addListener: fn => { storageListener = fn; } },
      sync: { get: key => Promise.resolve(typeof key === 'string' ? { [key]: syncStore[key] } : { ...syncStore }), set: object => { Object.assign(syncStore, object); return Promise.resolve(); } },
      local: { get: key => Promise.resolve(typeof key === 'string' ? { [key]: localStore[key] } : Object.fromEntries((Array.isArray(key) ? key : Object.keys(localStore)).map(k => [k, localStore[k]]))), set: object => { Object.assign(localStore, object); return Promise.resolve(); }, remove: key => { for (const k of (Array.isArray(key) ? key : [key])) delete localStore[k]; return Promise.resolve(); } },
    },
    alarms: { onAlarm: { addListener: fn => { alarmListener = fn; } }, create: (name, info) => { alarms.set(name, { name, scheduledTime: Date.now() + (info.delayInMinutes || info.periodInMinutes) * 60000, ...info }); }, clear: name => Promise.resolve(alarms.delete(name)), get: name => Promise.resolve(alarms.get(name) || null) },
    tabs: {
      query: async () => tabs,
      create: async props => { const tab = { id: 90, status: 'complete', ...props }; tabs.push(tab); return tab; },
      get: async id => tabs.find(tab => tab.id === id) || null,
      remove: async id => { removedTabs.push(id); tabs = tabs.filter(tab => tab.id !== id); },
      sendMessage: async (_id, message) => {
        dispatched.push(message);
        if (message.type === 'AUTOMATION_PING') return { ready: true };
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        return typeof contentResult === 'function' ? contentResult(message) : contentResult;
      },
    },
    notifications: { create: async (...args) => { api.notificationsSent.push(args); } }, notificationsSent: [],
  };
  return { api, localStore, syncStore, alarms, removedTabs, dispatched, listeners: () => ({ messageListener, alarmListener, startupListener, installListener, storageListener }) };
}

const settings = mode => normalizeSettings({ automation: { mode, scheduleMinutes: 360, notifications: false }, classificationMethod: 'local-rules' });
function authorizedLocal(configured, extra = {}) {
  const normalized = settings(configured.automation.mode);
  return {
    automationEnabled: true,
    automationPaused: false,
    automationAuthorization: { manualReorderVerified: true, playlistId: 'WL', accountId: '/@example', fingerprint: automationFingerprint(normalized, {}), consentedAt: Date.now() },
    ...extra,
  };
}

let workerListeners;
async function setup(options = {}) {
  const mock = chromeMock(options);
  globalThis.chrome = mock.api;
  await import('../background/service-worker.js');
  if (!workerListeners) workerListeners = mock.listeners();
  mock.listeners = () => workerListeners;
  return mock;
}

function send(mock, message, sender = {}) {
  return new Promise(resolve => {
    const keepAlive = mock.listeners().messageListener(message, sender, resolve);
    assert.equal(keepAlive, true);
  });
}

describe('unattended service-worker orchestration with mocked YouTube', () => {
  it('creates the six-hour alarm when scheduled settings and authorization are present', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured) });
    mock.listeners().storageListener({ settings: {} }, 'sync');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(mock.alarms.get(AUTOMATION_ALARM).periodInMinutes, 360);
  });

  it('recreates a missing alarm on service-worker startup and handles one delayed cycle once', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured) });
    mock.listeners().startupListener();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(mock.alarms.get(AUTOMATION_ALARM).periodInMinutes, 360);
    mock.listeners().alarmListener({ name: AUTOMATION_ALARM });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(mock.dispatched.filter(message => message.type === 'RUN_UNATTENDED_AUTOMATION').length, 1);
  });

  it('catches up one missed scheduled cycle when Chrome wakes after the due time', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured) });
    mock.alarms.set(AUTOMATION_ALARM, { name: AUTOMATION_ALARM, scheduledTime: Date.now() - 60000, periodInMinutes: 360 });
    mock.listeners().startupListener();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(mock.dispatched.filter(message => message.type === 'RUN_UNATTENDED_AUTOMATION').length, 1);
    assert.equal(mock.alarms.get(AUTOMATION_ALARM).periodInMinutes, 360);
  });

  it('uses the stored order and records a verified no-op without another write', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), contentResult: { success: true, alreadyOrdered: true, applied: false, completenessVerified: true, pageCount: 2, classifiedCount: 0, moveCount: 0 } });
    const result = await send(mock, { type: 'RUN_AUTOMATION_NOW' });
    assert.equal(result.success, true);
    assert.equal(result.status, 'success');
    assert.equal(result.alreadyOrdered, true);
    assert.equal(mock.dispatched.filter(m => m.type === 'RUN_UNATTENDED_AUTOMATION').length, 1);
    assert.equal(mock.localStore.automationHistory.length, 1);
    assert.equal(mock.localStore.automationLock, null);
  });

  it('does not report a structurally unsuccessful success result as a successful run', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), contentResult: { success: true, alreadyOrdered: false, applied: false, previewOnly: false, completenessVerified: true, moveCount: 0, error: 'No verified outcome.' } });
    const result = await send(mock, { type: 'RUN_AUTOMATION_NOW' });
    assert.equal(result.success, false);
    assert.equal(result.status, 'attention');
    assert.equal(mock.localStore.automationHistory[0].status, 'attention');
    assert.equal(mock.localStore.automationFailureStreak, 1);
    assert.equal(mock.localStore.automationPaused, true);
  });

  it('retries an applyOrder exhaustion only when complete read-back confirms the original order', async () => {
    const configured = settings('scheduled');
    const applyResult = { applied: false, retrySafe: true, originalOrderUnchanged: true, completenessVerified: true, moveCount: 1, error: 'YouTube did not confirm the new order. The playlist still matches its original order; no further write was attempted.' };
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), contentResult: { success: false, ...applyResult } });

    for (let attempt = 1; attempt <= 5; attempt++) {
      mock.listeners().alarmListener({ name: AUTOMATION_ALARM });
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(mock.localStore.automationHistory.at(-1).status, 'failed');
      assert.equal(mock.localStore.automationFailureStreak, attempt);
      if (attempt < 5) {
        assert.equal(mock.alarms.get(AUTOMATION_ALARM).delayInMinutes, 2 ** attempt);
        assert.notEqual(mock.localStore.automationPaused, true);
      }
    }
    assert.equal(mock.localStore.automationPaused, true);
    assert.equal(mock.localStore.automationState.status, 'attention');
    assert.equal(mock.alarms.has(AUTOMATION_ALARM), false);
  });

  it('does not retry an ambiguous or incomplete failed write result', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), contentResult: { success: false, applied: false, retrySafe: false, requiresAttention: true, completenessVerified: false, error: 'Write result is ambiguous; playlist read-back was incomplete.' } });
    const result = await send(mock, { type: 'RUN_AUTOMATION_NOW' });
    assert.equal(result.success, false);
    assert.equal(result.status, 'attention');
    assert.equal(mock.localStore.automationFailureStreak, 1);
    assert.equal(mock.alarms.has(AUTOMATION_ALARM), false);
    assert.equal(mock.localStore.automationPaused, true);
  });

  it('previews without enabling writes and returns the intended order to the user', async () => {
    const mock = await setup({ settings: settings('manual'), local: {}, contentResult: { success: true, previewOnly: true, completenessVerified: true, pageCount: 1, preview: [{ title: 'Video', subject: 'Music' }] } });
    const result = await send(mock, { type: 'RUN_AUTOMATION_NOW', previewOnly: true });
    assert.equal(result.success, true);
    assert.equal(result.status, 'preview');
    assert.deepEqual(result.preview, [{ title: 'Video', subject: 'Music' }]);
    assert.equal(mock.dispatched.find(m => m.type === 'RUN_UNATTENDED_AUTOMATION').apply, false);
  });

  it('pauses after a missing or mismatched completeness result', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), contentResult: { success: false, requiresAttention: true, completenessVerified: false, error: 'Header count mismatched retrieved entries.' } });
    const result = await send(mock, { type: 'RUN_AUTOMATION_NOW' });
    assert.equal(result.status, 'attention');
    assert.equal(mock.localStore.automationPaused, true);
    assert.equal(mock.alarms.has(AUTOMATION_ALARM), false);
  });

  it('pauses on account mismatch and retains a credential-free result record', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), contentResult: { success: false, requiresAttention: true, error: 'Account does not match the authorized account.' } });
    const result = await send(mock, { type: 'RUN_AUTOMATION_NOW' });
    assert.equal(result.status, 'attention');
    assert.equal(mock.localStore.automationPaused, true);
    assert.equal('cookie' in mock.localStore.automationHistory[0], false);
  });

  it('backs off transient failures and stops after five attempts', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), contentResult: { success: false, retrySafe: true, error: 'Temporary network failure.' } });
    for (let i = 0; i < 5; i++) {
      mock.listeners().alarmListener({ name: AUTOMATION_ALARM });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(mock.localStore.automationFailureStreak, 5);
    assert.equal(mock.localStore.automationPaused, true);
    assert.equal(mock.alarms.has(AUTOMATION_ALARM), false);
  });

  it('sends an attention notification only when requested', async () => {
    const configured = { ...settings('scheduled'), automation: { mode: 'scheduled', scheduleMinutes: 360, notifications: true } };
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), contentResult: { success: false, requiresAttention: true, error: 'Header count mismatch.' } });
    await send(mock, { type: 'RUN_AUTOMATION_NOW' });
    assert.equal(mock.api.notificationsSent.length, 1);
    assert.match(mock.api.notificationsSent[0][1].title, /needs attention/i);
  });

  it('prevents two same-worker triggers from overlapping', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), delayMs: 75 });
    const first = send(mock, { type: 'RUN_AUTOMATION_NOW' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await send(mock, { type: 'RUN_AUTOMATION_NOW' });
    assert.equal(second.skipped, true);
    await first;
  });

  it('closes only its own temporary tab after a background run', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured), tabs: [] });
    const result = await send(mock, { type: 'RUN_AUTOMATION_NOW' });
    assert.equal(result.success, true);
    assert.deepEqual(mock.removedTabs, [90]);
  });

  it('recovers stale locks on service-worker startup and pauses for inspection', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured, { automationLock: { id: 'stale', startedAt: 1, temporaryTabId: 33 } }) });
    mock.listeners().startupListener();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(mock.localStore.automationPaused, true);
    assert.deepEqual(mock.removedTabs, [33]);
    assert.equal(mock.localStore.automationLock, undefined);
    assert.equal(mock.localStore.automationHistory[0].status, 'attention');
  });

  it('honours pause and disable controls by clearing the schedule', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: authorizedLocal(configured) });
    assert.equal((await send(mock, { type: 'PAUSE_AUTOMATION' })).success, true);
    assert.equal(mock.localStore.automationPaused, true);
    assert.equal(mock.alarms.has(AUTOMATION_ALARM), false);
    assert.equal((await send(mock, { type: 'DISABLE_UNATTENDED_SORTING' })).success, true);
    assert.equal(mock.localStore.automationEnabled, false);
  });

  it('requires matching manual-reorder evidence and explicit consent before enabling', async () => {
    const configured = settings('scheduled');
    const evidence = { manualReorderVerified: true, playlistId: 'WL', accountId: '/@example', fingerprint: automationFingerprint(configured, {}), moveCount: 2 };
    const mock = await setup({ settings: configured, local: { lastManualAcceptance: evidence } });
    assert.equal((await send(mock, { type: 'ENABLE_UNATTENDED_SORTING' })).success, false);
    const enabled = await send(mock, { type: 'ENABLE_UNATTENDED_SORTING', confirmed: true });
    assert.equal(enabled.success, true);
    assert.equal(mock.localStore.automationEnabled, true);
    assert.equal(mock.alarms.get(AUTOMATION_ALARM).periodInMinutes, 360);
  });

  it('records a verified no-op read without claiming a write or enabling unattended mutation', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: {} });
    const response = await send(mock, { type: 'RECORD_MANUAL_ACCEPTANCE', playlistId: 'WL', accountId: '/@example', evidenceKind: 'read-noop', moveCount: 0, completenessVerified: true, verifiedRead: true, orderMatched: true, verifiedWrite: false, readbackVerified: false }, { tab: { url: 'https://www.youtube.com/playlist?list=WL' } });
    assert.equal(response.success, true);
    assert.equal(mock.localStore.lastManualAcceptance.manualReadVerified, true);
    assert.equal(mock.localStore.lastManualAcceptance.evidenceKind, 'read-noop');
    assert.equal(mock.localStore.lastManualAcceptance.manualMutationVerified, false);
    const status = await send(mock, { type: 'GET_AUTOMATION_STATUS' });
    assert.equal(status.manualReadVerified, true);
    assert.equal(status.manualWriteVerified, false);
    assert.equal(status.acceptanceReady, false);
    assert.equal((await send(mock, { type: 'ENABLE_UNATTENDED_SORTING', confirmed: true })).success, false);
  });

  it('records a separately verified live write as mutation evidence', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: {} });
    const response = await send(mock, { type: 'RECORD_MANUAL_ACCEPTANCE', playlistId: 'WL', accountId: '/@example', evidenceKind: 'write', moveCount: 1, completenessVerified: true, verifiedRead: true, orderMatched: true, verifiedWrite: true, readbackVerified: true }, { tab: { url: 'https://www.youtube.com/playlist?list=WL' } });
    assert.equal(response.success, true);
    assert.equal(mock.localStore.lastManualAcceptance.manualReorderVerified, true);
    assert.equal(mock.localStore.lastManualAcceptance.manualMutationVerified, true);
    assert.equal(mock.localStore.lastManualAcceptance.accountId, '/@example');
    const status = await send(mock, { type: 'GET_AUTOMATION_STATUS' });
    assert.equal(status.manualReadVerified, true);
    assert.equal(status.manualWriteVerified, true);
    assert.equal(status.acceptanceReady, true);
  });

  it('rejects incomplete retrieval and failed read-back evidence', async () => {
    const configured = settings('scheduled');
    const mock = await setup({ settings: configured, local: {} });
    const sender = { tab: { url: 'https://www.youtube.com/playlist?list=WL' } };
    const incomplete = await send(mock, { type: 'RECORD_MANUAL_ACCEPTANCE', playlistId: 'WL', accountId: '/@example', evidenceKind: 'read-noop', moveCount: 0, completenessVerified: false, verifiedRead: true, orderMatched: true, verifiedWrite: false }, sender);
    const unreadBack = await send(mock, { type: 'RECORD_MANUAL_ACCEPTANCE', playlistId: 'WL', accountId: '/@example', evidenceKind: 'write', moveCount: 1, completenessVerified: true, verifiedRead: true, orderMatched: false, verifiedWrite: true, readbackVerified: false }, sender);
    assert.equal(incomplete.success, false);
    assert.equal(unreadBack.success, false);
    assert.equal(mock.localStore.lastManualAcceptance, undefined);
  });

  it('requires fresh manual acceptance after safety settings change', async () => {
    const configured = settings('scheduled');
    const evidence = { manualReorderVerified: true, playlistId: 'WL', accountId: '/@example', fingerprint: 'old-config', moveCount: 1 };
    const mock = await setup({ settings: configured, local: {
      automationEnabled: true,
      automationAuthorization: { manualMutationVerified: true, manualReorderVerified: true, playlistId: 'WL', accountId: '/@example', fingerprint: 'old-config' },
      lastManualAcceptance: evidence,
    } });
    const response = await send(mock, { type: 'ENABLE_UNATTENDED_SORTING', confirmed: true });
    assert.equal(response.success, false);
    assert.match(response.error, /manual Watch Later reorder/i);
    assert.equal(mock.localStore.automationEnabled, true);
    const status = await send(mock, { type: 'GET_AUTOMATION_STATUS' });
    assert.equal(status.manualReadVerified, false);
    assert.equal(status.manualWriteVerified, false);
    assert.equal(status.authorized, false);
    assert.equal(status.enabled, false);
  });
});
