const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const {
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  PUMP_PROGRAM_ID,
} = require('@pump-fun/pump-sdk');
const deployer = require('../deployer');
const { placeholderPng } = require('../deployer/metadata');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tweet.json'), 'utf8'));

function fixtureGlobal() {
  const pk = (s) => new PublicKey(s);
  const zero = pk('11111111111111111111111111111111');
  return {
    initialized: true,
    authority: zero,
    feeRecipient: zero,
    initialVirtualTokenReserves: new BN('1073000000000000'),
    initialVirtualSolReserves: new BN('30000000000'),
    initialRealTokenReserves: new BN('793100000000000'),
    tokenTotalSupply: new BN('1000000000000000'),
    feeBasisPoints: new BN(100),
    withdrawAuthority: zero,
    enableMigrate: true,
    poolMigrationFee: new BN(0),
    creatorFeeBasisPoints: new BN(30),
    feeRecipients: [zero, zero, zero, zero, zero, zero, zero],
    setCreatorAuthority: zero,
    adminSetCreatorAuthority: zero,
    createV2Enabled: true,
    whitelistPda: zero,
    reservedFeeRecipient: zero,
    mayhemModeEnabled: false,
    reservedFeeRecipients: [zero, zero, zero, zero],
    isCashbackEnabled: false,
    buybackFeeRecipients: [],
    buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN('30000000000'),
    whitelistedQuoteMints: [],
  };
}

test('placeholder PNG is a real PNG', () => {
  const buf = placeholderPng('FROG');
  assert.equal(buf[0], 137);
  assert.equal(buf[1], 80);
  assert.equal(buf[2], 78);
  assert.equal(buf[3], 71);
  assert.ok(buf.length > 80);
});

test('runDeploy on fixture without wallet is an honest dry-run log, not a fake success', async () => {
  const result = await deployer.runDeploy({
    tweet: fixture,
    dryRun: true,
    env: { DEPLOY_ENABLED: '0' },
    fetchFn: async () => { throw new Error('no net'); },
  });
  assert.equal(result.sent, false);
  assert.equal(result.proposal.symbol, 'FROG');
  assert.equal(result.attempt.ok, false);
  assert.match(result.attempt.error, /no wallet|wallet/i);
  assert.match(result.attempt.would, /would deploy \$FROG/);
  assert.equal(result.attempt.signature, undefined);
});

test('live flag without DEPLOY_ENABLED stays dry-run', async () => {
  const kp = Keypair.generate();
  const result = await deployer.runDeploy({
    tweet: fixture,
    dryRun: false,
    env: {
      DEPLOY_ENABLED: '0',
      WALLET_SECRET_KEY: JSON.stringify(Array.from(kp.secretKey)),
      METADATA_URI: 'https://example.invalid/meta.json',
    },
    fetchFn: async () => { throw new Error('no net'); },
    onchain: { global: fixtureGlobal(), feeConfig: null },
    connection: null,
  });
  assert.equal(result.sent, false);
  assert.equal(result.attempt.gated, true);
  assert.match(result.attempt.error, /DEPLOY_ENABLED/);
});

test('official SDK builds CreateV2 + buy instructions (Token-2022) offline', async () => {
  const global = fixtureGlobal();
  const feeConfig = null;
  const solAmount = new BN(10_000_000);
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: solAmount,
    quoteMint: deployer.pump.NATIVE_MINT,
  });
  assert.ok(amount.gt(new BN(0)));

  const wallet = Keypair.generate();
  const mint = Keypair.generate();
  const ixs = await PUMP_SDK.createV2AndBuyInstructions({
    global,
    mint: mint.publicKey,
    name: 'Dry Run Frog',
    symbol: 'FROG',
    uri: 'https://example.invalid/dry-run.json',
    creator: wallet.publicKey,
    user: wallet.publicKey,
    amount,
    solAmount,
    mayhemMode: false,
    cashback: false,
  });
  assert.ok(ixs.length >= 3);
  assert.equal(ixs[0].programId.toBase58(), PUMP_PROGRAM_ID.toBase58());
  const programs = ixs.map(ix => ix.programId.toBase58());
  assert.ok(programs.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') || ixs.some(ix =>
    (ix.keys || []).some(k => k.pubkey.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
  ));

  const recorded = {
    programId: PUMP_PROGRAM_ID.toBase58(),
    instructionCount: ixs.length,
    tokenAmount: amount.toString(),
    solLamports: 10_000_000,
    firstIxDataBytes: ixs[0].data.length,
    note: 'offline createV2AndBuy — not submitted',
  };
  const dest = path.join(__dirname, 'fixtures', 'dry-run-createv2.json');
  fs.writeFileSync(dest, JSON.stringify(recorded, null, 2) + '\n');
  const saved = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'recorded-dry-run.json'), 'utf8'));
  assert.equal(recorded.programId, saved.programId);
  assert.equal(saved.sent, false);
  assert.equal(recorded.instructionCount, 3);
  assert.ok(recorded.firstIxDataBytes > 8);
});

test('GET-shaped publicState never includes secret key material', () => {
  const kp = Keypair.generate();
  const env = { WALLET_SECRET_KEY: JSON.stringify(Array.from(kp.secretKey)), DEPLOY_ENABLED: '0' };
  const st = deployer.publicState({ lastArmed: null, lastDeploy: null }, env);
  const blob = JSON.stringify(st);
  assert.equal(st.wallet, kp.publicKey.toBase58());
  assert.equal(st.deployEnabled, false);
  assert.equal(blob.includes(Buffer.from(kp.secretKey).toString('hex')), false);
  assert.ok(!Object.values(st).some(v => Array.isArray(v) && v.length === 64));
});
