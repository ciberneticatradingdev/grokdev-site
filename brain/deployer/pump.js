/* ============================================================
   Pump.fun create + initial buy (CreateV2 / Token-2022).

   Uses official @pump-fun/pump-sdk. Default path is dry-run:
   build the VersionedTransaction, optionally simulate, never
   send unless the caller already passed the live gate.
   ============================================================ */
const BN = require('bn.js');
const {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} = require('@solana/web3.js');
const {
  PUMP_SDK,
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  PUMP_PROGRAM_ID,
} = require('@pump-fun/pump-sdk');

const CREATE_AND_BUY_COMPUTE_UNITS = 390_000;
const DEFAULT_PRIORITY_MICROLAMPORTS = 100_000;
const DEFAULT_BUY_LAMPORTS = 10_000_000; // 0.01 SOL
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

function rpcUrl(env = process.env) {
  return (env.SOLANA_RPC_URL || env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
}

function connectionFrom(env = process.env) {
  return new Connection(rpcUrl(env), 'confirmed');
}

function buyLamports(env = process.env, override) {
  if (override != null) {
    const n = Number(override);
    if (!Number.isFinite(n) || n <= 0) throw new Error('solLamports must be > 0');
    return Math.floor(n);
  }
  const fromEnv = env.BUY_SOL != null && env.BUY_SOL !== '' ? Number(env.BUY_SOL) : null;
  if (fromEnv != null && Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv < 10 ? Math.round(fromEnv * 1e9) : Math.floor(fromEnv);
  }
  const lam = Number(env.BUY_LAMPORTS);
  if (Number.isFinite(lam) && lam > 0) return Math.floor(lam);
  return DEFAULT_BUY_LAMPORTS;
}

function quoteTokenAmount(global, feeConfig, solAmount) {
  return getBuyTokenAmountFromSolAmount({
    global,
    feeConfig: feeConfig || null,
    mintSupply: null,
    bondingCurve: null,
    amount: solAmount,
    quoteMint: NATIVE_MINT,
  });
}

async function fetchOnchainState(connection) {
  const online = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([
    online.fetchGlobal(),
    online.fetchFeeConfig(),
  ]);
  return { global, feeConfig };
}

function computeBudgetIxs(units = CREATE_AND_BUY_COMPUTE_UNITS, microLamports = DEFAULT_PRIORITY_MICROLAMPORTS) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

async function buildCreateAndBuy({
  wallet,
  name,
  symbol,
  uri,
  solLamports,
  global,
  feeConfig,
  connection,
  env = process.env,
  mintKeypair,
  mayhemMode = false,
  cashback = false,
}) {
  if (!wallet) throw new Error('wallet required to build create+buy');
  if (!name || !symbol) throw new Error('name and symbol required');
  if (!uri) throw new Error('metadata uri required to build a create tx');
  const mint = mintKeypair || Keypair.generate();
  const solAmount = new BN(solLamports);
  const amount = quoteTokenAmount(global, feeConfig, solAmount);
  const ixs = await PUMP_SDK.createV2AndBuyInstructions({
    global,
    mint: mint.publicKey,
    name,
    symbol,
    uri,
    creator: wallet.publicKey,
    user: wallet.publicKey,
    amount,
    solAmount,
    mayhemMode: Boolean(mayhemMode),
    cashback: Boolean(cashback),
  });
  const { blockhash } = connection
    ? await connection.getLatestBlockhash('confirmed')
    : { blockhash: '11111111111111111111111111111111' };
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [...computeBudgetIxs(), ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet, mint]);
  return {
    mint: mint.publicKey.toBase58(),
    mintKeypair: mint,
    solLamports,
    tokenAmount: amount.toString(),
    instructionCount: ixs.length + 2,
    programId: PUMP_PROGRAM_ID.toBase58(),
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    tx,
    instructions: ixs,
  };
}

function summarizeInstructions(ixs) {
  return (ixs || []).map(ix => ({
    programId: ix.programId.toBase58(),
    keys: (ix.keys || []).length,
    dataBytes: ix.data ? ix.data.length : 0,
  }));
}

async function simulateBuilt(connection, tx) {
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  return {
    ok: !sim.value.err,
    err: sim.value.err || null,
    logs: (sim.value.logs || []).slice(-12),
    unitsConsumed: sim.value.unitsConsumed ?? null,
  };
}

async function sendBuilt(connection, tx) {
  const raw = tx.serialize();
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const latest = await connection.getLatestBlockhash('confirmed');
  const conf = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  return {
    signature,
    confirmed: !conf.value.err,
    err: conf.value.err || null,
  };
}

function publicBuiltView(built) {
  if (!built) return null;
  return {
    mint: built.mint,
    solLamports: built.solLamports,
    tokenAmount: built.tokenAmount,
    instructionCount: built.instructionCount,
    programId: built.programId,
    tokenProgram: built.tokenProgram,
    instructions: summarizeInstructions(built.instructions),
  };
}

module.exports = {
  NATIVE_MINT,
  CREATE_AND_BUY_COMPUTE_UNITS,
  DEFAULT_BUY_LAMPORTS,
  rpcUrl,
  connectionFrom,
  buyLamports,
  quoteTokenAmount,
  fetchOnchainState,
  buildCreateAndBuy,
  simulateBuilt,
  sendBuilt,
  summarizeInstructions,
  publicBuiltView,
};
