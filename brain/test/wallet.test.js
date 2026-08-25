const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateWallet, writeWalletFile, loadWallet, publicAddress, parseSecretBytes } = require('../deployer/wallet');

test('generate + load from file does not expose secret via publicAddress', () => {
  const kp = generateWallet();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokdev-wallet-'));
  const dest = path.join(dir, 'wallet.json');
  writeWalletFile(kp, dest);
  const loaded = loadWallet({ WALLET_KEYPAIR_PATH: dest });
  assert.equal(publicAddress(loaded), publicAddress(kp));
  assert.equal(publicAddress(kp).length >= 32, true);
  const disk = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.equal(disk.length, 64);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load from JSON WALLET_SECRET_KEY', () => {
  const kp = generateWallet();
  const loaded = loadWallet({ WALLET_SECRET_KEY: JSON.stringify(Array.from(kp.secretKey)) });
  assert.equal(publicAddress(loaded), publicAddress(kp));
});

test('parseSecretBytes rejects short keys', () => {
  assert.throws(() => parseSecretBytes([1, 2, 3]), /64/);
});

test('missing env → null wallet', () => {
  assert.equal(loadWallet({}), null);
});
