// tests/innertube.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load-global.js';

function load(sandbox = {}) {
  return loadGlobal('content/innertube.js', 'WLInnerTube', sandbox);
}

describe('WLInnerTube.parseConfig', () => {
  const source = `
    ytcfg.set({"INNERTUBE_API_KEY":"AIzaSyTEST","INNERTUBE_CLIENT_NAME":"WEB",
    "INNERTUBE_CLIENT_VERSION":"2.20260724.01.01","DELEGATED_SESSION_ID":"sess123",
    "SESSION_INDEX":"2"});
  `;

  it('extracts every config field', () => {
    const config = load().parseConfig(source);
    assert.equal(config.apiKey, 'AIzaSyTEST');
    assert.equal(config.clientName, 'WEB');
    assert.equal(config.clientVersion, '2.20260724.01.01');
    assert.equal(config.delegatedSessionId, 'sess123');
    assert.equal(config.sessionIndex, '2');
  });

  it('defaults sessionIndex to 0 when the page does not state one', () => {
    assert.equal(load().parseConfig('{"INNERTUBE_API_KEY":"k"}').sessionIndex, '0');
  });

  it('defaults clientName to WEB when absent', () => {
    const config = load().parseConfig('{"INNERTUBE_API_KEY":"k"}');
    assert.equal(config.clientName, 'WEB');
  });

  it('returns null for missing fields rather than throwing', () => {
    const config = load().parseConfig('nothing useful here');
    assert.equal(config.apiKey, null);
    assert.equal(config.delegatedSessionId, null);
  });
});

describe('WLInnerTube.sha1Hex', () => {
  it('matches the known SHA-1 vector for "abc"', async () => {
    const hash = await load().sha1Hex('abc');
    assert.equal(hash, 'a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('produces 40 lowercase hex characters', async () => {
    const hash = await load().sha1Hex('anything at all');
    assert.match(hash, /^[0-9a-f]{40}$/);
  });
});

describe('WLInnerTube.buildAuthHeader', () => {
  it('formats as SAPISIDHASH <ts>_<sha1>', async () => {
    const header = await load().buildAuthHeader('SECRET', 1700000000, 'https://www.youtube.com');
    assert.match(header, /^SAPISIDHASH 1700000000_[0-9a-f]{40}$/);
  });

  it('hashes timestamp, sapisid and origin joined by spaces', async () => {
    const api = load();
    const expected = await api.sha1Hex('1700000000 SECRET https://www.youtube.com');
    const header = await api.buildAuthHeader('SECRET', 1700000000, 'https://www.youtube.com');
    assert.equal(header, `SAPISIDHASH 1700000000_${expected}`);
  });
});

describe('WLInnerTube.readCookie', () => {
  it('reads a cookie by name', () => {
    const api = load({ document: { cookie: 'A=1; SAPISID=abc123; B=2' } });
    assert.equal(api.readCookie('SAPISID'), 'abc123');
  });

  it('returns null when the cookie is absent', () => {
    const api = load({ document: { cookie: 'A=1' } });
    assert.equal(api.readCookie('SAPISID'), null);
  });

  it('does not match a cookie whose name is a suffix of another', () => {
    const api = load({ document: { cookie: '__Secure-3PAPISID=wrong; SAPISID=right' } });
    assert.equal(api.readCookie('SAPISID'), 'right');
  });
});

describe('WLInnerTube.getConfig / resetConfig', () => {
  it('memoizes — calling getConfig twice returns the identical object', () => {
    const document = {
      querySelectorAll: () => [
        { textContent: '{"INNERTUBE_API_KEY":"key1","DELEGATED_SESSION_ID":"sess1"}' }
      ],
      documentElement: { innerHTML: 'fallback' },
    };
    const api = load({ document });
    const config1 = api.getConfig();
    const config2 = api.getConfig();
    assert.strictEqual(config1, config2);
  });

  it('after resetConfig, the next getConfig re-reads and reflects changed content', () => {
    const document = {
      querySelectorAll: () => [
        { textContent: '{"INNERTUBE_API_KEY":"key1","DELEGATED_SESSION_ID":"sess1"}' }
      ],
      documentElement: { innerHTML: 'fallback' },
    };
    const api = load({ document });
    const config1 = api.getConfig();
    assert.equal(config1.delegatedSessionId, 'sess1');

    // Change the document content
    document.querySelectorAll = () => [
      { textContent: '{"INNERTUBE_API_KEY":"key2","DELEGATED_SESSION_ID":"sess2"}' }
    ];

    // Without reset, it would still return the memoized config
    api.resetConfig();
    const config2 = api.getConfig();
    assert.equal(config2.delegatedSessionId, 'sess2');
  });
});

describe('WLInnerTube.findAll', () => {
  it('finds values at any depth', () => {
    const api = load();
    const tree = { a: { b: [{ target: 1 }, { c: { target: 2 } }] } };
    assert.deepEqual([...api.findAll(tree, 'target')], [1, 2]);
  });

  it('returns an empty array when the key is absent', () => {
    assert.deepEqual([...load().findAll({ a: 1 }, 'missing')], []);
  });
});

describe('WLInnerTube.nextToken', () => {
  it('prefers the token under continuationItemRenderer, not the last token in tree order', () => {
    const api = load();
    const data = {
      contents: {
        continuationItemRenderer: {
          continuationEndpoint: { continuationCommand: { token: 'RIGHT' } },
        },
      },
      decoy: { continuationCommand: { token: 'WRONG' } },
      deepDecoy: {
        nested: {
          deeplyNested: { continuationCommand: { token: 'ALSO_WRONG' } },
        },
      },
    };
    // Verify the bug exists: a naive last-wins strategy would pick the wrong token
    const allTokens = api.findAll(data, 'continuationCommand');
    assert.ok(allTokens.length > 1, 'fixture should contain multiple continuationCommand objects');
    assert.notEqual(allTokens[allTokens.length - 1].token, 'RIGHT', 'last token in tree should not be the correct one');
    // Verify the correct implementation picks the right one
    assert.equal(api.nextToken(data), 'RIGHT');
  });

  it('returns null when there is no continuation', () => {
    assert.equal(load().nextToken({ contents: [] }), null);
  });

  it('ignores continuation entries with no token', () => {
    const data = { continuationItemRenderer: { continuationCommand: {} } };
    assert.equal(load().nextToken(data), null);
  });
});

describe('WLInnerTube.call', () => {
  function apiWithFetch(fetchImpl) {
    const api = load({ fetch: fetchImpl, document: { cookie: 'SAPISID=secret' } });
    api._config = { apiKey: 'K', clientName: 'WEB', clientVersion: '2.0', delegatedSessionId: null };
    return api;
  }

  it('returns parsed JSON on success', async () => {
    const api = apiWithFetch(async () => ({
      ok: true, status: 200, json: async () => ({ hello: 'world' }),
    }));
    assert.deepEqual(await api.call('browse', { browseId: 'VLWL' }), { hello: 'world' });
  });

  it('sends the auth header and credentials', async () => {
    let seen = null;
    const api = apiWithFetch(async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    await api.call('browse', { browseId: 'VLWL' });
    assert.match(seen.url, /youtubei\/v1\/browse\?key=K/);
    assert.match(seen.options.headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
    assert.equal(seen.options.credentials, 'include');
    assert.equal(seen.options.headers['X-Goog-AuthUser'], '0');
  });

  it('addresses the signed-in account the page belongs to, not account 0', async () => {
    // Regression: a second Google account in the same profile saw the first
    // account's Watch Later because X-Goog-AuthUser was hardcoded to 0.
    let seen = null;
    const api = apiWithFetch(async (url, options) => {
      seen = options;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    api._config.sessionIndex = '1';
    await api.call('browse', { browseId: 'VLWL' });
    assert.equal(seen.headers['X-Goog-AuthUser'], '1');
  });

  it('merges the client context into the body', async () => {
    let body = null;
    const api = apiWithFetch(async (url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({}) };
    });
    await api.call('browse', { browseId: 'VLWL' });
    assert.equal(body.browseId, 'VLWL');
    assert.equal(body.context.client.clientVersion, '2.0');
  });

  it('throws InnerTubeError carrying endpoint and status', async () => {
    const api = apiWithFetch(async () => ({
      ok: false, status: 404, text: async () => 'Requested entity was not found.',
    }));
    await assert.rejects(
      () => api.call('browse', {}),
      (err) => {
        assert.equal(err.name, 'InnerTubeError');
        assert.equal(err.endpoint, 'browse');
        assert.equal(err.status, 404);
        assert.match(err.snippet, /not found/);
        return true;
      }
    );
  });

  it('throws InnerTubeError when there is no readable cookie', async () => {
    const api = load({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
                       document: { cookie: '' } });
    api._config = { apiKey: 'K', clientName: 'WEB', clientVersion: '2.0' };
    await assert.rejects(() => api.call('browse', {}), /no readable SAPISID/i);
  });

  it('exercises getConfig() by scraping config from document when _config is not preset', async () => {
    let seenRequest = null;
    const configScript = `{"INNERTUBE_API_KEY":"scraped-key","INNERTUBE_CLIENT_NAME":"WEB","INNERTUBE_CLIENT_VERSION":"2.26.0"}`;
    const document = {
      querySelectorAll: () => [{ textContent: configScript }],
      documentElement: { innerHTML: 'fallback' },
      cookie: 'SAPISID=secret',
    };
    const api = load({
      fetch: async (url, options) => {
        seenRequest = { url, body: JSON.parse(options.body) };
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      },
      document,
    });
    // Do NOT preset api._config — force it to scan the document
    await api.call('browse', { browseId: 'VLWL' });
    assert.match(seenRequest.url, /key=scraped-key/, 'URL should contain the scraped API key');
    assert.equal(seenRequest.body.context.client.clientVersion, '2.26.0', 'body should contain the scraped client version');
  });
});

describe('WLInnerTube.pageAll', () => {
  it('follows continuations until exhausted', async () => {
    const pages = [
      { id: 1, continuationItemRenderer: { continuationCommand: { token: 't1' } } },
      { id: 2, continuationItemRenderer: { continuationCommand: { token: 't2' } } },
      { id: 3 },
    ];
    let call = 0;
    const api = load({
      fetch: async () => ({ ok: true, status: 200, json: async () => pages[call++] }),
      document: { cookie: 'SAPISID=secret' },
    });
    api._config = { apiKey: 'K', clientName: 'WEB', clientVersion: '2.0' };

    const result = await api.pageAll({ browseId: 'VLWL' });
    assert.equal(result.length, 3);
    assert.deepEqual([...result.map(p => p.id)], [1, 2, 3]);
  });

  it('fails closed when a continuation token repeats', async () => {
    const stuck = { id: 'x', continuationItemRenderer: { continuationCommand: { token: 'same' } } };
    const api = load({
      fetch: async () => ({ ok: true, status: 200, json: async () => stuck }),
      document: { cookie: 'SAPISID=secret' },
    });
    api._config = { apiKey: 'K', clientName: 'WEB', clientVersion: '2.0' };

    await assert.rejects(api.pageAll({ browseId: 'VLWL' }), /repeated a continuation token/);
  });
});
