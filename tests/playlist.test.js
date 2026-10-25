// tests/playlist.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load-global.js';

// Load the real WLInnerTube for its findAll — the single shared tree-walk that
// WLPlaylist depends on heavily. It touches `document`/`crypto` only inside methods
// we never call here (getConfig, currentAuth, etc.), so it's safe to load without
// stubbing those globals. call/pageAll are stubbed per-test as before.
const realInnerTube = loadGlobal('content/innertube.js', 'WLInnerTube', {});

function load(innerTube = {}, globals = {}) {
  const stub = {
    findAll: realInnerTube.findAll.bind(realInnerTube),
    ...innerTube,
  };
  return loadGlobal('content/playlist.js', 'WLPlaylist', { WLInnerTube: stub, ...globals });
}

function renderer(overrides = {}) {
  return {
    videoId: 'abc123',
    setVideoId: 'SET1',
    lengthSeconds: '520',
    title: { runs: [{ text: 'Some Video' }] },
    shortBylineText: { runs: [{ text: 'Some Channel' }] },
    thumbnailOverlays: [
      { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 32 } },
    ],
    ...overrides,
  };
}

describe('WLPlaylist.browseIdFor', () => {
  it('maps WL to VLWL', () => {
    assert.equal(load().browseIdFor('WL'), 'VLWL');
  });
  it('prefixes other playlists with VL', () => {
    assert.equal(load().browseIdFor('PLabc'), 'VLPLabc');
  });
});

describe('WLPlaylist.normalize', () => {
  it('extracts every field', () => {
    const video = load().normalize(renderer());
    assert.equal(video.id, 'abc123');
    assert.equal(video.setVideoId, 'SET1');
    assert.equal(video.title, 'Some Video');
    assert.equal(video.channel, 'Some Channel');
    assert.equal(video.duration, 520);
    assert.equal(video.percentWatched, 32);
    assert.equal(video.unavailable, false);
  });

  it('defaults percentWatched to 0 when there is no resume overlay', () => {
    const video = load().normalize(renderer({ thumbnailOverlays: [] }));
    assert.equal(video.percentWatched, 0);
  });

  it('initialises enrichment fields to null', () => {
    const video = load().normalize(renderer());
    assert.equal(video.category, null);
    assert.equal(video.description, null);
  });

  it('marks entries with no title as unavailable', () => {
    const video = load().normalize(renderer({ title: undefined }));
    assert.equal(video.unavailable, true);
    assert.equal(video.title, '[Unavailable]');
  });

  it('marks isPlayable:false as unavailable even when the title is present', () => {
    const video = load().normalize(
      renderer({ isPlayable: false, title: { runs: [{ text: 'Deleted video' }] } })
    );
    assert.equal(video.unavailable, true);
    assert.equal(video.title, 'Deleted video');
  });

  it('falls back to the falsy-title check when isPlayable is absent', () => {
    const input = renderer({ title: undefined });
    assert.equal('isPlayable' in input, false);
    const video = load().normalize(input);
    assert.equal(video.unavailable, true);
  });

  it('treats isPlayable:true with a normal title as available', () => {
    const video = load().normalize(renderer({ isPlayable: true }));
    assert.equal(video.unavailable, false);
  });

  it('treats an absent isPlayable with a normal title as available', () => {
    const input = renderer();
    assert.equal('isPlayable' in input, false);
    assert.equal(load().normalize(input).unavailable, false);
  });

  it('returns null when there is no setVideoId, since reorder is impossible', () => {
    assert.equal(load().normalize(renderer({ setVideoId: undefined })), null);
  });

  it('defaults a missing channel to Unknown', () => {
    const video = load().normalize(renderer({ shortBylineText: undefined }));
    assert.equal(video.channel, 'Unknown');
  });
});

describe('WLPlaylist.read', () => {
  it('flattens every page into one list', async () => {
    const playlist = load({
      pageAll: async () => [
        { contents: [{ playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'S1' }) }] },
        { contents: [{ playlistVideoRenderer: renderer({ videoId: 'b', setVideoId: 'S2' }) }] },
      ],
    });
    const videos = await playlist.read('WL');
    assert.deepEqual([...videos.map(v => v.id)], ['a', 'b']);
  });

  it('deduplicates entries repeated across pages', async () => {
    const dupe = { playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'S1' }) };
    const playlist = load({ pageAll: async () => [{ contents: [dupe] }, { contents: [dupe] }] });
    const videos = await playlist.read('WL');
    assert.equal(videos.length, 1);
  });

  it('skips renderers with no setVideoId', async () => {
    const playlist = load({
      pageAll: async () => [{
        contents: [
          { playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'S1' }) },
          { playlistVideoRenderer: renderer({ videoId: 'b', setVideoId: undefined }) },
        ],
      }],
    });
    const videos = await playlist.read('WL');
    assert.deepEqual([...videos.map(v => v.id)], ['a']);
  });
});

describe('WLPlaylist completeness gate', () => {
  it('marks a continuation result incomplete when the response has no authoritative item count', async () => {
    const playlist = load({ pageAll: async () => [{ contents: [{ playlistVideoRenderer: renderer({ setVideoId: 'A' }) }] }] });
    const snapshot = await playlist.readSnapshot('WL');
    assert.equal(snapshot.complete, false);
    assert.match(snapshot.reason, /cannot be verified/);
  });
  it('does not trust a generic videoCount nested in an InnerTube response', async () => {
    const playlist = load({ pageAll: async () => [{ videoCount: 1, unrelatedWidget: { videoCount: 1 }, contents: [{ playlistVideoRenderer: renderer({ setVideoId: 'A' }) }] }] });
    const snapshot = await playlist.readSnapshot('WL');
    assert.equal(snapshot.paginationTerminated, true);
    assert.equal(snapshot.expectedCount, null);
    assert.equal(snapshot.complete, false);
  });
  it('accepts an exact YouTube playlist header count when every entry is distinct and identified', async () => {
    const header = { playlistHeaderRenderer: { numVideosText: { simpleText: '2 videos' } } };
    const playlist = load({ pageAll: async () => [{ ...header, contents: [
      { playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'A' }) },
      { playlistVideoRenderer: renderer({ videoId: 'b', setVideoId: 'B', isPlayable: false, title: { simpleText: 'Private video' } }) },
    ] }] }, { document: { querySelectorAll: () => [{ innerText: '2 videos' }] } });
    const snapshot = await playlist.readSnapshot('WL');
    assert.equal(snapshot.expectedCount, 2);
    assert.equal(snapshot.uniqueEntryCount, 2);
    assert.equal(snapshot.integrityValid, true);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.visibleHeaderCount, 2);
    assert.equal(snapshot.diagnostics.pageCount, 1);
    assert.equal(snapshot.diagnostics.outcome, 'verified');
    assert.equal(snapshot.videos[1].unavailable, true);
  });
  it('fails closed when an exact header count disagrees with retrieved distinct entries', async () => {
    const playlist = load({ pageAll: async () => [{
      playlistHeaderRenderer: { numVideosText: { runs: [{ text: '46' }, { text: ' videos' }] } },
      contents: [{ playlistVideoRenderer: renderer({ setVideoId: 'A' }) }],
    }] }, { document: { querySelectorAll: () => [{ innerText: '46 videos' }] } });
    const snapshot = await playlist.readSnapshot('WL');
    assert.equal(snapshot.expectedCount, 46);
    assert.equal(snapshot.complete, false);
    assert.match(snapshot.reason, /reports 46.*retrieved/);
  });
  it('rejects abbreviated header counts instead of treating them as exact', async () => {
    const playlist = load({ pageAll: async () => [{
      playlistHeaderRenderer: { numVideosText: { simpleText: '1.2K videos' } },
      contents: [{ playlistVideoRenderer: renderer({ setVideoId: 'A' }) }],
    }] });
    const snapshot = await playlist.readSnapshot('WL');
    assert.equal(snapshot.expectedCount, null);
    assert.equal(snapshot.complete, false);
  });
  it('requires the rendered header count to agree with the response header count', async () => {
    const playlist = load({ pageAll: async () => [{
      playlistHeaderRenderer: { numVideosText: { simpleText: '19 videos' } },
      contents: Array.from({ length: 19 }, (_, i) => ({ playlistVideoRenderer: renderer({ videoId: `v${i}`, setVideoId: `S${i}` }) })),
    }] }, { document: { querySelectorAll: () => [{ innerText: '18 videos' }] } });
    const snapshot = await playlist.readSnapshot('WL');
    assert.equal(snapshot.complete, false);
    assert.match(snapshot.reason, /rendered header reports 18.*response reports 19/);
    assert.equal(snapshot.diagnostics.completenessVerified, false);
  });
  it('fails closed for duplicates and unidentified playlist entries', async () => {
    const duplicate = renderer({ setVideoId: 'A' });
    const playlist = load({ pageAll: async () => [{ contents: [{ playlistVideoRenderer: duplicate }, { playlistVideoRenderer: duplicate }, { playlistVideoRenderer: renderer({ setVideoId: undefined }) }] }] });
    const snapshot = await playlist.readSnapshot('WL');
    assert.equal(snapshot.complete, false);
    assert.match(snapshot.reason, /duplicate or unidentified/);
  });
  it('refuses permanent mutation unless the caller provides a validated snapshot', async () => {
    const { playlist, calls } = (() => {
      const calls = [];
      return { calls, playlist: load({ call: async (...args) => { calls.push(args); }, pageAll: async () => [] }) };
    })();
    await assert.rejects(playlist.applyOrder('WL', ['A', 'B']), /completeness has not been verified/);
    assert.equal(calls.length, 0);
  });
});

describe('WLPlaylist.buildMoveActions', () => {
  it('anchors the first item with MOVE_VIDEO_BEFORE', () => {
    const [first] = load().buildMoveActions(['A', 'B', 'C']);
    assert.equal(first.action, 'ACTION_MOVE_VIDEO_BEFORE');
    assert.equal(first.setVideoId, 'A');
    assert.equal(first.movedSetVideoIdSuccessor, 'B');
  });

  it('chains every later item after its predecessor', () => {
    const actions = load().buildMoveActions(['A', 'B', 'C']);
    assert.equal(actions[1].action, 'ACTION_MOVE_VIDEO_AFTER');
    assert.equal(actions[1].setVideoId, 'B');
    assert.equal(actions[1].movedSetVideoIdPredecessor, 'A');
    assert.equal(actions[2].movedSetVideoIdPredecessor, 'B');
  });

  it('produces one action per item', () => {
    assert.equal(load().buildMoveActions(['A', 'B', 'C', 'D']).length, 4);
  });

  it('minimizes moves to entries outside the longest stable subsequence', () => {
    const actions = load().buildMoveActions(['B', 'C', 'D', 'A'], ['A', 'B', 'C', 'D']);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].setVideoId, 'A');
    assert.equal(actions[0].movedSetVideoIdPredecessor, 'D');
  });

  it('returns no actions for lists too short to reorder', () => {
    assert.deepEqual([...load().buildMoveActions(['A'])], []);
    assert.deepEqual([...load().buildMoveActions([])], []);
  });

  it('never omits the anchor, which YouTube treats as a silent no-op', () => {
    for (const action of load().buildMoveActions(['A', 'B', 'C'])) {
      const anchored = action.movedSetVideoIdPredecessor || action.movedSetVideoIdSuccessor;
      assert.ok(anchored, `action for ${action.setVideoId} has no anchor`);
    }
  });
});

describe('WLPlaylist.applyOrder', () => {
  function withCalls(handlers) {
    const calls = [];
    const playlist = load({
      call: async (endpoint, body) => {
        calls.push({ endpoint, body });
        return handlers(endpoint, body, calls.length);
      },
      pageAll: async () => {
        const page = handlers('browse', {}, calls.length);
        return [{ ...page, videoCount: realInnerTube.findAll(page, 'playlistVideoRenderer').length }];
      },
    });
    // This writer-contract fixture simulates a separately validated snapshot;
    // the real readSnapshot intentionally cannot provide this for Watch Later.
    const readSnapshot = playlist.readSnapshot.bind(playlist);
    playlist.readSnapshot = async (...args) => ({ ...(await readSnapshot(...args)), complete: true, reason: null });
    return { playlist, calls };
  }

  it('makes no edit call for a list too short to reorder', async () => {
    const { playlist, calls } = withCalls((endpoint) =>
      endpoint === 'browse/edit_playlist'
        ? { status: 'STATUS_SUCCEEDED' }
        : { contents: [{ playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'A' }) }] }
    );
    await playlist.applyOrder('PLx', ['A'], { complete: true, originalOrder: ['A'] });
    const edits = calls.filter(c => c.endpoint === 'browse/edit_playlist');
    assert.equal(edits.length, 0);
  });

  it('batches all actions into one edit_playlist request', async () => {
    let edited = false;
    const { playlist, calls } = withCalls((endpoint) => {
      if (endpoint === 'browse/edit_playlist') { edited = true; return { status: 'STATUS_SUCCEEDED' }; }
      const ids = edited ? ['B', 'A'] : ['A', 'B'];
      return { contents: ids.map((id, i) => ({ playlistVideoRenderer: renderer({ videoId: id.toLowerCase(), setVideoId: id }) })) };
    });
    await playlist.applyOrder('PLx', ['B', 'A'], { complete: true, originalOrder: ['A', 'B'] });
    const edits = calls.filter(c => c.endpoint === 'browse/edit_playlist');
    assert.equal(edits.length, 1);
    assert.equal(edits[0].body.actions.length, 1, 'LIS move plan only moves the displaced entry');
    assert.equal(edits[0].body.playlistId, 'PLx');
  });

  it('reports applied:true once the order matches', async () => {
    const { playlist } = withCalls((endpoint) =>
      endpoint === 'browse/edit_playlist'
        ? { status: 'STATUS_SUCCEEDED' }
        : {
            contents: [
              { playlistVideoRenderer: renderer({ videoId: 'b', setVideoId: 'B' }) },
              { playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'A' }) },
            ],
          }
    );
    const result = await playlist.applyOrder('PLx', ['B', 'A'], { complete: true, originalOrder: ['B', 'A'] });
    assert.equal(result.applied, true);
  });

  it('reports applied:false as retry-safe only while complete read-back still matches the original order', async () => {
    const { playlist } = withCalls((endpoint) =>
      endpoint === 'browse/edit_playlist'
        ? { status: 'STATUS_SUCCEEDED' }
        : {
            contents: [
              { playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'A' }) },
              { playlistVideoRenderer: renderer({ videoId: 'b', setVideoId: 'B' }) },
            ],
          }
    );
    const result = await playlist.applyOrder('PLx', ['B', 'A'], { timeoutMs: 50, intervalMs: 10, complete: true, originalOrder: ['A', 'B'] });
    assert.equal(result.applied, false);
    assert.equal(result.retrySafe, true);
    assert.equal(result.originalOrderUnchanged, true);
    assert.equal(result.completenessVerified, true);
    assert.match(result.error, /still matches its original order/i);
  });

  it('retries on stale reads until the order converges', async () => {
    let browseCount = 0;
    const { playlist } = withCalls((endpoint) => {
      if (endpoint === 'browse/edit_playlist') {
        return { status: 'STATUS_SUCCEEDED' };
      }
      // endpoint === 'browse' (used by pageAll/read)
      browseCount++;
      if (browseCount <= 2) {
        // Stale read - old order still visible due to server-side caching
        return {
          contents: [
            { playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'A' }) },
            { playlistVideoRenderer: renderer({ videoId: 'b', setVideoId: 'B' }) },
          ],
        };
      }
      // Converged - new order now visible
      return {
        contents: [
          { playlistVideoRenderer: renderer({ videoId: 'b', setVideoId: 'B' }) },
          { playlistVideoRenderer: renderer({ videoId: 'a', setVideoId: 'A' }) },
        ],
      };
    });
    const result = await playlist.applyOrder('PLx', ['B', 'A'], { timeoutMs: 500, intervalMs: 10, complete: true, originalOrder: ['A', 'B'] });
    assert.equal(result.applied, true);
    assert.ok(result.waitedMs > 0, 'should have polled and waited for convergence');
  });

  it('retries a transport error only after readback confirms the original sequence', async () => {
    let writes = 0;
    const playlist = load({ call: async () => { writes++; if (writes === 1) throw new Error('connection lost'); return {}; } });
    playlist.readSnapshot = async () => ({ complete: true, videos: (writes >= 2 ? ['B', 'A'] : ['A', 'B']).map(id => ({ setVideoId: id })) });
    const result = await playlist.applyOrder('PLx', ['B', 'A'], { complete: true, originalOrder: ['A', 'B'], intervalMs: 1, timeoutMs: 20 });
    assert.equal(result.applied, true);
    assert.equal(writes, 2);
  });

  it('stops without another write when readback shows a partial or concurrent change', async () => {
    let writes = 0;
    const playlist = load({ call: async () => { writes++; throw new Error('connection lost'); } });
    let reads = 0;
    playlist.readSnapshot = async () => ({ complete: true, videos: (reads++ < 2 ? ['A', 'B'] : ['A', 'C']).map(id => ({ setVideoId: id })) });
    await assert.rejects(playlist.applyOrder('PLx', ['B', 'A'], { complete: true, originalOrder: ['A', 'B'] }), /uncertain.*changed/i);
    assert.equal(writes, 1);
  });

  it('detects a concurrent change between preflight and mutation', async () => {
    let writes = 0, reads = 0;
    const playlist = load({ call: async () => { writes++; } });
    playlist.readSnapshot = async () => ({ complete: true, videos: (reads++ === 0 ? ['A', 'B'] : ['A', 'C']).map(id => ({ setVideoId: id })) });
    await assert.rejects(playlist.applyOrder('PLx', ['B', 'A'], { complete: true, originalOrder: ['A', 'B'] }), /changed during reorder/);
    assert.equal(writes, 0);
  });
});
