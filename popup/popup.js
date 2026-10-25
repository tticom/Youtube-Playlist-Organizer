// popup/popup.js — settings UI. A module script so it can share lib/ with the
// background; build.sh copies lib/ into both dist layouts for this reason.
import { PROVIDERS, MODEL_GUIDANCE, getProvider, pickRecommended } from '../lib/providers.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../lib/settings.js';
import { SORT_CHOICES } from '../lib/sort.js';
import { CURATED_TOPICS, FALLBACK_VIDEO_CATEGORIES, createSubject, exportConfiguration, importConfiguration, normalizeSubjects, fetchVideoCategories } from '../lib/configuration.js';

const $ = (sel) => document.querySelector(sel);

// --- Host permission -------------------------------------------------------
// Firefox MV3 treats declared `host_permissions` as opt-in: they are NOT
// granted at install, and the declared content script does not inject until
// the user allows the site. That is why the Organize button appeared only
// after clicking the toolbar button, which grants temporary access via
// `activeTab`. Chrome grants host_permissions at install, so `contains()`
// returns true there and this banner never renders.
const YT_PERMS = { origins: ['https://www.youtube.com/*'] };

function showBanner(text, showButton) {
  $('#perm-text').textContent = text;
  $('#grant-btn').hidden = !showButton;
  $('#perm-banner').hidden = false;
}

if (chrome.permissions) {
  chrome.permissions.contains(YT_PERMS, (granted) => {
    if (!granted) $('#perm-banner').hidden = false;
  });

  // `permissions.request()` must be called from a user input handler, so it
  // cannot be fired automatically when the popup opens.
  $('#grant-btn').addEventListener('click', () => {
    chrome.permissions.request(YT_PERMS, (granted) => {
      if (granted) {
        // The grant does not retroactively inject into tabs that are already
        // open, so a reload is genuinely required.
        showBanner('Granted. Reload any open YouTube tabs.', false);
      } else {
        showBanner('Not granted. The Organize button will not appear until you allow access.', true);
      }
    });
  });
}

// --- Settings form ---------------------------------------------------------
const els = {
  provider: $('#provider'),
  method: $('#classification-method'),
    learningMinEvidence: $('#learning-min-evidence'),
    learningMinConsistency: $('#learning-min-consistency'),
  keyField: $('#key-field'),
  keyLink: $('#key-link'),
  apiKey: $('#api-key'),
  baseUrlField: $('#base-url-field'),
  baseUrl: $('#base-url'),
  modelSelect: $('#model-select'),
  modelText: $('#model-text'),
  loadModels: $('#load-models-btn'),
  guidance: $('#model-guidance'),
  hint: $('#provider-hint'),
  taxonomy: $('#taxonomy'),
  resetTaxonomy: $('#reset-taxonomy-btn'),
  maxNew: $('#max-new'),
  extra: $('#extra'),
  sort: {
    withinGroup: $('#sort-within-group'),
    secondaryWithinGroup: $('#sort-secondary-within-group'),
    inProgress: $('#sort-in-progress'),
    groupOrder: $('#sort-group-order'),
  },
  save: $('#save-btn'),
    automationMode: $('#automation-mode'),
    automationInterval: $('#automation-interval'),
    automationCustomMinutes: $('#automation-custom-minutes'),
    automationNotifications: $('#automation-notifications'),
  status: $('#status'),
};
let selectedSubjects = [];
let savedPresets = [];
let currentLearning = {};
let subjectSorts = {};
let catalog = [...FALLBACK_VIDEO_CATEGORIES, ...CURATED_TOPICS.map(t => ({ ...t, id: `youtube-topic:${t.id}`, source: 'topic', externalId: t.id, description: '', instructions: '' }))];

function renderSubjects() {
  const query = ($('#subject-search').value || '').trim().toLocaleLowerCase();
  const catalogEl = $('#subject-catalog'); catalogEl.replaceChildren();
  for (const subject of catalog.filter(s => !query || `${s.name} ${s.source}`.toLocaleLowerCase().includes(query))) {
    const row = document.createElement('label'); row.className = 'wl-row';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedSubjects.some(s => s.id === subject.id);
    check.addEventListener('change', () => {
      selectedSubjects = check.checked ? normalizeSubjects([...selectedSubjects, { ...subject, priority: selectedSubjects.length }]) : selectedSubjects.filter(s => s.id !== subject.id);
      renderSubjects();
    });
    const title = document.createElement('span'); title.className = 'wl-row-label'; title.textContent = `${subject.name} · ${subject.source === 'category' ? 'YouTube category' : 'Curated topic'}`;
    row.append(check, title); catalogEl.append(row);
  }
  const list = $('#selected-subjects'); list.replaceChildren();
  selectedSubjects.forEach((subject, index) => {
    const row = document.createElement('li'); row.className = 'wl-selected-subject';
    const name = document.createElement('input'); name.value = subject.name; name.setAttribute('aria-label', `${subject.name} name`);
    const desc = document.createElement('input'); desc.value = subject.description || ''; desc.placeholder = 'Description and classification guidance'; desc.setAttribute('aria-label', `${subject.name} description`);
    const instructions = document.createElement('input'); instructions.value = subject.instructions || ''; instructions.placeholder = 'Classification instructions'; instructions.setAttribute('aria-label', `${subject.name} classification instructions`);
    const ruleInputs = [];
    for (const [key, label] of [['includePhrases', 'Include phrases'], ['excludePhrases', 'Exclude phrases'], ['titlePhrases', 'Title phrases'], ['channelRules', 'Channel matches (supporting only)'], ['descriptionPhrases', 'Description phrases'], ['categoryMatches', 'YouTube category matches'], ['topicMatches', 'Topic ID/name matches']]) {
      const input = document.createElement('input'); input.value = (subject.rules?.[key] || []).join(', '); input.placeholder = `${label} (comma separated)`; input.setAttribute('aria-label', `${subject.name} ${label}`);
      input.addEventListener('change', () => { subject.rules = { ...(subject.rules || {}), [key]: input.value.split(',').map(x => x.trim()).filter(Boolean) }; }); ruleInputs.push(input);
    }
    const weights = document.createElement('input'); weights.value = JSON.stringify(subject.rules?.metadataWeights || {}); weights.placeholder = 'Weighted metadata matches JSON'; weights.setAttribute('aria-label', `${subject.name} metadata weights JSON`);
    weights.addEventListener('change', () => { try { const parsed = JSON.parse(weights.value || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); subject.rules = { ...(subject.rules || {}), metadataWeights: parsed }; } catch { setStatus('Metadata weights must be a JSON object.', { error: true }); } });
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = subject.enabled !== false; enabled.setAttribute('aria-label', `Enable ${subject.name}`); enabled.addEventListener('change', () => { subject.enabled = enabled.checked; });
    const subjectSort = subjectSorts[subject.name] || {};
    const sortPrimary = document.createElement('select'); sortPrimary.setAttribute('aria-label', `${subject.name} primary sort`);
    for (const choice of SORT_CHOICES.withinGroup) { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; sortPrimary.append(option); }
    sortPrimary.value = subjectSort.withinGroup || 'Use default';
    const primaryDefault = document.createElement('option'); primaryDefault.value = 'Use default'; primaryDefault.textContent = 'Use default primary sort'; sortPrimary.prepend(primaryDefault);
    sortPrimary.value = subjectSort.withinGroup || 'Use default';
    const sortSecondary = document.createElement('select'); sortSecondary.setAttribute('aria-label', `${subject.name} secondary sort`);
    const secondaryDefault = document.createElement('option'); secondaryDefault.value = 'Use default'; secondaryDefault.textContent = 'Use default secondary sort'; sortSecondary.append(secondaryDefault);
    for (const choice of SORT_CHOICES.secondaryWithinGroup) { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; sortSecondary.append(option); }
    sortSecondary.value = subjectSort.secondaryWithinGroup || 'Use default';
    const saveSubjectSort = (changedSlot) => {
      const next = { ...(subjectSorts[subject.name] || {}) };
      if (sortPrimary.value === 'Use default') delete next.withinGroup; else next.withinGroup = sortPrimary.value;
      if (sortSecondary.value === 'Use default') delete next.secondaryWithinGroup; else next.secondaryWithinGroup = sortSecondary.value;
      if (Object.keys(next).length) subjectSorts[subject.name] = next; else delete subjectSorts[subject.name];
      const field = changedSlot === 'withinGroup' ? sortPrimary.value : sortSecondary.value;
      if (field !== 'Use default') chrome.runtime.sendMessage({ type: 'RECORD_SORTING_CHOICE', group: subject.name, slot: changedSlot, field }).catch(() => {});
    };
    sortPrimary.addEventListener('change', () => saveSubjectSort('withinGroup')); sortSecondary.addEventListener('change', () => saveSubjectSort('secondaryWithinGroup'));
    name.disabled = subject.source !== 'custom';
    name.addEventListener('change', () => { subject.name = name.value.trim() || subject.name; renderSubjects(); });
    desc.addEventListener('change', () => { subject.description = desc.value; });
    instructions.addEventListener('change', () => { subject.instructions = instructions.value; });
    const up = document.createElement('button'); up.type = 'button'; up.textContent = '↑'; up.disabled = index === 0; up.title = 'Move up';
    up.addEventListener('click', () => { [selectedSubjects[index - 1], selectedSubjects[index]] = [selectedSubjects[index], selectedSubjects[index - 1]]; renderSubjects(); });
    const down = document.createElement('button'); down.type = 'button'; down.textContent = '↓'; down.disabled = index === selectedSubjects.length - 1; down.title = 'Move down';
    down.addEventListener('click', () => { [selectedSubjects[index + 1], selectedSubjects[index]] = [selectedSubjects[index], selectedSubjects[index + 1]]; renderSubjects(); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.addEventListener('click', () => { selectedSubjects = selectedSubjects.filter(s => s.id !== subject.id); renderSubjects(); });
    row.append(name, desc, instructions, ...ruleInputs, weights, enabled, document.createTextNode('Enabled'), sortPrimary, sortSecondary, up, down, remove); list.append(row);
  });
  els.taxonomy.value = selectedSubjects.map(s => s.name).join('\n');
  const fallback = $('#fallback-subject'); const chosenFallback = fallback.value; fallback.replaceChildren();
  const defaultFallback = document.createElement('option'); defaultFallback.value = ''; defaultFallback.textContent = 'Built-in Other'; fallback.append(defaultFallback);
  for (const subject of selectedSubjects) { const option = document.createElement('option'); option.value = subject.id; option.textContent = subject.name; fallback.append(option); }
  fallback.value = selectedSubjects.some(s => s.id === chosenFallback) ? chosenFallback : '';
}
function renderPresetChoices(selected = '') {
  const presetSelect = $('#preset-select'); presetSelect.replaceChildren();
  for (const preset of savedPresets) { const opt = document.createElement('option'); opt.value = preset.id; opt.textContent = preset.name; presetSelect.append(opt); }
  if (selected) presetSelect.value = selected;
}

const SHOW_URL_FOR = new Set(['custom', 'ollama']);
let statusTimer = null;

function setStatus(text, { sticky = false, error = false } = {}) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle('error', error);
  if (!sticky && text) statusTimer = setTimeout(() => { els.status.textContent = ''; }, 2000);
}

function selectedProvider() {
  return getProvider(els.provider.value) || PROVIDERS[0];
}

function currentModel() {
  return (els.modelText.hidden ? els.modelSelect.value : els.modelText.value).trim();
}

/** Fill the model select with `models`, keeping `current` selectable even if the API did not list it. */
function fillModels(models, current, recommended) {
  els.modelSelect.replaceChildren();
  const ids = [...models];
  if (current && !ids.includes(current)) ids.unshift(current);
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id === recommended ? `${id} (recommended)` : id;
    els.modelSelect.append(opt);
  }
  els.modelSelect.value = current || recommended || ids[0] || '';
  els.modelSelect.hidden = false;
  els.modelText.hidden = true;
}

/** Text-entry fallback for when the provider cannot list models. */
function useModelText(current) {
  els.modelText.value = current;
  els.modelText.hidden = false;
  els.modelSelect.hidden = true;
}

function formSettings() {
  const provider = selectedProvider();
  return {
    classificationMethod: els.method.value,
    learning: { ...(currentLearning || {}), minimumEvidence: els.learningMinEvidence.value, minimumConsistency: els.learningMinConsistency.value },
    provider: provider.id,
    apiKey: els.apiKey.value.trim(),
    baseUrl: SHOW_URL_FOR.has(provider.id) ? els.baseUrl.value.trim() : '',
    model: currentModel(),
    taxonomy: els.taxonomy.value.split('\n'),
    subjects: normalizeSubjects(selectedSubjects),
    fallbackSubjectId: $('#fallback-subject').value || null,
    presets: savedPresets,
    maxNewCategories: els.maxNew.value,
    extraInstructions: els.extra.value,
    automation: {
      mode: els.automationMode.value,
      scheduleMinutes: els.automationInterval.value === 'custom' ? els.automationCustomMinutes.value : els.automationInterval.value,
      notifications: els.automationNotifications.checked,
    },
    sort: {
      ...Object.fromEntries(Object.entries(els.sort).map(([key, el]) => [key, el.value])),
      subjectSorts: structuredClone(subjectSorts),
    },
  };
}

function renderProviderFields(provider) {
  const method = els.method.value;
  const usesAI = method === 'cloud-ai' || method === 'hybrid' || method === 'local-ai';
  els.provider.closest('.wl-section').hidden = !usesAI;
  els.maxNew.closest('.wl-row').hidden = !usesAI;
  els.extra.closest('.wl-field').hidden = !usesAI;
  els.keyField.hidden = !provider.needsKey || method === 'local-ai';
  els.keyLink.hidden = !provider.docsUrl;
  if (provider.docsUrl) els.keyLink.href = provider.docsUrl;
  els.baseUrlField.hidden = !SHOW_URL_FOR.has(provider.id);
  els.hint.textContent = provider.hint;
}

function render(settings) {
  currentLearning = settings.learning || { minimumEvidence: 4, minimumConsistency: 0.8 };
  els.method.value = settings.classificationMethod || 'local-rules';
  els.provider.value = settings.provider;
  const provider = selectedProvider();
  renderProviderFields(provider);
  els.apiKey.value = settings.apiKey;
  els.baseUrl.value = settings.baseUrl;
  // Until the user loads the list, the select just shows the one saved model.
  fillModels(settings.model ? [settings.model] : [], settings.model, null);
  if (!settings.model) useModelText('');
  els.taxonomy.value = settings.taxonomy.join('\n');
  selectedSubjects = normalizeSubjects(settings.subjects || []);
  subjectSorts = structuredClone(settings.sort?.subjectSorts || {});
  savedPresets = settings.presets || [];
  renderPresetChoices();
  renderSubjects();
  $('#fallback-subject').value = settings.fallbackSubjectId || '';
  els.maxNew.value = settings.maxNewCategories;
  els.extra.value = settings.extraInstructions;
  els.automationMode.value = settings.automation?.mode || 'manual';
  const minutes = String(settings.automation?.scheduleMinutes || 360);
  els.automationInterval.value = ['60', '360', '1440'].includes(minutes) ? minutes : 'custom';
  els.automationCustomMinutes.value = minutes;
  $('#automation-custom-row').hidden = els.automationInterval.value !== 'custom';
  els.automationNotifications.checked = settings.automation?.notifications === true;
  els.learningMinEvidence.value = currentLearning.minimumEvidence || 4;
  els.learningMinConsistency.value = currentLearning.minimumConsistency || 0.8;
  for (const [key, el] of Object.entries(els.sort)) el.value = settings.sort[key];
  loadLearningDashboard();
}

async function loadLearningDashboard() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_LEARNED_PREFERENCES' }).catch(() => null);
  if (!response?.success) return;
  const { confirmed, overrides, accepted, pending, rejected } = response.stats;
  $('#learning-stats').textContent = `${confirmed} confirmed examples · ${overrides} active video overrides · ${accepted} approved rules/preferences · ${pending} pending suggestions · ${rejected} rejected`;
  const list = $('#learning-suggestions'); list.replaceChildren();
  for (const rule of [...response.state.sortingPreferences, ...response.state.rules, ...response.state.suggestions, ...response.state.rejected.slice(-3)]) {
    const row = document.createElement('div'); row.className = 'wl-learning-item';
    const description = document.createElement('p'); description.textContent = `${rule.status === 'pending' ? 'Suggested' : rule.status === 'rejected' ? 'Recently rejected' : rule.type === 'sorting' ? 'Approved sorting preference' : 'Approved rule'}: ${rule.type === 'sorting' ? `${rule.field} for ${rule.group === '*' ? 'all subjects' : rule.group}` : rule.field === 'title' ? `title contains “${rule.phrase}”` : `${rule.field || ''} ${rule.phrase || ''}`} → ${selectedSubjects.find(s => s.id === rule.subjectId)?.name || rule.group || rule.subjectId || ''}. ${rule.explanation || ''}`;
    row.append(description);
    if (rule.status === 'pending') {
      const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'wl-btn'; accept.textContent = 'Accept'; accept.addEventListener('click', () => reviewRule(rule.id, 'accept'));
      const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'wl-btn'; reject.textContent = 'Reject'; reject.addEventListener('click', () => reviewRule(rule.id, 'reject'));
      row.append(accept);
      if (rule.type !== 'sorting') { const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'wl-btn'; edit.textContent = 'Edit then accept'; edit.addEventListener('click', () => { const phrase = prompt('Rule phrase', rule.phrase); if (!phrase) return; const currentName = selectedSubjects.find(s => s.id === rule.subjectId)?.name || ''; const target = prompt(`Destination subject name (selected: ${selectedSubjects.map(s => s.name).join(', ')})`, currentName); const subjectId = selectedSubjects.find(s => s.name.toLocaleLowerCase() === String(target || '').toLocaleLowerCase())?.id; reviewRule(rule.id, 'accept', { phrase, ...(subjectId ? { subjectId } : {}) }); }); row.append(edit); }
      row.append(reject);
    } else if (rule.enabled !== undefined) {
      if (rule.type !== 'sorting') { const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'wl-btn'; edit.textContent = 'Edit'; edit.addEventListener('click', async () => { const phrase = prompt('Rule phrase', rule.phrase); if (!phrase) return; const currentName = selectedSubjects.find(s => s.id === rule.subjectId)?.name || ''; const target = prompt(`Destination subject name (selected: ${selectedSubjects.map(s => s.name).join(', ')})`, currentName); const subjectId = selectedSubjects.find(s => s.name.toLocaleLowerCase() === String(target || '').toLocaleLowerCase())?.id; const result = await chrome.runtime.sendMessage({ type: 'EDIT_LEARNED_RULE', ruleId: rule.id, edited: { phrase, ...(subjectId ? { subjectId } : {}) } }); if (!result.success) setStatus(result.error, { error: true }); loadLearningDashboard(); }); row.append(edit); }
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'wl-btn'; toggle.textContent = rule.enabled ? 'Disable' : 'Enable'; toggle.addEventListener('click', () => toggleLearnedRule(rule.id)); row.append(toggle);
    }
    list.append(row);
  }
  for (const example of response.state.examples.filter(x => x.corrected).slice(-8).reverse()) {
    const row = document.createElement('div'); row.className = 'wl-learning-item';
    const text = document.createElement('p'); text.textContent = `Correction: “${example.title}” → ${selectedSubjects.find(s => s.id === example.subjectId)?.name || example.subjectId} (${example.confirmed ? 'confirmed' : 'unconfirmed'}).`;
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'wl-btn'; clear.textContent = 'Forget this example'; clear.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'CLEAR_LEARNED_EXAMPLE', videoId: example.videoId }); loadLearningDashboard(); });
    const clearAll = document.createElement('button'); clearAll.type = 'button'; clearAll.className = 'wl-btn'; clearAll.textContent = 'Clear correction and override'; clearAll.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'CLEAR_LEARNED_EXAMPLE', videoId: example.videoId, clearOverride: true }); loadLearningDashboard(); });
    row.append(text, clear, clearAll); list.append(row);
  }
}

async function reviewRule(suggestionId, action, edited = {}) {
  const result = await chrome.runtime.sendMessage({ type: 'REVIEW_LEARNED_SUGGESTION', suggestionId, action, edited });
  if (!result?.success) { setStatus(result?.error || 'Could not update learned rule.', { error: true }); return; }
  loadLearningDashboard();
}
async function toggleLearnedRule(ruleId) {
  await chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNED_RULE', ruleId }); loadLearningDashboard();
}

async function refreshAutomationStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_AUTOMATION_STATUS' }).catch(() => null);
  const label = $('#automation-status');
  if (!status) { label.textContent = 'Automation status is unavailable.'; return; }
  const last = status.lastResult;
  label.textContent = [
    `Unattended sorting: ${status.enabled ? 'enabled' : status.paused ? 'paused' : 'disabled'}`,
    `Mode: ${status.mode}${status.mode === 'scheduled' ? ` · every ${status.scheduleMinutes} minutes` : ''}`,
    `Authorized account: ${status.authorized ? status.authorization.accountId : 'none / needs reauthorization'}`,
    `Manual read validation: ${status.manualReadVerified ? 'verified complete read and matching order' : 'not verified for current account and settings'}`,
    `Live mutation evidence: ${status.manualWriteVerified ? 'verified write and read-back' : 'not verified; a no-op read does not test YouTube writes'}`,
    `Last attempt: ${status.lastAttemptedRun ? new Date(status.lastAttemptedRun).toLocaleString() : 'never'}`,
    `Last success: ${status.lastSuccessfulRun ? new Date(status.lastSuccessfulRun).toLocaleString() : 'never'}`,
    status.mode === 'scheduled' ? `Next scheduled run: ${status.nextScheduledRun ? new Date(status.nextScheduledRun).toLocaleString() : 'not scheduled'}` : '',
    last ? `Last result: ${last.status}; classified ${last.classifiedCount || 0}; reordered ${last.reorderedCount || 0}; already ordered ${last.alreadyOrdered ? 'yes' : 'no'}` : '',
    status.pauseReason ? `Attention: ${status.pauseReason}` : '',
    status.enabled ? '' : status.mode === 'manual' && status.authorized ? 'Manual mode does not run unattended. Choose an unattended mode to resume the saved consent.' : status.authorized ? 'Authorization is saved; enable or resume to run.' : status.manualReadVerified ? 'Your read validation succeeded without a write. To enable unattended writes, perform and verify one explicitly authorised live reorder, then confirm unattended consent.' : 'A complete manual validation and a separately verified live reorder are required before explicit unattended consent can enable writes.',
  ].filter(Boolean).join('\n');
  $('#automation-enable').disabled = status.enabled || !status.acceptanceReady || status.mode === 'manual';
  $('#automation-pause').disabled = !status.enabled;
  $('#automation-resume').disabled = !status.authorized || !status.paused;
  $('#automation-disable').disabled = !status.enabled && !status.authorized;
}

$('#automation-interval').addEventListener('change', () => { $('#automation-custom-row').hidden = els.automationInterval.value !== 'custom'; });
els.automationNotifications.addEventListener('change', async () => {
  if (els.automationNotifications.checked && chrome.permissions?.request) {
    const granted = await chrome.permissions.request({ permissions: ['notifications'] });
    if (!granted) { els.automationNotifications.checked = false; setStatus('Notification permission was not granted; automation status remains available in settings.', { error: true }); }
  }
});
$('#automation-enable').addEventListener('click', async () => {
  if (!confirm('Enable unattended sorting? Future runs may permanently reorder Watch Later without asking again. This requires a verified manual reorder for the current account and settings.')) return;
  const response = await chrome.runtime.sendMessage({ type: 'ENABLE_UNATTENDED_SORTING', confirmed: true });
  if (!response?.success) setStatus(response?.error || 'Could not enable unattended sorting.', { error: true });
  else setStatus('Unattended sorting enabled.');
  await refreshAutomationStatus();
});
$('#automation-disable').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'DISABLE_UNATTENDED_SORTING' }); await refreshAutomationStatus(); });
$('#automation-pause').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'PAUSE_AUTOMATION' }); await refreshAutomationStatus(); });
$('#automation-resume').addEventListener('click', async () => { const result = await chrome.runtime.sendMessage({ type: 'RESUME_AUTOMATION' }); if (!result?.success) setStatus(result.error, { error: true }); await refreshAutomationStatus(); });
$('#automation-run-now').addEventListener('click', async () => { setStatus('Running Watch Later automation…'); const result = await chrome.runtime.sendMessage({ type: 'RUN_AUTOMATION_NOW' }); setStatus(result?.error || `Run finished: ${result?.status || (result?.success ? 'success' : 'failed')}.`, { error: !result?.success }); await refreshAutomationStatus(); });
$('#automation-preview').addEventListener('click', async () => {
  const output = $('#automation-preview-result'); output.replaceChildren(); output.hidden = false;
  setStatus('Creating read-only Watch Later preview…');
  const result = await chrome.runtime.sendMessage({ type: 'RUN_AUTOMATION_NOW', previewOnly: true });
  setStatus(result?.error || `Preview finished: ${result?.status || 'preview'}. No playlist write was requested.`, { error: !result?.success });
  if (result?.preview) for (const [index, video] of result.preview.entries()) { const row = document.createElement('p'); row.textContent = `${index + 1}. ${video.subject ? `${video.subject}: ` : ''}${video.title}`; output.append(row); }
  else output.textContent = result?.error || 'No order preview was returned.';
  await refreshAutomationStatus();
});
$('#automation-history-toggle').addEventListener('click', async () => {
  const list = $('#automation-history'); list.hidden = !list.hidden; if (list.hidden) return;
  const status = await chrome.runtime.sendMessage({ type: 'GET_AUTOMATION_STATUS' }).catch(() => null); list.replaceChildren();
  for (const result of [...(status?.history || [])].reverse()) { const row = document.createElement('p'); row.textContent = `${new Date(result.completedAt).toLocaleString()} · ${result.status} · classified ${result.classifiedCount} · reordered ${result.reorderedCount}${result.alreadyOrdered ? ' · no write needed' : ''}${result.error ? ` · ${result.error}` : ''}`; list.append(row); }
  if (!list.childElementCount) list.textContent = 'No completed runs yet.';
});

for (const p of PROVIDERS) {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.label;
  els.provider.append(opt);
}
els.method.addEventListener('change', () => renderProviderFields(selectedProvider()));
for (const [key, el] of Object.entries(els.sort)) {
  for (const { value, label } of SORT_CHOICES[key]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    el.append(opt);
  }
}
els.guidance.textContent = MODEL_GUIDANCE;

els.provider.addEventListener('change', () => {
  const provider = selectedProvider();
  renderProviderFields(provider);
  // A different provider means a different URL space and model namespace, so
  // the previous values would only ever be wrong.
  els.baseUrl.value = provider.baseUrl;
  els.baseUrl.placeholder = provider.id === 'custom' ? 'https://host/v1' : provider.baseUrl;
  if (provider.defaultModel) fillModels([provider.defaultModel], provider.defaultModel, provider.defaultModel);
  else useModelText('');
  setStatus('');
});

els.loadModels.addEventListener('click', async () => {
  const provider = selectedProvider();
  const before = currentModel();
  els.loadModels.disabled = true;
  setStatus('Loading models…', { sticky: true });
  try {
    const response = await chrome.runtime.sendMessage({ type: 'LIST_MODELS', settings: formSettings() });
    if (!response?.success) throw new Error(response?.error || 'No response from the background script.');
    if (response.models.length === 0) throw new Error('The provider returned no models.');
    const recommended = pickRecommended(response.models, provider);
    fillModels(response.models, before, recommended);
    if (!before && recommended) els.modelSelect.value = recommended;
    setStatus(`${response.models.length} models loaded.`);
  } catch (err) {
    useModelText(before);
    setStatus(`Could not load models: ${err.message} Type a model id instead.`, { sticky: true, error: true });
  } finally {
    els.loadModels.disabled = false;
  }
});

els.resetTaxonomy.addEventListener('click', () => {
  els.taxonomy.value = DEFAULT_SETTINGS.taxonomy.join('\n');
  selectedSubjects = normalizeSubjects(DEFAULT_SETTINGS.subjects); renderSubjects();
});

$('#subject-search').addEventListener('input', renderSubjects);
$('#refresh-categories').addEventListener('click', async () => {
  try { const categories = await fetchVideoCategories($('#youtube-api-key').value); catalog = [...categories, ...catalog.filter(s => s.source === 'topic')]; renderSubjects(); setStatus(`Loaded ${categories.length} assignable YouTube categories.`); }
  catch (err) { setStatus(`Category refresh failed: ${err.message}`, { sticky: true, error: true }); }
});
$('#add-subject').addEventListener('click', () => {
  const input = $('#custom-subject');
  if (!input.value.trim()) return;
  selectedSubjects = normalizeSubjects([...selectedSubjects, createSubject('custom', input.value.trim(), null, { priority: selectedSubjects.length })]);
  input.value = ''; renderSubjects();
});
$('#load-preset').addEventListener('click', () => {
   const preset = savedPresets.find(p => p.id === $('#preset-select').value);
   if (!preset) return;
   selectedSubjects = normalizeSubjects(preset.subjects); subjectSorts = structuredClone(preset.sort.subjectSorts || {}); els.sort.withinGroup.value = preset.sort.withinGroup;
   els.sort.secondaryWithinGroup.value = preset.sort.secondaryWithinGroup || 'playlist';
  $('#fallback-subject').value = preset.fallbackSubjectId || '';
  els.sort.inProgress.value = preset.sort.inProgress;
  els.sort.groupOrder.value = preset.sort.groupOrder;
  renderSubjects(); setStatus(`Loaded ${preset.name}. Save to keep these settings.`);
});
$('#save-preset').addEventListener('click', () => {
  const name = $('#preset-name').value.trim(); if (!name) { setStatus('Enter a preset name.', { error: true }); return; }
  const id = `preset:${name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
   const preset = { id, name, subjects: normalizeSubjects(selectedSubjects), fallbackSubjectId: $('#fallback-subject').value || null, sort: formSettings().sort };
  const index = savedPresets.findIndex(p => p.id === id); if (index >= 0) savedPresets[index] = preset; else savedPresets.push(preset);
  renderPresetChoices(id); setStatus('Preset saved. Save settings to persist it.');
});
$('#remove-preset').addEventListener('click', () => {
  const id = $('#preset-select').value; savedPresets = savedPresets.filter(p => p.id !== id);
  renderPresetChoices();
  setStatus('Preset removed. Save settings to persist the change.');
});
$('#export-settings').addEventListener('click', async () => {
  const settings = await loadSettings();
  const blob = new Blob([exportConfiguration({ ...settings, ...formSettings() })], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'youtube-playlist-organizer-settings.json'; link.click(); URL.revokeObjectURL(link.href);
});
$('#import-settings').addEventListener('change', async (event) => {
  try { const settings = importConfiguration(await event.target.files[0].text()); const saved = await saveSettings(settings); render(saved); setStatus('Settings imported.'); }
  catch (err) { setStatus(`Import failed: ${err.message}`, { sticky: true, error: true }); }
});

$('#export-learning').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'EXPORT_LEARNED_PREFERENCES' });
  if (!result?.success) return setStatus('Could not export learned preferences.', { error: true });
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([result.text], { type: 'application/json' })); link.download = 'youtube-playlist-organizer-learned-preferences.json'; link.click(); URL.revokeObjectURL(link.href);
});
$('#import-learning').addEventListener('change', async event => {
  try { const text = await event.target.files[0].text(); const result = await chrome.runtime.sendMessage({ type: 'IMPORT_LEARNED_PREFERENCES', text }); if (!result.success) throw new Error(result.error); loadLearningDashboard(); setStatus('Learned preferences imported.'); }
  catch (error) { setStatus(`Import failed: ${error.message}`, { error: true }); }
});
$('#reset-learning').addEventListener('click', async () => { if (!confirm('Reset examples and learned rules? Video overrides will be preserved.')) return; await chrome.runtime.sendMessage({ type: 'RESET_LEARNED_PREFERENCES' }); loadLearningDashboard(); });

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const draft = formSettings();
  try {
    const saved = await saveSettings(draft);
    render(saved);
    setStatus('Saved.');
    await refreshAutomationStatus();
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, { sticky: true, error: true });
  }
});

loadSettings().then(async settings => {
  render(settings);
  await refreshAutomationStatus();
}).catch((err) => {
  render({ ...DEFAULT_SETTINGS });
  setStatus(`Could not load settings: ${err.message}`, { sticky: true, error: true });
});
