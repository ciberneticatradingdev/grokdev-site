const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTweetUrl, normalizeTweet, ingestTweet } = require('../deployer/tweet');

test('parseTweetUrl accepts x.com and twitter.com status links', () => {
  assert.equal(parseTweetUrl('https://x.com/foo/status/1882368585664626774').id, '1882368585664626774');
  assert.equal(parseTweetUrl('https://twitter.com/foo/status/1882368585664626774').authorHint, 'foo');
  assert.equal(parseTweetUrl('https://x.com/i/web/status/1882368585664626774').id, '1882368585664626774');
  assert.equal(parseTweetUrl('not a url'), null);
});

test('normalizeTweet accepts a pasted payload', () => {
  const t = normalizeTweet({
    text: 'hello frog',
    author: '@someone',
    id: '1',
    media: [{ url: 'https://img.example/a.png', type: 'photo' }],
  });
  assert.equal(t.author, 'someone');
  assert.equal(t.media[0].url, 'https://img.example/a.png');
  assert.equal(t.url, 'https://x.com/someone/status/1');
});

test('ingestTweet uses pasted payload without network', async () => {
  const t = await ingestTweet({
    tweet: { text: 'payload only', author: 'dev' },
    fetchFn: async () => { throw new Error('network should not be called'); },
  });
  assert.equal(t.text, 'payload only');
  assert.equal(t.source, 'payload');
});

test('ingestTweet hits X API when bearer is set', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          data: { id: '99', text: 'from x', author_id: 'u1', created_at: '2026-01-01T00:00:00Z' },
          includes: { users: [{ id: 'u1', username: 'watched' }], media: [] },
        });
      },
    };
  };
  const t = await ingestTweet({
    url: 'https://x.com/watched/status/99',
    env: { X_BEARER_TOKEN: 'test-token' },
    fetchFn,
  });
  assert.equal(t.text, 'from x');
  assert.equal(t.author, 'watched');
  assert.equal(t.source, 'x-api');
  assert.match(calls[0].url, /\/2\/tweets\/99/);
  assert.equal(calls[0].auth, 'Bearer test-token');
});
