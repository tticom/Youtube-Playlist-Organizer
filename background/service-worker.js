// background/service-worker.js
import { categorizeVideos, listModels } from '../lib/classify.js';
import { buildSortOrder, buildSimpleSortOrder, normalizeSortOptions } from '../lib/sort.js';
import { loadSettings, normalizeSettings, saveSettings } from '../lib/settings.js';
import { getProvider } from '../lib/providers.js';
import { classifyLocally, LOCAL_CLASSIFIER_VERSION } from '../lib/local-classify.js';
import { createLearningState, recordClassificationFeedback, generateRuleSuggestions, reviewSuggestion, recordSortingChoice, resetLearnedPreferences, exportLearningPreferences, importLearningPreferences } from '../lib/learning.js';
import { AUTOMATION_ALARM, DEFAULT_SCHEDULE_MINUTES, appendRunHistory, automationFingerprint, lockIsStale, sanitizeAutomationError } from '../lib/automation.js';

let automationInFlight = null;

async function getAutomationStatus() {
  const settings = await loadSettings();
  const local = await chrome.storage.local.get(['automationEnabled', 'automationPaused', 'automationState', 'automationAuthorization', 'automationHistory', 'automationLock', 'learningState', 'lastManualAcceptance']);
  const fingerprint = automationFingerprint(settings, createLearningState(local.learningState));
  const authorization = local.automationAuthorization;
  const authorized = Boolean(authorization?.manualReorderVerified && authorization?.playlistId === 'WL' && authorization?.accountId && authorization?.fingerprint === fingerprint);
  const acceptance = local.lastManualAcceptance;
  const acceptanceReady = Boolean(acceptance?.manualReorderVerified && acceptance?.playlistId === 'WL' && acceptance?.accountId && acceptance?.fingerprint === fingerprint && acceptance?.moveCount > 0);
  const enabled = local.automationEnabled === true && authorized && local.automationPaused !== true && settings.automation.mode !== 'manual';
  const alarm = chrome.alarms?.get ? await chrome.alarms.get(AUTOMATION_ALARM).catch(() => null) : null;
  return {
    enabled, authorized, acceptanceReady, mode: settings.automation.mode, scheduleMinutes: settings.automation.scheduleMinutes,
    notifications: settings.automation.notifications, paused: local.automationPaused === true,
    pauseReason: local.automationState?.pauseReason || null,
    lastAttemptedRun: local.automationState?.lastAttemptedRun || null,
    lastSuccessfulRun: local.automationState?.lastSuccessfulRun || null,
    lastResult: local.automationState?.lastResult || null,
    nextScheduledRun: alarm?.scheduledTime || null,
    history: Array.isArray(local.automationHistory) ? local.automationHistory : [],
    settings, authorization, lastManualAcceptance: local.lastManualAcceptance || null,
    previewAllowed: true,
  };
}

async function getAutomationPermit() {
  const status = await getAutomationStatus();
  return { enabled: status.enabled, authorized: status.authorized, mode: status.mode, accountId: status.authorization?.accountId || null };
}

async function syncAutomationSchedule() {
  if (!chrome.alarms) return;
  const status = await getAutomationStatus();
  const existing = await chrome.alarms.get(AUTOMATION_ALARM).catch(() => null);
  if (status.enabled && status.mode === 'scheduled') {
    const interval = status.scheduleMinutes || DEFAULT_SCHEDULE_MINUTES;
    const { automationFailureStreak = 0 } = await chrome.storage.local.get('automationFailureStreak');
    const retryAlarm = existing && !existing.periodInMinutes && automationFailureStreak > 0;
    if (existing && existing.scheduledTime > Date.now() && (existing.periodInMinutes === interval || retryAlarm)) return;
    const missedAlarm = Boolean(existing && existing.scheduledTime <= Date.now());
    await chrome.alarms.clear(AUTOMATION_ALARM);
    await chrome.alarms.create(AUTOMATION_ALARM, { periodInMinutes: interval });
    if (missedAlarm) setTimeout(() => runScheduledAutomation('scheduled').catch(() => {}), 0);
  } else await chrome.alarms.clear(AUTOMATION_ALARM);
}

async function saveAutomationStatus(update = {}) {
  const current = (await chrome.storage.local.get('automationState')).automationState || {};
  const safeUpdate = typeof update.pauseReason === 'string' ? { ...update, pauseReason: sanitizeAutomationError(update.pauseReason) } : update;
  const next = { ...current, ...safeUpdate, updatedAt: Date.now() };
  await chrome.storage.local.set({ automationState: next });
  return next;
}

async function recordManualAcceptance(message, sender) {
  const settings = await loadSettings();
  const { learningState } = await chrome.storage.local.get('learningState');
  const accountId = String(message.accountId || '');
  const moveCount = Number(message.moveCount) || 0;
  let senderPlaylist = null;
  try { const url = new URL(sender?.tab?.url); if (url.origin === 'https://www.youtube.com' && url.pathname === '/playlist') senderPlaylist = url.searchParams.get('list'); } catch {}
  if (senderPlaylist !== 'WL') return { success: false, error: 'Manual acceptance evidence must come from the Watch Later tab.' };
  if (message.playlistId !== 'WL' || !accountId || message.completenessVerified !== true || message.readbackVerified !== true || moveCount < 1) {
    return { success: false, error: 'A verified Watch Later reorder with at least one applied move is required before unattended sorting can be enabled.' };
  }
  const acceptance = { playlistId: 'WL', accountId, moveCount, fingerprint: automationFingerprint(settings, createLearningState(learningState)), verifiedAt: Date.now(), manualReorderVerified: true };
  await chrome.storage.local.set({ lastManualAcceptance: acceptance });
  return { success: true, acceptance };
}

async function enableUnattendedSorting({ confirmed = false } = {}) {
  if (!confirmed) return { success: false, error: 'Explicit confirmation is required.' };
  const status = await getAutomationStatus();
  const acceptance = status.lastManualAcceptance;
  if (status.settings.automation.mode === 'manual') return { success: false, error: 'Choose Automatic on opening Watch Later or Scheduled unattended before enabling unattended sorting.' };
  const fingerprint = automationFingerprint(status.settings, (await chrome.storage.local.get('learningState')).learningState || {});
  if (!acceptance?.manualReorderVerified || acceptance.playlistId !== 'WL' || !acceptance.accountId || acceptance.fingerprint !== fingerprint) {
    return { success: false, error: 'Complete and verify a manual Watch Later reorder using the current saved settings before enabling unattended sorting.' };
  }
  await chrome.storage.local.set({ automationEnabled: true, automationPaused: false, automationAuthorization: { ...acceptance, consentedAt: Date.now() } });
  await saveAutomationStatus({ pauseReason: null, status: 'enabled' });
  await syncAutomationSchedule();
  return { success: true };
}

async function disableUnattendedSorting(reason = 'disabled') {
  await chrome.storage.local.set({ automationEnabled: false, automationPaused: false });
  await chrome.alarms?.clear?.(AUTOMATION_ALARM);
  await saveAutomationStatus({ status: reason, pauseReason: reason === 'disabled' ? null : reason });
  return { success: true };
}

async function pauseAutomation() {
  await chrome.storage.local.set({ automationPaused: true });
  await chrome.alarms?.clear?.(AUTOMATION_ALARM);
  await saveAutomationStatus({ status: 'paused', pauseReason: 'Paused by user' });
  return { success: true };
}

async function resumeAutomation() {
  const status = await getAutomationStatus();
  if (!status.authorized || !status.settings) return { success: false, error: 'Unattended sorting needs fresh authorization for the current settings.' };
  await chrome.storage.local.set({ automationPaused: false });
  await saveAutomationStatus({ status: 'enabled', pauseReason: null });
  await syncAutomationSchedule();
  return { success: true };
}

async function recoverAutomationState() {
  const { automationLock, automationState, automationHistory = [] } = await chrome.storage.local.get(['automationLock', 'automationState', 'automationHistory']);
  if (automationLock && lockIsStale(automationLock)) {
    if (automationLock.temporaryTabId) await chrome.tabs.remove(automationLock.temporaryTabId).catch(() => {});
    await chrome.storage.local.remove('automationLock');
    const history = appendRunHistory(automationHistory, { id: automationLock.id, attemptedAt: automationLock.startedAt, status: 'attention', error: 'A previous run ended before its result was recorded; inspect Watch Later before resuming.' });
    await chrome.storage.local.set({ automationHistory: history, automationPaused: true });
    await saveAutomationStatus({ status: 'attention', pauseReason: 'A previous run ended before its result was recorded; inspect Watch Later before resuming.', lastResult: history.at(-1), lastAttemptedRun: automationLock.startedAt });
  }
  await syncAutomationSchedule();
}

async function notifyAutomation(summary, notifications) {
  if (!notifications || !chrome.notifications?.create) return;
  const requiresAttention = summary.status === 'attention' || summary.status === 'failed';
  const title = requiresAttention ? 'Watch Later automation needs attention' : summary.status === 'preview' ? 'Watch Later preview ready' : 'Watch Later automation completed';
  const message = requiresAttention ? (summary.error || 'Integrity could not be verified. No further write will be attempted.') : summary.status === 'preview' ? 'Read-only preview completed. No playlist write was requested.' : summary.alreadyOrdered ? 'The playlist was already in the configured order. No write was made.' : `Verified playlist update: ${summary.reorderedCount} move(s).`;
  try { await chrome.notifications.create(`wl-automation-${summary.id}`, { type: 'basic', iconUrl: '/icons/icon48.png', title, message, priority: requiresAttention ? 2 : 0 }); }
  catch (error) { console.warn('WL automation notification was unavailable', error); }
}

async function runScheduledAutomation(trigger = 'scheduled') {
  if (automationInFlight) return { success: false, skipped: true, error: 'An automation run is already active.' };
  automationInFlight = runAutomationExclusive(trigger);
  try { return await automationInFlight; }
  finally { automationInFlight = null; }
}

async function runAutomationExclusive(trigger) {
  await recoverAutomationState();
  const status = await getAutomationStatus();
  const previewOnly = trigger === 'preview' || !status.enabled;
  if (trigger === 'scheduled' && (status.mode !== 'scheduled' || !status.enabled)) return { success: false, skipped: true, error: 'Scheduled automation is not enabled.' };
  if (trigger === 'on-open' && status.mode !== 'on-open') return { success: false, skipped: true, error: 'On-open automation is not selected.' };
  if (!previewOnly && !status.authorized) return { success: false, skipped: true, error: 'Unattended authorization is missing or stale.' };

  const now = Date.now();
  const { automationLock, automationHistory = [] } = await chrome.storage.local.get(['automationLock', 'automationHistory']);
  if (automationLock && !lockIsStale(automationLock, now)) return { success: false, skipped: true, error: 'An automation lock is still active.' };
  const runId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  const lock = { id: runId, startedAt: now, trigger, temporaryTabId: null };
  await chrome.storage.local.set({ automationLock: lock });
  await saveAutomationStatus({ lastAttemptedRun: now, status: 'running' });
  let tabId = null;
  let temporary = false;
  let result;
  try {
    const matches = await chrome.tabs.query({ url: 'https://www.youtube.com/playlist?list=WL*' });
    const candidate = matches.find(tab => tab.id != null && tab.status === 'complete' && tab.active !== true && tab.audible !== true);
    if (candidate) tabId = candidate.id;
    else {
      const tab = await chrome.tabs.create({ url: 'https://www.youtube.com/playlist?list=WL#wl-organizer-automation', active: false });
      tabId = tab.id; temporary = true; lock.temporaryTabId = tabId;
      await chrome.storage.local.set({ automationLock: lock });
      await waitForTabComplete(tabId, 45000);
    }
    await waitForAutomationReady(tabId);
    const message = { type: 'RUN_UNATTENDED_AUTOMATION', runId, apply: !previewOnly, expectedAccountId: status.authorization?.accountId || null };
    try { result = await chrome.tabs.sendMessage(tabId, message); }
    catch (error) { throw Object.assign(new Error(`Automation result is ambiguous after dispatch: ${error.message}`), { requiresAttention: true }); }
    if (!result?.success) throw Object.assign(new Error(result?.error || 'Content script returned no result.'), { automationResult: result });
    if (result.requiresAttention) throw Object.assign(new Error(result.error || 'Playlist integrity needs attention.'), { requiresAttention: true, automationResult: result });
    if (result.accountId && status.authorization?.accountId && result.accountId !== status.authorization.accountId) throw Object.assign(new Error('The active YouTube account differs from the account authorized for unattended sorting.'), { requiresAttention: true });

    const summary = { id: runId, attemptedAt: now, status: result.applied ? 'success' : result.previewOnly ? 'preview' : result.alreadyOrdered ? 'success' : 'failed', classifiedCount: result.classifiedCount, reorderedCount: result.moveCount, alreadyOrdered: result.alreadyOrdered, pageCount: result.pageCount, completenessVerified: result.completenessVerified, error: result.error };
    const history = appendRunHistory(automationHistory, summary);
    await chrome.storage.local.set({ automationHistory: history, automationLock: null, automationFailureStreak: 0 });
    await saveAutomationStatus({ status: summary.status, lastResult: history.at(-1), ...(result.applied || (result.alreadyOrdered && !result.previewOnly) ? { lastSuccessfulRun: Date.now(), pauseReason: null } : {}) });
    await notifyAutomation(history.at(-1), status.notifications);
    if (trigger === 'scheduled') await syncAutomationSchedule();
    return { success: true, ...history.at(-1), preview: result.preview || null };
  } catch (error) {
    const failed = error.automationResult || {};
    const attention = error.requiresAttention === true || failed.requiresAttention === true || /integrity|count|account|concurrent|ambiguous/i.test(error.message);
    const summary = { id: runId, attemptedAt: now, status: attention ? 'attention' : 'failed', error: error.message, pageCount: failed.pageCount, completenessVerified: failed.completenessVerified };
    const history = appendRunHistory(automationHistory, summary);
    const { automationFailureStreak: previousStreak = 0 } = await chrome.storage.local.get('automationFailureStreak');
    const failureStreak = previousStreak + 1;
    const stopAfterRetries = failureStreak >= 5;
    const stopAutomation = attention || stopAfterRetries;
    await chrome.storage.local.set({ automationHistory: history, automationLock: null, automationFailureStreak: failureStreak, ...(stopAutomation ? { automationPaused: true } : {}) });
    await saveAutomationStatus({ status: summary.status, lastResult: history.at(-1), pauseReason: attention ? error.message : null });
    await notifyAutomation(history.at(-1), status.notifications);
    if (stopAutomation) {
      await chrome.alarms?.clear?.(AUTOMATION_ALARM);
      if (stopAfterRetries && !attention) await saveAutomationStatus({ status: 'attention', pauseReason: 'Five transient run attempts failed. Inspect the recent results before resuming.' });
    } else if (trigger === 'scheduled' && chrome.alarms?.create) {
      await chrome.alarms.clear(AUTOMATION_ALARM);
      await chrome.alarms.create(AUTOMATION_ALARM, { delayInMinutes: Math.min(60, 2 ** failureStreak) });
    }
    return { success: false, ...history.at(-1), preview: failed.preview || null };
  } finally {
    if (temporary && tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    const stored = await chrome.storage.local.get('automationLock');
    if (stored.automationLock?.id === runId) await chrome.storage.local.remove('automationLock');
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return reject(new Error('Temporary Watch Later tab was closed before loading.'));
      if (tab.status === 'complete') return resolve();
      if (Date.now() >= deadline) return reject(new Error('Watch Later did not finish loading in time.'));
      setTimeout(check, 500);
    };
    check();
  });
}

async function waitForAutomationReady(tabId) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'AUTOMATION_PING' });
      if (response?.ready === true) return;
      lastError = new Error('Content script is not ready.');
    }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (2 ** Math.min(attempt, 3)), 8000))); }
    if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Watch Later content script did not become ready: ${lastError?.message || 'unknown error'}`);
}

chrome.runtime.onInstalled?.addListener(() => { syncAutomationSchedule().catch(() => {}); });
chrome.runtime.onStartup?.addListener(() => { recoverAutomationState().catch(() => {}); });
chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm.name === AUTOMATION_ALARM) runScheduledAutomation('scheduled').catch(() => {});
});
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'sync' && (changes.settings || changes.apiKey)) syncAutomationSchedule().catch(() => {});
});

// The toolbar icon is per-tab: it turns red on tabs whose content script has
// announced itself (YT_PAGE) and stays gray everywhere else, so no `tabs`
// permission is needed to watch navigation.
const ICON_ACTIVE = { 16: '/icons/active/icon16.png', 48: '/icons/active/icon48.png', 128: '/icons/active/icon128.png' };
const ICON_DEFAULT = { 16: '/icons/icon16.png', 48: '/icons/icon48.png', 128: '/icons/icon128.png' };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE') {
    handleAnalyze(message.videos, message.playlistId, message.sortOptions, message.manualPreview !== false).then(sendResponse);
    return true;
  }

  if (message.type === 'RESORT') {
    handleResort(message).then(sendResponse);
    return true;
  }

  if (message.type === 'SET_CLASSIFICATION_OVERRIDE') {
    handleClassificationOverride(message).then(sendResponse);
    return true;
  }

  if (message.type === 'CLASSIFICATION_FEEDBACK') { handleClassificationFeedback(message).then(sendResponse); return true; }
  if (message.type === 'RECORD_SORTING_CHOICE') { recordExplicitSortingChoice(message).then(sendResponse); return true; }
  if (message.type === 'GET_LEARNED_PREFERENCES') { getLearnedPreferences().then(sendResponse); return true; }
  if (message.type === 'REVIEW_LEARNED_SUGGESTION') { handleReviewSuggestion(message).then(sendResponse); return true; }
  if (message.type === 'TOGGLE_LEARNED_RULE') { toggleLearnedRule(message.ruleId).then(sendResponse); return true; }
  if (message.type === 'EDIT_LEARNED_RULE') { editLearnedRule(message.ruleId, message.edited).then(sendResponse); return true; }
  if (message.type === 'CLEAR_LEARNED_EXAMPLE') { clearLearnedExample(message.videoId, message.clearOverride === true).then(sendResponse); return true; }
  if (message.type === 'RESET_LEARNED_PREFERENCES') { resetLearning().then(sendResponse); return true; }
  if (message.type === 'EXPORT_LEARNED_PREFERENCES') { exportLearned().then(sendResponse); return true; }
  if (message.type === 'IMPORT_LEARNED_PREFERENCES') { importLearned(message.text).then(sendResponse); return true; }

  // Name predates the title and channel sorts; `by` selects among the three.
  if (message.type === 'SORT_BY_DURATION') {
    try {
      sendResponse({ success: true, sortOrder: buildSimpleSortOrder(message.videos, message.by ?? 'duration') });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }

  if (message.type === 'GET_SORT_STATE') {
    chrome.storage.local.get('sortState', (data) => sendResponse(data.sortState || null));
    return true;
  }

  if (message.type === 'AUTO_PREVIEW_STATUS') {
    getAutomationStatus().then(status => sendResponse({ enabled: status.mode === 'on-open', onOpenMode: status.mode === 'on-open', autoOrganize: status.mode === 'on-open' && status.enabled, manualDryRunCompleted: status.authorized, autoPreviewAllowed: true }));
    return true;
  }

  if (message.type === 'GET_AUTOMATION_STATUS') { getAutomationStatus().then(sendResponse); return true; }
  if (message.type === 'GET_AUTOMATION_PERMIT') { getAutomationPermit().then(sendResponse); return true; }
  if (message.type === 'ENABLE_UNATTENDED_SORTING') { enableUnattendedSorting(message).then(sendResponse); return true; }
  if (message.type === 'DISABLE_UNATTENDED_SORTING') { disableUnattendedSorting('disabled').then(sendResponse); return true; }
  if (message.type === 'PAUSE_AUTOMATION') { pauseAutomation().then(sendResponse); return true; }
  if (message.type === 'RESUME_AUTOMATION') { resumeAutomation().then(sendResponse); return true; }
  if (message.type === 'RUN_AUTOMATION_NOW') { runScheduledAutomation(message.previewOnly ? 'preview' : 'manual').then(sendResponse); return true; }
  if (message.type === 'AUTOMATION_ON_OPEN') { runScheduledAutomation('on-open').then(sendResponse); return true; }
  if (message.type === 'RECORD_MANUAL_ACCEPTANCE') { recordManualAcceptance(message, sender).then(sendResponse); return true; }

  if (message.type === 'YT_PAGE' || message.type === 'YT_LEAVE') {
    const tabId = sender?.tab?.id;
    const path = message.type === 'YT_PAGE' ? ICON_ACTIVE : ICON_DEFAULT;
    if (tabId !== undefined) chrome.action.setIcon({ tabId, path }).catch(() => {});
    return false;
  }

  if (message.type === 'LIST_MODELS') {
    handleListModels(message.settings).then(sendResponse);
    return true;
  }
});

async function handleAnalyze(videos, playlistId, rawSortOptions, manualPreview = true) {
  try {
    const settings = await loadSettings();
    const sortOptions = normalizeSortOptions({ ...settings.sort, ...(rawSortOptions || {}), subjectSorts: settings.sort.subjectSorts });
    const provider = getProvider(settings.provider);
    const { unwatchedOverrides = [], classificationCache = {}, classificationOverrides = {}, learningState: rawLearning } = await chrome.storage.local.get(['unwatchedOverrides', 'classificationCache', 'classificationOverrides', 'learningState']);
    const learningState = createLearningState(rawLearning);
    const configuration = JSON.stringify({ method: settings.classificationMethod, provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, maxNewCategories: settings.maxNewCategories, subjects: settings.subjects, taxonomy: settings.taxonomy, fallbackSubjectId: settings.fallbackSubjectId, extraInstructions: settings.extraInstructions, rules: learningState.rules.filter(r => r.enabled).map(r => [r.id, r.phrase, r.subjectId, r.field, r.weight]), version: LOCAL_CLASSIFIER_VERSION });
    const cacheKey = video => JSON.stringify([video.id, video.title, video.channel, video.category, video.description, configuration]);
    for (const key of Object.keys(classificationCache)) {
      try { if (JSON.parse(key)[5] !== configuration) delete classificationCache[key]; }
      catch { delete classificationCache[key]; }
    }
    const fallbackGroup = settings.subjects.find(s => s.id === settings.fallbackSubjectId)?.name || 'Other';
    const classifiable = videos.filter(v => !v.unavailable);
    const confirmedLabels = new Map(learningState.examples.filter(example => example.confirmed && !example.corrected && settings.subjects.some(subject => subject.id === example.subjectId)).map(example => [example.videoId, example.subjectId]));
    const uncached = classifiable.filter(v => !classificationCache[cacheKey(v)] && !confirmedLabels.has(v.id));
    const localFirst = settings.classificationMethod === 'local-rules' || settings.classificationMethod === 'hybrid';
    const localResults = new Map();
    if (localFirst) for (const video of uncached) localResults.set(video.id, classifyLocally(video, settings.subjects, { fallbackSubjectId: settings.fallbackSubjectId, overrides: classificationOverrides, approvedRules: learningState.rules }));
    const cloudSelected = settings.classificationMethod === 'cloud-ai' || settings.classificationMethod === 'hybrid';
    const localAI = settings.classificationMethod === 'local-ai';
    if (localAI && settings.provider !== 'ollama') return { success: false, error: 'Local AI requires the Ollama provider. No cloud fallback was attempted.' };
    const videosForAI = localFirst ? uncached.filter(v => settings.classificationMethod === 'hybrid' && localResults.get(v.id)?.uncertain) : uncached;
    if (videosForAI.length && (cloudSelected || localAI) && provider.needsKey && !settings.apiKey) {
      return { success: false, error: "No API key configured. Open the extension's settings." };
    }
    let clusters = { clusters: [] };
    if (videosForAI.length) clusters = await categorizeVideos(settings, videosForAI);
    const assignments = new Map();
    for (const cluster of clusters.clusters || []) for (const id of cluster.videoIds) assignments.set(id, cluster.name);
    for (const video of classifiable) {
      const override = classificationOverrides[video.id];
      const confirmedSubject = settings.subjects.find(subject => subject.id === confirmedLabels.get(video.id));
      const cached = classificationCache[cacheKey(video)];
      const localResult = localResults.get(video.id);
      const rawCategory = confirmedSubject?.name || (typeof cached === 'object' ? cached.name : cached) || assignments.get(video.id) || (localResult && !videosForAI.includes(video) ? localResult.name : null);
      const overrideSubject = settings.subjects.find(s => s.id === override);
      const category = overrideSubject?.name || (settings.subjects.length
        ? settings.taxonomy.find(name => name.toLocaleLowerCase() === String(rawCategory || '').toLocaleLowerCase()) || fallbackGroup
        : rawCategory || fallbackGroup);
      if (category && !overrideSubject) {
        const source = confirmedSubject ? 'user-confirmed' : localResult && !videosForAI.includes(video) ? localResult.source : (typeof cached === 'object' ? cached.source : (localFirst ? (settings.classificationMethod === 'hybrid' ? 'hybrid-local' : 'local-rules') : localAI ? 'ollama' : 'cloud-ai'));
        const evidence = confirmedSubject ? [{ field: 'user-confirmed', phrase: confirmedSubject.name }] : (localResult?.evidence || cached?.evidence || []);
        const uncertain = confirmedSubject ? false : localResult?.uncertain ?? cached?.uncertain ?? false;
        classificationCache[cacheKey(video)] = { name: category, source, evidence, uncertain, metadata: [video.title, video.channel, video.category, video.description], config: configuration, touchedAt: Date.now() };
        // Reinsert touched entries at the end, then evict oldest cache entries.
        const key = cacheKey(video); const value = classificationCache[key]; delete classificationCache[key]; classificationCache[key] = value;
      }
    }
    const byCategory = new Map();
    const autoAssignments = {};
    for (const video of classifiable) {
      const cached = classificationCache[cacheKey(video)];
      const autoName = typeof cached === 'object' ? cached.name : cached;
      if (autoName) autoAssignments[video.id] = autoName;
      const overrideSubject = settings.subjects.find(s => s.id === classificationOverrides[video.id]);
      const name = overrideSubject?.name || autoName;
      if (!name) continue;
      if (!byCategory.has(name)) byCategory.set(name, []);
      byCategory.get(name).push(video.id);
    }
    clusters = { clusters: [...byCategory].map(([name, videoIds]) => ({ name, videoIds })) };
    while (Object.keys(classificationCache).length > 2000) delete classificationCache[Object.keys(classificationCache)[0]];
    const sortOrder = buildSortOrder(videos, clusters, unwatchedOverrides, settings.taxonomy, { ...sortOptions, fallbackGroup });
    const classificationRecords = {};
    for (const video of sortOrder) {
      video.manualOverride = Boolean(classificationOverrides[video.id]);
      const record = classificationCache[cacheKey(video)];
      const classification = { evidence: typeof record === 'object' ? record.evidence || [] : [], source: typeof record === 'object' ? record.source || 'cached' : 'cached-ai', uncertain: typeof record === 'object' ? Boolean(record.uncertain) : false, confirmed: learningState.examples.some(x => x.videoId === video.id && x.confirmed) };
      classificationRecords[video.id] = classification;
      video.classificationEvidence = classification.evidence;
      video.classificationSource = classification.source;
      video.classificationUncertain = classification.uncertain;
      video.classificationConfirmed = classification.confirmed;
    }

    learningState.observedVideos = classifiable.map(video => ({ videoId: video.id, title: String(video.title || ''), channel: String(video.channel || '') })).slice(-2000);
    await chrome.storage.local.set({
      classificationCache,
      classificationOverrides,
      learningState: generateRuleSuggestions(learningState, settings.learning),
      cachedClusters: { playlistId, clusters, autoAssignments, classificationRecords, videos, sortOptions },
      sortState: { videos, clusters, sortOrder, sortOptions, timestamp: Date.now() },
    });
    if (manualPreview) await chrome.storage.local.set({ manualDryRunCompleted: { playlistId, completedAt: Date.now(), config: dryRunConfig(settings, learningState) } });

    return { success: true, sortOrder, sortOptions, subjects: settings.subjects, method: settings.classificationMethod, classifiedCount: uncached.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function dryRunConfig(settings, learningState = {}) {
  return JSON.stringify({ method: settings.classificationMethod, subjects: settings.subjects, taxonomy: settings.taxonomy, fallbackSubjectId: settings.fallbackSubjectId, extraInstructions: settings.extraInstructions, approvedRules: (learningState?.rules || []).filter(rule => rule.enabled).map(rule => [rule.id, rule.phrase, rule.subjectId, rule.field, rule.weight]), sort: settings.sort, version: 2 });
}

async function handleClassificationOverride({ videoId, subjectId, playlistId }) {
  try {
    const { cachedClusters, classificationOverrides = {} } = await chrome.storage.local.get(['cachedClusters', 'classificationOverrides']);
    if (!cachedClusters || cachedClusters.playlistId !== playlistId) throw new Error('No matching cached analysis. Run Analyze first.');
    const settings = await loadSettings();
    if (!cachedClusters.videos.some(v => v.id === videoId)) throw new Error('This video is not in the current playlist preview.');
    if (subjectId && !settings.subjects.some(s => s.id === subjectId)) throw new Error('Choose a subject that is currently selected.');
    const videoForLearning = cachedClusters.videos.find(v => v.id === videoId);
    const originalName = cachedClusters.autoAssignments?.[videoId];
    const originalSubjectId = settings.subjects.find(s => s.name === originalName)?.id || null;
    if (subjectId) classificationOverrides[videoId] = subjectId;
    else delete classificationOverrides[videoId];
    const { learningState: rawLearning } = await chrome.storage.local.get('learningState');
    let learningState = createLearningState(rawLearning);
    if (subjectId && videoForLearning) {
      learningState = recordClassificationFeedback(learningState, videoForLearning, { originalSubjectId, correctedSubjectId: subjectId, confirmed: true }, { ruleVersion: LOCAL_CLASSIFIER_VERSION });
      learningState = generateRuleSuggestions(learningState, settings.learning);
      const record = cachedClusters.classificationRecords?.[videoId] || { evidence: [], source: 'manual-override', uncertain: false };
      cachedClusters.classificationRecords = { ...(cachedClusters.classificationRecords || {}), [videoId]: { ...record, confirmed: true } };
    }
    await chrome.storage.local.set({ classificationOverrides, learningState });
    const { unwatchedOverrides = [] } = await chrome.storage.local.get('unwatchedOverrides');
    const clustersByName = new Map();
    for (const video of cachedClusters.videos.filter(v => !v.unavailable)) {
      const override = settings.subjects.find(s => s.id === classificationOverrides[video.id]);
      const name = override?.name || cachedClusters.autoAssignments?.[video.id] || settings.subjects.find(s => s.id === settings.fallbackSubjectId)?.name || 'Other';
      if (!clustersByName.has(name)) clustersByName.set(name, []);
      clustersByName.get(name).push(video.id);
    }
    const clusters = [...clustersByName].map(([name, videoIds]) => ({ name, videoIds }));
    const sortOptions = normalizeSortOptions(cachedClusters.sortOptions ?? settings.sort);
    const sortOrder = buildSortOrder(cachedClusters.videos, { clusters }, unwatchedOverrides, settings.taxonomy, { ...sortOptions, fallbackGroup: settings.subjects.find(s => s.id === settings.fallbackSubjectId)?.name });
    for (const video of sortOrder) {
      video.manualOverride = Boolean(classificationOverrides[video.id]);
      Object.assign(video, { classificationEvidence: cachedClusters.classificationRecords?.[video.id]?.evidence || [], classificationSource: cachedClusters.classificationRecords?.[video.id]?.source || 'cached', classificationUncertain: Boolean(cachedClusters.classificationRecords?.[video.id]?.uncertain) });
      video.classificationConfirmed = Boolean(cachedClusters.classificationRecords?.[video.id]?.confirmed);
    }
    cachedClusters.clusters = clusters;
    await chrome.storage.local.set({ cachedClusters, sortState: { videos: cachedClusters.videos, clusters, sortOrder, sortOptions, timestamp: Date.now() } });
    return { success: true, sortOrder };
  } catch (err) { return { success: false, error: err.message }; }
}

async function handleClassificationFeedback({ videoId, confirmed = false, uncertain = false, explanation = '' }) {
  try {
    const { cachedClusters, learningState: rawLearning, classificationOverrides = {} } = await chrome.storage.local.get(['cachedClusters', 'learningState', 'classificationOverrides']);
    const video = cachedClusters?.videos?.find(v => v.id === videoId);
    if (!video) throw new Error('Run Analyze before saving feedback for this video.');
    const settings = await loadSettings();
    const name = cachedClusters.autoAssignments?.[videoId];
    const originalSubjectId = settings.subjects.find(s => s.name === name)?.id || null;
    let learningState = recordClassificationFeedback(createLearningState(rawLearning), video, { originalSubjectId, correctedSubjectId: classificationOverrides[videoId] || null, confirmed, uncertain, explanation }, { ruleVersion: LOCAL_CLASSIFIER_VERSION });
    learningState = generateRuleSuggestions(learningState, settings.learning);
    cachedClusters.classificationRecords = { ...(cachedClusters.classificationRecords || {}), [videoId]: { ...(cachedClusters.classificationRecords?.[videoId] || {}), confirmed: Boolean(confirmed), uncertain: Boolean(uncertain) } };
    const { sortState } = await chrome.storage.local.get('sortState');
    if (sortState?.sortOrder) for (const item of sortState.sortOrder) if (item.id === videoId) { item.classificationConfirmed = Boolean(confirmed); item.classificationUncertain = Boolean(uncertain); }
    await chrome.storage.local.set({ learningState, cachedClusters, ...(sortState ? { sortState } : {}) });
    return { success: true, learningState };
  } catch (err) { return { success: false, error: err.message }; }
}

async function getLearnedPreferences() {
  const { learningState, classificationOverrides = {} } = await chrome.storage.local.get(['learningState', 'classificationOverrides']);
  const state = createLearningState(learningState);
  return { success: true, state, stats: { confirmed: state.examples.filter(x => x.confirmed).length, overrides: Object.keys(classificationOverrides).length, accepted: state.rules.length + state.sortingPreferences.length, pending: state.suggestions.length, rejected: state.rejected.length } };
}

async function handleReviewSuggestion({ suggestionId, action, edited }) {
  try {
    const { learningState } = await chrome.storage.local.get('learningState');
    const current = createLearningState(learningState);
    const suggestion = current.suggestions.find(s => s.id === suggestionId);
    const next = reviewSuggestion(current, suggestionId, action, edited);
    if (action === 'accept' && suggestion?.type === 'sorting') {
      const settings = await loadSettings();
      const slot = suggestion.slot === 'secondaryWithinGroup' ? 'secondaryWithinGroup' : 'withinGroup';
      let previousValue;
      const sort = suggestion.group === '*'
        ? (previousValue = settings.sort[slot], { ...settings.sort, [slot]: suggestion.field })
        : (previousValue = settings.sort.subjectSorts?.[suggestion.group]?.[slot] || null, { ...settings.sort, subjectSorts: { ...(settings.sort.subjectSorts || {}), [suggestion.group]: { ...(settings.sort.subjectSorts?.[suggestion.group] || {}), [slot]: suggestion.field } } });
      await saveSettings({ sort });
      const accepted = next.sortingPreferences.find(rule => rule.id === suggestion.id);
      if (accepted) accepted.previousValue = previousValue;
    }
    await chrome.storage.local.set({ learningState: next });
    return { success: true, state: next };
  } catch (err) { return { success: false, error: err.message }; }
}

async function recordExplicitSortingChoice({ field, group = '*', slot = 'withinGroup' }) {
  const { learningState: raw } = await chrome.storage.local.get('learningState');
  const result = recordSortingChoice(createLearningState(raw), { field, group, slot, explicit: true }, { minimumEvidence: 3 });
  await chrome.storage.local.set({ learningState: result.state });
  return { success: true, suggestion: result.suggestion };
}

async function toggleLearnedRule(ruleId) {
  const { learningState: raw } = await chrome.storage.local.get('learningState');
  const learningState = createLearningState(raw);
  const rule = [...learningState.rules, ...learningState.sortingPreferences].find(r => r.id === ruleId);
  if (!rule) return { success: false, error: 'Learned rule not found.' };
  rule.enabled = !rule.enabled;
  if (rule.type === 'sorting' || learningState.sortingPreferences.includes(rule)) {
    const settings = await loadSettings();
    const slot = rule.slot === 'secondaryWithinGroup' ? 'secondaryWithinGroup' : 'withinGroup';
    let sort = settings.sort;
    if (rule.group === '*') sort = { ...sort, [slot]: rule.enabled ? rule.field : (rule.previousValue || (slot === 'withinGroup' ? 'duration-asc' : 'playlist')) };
    else {
      const subjectSorts = { ...(sort.subjectSorts || {}) };
      const subject = { ...(subjectSorts[rule.group] || {}) };
      if (rule.enabled) subject[slot] = rule.field;
      else if (rule.previousValue) subject[slot] = rule.previousValue;
      else delete subject[slot];
      if (Object.keys(subject).length) subjectSorts[rule.group] = subject; else delete subjectSorts[rule.group];
      sort = { ...sort, subjectSorts };
    }
    await saveSettings({ sort });
  }
  await chrome.storage.local.set({ learningState });
  // Derived classifications based on learned rules are invalid after toggles.
  await chrome.storage.local.remove?.('classificationCache');
  return { success: true, enabled: rule.enabled };
}

async function editLearnedRule(ruleId, edited = {}) {
  const { learningState: raw } = await chrome.storage.local.get('learningState');
  const learningState = createLearningState(raw);
  const rule = learningState.rules.find(candidate => candidate.id === ruleId);
  if (!rule) return { success: false, error: 'Learned rule not found.' };
  const settings = await loadSettings();
  if (edited.subjectId && !settings.subjects.some(subject => subject.id === edited.subjectId)) return { success: false, error: 'Choose a currently selected subject.' };
  if (edited.phrase !== undefined) rule.phrase = String(edited.phrase).trim();
  if (edited.subjectId) rule.subjectId = edited.subjectId;
  if (!rule.phrase) return { success: false, error: 'A learned rule phrase cannot be empty.' };
  await chrome.storage.local.set({ learningState });
  await chrome.storage.local.remove?.('classificationCache');
  return { success: true };
}

async function clearLearnedExample(videoId, clearOverride = false) {
  const { learningState: raw, classificationOverrides = {} } = await chrome.storage.local.get(['learningState', 'classificationOverrides']);
  const learningState = createLearningState(raw);
  learningState.examples = learningState.examples.filter(example => example.videoId !== videoId);
  if (clearOverride) delete classificationOverrides[videoId];
  await chrome.storage.local.set({ learningState, ...(clearOverride ? { classificationOverrides } : {}) });
  return { success: true };
}

async function resetLearning() {
  const { learningState: rawLearning } = await chrome.storage.local.get('learningState');
  const learningState = createLearningState(rawLearning);
  const settings = await loadSettings();
  let sort = settings.sort;
  for (const rule of learningState.sortingPreferences) {
    if (!rule.enabled) continue;
    const slot = rule.slot === 'secondaryWithinGroup' ? 'secondaryWithinGroup' : 'withinGroup';
    if (rule.group === '*') {
      if (sort[slot] === rule.field) sort = { ...sort, [slot]: rule.previousValue || (slot === 'withinGroup' ? 'duration-asc' : 'playlist') };
    } else if (sort.subjectSorts?.[rule.group]?.[slot] === rule.field) {
      const subjectSorts = { ...sort.subjectSorts };
      const subject = { ...subjectSorts[rule.group] };
      if (rule.previousValue) subject[slot] = rule.previousValue; else delete subject[slot];
      if (Object.keys(subject).length) subjectSorts[rule.group] = subject; else delete subjectSorts[rule.group];
      sort = { ...sort, subjectSorts };
    }
  }
  if (JSON.stringify(sort) !== JSON.stringify(settings.sort)) await saveSettings({ sort });
  await chrome.storage.local.set({ learningState: resetLearnedPreferences(learningState) });
  await chrome.storage.local.remove?.('classificationCache');
  return { success: true };
}

async function exportLearned() {
  const { learningState } = await chrome.storage.local.get('learningState');
  return { success: true, text: exportLearningPreferences(learningState) };
}

async function importLearned(text) {
  try {
    const learningState = importLearningPreferences(text);
    const settings = await loadSettings();
    let sort = settings.sort;
    for (const rule of learningState.sortingPreferences) {
      if (!rule.enabled) continue;
      const slot = rule.slot === 'secondaryWithinGroup' ? 'secondaryWithinGroup' : 'withinGroup';
      if (rule.group === '*') sort = { ...sort, [slot]: rule.field };
      else sort = { ...sort, subjectSorts: { ...(sort.subjectSorts || {}), [rule.group]: { ...(sort.subjectSorts?.[rule.group] || {}), [slot]: rule.field } } };
    }
    if (JSON.stringify(sort) !== JSON.stringify(settings.sort)) await saveSettings({ sort });
    await chrome.storage.local.set({ learningState });
    await chrome.storage.local.remove?.('classificationCache');
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
}

/**
 * Re-sort using cached clusters. Never calls the model — neither watch state
 * nor the sort options change grouping. `overrides` and `sortOptions` are each
 * optional: a message that omits one keeps the stored overrides / falls back to
 * the saved settings, so the "treat as unwatched" toggle and the sort-option
 * selects can each send only what they changed.
 */
async function handleResort({ overrides, sortOptions: rawSortOptions, playlistId }) {
  try {
    const { cachedClusters, learningState: rawLearning } = await chrome.storage.local.get(['cachedClusters', 'learningState']);
    if (!cachedClusters) {
      return { success: false, error: 'No cached analysis. Run Analyze first.' };
    }
    if (cachedClusters.playlistId !== playlistId) {
      return { success: false, error: 'Cached analysis belongs to a different playlist. Run Analyze again.' };
    }

    const settings = await loadSettings();
    const sortOptions = normalizeSortOptions({ ...settings.sort, ...(rawSortOptions || {}), subjectSorts: settings.sort.subjectSorts });
    const localOverrides = await chrome.storage.local.get(['unwatchedOverrides', 'classificationOverrides']);
    const classificationOverrides = localOverrides.classificationOverrides || {};
    if (overrides === undefined) {
      overrides = localOverrides.unwatchedOverrides || [];
    } else {
      await chrome.storage.local.set({ unwatchedOverrides: overrides });
    }
    const fallbackGroup = settings.subjects.find(s => s.id === settings.fallbackSubjectId)?.name;
    const sortOrder = buildSortOrder(cachedClusters.videos, cachedClusters.clusters, overrides, settings.taxonomy, { ...sortOptions, fallbackGroup });
    for (const video of sortOrder) {
      video.manualOverride = Boolean(classificationOverrides[video.id]);
      Object.assign(video, { classificationEvidence: cachedClusters.classificationRecords?.[video.id]?.evidence || [], classificationSource: cachedClusters.classificationRecords?.[video.id]?.source || 'cached', classificationUncertain: Boolean(cachedClusters.classificationRecords?.[video.id]?.uncertain) });
      video.classificationConfirmed = createLearningState(rawLearning).examples.some(example => example.videoId === video.id && example.confirmed);
    }

    await chrome.storage.local.set({
      sortState: { videos: cachedClusters.videos, clusters: cachedClusters.clusters, sortOrder, sortOptions, timestamp: Date.now() },
    });

    return { success: true, sortOrder, sortOptions };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Uses the settings the popup sends, not the saved ones, so a key can be tried before saving. */
async function handleListModels(rawSettings) {
  try {
    const models = await listModels(normalizeSettings(rawSettings));
    return { success: true, models };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
