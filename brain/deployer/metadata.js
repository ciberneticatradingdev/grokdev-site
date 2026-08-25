/* ============================================================
   Metadata JSON + image handling.

   Reuse tweet image bytes when available. If PINATA_JWT is set,
   upload image then JSON to IPFS (same path pump.fun documents).
   Without Pinata we return the JSON and an honest "not uploaded"
   — never a fake ipfs CID.
   ============================================================ */
const crypto = require('crypto');
const zlib = require('zlib');

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function hashColor(seed) {
  const h = crypto.createHash('sha256').update(String(seed || 'grokdev')).digest();
  return [h[0], h[1], h[2]];
}

function placeholderPng(seed, size = 64) {
  const [r, g, b] = hashColor(seed);
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 3;
      const edge = x < 3 || y < 3 || x >= size - 3 || y >= size - 3;
      raw[i] = edge ? 20 : r;
      raw[i + 1] = edge ? 20 : g;
      raw[i + 2] = edge ? 20 : b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function isPng(buf) {
  return buf && buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
}

function buildMetadata({ name, symbol, description, imageUri, twitter, website }) {
  const meta = {
    name,
    symbol,
    description: description || '',
    image: imageUri,
    showName: true,
    createdOn: 'https://pump.fun',
  };
  if (twitter) meta.twitter = twitter;
  if (website) meta.website = website;
  return meta;
}

async function fetchImageBytes(url, fetchFn = fetch) {
  if (!url) return null;
  const r = await fetchFn(url, {
    headers: { 'user-agent': 'grokdev-brain/0.2', accept: 'image/*,*/*' },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error('image fetch http ' + r.status);
  const mime = (r.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 32) throw new Error('image too small');
  if (buf.length > 5_000_000) throw new Error('image over 5MB');
  return { bytes: buf, mime: mime.startsWith('image/') ? mime : (isPng(buf) ? 'image/png' : 'image/jpeg') };
}

async function pinataUpload({ bytes, filename, mime, jwt, fetchFn = fetch }) {
  const form = new FormData();
  form.append('network', 'public');
  form.append('file', new Blob([bytes], { type: mime }), filename);
  const r = await fetchFn('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + jwt },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.message || 'pinata http ' + r.status);
  const cid = j.data?.cid || j.cid;
  if (!cid) throw new Error('pinata response missing cid');
  return { cid, uri: 'https://ipfs.io/ipfs/' + cid };
}

async function resolveMetadata({ proposal, uri, imageUrl, env = process.env, fetchFn = fetch } = {}) {
  if (!proposal) throw new Error('proposal required');
  const explicitUri = uri || env.METADATA_URI || null;
  let image = null;
  const src = imageUrl || proposal.imageUrl;
  if (src) {
    try { image = await fetchImageBytes(src, fetchFn); }
    catch (e) { image = { error: e.message }; }
  }
  if (!image || image.error) {
    image = { bytes: placeholderPng(proposal.symbol || proposal.name), mime: 'image/png', placeholder: true, error: image?.error };
  }
  const metaPreview = buildMetadata({
    name: proposal.name,
    symbol: proposal.symbol,
    description: proposal.description,
    imageUri: src || 'placeholder://png',
    twitter: proposal.twitter,
    website: proposal.website,
  });

  const jwt = (env.PINATA_JWT || '').trim();
  if (explicitUri) {
    return {
      uploaded: false,
      uri: explicitUri,
      metadata: metaPreview,
      imageSource: proposal.imageSource,
      imageBytes: image.bytes,
      imageMime: image.mime,
      placeholder: !!image.placeholder,
      reason: 'explicit metadata uri',
    };
  }
  if (!jwt) {
    return {
      uploaded: false,
      uri: null,
      metadata: metaPreview,
      imageSource: image.placeholder ? 'placeholder' : proposal.imageSource,
      imageBytes: image.bytes,
      imageMime: image.mime,
      placeholder: !!image.placeholder,
      reason: 'PINATA_JWT not set — metadata not uploaded',
    };
  }
  const imgUp = await pinataUpload({
    bytes: image.bytes,
    filename: (proposal.symbol || 'token') + (image.mime === 'image/png' ? '.png' : '.img'),
    mime: image.mime,
    jwt,
    fetchFn,
  });
  const metadata = buildMetadata({
    name: proposal.name,
    symbol: proposal.symbol,
    description: proposal.description,
    imageUri: imgUp.uri,
    twitter: proposal.twitter,
    website: proposal.website,
  });
  const jsonUp = await pinataUpload({
    bytes: Buffer.from(JSON.stringify(metadata)),
    filename: (proposal.symbol || 'token') + '.json',
    mime: 'application/json',
    jwt,
    fetchFn,
  });
  return {
    uploaded: true,
    uri: jsonUp.uri,
    metadata,
    imageSource: image.placeholder ? 'placeholder' : proposal.imageSource,
    imageBytes: image.bytes,
    imageMime: image.mime,
    placeholder: !!image.placeholder,
    imageCid: imgUp.cid,
    metadataCid: jsonUp.cid,
  };
}

function publicMetadataView(resolved) {
  if (!resolved) return null;
  return {
    uploaded: !!resolved.uploaded,
    uri: resolved.uri,
    metadata: resolved.metadata,
    imageSource: resolved.imageSource,
    placeholder: !!resolved.placeholder,
    reason: resolved.reason || null,
  };
}

module.exports = {
  placeholderPng,
  buildMetadata,
  fetchImageBytes,
  resolveMetadata,
  publicMetadataView,
};
