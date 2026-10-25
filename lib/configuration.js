// Source-aware, user-editable subjects and presets. Category IDs, curated
// topic IDs and custom IDs intentionally occupy separate namespaces.
export const CURATED_TOPICS = Object.freeze([
  { id: '/m/09kqc', name: 'Humor' }, { id: '/m/02vxn', name: 'Movies' },
  { id: '/m/05qjc', name: 'Performing arts' }, { id: '/m/066wd', name: 'Professional wrestling' },
  { id: '/m/0f2f9', name: 'TV shows' }, { id: '/m/019_rr', name: 'Lifestyle' },
  { id: '/m/032tl', name: 'Fashion' }, { id: '/m/027x7n', name: 'Fitness' },
  { id: '/m/02wbm', name: 'Food' }, { id: '/m/03glg', name: 'Hobby' },
  { id: '/m/068hy', name: 'Pets' }, { id: '/m/041xxh', name: 'Beauty' },
  { id: '/m/07c1v', name: 'Technology' }, { id: '/m/07bxq', name: 'Tourism' },
  { id: '/m/07yv9', name: 'Vehicles' }, { id: '/m/098wr', name: 'Society' },
  { id: '/m/09s1f', name: 'Business' }, { id: '/m/0kt51', name: 'Health' },
  { id: '/m/01h6rj', name: 'Military' }, { id: '/m/05qt0', name: 'Politics' },
  { id: '/m/06bvp', name: 'Religion' }, { id: '/m/01k8wb', name: 'Knowledge' },
]);

// Offline fallback for videoCategories.list (common assignable US categories).
// The API remains authoritative and can be refreshed with an API key.
export const FALLBACK_VIDEO_CATEGORIES = Object.freeze([
  ['1', 'Film & Animation'], ['2', 'Autos & Vehicles'], ['10', 'Music'], ['15', 'Pets & Animals'],
  ['17', 'Sports'], ['18', 'Short Movies'], ['19', 'Travel & Events'], ['20', 'Gaming'],
  ['21', 'Videoblogging'], ['22', 'People & Blogs'], ['23', 'Comedy'], ['24', 'Entertainment'],
  ['25', 'News & Politics'], ['26', 'Howto & Style'], ['27', 'Education'], ['28', 'Science & Technology'], ['29', 'Nonprofits & Activism'],
].map(([externalId, name]) => ({ id: `youtube-category:${externalId}`, source: 'category', externalId, name, description: '', instructions: '' })));

export const PERSONAL_PRESET = Object.freeze({
  id: 'preset:niall-watch-later', name: 'Niall — Watch Later',
  subjects: [
    ['News', 'General current affairs, politics, world events and news reporting.'],
    ['Music History / Commentary', 'Musicians, artist biographies, albums, music history, criticism and analysis.'],
    ['Biblical History / Documentary', 'Biblical archaeology, ancient Israel, Ancient Near Eastern history and historical documentaries.'],
    ['Biblical Explanation', 'Torah, Tanakh, Talmud, parashah, rabbinic commentary and interpretation.'],
    ['Physics', 'Cosmology, quantum mechanics, astrophysics, relativity and other physical sciences.'],
    ['AI Skills & News', 'AI engineering, LangChain, LangGraph, agents, machine learning, models, tutorials and AI industry developments.'],
    ['Other / Uncategorised', 'Use only when no selected subject is a confident fit.'],
  ].map(([name, description], i) => ({
    id: `custom:niall-watch-later:${i + 1}`, source: 'custom', name, description, externalId: null, priority: i,
    rules: [
      { includePhrases: ['election results', 'world events', 'current affairs', 'news reporting', 'politics'] },
      { includePhrases: ['pink floyd', 'music history', 'artist biography', 'music criticism', 'album analysis', 'musician biography'] },
      { includePhrases: ['biblical archaeology', 'ancient israel', 'ancient near east', 'archaeological discoveries', 'historical documentary'] },
      { includePhrases: ['torah commentary', 'tanakh', 'talmud', 'parashah', 'rabbinic commentary', 'rabbi sacks'] },
      { includePhrases: ['quantum mechanics', 'quantum entanglement', 'cosmology', 'astrophysics', 'relativity', 'physical sciences'] },
      { includePhrases: ['ai engineering', 'langchain', 'langgraph', 'machine learning', 'ai model', 'openai', 'ai industry', 'artificial intelligence'] },
      {},
    ][i],
  })),
  fallbackSubjectId: 'custom:niall-watch-later:7',
  sort: { withinGroup: 'duration-asc', secondaryWithinGroup: 'playlist', inProgress: 'sort', groupOrder: 'taxonomy' },
});

export function createSubject(source, name, externalId = null, extra = {}) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Subject name is required.');
  const id = source === 'category' ? `youtube-category:${externalId}`
    : source === 'topic' ? `youtube-topic:${externalId}`
      : `custom:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  return { id, source, name: clean, externalId: externalId == null ? null : String(externalId), description: String(extra.description ?? ''), instructions: String(extra.instructions ?? ''), priority: Number(extra.priority) || 0 };
}

function normalizePhrases(value) {
  return Array.isArray(value) ? [...new Set(value.map(x => String(x).trim().slice(0, 150)).filter(Boolean))].slice(0, 100) : [];
}

function normalizeMetadataWeights(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const field of ['title', 'channel', 'description', 'category', 'topic']) {
    const entry = value[field];
    if (!entry || typeof entry !== 'object') continue;
    const numeric = Number(entry.weight);
    const weight = Number.isFinite(numeric) ? Math.max(-10, Math.min(10, numeric)) : 1;
    result[field] = { weight, phrases: normalizePhrases(entry.phrases) };
  }
  return result;
}

export function normalizeSubjects(subjects) {
  if (!Array.isArray(subjects)) return [];
  const ids = new Set();
  const names = new Set();
  return subjects.map((s, priority) => {
    if (!s || !['category', 'topic', 'custom'].includes(s.source)) return null;
    const name = String(s.name ?? '').trim();
    const externalId = s.externalId == null ? null : String(s.externalId);
    const id = String(s.id || (s.source === 'custom' ? createSubject('custom', name).id : `${s.source === 'category' ? 'youtube-category' : 'youtube-topic'}:${externalId}`));
    const nameKey = name.toLocaleLowerCase();
    if (!name || ids.has(id) || names.has(nameKey) || (s.source !== 'custom' && !externalId)) return null;
    ids.add(id);
    names.add(nameKey);
    const sourceRules = s.rules && typeof s.rules === 'object' ? s.rules : {};
    const rules = Object.fromEntries(['includePhrases', 'excludePhrases', 'titlePhrases', 'channelRules', 'descriptionPhrases', 'categoryMatches', 'topicMatches'].map(key => [key, normalizePhrases(sourceRules[key])]));
    rules.metadataWeights = normalizeMetadataWeights(sourceRules.metadataWeights);
    return { id, source: s.source, name, externalId, description: String(s.description ?? '').slice(0, 2000), instructions: String(s.instructions ?? '').slice(0, 2000), priority, enabled: s.enabled !== false, rules };
  }).filter(Boolean);
}

export async function fetchVideoCategories(apiKey, { regionCode = 'US', fetchImpl = fetch } = {}) {
  if (!String(apiKey ?? '').trim()) throw new Error('YouTube Data API key is required to refresh video categories.');
  const url = new URL('https://www.googleapis.com/youtube/v3/videoCategories');
  url.search = new URLSearchParams({ part: 'snippet', regionCode, hl: 'en_US', key: apiKey }).toString();
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`YouTube categories request failed (${response.status}).`);
  const data = await response.json();
  return (data.items || []).filter(x => x?.snippet?.assignable).map(x => ({ id: `youtube-category:${x.id}`, source: 'category', externalId: String(x.id), name: x.snippet.title, description: '', instructions: '' }));
}

export function exportConfiguration(settings) {
  const safeSettings = { ...settings };
  delete safeSettings.apiKey;
  return JSON.stringify({ format: 'youtube-playlist-organizer', version: 1, settings: safeSettings }, null, 2);
}

export function importConfiguration(text) {
  const value = JSON.parse(text);
  if (value?.format !== 'youtube-playlist-organizer' || !value.settings || typeof value.settings !== 'object') throw new Error('This file is not a supported Organizer settings export.');
  return value.settings;
}
