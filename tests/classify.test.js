// tests/classify.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseClusters, categorizeVideos, listModels } from '../lib/classify.js';
import { TAXONOMY } from '../lib/taxonomy.js';

function video(overrides = {}) {
  return {
    id: 'v1', title: 'A Title', channel: 'A Channel',
    duration: 600, category: 'Science & Technology',
    description: 'A description.', unavailable: false,
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('lists every taxonomy category', () => {
    const prompt = buildPrompt([video()]);
    for (const name of TAXONOMY) assert.ok(prompt.includes(name), `missing ${name}`);
  });

  it('includes id, title, channel and category for each video', () => {
    const prompt = buildPrompt([video({ id: 'abc', title: 'Sushi', channel: 'Atlas Obscura' })]);
    assert.ok(prompt.includes('abc'));
    assert.ok(prompt.includes('Sushi'));
    assert.ok(prompt.includes('Atlas Obscura'));
    assert.ok(prompt.includes('Science & Technology'));
  });

  it('omits the category field when enrichment failed', () => {
    const prompt = buildPrompt([video({ category: null })]);
    assert.ok(!prompt.includes('ytCategory: "null"'));
  });

  it('escapes double quotes in titles', () => {
    const prompt = buildPrompt([video({ title: 'He said "hello"' })]);
    assert.ok(prompt.includes('\\"hello\\"'));
  });

  it('excludes unavailable videos, which have nothing to classify', () => {
    const prompt = buildPrompt([video({ id: 'ok' }), video({ id: 'ghost', unavailable: true })]);
    assert.ok(prompt.includes('ok'));
    assert.ok(!prompt.includes('ghost'));
  });

  it('uses a custom taxonomy and new-category limit when given', () => {
    const prompt = buildPrompt([video()], { taxonomy: ['Knitting', 'Woodwork'], maxNewCategories: 0 });
    assert.ok(prompt.includes('- Knitting\n- Woodwork'));
    assert.ok(prompt.includes('at most 0 new categories'));
    assert.ok(!prompt.includes('Music'));
  });

  it('includes both subject descriptions and explicit classification instructions', () => {
    const prompt = buildPrompt([video()], {
      subjects: [{ id: 'custom:physics', name: 'Physics', description: 'Physical sciences.', instructions: 'Prefer this to general science when relevant.' }],
    });
    assert.ok(prompt.includes('- Physics: Physical sciences. Classification instructions: Prefer this to general science when relevant.'));
  });

  it('appends extra instructions only when non-empty', () => {
    const withExtra = buildPrompt([video()], { extraInstructions: 'Keep cooking and baking separate' });
    assert.ok(withExtra.includes('Additional instructions from the user:\nKeep cooking and baking separate'));
    const without = buildPrompt([video()], { extraInstructions: '   ' });
    assert.ok(!without.includes('Additional instructions'));
  });
});

describe('parseClusters', () => {
  it('parses bare JSON', () => {
    const result = parseClusters('{"clusters":[{"name":"Music","videoIds":["a"]}]}');
    assert.equal(result.clusters[0].name, 'Music');
  });

  it('parses JSON inside a fenced code block', () => {
    const result = parseClusters('```json\n{"clusters":[{"name":"Music","videoIds":["a"]}]}\n```');
    assert.equal(result.clusters[0].name, 'Music');
  });

  it('parses a fenced block with no language tag', () => {
    const result = parseClusters('```\n{"clusters":[]}\n```');
    assert.deepEqual(result.clusters, []);
  });

  it('throws a useful error on malformed JSON', () => {
    assert.throws(() => parseClusters('not json at all'), /Failed to parse cluster JSON/);
  });

  it('throws when the clusters array is missing', () => {
    assert.throws(() => parseClusters('{"groups":[]}'), /Missing "clusters" array/);
  });

  it('throws when a cluster videoIds is a string instead of an array', () => {
    assert.throws(
      () => parseClusters('{"clusters":[{"name":"Music","videoIds":"abc123"}]}'),
      /Invalid cluster at index 0.*"videoIds" must be an array, got string/
    );
  });

  it('throws when a cluster videoIds is absent', () => {
    assert.throws(
      () => parseClusters('{"clusters":[{"name":"Music"}]}'),
      /Invalid cluster at index 0.*"videoIds" must be an array, got undefined/
    );
  });

  it('throws when a cluster name is missing', () => {
    assert.throws(
      () => parseClusters('{"clusters":[{"videoIds":["a"]}]}'),
      /Invalid cluster at index 0.*"name" must be a non-empty string/
    );
  });

  it('throws when a cluster name is empty', () => {
    assert.throws(
      () => parseClusters('{"clusters":[{"name":"","videoIds":["a"]}]}'),
      /Invalid cluster at index 0.*"name" must be a non-empty string/
    );
  });
});

function fakeFetch(reply, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok,
      status,
      json: async () => reply,
      text: async () => (typeof reply === 'string' ? reply : JSON.stringify(reply)),
    };
  };
  return { fetchImpl, calls };
}

const CLUSTER_TEXT = '{"clusters":[{"name":"Music","videoIds":["v1"]}]}';

describe('categorizeVideos', () => {
  it('posts to the Anthropic Messages API and reads content[0].text', async () => {
    const { fetchImpl, calls } = fakeFetch({ content: [{ type: 'text', text: CLUSTER_TEXT }] });
    const settings = { provider: 'anthropic', apiKey: 'sk-ant-test', baseUrl: '', model: '' };

    const result = await categorizeVideos(settings, [video()], fetchImpl);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-test');
    assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
    assert.equal(calls[0].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(calls[0].body.model, 'claude-haiku-4-5-20251001');
    assert.equal(calls[0].body.stream, undefined, 'streaming was dropped');
    assert.equal(calls[0].body.messages[0].role, 'user');
    assert.ok(calls[0].body.messages[0].content.includes('A Title'));
    assert.equal(result.clusters[0].name, 'Music');
  });

  it('posts to an OpenAI-compatible chat/completions endpoint with a bearer token', async () => {
    const { fetchImpl, calls } = fakeFetch({ choices: [{ message: { role: 'assistant', content: CLUSTER_TEXT } }] });
    const settings = { provider: 'openai', apiKey: 'sk-test', baseUrl: '', model: 'gpt-5-nano' };

    const result = await categorizeVideos(settings, [video()], fetchImpl);

    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
    assert.equal(calls[0].init.headers['x-api-key'], undefined);
    assert.equal(calls[0].body.model, 'gpt-5-nano');
    assert.equal(calls[0].body.temperature, 0);
    assert.equal(result.clusters[0].videoIds[0], 'v1');
  });

  it('omits the Authorization header for a keyless provider and honours a custom base URL', async () => {
    const { fetchImpl, calls } = fakeFetch({ choices: [{ message: { content: CLUSTER_TEXT } }] });
    const settings = { provider: 'ollama', apiKey: '', baseUrl: 'http://box.local:11434/v1/', model: '' };

    await categorizeVideos(settings, [video()], fetchImpl);

    assert.equal(calls[0].url, 'http://box.local:11434/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(calls[0].body.model, 'llama3.2');
  });

  it('passes the taxonomy and extra instructions from settings into the prompt', async () => {
    const { fetchImpl, calls } = fakeFetch({ content: [{ text: CLUSTER_TEXT }] });
    const settings = {
      provider: 'anthropic', apiKey: 'k', taxonomy: ['Knitting'], maxNewCategories: 1,
      extraInstructions: 'Be terse',
    };

    await categorizeVideos(settings, [video()], fetchImpl);

    const content = calls[0].body.messages[0].content;
    assert.ok(content.includes('- Knitting'));
    assert.ok(content.includes('at most 1 new'));
    assert.ok(content.includes('Be terse'));
  });

  it('rejects before fetching when a key-requiring provider has no key', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await assert.rejects(
      categorizeVideos({ provider: 'anthropic', apiKey: '' }, [video()], fetchImpl),
      /Anthropic: no API key configured/,
    );
    assert.equal(calls.length, 0);
  });

  it('rejects an unknown provider', async () => {
    await assert.rejects(categorizeVideos({ provider: 'bogus', apiKey: 'k' }, [video()]), /Unknown provider/);
  });

  it('rejects a custom provider with no base URL', async () => {
    await assert.rejects(
      categorizeVideos({ provider: 'custom', apiKey: 'k', model: 'm' }, [video()]),
      /no base URL/,
    );
  });

  it('reports non-OK responses with the provider label, status and truncated body', async () => {
    const longBody = 'x'.repeat(500);
    const { fetchImpl } = fakeFetch(longBody, { ok: false, status: 429 });
    await assert.rejects(
      categorizeVideos({ provider: 'openrouter', apiKey: 'k' }, [video()], fetchImpl),
      (err) => {
        assert.ok(err.message.startsWith('OpenRouter API error (429): '));
        assert.equal(err.message.length, 'OpenRouter API error (429): '.length + 300);
        return true;
      },
    );
  });

  it('rejects when the response has no text content', async () => {
    const { fetchImpl } = fakeFetch({ choices: [] });
    await assert.rejects(
      categorizeVideos({ provider: 'openai', apiKey: 'k' }, [video()], fetchImpl),
      /returned no text content/,
    );
  });
});

describe('listModels', () => {
  it('GETs /v1/models for Anthropic with the same headers and returns sorted ids', async () => {
    const { fetchImpl, calls } = fakeFetch({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5-20251001' }] });

    const models = await listModels({ provider: 'anthropic', apiKey: 'sk-ant-test' }, fetchImpl);

    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-test');
    assert.equal(calls[0].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.deepEqual(models, ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5']);
  });

  it('GETs /models for OpenAI-compatible providers and de-duplicates ids', async () => {
    const { fetchImpl, calls } = fakeFetch({ object: 'list', data: [{ id: 'llama3.2' }, { id: 'gemma' }, { id: 'llama3.2' }, { object: 'noise' }] });

    const models = await listModels({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1' }, fetchImpl);

    assert.equal(calls[0].url, 'http://localhost:11434/v1/models');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.deepEqual(models, ['gemma', 'llama3.2']);
  });

  it('does not require a model to be chosen yet', async () => {
    const { fetchImpl } = fakeFetch({ data: [{ id: 'm' }] });
    assert.deepEqual(await listModels({ provider: 'custom', apiKey: 'k', baseUrl: 'https://x.test/v1' }, fetchImpl), ['m']);
  });

  it('surfaces non-OK responses with the provider label', async () => {
    const { fetchImpl } = fakeFetch('{"error":"bad key"}', { ok: false, status: 401 });
    await assert.rejects(
      listModels({ provider: 'openai', apiKey: 'k' }, fetchImpl),
      /OpenAI API error \(401\): \{"error":"bad key"\}/,
    );
  });
});
