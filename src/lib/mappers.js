
const ID_PREFIX = 'sloflix:';

function toId(mediaId) {
  return `${ID_PREFIX}${mediaId}`;
}

function fromId(id) {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
}

function pickTitle(item) {
  return item.media_name || item.media_name_en || item.title || item.name || 'Untitled';
}

function pickYear(item) {
  const raw = item.media_year || item.year || item.release_date || item.first_air_date;
  if (!raw) return undefined;
  const match = String(raw).match(/\b(19\d\d|20\d\d)\b/);
  return match ? match[1] : undefined;
}

function pickRating(item) {
  const r = item.media_rating;
  if (typeof r === 'number') return r > 10 ? (r / 10).toFixed(1) : r.toFixed(1);
  if (r && typeof r === 'object' && r.rating) return (r.rating / 10).toFixed(1);
  return undefined;
}

function pickGenres(item) {
  return (item.media_genres || []).map((g) => (typeof g === 'object' ? g.genre_name : g)).filter(Boolean);
}

function pickPoster(item) {
  return item.media_thumbnail_url || item.thumbnail || undefined;
}

function pickBackground(item) {
  return item.media_banner_url || item.banner || pickPoster(item);
}

function pickDescription(item) {
  return item.media_description || item.description || item.media_synopsis || item.synopsis || '';
}

/** Build a lightweight catalog preview item (movie or series) */
function toCatalogPreview(item, type) {
  return {
    id: toId(item.media_id || item.id),
    type,
    name: pickTitle(item),
    poster: pickPoster(item),
    posterShape: 'poster',
    background: pickBackground(item),
    description: pickDescription(item),
    releaseInfo: pickYear(item),
    imdbRating: pickRating(item),
    genres: pickGenres(item)
  };
}

/** Build a full meta object for a movie */
function toMovieMeta(item) {
  const meta = toCatalogPreview(item, 'movie');
  const runtime = item.media_duration || item.duration;
  if (runtime && !isNaN(parseInt(runtime, 10))) {
    meta.runtime = `${parseInt(runtime, 10)} min`;
  }
  return meta;
}

/** Build a full meta object for a series, including videos (episodes) list */
function toSeriesMeta(item, episodes) {
  const meta = toCatalogPreview(item, 'series');
  meta.videos = (episodes || []).map((ep) => {
    const epId = ep.id || ep.media_id || item.media_id || item.id;
    const season = ep.season_number || ep.season || 1;
    const episode = ep.episode_number || ep.episode || 1;
    return {
      id: toId(epId),
      title: ep.media_name || ep.title || `Epizoda ${episode}`,
      season,
      episode,
      thumbnail: pickPoster(ep) || meta.poster,
      overview: pickDescription(ep),
      released: undefined
    };
  });
  return meta;
}

export {
  toId,
  fromId,
  pickTitle,
  pickYear,
  pickGenres,
  toCatalogPreview,
  toMovieMeta,
  toSeriesMeta
};
