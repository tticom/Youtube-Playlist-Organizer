// lib/sort.js
import { TAXONOMY, OTHER_GROUP, UNAVAILABLE_GROUP } from './taxonomy.js';

/** Watch percentages below this count as unwatched. Exactly this value counts as watched. */
export const WATCHED_THRESHOLD = 10;

export const SORT_DEFAULTS = Object.freeze({
  withinGroup: 'duration-asc',
  secondaryWithinGroup: 'playlist',
  inProgress: 'top',
  groupOrder: 'taxonomy',
});

/** One entry per option, in the order the UI should offer them. */
export const SORT_CHOICES = Object.freeze({
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
});

// Values that shipped once and were later removed, mapped onto their nearest
// surviving choice so a saved setting keeps its intent instead of resetting.
const LEGACY_SORT_VALUES = {
  inProgress: { ignore: 'within' },
};

export function normalizeSortOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(SORT_DEFAULTS)) {
    const value = LEGACY_SORT_VALUES[key]?.[source[key]] ?? source[key];
    const allowed = SORT_CHOICES[key].some(choice => choice.value === value);
    out[key] = allowed ? value : fallback;
  }
  if (source.subjectSorts && typeof source.subjectSorts === 'object' && !Array.isArray(source.subjectSorts)) {
    out.subjectSorts = {};
    for (const [group, value] of Object.entries(source.subjectSorts)) {
      if (!group || !value || typeof value !== 'object') continue;
      const withinGroup = SORT_CHOICES.withinGroup.some(choice => choice.value === value.withinGroup) ? value.withinGroup : null;
      const secondaryWithinGroup = SORT_CHOICES.secondaryWithinGroup.some(choice => choice.value === value.secondaryWithinGroup) ? value.secondaryWithinGroup : null;
      if (withinGroup || secondaryWithinGroup) out.subjectSorts[group] = { ...(withinGroup ? { withinGroup } : {}), ...(secondaryWithinGroup ? { secondaryWithinGroup } : {}) };
    }
  }
  return out;
}

export function effectiveProgress(video, overrides = []) {
  if (overrides.includes(video.id)) return 0;
  if (video.percentWatched < WATCHED_THRESHOLD) return 0;
  return video.percentWatched;
}

/**
 * Fold cluster names onto one canonical spelling.
 *
 * Group identity is a plain string match, so `"tech & ai"` and `"Tech & AI"`
 * used to become two separate groups with two headings. The model is asked for
 * the taxonomy's exact spellings but is not guaranteed to obey, and stray
 * whitespace is just as likely.
 *
 * Taxonomy spellings always win. Names the model invented fold onto whichever
 * spelling arrived first, so they stay consistent within a single sort even
 * though there is no canonical form to appeal to.
 */
function makeCanonicaliser(taxonomy) {
  const seen = new Map(
    [...taxonomy, OTHER_GROUP, UNAVAILABLE_GROUP].map(name => [name.toLowerCase(), name]),
  );
  return (raw) => {
    const trimmed = String(raw ?? '').trim();
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
    return seen.get(key);
  };
}

function compareStrings(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base' });
}

function compareTitles(a, b) {
  return compareStrings(a.title, b.title);
}

const SIMPLE_SORTS = {
  duration: (a, b) => compareDuration(a, b),
  title: compareTitles,
  channel: (a, b) => compareStrings(a.channel, b.channel) || compareTitles(a, b),
};

function durationKey(video) {
  const value = Number(video?.duration);
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function compareDuration(a, b, direction = 1) {
  const aKey = durationKey(a), bKey = durationKey(b);
  const aUnknown = !Number.isFinite(aKey), bUnknown = !Number.isFinite(bKey);
  if (aUnknown || bUnknown) return aUnknown === bUnknown ? 0 : (aUnknown ? 1 : -1);
  return direction * (aKey - bKey);
}

/**
 * The non-AI sorts: one comparator over the whole playlist, no groups. The
 * output deliberately carries no `cluster` or `inProgress` key — the UI reads
 * their absence as "no headings, no unwatch control" (WLModal.toGroups,
 * WLHeadings.boundariesFrom).
 * @param {'duration'|'title'|'channel'} by
 */
export function buildSimpleSortOrder(videos, by = 'duration') {
  const comparator = SIMPLE_SORTS[by];
  if (!comparator) throw new Error(`Unknown sort: ${by}`);
  return [...videos].sort(comparator);
}

export function buildDurationSortOrder(videos) {
  return buildSimpleSortOrder(videos, 'duration');
}

// 'playlist' has no comparator: the videos already arrive in playlist order and
// every step below preserves it.
const WITHIN_GROUP = {
  'duration-asc': (a, b) => compareDuration(a, b),
  'duration-desc': (a, b) => compareDuration(a, b, -1),
  'playlist': null,
  'title': compareTitles,
  'title-desc': (a, b) => compareTitles(b, a),
};

function compareBySortKey(key, a, b) {
  if (key === 'playlist') return 0;
  return WITHIN_GROUP[key]?.(a, b) ?? 0;
}

/**
 * Order (with the default options):
 *   1. In progress, by remaining watch time ascending
 *   2. Topic groups in taxonomy order, by duration ascending within each
 *   3. Other, then Unavailable
 *
 * `options` (see SORT_CHOICES) moves the in-progress videos into their groups,
 * changes the order inside a group, and changes the order of the groups.
 * Unavailable is last whatever the options say.
 *
 * Every available video carries `inProgress` in the output, because with
 * `inProgress: 'within'` a started video keeps its cluster name and the UI can
 * no longer infer "started" from `cluster === null`.
 */
export function buildSortOrder(videos, clusterResult, overrides = [], taxonomy = TAXONOMY, options = {}) {
  if (videos.length === 0) return [];
  const { withinGroup, secondaryWithinGroup, inProgress, groupOrder } = normalizeSortOptions(options);

  const remaining = (v) => v.duration * (1 - effectiveProgress(v, overrides) / 100);
  const byRemaining = (a, b) => remaining(a) - remaining(b);
  const originalPosition = new Map(videos.map((video, index) => [video.id, index]));
  const sortWithin = (list, groupName) => {
    const override = options.subjectSorts?.[groupName] || {};
    const primary = override.withinGroup || withinGroup;
    const secondary = override.secondaryWithinGroup || secondaryWithinGroup;
    return list.sort((a, b) =>
    compareBySortKey(primary, a, b) ||
    compareBySortKey(secondary, a, b) ||
    originalPosition.get(a.id) - originalPosition.get(b.id));
  };

  const available = videos
    .filter(v => !v.unavailable)
    .map(v => ({ ...v, inProgress: effectiveProgress(v, overrides) > 0 }));
  const unavailable = videos
    .filter(v => v.unavailable)
    .map(v => ({ ...v, cluster: UNAVAILABLE_GROUP }));

  const top = inProgress === 'top'
    ? available.filter(v => v.inProgress).sort(byRemaining).map(v => ({ ...v, cluster: null }))
    : [];
  const toGroup = inProgress === 'top' ? available.filter(v => !v.inProgress) : available;

  const canonical = makeCanonicaliser(taxonomy);
  const fallbackName = options.fallbackGroup || taxonomy.find(name => String(name).trim().toLocaleLowerCase() === 'other / uncategorised') || OTHER_GROUP;
  const clusterOf = new Map();
  for (const cluster of clusterResult.clusters || []) {
    const name = canonical(cluster.name);
    for (const videoId of cluster.videoIds) clusterOf.set(videoId, name);
  }

  const groups = new Map();
  for (const video of toGroup) {
    const name = clusterOf.get(video.id) || fallbackName;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ ...video, cluster: name });
  }
  // With 'top' the started videos were already pulled out above, so this pass
  // is a plain sortWithin; with 'within' it floats the started ones first.
  for (const [name, group] of groups) {
    if (inProgress === 'sort') {
      groups.set(name, sortWithin(group, name));
    } else {
      const started = group.filter(v => v.inProgress).sort(byRemaining);
      const rest = sortWithin(group.filter(v => !v.inProgress), name);
      groups.set(name, [...started, ...rest]);
    }
  }

  // Taxonomy order first, then any model-invented names, then Other.
  const custom = taxonomy.filter(name => name !== OTHER_GROUP && name !== UNAVAILABLE_GROUP && name !== fallbackName);
  const invented = [...groups.keys()]
    .filter(name => !custom.includes(name) && name !== OTHER_GROUP && name !== fallbackName)
    .sort();
  const byTaxonomy = [...custom, ...invented].filter(name => groups.has(name));

  let ordered = byTaxonomy;
  if (groupOrder === 'size' || groupOrder === 'size-asc') {
    const rank = new Map(byTaxonomy.map((name, i) => [name, i]));
    const direction = groupOrder === 'size' ? -1 : 1;
    ordered = [...byTaxonomy].sort((a, b) =>
      direction * (groups.get(a).length - groups.get(b).length) || rank.get(a) - rank.get(b));
  } else if (groupOrder === 'alpha') {
    ordered = [...byTaxonomy].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  const grouped = [];
  for (const name of [...ordered, fallbackName, ...(fallbackName === OTHER_GROUP ? [] : [OTHER_GROUP])]) {
    if (groups.has(name)) grouped.push(...groups.get(name));
  }

  return [...top, ...grouped, ...unavailable];
}
