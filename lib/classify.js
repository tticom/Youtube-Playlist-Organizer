// lib/classify.js
import { TAXONOMY, MAX_NEW_CATEGORIES } from './taxonomy.js';
import { getProvider } from './providers.js';

export function buildPrompt(videos, options = {}) {
  const subjects = options.subjects?.length ? options.subjects : null;
  const taxonomy = subjects ? subjects.map(s => s.name) : (options.taxonomy ?? TAXONOMY);
  const maxNewCategories = subjects ? 0 : (options.maxNewCategories ?? MAX_NEW_CATEGORIES);
  const extraInstructions = String(options.extraInstructions ?? '').trim();

  const escape = (value) => String(value).replace(/"/g, '\\"');

  const list = videos
    .filter(v => !v.unavailable)
    .map(v => {
      const fields = [
        `id: "${escape(v.id)}"`,
        `title: "${escape(v.title)}"`,
        `channel: "${escape(v.channel)}"`,
      ];
      if (v.category) fields.push(`ytCategory: "${escape(v.category)}"`);
      if (v.description) fields.push(`description: "${escape(String(v.description).slice(0, 500))}"`);
      if (Array.isArray(v.topicIds) && v.topicIds.length) fields.push(`ytTopicIds: "${escape(v.topicIds.join(', '))}"`);
      return `- ${fields.join(', ')}`;
    })
    .join('\n');

  const descriptions = subjects ? `\nSubject guidance:\n${subjects.map(s => {
    const guidance = [s.description, s.instructions].map(value => String(value ?? '').trim()).filter(Boolean).join(' Classification instructions: ');
    const rules = s.rules || {};
    const ruleText = [
      Array.isArray(rules.includePhrases) && rules.includePhrases.length ? `Include phrases: ${rules.includePhrases.join(', ')}` : '',
      Array.isArray(rules.excludePhrases) && rules.excludePhrases.length ? `Exclude phrases: ${rules.excludePhrases.join(', ')}` : '',
      Array.isArray(rules.titlePhrases) && rules.titlePhrases.length ? `Title phrases: ${rules.titlePhrases.join(', ')}` : '',
    ].filter(Boolean).join('. ');
    return `- ${s.name}: ${[guidance || 'No additional guidance.', ruleText].filter(Boolean).join(' Rules: ')}`;
  }).join('\n')}\n` : '';
  const fallback = subjects?.find(s => s.id === options.fallbackSubjectId)?.name
    || subjects?.find(s => s.name.toLocaleLowerCase() === 'other / uncategorised')?.name
    || 'Other';
  const extra = extraInstructions
    ? `\nAdditional instructions from the user:\n${extraInstructions}\n`
    : '';

  return `You are organizing a YouTube Watch Later playlist. Assign each video to one category.

Prefer these categories:
${taxonomy.map(name => `- ${name}`).join('\n')}

Rules:
- Each video belongs to exactly one category
- Strongly prefer the categories above
- ${subjects ? `Do not invent categories. Use only the selected subjects. Put uncertain items in "${fallback}".` : `You may introduce at most ${maxNewCategories} new categories, but only when a video genuinely fits none of them`}
- Use title, channel, description and YouTube's category as combined evidence. Never decide from channel name alone.
- Prefer the most specific applicable subject. If uncertain, use "Other / Uncategorised".
- ytCategory is YouTube's own label. It is coarse and sometimes wrong — treat it as a hint, not an answer
- Return ONLY valid JSON, no explanation
${descriptions}${extra}
Videos:
${list}

Return JSON in this exact format:
{"clusters":[{"name":"Category Name","videoIds":["id1","id2"]}]}`;
}

export function parseClusters(text) {
  let json = text.trim();

  const fenced = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) json = fenced[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Failed to parse cluster JSON: ${json.slice(0, 100)}`);
  }

  if (!parsed.clusters || !Array.isArray(parsed.clusters)) {
    throw new Error('Missing "clusters" array in response');
  }

  parsed.clusters.forEach((cluster, index) => {
    if (typeof cluster?.name !== 'string' || cluster.name.length === 0) {
      throw new Error(`Invalid cluster at index ${index}: "name" must be a non-empty string, got ${JSON.stringify(cluster?.name)}`);
    }
    if (!Array.isArray(cluster.videoIds)) {
      throw new Error(`Invalid cluster at index ${index} ("${cluster.name}"): "videoIds" must be an array, got ${typeof cluster.videoIds}`);
    }
  });

  return parsed;
}

function resolveProvider(settings, { requireModel = true } = {}) {
  const provider = getProvider(settings?.provider);
  if (!provider) throw new Error(`Unknown provider: ${settings?.provider}`);
  const baseUrl = String(settings.baseUrl || provider.baseUrl).replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`${provider.label}: no base URL configured.`);
  const apiKey = String(settings.apiKey || '').trim();
  if (provider.needsKey && !apiKey) {
    throw new Error(`${provider.label}: no API key configured.`);
  }
  const model = settings.model || provider.defaultModel;
  if (requireModel && !model) throw new Error(`${provider.label}: no model configured.`);
  return { provider, baseUrl, apiKey, model };
}

function headersFor(provider, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.kind === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // Anthropic refuses browser-originated requests unless the caller opts in.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

async function requestJson(provider, url, init, fetchImpl) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${provider.label} API error (${response.status}): ${body.slice(0, 300)}`);
  }
  return response.json();
}

export async function categorizeVideos(settings, videos, fetchImpl = fetch) {
  const { provider, baseUrl, apiKey, model } = resolveProvider(settings);
  const content = buildPrompt(videos, settings);
  const headers = headersFor(provider, apiKey);

  let text;
  if (provider.kind === 'anthropic') {
    const data = await requestJson(provider, `${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content }] }),
    }, fetchImpl);
    text = data?.content?.[0]?.text;
  } else {
    const data = await requestJson(provider, `${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0 }),
    }, fetchImpl);
    text = data?.choices?.[0]?.message?.content;
  }

  if (typeof text !== 'string') {
    throw new Error(`${provider.label} returned no text content.`);
  }
  return parseClusters(text);
}

export async function listModels(settings, fetchImpl = fetch) {
  const { provider, baseUrl, apiKey } = resolveProvider(settings, { requireModel: false });
  const path = provider.kind === 'anthropic' ? '/v1/models' : '/models';
  const data = await requestJson(provider, `${baseUrl}${path}`, {
    method: 'GET',
    headers: headersFor(provider, apiKey),
  }, fetchImpl);
  const ids = (data?.data || [])
    .map(entry => entry?.id)
    .filter(id => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].sort();
}
