/* ============================================================
   Agent wallet — server-side only. Never log or return secrets.
   Load order: WALLET_SECRET_KEY (base58 or JSON byte array) then
   WALLET_KEYPAIR_PATH (Solana JSON array file).
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

function parseSecretBytes(raw) {
  if (raw == null) return null;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    const buf = Buffer.from(raw);
    if (buf.length === 64) return buf;
    throw new Error('secret key must be 64 bytes');
  }
  if (Array.isArray(raw)) {
    if (raw.length !== 64) throw new Error('secret key JSON array must have 64 bytes');
    return Buffer.from(raw);
  }
  if (typeof raw !== 'string') throw new Error('unsupported secret key type');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error('secret key JSON array must have 64 bytes');
    return Buffer.from(arr);
  }
  const decoded = bs58.decode(trimmed);
  if (decoded.length !== 64) throw new Error('secret key base58 must decode to 64 bytes');
  return Buffer.from(decoded);
}

function keypairFromSecret(raw) {
  const bytes = parseSecretBytes(raw);
  if (!bytes) return null;
  return Keypair.fromSecretKey(bytes);
}

function loadWallet(env = process.env) {
  const fromEnv = env.WALLET_SECRET_KEY;
  if (fromEnv && String(fromEnv).trim()) {
    return keypairFromSecret(fromEnv);
  }
  const filePath = env.WALLET_KEYPAIR_PATH && String(env.WALLET_KEYPAIR_PATH).trim();
  if (filePath) {
    const abs = path.resolve(filePath);
    const txt = fs.readFileSync(abs, 'utf8');
    return keypairFromSecret(txt);
  }
  return null;
}

function generateWallet() {
  return Keypair.generate();
}

function writeWalletFile(keypair, dest) {
  const abs = path.resolve(dest);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(Array.from(keypair.secretKey)) + '\n', { mode: 0o600 });
  return abs;
}

function publicAddress(wallet) {
  return wallet ? wallet.publicKey.toBase58() : null;
}

function redact(addr) {
  if (!addr) return null;
  if (addr.length <= 12) return addr;
  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

module.exports = {
  parseSecretBytes,
  keypairFromSecret,
  loadWallet,
  generateWallet,
  writeWalletFile,
  publicAddress,
  redact,
};
