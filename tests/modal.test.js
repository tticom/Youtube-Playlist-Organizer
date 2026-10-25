// tests/modal.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load-global.js';
import { SORT_CHOICES } from '../lib/sort.js';

const load = () => loadGlobal('content/modal.js', 'WLModal', { document: undefined });
// showPreview reads WLHeadings at click time for the per-group unwatched total.
const realHeadings = () => loadGlobal('content/headings.js', 'WLHeadings', {
  document: undefined, MutationObserver: class { observe() {} disconnect() {} },
});

function video(overrides = {}) {
  return {
    id: 'v', title: 'T', duration: 600, percentWatched: 0,
    cluster: 'Music', unavailable: false, ...overrides,
  };
}

describe('WLModal.toGroups', () => {
  it('returns an empty array for an empty order', () => {
    assert.deepEqual([...load().toGroups([])], []);
  });

  it('groups consecutive videos sharing a cluster', () => {
    const groups = load().toGroups([
      video({ id: 'a', cluster: 'Music' }),
      video({ id: 'b', cluster: 'Music' }),
      video({ id: 'c', cluster: 'Tech & AI' }),
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual([...groups[0].videos.map(v => v.id)], ['a', 'b']);
    assert.equal(groups[1].name, 'Tech & AI');
  });

  it('labels the null cluster as in progress', () => {
    const modal = load();
    assert.equal(modal.toGroups([video({ cluster: null })])[0].name, modal.IN_PROGRESS_LABEL);
  });

  it('treats a video with no cluster property as its own unlabelled group', () => {
    // buildDurationSortOrder returns videos with no cluster key at all.
    const groups = load().toGroups([{ id: 'a', title: 'T', duration: 60 }]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, null, 'duration mode must not render a heading');
  });

  it('starts a new group when a cluster name repeats non-consecutively', () => {
    const groups = load().toGroups([
      video({ id: 'a', cluster: 'Music' }),
      video({ id: 'b', cluster: 'Tech & AI' }),
      video({ id: 'c', cluster: 'Music' }),
    ]);
    assert.equal(groups.length, 3);
  });
});

describe('WLModal.formatDuration', () => {
  it('formats under an hour as m:ss', () => { assert.equal(load().formatDuration(125), '2:05'); });
  it('formats an hour or more as h:mm:ss', () => { assert.equal(load().formatDuration(3725), '1:02:05'); });
  it('formats zero', () => { assert.equal(load().formatDuration(0), '0:00'); });
  it('pads seconds below ten', () => { assert.equal(load().formatDuration(65), '1:05'); });
});

describe('WLModal.metaFor', () => {
  it('shows watched position over total for in-progress videos', () => {
    assert.equal(load().metaFor(video({ cluster: null, duration: 600, percentWatched: 50 })), '5:00 / 10:00');
  });

  it('shows only the total for a started video the user marked unwatched', () => {
    // The pressed eye already marks the override; "0:00 / 10:00" read as a bug.
    assert.equal(load().metaFor(video({ cluster: 'Music', inProgress: false, duration: 600, percentWatched: 50 })), '10:00');
  });

  it('shows the real position in a simple (non-AI) sort, where no override exists', () => {
    const v = { id: 'a', title: 't', channel: 'c', duration: 600, percentWatched: 50, unavailable: false };
    assert.equal(load().metaFor(v), '5:00 / 10:00');
  });

  it('shows total duration for unwatched videos', () => {
    assert.equal(load().metaFor(video({ duration: 600 })), '10:00');
  });

  it('treats a video under the 10% watched threshold as plain unwatched', () => {
    // Regression: the sorter zeroes progress under WATCHED_THRESHOLD, so such a
    // video arrived as not-in-progress and showed "0:00 / 10:00" with a pressed
    // "undo" button that could not change anything.
    const modal = load();
    assert.equal(modal.metaFor(video({ duration: 600, percentWatched: 5, inProgress: false, cluster: 'Music' })), '10:00');
    assert.equal(modal.hasWatchTime(video({ duration: 600, percentWatched: 5, inProgress: false, cluster: 'Music' })), false);
  });

  it('shows a marker for unavailable videos', () => {
    assert.equal(load().metaFor(video({ unavailable: true })), 'unavailable');
  });

  it('never produces NaN when percentWatched is missing', () => {
    // Regression: the old panel read a deleted `progress` field and rendered NaN:NaN.
    assert.ok(!load().metaFor({ cluster: null, duration: 600 }).includes('NaN'));
  });
});

describe('WLModal.isInProgress', () => {
  it('trusts the sorter\'s inProgress flag when present, whatever the cluster is', () => {
    // inProgress 'within' keeps the cluster name on a started video.
    assert.equal(load().isInProgress(video({ cluster: 'Music', inProgress: true })), true);
    assert.equal(load().isInProgress(video({ cluster: null, inProgress: false })), false);
  });

  it('falls back to the null-cluster convention for orders saved before the flag existed', () => {
    assert.equal(load().isInProgress(video({ cluster: null })), true);
    assert.equal(load().isInProgress(video({ cluster: 'Music' })), false);
  });

  it('metaFor shows the watched position for a started video inside its category', () => {
    assert.equal(load().metaFor(video({ cluster: 'Music', inProgress: true, duration: 600, percentWatched: 50 })), '5:00 / 10:00');
  });
});

describe('WLModal.SORT_CHOICES constant drift', () => {
  it('matches lib/sort.js SORT_CHOICES exactly', () => {
    // Content scripts cannot import lib/, so the modal carries its own copy of
    // the select contents. The background whitelists values against the lib
    // copy, so a value that only exists here would silently fall back to the
    // default at sort time.
    const modal = load();
    assert.deepEqual(JSON.parse(JSON.stringify(modal.SORT_CHOICES)), JSON.parse(JSON.stringify(SORT_CHOICES)));
    assert.deepEqual(Object.keys(modal.SORT_FIELD_LABELS), Object.keys(SORT_CHOICES));
  });
});

/**
 * Minimal element/document fake, just enough for showModes(). open() builds the
 * modal shell with innerHTML, which is not worth faking, so these tests stub
 * _body()/_footer() directly and call showModes() on its own.
 */
function fakeUi() {
  const make = (tag) => ({
    tagName: tag, className: '', type: '', innerHTML: '', textContent: '',
    children: [], _attrs: {},
    _listeners: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); },
    focus() { this._focusCalls = (this._focusCalls || 0) + 1; },
  });
  return { make, document: { createElement: make } };
}

function showModesWith({ canUndo = false, hasHeadings = false, handlers = {} }) {
  const { make, document } = fakeUi();
  const modal = loadGlobal('content/modal.js', 'WLModal', { document });
  const body = make('div');
  const footer = make('div');
  modal._body = () => body;
  modal._footer = () => footer;
  modal._handlers = handlers;
  modal._canUndo = canUndo;
  modal._hasHeadings = hasHeadings;
  modal.showModes();
  return { body, footer, labels: footer.children.map(el => el.textContent) };
}

describe('WLModal.showModes', () => {
  it('offers only Close when there is nothing to undo', () => {
    const { labels } = showModesWith({ canUndo: false });
    assert.deepEqual([...labels], ['Close']);
  });

  it('offers Undo last sort when open() was told an undo exists', () => {
    const { labels } = showModesWith({ canUndo: true });
    assert.deepEqual([...labels], ['Undo last sort', 'Close']);
  });

  it('wires the undo button to onUndo', () => {
    let called = false;
    const { footer } = showModesWith({
      canUndo: true,
      handlers: { onUndo: () => { called = true; } },
    });
    footer.children.find(el => el.textContent === 'Undo last sort')._listeners.click();
    assert.equal(called, true);
  });

  it('never offers Hide group headings: the chip beside Organize owns visibility', () => {
    const { labels } = showModesWith({ canUndo: true });
    assert.ok(!labels.includes('Hide group headings'));
  });

  it('offers Clear headings before Undo when the playlist has stored headings', () => {
    const { labels } = showModesWith({ canUndo: true, hasHeadings: true });
    assert.deepEqual([...labels], ['Clear headings', 'Undo last sort', 'Close']);
    assert.deepEqual([...showModesWith({ hasHeadings: true }).labels], ['Clear headings', 'Close']);
  });

  it('wires Clear headings to onClearHeadings', () => {
    let called = false;
    const { footer } = showModesWith({ hasHeadings: true, handlers: { onClearHeadings: () => { called = true; } } });
    footer.children.find(el => el.textContent === 'Clear headings')._listeners.click();
    assert.equal(called, true);
  });

  it('offers the AI sort and the three simple sorts as rows, in that order, with their captions', () => {
    const { body } = showModesWith({});
    const rows = body.children[0].children;
    assert.equal(body.children[0].className, 'wl-mode-choice');
    assert.deepEqual(rows.map(r => r.className), Array(4).fill('wl-mode-btn'));
    assert.deepEqual(rows.map(r => r.innerHTML), [
      'Analyze &amp; sort<small>Groups videos by topic using Claude. Needs an API key. Takes a few seconds.</small>',
      'Sort by duration<small>Shortest first. Instant, no API key needed.</small>',
      'Sort by title<small>A to Z. Instant, no API key needed.</small>',
      'Sort by channel<small>Channel name A to Z, then title. Instant, no API key needed.</small>',
    ]);
    assert.equal(rows[0]._focusCalls, 1, 'the AI row takes focus');
  });

  it('each mode row hands its mode to onSort', () => {
    const modes = [];
    const { body } = showModesWith({ handlers: { onSort: (mode) => modes.push(mode) } });
    for (const row of body.children[0].children) row._listeners.click();
    assert.deepEqual(modes, ['ai', 'duration', 'title', 'channel']);
  });

  it('does not throw when showModes runs with no handlers registered', () => {
    // Every handler call site uses ?., and the buttons are reachable before
    // open() has wired anything in the tests above.
    const { footer } = showModesWith({ canUndo: true });
    assert.doesNotThrow(() => {
      footer.children.find(el => el.textContent === 'Undo last sort')._listeners.click();
    });
  });
});

/** Depth-first walk of a fake subtree. */
const walk = (node, out = []) => {
  for (const child of node.children ?? []) { out.push(child); walk(child, out); }
  return out;
};
/** Just enough of querySelector for `[data-wl-sort="k"]` and `[data-wl-sort-choice="k"]`. */
const selectorFor = (root) => (selector) => {
  const [, attr, value] = /\[([\w-]+)="([\w-]+)"\]/.exec(selector);
  return walk(root).find(el => el.getAttribute(attr) === value) ?? null;
};

/**
 * Renders a preview and hands back the sort-option controls by their role:
 * `rows` are the disclosure buttons (data-wl-sort), `lists` the radio groups
 * they unfold, `radios[key]` the inputs (data-wl-sort-choice).
 */
function previewWith({ sortOrder = [], sortOptions = null, handlers = {}, activeSortKey = null, activeChoiceKey = null } = {}) {
  const { make, document } = fakeUi();
  const activeElement = activeSortKey || activeChoiceKey
    ? { getAttribute: (k) => (k === 'data-wl-sort' ? activeSortKey : k === 'data-wl-sort-choice' ? activeChoiceKey : null) }
    : undefined;
  document.activeElement = activeElement;
  const modal = loadGlobal('content/modal.js', 'WLModal', { document, WLHeadings: realHeadings() });
  const body = make('div');
  body.querySelector = selectorFor(body);
  const footer = make('div');
  modal._body = () => body;
  modal._footer = () => footer;
  modal._handlers = handlers;
  modal.showPreview(sortOrder, sortOptions);
  const panel = body.children.find(el => el.className === 'wl-sort-options') ?? null;
  const all = panel ? walk(panel) : [];
  const rows = all.filter(el => el.tagName === 'button');
  const lists = all.filter(el => el.className === 'wl-option-list');
  const radios = {};
  for (const el of all.filter(el => el.type === 'radio')) {
    (radios[el.getAttribute('data-wl-sort-choice')] ??= []).push(el);
  }
  const sw = null;
  const rowFor = (key) => rows.find(r => r.getAttribute('data-wl-sort') === key);
  const listFor = (key) => lists.find(l => l.getAttribute('aria-label') === modal.SORT_FIELD_LABELS[key]);
  return { modal, body, footer, panel, rows, lists, radios, sw, rowFor, listFor, toggle: body.children[0] };
}

describe('WLModal.showPreview sort options', () => {
  const options = { withinGroup: 'title', secondaryWithinGroup: 'playlist', inProgress: 'within', groupOrder: 'alpha' };
  const labelOf = (row) => row.children.find(c => c.className === 'wl-row-label').textContent;
  const valueOf = (row) => row.children.find(c => c.className === 'wl-row-value')?.textContent ?? null;

  it('renders no options row when none are given (duration mode)', () => {
    const { panel, body } = previewWith({ sortOrder: [video({ id: 'a' })] });
    assert.equal(panel, null);
    assert.equal(body.children[0].className, 'wl-group-heading');
  });

  it('stacks the group meta under the label in the same markup as the injected headings', () => {
    const { body } = previewWith({ sortOrder: [
      video({ id: 'a', cluster: 'Music', duration: 600 }),
      video({ id: 'b', cluster: 'Music', duration: 600 }),
    ] });
    const heading = body.children[0];
    assert.deepEqual(heading.children.map(el => el.className), ['wl-group-label', 'wl-heading-meta']);
    assert.deepEqual(heading.children[1].children.map(el => el.className), ['wl-heading-count', 'wl-heading-total']);
    assert.equal(heading.children[1].children[0].textContent, '2 videos');
    assert.equal(heading.children[1].children[1].textContent, '20m');
  });

  it('draws the in-progress heading as a plain coloured label with no icon', () => {
    const { body } = previewWith({ sortOrder: [video({ id: 'a', cluster: null, inProgress: true, percentWatched: 50 })] });
    const heading = body.children.find(el => el.className.startsWith('wl-group-heading'));
    assert.equal(heading.className, 'wl-group-heading wl-in-progress');
    assert.equal(heading.innerHTML, '');
    assert.deepEqual(heading.children.map(el => el.className), ['wl-group-label', 'wl-heading-meta']);
    assert.equal(heading.children[0].textContent, 'In progress');
  });

  it('renders a collapsed "Sort options" disclosure row above the list that unfolds the panel', () => {
    const { body, panel, toggle } = previewWith({ sortOrder: [video({ id: 'a' })], sortOptions: options });
    assert.equal(toggle.tagName, 'button');
    assert.equal(toggle.className, 'wl-row wl-row-disclosure');
    assert.equal(toggle.getAttribute('data-wl-sort'), 'toggle');
    assert.equal(labelOf(toggle), 'Sort options');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'collapsed by default');
    assert.equal(body.children[1], panel, 'the panel comes before the first heading');
    assert.equal(panel.hidden, true);
    toggle._listeners.click();
    assert.equal(panel.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  });

  it('renders one choice row per sort option', () => {
    const { panel, rows, radios, sw, rowFor } = previewWith({ sortOptions: options });
    assert.deepEqual(panel.children.map(el => el.className), [
      'wl-row', 'wl-option-list', 'wl-row', 'wl-option-list', 'wl-row', 'wl-option-list', 'wl-row', 'wl-option-list',
    ]);
    assert.deepEqual(rows.map(r => r.getAttribute('data-wl-sort')), ['withinGroup', 'secondaryWithinGroup', 'inProgress', 'groupOrder']);
    assert.deepEqual(rows.map(labelOf), ['Within a group', 'Then sort by', 'Group in progress', 'Group order']);
    assert.deepEqual(rows.map(valueOf), ['Title A–Z', 'Original playlist position', 'Inside their category', 'Alphabetical']);
    assert.deepEqual(rows.map(r => r.getAttribute('aria-expanded')), ['false', 'false', 'false', 'false']);
    for (const key of ['withinGroup', 'secondaryWithinGroup', 'inProgress', 'groupOrder']) {
      assert.deepEqual(radios[key].map(r => r.value), SORT_CHOICES[key].map(c => c.value));
      assert.deepEqual(radios[key].map(r => r.name), radios[key].map(() => `wl-${key}`), 'one radio group per option');
      assert.deepEqual(radios[key].filter(r => r.checked).map(r => r.value), [options[key]]);
      assert.ok(rowFor(key).children.some(c => c.className === 'wl-chevron'));
    }
  });

  it('each choice row holds the radio, a check-icon slot and its label', () => {
    const { listFor } = previewWith({ sortOptions: options });
    const option = listFor('groupOrder').children[0];
    assert.equal(option.tagName, 'label');
    assert.equal(option.className, 'wl-row wl-option');
    assert.deepEqual(option.children.map(c => c.className), ['', 'wl-option-check', 'wl-row-label']);
    assert.match(option.children[1].innerHTML, /^<svg/);
    assert.equal(option.children[2].textContent, 'My category order');
  });

  it('renders the selected in-progress choice', () => {
    const { radios } = previewWith({ sortOptions: { ...options, inProgress: 'top' } });
    assert.deepEqual(radios.inProgress.filter(r => r.checked).map(r => r.value), ['top']);
  });

  it('changing the in-progress choice emits the selected rule', () => {
    const emitted = [];
    const { radios } = previewWith({
      sortOptions: options,
      handlers: { onSortOptionsChange: (next) => emitted.push(next) },
    });
    for (const value of ['top', 'sort']) {
      for (const radio of radios.inProgress) radio.checked = radio.value === value;
      radios.inProgress.find(r => r.value === value)._listeners.change();
    }
    assert.deepEqual(emitted.map(o => ({ ...o })), [
      { withinGroup: 'title', secondaryWithinGroup: 'playlist', inProgress: 'top', groupOrder: 'alpha' },
      { withinGroup: 'title', secondaryWithinGroup: 'playlist', inProgress: 'sort', groupOrder: 'alpha' },
    ]);
  });

  it('clicking an option row unfolds only its list and remembers it in _openSortKey', () => {
    const { modal, rowFor, listFor } = previewWith({ sortOptions: options });
    assert.equal(listFor('withinGroup').hidden, true);
    rowFor('withinGroup')._listeners.click();
    assert.equal(modal._openSortKey, 'withinGroup');
    assert.equal(listFor('withinGroup').hidden, false);
    assert.equal(rowFor('withinGroup').getAttribute('aria-expanded'), 'true');
    rowFor('groupOrder')._listeners.click();
    assert.equal(modal._openSortKey, 'groupOrder');
    assert.equal(listFor('withinGroup').hidden, true, 'one list at a time, like a menu');
    assert.equal(rowFor('withinGroup').getAttribute('aria-expanded'), 'false');
    assert.equal(listFor('groupOrder').hidden, false);
    rowFor('groupOrder')._listeners.click();
    assert.equal(modal._openSortKey, null);
    assert.equal(listFor('groupOrder').hidden, true);
  });

  it('a re-render keeps the list the user opened unfolded', () => {
    const { make, document } = fakeUi();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document, WLHeadings: realHeadings() });
    const body = make('div');
    body.querySelector = selectorFor(body);
    modal._body = () => body;
    modal._footer = () => make('div');
    modal._handlers = {};
    modal._sortOptionsOpen = true;
    modal._openSortKey = 'groupOrder';
    modal.showPreview([], options);
    const panel = body.children[1];
    assert.equal(panel.hidden, false);
    assert.equal(panel.children[6].getAttribute('aria-expanded'), 'true');
    assert.equal(panel.children[7].hidden, false);
    assert.equal(panel.children[1].hidden, true);
  });

  it('choosing a radio emits the full option set with only that key replaced, and folds its list', () => {
    const emitted = [];
    const { modal, radios, rowFor, listFor } = previewWith({
      sortOptions: options,
      handlers: { onSortOptionsChange: (next) => emitted.push(next) },
    });
    rowFor('groupOrder')._listeners.click();
    const size = radios.groupOrder.find(r => r.value === 'size');
    for (const r of radios.groupOrder) r.checked = r === size;
    size._listeners.change();
    assert.deepEqual(emitted.map(o => ({ ...o })), [{ withinGroup: 'title', secondaryWithinGroup: 'playlist', inProgress: 'within', groupOrder: 'size' }]);
    assert.equal(modal._openSortKey, null);
    assert.equal(listFor('groupOrder').hidden, true);
    assert.equal(rowFor('groupOrder').getAttribute('aria-expanded'), 'false');
    // Focus moves to the row before the list hides, or the browser drops it to <body>.
    assert.equal(rowFor('groupOrder')._focusCalls, 1);
    assert.equal(rowFor('groupOrder').getAttribute('aria-controls'), listFor('groupOrder').id);
  });

  it('a second change carries the first one, not a render-time snapshot', () => {
    // Regression: two quick changes before the first re-sort returned reverted
    // each other because the handler closed over the options at render time.
    const emitted = [];
    const { radios } = previewWith({
      sortOptions: options,
      handlers: { onSortOptionsChange: (next) => emitted.push(next) },
    });
    const pick = (key, value) => {
      for (const r of radios[key]) r.checked = r.value === value;
      radios[key].find(r => r.value === value)._listeners.change();
    };
    pick('withinGroup', 'duration-desc');
    pick('groupOrder', 'alpha');
    assert.deepEqual({ ...emitted[1] }, { withinGroup: 'duration-desc', secondaryWithinGroup: 'playlist', inProgress: 'within', groupOrder: 'alpha' });
  });

  it('does not throw on change when no handler is registered', () => {
    const { radios, sw } = previewWith({ sortOptions: options });
    assert.doesNotThrow(() => radios.withinGroup[0]._listeners.change());
  });

  it('focuses Apply normally, but the control that triggered a re-render keeps focus', () => {
    const focusedWith = (activeSortKey, activeChoiceKey = null) => {
      const focused = [];
      const { make, document } = fakeUi();
      document.createElement = (tag) => { const el = make(tag); el.focus = () => focused.push(el); return el; };
      if (activeSortKey || activeChoiceKey) {
        document.activeElement = { getAttribute: (k) => (k === 'data-wl-sort' ? activeSortKey : k === 'data-wl-sort-choice' ? activeChoiceKey : null) };
      }
      const modal = loadGlobal('content/modal.js', 'WLModal', { document, WLHeadings: realHeadings() });
      const body = make('div');
      body.querySelector = selectorFor(body);
      const footer = make('div');
      modal._body = () => body;
      modal._footer = () => footer;
      modal.showPreview([], options);
      return { focused, apply: footer.children[0], byKey: (key) => body.querySelector(`[data-wl-sort="${key}"]`) };
    };

    const plain = focusedWith(null);
    assert.deepEqual(plain.focused, [plain.apply]);

    const row = focusedWith('groupOrder');
    assert.equal(row.byKey('groupOrder').tagName, 'button');
    assert.deepEqual(row.focused, [row.byKey('groupOrder')]);

    const progress = focusedWith('inProgress');
    assert.equal(progress.byKey('inProgress').tagName, 'button');
    assert.deepEqual(progress.focused, [progress.byKey('inProgress')]);

    const toggle = focusedWith('toggle');
    assert.deepEqual(toggle.focused, [toggle.byKey('toggle')]);

    // A radio's list has folded by the time the re-render lands, so focus goes
    // to the row that reopens it rather than to a hidden input.
    const choice = focusedWith(null, 'withinGroup');
    assert.deepEqual(choice.focused, [choice.byKey('withinGroup')]);
  });
});

describe('WLModal._renderItem unwatched toggle', () => {
  const itemWith = (v) => {
    const { document } = fakeUi();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });
    modal._handlers = {};
    return modal._renderItem(v);
  };

  it('reports pressed only when the sorter treated a started video as unwatched', () => {
    const pressed = (v) => itemWith(v).children[1].getAttribute('aria-pressed');
    assert.equal(pressed(video({ percentWatched: 50, cluster: null, inProgress: true })), 'false');
    assert.equal(pressed(video({ percentWatched: 50, cluster: 'Music', inProgress: true })), 'false', 'within: started, not overridden');
    assert.equal(pressed(video({ percentWatched: 50, cluster: 'Music', inProgress: false })), 'true', 'overridden');
  });

  it('draws the control as an icon button whose name flips with its pressed state', () => {
    const started = itemWith(video({ percentWatched: 50, cluster: 'Music', inProgress: true })).children[1];
    assert.equal(started.className, 'wl-unwatch-btn');
    assert.match(started.innerHTML, /^<svg/);
    assert.equal(started.getAttribute('aria-label'), 'Mark as unwatched');
    assert.equal(started.title, 'Mark as unwatched');

    const undone = itemWith(video({ percentWatched: 50, cluster: 'Music', inProgress: false })).children[1];
    assert.equal(undone.getAttribute('aria-label'), 'Mark as unwatched', 'name is fixed; aria-pressed carries the state');
    assert.equal(undone.title, 'Marked as unwatched (click to undo)');
  });

  it('explains the eye control once, only when a started video is in an AI preview', () => {
    const withStarted = previewWith({ sortOrder: [video({ id: 'a', percentWatched: 50, cluster: 'Music', inProgress: true })] });
    assert.ok(withStarted.body.children.some(el => el.className === 'wl-hint'));
    const noneStarted = previewWith({ sortOrder: [video({ id: 'a', cluster: 'Music' })] });
    assert.ok(!noneStarted.body.children.some(el => el.className === 'wl-hint'));
  });

  it('pairs the button with the position-over-total time and omits both for unwatched videos', () => {
    const started = itemWith(video({ percentWatched: 50, cluster: 'Music', inProgress: true }));
    assert.equal(started.children[2].textContent, '5:00 / 10:00', 'timestamp follows the button');
    const fresh = itemWith(video({ percentWatched: 0 }));
    assert.equal(fresh.children.length, 2, 'no button on an unwatched video');
    assert.equal(fresh.children[1].textContent, '10:00');
  });

  it('omits the control from a simple-sort order, where no cached analysis backs a resort', () => {
    // Simple sorts (lib/sort.js buildSimpleSortOrder) copy the input videos,
    // which carry no `cluster` key; an AI order always has one, even if null.
    const simple = { id: 'v', title: 'T', duration: 600, percentWatched: 50, unavailable: false };
    assert.equal(itemWith(simple).children.length, 2);
    assert.equal(itemWith({ ...simple, cluster: null, inProgress: true }).children.length, 3);
  });

  it('routes a click to onToggleUnwatched with the video id', () => {
    const { document } = fakeUi();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });
    const calls = [];
    modal._handlers = { onToggleUnwatched: (id) => calls.push(id) };
    modal._renderItem(video({ id: 'v9', percentWatched: 50, inProgress: true })).children[1]._listeners.click();
    assert.deepEqual(calls, ['v9']);
  });
});

describe('WLModal classification override selector', () => {
  it('shows the automatic assignment, selected subjects, and emits a video-ID override', () => {
    const { document } = fakeUi();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });
    const chosen = [];
    modal._subjects = [{ id: 'custom:music', name: 'Music' }, { id: 'custom:physics', name: 'Physics' }];
    modal._handlers = { onClassificationOverride: (videoId, subjectId) => chosen.push([videoId, subjectId]) };
    const row = modal._renderItem(video({ id: 'video-123', cluster: 'Music', manualOverride: false }));
    const select = row.children[1];
    assert.equal(select.className, 'wl-classification-override');
    assert.equal(select.children[0].textContent, 'Automatic · Music');
    assert.equal(select.children[0].selected, true);
    select.value = 'custom:physics';
    select._listeners.change();
    assert.deepEqual(chosen, [['video-123', 'custom:physics']]);
  });

  it('shows actual decision evidence and emits explicit confirmation and uncertainty feedback', () => {
    const { document } = fakeUi();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });
    const feedback = [];
    modal._subjects = [{ id: 'custom:physics', name: 'Physics' }];
    modal._handlers = { onClassificationFeedback: (videoId, value) => feedback.push([videoId, value]) };
    const row = modal._renderItem(video({ id: 'video-feedback', cluster: 'Physics', classificationEvidence: [{ field: 'title', phrase: 'quantum' }] }));
    const all = walk(row);
    assert.ok(all.some(node => String(node.textContent).includes('title “quantum”')));
    all.find(node => node.textContent === 'Confirm')._listeners.click();
    all.find(node => node.textContent === 'Uncertain')._listeners.click();
    assert.deepEqual(JSON.parse(JSON.stringify(feedback)), [['video-feedback', { confirmed: true }], ['video-feedback', { uncertain: true }]]);
  });
});

/**
 * Minimal document stub covering only what mountTrigger/removeTrigger/close
 * touch. The rest of WLModal's DOM-rendering methods need far more of the
 * DOM API (innerHTML parsing, event delegation) than is worth faking without
 * a real jsdom dependency, so those remain manually verified.
 *
 * `isConnected` mirrors the real DOM property: an element is connected iff
 * it is present in this document's `elements` list (i.e. was appended and
 * not since removed). This is enough fidelity to test close()'s fallback
 * logic honestly without pulling in a DOM library.
 */
function fakeDocument() {
  const elements = [];
  const makeElement = (tag) => {
    const el = {
      tagName: tag,
      id: '',
      className: '',
      children: [],
      _listeners: {},
      _focused: false,
      classList: {
        add(name) { if (!this.contains(name)) el.className = (el.className + ' ' + name).trim(); },
        contains(name) { return el.className.split(/\s+/).includes(name); },
      },
      setAttribute() {},
      addEventListener(type, fn) { this._listeners[type] = fn; },
      focus() { this._focused = true; },
      remove() {
        const i = elements.indexOf(el);
        if (i !== -1) elements.splice(i, 1);
      },
    };
    Object.defineProperty(el, 'isConnected', { get: () => elements.includes(el) });
    return el;
  };

  return {
    _elements: elements, // exposed for test introspection only; not part of the real DOM API
    body: { appendChild(el) { elements.push(el); } },
    createElement(tag) { return makeElement(tag); },
    _host: null, // set by a test to simulate YouTube's chip row being present
    querySelector(selector) {
      if (selector === '#wl-trigger') return elements.find(el => el.id === 'wl-trigger') ?? null;
      if (this._host && selector === this._host._selector) return this._host;
      return null;
    },
  };
}

function fakeHost(selector) {
  const host = {
    _selector: selector,
    children: [{ id: 'yt-sort-chip' }],
    appendChild(el) { this.children.push(el); },
    insertBefore(el, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      this.children.splice(i === -1 ? this.children.length : i, 0, el);
    },
    get firstChild() { return this.children[0] ?? null; },
  };
  return host;
}

describe('WLModal.mountTrigger', () => {
  it('is idempotent: two calls append exactly one #wl-trigger button', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });

    modal.mountTrigger({ onOpen: () => {} });
    modal.mountTrigger({ onOpen: () => {} });

    const triggers = document._elements.filter(el => el.id === 'wl-trigger');
    assert.equal(triggers.length, 1);
  });

  it('wires the click handler to call onOpen', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });

    let opened = false;
    modal.mountTrigger({ onOpen: () => { opened = true; } });
    document._elements[0]._listeners.click();

    assert.equal(opened, true);
  });
});

describe('WLModal.mountTrigger placement', () => {
  it('mounts inline in the first matching chip-row host', () => {
    const document = fakeDocument();
    const selector = 'ytd-playlist-video-list-renderer ytd-feed-filter-chip-bar-renderer #chips-wrapper';
    document._host = fakeHost(selector);
    const modal = loadGlobal('content/modal.js', 'WLModal', {
      document, SELECTORS: { TRIGGER_HOSTS: ['nope', selector] },
    });
    modal.mountTrigger({ onOpen: () => {} });
    assert.equal(document._host.children.length, 2);
    assert.equal(document._host.children[0].id, 'yt-sort-chip', 'YouTube\'s chips keep their child indices');
    assert.match(document._host.children[1].className, /wl-trigger-inline/);
    assert.equal(document._elements.length, 0, 'not appended to body');
  });

  it('moves a floating trigger into the chip row once the row appears', () => {
    const document = fakeDocument();
    const selector = 'chip-bar-view-model .ytChipBarViewModelChipBarScrollContainer';
    const modal = loadGlobal('content/modal.js', 'WLModal', {
      document, SELECTORS: { TRIGGER_HOSTS: [selector] },
    });
    assert.equal(modal.mountTrigger({ onOpen: () => {} }), true);
    assert.equal(document._elements.length, 1, 'floating first');
    document._host = fakeHost(selector);
    assert.equal(modal.mountTrigger({ onOpen: () => {} }), false, 'no second button');
    assert.equal(document._host.children.length, 2, 'moved into the row');
    assert.match(document._host.children[1].className, /wl-trigger-inline/);
  });

  it('mounts in the parent of a { parentOf } match', () => {
    const document = fakeDocument();
    const host = fakeHost(null);
    document._host = { _selector: 'chip-bar-view-model chip-view-model', parentElement: host };
    const modal = loadGlobal('content/modal.js', 'WLModal', {
      document, SELECTORS: { TRIGGER_HOSTS: [{ parentOf: 'chip-bar-view-model chip-view-model' }] },
    });
    modal.mountTrigger({ onOpen: () => {} });
    assert.equal(host.children.length, 2);
    assert.equal(host.children[1].id, 'wl-trigger');
    assert.equal(document._elements.length, 0);
  });

  it('falls back to a floating button on body when no host matches', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', {
      document, SELECTORS: { TRIGGER_HOSTS: ['nope'] },
    });
    modal.mountTrigger({ onOpen: () => {} });
    assert.equal(document._elements.length, 1);
    assert.doesNotMatch(document._elements[0].className, /wl-trigger-inline/);
  });
});

describe('WLModal.removeTrigger', () => {
  it('removes a mounted trigger', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });

    modal.mountTrigger({ onOpen: () => {} });
    assert.ok(document.querySelector('#wl-trigger'));

    modal.removeTrigger();
    assert.equal(document.querySelector('#wl-trigger'), null);
  });

  it('is a no-op when no trigger is mounted', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });

    assert.doesNotThrow(() => modal.removeTrigger());
  });
});

describe('WLModal.close', () => {
  // These tests poke _lastFocused/_root directly rather than going through
  // open(), which needs far more DOM fidelity (innerHTML parsing) than this
  // stub provides. That's an honest trade: it means these tests exercise
  // close()'s focus-restoration branch in isolation, not the full open→close
  // lifecycle, but the branch itself — connected vs. detached — is exactly
  // what changed and what the stub can model faithfully via `isConnected`.

  it('restores focus to the last-focused element when it is still connected', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });

    const field = document.createElement('input');
    document.body.appendChild(field); // connected

    modal._lastFocused = field;
    modal._root = null;
    modal.close();

    assert.equal(field._focused, true);
  });

  it('falls back to the trigger when the last-focused element has been detached', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });

    const detached = document.createElement('input'); // never appended — not connected
    modal.mountTrigger({ onOpen: () => {} });

    modal._lastFocused = detached;
    modal._root = null;
    modal.close();

    assert.equal(detached._focused, false, 'must not focus a detached node');
    assert.equal(document.querySelector('#wl-trigger')._focused, true);
  });

  it('does nothing when both the last-focused element and the trigger are gone', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });

    const detached = document.createElement('input'); // never appended, no trigger mounted

    modal._lastFocused = detached;
    modal._root = null;

    assert.doesNotThrow(() => modal.close());
    assert.equal(detached._focused, false);
  });
});

describe('WLModal.showBusy cancellability', () => {
  function busyWith(opts, handlers = {}) {
    const { make, document } = fakeUi();
    const modal = loadGlobal('content/modal.js', 'WLModal', {
      document,
      WLHeadings: { present: () => false },
    });
    const body = make('div');
    const footer = make('div');
    modal._body = () => body;
    modal._footer = () => footer;
    modal._handlers = handlers;
    modal.close = () => { closed = true; };
    let closed = false;
    modal.showBusy('Applying 3 moves...', opts);
    return { modal, footer, button: footer.children[0], wasClosed: () => closed };
  }

  it('is cancellable by default', () => {
    const { modal, button } = busyWith(undefined);
    assert.equal(modal._cancellable, true);
    assert.equal(button.disabled, undefined, 'the default Cancel button stays enabled');
  });

  it('wraps the label and bar in one inset block', () => {
    const { modal } = busyWith(undefined);
    const [busy] = modal._body().children;
    assert.equal(busy.className, 'wl-busy');
    assert.deepEqual(busy.children.map(el => el.className), ['', 'wl-progress-bar']);
    assert.equal(busy.children[0].textContent, 'Applying 3 moves...');
  });

  it('disables the button when the work has already been sent', () => {
    const { modal, button } = busyWith({ cancellable: false });
    assert.equal(modal._cancellable, false);
    assert.equal(button.disabled, true);
    assert.equal(button._listeners.click, undefined, 'no click handler is wired at all');
  });

  it('ignores _cancel() while uninterruptible, so Escape and backdrop clicks cannot fire onCancel', () => {
    // Regression: the reorder is already written by this point. Cancelling only
    // hid the modal and skipped the reload, leaving the playlist silently
    // reordered while the UI implied nothing had happened. Escape and backdrop
    // clicks route through _cancel() too, which is why the guard lives there
    // rather than on the button.
    let cancelled = false;
    const { modal, wasClosed } = busyWith({ cancellable: false }, { onCancel: () => { cancelled = true; } });

    modal._cancel();

    assert.equal(cancelled, false, 'onCancel must not fire');
    assert.equal(wasClosed(), false, 'the modal must not close');
  });

  it('still cancels normally when the state is interruptible', () => {
    let cancelled = false;
    const { modal, wasClosed } = busyWith({ cancellable: true }, { onCancel: () => { cancelled = true; } });

    modal._cancel();

    assert.equal(cancelled, true);
    assert.equal(wasClosed(), true);
  });

  it('restores cancellability when a later state renders', () => {
    // Without this, one uninterruptible apply would wedge Escape shut for the
    // rest of the modal's life.
    const { modal, footer } = busyWith({ cancellable: false });
    assert.equal(modal._cancellable, false, 'setup');

    footer.children.length = 0;
    modal.showError('something broke');

    assert.equal(modal._cancellable, true);
  });
});

describe('WLModal.syncHeadingsToggle', () => {
  /** A trigger already mounted in a parent, with enough DOM for insertBefore. */
  function mounted(inline) {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });
    const parent = {
      children: [],
      insertBefore(node, ref) {
        const i = ref ? this.children.indexOf(ref) : -1;
        const j = this.children.indexOf(node);
        if (j !== -1) this.children.splice(j, 1);
        this.children.splice(i === -1 ? this.children.length : i, 0, node);
        node.parentNode = this;
      },
      appendChild(node) { this.insertBefore(node, null); },
      get lastElementChild() { return this.children[this.children.length - 1] ?? null; },
    };
    const trigger = document.createElement('button');
    trigger.id = 'wl-trigger';
    trigger.className = inline ? 'wl-trigger wl-trigger-inline' : 'wl-trigger';
    document.body.appendChild(trigger);
    parent.insertBefore(trigger, null);
    const after = () => parent.children[parent.children.indexOf(trigger) + 1] ?? null;
    Object.defineProperty(trigger, 'nextSibling', { get: after });
    Object.defineProperty(trigger, 'nextElementSibling', { get: after });
    const original = document.querySelector.bind(document);
    document.querySelector = (sel) => (sel === '#wl-headings-toggle'
      ? document._elements.find(el => el.id === 'wl-headings-toggle') ?? null
      : original(sel));
    document.body.appendChild = (el) => { document._elements.push(el); };
    const toggle = () => document._elements.find(el => el.id === 'wl-headings-toggle') ?? null;
    return { modal, document, parent, trigger, toggle };
  }

  // fakeDocument's createElement does not track elements until appended;
  // register anything the method creates so querySelector can find it later.
  function track(document) {
    const create = document.createElement.bind(document);
    document.createElement = (tag) => { const el = create(tag); el.setAttribute = (k, v) => { el[`_${k}`] = v; }; el.getAttribute = (k) => el[`_${k}`] ?? null; document._elements.push(el); return el; };
  }

  it('does nothing without a state, and removes a stale button', () => {
    const { modal, document, toggle } = mounted(true);
    track(document);
    modal.syncHeadingsToggle(null);
    assert.equal(toggle(), null);
    modal.syncHeadingsToggle('shown');
    assert.ok(toggle());
    modal.syncHeadingsToggle(null);
    assert.equal(toggle(), null, 'removed once the playlist has no headings');
  });

  it('appends the chip at the end of the row, after Organize, in the trigger\'s shape', () => {
    const { modal, document, parent, trigger, toggle } = mounted(true);
    track(document);
    parent.insertBefore({ id: 'yt-sort-chip' }, trigger);
    parent.insertBefore({ id: 'yt-all-chip' }, trigger);
    modal.syncHeadingsToggle('shown', { onToggle: () => {} });
    const button = toggle();
    assert.equal(parent.children[2], trigger);
    assert.deepEqual(parent.children.map(el => el.id), ['yt-sort-chip', 'yt-all-chip', 'wl-trigger', 'wl-headings-toggle']);
    assert.match(button.className, /wl-trigger-inline/);
    assert.match(button.innerHTML, /Hide headings/);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
  });

  it('relabels in place for the hidden state and keeps one button', () => {
    const { modal, document, parent, toggle } = mounted(true);
    track(document);
    modal.syncHeadingsToggle('shown');
    modal.syncHeadingsToggle('hidden');
    modal.syncHeadingsToggle('hidden');
    const buttons = document._elements.filter(el => el.id === 'wl-headings-toggle');
    assert.equal(buttons.length, 1);
    assert.equal(parent.children.length, 2);
    assert.match(toggle().innerHTML, /Show headings/);
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  });

  it('moves back to the end of the row when YouTube appends a chip after it', () => {
    const { modal, document, parent, trigger, toggle } = mounted(true);
    track(document);
    modal.syncHeadingsToggle('shown');
    parent.insertBefore({ id: 'yt-chip' }, null);
    assert.equal(parent.children[1], toggle());
    modal.syncHeadingsToggle('shown');
    assert.deepEqual(parent.children.map(el => el.id), ['wl-trigger', 'yt-chip', 'wl-headings-toggle']);
    assert.equal(parent.children[0], trigger);
  });

  it('floating: sits right after the floating trigger', () => {
    const { modal, document, parent, trigger, toggle } = mounted(false);
    track(document);
    modal.syncHeadingsToggle('shown');
    assert.deepEqual(parent.children, [trigger, toggle()]);
  });

  it('routes a click to onToggle', () => {
    const { modal, document, toggle } = mounted(false);
    track(document);
    let toggled = 0;
    modal.syncHeadingsToggle('shown', { onToggle: () => { toggled++; } });
    toggle()._listeners.click();
    assert.equal(toggled, 1);
    assert.doesNotMatch(toggle().className, /wl-trigger-inline/, 'floating trigger, floating chip');
  });

  it('is a no-op when the trigger is not mounted', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });
    modal.syncHeadingsToggle('shown');
    assert.equal(document._elements.length, 0);
  });
});

describe('WLModal.removeTrigger with the headings chip', () => {
  it('removes both chips', () => {
    const document = fakeDocument();
    const modal = loadGlobal('content/modal.js', 'WLModal', { document });
    const original = document.querySelector.bind(document);
    document.querySelector = (sel) => (sel === '#wl-headings-toggle'
      ? document._elements.find(el => el.id === 'wl-headings-toggle') ?? null
      : original(sel));
    modal.mountTrigger({ onOpen: () => {} });
    const chip = document.createElement('button');
    chip.id = 'wl-headings-toggle';
    document.body.appendChild(chip);
    modal.removeTrigger();
    assert.equal(document._elements.length, 0);
  });
});
