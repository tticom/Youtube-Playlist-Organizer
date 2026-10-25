import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLearningState, recordClassificationFeedback, generateRuleSuggestions, reviewSuggestion, recordSortingChoice, resetLearnedPreferences, exportLearningPreferences, importLearningPreferences } from '../lib/learning.js';

const example = (id, title, subjectId = 'explain', corrected = true) => ({ videoId: id, title, channel: 'Mixed Channel', subjectId, originalSubjectId: corrected ? 'history' : subjectId, corrected, confirmed: true });

describe('adaptive learning', () => {
  it('records persistent user-confirmed corrections and replaces duplicate video examples', () => {
    let state = recordClassificationFeedback({}, { id: 'v1', title: 'Parashah commentary', channel: 'Mixed', description: '' }, { originalSubjectId: 'history', correctedSubjectId: 'explain', confirmed: true });
    assert.equal(state.examples[0].corrected, true);
    state = recordClassificationFeedback(state, { id: 'v1', title: 'Parashah commentary', channel: 'Mixed', description: '' }, { originalSubjectId: 'history', correctedSubjectId: 'explain', confirmed: true });
    assert.equal(state.examples.length, 1);
  });
  it('suggests recurring title phrases only after the evidence threshold and with conflict checks', () => {
    const weak = createLearningState({ examples: [example('1', 'Parashah notes')] });
    assert.equal(generateRuleSuggestions(weak, { minimumEvidence: 3 }).suggestions.length, 0);
    const enough = createLearningState({ examples: [example('1', 'Parashah commentary'), example('2', 'Weekly Parashah notes'), example('3', 'Parashah lesson'), example('4', 'Parashah with examples')] });
    const suggestions = generateRuleSuggestions(enough, { minimumEvidence: 3, minimumConsistency: 0.8 }).suggestions;
    assert.ok(suggestions.some(s => s.phrase === 'parashah' && s.subjectId === 'explain'));
    const conflicted = createLearningState({ examples: [...enough.examples, example('5', 'Parashah archaeology', 'history', false)] });
    assert.ok(!generateRuleSuggestions(conflicted, { minimumEvidence: 3, minimumConsistency: 0.85 }).suggestions.some(s => s.phrase === 'parashah'));
  });
  it('proposes multiword title phrases and checks their specific slot', () => {
    const state = createLearningState({ examples: [
      example('1', 'Quantum entanglement basics'), example('2', 'Quantum entanglement explained'),
      example('3', 'Quantum entanglement experiments'), example('4', 'Quantum entanglement theories'),
    ] });
    const suggestion = generateRuleSuggestions(state, { minimumEvidence: 3 }).suggestions.find(s => s.phrase === 'quantum entanglement');
    assert.ok(suggestion);
    let sorting = {};
    for (let i = 0; i < 3; i++) sorting = recordSortingChoice(sorting, { group: 'Music History', slot: 'secondaryWithinGroup', field: 'duration-desc', explicit: true }).state;
    assert.equal(sorting.suggestions[0].slot, 'secondaryWithinGroup');
    assert.equal(createLearningState(sorting).sortingChoices[0].slot, 'secondaryWithinGroup');
  });
  it('does not propose broad channel rules and remembers rejected suggestions', () => {
    const state = createLearningState({ examples: Array.from({ length: 4 }, (_, i) => example(String(i), `Distinct topic word${i} Parashah`, 'explain')) });
    let next = generateRuleSuggestions(state, { minimumEvidence: 3 });
    const suggestion = next.suggestions.find(s => s.phrase === 'parashah');
    assert.ok(suggestion);
    next = reviewSuggestion(next, suggestion.id, 'reject');
    assert.ok(next.rejected.some(s => s.id === suggestion.id));
    assert.ok(!generateRuleSuggestions(next, { minimumEvidence: 3 }).suggestions.some(s => s.id === suggestion.id));
  });
  it('accepts, disables by reset, exports/imports, and preserves separate manual overrides by design', () => {
    let state = generateRuleSuggestions({ examples: [example('1', 'Parashah'), example('2', 'Parashah'), example('3', 'Parashah')] }, { minimumEvidence: 3 });
    const suggestion = state.suggestions.find(s => s.phrase === 'parashah');
    state = reviewSuggestion(state, suggestion.id, 'accept');
    assert.equal(state.rules[0].enabled, true);
    const restored = importLearningPreferences(exportLearningPreferences(state));
    assert.equal(restored.rules[0].phrase, 'parashah');
    assert.equal(resetLearnedPreferences(restored).rules.length, 0);
  });
  it('learns sorting only from explicitly attributed repeated choices', () => {
    let state = {};
    for (let i = 0; i < 3; i++) state = recordSortingChoice(state, { group: '*', field: 'duration-desc', explicit: true }).state;
    assert.equal(state.suggestions[0].type, 'sorting');
    assert.equal(recordSortingChoice({}, { group: '*', field: 'duration-desc', explicit: false }).state.sortingChoices.length, 0);
  });
});
