// lib/settings.js
// One `settings` key in chrome.storage.sync holds everything the popup edits.
// Shared by the background (via import) and the popup (as a module script).
import { TAXONOMY, OTHER_GROUP, UNAVAILABLE_GROUP } from './taxonomy.js';
import { getProvider, PROVIDERS } from './providers.js';
import { SORT_DEFAULTS, normalizeSortOptions } from './sort.js';
import { normalizeSubjects, PERSONAL_PRESET } from './configuration.js';
import { normalizeAutomation } from './automation.js';

export const SETTINGS_KEY = 'settings';
export const MAX_NEW_CATEGORIES_LIMIT = 10;

export const DEFAULT_SETTINGS = Object.freeze({
  classificationMethod: 'local-rules',
  provider: 'anthropic',
  apiKey: '',
  baseUrl: '',
  model: '',
  taxonomy: [...TAXONOMY],
  subjects: TAXONOMY.map((name, i) => ({ id: `custom:legacy-${i + 1}`, source: 'custom', externalId: null, name, description: '', instructions: '', priority: i })),
  fallbackSubjectId: null,
  presets: [{ ...PERSONAL_PRESET, subjects: PERSONAL_PRESET.subjects.map(s => ({ ...s })), sort: { ...PERSONAL_PRESET.sort } }],
  maxNewCategories: 2,
  extraInstructions: '',
  learning: { minimumEvidence: 4, minimumConsistency: 0.8 },
  autoPreviewWatchLater: false,
  autoOrganizeWatchLater: false,
  automation: { mode: 'manual', scheduleMinutes: 360, notifications: false },
  sort: { ...SORT_DEFAULTS },
});

const RESERVED = new Set([OTHER_GROUP, UNAVAILABLE_GROUP].map(n => n.toLowerCase()));

function coerceTaxonomy(raw) {
  const items = Array.isArray(raw) ? raw : String(raw ?? '').split('\n');
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const name = String(item ?? '').trim();
    // sort.js folds group names case-insensitively, so two spellings of one
    // category would collapse into a single group anyway.
    const key = name.toLowerCase();
    // "Other" and "Unavailable" are groups the sorter appends itself; listing
    // them as categories would place the same group twice.
    if (!name || seen.has(key) || RESERVED.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.length > 0 ? out : [...TAXONOMY];
}

function coerceMaxNew(raw) {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return DEFAULT_SETTINGS.maxNewCategories;
  return Math.min(MAX_NEW_CATEGORIES_LIMIT, Math.max(0, n));
}

export function normalizeSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const provider = getProvider(source.provider) || getProvider(DEFAULT_SETTINGS.provider) || PROVIDERS[0];
  const baseUrl = String(source.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(source.model ?? '').trim();
  const legacyNames = coerceTaxonomy(source.taxonomy ?? DEFAULT_SETTINGS.taxonomy);
  const subjects = normalizeSubjects(source.subjects ?? legacyNames.filter(n => !RESERVED.has(String(n).trim().toLowerCase())).map((name, i) => ({ id: `custom:legacy-${i + 1}`, source: 'custom', name, priority: i })));
  const presets = Array.isArray(source.presets) ? source.presets.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string').map(p => ({ ...p, subjects: normalizeSubjects(p.subjects), sort: normalizeSortOptions(p.sort) })) : DEFAULT_SETTINGS.presets;
  return {
    classificationMethod: ['local-rules', 'local-ai', 'cloud-ai', 'hybrid'].includes(source.classificationMethod) ? source.classificationMethod : (source.provider ? 'cloud-ai' : DEFAULT_SETTINGS.classificationMethod),
    provider: provider.id,
    apiKey: String(source.apiKey ?? '').trim(),
    baseUrl: baseUrl || provider.baseUrl,
    model: model || provider.defaultModel,
    taxonomy: subjects.length ? subjects.map(s => s.name) : coerceTaxonomy(source.taxonomy ?? DEFAULT_SETTINGS.taxonomy),
    subjects: subjects.length ? subjects : DEFAULT_SETTINGS.subjects.map(s => ({ ...s })),
    fallbackSubjectId: subjects.some(s => s.id === source.fallbackSubjectId) ? source.fallbackSubjectId : null,
    presets,
    maxNewCategories: coerceMaxNew(source.maxNewCategories ?? DEFAULT_SETTINGS.maxNewCategories),
    extraInstructions: String(source.extraInstructions ?? '').trim(),
    learning: { minimumEvidence: Math.max(3, Math.min(20, Number(source.learning?.minimumEvidence) || 4)), minimumConsistency: Math.max(0.6, Math.min(1, Number(source.learning?.minimumConsistency) || 0.8)) },
    autoPreviewWatchLater: source.autoPreviewWatchLater === true,
    autoOrganizeWatchLater: source.autoOrganizeWatchLater === true,
    automation: normalizeAutomation(source.automation),
    sort: normalizeSortOptions(source.sort),
  };
}

export async function loadSettings(storage = chrome.storage.sync) {
  const data = await storage.get([SETTINGS_KEY, 'apiKey']);
  if (data[SETTINGS_KEY]) return normalizeSettings(data[SETTINGS_KEY]);

  // Versions before the provider picker stored only a top-level Anthropic key.
  if (typeof data.apiKey === 'string' && data.apiKey) {
    const migrated = normalizeSettings({ provider: 'anthropic', apiKey: data.apiKey });
    await storage.set({ [SETTINGS_KEY]: migrated });
    await storage.remove('apiKey');
    return migrated;
  }

  return normalizeSettings({});
}

export async function saveSettings(partial, storage = chrome.storage.sync) {
  const current = await loadSettings(storage);
  const merged = { ...current, ...partial };
  if ('taxonomy' in partial && !('subjects' in partial)) delete merged.subjects;
  // A provider switch must not inherit the previous provider's URL or model.
  if (partial.provider && partial.provider !== current.provider) {
    if (!('baseUrl' in partial)) merged.baseUrl = '';
    if (!('model' in partial)) merged.model = '';
  }
  const next = normalizeSettings(merged);
  await storage.set({ [SETTINGS_KEY]: next });
  return next;
}
