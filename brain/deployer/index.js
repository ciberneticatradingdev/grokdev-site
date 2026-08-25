/* ============================================================
   Deployer facade: tweet → proposal → metadata → create+buy.
   Live send is gated. Everything else is dry-run / propose.
   ============================================================ */
const walletMod = require('./wallet');
const tweetMod = require('./tweet');
const proposeMod = require('./propose');
const metadataMod = require('./metadata');
const pumpMod = require('./pump');
const gateMod = require('./gate');

function snapshotWallet(env = process.env) {
  try {
    const kp = walletMod.loadWallet(env);
    return {
      wallet: walletMod.publicAddress(kp),
      walletShort: walletMod.redact(walletMod.publicAddress(kp)),
      hasWallet: !!kp,
      keypair: kp,
    };
  } catch (e) {
    return { wallet: null, walletShort: null, hasWallet: false, keypair: null, walletError: e.message };
  }
}

function publicState(runtime, env = process.env) {
  const snap = snapshotWallet(env);
  const gate = gateMod.describeGate(env, snap.hasWallet);
  return {
    wallet: snap.wallet,
    walletShort: snap.walletShort,
    walletError: snap.walletError || null,
    deployEnabled: gate.deployEnabled,
    deployOnWatch: gate.deployOnWatch,
    deployMode: gate.deployMode,
    cooldownHours: gate.cooldownHours,
    maxPerWeek: gate.maxPerWeek,
    lastArmed: runtime.lastArmed || null,
    lastDeploy: runtime.lastDeploy || null,
    liveDeploys: (runtime.deployHistory || []).filter(h => h.mode === 'live' && h.ok).length,
    xConfigured: tweetMod.xConfigured(env),
    watchAccounts: tweetMod.parseWatchAccounts(env),
  };
}

async function ingestAndPropose({ url, tweet, env = process.env, fetchFn = fetch } = {}) {
  const ingested = await tweetMod.ingestTweet({ url, tweet, env, fetchFn });
  const proposal = proposeMod.proposeFromTweet(ingested);
  return { tweet: ingested, proposal };
}

function wouldDeployLine(proposal, extra = {}) {
  const bits = [
    `would deploy $${proposal.symbol} — ${proposal.name}`,
    extra.uri ? `uri ${extra.uri}` : 'no metadata uri yet',
    extra.solLamports != null ? `buy ${extra.solLamports} lamports` : null,
    extra.mint ? `mint ${extra.mint}` : null,
    extra.reason || null,
  ].filter(Boolean);
  return bits.join('. ') + '.';
}

async function runDeploy(opts = {}) {
  const {
    url, tweet, name, symbol, uri, imageUrl, solLamports,
    dryRun = true,
    env = process.env,
    fetchFn = fetch,
    runtime = {},
    now = Date.now(),
    connection,
  } = opts;

  const snap = snapshotWallet(env);
  const wantLive = dryRun === false;
  const gate = wantLive ? gateMod.canLiveSend({ now, history: runtime.deployHistory, env }) : { ok: true };

  const ingested = (url || tweet)
    ? await tweetMod.ingestTweet({ url, tweet, env, fetchFn })
    : (tweet || null);
  const proposal = ingested
    ? proposeMod.proposeFromTweet(ingested)
    : { name, symbol, description: opts.description || name, twitter: opts.twitter || null, imageUrl: imageUrl || null, imageSource: imageUrl ? 'explicit' : 'placeholder' };
  if (name) proposal.name = name;
  if (symbol) proposal.symbol = symbol;
  if (imageUrl) { proposal.imageUrl = imageUrl; proposal.imageSource = 'explicit'; }

  if (!proposal.name || !proposal.symbol) {
    throw new Error('name and symbol required (from tweet or body)');
  }

  const resolved = await metadataMod.resolveMetadata({ proposal, uri, imageUrl: proposal.imageUrl, env, fetchFn });
  const lamports = pumpMod.buyLamports(env, solLamports);

  const attempt = {
    t: now,
    mode: wantLive ? 'live' : 'dry-run',
    name: proposal.name,
    symbol: proposal.symbol,
    tweetUrl: ingested?.url || url || null,
    imageSource: resolved.imageSource,
    metadataUploaded: resolved.uploaded,
    uri: resolved.uri,
    solLamports: lamports,
    wallet: snap.wallet,
    ok: false,
  };

  if (!snap.keypair) {
    attempt.error = snap.walletError || 'no wallet';
    attempt.would = wouldDeployLine(proposal, { uri: resolved.uri, solLamports: lamports, reason: attempt.error });
    return { attempt, proposal, tweet: ingested, metadata: metadataMod.publicMetadataView(resolved), built: null, sent: false };
  }

  if (!resolved.uri) {
    attempt.error = resolved.reason || 'metadata uri missing';
    attempt.would = wouldDeployLine(proposal, { solLamports: lamports, reason: attempt.error });
    return { attempt, proposal, tweet: ingested, metadata: metadataMod.publicMetadataView(resolved), built: null, sent: false };
  }

  if (wantLive && !gate.ok) {
    attempt.mode = 'dry-run';
    attempt.gated = true;
    attempt.error = gate.reason;
    attempt.would = wouldDeployLine(proposal, { uri: resolved.uri, solLamports: lamports, reason: gate.reason });
    return { attempt, proposal, tweet: ingested, metadata: metadataMod.publicMetadataView(resolved), built: null, sent: false };
  }

  let conn = connection;
  let onchain = opts.onchain || null;
  let rpcError = null;
  if (!onchain) {
    try {
      conn = conn || pumpMod.connectionFrom(env);
      onchain = await pumpMod.fetchOnchainState(conn);
    } catch (e) {
      rpcError = e.message;
    }
  }

  if (!onchain) {
    attempt.error = 'could not fetch pump global: ' + (rpcError || 'no rpc');
    attempt.would = wouldDeployLine(proposal, { uri: resolved.uri, solLamports: lamports, reason: attempt.error });
    return { attempt, proposal, tweet: ingested, metadata: metadataMod.publicMetadataView(resolved), built: null, sent: false };
  }

  let built;
  try {
    built = await pumpMod.buildCreateAndBuy({
      wallet: snap.keypair,
      name: proposal.name,
      symbol: proposal.symbol,
      uri: resolved.uri,
      solLamports: lamports,
      global: onchain.global,
      feeConfig: onchain.feeConfig,
      connection: conn,
      env,
      mayhemMode: gateMod.truthy(env.MAYHEM_MODE),
      cashback: gateMod.truthy(env.CASHBACK),
    });
  } catch (e) {
    attempt.error = 'build failed: ' + e.message;
    attempt.would = wouldDeployLine(proposal, { uri: resolved.uri, solLamports: lamports, reason: attempt.error });
    return { attempt, proposal, tweet: ingested, metadata: metadataMod.publicMetadataView(resolved), built: null, sent: false };
  }

  attempt.mint = built.mint;
  attempt.tokenAmount = built.tokenAmount;
  attempt.built = pumpMod.publicBuiltView(built);

  if (!wantLive || !gateMod.isDeployEnabled(env)) {
    let sim = null;
    if (conn) {
      try { sim = await pumpMod.simulateBuilt(conn, built.tx); }
      catch (e) { sim = { ok: false, err: e.message, skipped: true }; }
    }
    attempt.ok = true;
    attempt.simulated = sim;
    attempt.would = wouldDeployLine(proposal, { uri: resolved.uri, solLamports: lamports, mint: built.mint, reason: 'dry-run — not sent' });
    return { attempt, proposal, tweet: ingested, metadata: metadataMod.publicMetadataView(resolved), built: pumpMod.publicBuiltView(built), sent: false, simulated: sim };
  }

  try {
    const sent = await pumpMod.sendBuilt(conn, built.tx);
    attempt.ok = sent.confirmed;
    attempt.signature = sent.signature;
    attempt.error = sent.err ? JSON.stringify(sent.err) : null;
    return { attempt, proposal, tweet: ingested, metadata: metadataMod.publicMetadataView(resolved), built: pumpMod.publicBuiltView(built), sent: true, signature: sent.signature };
  } catch (e) {
    attempt.error = 'send failed: ' + e.message;
    return { attempt, proposal, tweet: ingested, metadata: metadataMod.publicMetadataView(resolved), built: pumpMod.publicBuiltView(built), sent: false };
  }
}

function requireOperator(req, env = process.env) {
  const secret = (env.OPERATOR_SECRET || '').trim();
  if (!secret) return { ok: true };
  const got = String(req.headers['x-operator-secret'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (got !== secret) return { ok: false, error: 'unauthorized' };
  return { ok: true };
}

module.exports = {
  wallet: walletMod,
  tweet: tweetMod,
  propose: proposeMod,
  metadata: metadataMod,
  pump: pumpMod,
  gate: gateMod,
  snapshotWallet,
  publicState,
  ingestAndPropose,
  runDeploy,
  wouldDeployLine,
  requireOperator,
};
