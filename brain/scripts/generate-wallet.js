#!/usr/bin/env node
/* Generate a one-off agent keypair for local/dev. Prints the PUBLIC
   address only. Writes the secret JSON array to --out (mode 0600).
   Never commit that file. */
const path = require('path');
const { generateWallet, writeWalletFile, publicAddress } = require('../deployer/wallet');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  process.stdout.write(`Usage: node scripts/generate-wallet.js [--out ./secrets/wallet.json]

Writes a Solana keypair JSON array (64 bytes) and prints the public address.
Set WALLET_KEYPAIR_PATH to that file, or WALLET_SECRET_KEY to the JSON/base58 secret.
Never commit the file. Never enable DEPLOY_ENABLED until the wallet is funded and you mean it.
`);
  process.exit(0);
}

const dest = path.resolve(arg('--out', path.join(__dirname, '..', 'secrets', 'wallet.json')));
const kp = generateWallet();
writeWalletFile(kp, dest);
process.stdout.write('wallet ' + publicAddress(kp) + '\n');
process.stdout.write('wrote  ' + dest + ' (mode 0600)\n');
process.stdout.write('export WALLET_KEYPAIR_PATH=' + dest + '\n');
