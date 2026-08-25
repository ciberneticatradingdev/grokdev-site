/* ============================================================
   Tweet ingest adapter.

   Works now:
     - pasted payload { text, author, media[], url, id }
     - tweet URL (x.com / twitter.com / x.com/i/web/status/ID)

   When X_BEARER_TOKEN (or X_API_BEARER) is set, uses official
   X API v2. Otherwise tries a public syndication helper for
   media, then oEmbed for text-only. Live firehose / watched
   accounts plug in when X_* + X_WATCH_ACCOUNTS are set.
   ============================================================ */

const UA = 'grokdev-brain/0.2 (+https://github.com/ciberneticatradingdev/grokdev-site)';

function parseTweetUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const m = trimmed.match(
    /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/(?:i\/web\/status|[^/\s]+\/status)\/(\d+)/i
  );
  if (!m) {
    if (/^\d{5,}$/.test(trimmed)) return { id: trimmed, url: null, authorHint: null };
    return null;
  }
  const authorHint = trimmed.match(/(?:twitter\.com|x\.com)\/([^/\s]+)\/status/i);
  const handle = authorHint && authorHint[1] !== 'i' ? authorHint[1] : null;
  return {
    id: m[1],
    url: `https://x.com/${handle || 'i'}/status/${m[1]}`,
    authorHint: handle,
  };
}

function normalizeTweet(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('tweet payload must be an object');
  const id = String(raw.id || raw.tweetId || raw.tweetID || '').trim();
  const text = String(raw.text || raw.full_text || raw.body || '').trim();
  if (!text && !id) throw new Error('tweet payload needs text or id');
  const author = String(
    raw.author || raw.username || raw.handle || raw.user?.username || raw.user?.screen_name || ''
  ).replace(/^@/, '');
  const url = raw.url || (id && author ? `https://x.com/${author}/status/${id}` : id ? `https://x.com/i/web/status/${id}` : null);
  const media = [];
  const pushMedia = (item) => {
    if (!item) return;
    if (typeof item === 'string') { media.push({ url: item, type: 'photo' }); return; }
    const u = item.url || item.media_url_https || item.preview_image_url || item.src;
    if (u) media.push({ url: u, type: item.type || 'photo' });
  };
  if (Array.isArray(raw.media)) raw.media.forEach(pushMedia);
  if (Array.isArray(raw.images)) raw.images.forEach(pushMedia);
  if (raw.photos) (Array.isArray(raw.photos) ? raw.photos : [raw.photos]).forEach(pushMedia);
  if (raw.imageUrl || raw.image) pushMedia(raw.imageUrl || raw.image);
  if (raw.media?.photos) raw.media.photos.forEach(pushMedia);
  if (raw.includes?.media) raw.includes.media.forEach(pushMedia);
  return {
    id: id || null,
    text,
    author: author || null,
    url,
    createdAt: raw.createdAt || raw.created_at || null,
    media,
    source: raw.source || 'payload',
  };
}

function bearer(env) {
  return (env.X_BEARER_TOKEN || env.X_API_BEARER || env.TWITTER_BEARER_TOKEN || '').trim();
}

async function fetchJson(url, opts = {}, fetchFn = fetch) {
  const r = await fetchFn(url, {
    ...opts,
    headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers || {}) },
    signal: opts.signal || AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!r.ok) {
    const msg = json?.detail || json?.title || json?.error || `http ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return json;
}

async function fromXApi(id, env, fetchFn) {
  const token = bearer(env);
  if (!token) return null;
  const host = (env.X_API_HOST || 'https://api.x.com').replace(/\/$/, '');
  const qs = new URLSearchParams({
    'tweet.fields': 'created_at,text,author_id,attachments',
    expansions: 'author_id,attachments.media_keys',
    'user.fields': 'username,name',
    'media.fields': 'url,preview_image_url,type,width,height,alt_text',
  });
  const j = await fetchJson(`${host}/2/tweets/${id}?${qs}`, {
    headers: { authorization: 'Bearer ' + token },
  }, fetchFn);
  const data = j.data;
  if (!data) throw new Error('x api returned no tweet');
  const users = j.includes?.users || [];
  const media = j.includes?.media || [];
  const author = users.find(u => u.id === data.author_id)?.username || null;
  return normalizeTweet({
    id: data.id,
    text: data.text,
    author,
    created_at: data.created_at,
    media,
    source: 'x-api',
  });
}

async function fromFx(id, fetchFn) {
  const hosts = [
    `https://api.fxtwitter.com/status/${id}`,
    `https://api.vxtwitter.com/Twitter/status/${id}`,
  ];
  let last = null;
  for (const url of hosts) {
    try {
      const j = await fetchJson(url, {}, fetchFn);
      const t = j.tweet || j;
      const photos = t.media?.photos || t.media_extended || t.photos || [];
      const media = (Array.isArray(photos) ? photos : []).map(p => ({
        url: p.url || p.thumbnail_url || p.src,
        type: p.type || 'photo',
      }));
      if (t.media_urls) t.media_urls.forEach(u => media.push({ url: u, type: 'photo' }));
      return normalizeTweet({
        id: t.id || t.tweetID || id,
        text: t.text || t.full_text,
        author: t.author?.screen_name || t.user_screen_name || t.author?.username,
        url: t.url,
        created_at: t.created_at || t.created_timestamp,
        media,
        source: 'syndication',
      });
    } catch (e) { last = e; }
  }
  if (last) throw last;
  return null;
}

function stripOembedHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fromOembed(url, fetchFn) {
  const j = await fetchJson(
    'https://publish.twitter.com/oembed?omit_script=1&url=' + encodeURIComponent(url),
    {},
    fetchFn
  );
  const author = (j.author_url || '').split('/').filter(Boolean).pop() || null;
  return normalizeTweet({
    id: parseTweetUrl(url)?.id,
    text: stripOembedHtml(j.html).replace(/\s*—\s*.+$/, '').trim() || j.html,
    author,
    url,
    source: 'oembed',
  });
}

async function ingestTweet({ url, tweet, env = process.env, fetchFn = fetch } = {}) {
  if (tweet) {
    const n = normalizeTweet(tweet);
    if (url && !n.url) n.url = url;
    return n;
  }
  if (!url) throw new Error('provide tweet.url or tweet payload');
  const parsed = parseTweetUrl(url);
  if (!parsed) throw new Error('unrecognized tweet url');
  const errors = [];
  if (bearer(env)) {
    try { return await fromXApi(parsed.id, env, fetchFn); }
    catch (e) { errors.push('x-api: ' + e.message); }
  }
  try { return await fromFx(parsed.id, fetchFn); }
  catch (e) { errors.push('syndication: ' + e.message); }
  try { return await fromOembed(parsed.url || url, fetchFn); }
  catch (e) { errors.push('oembed: ' + e.message); }
  throw new Error('could not ingest tweet (' + errors.join('; ') + '). paste a payload instead.');
}

async function lookupUserId(username, env, fetchFn) {
  const token = bearer(env);
  if (!token) throw new Error('X_BEARER_TOKEN required to watch accounts');
  const host = (env.X_API_HOST || 'https://api.x.com').replace(/\/$/, '');
  const j = await fetchJson(
    `${host}/2/users/by/username/${encodeURIComponent(username.replace(/^@/, ''))}`,
    { headers: { authorization: 'Bearer ' + token } },
    fetchFn
  );
  if (!j.data?.id) throw new Error('unknown user ' + username);
  return j.data;
}

async function fetchUserTweets(username, env = process.env, fetchFn = fetch) {
  const token = bearer(env);
  if (!token) throw new Error('X_BEARER_TOKEN required to watch accounts');
  const host = (env.X_API_HOST || 'https://api.x.com').replace(/\/$/, '');
  const user = await lookupUserId(username, env, fetchFn);
  const qs = new URLSearchParams({
    max_results: '5',
    'tweet.fields': 'created_at,text,attachments',
    expansions: 'attachments.media_keys',
    'media.fields': 'url,preview_image_url,type',
    exclude: 'replies,retweets',
  });
  const j = await fetchJson(`${host}/2/users/${user.id}/tweets?${qs}`, {
    headers: { authorization: 'Bearer ' + token },
  }, fetchFn);
  const mediaByKey = new Map((j.includes?.media || []).map(m => [m.media_key, m]));
  return (j.data || []).map(t => normalizeTweet({
    id: t.id,
    text: t.text,
    author: user.username,
    created_at: t.created_at,
    media: (t.attachments?.media_keys || []).map(k => mediaByKey.get(k)).filter(Boolean),
    source: 'x-watch',
  }));
}

function parseWatchAccounts(env = process.env) {
  return String(env.X_WATCH_ACCOUNTS || '')
    .split(/[,\s]+/)
    .map(s => s.replace(/^@/, '').trim())
    .filter(Boolean);
}

function xConfigured(env = process.env) {
  return Boolean(bearer(env));
}

module.exports = {
  parseTweetUrl,
  normalizeTweet,
  ingestTweet,
  fetchUserTweets,
  parseWatchAccounts,
  xConfigured,
  bearer,
};
