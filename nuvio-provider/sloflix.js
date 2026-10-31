// Nuvio provider plugin for SloFlix.
//
// IMPORTANT LIMITATION: Nuvio calls getStreams(tmdbId, mediaType, season, episode) -
// it only gives us a TMDB id, but the SloFlix API has no TMDB mapping at all.
// So this provider:
//   1) resolves the TMDB id to a title via the public TMDB API (needs a free
//      TMDB API key, set below),
//   2) searches the SloFlix catalog by that title,
//   3) picks the best title/year match and resolves its direct stream.
// This is a best-effort text match and can occasionally pick the wrong title
// or find nothing for shows with very different Slovene naming.
//
// Fill in your own SloFlix + TMDB credentials below before using.
//
// NOTE ON SUBTITLES: this file is a Nuvio "Local Scraper" - its getStreams()
// return format (name/title/url/quality/headers/provider) has no subtitle
// field in Nuvio's own spec, so SloFlix's Slovenian subtitles genuinely
// cannot be attached this way, no matter what's added here. If you want
// subtitles in Nuvio, don't use this file - instead install the addon.js
// server in this project as a regular Nuvio/Stremio ADDON (Settings ->
// Addons -> paste its /manifest.json URL, NOT Settings -> Local Scrapers).
// That addon returns proper Stream objects with a `subtitles` array, which
// both Stremio and Nuvio do support and display.

const SLOFLIX_API_URL = 'https://api.sloflix.com';
const SLOFLIX_USERNAME = 'YOUR_SLOFLIX_EMAIL';
const SLOFLIX_PASSWORD = 'YOUR_SLOFLIX_PASSWORD';
const TMDB_API_KEY = 'YOUR_TMDB_API_KEY'; // https://www.themoviedb.org/settings/api

let cachedToken = null;

function sloflixHeaders(token) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: 'https://sloflix.com/',
    Origin: 'https://sloflix.com',
    Accept: 'application/json, text/plain, */*'
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return headers;
}

function sloflixLogin() {
  return fetch(SLOFLIX_API_URL + '/v1/user/login', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, sloflixHeaders()),
    body: JSON.stringify({ username: SLOFLIX_USERNAME, password: SLOFLIX_PASSWORD })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data && data.metadata && data.metadata.access_token) {
        cachedToken = data.metadata.access_token;
        return cachedToken;
      }
      throw new Error('SloFlix login failed: ' + ((data && data.message) || 'unknown error'));
    });
}

function withToken(fn) {
  const ready = cachedToken ? Promise.resolve(cachedToken) : sloflixLogin();
  return ready.then(fn);
}

function tmdbTitle(tmdbId, mediaType) {
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const url =
    'https://api.themoviedb.org/3/' + kind + '/' + tmdbId + '?api_key=' + TMDB_API_KEY + '&language=en-US';
  return fetch(url)
    .then((res) => res.json())
    .then((data) => ({
      title: data.title || data.name || data.original_title || data.original_name,
      year: ((data.release_date || data.first_air_date || '') + '').slice(0, 4)
    }));
}

function searchSloFlix(token, keyword) {
  const url = SLOFLIX_API_URL + '/v1/media/search?keyword=' + encodeURIComponent(keyword);
  return fetch(url, { headers: sloflixHeaders(token) })
    .then((res) => res.json())
    .then((data) => (data && data.data) || data || []);
}

function pickBestMatch(results, title, year) {
  const normalize = (s) => (s || '').toLowerCase().trim();
  const t = normalize(title);
  let best = null;
  for (const item of results) {
    const names = [item.media_name, item.media_name_en].map(normalize);
    if (!names.includes(t)) continue;
    const itemYear = (item.media_year || '') + '';
    if (!best || itemYear === year) best = item;
  }
  return best || results[0] || null;
}

function resolveStreamUrl(token, mediaId) {
  const url = SLOFLIX_API_URL + '/v1/media/single/' + mediaId + '?dont_count_view=true';
  return fetch(url, { headers: sloflixHeaders(token) })
    .then((res) => res.json())
    .then((data) => {
      const d = (data && data.data) || data;
      const sources = (d && (d.media_sources || d.sources)) || [];
      for (const src of sources) {
        const raw = src.media_source || src.source;
        if (!raw) continue;
        const match = raw.match(/[?&]source=([^&]+)/);
        return {
          streamUrl: match ? decodeURIComponent(match[1]) : raw,
          name: d.media_name || d.media_name_en
        };
      }
      throw new Error('No stream source on SloFlix for media ' + mediaId);
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return tmdbTitle(tmdbId, mediaType)
    .then(({ title, year }) =>
      withToken((token) =>
        searchSloFlix(token, title).then((results) => {
          let match = pickBestMatch(results, title, year);
          if (!match) return [];

          // For series, drill into the requested season/episode.
          if (mediaType === 'tv' && season && episode) {
            const showId = match.media_id || match.id;
            const epUrl = SLOFLIX_API_URL + '/v1/media/episodes/' + showId + '/' + season;
            return fetch(epUrl, { headers: sloflixHeaders(token) })
              .then((res) => res.json())
              .then((epData) => {
                const eps = (epData && epData.data) || [];
                const ep = eps.find((e) => (e.episode_index || e.episode) === Number(episode));
                if (!ep) return [];
                const epId = ep.id || ep.media_id;
                return resolveStreamUrl(token, epId).then((r) => [
                  {
                    name: 'SloFlix',
                    title: (r.name || title) + ' S' + season + 'E' + episode,
                    url: r.streamUrl,
                    quality: 'SD/HD',
                    headers: { Referer: 'https://player.sloflix.com/', Origin: 'https://player.sloflix.com' }
                  }
                ]);
              });
          }

          const mediaId = match.media_id || match.id;
          return resolveStreamUrl(token, mediaId).then((r) => [
            {
              name: 'SloFlix',
              title: r.name || title,
              url: r.streamUrl,
              quality: 'SD/HD',
              headers: { Referer: 'https://player.sloflix.com/', Origin: 'https://player.sloflix.com' }
            }
          ]);
        })
      )
    )
    .catch((err) => {
      console.error('[SloFlix] Error:', err.message);
      return [];
    });
}

module.exports = { getStreams };
