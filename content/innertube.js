// content/innertube.js
// The only module that knows about YouTube's internal API.
// Loaded as a content script global — no imports, no exports.

class InnerTubeError extends Error {
  constructor(endpoint, status, snippet) {
    super(`InnerTube ${endpoint} failed (${status}): ${snippet}`);
    this.name = 'InnerTubeError';
    this.endpoint = endpoint;
    this.status = status;
    this.snippet = snippet;
  }
}

const WLInnerTube = {
  ORIGIN: 'https://www.youtube.com',
  _config: null,

  /** Pull InnerTube client config from page HTML. Pure — takes source, returns config. */
  parseConfig(source) {
    const pick = (re) => {
      const match = source.match(re);
      return match ? match[1] : null;
    };
    return {
      apiKey: pick(/"INNERTUBE_API_KEY":"(.*?)"/),
      clientName: pick(/"INNERTUBE_CLIENT_NAME":"(.*?)"/) || 'WEB',
      clientVersion: pick(/"INNERTUBE_CLIENT_VERSION":"(.*?)"/),
      delegatedSessionId: pick(/"DELEGATED_SESSION_ID":"(.*?)"/),
      // Which of the signed-in Google accounts this page belongs to. Every
      // account in the profile shares the SAPISID cookie, so without this
      // index InnerTube answers for account 0, the first one signed in.
      sessionIndex: pick(/"SESSION_INDEX":"(\d+)"/) || '0',
    };
  },

  /** Scan inline script text only — YouTube's full innerHTML is multiple MB. */
  getConfig() {
    if (this._config) return this._config;

    const scripts = [...document.querySelectorAll('script')]
      .map(s => s.textContent || '')
      .filter(t => t.includes('INNERTUBE_API_KEY'));
    const source = scripts.length ? scripts.join('\n') : document.documentElement.innerHTML;

    this._config = this.parseConfig(source);
    return this._config;
  },

  /** Clear the memoized config cache. Required for SPA navigation and account switches. */
  resetConfig() {
    this._config = null;
  },

  readCookie(name) {
    const match = document.cookie.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`));
    return match ? match[2] : null;
  },

  async sha1Hex(input) {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /** Google's scheme: SHA1("<unix seconds> <SAPISID> <origin>"). */
  async buildAuthHeader(sapisid, timestamp, origin) {
    const hash = await this.sha1Hex(`${timestamp} ${sapisid} ${origin}`);
    return `SAPISIDHASH ${timestamp}_${hash}`;
  },

  /** Live auth from the page's cookie jar. Returns null when no cookie is readable. */
  async currentAuth() {
    const sapisid =
      this.readCookie('SAPISID') ||
      this.readCookie('__Secure-3PAPISID') ||
      this.readCookie('__Secure-1PAPISID');
    if (!sapisid) return null;
    return this.buildAuthHeader(sapisid, Math.floor(Date.now() / 1000), this.ORIGIN);
  },

  /** Recursively collect every value stored under `key`. */
  findAll(obj, key, found = []) {
    if (obj === null || typeof obj !== 'object') return found;
    if (Array.isArray(obj)) {
      for (const value of obj) this.findAll(value, key, found);
      return found;
    }
    for (const [k, value] of Object.entries(obj)) {
      if (k === key) found.push(value);
      this.findAll(value, key, found);
    }
    return found;
  },

  /**
   * The feed's "load more" token. Responses carry several continuationCommands
   * for unrelated widgets, so prefer the one under continuationItemRenderer.
   */
  nextToken(data) {
    for (const item of this.findAll(data, 'continuationItemRenderer')) {
      const commands = this.findAll(item, 'continuationCommand').filter(c => c && c.token);
      if (commands.length) return commands[0].token;
    }
    return null;
  },

  async call(endpoint, body) {
    const config = this.getConfig();
    const auth = await this.currentAuth();
    if (!auth) {
      throw new InnerTubeError(endpoint, 0, 'no readable SAPISID cookie — are you signed in?');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': auth,
      'X-Goog-AuthUser': config.sessionIndex || '0',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': config.clientVersion || '',
    };
    if (config.delegatedSessionId) headers['X-Goog-PageId'] = config.delegatedSessionId;

    const url = `${this.ORIGIN}/youtubei/v1/${endpoint}?key=${config.apiKey}&prettyPrint=false`;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          context: {
            client: {
              clientName: config.clientName,
              clientVersion: config.clientVersion,
              hl: 'en',
              gl: 'US',
            },
          },
          ...body,
        }),
      });
    } catch (err) {
      throw new InnerTubeError(endpoint, 0, String(err));
    }

    if (!response.ok) {
      const text = await response.text();
      throw new InnerTubeError(endpoint, response.status, text.slice(0, 200));
    }
    return response.json();
  },

  /** Follow continuations, returning every page's raw response. */
  async pageAll(body, maxPages = 20) {
    const first = await this.call('browse', body);
    const pages = [first];

    let token = this.nextToken(first);
    const seen = new Set();

    for (let page = 1; page < maxPages && token; page++) {
      if (seen.has(token)) throw new Error('Playlist paging repeated a continuation token; refusing an incomplete read.');
      seen.add(token);

      const next = await this.call('browse', { continuation: token });
      pages.push(next);
      token = this.nextToken(next);
    }
    if (token) throw new Error(`Playlist exceeds the safe ${maxPages}-page retrieval limit; refusing to use a partial playlist.`);
    return pages;
  },
};
