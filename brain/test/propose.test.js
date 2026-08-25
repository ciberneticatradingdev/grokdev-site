const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { proposeFromTweet, tickerFrom } = require('../deployer/propose');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tweet.json'), 'utf8'));

test('tickerFrom strips and uppercases', () => {
  assert.equal(tickerFrom('frog'), 'FROG');
  assert.equal(tickerFrom('supercalifragilistic'), 'SUPERCALIF');
});

test('fixture tweet prefers $cashtag and tweet image', () => {
  const p = proposeFromTweet(fixture);
  assert.equal(p.symbol, 'FROG');
  assert.equal(p.imageSource, 'tweet');
  assert.equal(p.imageUrl, 'https://example.invalid/frog.png');
  assert.match(p.name.toLowerCase(), /frog/);
  assert.equal(p.twitter, fixture.url);
});

test('no media → placeholder image source', () => {
  const p = proposeFromTweet({ text: 'plain text only about widgets', author: 'a' });
  assert.equal(p.imageSource, 'placeholder');
  assert.equal(p.imageUrl, null);
  assert.equal(p.symbol, 'WIDGETS');
});
