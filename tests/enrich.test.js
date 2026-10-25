// tests/enrich.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load-global.js';

function load(innerTube = {}) {
  return loadGlobal('content/enrich.js', 'WLEnrich', { WLInnerTube: innerTube });
}

function playerResponse(overrides = {}) {
  return {
    videoDetails: { shortDescription: 'A description.', ...overrides.videoDetails },
    microformat: { playerMicroformatRenderer: { category: 'Science & Technology', ...overrides.micro } },
  };
}

describe('WLEnrich.extract', () => {
  it('pulls category and description', () => {
    const { category, description } = load().extract(playerResponse());
    assert.equal(category, 'Science & Technology');
    assert.equal(description, 'A description.');
  });

  it('pulls available topic IDs without requiring them to be present', () => {
    const { topicIds } = load({ findAll: (value, key) => key === 'topicIds' ? [value.videoDetails?.topicDetails?.topicIds || []] : [] })
      .extract(playerResponse({ videoDetails: { topicDetails: { topicIds: ['/m/02vxn', '/m/07c1v'] } } }));
    assert.deepEqual(Array.from(topicIds), ['/m/02vxn', '/m/07c1v']);
  });

  it('truncates long descriptions to MAX_DESCRIPTION', () => {
    const enrich = load();
    const long = 'x'.repeat(1000);
    const { description } = enrich.extract(playerResponse({ videoDetails: { shortDescription: long } }));
    assert.equal(description.length, enrich.MAX_DESCRIPTION);
  });

  it('returns nulls when fields are absent', () => {
    const { category, description } = load().extract({});
    assert.equal(category, null);
    assert.equal(description, null);
  });
});

describe('WLEnrich.enrich', () => {
  it('populates every video', async () => {
    const enrich = load({ call: async () => playerResponse() });
    const videos = [
      { id: 'a', category: null, description: null },
      { id: 'b', category: null, description: null },
    ];
    await enrich.enrich(videos, { concurrency: 2 });
    assert.equal(videos[0].category, 'Science & Technology');
    assert.deepEqual(Array.from(videos[0].topicIds), []);
    assert.equal(videos[1].category, 'Science & Technology');
  });

  it('leaves fields null when a call fails, without rejecting', async () => {
    const enrich = load({
      call: async (endpoint, body) => {
        if (body.videoId === 'b') throw new Error('boom');
        return playerResponse();
      },
    });
    const videos = [
      { id: 'a', category: null, description: null },
      { id: 'b', category: null, description: null },
    ];
    await enrich.enrich(videos, { concurrency: 2 });
    assert.equal(videos[0].category, 'Science & Technology');
    assert.equal(videos[1].category, null);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const enrich = load({
      call: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return playerResponse();
      },
    });
    const videos = Array.from({ length: 12 }, (_, i) => ({ id: `v${i}`, category: null, description: null }));
    await enrich.enrich(videos, { concurrency: 3 });
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });

  it('skips unavailable videos, which have nothing to fetch', async () => {
    let calls = 0;
    const enrich = load({ call: async () => { calls++; return playerResponse(); } });
    await enrich.enrich([{ id: 'a', unavailable: true, category: null, description: null }]);
    assert.equal(calls, 0);
  });

  it('logs failures but continues enriching other videos', async () => {
    const warns = [];
    const mockConsole = {
      warn: (...args) => warns.push(args),
    };
    const enrich = loadGlobal('content/enrich.js', 'WLEnrich', {
      WLInnerTube: {
        call: async (endpoint, body) => {
          if (body.videoId === 'b') throw new Error('boom');
          return playerResponse();
        },
      },
      console: mockConsole,
    });
    const videos = [
      { id: 'a', category: null, description: null },
      { id: 'b', category: null, description: null },
      { id: 'c', category: null, description: null },
    ];
    await enrich.enrich(videos, { concurrency: 2 });
    assert.equal(videos[0].category, 'Science & Technology');
    assert.equal(videos[1].category, null);
    assert.equal(videos[2].category, 'Science & Technology');
    assert.equal(warns.length, 1);
    assert.ok(warns[0][0].includes('enrichment failed for b'), `expected log to include video id 'b', got: ${warns[0][0]}`);
  });
});
