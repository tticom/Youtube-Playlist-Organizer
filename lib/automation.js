export const AUTOMATION_ALARM = 'wl-unattended-sort';
export const DEFAULT_SCHEDULE_MINUTES = 360;
export const MIN_SCHEDULE_MINUTES = 60;
export const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;
export const RUN_LOCK_TTL_MS = 45 * 60 * 1000;

export function normalizeAutomation(raw = {}) {
  const minutes = Number(raw.scheduleMinutes);
  return {
    mode: ['manual', 'on-open', 'scheduled'].includes(raw.mode) ? raw.mode : 'manual',
    scheduleMinutes: Number.isFinite(minutes)
      ? Math.max(MIN_SCHEDULE_MINUTES, Math.min(MAX_SCHEDULE_MINUTES, Math.floor(minutes)))
      : DEFAULT_SCHEDULE_MINUTES,
    notifications: raw.notifications === true,
  };
}

export function automationFingerprint(settings, learningState = {}) {
  return JSON.stringify({
    playlistId: 'WL', method: settings.classificationMethod, provider: settings.provider,
    baseUrl: settings.baseUrl, model: settings.model, maxNewCategories: settings.maxNewCategories,
    subjects: settings.subjects, taxonomy: settings.taxonomy,
    fallbackSubjectId: settings.fallbackSubjectId, extraInstructions: settings.extraInstructions,
    sort: settings.sort,
    approvedRules: (learningState.rules || []).filter(rule => rule.enabled).map(rule => [rule.id, rule.phrase, rule.subjectId, rule.field, rule.weight]),
    approvedSorts: (learningState.sortingPreferences || []).filter(rule => rule.enabled).map(rule => [rule.id, rule.group, rule.field, rule.slot]),
  });
}

export function lockIsStale(lock, now = Date.now()) {
  return !lock || !Number.isFinite(lock.startedAt) || lock.startedAt > now + 5 * 60 * 1000 || now - lock.startedAt > RUN_LOCK_TTL_MS;
}

export function sanitizeAutomationError(error) {
  return String(error || '')
    .replace(/SAPISIDHASH\s+[^\s"']+/gi, 'SAPISIDHASH [redacted]')
    .replace(/((?:SAPISID|__Secure-[^=\s;]+)=)[^\s;"']+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;"']+/gi, '$1[redacted]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}

export function summarizeRun(result, now = Date.now()) {
  return {
    id: String(result.id || `${now}`), attemptedAt: Number(result.attemptedAt) || now,
    completedAt: now, status: result.status || 'failed', error: result.error ? sanitizeAutomationError(result.error) : null,
    classifiedCount: Math.max(0, Number(result.classifiedCount) || 0),
    reorderedCount: Math.max(0, Number(result.reorderedCount) || 0),
    alreadyOrdered: result.alreadyOrdered === true,
    pageCount: Math.max(0, Number(result.pageCount) || 0),
    completenessVerified: result.completenessVerified === true,
  };
}

export function appendRunHistory(history, result, limit = 30) {
  return [...(Array.isArray(history) ? history : []), summarizeRun(result)].slice(-limit);
}
