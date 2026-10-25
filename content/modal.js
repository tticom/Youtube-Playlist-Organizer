// content/modal.js
// The extension's entire preview UI. Owns no sorting logic — renders state and
// emits callbacks. Deliberately not anchored to any YouTube element.

const WLModal = {
  IN_PROGRESS_LABEL: 'In progress',
  CHEVRON_ICON: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.707 8.793a1 1 0 00-1.414 0L12 14.086 6.707 8.793a1 1 0 10-1.414 1.414L12 16.914l6.707-6.707a1 1 0 000-1.414Z"/></svg>',
  // Eye = watched position is honoured; crossed eye = marked as unwatched.
  EYE_ICON: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>',
  EYE_OFF_ICON: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>',
  // A slab-serif H, the conventional glyph for a heading.
  HEADINGS_ICON: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h6v2H8.5v4.5h7V6H14V4h6v2h-1.5v12H20v2h-6v-2h1.5v-5.5h-7V18H10v2H4v-2h1.5V6H4z"/></svg>',
  HEADINGS_TOGGLE_ID: 'wl-headings-toggle',
  CHECK_ICON: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',

  // Mirror of lib/sort.js SORT_CHOICES — content scripts cannot import lib/.
  // tests/modal.test.js pins the two copies together.
  SORT_CHOICES: {
    withinGroup: [
      { value: 'duration-asc', label: 'Shortest first' },
      { value: 'duration-desc', label: 'Longest first' },
      { value: 'playlist', label: 'Playlist order' },
      { value: 'title', label: 'Title A–Z' },
      { value: 'title-desc', label: 'Title Z–A' },
    ],
    secondaryWithinGroup: [
      { value: 'playlist', label: 'Original playlist position' },
      { value: 'duration-asc', label: 'Duration shortest first' },
      { value: 'duration-desc', label: 'Duration longest first' },
      { value: 'title', label: 'Title A–Z' },
      { value: 'title-desc', label: 'Title Z–A' },
    ],
    inProgress: [
      { value: 'top', label: 'Own group on top' },
      { value: 'within', label: 'Inside their category' },
      { value: 'sort', label: 'Follow selected sort' },
    ],
    groupOrder: [
      { value: 'taxonomy', label: 'My category order' },
      { value: 'size', label: 'Largest group first' },
      { value: 'size-asc', label: 'Smallest group first' },
      { value: 'alpha', label: 'Alphabetical' },
    ],
  },
  // The rows of the mode-choice view, in display order. `label` is HTML.
  MODES: [
    { mode: 'ai', label: 'Analyze &amp; sort', detail: 'Groups videos by topic using Claude. Needs an API key. Takes a few seconds.' },
    { mode: 'duration', label: 'Sort by duration', detail: 'Shortest first. Instant, no API key needed.' },
    { mode: 'title', label: 'Sort by title', detail: 'A to Z. Instant, no API key needed.' },
    { mode: 'channel', label: 'Sort by channel', detail: 'Channel name A to Z, then title. Instant, no API key needed.' },
  ],
  SORT_FIELD_LABELS: {
    withinGroup: 'Within a group',
    secondaryWithinGroup: 'Then sort by',
    inProgress: 'Group in progress',
    groupOrder: 'Group order',
  },
  SORT_CHECKBOX_VALUES: {},
  // Collapsed by default; remembered for the life of the page so a re-render
  // after a change does not fold the panel the user just opened.
  _sortOptionsOpen: false,
  // The option whose choice list is unfolded, or null. Choosing collapses it,
  // so a re-render after the change lands back on the option rows.
  _openSortKey: null,

  // Whether the mode view offers Undo and Clear headings; set by open() from
  // the panel's stored state.
  _canUndo: false,
  _hasHeadings: false,

  _root: null,
  _lastFocused: null,
  _handlers: {},
  _subjects: [],
  _keyHandler: null,

  /**
   * Collapse a flat sort order into consecutive runs sharing a cluster.
   * A video with no `cluster` property at all (duration mode) yields a group
   * named null, which renders without a heading.
   */
  toGroups(sortOrder) {
    const groups = [];
    let current = null;

    for (const video of sortOrder) {
      const name = video.cluster === null ? this.IN_PROGRESS_LABEL
        : video.cluster === undefined ? null
        : video.cluster;

      if (!current || current.name !== name) {
        current = { name, videos: [] };
        groups.push(current);
      }
      current.videos.push(video);
    }
    return groups;
  },

  formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${minutes}:${String(secs).padStart(2, '0')}`;
  },

  /**
   * Sorted videos carry `inProgress` from lib/sort.js; a `cluster: null` fallback
   * keeps a sortState persisted before that field existed rendering correctly.
   */
  isInProgress(video) {
    return video.inProgress ?? video.cluster === null;
  },

  /**
   * A started video reads "2:14 / 5:24". One the user marked unwatched reads
   * like any unwatched video, "5:24": the pressed eye already shows the
   * override, and a "0:00 /" prefix looked like a bug.
   */
  metaFor(video) {
    if (video.unavailable) return 'unavailable';
    // Outside AI mode there is no override, so the real position always shows.
    const started = this.isInProgress(video) || !('cluster' in video);
    if (started && this.hasWatchTime(video)) {
      const pct = Number(video.percentWatched) || 0;
      return `${this.formatDuration(video.duration * pct / 100)} / ${this.formatDuration(video.duration)}`;
    }
    return this.formatDuration(video.duration);
  },

  /**
   * Where the unwatch control can help: videos the sorter treats as started,
   * or ones the user overrode. Under 10% is "unwatched" to the sorter
   * (lib/sort.js WATCHED_THRESHOLD), so a 5% video gets no control — a
   * pressed button there would be lying and clicking it would change nothing.
   */
  hasWatchTime(video) {
    if (video.unavailable) return false;
    return this.isInProgress(video) || Number(video.percentWatched) >= 10;
  },

  // ── Trigger ────────────────────────────────────────────────────────────

  /**
   * Idempotent: safe to call on every navigation.
   * @returns {boolean} true when it created the element, false when one already existed.
   */
  mountTrigger({ onOpen }) {
    const existing = document.querySelector('#wl-trigger');
    const host = this.findTriggerHost();
    if (existing) {
      // YouTube renders the chip row after the page is otherwise ready, so a
      // trigger that mounted floating moves into the row once it exists.
      if (host && !existing.classList.contains('wl-trigger-inline')) {
        existing.classList.add('wl-trigger-inline');
        host.appendChild(existing);
      }
      return false;
    }

    const button = document.createElement('button');
    button.id = 'wl-trigger';
    button.className = 'wl-trigger';
    button.type = 'button';
    button.setAttribute('aria-label', 'Organize this playlist');
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/></svg>Organize`;
    button.addEventListener('click', () => onOpen());

    // Appended AFTER YouTube's chips, never before them: the chip bar resolves
    // a click by the chip's child index, so a foreign first child made every
    // sort choice apply one click late (measured 2026-09-11). The headings
    // chip follows this one.
    if (host) {
      button.classList.add('wl-trigger-inline');
      host.appendChild(button);
    } else {
      document.body.appendChild(button);
    }
    return true;
  },

  /** The chip row above the playlist items, or null when YouTube's markup has none. */
  findTriggerHost() {
    const hosts = (typeof SELECTORS !== 'undefined' && SELECTORS.TRIGGER_HOSTS) || [];
    for (const entry of hosts) {
      if (typeof entry === 'string') {
        const el = document.querySelector(entry);
        if (el) return el;
      } else if (entry && entry.parentOf) {
        const child = document.querySelector(entry.parentOf);
        if (child && child.parentElement) return child.parentElement;
      }
    }
    return null;
  },

  removeTrigger() {
    document.querySelector('#wl-trigger')?.remove();
    document.querySelector(`#${this.HEADINGS_TOGGLE_ID}`)?.remove();
  },

  /**
   * A second chip, last in the row, that hides or shows the injected headings.
   * With a floating trigger it floats above that.
   * `state` is 'shown', 'hidden', or null when this playlist has no stored
   * headings, in which case there is no button. Idempotent like mountTrigger:
   * syncTrigger calls it on every mutation batch, so a no-op must stay cheap.
   */
  syncHeadingsToggle(state, { onToggle } = {}) {
    let button = document.querySelector(`#${this.HEADINGS_TOGGLE_ID}`);
    if (!state) { button?.remove(); return; }
    const trigger = document.querySelector('#wl-trigger');
    if (!trigger) return;

    const shown = state === 'shown';
    const label = shown ? 'Hide headings' : 'Show headings';
    const inline = trigger.classList.contains('wl-trigger-inline');
    const parent = trigger.parentNode;
    const placed = inline
      ? parent && parent.lastElementChild === button
      : trigger.nextElementSibling === button;
    if (button && placed
        && button.getAttribute('aria-pressed') === String(shown)
        && button.className.includes('wl-trigger-inline') === inline) {
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.id = this.HEADINGS_TOGGLE_ID;
      button.type = 'button';
      button.addEventListener('click', () => onToggle?.());
    }
    button.className = inline ? 'wl-trigger wl-trigger-inline wl-headings-toggle' : 'wl-trigger wl-headings-toggle';
    button.setAttribute('aria-pressed', String(shown));
    button.setAttribute('aria-label', `${label} in this playlist`);
    button.innerHTML = `${this.HEADINGS_ICON}${label}`;
    if (inline && parent) parent.appendChild(button);
    else if (parent) parent.insertBefore(button, trigger.nextSibling);
    else document.body.appendChild(button);
  },

  /** Diagnostic: is the trigger present, and did our stylesheet actually apply? */
  verifyTrigger() {
    const el = document.querySelector('#wl-trigger');
    if (!el) return { present: false };

    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    return {
      present: true,
      connected: el.isConnected,
      position: style ? style.position : 'unknown',
      zIndex: style ? style.zIndex : 'unknown',
      visible: style ? style.display !== 'none' && style.visibility !== 'hidden' : 'unknown',
    };
  },

  // ── Modal shell ────────────────────────────────────────────────────────

  open(handlers = {}, { canUndo = false, hasHeadings = false } = {}) {
    this.close();
    this._handlers = handlers;
    this._canUndo = canUndo;
    this._hasHeadings = hasHeadings;
    this._lastFocused = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'wl-modal-backdrop';
    backdrop.innerHTML = `
      <div class="wl-modal" role="dialog" aria-modal="true" aria-labelledby="wl-modal-title">
        <div class="wl-modal-header">
          <h2 class="wl-modal-title" id="wl-modal-title">Organize playlist</h2>
          <span class="wl-modal-status" id="wl-modal-status"></span>
        </div>
        <div class="wl-modal-body" id="wl-modal-body"></div>
        <div class="wl-modal-footer" id="wl-modal-footer"></div>
      </div>
    `;

    document.body.appendChild(backdrop);
    this._root = backdrop;

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) this._cancel();
    });

    this._keyHandler = (event) => {
      if (event.key === 'Escape') { this._cancel(); return; }
      if (event.key === 'Tab') this._trapFocus(event);
    };
    document.addEventListener('keydown', this._keyHandler, true);

    this.showModes();
  },

  /**
   * True unless a state has declared itself uninterruptible. Backdrop clicks and
   * Escape route through here too, so the flag has to live on _cancel() rather
   * than on the button — otherwise pressing Escape would still "cancel" an
   * operation that cannot actually be stopped.
   */
  _cancellable: true,

  _cancel() {
    if (!this._cancellable) return;
    this.close();
    this._handlers.onCancel?.();
  },

  /** Keep Tab inside the dialog — required for WCAG 2.1 AA. */
  _trapFocus(event) {
    const focusable = this._root.querySelectorAll(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  },

  _body() { return this._root?.querySelector('#wl-modal-body'); },
  _footer() { return this._root?.querySelector('#wl-modal-footer'); },

  setStatus(text) {
    const status = this._root?.querySelector('#wl-modal-status');
    if (status) status.textContent = text;
  },

  // ── States ─────────────────────────────────────────────────────────────

  showModes() {
    const body = this._body();
    const footer = this._footer();
    if (!body) return;

    this._cancellable = true;

    this.setStatus('');
    body.textContent = '';
    footer.textContent = '';

    const wrap = document.createElement('div');
    wrap.className = 'wl-mode-choice';

    const buttons = this.MODES.map(({ mode, label, detail }) => {
      const button = document.createElement('button');
      button.className = 'wl-mode-btn';
      button.type = 'button';
      button.innerHTML = `${label}<small>${detail}</small>`;
      button.addEventListener('click', () => this._handlers.onSort?.(mode));
      return button;
    });
    wrap.append(...buttons);
    body.appendChild(wrap);

    if (this._hasHeadings) {
      const clear = document.createElement('button');
      clear.className = 'wl-modal-btn';
      clear.type = 'button';
      clear.textContent = 'Clear headings';
      clear.addEventListener('click', () => this._handlers.onClearHeadings?.());
      footer.appendChild(clear);
    }

    if (this._canUndo) {
      const undo = document.createElement('button');
      undo.className = 'wl-modal-btn';
      undo.type = 'button';
      undo.textContent = 'Undo last sort';
      undo.addEventListener('click', () => this._handlers.onUndo?.());
      footer.appendChild(undo);
    }

    const cancel = document.createElement('button');
    cancel.className = 'wl-modal-btn';
    cancel.type = 'button';
    cancel.textContent = 'Close';
    cancel.addEventListener('click', () => this._cancel());
    footer.appendChild(cancel);

    buttons[0].focus();
  },

  /**
   * `cancellable: false` is for work already sent to YouTube. Cancelling then
   * closed the modal and skipped the reload, but the reorder had already been
   * written — so the playlist silently changed while the UI implied nothing
   * happened. The button stays visible but disabled so the layout does not jump
   * and the state is legible.
   */
  showBusy(text, { cancellable = true } = {}) {
    const body = this._body();
    const footer = this._footer();
    if (!body) return;

    this._cancellable = cancellable;
    body.textContent = '';
    footer.textContent = '';

    const busy = document.createElement('div');
    busy.className = 'wl-busy';

    const label = document.createElement('p');
    label.textContent = text;

    const bar = document.createElement('div');
    bar.className = 'wl-progress-bar';
    bar.innerHTML = `<div class="wl-progress-fill"></div>`;

    busy.append(label, bar);
    body.appendChild(busy);

    const cancel = document.createElement('button');
    cancel.className = 'wl-modal-btn';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    if (cancellable) {
      cancel.addEventListener('click', () => this._cancel());
    } else {
      cancel.disabled = true;
      cancel.title = 'The reorder has already been sent and cannot be stopped';
    }
    footer.appendChild(cancel);
    if (cancellable) cancel.focus();
  },

  /**
   * `sortOptions` is the set the order was built with; when given, the option
   * selects render above the list. Duration mode passes none and gets no row.
   */
  showPreview(sortOrder, sortOptions = null, subjects = this._subjects, { warning = null, canApply = true, diagnostics = null } = {}) {
    const body = this._body();
    const footer = this._footer();
    if (!body) return;

    this._cancellable = true;
    this._subjects = subjects || [];

    // A re-render triggered by one of the controls must not steal focus from it:
    // arrow keys on a focused radio fire `change` per step, and jumping to Apply
    // after each would strand a keyboard user. A radio's own list has just
    // collapsed by then, so focus goes to the row that opens it.
    const active = document.activeElement;
    const focusedControl = active?.getAttribute?.('data-wl-sort')
      ?? active?.getAttribute?.('data-wl-sort-choice')
      ?? null;

    this.setStatus('');
    body.textContent = '';
    footer.textContent = '';

    if (warning) {
      const notice = document.createElement('p');
      notice.className = 'wl-hint wl-retrieval-warning';
      notice.setAttribute('role', 'status');
      notice.textContent = warning;
      body.appendChild(notice);
    }

    if (diagnostics) {
      const details = document.createElement('details');
      details.className = 'wl-retrieval-diagnostics';
      const summary = document.createElement('summary');
      summary.textContent = 'Playlist retrieval diagnostics';
      const list = document.createElement('dl');
      const rows = [
        ['Header count', diagnostics.headerCount ?? 'Unavailable'],
        ['Rendered header count', diagnostics.renderedHeaderCount ?? 'Unavailable'],
        ['Retrieved entries', diagnostics.retrievedEntryCount],
        ['Distinct reorderable entries', diagnostics.distinctReorderableEntryCount],
        ['Pages read', diagnostics.pageCount],
        ['Pagination terminated', diagnostics.paginationTerminated ? 'Yes' : 'No'],
        ['Completeness verification', diagnostics.completenessVerified ? 'Passed' : 'Not verified'],
        ['Outcome', diagnostics.outcome || 'Not verified'],
      ];
      for (const [label, value] of rows) {
        const term = document.createElement('dt'); term.textContent = label;
        const description = document.createElement('dd'); description.textContent = String(value);
        list.append(term, description);
      }
      details.append(summary, list);
      body.appendChild(details);
    }

    if (sortOptions) {
      const row = this._renderSortOptions(sortOptions);
      const toggle = this._renderDisclosureRow('toggle', 'Sort options');
      toggle.className += ' wl-row-disclosure';
      toggle.setAttribute('aria-expanded', String(this._sortOptionsOpen));
      row.hidden = !this._sortOptionsOpen;
      toggle.addEventListener('click', () => {
        this._sortOptionsOpen = !this._sortOptionsOpen;
        row.hidden = !this._sortOptionsOpen;
        toggle.setAttribute('aria-expanded', String(this._sortOptionsOpen));
      });
      body.append(toggle, row);
    }

    // The eye control only appears on hover, so say what it does once, up front.
    if (sortOrder.some(v => 'cluster' in v && this.hasWatchTime(v))) {
      const hint = document.createElement('p');
      hint.className = 'wl-hint';
      hint.textContent = 'Started videos sort by time left within their group. Hover one and click the eye to treat it as unwatched instead.';
      body.appendChild(hint);
    }

    for (const group of this.toGroups(sortOrder)) {
      if (group.name !== null) {
        const heading = document.createElement('h3');
        const inProgress = group.name === this.IN_PROGRESS_LABEL;
        heading.className = inProgress ? 'wl-group-heading wl-in-progress' : 'wl-group-heading';
        const label = document.createElement('span');
        label.className = 'wl-group-label';
        label.textContent = group.name;
        heading.append(label, this._renderGroupMeta(group.videos));
        body.appendChild(heading);
      }
      for (const video of group.videos) body.appendChild(this._renderItem(video));
    }

    const apply = document.createElement('button');
    apply.className = 'wl-modal-btn wl-primary';
    apply.type = 'button';
    apply.textContent = 'Apply Sort';
    apply.disabled = !canApply;
    if (!canApply) apply.title = 'Permanent reorder is disabled because playlist completeness is unverified.';
    apply.addEventListener('click', () => this._handlers.onApply?.());

    const cancel = document.createElement('button');
    cancel.className = 'wl-modal-btn';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this._cancel());

    footer.append(apply, cancel);
    const restore = focusedControl
      ? body.querySelector?.(`[data-wl-sort="${focusedControl}"]`)
      : null;
    (restore || apply).focus();
  },

  /** "12 videos · 3h 12m" under a preview heading, same markup as the injected headings. */
  _renderGroupMeta(videos) {
    const meta = document.createElement('span');
    meta.className = 'wl-heading-meta';
    const count = document.createElement('span');
    count.className = 'wl-heading-count';
    count.textContent = `${videos.length} video${videos.length === 1 ? '' : 's'}`;
    meta.appendChild(count);
    // WLHeadings loads after this file but this runs at click time, long after
    // every content script is in.
    const remaining = WLHeadings.remainingSeconds(videos);
    if (remaining > 0) {
      const total = document.createElement('span');
      total.className = 'wl-heading-total';
      total.textContent = WLHeadings.formatTotal(remaining);
      meta.appendChild(total);
    }
    return meta;
  },

  /** A 40px menu row: label, optional current-value text, chevron. */
  _renderDisclosureRow(key, label, value = null) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'wl-row';
    row.setAttribute('data-wl-sort', key);
    const caption = document.createElement('span');
    caption.className = 'wl-row-label';
    caption.textContent = label;
    row.appendChild(caption);
    if (value !== null) {
      const current = document.createElement('span');
      current.className = 'wl-row-value';
      current.textContent = value;
      row.appendChild(current);
    }
    const chevron = document.createElement('span');
    chevron.className = 'wl-chevron';
    chevron.innerHTML = this.CHEVRON_ICON;
    row.appendChild(chevron);
    return row;
  },

  _renderSortOptions(sortOptions) {
    const panel = document.createElement('div');
    panel.className = 'wl-sort-options';
    const radios = {};
    let switchInput = null;

    // Read every control live: two quick changes before the first re-sort
    // returns must not revert each other through a render-time snapshot.
    const emit = () => {
      const current = {};
      for (const key of Object.keys(this.SORT_CHOICES)) {
        const toggle = this.SORT_CHECKBOX_VALUES[key];
        if (toggle) {
          current[key] = switchInput.checked ? toggle.on : toggle.off;
          continue;
        }
        const checked = radios[key].find(r => r.checked);
        current[key] = checked ? checked.value : sortOptions[key];
      }
      this._handlers.onSortOptionsChange?.(current);
    };

    // Choice rows first, switches last, whatever order SORT_CHOICES (pinned to
    // lib/sort.js) happens to list them in.
    const keys = Object.keys(this.SORT_CHOICES)
      .sort((a, b) => (a in this.SORT_CHECKBOX_VALUES) - (b in this.SORT_CHECKBOX_VALUES));
    for (const key of keys) {
      const choices = this.SORT_CHOICES[key];
      const toggle = this.SORT_CHECKBOX_VALUES[key];

      if (toggle) {
        const field = document.createElement('label');
        field.className = 'wl-row wl-switch-row';
        const caption = document.createElement('span');
        caption.className = 'wl-row-label';
        caption.textContent = this.SORT_FIELD_LABELS[key];
        switchInput = document.createElement('input');
        switchInput.type = 'checkbox';
        switchInput.className = 'wl-switch';
        switchInput.setAttribute('role', 'switch');
        switchInput.setAttribute('data-wl-sort', key);
        switchInput.checked = sortOptions[key] === toggle.on;
        switchInput.addEventListener('change', emit);
        field.append(caption, switchInput);
        panel.appendChild(field);
        continue;
      }

      const current = choices.find(c => c.value === sortOptions[key]) ?? choices[0];
      const row = this._renderDisclosureRow(key, this.SORT_FIELD_LABELS[key], current.label);
      const open = this._openSortKey === key;
      row.setAttribute('aria-expanded', String(open));

      const list = document.createElement('div');
      list.className = 'wl-option-list';
      list.id = `wl-sort-list-${key}`;
      row.setAttribute('aria-controls', list.id);
      list.setAttribute('role', 'radiogroup');
      list.setAttribute('aria-label', this.SORT_FIELD_LABELS[key]);
      list.hidden = !open;

      radios[key] = [];
      for (const { value, label } of choices) {
        const option = document.createElement('label');
        option.className = 'wl-row wl-option';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `wl-${key}`;
        radio.value = value;
        radio.setAttribute('data-wl-sort-choice', key);
        radio.checked = value === sortOptions[key];
        radio.addEventListener('change', () => {
          this._openSortKey = null;
          // Hiding a list that still holds focus drops focus to <body>, which
          // the post-re-sort focus restore then reads as "nothing focused".
          row.focus?.();
          list.hidden = true;
          row.setAttribute('aria-expanded', 'false');
          emit();
        });
        radios[key].push(radio);
        const check = document.createElement('span');
        check.className = 'wl-option-check';
        check.innerHTML = this.CHECK_ICON;
        const caption = document.createElement('span');
        caption.className = 'wl-row-label';
        caption.textContent = label;
        option.append(radio, check, caption);
        list.appendChild(option);
      }

      row.addEventListener('click', () => {
        const nowOpen = this._openSortKey !== key;
        this._openSortKey = nowOpen ? key : null;
        list.hidden = !nowOpen;
        row.setAttribute('aria-expanded', String(nowOpen));
        // Only one list unfolds at a time, like a menu.
        for (const sibling of panel.children) {
          if (sibling === row || sibling === list) continue;
          if (sibling.className === 'wl-option-list') sibling.hidden = true;
          else if (sibling.getAttribute('aria-expanded') !== null) sibling.setAttribute('aria-expanded', 'false');
        }
      });

      panel.append(row, list);
    }
    return panel;
  },

  _renderItem(video) {
    const row = document.createElement('div');
    row.className = video.unavailable ? 'wl-modal-item wl-unavailable' : 'wl-modal-item';

    const title = document.createElement('span');
    title.className = 'wl-item-title';
    title.textContent = video.title;

    const meta = document.createElement('span');
    meta.className = 'wl-item-meta';
    meta.textContent = this.metaFor(video);

    row.appendChild(title);

    if ('cluster' in video && this._subjects.length && !video.unavailable) {
      const select = document.createElement('select');
      select.className = 'wl-classification-override';
      select.setAttribute('aria-label', `Classification for ${video.title}`);
      const automatic = document.createElement('option');
      automatic.value = '';
      automatic.textContent = `Automatic · ${video.cluster || 'Other'}`;
      automatic.selected = !video.manualOverride;
      select.appendChild(automatic);
      for (const subject of this._subjects) {
        const option = document.createElement('option');
        option.value = subject.id;
        option.textContent = subject.name;
        option.selected = video.manualOverride && subject.name === video.cluster;
        select.appendChild(option);
      }
      select.addEventListener('change', () => this._handlers.onClassificationOverride?.(video.id, select.value));
      row.appendChild(select);
      const reason = document.createElement('span'); reason.className = 'wl-item-meta';
      reason.textContent = video.classificationEvidence?.length
        ? `Why: ${video.classificationEvidence.map(e => `${e.field} “${e.phrase}”`).join(', ')}`
        : (video.classificationSource ? `Assigned by ${video.classificationSource}${video.classificationUncertain ? ' · uncertain' : ''}` : '');
      if (reason.textContent) row.appendChild(reason);
      if (!video.manualOverride) {
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'wl-unwatch-btn'; confirm.textContent = video.classificationConfirmed ? 'Confirmed' : 'Confirm'; confirm.disabled = Boolean(video.classificationConfirmed);
        confirm.addEventListener('click', () => this._handlers.onClassificationFeedback?.(video.id, { confirmed: true }));
        const uncertain = document.createElement('button'); uncertain.type = 'button'; uncertain.className = 'wl-unwatch-btn'; uncertain.textContent = 'Uncertain';
        uncertain.addEventListener('click', () => this._handlers.onClassificationFeedback?.(video.id, { uncertain: true }));
        row.append(confirm, uncertain);
      }
      const explain = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'Add feedback note';
      const note = document.createElement('input'); note.placeholder = 'Optional correction or classification note'; note.setAttribute('aria-label', `Feedback note for ${video.title}`);
      const saveFeedback = document.createElement('button'); saveFeedback.type = 'button'; saveFeedback.textContent = 'Save note';
      saveFeedback.addEventListener('click', () => this._handlers.onClassificationFeedback?.(video.id, { explanation: note.value, confirmed: true }));
      explain.append(summary, note, saveFeedback); row.appendChild(explain);
    }

    // Only an AI order carries `cluster`; the simple sorts have no cached
    // analysis for the toggle's RESORT to recompute against.
    if ('cluster' in video && this.hasWatchTime(video)) {
      const pressed = !this.isInProgress(video);
      const toggle = document.createElement('button');
      toggle.className = 'wl-unwatch-btn';
      toggle.type = 'button';
      toggle.innerHTML = pressed ? this.EYE_OFF_ICON : this.EYE_ICON;
      // The name stays fixed; aria-pressed carries the state (ARIA toggle-button pattern).
      toggle.setAttribute('aria-pressed', String(pressed));
      toggle.setAttribute('aria-label', 'Mark as unwatched');
      toggle.title = pressed ? 'Marked as unwatched (click to undo)' : 'Mark as unwatched';
      toggle.addEventListener('click', () => this._handlers.onToggleUnwatched?.(video.id));
      row.appendChild(toggle);
    }
    row.appendChild(meta);
    return row;
  },

  showError(message) {
    const body = this._body();
    const footer = this._footer();
    if (!body) return;

    this._cancellable = true;

    body.textContent = '';
    footer.textContent = '';

    const error = document.createElement('p');
    error.className = 'wl-modal-error';
    error.setAttribute('role', 'alert');
    error.textContent = message;
    body.appendChild(error);

    const back = document.createElement('button');
    back.className = 'wl-modal-btn';
    back.type = 'button';
    back.textContent = 'Try Again';
    back.addEventListener('click', () => this.showModes());

    const close = document.createElement('button');
    close.className = 'wl-modal-btn';
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => this._cancel());

    footer.append(back, close);
    back.focus();
  },

  close() {
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler, true);
      this._keyHandler = null;
    }
    this._root?.remove();
    this._root = null;

    // The element that had focus when the modal opened may have since been
    // removed from the DOM — routine on an SPA like YouTube that re-renders
    // its header constantly. Focusing a detached node is a silent no-op, so
    // fall back to the trigger (where the user came from) rather than
    // stranding focus on <body>.
    const restoreTarget = this._lastFocused?.isConnected
      ? this._lastFocused
      : document.querySelector('#wl-trigger');
    restoreTarget?.focus?.();
    this._lastFocused = null;
  },
};
