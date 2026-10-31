
/**
 * Minimal SloFlix API client, adapted from the JellySloFlix project
 * (sync.js / server.js) for use inside a Stremio addon.
 */

const DEFAULT_API_URL = 'https://api.sloflix.com';

function buildHeaders(extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: 'https://sloflix.com/',
    Origin: 'https://sloflix.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,sl;q=0.8',
    ...extra
  };
}

class SloFlixClient {
  constructor({ apiUrl = DEFAULT_API_URL, username, password, token } = {}) {
    this.baseUrl = apiUrl.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.token = token || null;
    this.headers = buildHeaders();
  }

  async login() {
    if (!this.username || !this.password) {
      throw new Error('Manjkajo SloFlix poverilnice (username/password).');
    }
    const res = await fetch(`${this.baseUrl}/v1/user/login`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password })
    });
    const data = await res.json().catch(() => ({}));
    if (data.code === 200 && data.metadata && data.metadata.access_token) {
      this.token = data.metadata.access_token;
      return this.token;
    }
    throw new Error(
      `SloFlix prijava ni uspela: ${(data.error && data.error.message) || data.message || res.status}`
    );
  }

  async ensureToken() {
    if (!this.token) await this.login();
    return this.token;
  }

  async authedFetch(pathAndQuery, opts = {}) {
    await this.ensureToken();
    const url = `${this.baseUrl}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
    let res = await fetch(url, {
      ...opts,
      headers: { ...this.headers, ...(opts.headers || {}), Authorization: `Bearer ${this.token}` }
    });

    if (res.status === 401 || res.status === 500) {
      // Token may have expired - re-login once and retry.
      this.token = null;
      await this.login();
      res = await fetch(url, {
        ...opts,
        headers: { ...this.headers, ...(opts.headers || {}), Authorization: `Bearer ${this.token}` }
      });
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} @ ${pathAndQuery}`);
    }
    return res.json();
  }

  /** Fetch the full movie+series catalog via pagination from /v1/media */
  async getCatalog({ sortBy = 1, pageSize = 100, maxItems = 4000 } = {}) {
    let allItems = [];
    let offset = 0;
    let totalAvailable = Infinity;

    while (allItems.length < totalAvailable && allItems.length < maxItems) {
      const response = await this.authedFetch(`/v1/media?sortBy=${sortBy}&limit=${pageSize}&offset=${offset}`);
      let batch = [];
      if (response && Array.isArray(response.data)) {
        batch = response.data;
        if (response.metadata && response.metadata.all_movies) {
          totalAvailable = response.metadata.all_movies;
        }
      } else if (Array.isArray(response)) {
        batch = response;
      }
      if (batch.length === 0) break;
      allItems.push(...batch);
      offset += batch.length;
      if (batch.length < pageSize) break;
    }

    const movies = allItems.filter(
      (item) => item.media_type === 1 || item.type === 'movie' || (!item.media_type && !item.seasons)
    );
    const shows = allItems.filter(
      (item) => item.media_type === 2 || item.type === 'series' || item.type === 'show' || item.seasons
    );
    return { movies, shows };
  }

  async searchCatalog(keyword) {
    const response = await this.authedFetch(`/v1/media/search?keyword=${encodeURIComponent(keyword)}`);
    if (response && Array.isArray(response.data)) return response.data;
    if (Array.isArray(response)) return response;
    return [];
  }

  async getSingle(mediaId) {
    const response = await this.authedFetch(`/v1/media/single/${mediaId}?dont_count_view=true`);
    return response && response.data ? response.data : response;
  }

  /** Fetch all episodes for a show across all its seasons */
  async getShowEpisodes(showId) {
    const single = await this.getSingle(showId);
    const seasons = (single && single.seasons) || [1];
    const allEpisodes = [];

    for (const seasonNum of seasons) {
      try {
        const epData = await this.authedFetch(`/v1/media/episodes/${showId}/${seasonNum}`);
        if (epData && Array.isArray(epData.data)) {
          for (const ep of epData.data) {
            allEpisodes.push({
              ...ep,
              season: seasonNum,
              episode: ep.episode_index || ep.episode || 1
            });
          }
        }
      } catch (err) {
        // skip missing season
      }
    }
    return allEpisodes;
  }

  /**
   * Pull the (SloFlix-adapted) Slovenian subtitle URL out of a media item, if
   * it has one. A title can have several sources and any of them may carry
   * subtitle_location - we don't care which underlying video source it came
   * from since we're only ever surfacing the subtitle track itself.
   */
  static extractSubtitleUrl(mediaItem) {
    const sources = (mediaItem && (mediaItem.media_sources || mediaItem.sources)) || [];
    for (const sourceObj of sources) {
      let subtitleUrl = sourceObj.subtitle_location || sourceObj.subtitles || sourceObj.subtitle || null;
      if (subtitleUrl) {
        if (!subtitleUrl.startsWith('http')) subtitleUrl = `https://sloflix.com/subtitles/${subtitleUrl}`;
        return subtitleUrl;
      }
    }
    return null;
  }

  /**
   * Lightweight subtitle-only lookup: just getSingle() + extractSubtitleUrl(),
   * with none of resolveStream()'s video-source probing/scoring overhead.
   * Used by the standalone `subtitles` resource handler (matching arbitrary
   * IMDb-id content to a SloFlix title), where all we need is the subtitle
   * URL - not a playable video stream.
   */
  async getSubtitleUrl(mediaId) {
    const item = await this.getSingle(mediaId);
    return SloFlixClient.extractSubtitleUrl(item);
  }

  /**
   * Best-effort quality score for a SloFlix source object, so we can pick the
   * highest-quality stream instead of just the first one the API happens to
   * list first. We don't know SloFlix's exact schema for this field across
   * accounts/content, so we check several common key names, then fall back
   * to parsing quality hints (e.g. "1080p", "4K") out of any label/URL text.
   */
  static scoreSource(sourceObj, streamUrl) {
    const explicit =
      sourceObj.height ||
      sourceObj.resolution_height ||
      sourceObj.quality ||
      sourceObj.resolution ||
      sourceObj.quality_label ||
      sourceObj.label ||
      sourceObj.name ||
      sourceObj.title ||
      sourceObj.tag;
    if (typeof explicit === 'number') return explicit;

    // Prefer scanning the actual resolved CDN URL (streamUrl) over the outer
    // wrapper/proxy URL: the wrapper (e.g. player.sloflix.com/proxy?source=...)
    // rarely encodes quality, but the real file path/name it points to
    // (e.g. .../movie_1080.mp4, .../720p/index.m3u8) usually does. We still
    // fall back to any explicit field text SloFlix does provide.
    const text = String(explicit || streamUrl || '').toLowerCase();
    const match = text.match(/(\d{3,4})\s*p\b/) || text.match(/\b(4k|2160|1440|1080|720|576|480|360|240)\b/);
    if (match) {
      const token = match[1];
      if (token === '4k') return 2160;
      const num = parseInt(token, 10);
      if (!isNaN(num)) return num;
    }
    return 0; // unknown quality: sorted last among sources with detected quality
  }

  static labelForScore(score) {
    if (!score) return 'SloFlix';
    if (score >= 2160) return '4K';
    return `${score}p`;
  }

  /**
   * Identify which backend/CDN a source object actually points to, so we can
   * keep only the providers that are known to work. SloFlix sometimes offers
   * the same title from more than one backend (e.g. Doodstream vs StreamP2P);
   * StreamP2P is a P2P/torrent-style relay that needs peer discovery before
   * it can start serving bytes at all - on a fast connection it just about
   * scrapes by, but it's what makes playback hang at "loading" for minutes
   * (especially on Android TV boxes, which have less networking headroom
   * than a phone). Doodstream is a plain CDN link and starts instantly, so
   * we drop StreamP2P sources outright rather than let players sit on them.
   *
   * We don't know SloFlix's exact schema for a provider field, so this
   * checks common explicit field names first, then falls back to matching
   * known hostnames/keywords in the resolved CDN URL itself.
   */
  static detectProvider(sourceObj, streamUrl, rawSource) {
    const explicit = String(
      sourceObj.provider || sourceObj.host || sourceObj.cdn || sourceObj.source_name || sourceObj.server || ''
    ).toLowerCase();
    const haystack = `${explicit} ${streamUrl || ''} ${rawSource || ''}`.toLowerCase();

    if (/streamp2p|stream-p2p|\bp2p\b/.test(haystack)) return 'streamp2p';
    // All known Doodstream mirrors (doodstream.com, dood.to/.wf/.la/.re/.pm/.yt/.watch,
    // ds2play.com, doods.pro, dooood.com ...) share the "dood" substring.
    if (/dood/.test(haystack)) return 'doodstream';
    return 'unknown';
  }

  /**
   * Liveness check for a resolved CDN stream URL: fires the same request
   * shape the /play/ proxy will (Referer/Origin the SloFlix CDN expects, a
   * Range request) and - critically - waits for actual bytes of the body to
   * start arriving, not just a successful status/headers response. A P2P or
   * relay-style source can happily answer "200 OK" instantly and then stall
   * forever trying to find a peer before it sends any real video data; a
   * plain status/headers check would wrongly call that "alive". Used to drop
   * dead/stalled sources from what Stremio/Nuvio see, instead of listing
   * several "Stream" entries where only one actually plays.
   */
  static async probeStream(streamUrl, { timeoutMs = 6000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader = null;
    try {
      const res = await fetch(streamUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://player.sloflix.com/',
          Origin: 'https://player.sloflix.com',
          Range: 'bytes=0-65535'
        }
      });
      if (res.status >= 400) return false;
      if (!res.body || typeof res.body.getReader !== 'function') {
        // No readable stream available to actually verify with (unusual for
        // fetch, but be lenient rather than false-negative) - fall back to
        // the status check alone.
        return true;
      }
      reader = res.body.getReader();
      // Read until we see real bytes or the source stalls past timeoutMs
      // (via the AbortController above cancelling the read).
      while (true) {
        const { done, value } = await reader.read();
        if (value && value.length > 0) return true;
        if (done) return false;
      }
    } catch (err) {
      return false;
    } finally {
      clearTimeout(timer);
      if (reader) {
        try {
          await reader.cancel();
        } catch (_) {
          // ignore - we're discarding this probe either way
        }
      }
    }
  }

  /**
   * Resolve ALL playable sources for a given media/episode id, drop the ones
   * that don't actually respond, and sort what's left best quality first.
   * Each entry: { streamUrl, subtitleUrl, label, score }.
   */
  async resolveStream(mediaId) {
    const data = await this.getSingle(mediaId);
    const sources = (data && (data.media_sources || data.sources)) || [];

    let candidates = [];
    for (const sourceObj of sources) {
      const rawSource = sourceObj.media_source || sourceObj.source;
      if (!rawSource) continue;

      const match = rawSource.match(/[?&]source=([^&]+)/);
      const streamUrl = match ? decodeURIComponent(match[1]) : rawSource;
      const subtitleUrl = SloFlixClient.extractSubtitleUrl({ media_sources: [sourceObj] });

      const score = SloFlixClient.scoreSource(sourceObj, streamUrl);
      const provider = SloFlixClient.detectProvider(sourceObj, streamUrl, rawSource);
      candidates.push({ streamUrl, subtitleUrl, score, label: SloFlixClient.labelForScore(score), provider });
    }

    if (candidates.length === 0) {
      throw new Error(`Ni bilo mogoče najti veljavne povezave za predvajanje (id ${mediaId}).`);
    }

    // Drop known-bad StreamP2P sources before even probing them - probing a
    // hanging P2P relay would itself burn several seconds per source for
    // nothing, and it's the slow "stuck loading" path we're trying to avoid.
    // If every source on this title happens to be StreamP2P (no Doodstream
    // alternative at all), keep them rather than leaving nothing playable.
    const nonP2P = candidates.filter((c) => c.provider !== 'streamp2p');
    if (nonP2P.length > 0) candidates = nonP2P;

    // Drop sources that don't actually respond (expired link, dead mirror
    // ...) so Stremio/Nuvio only ever list working streams. If the probe
    // step itself fails to clear anyone (e.g. this server's own network is
    // briefly having issues), fall back to the unfiltered list rather than
    // returning nothing playable.
    const aliveFlags = await Promise.all(candidates.map((c) => SloFlixClient.probeStream(c.streamUrl)));
    let resolved = candidates.filter((_, idx) => aliveFlags[idx]);
    if (resolved.length === 0) resolved = candidates;

    // Best quality first; among ties, prefer a source we positively
    // identified as Doodstream over an unrecognized one, so which stream
    // ends up in the kept position 0 below doesn't depend on whatever order
    // SloFlix happened to list sources in for this particular title.
    const PROVIDER_RANK = { doodstream: 0, unknown: 1, streamp2p: 2 };
    resolved.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (PROVIDER_RANK[a.provider] ?? 1) - (PROVIDER_RANK[b.provider] ?? 1);
    });

    // Only ever expose a single stream to Stremio/Nuvio. In practice
    // SloFlix's "sources" for one title aren't real quality variants of the
    // same working stream - they're different backends (Doodstream vs a
    // P2P/relay one), and the P2P one can pass the liveness probe above
    // (it trickles out a first chunk or two) and then still stall for real
    // playback. Rather than trust that probe as the final word, only the
    // top candidate after filtering/sorting is ever returned, so the
    // player only ever sees the one option that actually plays.
    resolved = resolved.slice(0, 1);

    return {
      streams: resolved,
      mediaName: data.media_name,
      mediaNameEn: data.media_name_en
    };
  }
}

export { SloFlixClient, DEFAULT_API_URL };
