// Deterministic, local-only classification. Scores rank evidence; they are
// heuristic weights, not probabilities.
export const LOCAL_CLASSIFIER_VERSION = 1;
export const MIN_LOCAL_SCORE = 3;
export const MIN_LOCAL_MARGIN = 1.5;

const clean = value => String(value ?? '').toLocaleLowerCase().normalize('NFKC');
const list = value => Array.isArray(value) ? value.map(x => String(x).trim()).filter(Boolean) : [];
const contains = (text, phrase) => {
  const p = clean(phrase);
  if (!p) return false;
  return p.includes(' ') ? text.includes(p) : new RegExp(`(^|[^\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(text);
};

function textFor(video) {
  return {
    all: clean([video.title, video.channel, video.description, video.category, ...(video.topicIds || [])].join(' ')),
    title: clean(video.title), channel: clean(video.channel), description: clean(video.description),
    category: clean(video.category), topics: (video.topicIds || []).map(clean),
  };
}

function scoreSubject(video, subject, learnedRules = []) {
  const text = textFor(video);
  let score = 0;
  const evidence = [];
  const addMatches = (phrases, weight, field, target = text.all) => {
    for (const phrase of list(phrases)) if (contains(target, phrase)) {
      const specificity = Math.min(3, Math.max(1, clean(phrase).split(/\s+/).length));
      const value = weight * specificity;
      score += value; evidence.push({ field, phrase, weight: value });
    }
  };
  const rules = subject.rules || {};
  if (subject.source === 'category' && (text.category === clean(subject.name) || text.category === clean(subject.externalId))) {
    score += 5; evidence.push({ field: 'youtube-category', phrase: subject.externalId || subject.name, weight: 5 });
  }
  if (subject.source === 'topic' && (video.topicIds || []).some(id => clean(id) === clean(subject.externalId))) {
    score += 6; evidence.push({ field: 'youtube-topic', phrase: subject.externalId, weight: 6 });
  }
  addMatches(rules.includePhrases, 4, 'include', `${text.title} ${text.description} ${text.category} ${text.topics.join(' ')}`);
  addMatches(rules.titlePhrases, 5, 'title', text.title);
  addMatches(rules.channelRules, 1.5, 'channel', text.channel);
  addMatches(rules.descriptionPhrases, 2, 'description', text.description);
  addMatches(rules.categoryMatches, 2.5, 'category', text.category);
  addMatches(rules.topicMatches, 3, 'topic', text.topics.join(' '));
  const weights = rules.metadataWeights || {};
  for (const [field, value] of Object.entries({ title: text.title, channel: text.channel, description: text.description, category: text.category, topic: text.topics.join(' ') })) {
    for (const phrase of list(weights[field]?.phrases)) addMatches([phrase], Number(weights[field].weight) || 1, field, value);
  }
  // Subject guidance is weak supporting evidence only; precise user rules win.
  addMatches([subject.name], 0.7, 'subject-name', `${text.title} ${text.description} ${text.category}`);
  addMatches(clean(`${subject.description || ''} ${subject.instructions || ''}`).match(/[\p{L}\p{N}]{4,}(?:\s+[\p{L}\p{N}]{3,})?/gu) || [], 0.35, 'guidance');
  for (const phrase of list(rules.excludePhrases)) if (contains(text.all, phrase)) {
    score -= Math.min(12, 5 * Math.max(1, clean(phrase).split(/\s+/).length));
    evidence.push({ field: 'exclude', phrase, weight: -5 });
  }
  for (const rule of learnedRules) {
    if (!rule.enabled || rule.subjectId !== subject.id) continue;
    const target = rule.field === 'channel+title' ? `${text.channel} ${text.title}` : (text[rule.field] || text.all);
    if (contains(target, rule.phrase)) { score += Number(rule.weight) || 6; evidence.push({ field: 'approved-learned-rule', phrase: rule.phrase, ruleId: rule.id, weight: Number(rule.weight) || 6 }); }
  }
  return { subject, score, evidence };
}

export function classifyLocally(video, subjects, { fallbackSubjectId = null, learnedRules = [], overrides = {}, approvedRules = [] } = {}) {
  const overridden = subjects.find(s => s.id === overrides[video.id]);
  if (overridden) return { subjectId: overridden.id, name: overridden.name, source: 'manual-override', score: null, evidence: [{ field: 'manual-override', phrase: video.id }], uncertain: false };
  const enabled = subjects.filter(s => s.enabled !== false && s.id !== fallbackSubjectId && !/^(other|other \/ uncategorised|unavailable)$/i.test(s.name));
  const ranked = enabled.map(subject => scoreSubject(video, subject, approvedRules)).sort((a, b) => b.score - a.score || (a.subject.priority ?? 0) - (b.subject.priority ?? 0) || a.subject.id.localeCompare(b.subject.id));
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const hasContentEvidence = winner?.evidence.some(item => !['channel', 'subject-name', 'guidance'].includes(item.field));
  const uncertain = !winner || !hasContentEvidence || winner.score < MIN_LOCAL_SCORE || (runnerUp && winner.score - runnerUp.score < MIN_LOCAL_MARGIN);
  const selected = uncertain ? subjects.find(s => s.id === fallbackSubjectId) : winner.subject;
  const subject = selected || subjects.find(s => /^(other|other \/ uncategorised)$/i.test(s.name));
  return {
    subjectId: subject?.id || null, name: subject?.name || 'Other / Uncategorised',
    source: uncertain ? 'local-fallback' : 'local-rules', score: uncertain ? winner?.score ?? 0 : winner.score,
    evidence: uncertain ? (winner?.evidence || []) : winner.evidence,
    competing: runnerUp ? { subjectId: runnerUp.subject.id, score: runnerUp.score } : null,
    uncertain: Boolean(uncertain),
  };
}

export function classifyManyLocally(videos, subjects, options = {}) {
  return videos.filter(video => !video.unavailable).map(video => ({ videoId: video.id, ...classifyLocally(video, subjects, options) }));
}
