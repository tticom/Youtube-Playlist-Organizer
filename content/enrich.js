// content/enrich.js
// Depends on: content/innertube.js

const WLEnrich = {
  MAX_DESCRIPTION: 300,

  extract(playerResponse) {
    const details = (playerResponse && playerResponse.videoDetails) || {};
    const micro =
      (playerResponse && playerResponse.microformat && playerResponse.microformat.playerMicroformatRenderer) || {};

    const description = typeof details.shortDescription === 'string'
      ? details.shortDescription.slice(0, this.MAX_DESCRIPTION)
      : null;
    const directTopics = details.topicDetails?.topicIds || playerResponse?.topicDetails?.topicIds;
    const nestedTopics = typeof WLInnerTube?.findAll === 'function'
      ? WLInnerTube.findAll(playerResponse, 'topicIds').flatMap(value => Array.isArray(value) ? value : [])
      : [];
    const topicIds = [...new Set([...(Array.isArray(directTopics) ? directTopics : []), ...nestedTopics].filter(x => typeof x === 'string'))];

    return { category: micro.category || null, description, topicIds };
  },

  /**
   * Fetch category and description for each video.
   * A failed call leaves the fields null rather than failing the whole sort —
   * classification still works from title and channel.
   */
  async enrich(videos, { concurrency = 6 } = {}) {
    const targets = videos.filter(v => !v.unavailable);
    let cursor = 0;

    const worker = async () => {
      while (cursor < targets.length) {
        const video = targets[cursor++];
        try {
          const response = await WLInnerTube.call('player', { videoId: video.id });
          const { category, description, topicIds } = this.extract(response);
          video.category = category;
          video.description = description;
          video.topicIds = topicIds;
        } catch (err) {
          // Best-effort: a failed lookup must not fail the sort. Log so a real bug
          // here doesn't masquerade as "this video simply had no category".
          console.warn(`[WL] enrichment failed for ${video.id}:`, err);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, worker);
    await Promise.all(workers);
    return videos;
  },
};
