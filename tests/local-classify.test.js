import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocally } from '../lib/local-classify.js';
import { PERSONAL_PRESET } from '../lib/configuration.js';

const subjects = [
  { id: 'news', name: 'News', priority: 0, rules: { includePhrases: ['election results', 'current affairs'] } },
  { id: 'music', name: 'Music History / Commentary', priority: 1, rules: { includePhrases: ['pink floyd', 'music history'] } },
  { id: 'biblical-history', name: 'Biblical History / Documentary', priority: 2, rules: { includePhrases: ['ancient israel', 'archaeological discoveries'] } },
  { id: 'biblical-explanation', name: 'Biblical Explanation', priority: 3, rules: { includePhrases: ['rabbi sacks', 'parashah', 'torah commentary'] } },
  { id: 'physics', name: 'Physics', priority: 4, rules: { includePhrases: ['quantum entanglement', 'cosmology'] } },
  { id: 'ai', name: 'AI Skills & News', priority: 5, rules: { includePhrases: ['openai model', 'langgraph'] } },
  { id: 'other', name: 'Other / Uncategorised', priority: 6, rules: {} },
];
const classify = title => classifyLocally({ id: 'v', title, channel: 'General Channel', description: '' }, subjects, { fallbackSubjectId: 'other' });

describe('local classification', () => {
  it('uses configured keywords for representative subjects without a provider', () => {
    assert.equal(classify('History of Pink Floyd').subjectId, 'music');
    assert.equal(classify('Ancient Israel archaeological discoveries').subjectId, 'biblical-history');
    assert.equal(classify('Rabbi Sacks explains Genesis').subjectId, 'biblical-explanation');
    assert.equal(classify('Quantum entanglement explained').subjectId, 'physics');
    assert.equal(classify('New OpenAI model released').subjectId, 'ai');
    assert.equal(classify('UK election results').subjectId, 'news');
  });
  it('ships usable local rules in the selectable Niall preset', () => {
    const title = 'New OpenAI model released';
    const result = classifyLocally({ id: 'niall-example', title }, PERSONAL_PRESET.subjects, { fallbackSubjectId: PERSONAL_PRESET.fallbackSubjectId });
    assert.equal(result.name, 'AI Skills & News');
    assert.equal(result.source, 'local-rules');
  });
  it('returns fallback for unknown and ambiguous titles', () => {
    assert.equal(classify('A walk through the countryside').subjectId, 'other');
    assert.equal(classify('Ancient Israel: Rabbi Sacks discusses history').subjectId, 'other');
  });
  it('applies exclusions and approved learned rules after manual overrides', () => {
    const custom = [{ id: 'x', name: 'Physics', rules: { includePhrases: ['quantum'], excludePhrases: ['fiction'] } }, subjects[6]];
    const args = { fallbackSubjectId: 'other', approvedRules: [{ id: 'lr', subjectId: 'x', field: 'title', phrase: 'model announcement', enabled: true }] };
    assert.equal(classifyLocally({ id: 'v', title: 'Quantum fiction', channel: '' }, custom, args).subjectId, 'other');
    assert.equal(classifyLocally({ id: 'v', title: 'Model announcement', channel: '' }, custom, args).subjectId, 'x');
    assert.equal(classifyLocally({ id: 'v', title: '', channel: '' }, custom, { ...args, overrides: { v: 'x' } }).source, 'manual-override');
  });
  it('does not select a channel rule by itself as strong classification evidence', () => {
    const result = classifyLocally({ id: 'v', title: 'Unrelated topic', channel: 'Physics Weekly' }, [{ id: 'p', name: 'Physics', rules: { channelRules: ['Physics Weekly'] } }, subjects[6]], { fallbackSubjectId: 'other' });
    assert.equal(result.subjectId, 'other');
  });
});
