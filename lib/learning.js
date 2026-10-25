const words = value => (String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).filter(w => !new Set(['this', 'that', 'with', 'from', 'your', 'what', 'when', 'video', 'explained', 'about']).has(w));
const idFor = (field, phrase, subjectId) => `suggestion:${field}:${subjectId}:${encodeURIComponent(phrase).replaceAll('%', '_')}`;
const SORT_FIELDS = new Set(['playlist', 'duration-asc', 'duration-desc', 'title', 'title-desc']);

function boundedText(value, max = 2000) { return String(value ?? '').slice(0, max); }
function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || !rule.id || !rule.subjectId || !rule.phrase) return null;
  const rawWeight = Number(rule.weight);
  return { ...rule, id: boundedText(rule.id, 300), subjectId: boundedText(rule.subjectId, 300), phrase: boundedText(rule.phrase, 150), field: ['title', 'description', 'channel', 'category', 'topic', 'channel+title'].includes(rule.field) ? rule.field : 'title', weight: Number.isFinite(rawWeight) ? Math.max(-10, Math.min(10, rawWeight)) : 7, enabled: rule.enabled !== false };
}
function normalizeExample(example) {
  if (!example || typeof example !== 'object' || !example.videoId) return null;
  return { ...example, videoId: boundedText(example.videoId, 300), title: boundedText(example.title, 1000), channel: boundedText(example.channel, 500), description: boundedText(example.description, 500), category: boundedText(example.category, 200), subjectId: boundedText(example.subjectId, 300), originalSubjectId: boundedText(example.originalSubjectId, 300), explanation: boundedText(example.explanation, 1000), confirmed: example.confirmed === true, corrected: example.corrected === true, uncertain: example.uncertain === true, topicIds: Array.isArray(example.topicIds) ? example.topicIds.slice(0, 50).map(x => boundedText(x, 200)) : [] };
}

export function createLearningState(raw = {}) {
  return {
    examples: Array.isArray(raw.examples) ? raw.examples.slice(-5000).map(normalizeExample).filter(Boolean) : [],
    observedVideos: Array.isArray(raw.observedVideos) ? raw.observedVideos.slice(-2000).filter(v => v && v.videoId).map(v => ({ videoId: boundedText(v.videoId, 300), title: boundedText(v.title, 1000), channel: boundedText(v.channel, 500) })) : [],
    rules: Array.isArray(raw.rules) ? raw.rules.slice(-1000).map(normalizeRule).filter(Boolean) : [],
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.slice(-1000).filter(s => s && s.id && s.status === 'pending' && (s.type === 'sorting' ? SORT_FIELDS.has(s.field) : Boolean(s.subjectId && s.phrase))).map(s => ({ ...s, id: boundedText(s.id, 300), phrase: boundedText(s.phrase, 150), subjectId: boundedText(s.subjectId, 300), field: s.type === 'sorting' ? s.field : (s.field === 'title' ? 'title' : 'title'), support: Math.max(0, Number(s.support) || 0), conflicts: Math.max(0, Number(s.conflicts) || 0) })) : [],
    rejected: Array.isArray(raw.rejected) ? raw.rejected.slice(-5000).filter(s => s && s.id).map(s => ({ ...s, id: boundedText(s.id, 300) })) : [],
    sortingChoices: Array.isArray(raw.sortingChoices) ? raw.sortingChoices.slice(-500).filter(x => x && SORT_FIELDS.has(x.field)).map(x => ({ group: boundedText(x.group, 300), field: x.field, slot: x.slot === 'secondaryWithinGroup' ? x.slot : 'withinGroup', direction: x.direction === 'desc' ? 'desc' : 'asc', explicit: x.explicit === true, at: Number(x.at) || 0 })) : [],
    sortingPreferences: Array.isArray(raw.sortingPreferences) ? raw.sortingPreferences.filter(s => s && SORT_FIELDS.has(s.field)).map(s => ({ ...s, id: boundedText(s.id, 300), group: boundedText(s.group, 300), enabled: s.enabled !== false })) : [],
  };
}

export function recordClassificationFeedback(state, video, { originalSubjectId = null, correctedSubjectId = null, confirmed = false, uncertain = false, explanation = '' } = {}, { ruleVersion = 1 } = {}) {
  const next = createLearningState(state);
  const idx = next.examples.findIndex(x => x.videoId === video.id);
  const example = { videoId: String(video.id), title: String(video.title || ''), channel: String(video.channel || ''), description: String(video.description || ''), category: String(video.category || ''), topicIds: video.topicIds || [], originalSubjectId, subjectId: correctedSubjectId || originalSubjectId, corrected: Boolean(correctedSubjectId && correctedSubjectId !== originalSubjectId), confirmed: Boolean(confirmed), uncertain: Boolean(uncertain), explanation: String(explanation || ''), ruleVersion, updatedAt: Date.now() };
  if (idx >= 0) next.examples[idx] = example; else next.examples.push(example);
  return next;
}

export function generateRuleSuggestions(state, { minimumEvidence = 4, minimumConsistency = 0.8 } = {}) {
  const next = createLearningState(state);
  next.suggestions = next.suggestions.filter(s => !s.dismissedUntil || s.dismissedUntil > Date.now());
  const examples = next.examples.filter(e => e.confirmed && e.subjectId);
  const candidates = new Map();
  for (const example of examples) {
    if (!example.corrected) continue;
    const titleWords = words(example.title);
    const phrases = new Set(titleWords);
    for (let size = 2; size <= 3; size++) {
      for (let start = 0; start + size <= titleWords.length; start++) phrases.add(titleWords.slice(start, start + size).join(' '));
    }
    for (const phrase of phrases) {
      const key = `title:${phrase}:${example.subjectId}`;
      if (!candidates.has(key)) candidates.set(key, { field: 'title', phrase, subjectId: example.subjectId });
    }
  }
  const existing = new Set([...next.suggestions, ...next.rejected].map(s => s.id));
  for (const candidate of candidates.values()) {
    const relevant = examples.filter(e => (` ${words(e.title).join(' ')} `).includes(` ${candidate.phrase} `));
    const supporting = relevant.filter(e => e.subjectId === candidate.subjectId);
    const conflicting = relevant.filter(e => e.subjectId !== candidate.subjectId);
    const observedOthers = next.observedVideos.filter(v => v.videoId && !supporting.some(e => e.videoId === v.videoId) && (` ${words(v.title).join(' ')} `).includes(` ${candidate.phrase} `));
    const consistency = supporting.length / Math.max(1, relevant.length);
    const id = idFor(candidate.field, candidate.phrase, candidate.subjectId);
    if (supporting.length < minimumEvidence || consistency < minimumConsistency || existing.has(id)) continue;
    // Broad channel-only suggestions are intentionally excluded. A phrase in
    // titles is reviewable, narrower evidence and avoids assigning a whole channel.
    next.suggestions.push({ id, ...candidate, support: supporting.length, conflicts: conflicting.length, consistency, affectedConfirmed: relevant.length, affectedObserved: observedOthers.length, evidenceVideoIds: supporting.map(e => e.videoId), status: 'pending', createdAt: Date.now(), explanation: `${supporting.length} confirmed corrections contain “${candidate.phrase}”; ${conflicting.length} confirmed examples with the phrase use another subject. The phrase also appears on ${observedOthers.length} other videos in the most recent analyzed playlist.` });
  }
  return next;
}

export function reviewSuggestion(state, suggestionId, action, edited = {}) {
  const next = createLearningState(state);
  const at = next.suggestions.findIndex(s => s.id === suggestionId);
  if (at < 0) throw new Error('Suggestion not found.');
  const suggestion = next.suggestions[at];
  next.suggestions.splice(at, 1);
  if (action === 'accept' && suggestion.type === 'sorting') next.sortingPreferences.push({ ...suggestion, ...edited, enabled: true, approvedAt: Date.now() });
  else if (action === 'accept') next.rules.push({ ...suggestion, ...edited, enabled: true, approvedAt: Date.now(), weight: 7 });
  else if (action === 'reject') next.rejected.push({ ...suggestion, status: 'rejected', rejectedAt: Date.now() });
  else if (action === 'dismiss') next.suggestions.push({ ...suggestion, dismissedUntil: Date.now() + 7 * 86400000 });
  else throw new Error('Unknown suggestion action.');
  return next;
}

export function recordSortingChoice(state, { group, field, slot = 'withinGroup', direction = 'asc', explicit = false } = {}, { minimumEvidence = 3 } = {}) {
  const next = createLearningState(state);
  if (!explicit || !group || !field || !['withinGroup', 'secondaryWithinGroup'].includes(slot)) return { state: next, suggestion: null };
  next.sortingChoices.push({ group, field, slot, direction, explicit: true, at: Date.now() });
  const same = next.sortingChoices.filter(x => x.group === group && (x.slot || 'withinGroup') === slot);
  const counts = new Map();
  for (const choice of same) { const key = `${choice.field}:${choice.direction}`; counts.set(key, (counts.get(key) || 0) + 1); }
  const [key, count] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
  if (count < minimumEvidence) return { state: next, suggestion: null };
  const [suggestedField, suggestedDirection] = key.split(':');
  const id = `sort:${group}:${slot}:${key}`;
  if (next.suggestions.some(s => s.id === id) || next.rejected.some(s => s.id === id) || next.rules.some(s => s.id === id)) return { state: next, suggestion: null };
  const suggestion = { id, type: 'sorting', group, slot, field: suggestedField, direction: suggestedDirection, support: count, status: 'pending', explanation: `${count} explicit sorting selections used ${suggestedField} for ${slot === 'secondaryWithinGroup' ? 'the secondary' : 'the primary'} sort.` };
  next.suggestions.push(suggestion);
  return { state: next, suggestion };
}

export function resetLearnedPreferences(state) {
  const current = createLearningState(state);
  return { ...current, examples: [], observedVideos: [], rules: [], suggestions: [], rejected: [], sortingChoices: [], sortingPreferences: [] };
}

export function exportLearningPreferences(state) {
  return JSON.stringify({ format: 'youtube-playlist-organizer-learning', version: 1, preferences: createLearningState(state) }, null, 2);
}

export function importLearningPreferences(text) {
  const value = JSON.parse(text);
  if (value?.format !== 'youtube-playlist-organizer-learning' || !value.preferences) throw new Error('Unsupported learned preferences export.');
  return createLearningState(value.preferences);
}
