// tests/sort.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSortOrder, buildDurationSortOrder, buildSimpleSortOrder, effectiveProgress, WATCHED_THRESHOLD,
  SORT_DEFAULTS, SORT_CHOICES, normalizeSortOptions,
} from '../lib/sort.js';
import { UNAVAILABLE_GROUP } from '../lib/taxonomy.js';

function video(overrides = {}) {
  return {
    id: 'v', setVideoId: 'S', title: 'T', channel: 'C',
    duration: 600, percentWatched: 0, category: null,
    description: null, unavailable: false,
    ...overrides,
  };
}

describe('effectiveProgress', () => {
  it('treats progress below the threshold as unwatched', () => {
    assert.equal(effectiveProgress(video({ percentWatched: 9 }), []), 0);
  });

  it('treats exactly the threshold as watched', () => {
    assert.equal(effectiveProgress(video({ percentWatched: WATCHED_THRESHOLD }), []), WATCHED_THRESHOLD);
  });

  it('treats an overridden video as unwatched regardless of progress', () => {
    assert.equal(effectiveProgress(video({ id: 'x', percentWatched: 100 }), ['x']), 0);
  });

  it('leaves non-overridden videos alone', () => {
    assert.equal(effectiveProgress(video({ id: 'x', percentWatched: 50 }), ['other']), 50);
  });
});

describe('buildSortOrder', () => {
  const clusters = {
    clusters: [
      { name: 'Tech & AI', videoIds: ['t1', 't2'] },
      { name: 'Music', videoIds: ['m1'] },
    ],
  };

  it('returns an empty array for empty input', () => {
    assert.deepEqual(buildSortOrder([], { clusters: [] }, []), []);
  });

  it('puts in-progress videos first', () => {
    const videos = [
      video({ id: 't1', percentWatched: 0 }),
      video({ id: 'p1', percentWatched: 50 }),
    ];
    const [first] = buildSortOrder(videos, clusters, []);
    assert.equal(first.id, 'p1');
    assert.equal(first.cluster, null);
  });

  it('sorts in-progress by remaining watch time ascending', () => {
    const videos = [
      video({ id: 'long', duration: 1000, percentWatched: 50 }),   // 500s left
      video({ id: 'short', duration: 400, percentWatched: 50 }),   // 200s left
    ];
    const order = buildSortOrder(videos, { clusters: [] }, []);
    assert.deepEqual(order.map(v => v.id), ['short', 'long']);
  });

  it('does not promote videos below the threshold', () => {
    const videos = [
      video({ id: 't1', percentWatched: 5 }),
      video({ id: 't2', percentWatched: 0 }),
    ];
    const order = buildSortOrder(videos, clusters, []);
    assert.equal(order.every(v => v.cluster !== null), true);
  });

  it('respects overrides, moving the video out of in-progress', () => {
    const videos = [video({ id: 't1', percentWatched: 100 })];
    const order = buildSortOrder(videos, clusters, ['t1']);
    assert.equal(order[0].cluster, 'Tech & AI');
  });

  it('orders groups by the taxonomy, not by cluster response order', () => {
    const videos = [video({ id: 't1' }), video({ id: 'm1' })];
    const order = buildSortOrder(videos, clusters, []);
    // Music precedes Tech & AI in the taxonomy.
    assert.deepEqual(order.map(v => v.id), ['m1', 't1']);
  });

  it('sorts by duration ascending within a group', () => {
    const videos = [
      video({ id: 't1', duration: 900 }),
      video({ id: 't2', duration: 300 }),
    ];
    const order = buildSortOrder(videos, clusters, []);
    assert.deepEqual(order.map(v => v.id), ['t2', 't1']);
  });

  it('places unavailable videos last, in their own group', () => {
    const videos = [
      video({ id: 'ghost', unavailable: true }),
      video({ id: 't1' }),
    ];
    const order = buildSortOrder(videos, clusters, []);
    assert.equal(order[order.length - 1].id, 'ghost');
    assert.equal(order[order.length - 1].cluster, UNAVAILABLE_GROUP);
  });

  it('puts unclustered videos in Other, before unavailable', () => {
    const videos = [
      video({ id: 'ghost', unavailable: true }),
      video({ id: 'orphan' }),
      video({ id: 't1' }),
    ];
    const order = buildSortOrder(videos, clusters, []);
    assert.deepEqual(order.map(v => v.id), ['t1', 'orphan', 'ghost']);
    assert.equal(order[1].cluster, 'Other');
  });

  it('uses a selected Other / Uncategorised subject as the final fallback group', () => {
    const videos = [video({ id: 'u' }), video({ id: 'n' }), video({ id: 'k' })];
    const clusters = { clusters: [{ name: 'News', videoIds: ['n'] }, { name: 'Physics', videoIds: ['k'] }] };
    const result = buildSortOrder(videos, clusters, [], ['News', 'Physics', 'Other / Uncategorised'], { inProgress: 'sort' });
    assert.deepEqual(result.map(v => [v.id, v.cluster]), [['n', 'News'], ['k', 'Physics'], ['u', 'Other / Uncategorised']]);
  });

  it('appends model-invented categories after the taxonomy', () => {
    const videos = [video({ id: 'n1' }), video({ id: 'm1' })];
    const withNew = { clusters: [{ name: 'Knitting', videoIds: ['n1'] }, { name: 'Music', videoIds: ['m1'] }] };
    const order = buildSortOrder(videos, withNew, []);
    assert.deepEqual(order.map(v => v.id), ['m1', 'n1']);
  });

  it('includes every input video exactly once', () => {
    const videos = [
      video({ id: 't1' }), video({ id: 't2' }), video({ id: 'm1' }),
      video({ id: 'orphan' }), video({ id: 'ghost', unavailable: true }),
      video({ id: 'p1', percentWatched: 40 }),
    ];
    const order = buildSortOrder(videos, clusters, []);
    assert.equal(order.length, videos.length);
    assert.equal(new Set(order.map(v => v.id)).size, videos.length);
  });
});

describe('buildSortOrder with a custom taxonomy', () => {
  it('orders and canonicalises against the taxonomy passed in, not the default', () => {
    const taxonomy = ['Woodwork', 'Knitting'];
    const videos = [video({ id: 'k' }), video({ id: 'w' }), video({ id: 'm' })];
    const order = buildSortOrder(videos, {
      clusters: [
        { name: 'knitting', videoIds: ['k'] },
        { name: 'Woodwork', videoIds: ['w'] },
        { name: 'Music', videoIds: ['m'] },
      ],
    }, [], taxonomy);

    // Custom order first; Music is no longer a taxonomy name, so it sorts after.
    assert.deepEqual(order.map(v => v.id), ['w', 'k', 'm']);
    assert.equal(order[1].cluster, 'Knitting', 'folds onto the custom spelling');
  });

  it('ignores the reserved Other and Unavailable names so no video is emitted twice', () => {
    // Regression: a user listing "Other" as a category made `ordered` contain it
    // twice, and the sort order doubled every video in that group.
    const videos = [video({ id: 'a' }), video({ id: 'b' }), video({ id: 'u', unavailable: true })];
    const order = buildSortOrder(videos, {
      clusters: [{ name: 'Other', videoIds: ['a', 'b'] }],
    }, [], ['Music', 'Other', 'Unavailable']);
    assert.deepEqual(order.map(v => v.id), ['a', 'b', 'u']);
  });
});

describe('buildSortOrder cluster-name folding', () => {
  it('folds a differently-cased taxonomy name onto the taxonomy spelling', () => {
    // Regression: group identity is a plain string match, so "tech & ai" and
    // "Tech & AI" produced two groups and two headings for one category.
    const videos = [video({ id: 'a' }), video({ id: 'b' })];
    const order = buildSortOrder(videos, {
      clusters: [
        { name: 'Tech & AI', videoIds: ['a'] },
        { name: 'tech & ai', videoIds: ['b'] },
      ],
    }, []);

    assert.deepEqual([...new Set(order.map(v => v.cluster))], ['Tech & AI'],
      'both videos must land in one group, spelled as the taxonomy spells it');
  });

  it('folds surrounding whitespace onto the taxonomy spelling', () => {
    const order = buildSortOrder([video({ id: 'a' })], {
      clusters: [{ name: '  Music  ', videoIds: ['a'] }],
    }, []);
    assert.equal(order[0].cluster, 'Music');
  });

  it('folds model-invented names onto the spelling that arrived first', () => {
    // No canonical spelling exists for these, so first-seen wins. What matters
    // is that they do not fragment.
    const videos = [video({ id: 'a' }), video({ id: 'b' })];
    const order = buildSortOrder(videos, {
      clusters: [
        { name: 'Knitting', videoIds: ['a'] },
        { name: 'KNITTING', videoIds: ['b'] },
      ],
    }, []);

    assert.deepEqual([...new Set(order.map(v => v.cluster))], ['Knitting']);
  });

  it('still separates genuinely different categories', () => {
    // Guard against the folding being too aggressive.
    const videos = [video({ id: 'a' }), video({ id: 'b' })];
    const order = buildSortOrder(videos, {
      clusters: [
        { name: 'Music', videoIds: ['a'] },
        { name: 'Tech & AI', videoIds: ['b'] },
      ],
    }, []);

    assert.equal(new Set(order.map(v => v.cluster)).size, 2);
  });

  it('sorts a case-folded taxonomy group into its taxonomy position, not after it', () => {
    // Ordering keys off TAXONOMY.includes(name), so an unfolded "music" would
    // have been treated as invented and sorted after every real category.
    const videos = [video({ id: 'tech' }), video({ id: 'music' })];
    const order = buildSortOrder(videos, {
      clusters: [
        { name: 'Tech & AI', videoIds: ['tech'] },
        { name: 'music', videoIds: ['music'] },
      ],
    }, []);

    assert.deepEqual(order.map(v => v.id), ['music', 'tech'],
      'Music precedes Tech & AI in the taxonomy');
  });
});

describe('normalizeSortOptions', () => {
  it('fills every default from nothing', () => {
    assert.deepEqual(normalizeSortOptions(undefined), SORT_DEFAULTS);
    assert.deepEqual(normalizeSortOptions(null), SORT_DEFAULTS);
    assert.deepEqual(normalizeSortOptions('nope'), SORT_DEFAULTS);
  });

  it('keeps whitelisted values and replaces unknown ones with the default', () => {
    const s = normalizeSortOptions({ withinGroup: 'title', inProgress: 'bogus', groupOrder: 'alpha', extra: 1 });
    assert.deepEqual(s, { withinGroup: 'title', secondaryWithinGroup: 'playlist', inProgress: 'top', groupOrder: 'alpha' });
  });

  it('maps the retired inProgress "ignore" onto "within" rather than the default', () => {
    assert.equal(normalizeSortOptions({ inProgress: 'ignore' }).inProgress, 'within');
    assert.equal(SORT_CHOICES.inProgress.some(c => c.value === 'ignore'), false, 'no longer offered');
  });

  it('accepts every value SORT_CHOICES offers', () => {
    for (const [key, choices] of Object.entries(SORT_CHOICES)) {
      for (const { value } of choices) assert.equal(normalizeSortOptions({ [key]: value })[key], value);
    }
  });

  it('defaults are the first choice of each select', () => {
    for (const [key, choices] of Object.entries(SORT_CHOICES)) assert.equal(choices[0].value, SORT_DEFAULTS[key]);
  });
});

describe('buildSortOrder options: withinGroup', () => {
  const clusters = { clusters: [{ name: 'Music', videoIds: ['a', 'b', 'c'] }] };
  const videos = [
    video({ id: 'a', title: 'banana', duration: 500 }),
    video({ id: 'b', title: 'Apple', duration: 900 }),
    video({ id: 'c', title: 'cherry', duration: 100 }),
  ];
  const ids = (options) => buildSortOrder(videos, clusters, [], undefined, options).map(v => v.id);

  it('duration-asc is the default and matches the five-argument form', () => {
    assert.deepEqual(ids({}), ['c', 'a', 'b']);
    assert.deepEqual(ids({ withinGroup: 'duration-asc' }), buildSortOrder(videos, clusters, []).map(v => v.id));
  });

  it('duration-desc puts the longest first', () => {
    assert.deepEqual(ids({ withinGroup: 'duration-desc' }), ['b', 'a', 'c']);
  });

  it('strict duration ordering does not promote partially watched videos', () => {
    const started = [video({ id: 'short-started', duration: 30, percentWatched: 50 }), video({ id: 'long', duration: 900, percentWatched: 0 })];
    const result = buildSortOrder(started, { clusters: [{ name: 'Music', videoIds: ['short-started', 'long'] }] }, [], ['Music'], { withinGroup: 'duration-asc', inProgress: 'sort' });
    assert.deepEqual(result.map(v => v.id), ['short-started', 'long']);
  });

  it('playlist keeps arrival order, including across interleaved groups', () => {
    assert.deepEqual(ids({ withinGroup: 'playlist' }), ['a', 'b', 'c']);
    const mixed = [1, 2, 3, 4, 5, 6, 7].map(n => video({ id: String(n), duration: 1000 - n * 100 }));
    const twoGroups = { clusters: [
      { name: 'Music', videoIds: ['1', '5', '7'] },
      { name: 'Tech & AI', videoIds: ['2', '3', '4', '6'] },
    ] };
    const order = buildSortOrder(mixed, twoGroups, [], undefined, { withinGroup: 'playlist' }).map(v => v.id);
    assert.deepEqual(order, ['1', '5', '7', '2', '3', '4', '6']);
  });

  it('title sorts case-insensitively', () => {
    assert.deepEqual(ids({ withinGroup: 'title' }), ['b', 'a', 'c']);
  });

  it('applies secondary duration/title rules and original position as a stable final tie-breaker', () => {
    const list = [
      { id: 'a', title: 'Beta', duration: 10 },
      { id: 'b', title: 'Alpha', duration: 10 },
      { id: 'c', title: 'Alpha', duration: 5 },
    ];
    const grouped = { clusters: [{ name: 'Music', videoIds: ['a', 'b', 'c'] }] };
    const ids = opts => buildSortOrder(list, grouped, [], ['Music'], { inProgress: 'sort', ...opts }).map(v => v.id);
    assert.deepEqual(ids({ withinGroup: 'duration-asc', secondaryWithinGroup: 'title' }), ['c', 'b', 'a']);
    assert.deepEqual(ids({ withinGroup: 'title', secondaryWithinGroup: 'duration-desc' }), ['b', 'c', 'a']);
    assert.deepEqual(ids({ withinGroup: 'title', secondaryWithinGroup: 'playlist' }), ['b', 'c', 'a']);
  });

  it('allows a subject-specific primary and secondary sort to override shared defaults', () => {
    const videos = [
      { id: 'm-short', duration: 10, title: 'Zulu' }, { id: 'm-long', duration: 90, title: 'Alpha' },
      { id: 'p-short', duration: 20, title: 'Zulu' }, { id: 'p-long', duration: 80, title: 'Alpha' },
    ];
    const clusters = { clusters: [{ name: 'Music', videoIds: ['m-short', 'm-long'] }, { name: 'Physics', videoIds: ['p-short', 'p-long'] }] };
    const order = buildSortOrder(videos, clusters, [], ['Music', 'Physics'], {
      withinGroup: 'duration-asc', inProgress: 'sort',
      subjectSorts: { Physics: { withinGroup: 'duration-desc' }, Music: { withinGroup: 'title', secondaryWithinGroup: 'duration-desc' } },
    });
    assert.deepEqual(order.map(v => v.id), ['m-long', 'm-short', 'p-long', 'p-short']);
  });

  it('never changes the in-progress group, which always sorts by time left', () => {
    const started = [
      video({ id: 'x', title: 'zzz', duration: 1000, percentWatched: 90 }), // 100 left
      video({ id: 'y', title: 'aaa', duration: 1000, percentWatched: 50 }), // 500 left
    ];
    for (const withinGroup of ['duration-desc', 'playlist', 'title']) {
      const order = buildSortOrder([...started].reverse(), clusters, [], undefined, { withinGroup });
      assert.deepEqual(order.map(v => v.id), ['x', 'y'], withinGroup);
    }
  });
});

describe('buildSortOrder options: inProgress', () => {
  const clusters = { clusters: [
    { name: 'Music', videoIds: ['m1', 'm2', 'm3'] },
    { name: 'Tech & AI', videoIds: ['t1', 't2'] },
  ] };
  const videos = [
    video({ id: 't1', duration: 300 }),
    video({ id: 'm1', duration: 900, percentWatched: 50 }), // 450 left
    video({ id: 'm2', duration: 200 }),
    video({ id: 'm3', duration: 1000, percentWatched: 90 }), // 100 left
    video({ id: 't2', duration: 100, percentWatched: 20 }), // 80 left
  ];

  it('top (default) makes one null-cluster group ordered by time left', () => {
    const order = buildSortOrder(videos, clusters, [], undefined, { inProgress: 'top' });
    assert.deepEqual(order.map(v => v.id), ['t2', 'm3', 'm1', 'm2', 't1']);
    assert.deepEqual(order.slice(0, 3).map(v => v.cluster), [null, null, null]);
    assert.equal(order.every(v => typeof v.inProgress === 'boolean'), true);
  });

  it('within keeps started videos in their group, first, by time left, then the rest per withinGroup', () => {
    const order = buildSortOrder(videos, clusters, [], undefined, { inProgress: 'within', withinGroup: 'duration-asc' });
    assert.deepEqual(order.map(v => v.id), ['m3', 'm1', 'm2', 't2', 't1']);
    assert.equal(order.some(v => v.cluster === null), false, 'no In Progress group');
    const m3 = order.find(v => v.id === 'm3');
    assert.equal(m3.cluster, 'Music');
    assert.equal(m3.percentWatched, 90, 'the modal still needs this to print "left"');
    assert.equal(m3.inProgress, true);
    assert.equal(order.find(v => v.id === 'm2').inProgress, false);
  });

  it('within honours withinGroup for the unwatched tail only', () => {
    const more = [...videos, video({ id: 'm4', duration: 50 })];
    const withM4 = { clusters: [{ name: 'Music', videoIds: ['m1', 'm2', 'm3', 'm4'] }, clusters.clusters[1]] };
    const asc = buildSortOrder(more, withM4, [], undefined, { inProgress: 'within', withinGroup: 'duration-asc' });
    const desc = buildSortOrder(more, withM4, [], undefined, { inProgress: 'within', withinGroup: 'duration-desc' });
    assert.deepEqual(asc.map(v => v.id), ['m3', 'm1', 'm4', 'm2', 't2', 't1']);
    assert.deepEqual(desc.map(v => v.id), ['m3', 'm1', 'm2', 'm4', 't2', 't1'], 'started pair unchanged, tail reversed');
  });

  it('the retired ignore value behaves as within', () => {
    const legacy = buildSortOrder(videos, clusters, [], undefined, { inProgress: 'ignore' });
    const within = buildSortOrder(videos, clusters, [], undefined, { inProgress: 'within' });
    assert.deepEqual(legacy.map(v => v.id), within.map(v => v.id));
  });

  it('within still respects overrides for the started flag', () => {
    const order = buildSortOrder(videos, clusters, ['m3'], undefined, { inProgress: 'within' });
    assert.deepEqual(order.map(v => v.id), ['m1', 'm2', 'm3', 't2', 't1']);
    assert.equal(order.find(v => v.id === 'm3').inProgress, false);
  });
});

describe('buildSortOrder options: groupOrder', () => {
  const taxonomy = ['Zebra', 'Music', 'Apple'];
  const clusters = { clusters: [
    { name: 'Music', videoIds: ['m1'] },
    { name: 'Apple', videoIds: ['a1', 'a2'] },
    { name: 'Zebra', videoIds: ['z1', 'z2'] },
    { name: 'Knitting', videoIds: ['k1', 'k2', 'k3'] },
  ] };
  const videos = [
    video({ id: 'other1' }), video({ id: 'other2' }), video({ id: 'other3' }), video({ id: 'other4' }),
    video({ id: 'k1' }), video({ id: 'k2' }), video({ id: 'k3' }),
    video({ id: 'a1' }), video({ id: 'a2' }),
    video({ id: 'z1' }), video({ id: 'z2' }),
    video({ id: 'm1' }),
    video({ id: 'ghost', unavailable: true }),
  ];
  const groupsOf = (options) => {
    const order = buildSortOrder(videos, clusters, [], taxonomy, options);
    return [...new Set(order.map(v => v.cluster))];
  };

  it('taxonomy (default): taxonomy order, invented names, Other, Unavailable', () => {
    assert.deepEqual(groupsOf({}), ['Zebra', 'Music', 'Apple', 'Knitting', 'Other', 'Unavailable']);
  });

  it('size: largest first, ties broken by taxonomy order; Other stays last even when biggest', () => {
    assert.deepEqual(groupsOf({ groupOrder: 'size' }), ['Knitting', 'Zebra', 'Apple', 'Music', 'Other', 'Unavailable']);
  });

  it('size-asc: smallest first, ties broken by taxonomy order; Other still last even when smallest', () => {
    assert.deepEqual(groupsOf({ groupOrder: 'size-asc' }), ['Music', 'Zebra', 'Apple', 'Knitting', 'Other', 'Unavailable']);
    const oneOther = videos.filter(v => v.id !== 'other2' && v.id !== 'other3' && v.id !== 'other4');
    const order = buildSortOrder(oneOther, clusters, [], taxonomy, { groupOrder: 'size-asc' });
    assert.deepEqual([...new Set(order.map(v => v.cluster))], ['Music', 'Zebra', 'Apple', 'Knitting', 'Other', 'Unavailable']);
  });

  it('size and size-asc are exact reverses of each other apart from the Other/Unavailable tail', () => {
    const desc = groupsOf({ groupOrder: 'size' }).slice(0, -2);
    const asc = groupsOf({ groupOrder: 'size-asc' }).slice(0, -2);
    // Zebra and Apple tie at two videos; taxonomy order (Zebra first) wins in
    // both directions, so the reverse holds only up to that tie.
    assert.deepEqual(desc, ['Knitting', 'Zebra', 'Apple', 'Music']);
    assert.deepEqual(asc, ['Music', 'Zebra', 'Apple', 'Knitting']);
  });

  it('alpha: alphabetical, Other last', () => {
    assert.deepEqual(groupsOf({ groupOrder: 'alpha' }), ['Apple', 'Knitting', 'Music', 'Zebra', 'Other', 'Unavailable']);
  });

  it('with inProgress top, the In Progress group precedes every ordering', () => {
    const withStarted = [video({ id: 'p', percentWatched: 50 }), ...videos];
    for (const groupOrder of ['taxonomy', 'size', 'size-asc', 'alpha']) {
      const order = buildSortOrder(withStarted, clusters, [], taxonomy, { groupOrder });
      assert.equal(order[0].id, 'p', groupOrder);
      assert.equal(order[order.length - 1].id, 'ghost', groupOrder);
    }
  });
});

describe('buildSortOrder ignores options in the non-AI path', () => {
  it('buildDurationSortOrder is untouched by sort options', () => {
    const order = buildDurationSortOrder([video({ id: 'b', duration: 9 }), video({ id: 'a', duration: 1 })]);
    assert.deepEqual(order.map(v => v.id), ['a', 'b']);
    assert.equal('cluster' in order[0], false);
    assert.equal('inProgress' in order[0], false);
  });
});

describe('buildSimpleSortOrder', () => {
  const ids = (order) => order.map(v => v.id);

  it('duration is shortest first and is what buildDurationSortOrder returns', () => {
    const videos = [video({ id: 'b', duration: 9 }), video({ id: 'a', duration: 1 }), video({ id: 'c', duration: 5 })];
    assert.deepEqual(ids(buildSimpleSortOrder(videos, 'duration')), ['a', 'c', 'b']);
    assert.deepEqual(ids(buildSimpleSortOrder(videos)), ['a', 'c', 'b'], 'duration is the default');
    assert.deepEqual(buildDurationSortOrder(videos), buildSimpleSortOrder(videos, 'duration'));
  });

  it('title is A to Z, ignoring case and accents', () => {
    const videos = [video({ id: 'z', title: 'zebra' }), video({ id: 'e', title: 'Éclair' }), video({ id: 'a', title: 'apple' })];
    assert.deepEqual(ids(buildSimpleSortOrder(videos, 'title')), ['a', 'e', 'z']);
  });

  it('channel is channel A to Z, then title within a channel', () => {
    const videos = [
      video({ id: 'b2', channel: 'Beta', title: 'Two' }),
      video({ id: 'a1', channel: 'alpha', title: 'One' }),
      video({ id: 'b1', channel: 'beta', title: 'One' }),
    ];
    assert.deepEqual(ids(buildSimpleSortOrder(videos, 'channel')), ['a1', 'b1', 'b2']);
  });

  it('supports descending title and leaves unavailable duration values last', () => {
    const videos = [video({ id: 'unknown', duration: undefined, title: 'A' }), video({ id: 'known', duration: 20, title: 'B' })];
    assert.deepEqual(ids(buildSortOrder(videos, { clusters: [{ name: 'Music', videoIds: ['unknown', 'known'] }] }, [], ['Music'], { withinGroup: 'title-desc', inProgress: 'sort' })), ['known', 'unknown']);
    assert.deepEqual(ids(buildSimpleSortOrder(videos, 'duration')), ['known', 'unknown']);
  });

  it('is stable: equal keys keep playlist order', () => {
    const videos = [video({ id: 'x', duration: 5, title: 'Same', channel: 'C' }), video({ id: 'y', duration: 5, title: 'Same', channel: 'C' })];
    for (const by of ['duration', 'title', 'channel']) {
      assert.deepEqual(ids(buildSimpleSortOrder(videos, by)), ['x', 'y'], by);
    }
  });

  it('sorts a missing title or channel as empty text instead of throwing', () => {
    const videos = [video({ id: 'a', title: 'A', channel: 'C' }), video({ id: 'n', title: undefined, channel: undefined })];
    assert.deepEqual(ids(buildSimpleSortOrder(videos, 'title')), ['n', 'a']);
    assert.deepEqual(ids(buildSimpleSortOrder(videos, 'channel')), ['n', 'a']);
  });

  it('does not mutate the input and adds no cluster or inProgress key', () => {
    const videos = [video({ id: 'b', title: 'B' }), video({ id: 'a', title: 'A' })];
    const order = buildSimpleSortOrder(videos, 'title');
    assert.deepEqual(ids(videos), ['b', 'a']);
    assert.equal('cluster' in order[0], false);
    assert.equal('inProgress' in order[0], false);
  });

  it('rejects an unknown sort', () => {
    assert.throws(() => buildSimpleSortOrder([video()], 'views'), /Unknown sort/);
  });
});
