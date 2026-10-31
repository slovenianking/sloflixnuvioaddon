import { SloFlixClient, DEFAULT_API_URL } from './lib/sloflixClient.js';
import { TTLCache } from './lib/cache.js';
import renderConfigurePage from './lib/configurePage.js';
import { toCatalogPreview, toMovieMeta, toSeriesMeta, fromId, pickGenres, pickYear } from './lib/mappers.js';

const CATALOG_TTL_MS = 30 * 60 * 1000; // 30 min
const STREAM_TTL_MS = 5 * 60 * 1000; // 5 min (SloFlix source povezave lahko potečejo)
// Kako dolgo proxy čaka, da CDN začne odgovarjati, preden obupa (hitra napaka
// namesto večnega vrtenja predvajalnika).
const UPSTREAM_TIMEOUT_MS = 12 * 1000;
const TITLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MATCH_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const EXT_SUBTITLE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// Predpomnilniki živijo v pomnilniku Worker isolata (dokler je isolate topel).
// Ob hladnem zagonu se preprosto znova napolnijo.
const catalogCache = new TTLCache(CATALOG_TTL_MS);
const streamCache = new TTLCache(STREAM_TTL_MS);
const titleCache = new TTLCache(TITLE_TTL_MS);
const matchCache = new TTLCache(MATCH_TTL_MS);
const extSubtitleCache = new TTLCache(EXT_SUBTITLE_TTL_MS);
const clientCache = new Map(); // username -> SloFlixClient (obdrži prijavni žeton)

const manifest = {
  id: 'com.jellysloflix.stremio',
  version: '1.4.0',
  name: 'SloFlix',
  description:
    'Glej Sloflix neposredno preko Nuvio ali Stremio, z vašim lastnim računom Sloflix. Vključno s slovenskimi podnapisi SloFlix - tudi za vsebino, ki jo predvajate iz katerega koli drugega addona (Torrentio, Comet ...), ne le iz tega.',
  logo: '/icon.png', // placeholder; rewritten to an absolute URL per-request in the manifest.json override below
  // catalog/meta stay scoped to our own 'sloflix:' ids exactly as before.
  // stream and subtitles are ALSO scoped to 'tt' (IMDb) ids - that's what
  // lets Stremio/Nuvio query THIS addon for a SloFlix source (and Slovenian
  // subtitles) whenever the user searches/opens ANY title via IMDb metadata
  // (Cinemeta), not just when browsing our own "SloFlix Filmi"/"Serije"
  // catalogs. Without the 'tt' prefix here, SloFlix never showed up
  // alongside Torrentio/ThePirateBay+/AIOStreams etc. in Nuvio's stream
  // picker for titles found via search.
  resources: [
    'catalog',
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['sloflix:'] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['sloflix:', 'tt'] },
    // 'sloflix:' is included here (alongside 'tt') so Nuvio's own subtitle
    // picker - which only ever queries this standalone resource, and does
    // NOT read the inline `subtitles` array set on stream objects in
    // defineStreamHandler below - also gets results for our own catalog
    // titles, not just for content played from other addons.
    { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt', 'sloflix:'] }
  ],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'sloflix-movies',
      name: 'SloFlix Filmi',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'series',
      id: 'sloflix-series',
      name: 'SloFlix Serije',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'movie',
      id: 'sloflix-slovenski',
      name: 'SloFlix Slovenski filmi',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'movie',
      id: 'sloflix-slosinh',
      name: 'SloFlix SLOSiNH (risanke in risani filmi)',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'series',
      id: 'sloflix-slovenski-series',
      name: 'SloFlix Slovenske serije',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'series',
      id: 'sloflix-slosinh-series',
      name: 'SloFlix SLOSiNH (risanke in risane serije)',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
  config: [
    { key: 'username', type: 'text', title: 'SloFlix uporabniško ime (e-pošta)' },
    { key: 'password', type: 'password', title: 'SloFlix geslo' }
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: true
  }
};

// ==========================================
// Pomožne funkcije
// ==========================================
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

function text(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS, ...extra }
  });
}

function getClient(config, env) {
  const username = config && config.username;
  const password = config && config.password;
  if (!username || !password) {
    throw new Error('Ta addon zahteva SloFlix uporabniško ime in geslo. Uporabite gumb "Configure" ob namestitvi.');
  }
  let client = clientCache.get(username);
  if (!client || client.password !== password) {
    client = new SloFlixClient({ apiUrl: (env && env.SLOFLIX_API_URL) || DEFAULT_API_URL, username, password });
    clientCache.set(username, client);
  }
  return client;
}

async function getCatalogData(client) {
  return catalogCache.getOrLoad(client.username, () => client.getCatalog());
}

// Javni naslov: PUBLIC_URL (če je nastavljen) sicer naslov, na katerega je prispela zahteva.
function getPublicUrl(ctx) {
  if (ctx.env && ctx.env.PUBLIC_URL) return String(ctx.env.PUBLIC_URL).replace(/\/+$/, '');
  return ctx.baseUrl;
}

function buildPlayUrl(ctx, mediaId, qualityIndex) {
  const configStr = encodeURIComponent(JSON.stringify(ctx.config));
  const base = `${getPublicUrl(ctx)}/${configStr}/play/${encodeURIComponent(mediaId)}`;
  return qualityIndex === undefined ? base : `${base}/${qualityIndex}`;
}

function buildSubsUrl(ctx, mediaId, qualityIndex) {
  const configStr = encodeURIComponent(JSON.stringify(ctx.config));
  const base = `${getPublicUrl(ctx)}/${configStr}/subs/${encodeURIComponent(mediaId)}`;
  return qualityIndex === undefined ? base : `${base}/${qualityIndex}`;
}

function buildExternalSubsUrl(ctx, mediaId) {
  const configStr = encodeURIComponent(JSON.stringify(ctx.config));
  return `${getPublicUrl(ctx)}/${configStr}/subs-tt/${encodeURIComponent(mediaId)}`;
}

function normalizeTitle(s) {
  return (s || '').toLowerCase().trim();
}

// Cinemeta: Stremiov javni metapodatkovni addon (brez ključa) - IMDb id -> naslov + leto.
async function fetchCinemetaTitle(type, imdbId) {
  const cinemetaType = type === 'series' ? 'series' : 'movie';
  const res = await fetch(`https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`);
  const data = await res.json().catch(() => null);
  const meta = data && data.meta;
  if (!meta || !meta.name) return { title: null, year: null };
  return {
    title: meta.name,
    year: ((meta.year || meta.released || '') + '').slice(0, 4)
  };
}

function pickBestMatch(results, title, year) {
  const t = normalizeTitle(title);
  let best = null;
  for (const item of results) {
    const names = [item.media_name, item.media_name_en].map(normalizeTitle);
    if (!names.includes(t)) continue;
    const itemYear = (item.media_year || '') + '';
    if (!best || itemYear === year) best = item;
  }
  return best || null;
}

// Katalog -> SloFlix žanrska oznaka
const GENRE_CATALOGS = {
  'sloflix-slovenski': 'Slovenski',
  'sloflix-slosinh': 'SLOSiNH',
  'sloflix-slovenski-series': 'Slovenski',
  'sloflix-slosinh-series': 'SLOSiNH'
};
const BASE_CATALOGS = new Set(['sloflix-movies', 'sloflix-series']);
const EXCLUDED_FROM_BASE_GENRES = [...new Set(Object.values(GENRE_CATALOGS))];

// ==========================================
// Stremio resource handlerji
// ==========================================
async function handleCatalog(ctx, type, id, extra) {
  const client = getClient(ctx.config, ctx.env);
  const search = extra && extra.search;
  const skip = (extra && parseInt(extra.skip, 10)) || 0;
  const pageSize = 100;
  const genreFilter = GENRE_CATALOGS[id];

  let items;
  if (search) {
    const results = await client.searchCatalog(search);
    items = results.filter((item) =>
      type === 'movie'
        ? item.media_type === 1 || (!item.media_type && !item.seasons)
        : item.media_type === 2 || item.seasons
    );
  } else {
    const { movies, shows } = await getCatalogData(client);
    items = type === 'movie' ? movies : shows;
  }

  if (genreFilter) {
    items = items.filter((item) => pickGenres(item).includes(genreFilter));
  } else if (BASE_CATALOGS.has(id)) {
    items = items.filter((item) => !pickGenres(item).some((g) => EXCLUDED_FROM_BASE_GENRES.includes(g)));
  }

  // Najprej novejše (kot "Leto: najprej novejše" na SloFlix)
  items = [...items].sort((a, b) => {
    const yearA = parseInt(pickYear(a), 10);
    const yearB = parseInt(pickYear(b), 10);
    return (isNaN(yearB) ? -Infinity : yearB) - (isNaN(yearA) ? -Infinity : yearA);
  });

  if (!search) items = items.slice(skip, skip + pageSize);

  return { metas: items.map((item) => toCatalogPreview(item, type)) };
}

async function handleMeta(ctx, type, id) {
  const client = getClient(ctx.config, ctx.env);
  const mediaId = fromId(id);
  const item = await client.getSingle(mediaId);

  if (type === 'movie') return { meta: toMovieMeta(item) };

  const episodes = await client.getShowEpisodes(mediaId);
  return { meta: toSeriesMeta(item, episodes) };
}

// 'sloflix:' id -> neposredno; IMDb 'tt...' (opcijsko :sezona:epizoda) -> ujemanje po naslovu/letu.
async function resolveMediaIdForStream(type, id, client) {
  if (String(id).startsWith('sloflix:')) return fromId(id);

  const [imdbId, seasonStr, episodeStr] = String(id).split(':');
  const season = seasonStr ? parseInt(seasonStr, 10) : null;
  const episode = episodeStr ? parseInt(episodeStr, 10) : null;

  const { title, year } = await titleCache.getOrLoad(`${type}:${imdbId}`, () => fetchCinemetaTitle(type, imdbId));
  if (!title) return null;

  const match = await matchCache.getOrLoad(`${client.username}:${type}:${imdbId}`, async () => {
    const results = await client.searchCatalog(title);
    return pickBestMatch(results, title, year);
  });
  if (!match) return null;

  let mediaId = match.media_id || match.id;

  if (type === 'series') {
    if (!season || !episode) return null;
    const episodes = await matchCache.getOrLoad(`${client.username}:episodes:${mediaId}`, () =>
      client.getShowEpisodes(mediaId)
    );
    const ep = episodes.find((e) => e.season === season && e.episode === episode);
    if (!ep) return null;
    mediaId = ep.id || ep.media_id;
  }

  return mediaId;
}

async function handleStream(ctx, type, id) {
  let client;
  try {
    client = getClient(ctx.config, ctx.env);
  } catch (err) {
    // Še ni nastavljeno - ne prispevamo nič, da ne podremo celotne zahteve.
    return { streams: [] };
  }

  let mediaId;
  try {
    mediaId = await resolveMediaIdForStream(type, id, client);
  } catch (err) {
    mediaId = null;
  }
  if (!mediaId) return { streams: [] };

  try {
    const resolved = await streamCache.getOrLoad(`${client.username}:${mediaId}`, () => client.resolveStream(mediaId));

    return {
      streams: resolved.streams.map((s, idx) => ({
        url: buildPlayUrl(ctx, mediaId, idx),
        title: s.score ? `SloFlix - ${s.label}` : 'SloFlix',
        subtitles: s.subtitleUrl
          ? [{ id: `sloflix-slv-${mediaId}-${idx}`, url: buildSubsUrl(ctx, mediaId, idx), lang: 'slv' }]
          : undefined,
        behaviorHints: { notWebReady: false, bingeGroup: `sloflix-${mediaId}` }
      }))
    };
  } catch (err) {
    // Razreševanje ni uspelo - ponudi eno leno razrešeno povezavo (/play/ bo poskusil znova).
    return {
      streams: [
        {
          url: buildPlayUrl(ctx, mediaId),
          title: 'SloFlix',
          behaviorHints: { notWebReady: false }
        }
      ]
    };
  }
}

async function handleSubtitles(ctx, type, id) {
  try {
    const client = getClient(ctx.config, ctx.env);

    if (String(id).startsWith('sloflix:')) {
      const mediaId = fromId(id);
      const subtitleUrl = await extSubtitleCache.getOrLoad(`${client.username}:${mediaId}`, () =>
        client.getSubtitleUrl(mediaId)
      );
      if (!subtitleUrl) return { subtitles: [] };
      return {
        subtitles: [{ id: `sloflix-slv-${mediaId}`, url: buildExternalSubsUrl(ctx, mediaId), lang: 'slv' }]
      };
    }

    const mediaId = await resolveMediaIdForStream(type, id, client);
    if (!mediaId) return { subtitles: [] };

    const subtitleUrl = await extSubtitleCache.getOrLoad(`${client.username}:${mediaId}`, () =>
      client.getSubtitleUrl(mediaId)
    );
    if (!subtitleUrl) return { subtitles: [] };

    return {
      subtitles: [{ id: `sloflix-slv-${mediaId}`, url: buildExternalSubsUrl(ctx, mediaId), lang: 'slv' }]
    };
  } catch (err) {
    // Podnapisi nikoli ne smejo ovirati predvajanja videa iz drugega addona.
    return { subtitles: [] };
  }
}

// ==========================================
// Proxy za video in podnapise (fetch + stream, brez Node http/https)
// ==========================================
async function fetchUpstream(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // Timer velja le do prihoda glav; telo se nato pretaka brez omejitve.
    return await fetch(url, { ...init, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function proxyStream(request, targetUrl) {
  try {
    new URL(targetUrl);
  } catch (err) {
    return text('Invalid upstream URL', 400);
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: 'https://player.sloflix.com/',
    Origin: 'https://player.sloflix.com',
    'Accept-Encoding': 'identity'
  };
  const range = request.headers.get('range');
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetchUpstream(targetUrl, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return text(
      timedOut ? `Vir se ni odzval znotraj ${UPSTREAM_TIMEOUT_MS / 1000}s` : 'Upstream request error: ' + err.message,
      timedOut ? 504 : 502
    );
  }

  const out = new Headers(CORS_HEADERS);
  out.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  ['content-type', 'content-range', 'accept-ranges', 'cache-control'].forEach((h) => {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  });
  if (!upstream.headers.get('content-encoding')) {
    const len = upstream.headers.get('content-length');
    if (len) out.set('content-length', len);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function proxySubtitle(targetUrl) {
  try {
    new URL(targetUrl);
  } catch (err) {
    return text('Invalid subtitle URL', 400);
  }

  let upstream;
  try {
    upstream = await fetchUpstream(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://sloflix.com/',
        Origin: 'https://sloflix.com',
        'Accept-Encoding': 'identity'
      }
    });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return text(
      timedOut ? `Podnapisi se niso odzvali znotraj ${UPSTREAM_TIMEOUT_MS / 1000}s` : 'Subtitle proxy error: ' + err.message,
      timedOut ? 504 : 502
    );
  }

  // Nekateri predvajalniki zavrnejo application/octet-stream, zato ga normaliziramo.
  let contentType = upstream.headers.get('content-type');
  if (!contentType || /octet-stream/i.test(contentType)) {
    contentType = /\.vtt(\?|$)/i.test(targetUrl) ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8';
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': contentType, ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' }
  });
}

async function pickStream(ctx, mediaId, qualityIndexRaw) {
  const client = getClient(ctx.config, ctx.env);
  const resolved = await streamCache.getOrLoad(`${client.username}:${mediaId}`, () => client.resolveStream(mediaId));
  const requestedIndex = parseInt(qualityIndexRaw, 10);
  return (!isNaN(requestedIndex) && resolved.streams[requestedIndex]) || resolved.streams[0];
}

// ==========================================
// Usmerjevalnik
// ==========================================
const RESERVED_FIRST_SEGMENTS = new Set(['manifest.json', 'configure', 'catalog', 'meta', 'stream', 'subtitles']);

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

function stripJson(s) {
  return (s || '').replace(/\.json$/i, '');
}

// "search=foo%20bar&skip=100.json" -> { search: 'foo bar', skip: '100' }
function parseExtra(rawSegment) {
  const extra = {};
  if (!rawSegment) return extra;
  for (const pair of stripJson(rawSegment).split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const key = safeDecode(i === -1 ? pair : pair.slice(0, i));
    const value = i === -1 ? '' : safeDecode(pair.slice(i + 1));
    extra[key] = value;
  }
  return extra;
}

function parseConfig(rawSegment) {
  if (!rawSegment) return null;
  try {
    const parsed = JSON.parse(safeDecode(rawSegment));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function buildManifest(baseUrl, hasConfig) {
  const manifestResp = JSON.parse(JSON.stringify(manifest));
  manifestResp.logo = `${baseUrl}/icon.png`;
  if (hasConfig && manifestResp.behaviorHints) {
    // Ko je addon nastavljen, ga Stremio/Nuvio obravnava kot že konfiguriranega.
    delete manifestResp.behaviorHints.configurationRequired;
    delete manifestResp.behaviorHints.configurable;
  }
  return manifestResp;
}

async function route(request, env) {
  const url = new URL(request.url);
  const baseUrl = url.origin;
  const raw = url.pathname.split('/').filter(Boolean);

  if (raw.length === 0) return Response.redirect(`${baseUrl}/configure`, 302);

  let rawConfig = null;
  if (!RESERVED_FIRST_SEGMENTS.has(raw[0])) rawConfig = raw.shift();
  const config = parseConfig(rawConfig);
  const segs = raw.map(safeDecode);
  const ctx = { config, env, baseUrl };

  const resource = segs[0];

  if (resource === 'manifest.json') return json(buildManifest(baseUrl, !!rawConfig));

  if (resource === 'configure' || (resource === undefined && rawConfig)) {
    return new Response(renderConfigurePage(buildManifest(baseUrl, false)), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  try {
    switch (resource) {
      case 'catalog':
        // /catalog/:type/:id.json  ali  /catalog/:type/:id/:extra.json
        return json(
          await handleCatalog(ctx, segs[1], stripJson(segs[2]), parseExtra(raw[3]))
        );
      case 'meta':
        return json(await handleMeta(ctx, segs[1], stripJson(segs[2])));
      case 'stream':
        return json(await handleStream(ctx, segs[1], stripJson(segs[2])));
      case 'subtitles':
        return json(await handleSubtitles(ctx, segs[1], stripJson(segs[2])));
      case 'play': {
        const stream = await pickStream(ctx, segs[1], segs[2]);
        return await proxyStream(request, stream.streamUrl);
      }
      case 'subs': {
        const stream = await pickStream(ctx, segs[1], segs[2]);
        if (!stream || !stream.subtitleUrl) return text('Za to vsebino ni na voljo slovenskih podnapisov.', 404);
        return await proxySubtitle(stream.subtitleUrl);
      }
      case 'subs-tt': {
        const client = getClient(ctx.config, env);
        const mediaId = segs[1];
        const subtitleUrl = await extSubtitleCache.getOrLoad(`${client.username}:${mediaId}`, () =>
          client.getSubtitleUrl(mediaId)
        );
        if (!subtitleUrl) return text('Za to vsebino ni na voljo slovenskih podnapisov.', 404);
        return await proxySubtitle(subtitleUrl);
      }
      default:
        return text('Not found', 404);
    }
  } catch (err) {
    if (resource === 'play') return text('SloFlix proxy error: ' + err.message, 502);
    if (resource === 'subs' || resource === 'subs-tt') return text('SloFlix subtitle proxy error: ' + err.message, 502);
    return json({ err: err.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405);
    return route(request, env);
  }
};
