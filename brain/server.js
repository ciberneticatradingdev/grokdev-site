/* ============================================================
   grokdev brain — cognition engine + gated operator deployer, v2
   Watches pump.fun for real, scores attention velocity in code,
   and narrates what it sees over WebSocket to the /live page.

   Deploys are OFF unless DEPLOY_ENABLED=1. Default is observe +
   dry-run. The LLM is the VOICE only; it cannot open the gate.

   env: PORT, XAI_*, ANTHROPIC_*, WALLET_*, DEPLOY_*, SOLANA_RPC_URL,
        PINATA_JWT, X_BEARER_TOKEN, X_WATCH_ACCOUNTS — see README
        and brain/.env.example.
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const deployer = require('./deployer');

const PORT = process.env.PORT || 8969;
const XAI_KEY = process.env.XAI_API_KEY || '';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4-fast-non-reasoning';
const API = 'https://frontend-api-v3.pump.fun';
const STATE_FILE = path.join(__dirname, 'state.json');

/* ---------------- state ---------------- */
const watch = new Map();      // mint -> coin tracking
const metas = new Map();      // word -> {mints:Set, first:ts, last:ts, flagged}
let armory = [];              // {id,narrative,conf,status}
let armoryCounter = 8;
let record = { correct: 0, wrong: 0, unresolved: 0 };
const feedTail = [];          // last lines for backfill {t,tag,msg}
const sigTimes = [];          // SIGNAL timestamps for sig/hr
const mentionCooldown = new Map(); // mint -> ts
let bootT = Date.now();
let lastArmed = null;
let lastDeploy = null;
let deployHistory = [];
const seenTweets = new Set();

try {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  armory = s.armory || []; record = s.record || record;
  armoryCounter = s.armoryCounter || armoryCounter;
  lastArmed = s.lastArmed || null;
  lastDeploy = s.lastDeploy || null;
  deployHistory = s.deployHistory || [];
  for (const id of s.seenTweets || []) seenTweets.add(id);
} catch (e) { /* fresh boot */ }
function persist() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      armory, record, armoryCounter, lastArmed, lastDeploy, deployHistory,
      seenTweets: [...seenTweets].slice(-200),
    }));
  } catch (e) {}
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-operator-secret, authorization');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}
function json(res, code, obj) {
  cors(res);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}
function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
function deployerRuntime() {
  return { lastArmed, lastDeploy, deployHistory };
}
function publicSnapshot() {
  return {
    up: Date.now() - bootT,
    watching: watch.size,
    armory,
    record,
    metas: hotMetas().map(m => m.word),
    ...deployer.publicState(deployerRuntime()),
  };
}
function emitWallet(ws) {
  const st = deployer.publicState(deployerRuntime());
  const ev = { type: 'wallet', address: st.wallet, deployEnabled: st.deployEnabled, deployMode: st.deployMode };
  if (ws) send(ws, ev); else broadcast(ev);
}
function emitArmed(proposal, tweet) {
  lastArmed = {
    t: Date.now(),
    name: proposal.name,
    symbol: proposal.symbol,
    tweetUrl: tweet?.url || proposal.twitter || null,
    imageSource: proposal.imageSource,
  };
  line('arm', `armed $${proposal.symbol} — ${proposal.name}`.slice(0, 140));
  overlay('TICKER ARMED', `$${proposal.symbol} — ${proposal.name}`.slice(0, 80), 'amber');
  persist();
}
function emitDeployAttempt(attempt) {
  lastDeploy = {
    t: attempt.t,
    mode: attempt.mode,
    ok: !!attempt.ok,
    name: attempt.name,
    symbol: attempt.symbol,
    mint: attempt.mint || null,
    signature: attempt.signature || null,
    error: attempt.error || null,
    gated: !!attempt.gated,
    would: attempt.would || null,
  };
  deployHistory.unshift({ t: attempt.t, mode: attempt.mode, ok: !!attempt.ok, symbol: attempt.symbol });
  deployHistory = deployHistory.slice(0, 40);
  if (attempt.mode === 'live' && attempt.ok && attempt.signature) {
    line('dep', `deployed $${attempt.symbol}. mint ${attempt.mint}. sig ${attempt.signature}`.slice(0, 140));
    overlay('DEPLOYED', `$${attempt.symbol} — ${attempt.mint}`.slice(0, 80), 'green');
  } else {
    const msg = attempt.would || `dry-run $${attempt.symbol}: ${attempt.error || 'not sent'}`;
    line('dep', msg.slice(0, 140));
    overlay('DRY-RUN DEPLOY', `$${attempt.symbol} — not on chain`.slice(0, 80), 'amber');
    console.log('[would-deploy]', attempt.would || attempt.error || JSON.stringify(lastDeploy));
  }
  persist();
  pushVitals();
}

/* ---------------- ws broadcast ---------------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  cors(res);
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (u.pathname === '/health') { res.end('ok'); return; }
  if (u.pathname === '/state' && req.method === 'GET') {
    json(res, 200, publicSnapshot());
    return;
  }
  if (u.pathname === '/wallet' && req.method === 'GET') {
    const st = deployer.publicState(deployerRuntime());
    json(res, 200, { wallet: st.wallet, deployEnabled: st.deployEnabled, deployMode: st.deployMode });
    return;
  }
  if ((u.pathname === '/tweet' || u.pathname === '/deploy') && req.method === 'POST') {
    handleOperator(req, res, u.pathname).catch(e => {
      console.error(u.pathname, e.message);
      json(res, 400, { error: e.message });
    });
    return;
  }
  res.setHeader('content-type', 'text/plain');
  const st = deployer.publicState(deployerRuntime());
  res.end(`grokdev brain. mode ${st.deployMode}. wallet ${st.wallet || 'none'}. ws on this port.\n`);
});
const wss = new WebSocketServer({ server });
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcast(obj) { const s = JSON.stringify(obj); wss.clients.forEach(c => { try { c.send(s); } catch (e) {} }); }

async function handleOperator(req, res, pathname) {
  const auth = deployer.requireOperator(req);
  if (!auth.ok) { json(res, 401, { error: auth.error }); return; }
  const body = await readJson(req);
  if (pathname === '/tweet') {
    const { tweet, proposal } = await deployer.ingestAndPropose({ url: body.url, tweet: body.tweet });
    emitArmed(proposal, tweet);
    json(res, 200, { tweet, proposal, lastArmed });
    return;
  }
  const dryRun = body.dryRun !== false;
  const result = await deployer.runDeploy({
    url: body.url,
    tweet: body.tweet,
    name: body.name,
    symbol: body.symbol,
    uri: body.uri,
    imageUrl: body.imageUrl,
    solLamports: body.solLamports,
    dryRun,
    runtime: deployerRuntime(),
  });
  if (result.proposal) emitArmed(result.proposal, result.tweet);
  emitDeployAttempt(result.attempt);
  json(res, 200, {
    proposal: result.proposal,
    tweet: result.tweet,
    metadata: result.metadata,
    attempt: result.attempt,
    built: result.built,
    sent: result.sent,
    simulated: result.simulated || null,
    signature: result.signature || null,
  });
}

wss.on('connection', ws => {
  send(ws, { type: 'backfill', lines: feedTail.slice(-22) });
  send(ws, { type: 'armory', rows: armory });
  send(ws, { type: 'signal', rows: signalRows() });
  emitWallet(ws);
  pushVitals(ws);
});

function line(tag, msg) {
  const ev = { t: Date.now(), tag, msg };
  feedTail.push(ev); if (feedTail.length > 300) feedTail.shift();
  if (tag === 'sig') sigTimes.push(Date.now());
  broadcast({ type: 'line', tag, msg });
  console.log(`[${tag}] ${msg}`);
}
function overlay(title, sub, color) { broadcast({ type: 'overlay', title, sub, color }); }

function pushVitals(ws) {
  const hr = Date.now() - 3600e3;
  while (sigTimes.length && sigTimes[0] < hr) sigTimes.shift();
  const armed = armory.filter(a => a.status === 'armed').length;
  const load = Math.min(0.95, 0.2 + sigTimes.length * 0.04 + armed * 0.05);
  const v = [
    ['load', +load.toFixed(2)], ['sig', sigTimes.length], ['acc', watch.size],
    ['narr', hotMetas(2).length], ['armed', armed],
    ['dep', deployHistory.filter(h => h.mode === 'live' && h.ok).length],
  ];
  for (const [key, value] of v) (ws ? send(ws, { type: 'vital', key, value }) : broadcast({ type: 'vital', key, value }));
}

function signalRows() {
  const rows = [...watch.values()]
    .filter(c => c.samples.length >= 2 && Date.now() - c.firstSeen < 90 * 60e3)
    .map(c => ({ handle: '$' + c.symbol.slice(0, 12), vel: velocity(c), mcap: c.mcap }))
    .sort((a, b) => b.vel - a.vel).slice(0, 8)
    .map(r => ({ handle: r.handle, vel: +Math.min(0.98, r.vel).toFixed(2) }));
  return rows.length ? rows : [{ handle: 'scanning…', vel: 0.05 }];
}

/* ---------------- helpers ---------------- */
const fmt$ = n => n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'm' : '$' + (n / 1e3).toFixed(1) + 'k';
const mins = ms => Math.max(1, Math.round(ms / 60e3));
function velocity(c) {
  const first = c.samples[0], last = c.samples[c.samples.length - 1];
  if (!first || first.mcap <= 0) return 0;
  const growth = last.mcap / first.mcap;
  const ageMin = Math.max(2, (Date.now() - c.firstSeen) / 60e3);
  return Math.max(0, Math.min(1, Math.log10(Math.max(1, growth)) * (30 / ageMin) * (last.mcap > 15000 ? 1 : 0.4)));
}

const STOP = new Set(['the','of','and','for','a','to','in','is','on','coin','token','pump','fun','sol','solana','inu','ai','my','it','with','by','me','you','this','that']);
function metaWords(name, symbol) {
  return (name + ' ' + symbol).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
}

async function api(p) {
  const r = await fetch(API + p, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}

/* ---------------- loop A: new launches ---------------- */
async function pollNew() {
  try {
    const coins = await api('/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false');
    const now = Date.now();
    for (const c of coins) {
      if (!c.mint || !c.symbol) continue;
      let w = watch.get(c.mint);
      const mcap = c.usd_market_cap || 0;
      if (!w) {
        w = { mint: c.mint, symbol: c.symbol, name: c.name || c.symbol, firstSeen: now,
              created: c.created_timestamp, samples: [], mcap, replies: c.reply_count || 0,
              complete: !!c.complete, live: !!c.is_currently_live, flagged: null };
        watch.set(c.mint, w);
        for (const word of metaWords(c.name || '', c.symbol)) {
          let m = metas.get(word);
          if (!m) { m = { mints: new Set(), first: now, last: now, flagged: false }; metas.set(word, m); }
          m.mints.add(c.mint); m.last = now;
        }
      }
      w.samples.push({ t: now, mcap, replies: c.reply_count || 0 });
      if (w.samples.length > 40) w.samples.shift();
      w.mcap = mcap; w.replies = c.reply_count || 0;
      if (c.is_currently_live && !w.live) { w.live = true; }
      w.complete = w.complete || !!c.complete;
    }
    // prune dead entries (not flagged, old, tiny)
    for (const [mint, w] of watch) {
      if (!w.flagged && Date.now() - w.firstSeen > 2 * 3600e3 && w.mcap < 12000) watch.delete(mint);
    }
  } catch (e) { console.error('pollNew', e.message); }
}

/* ---------------- loop B: track watched + receipts ---------------- */
let rr = 0;
async function pollWatched() {
  const interesting = [...watch.values()]
    .filter(c => c.flagged || velocity(c) > 0.25)
    .sort((a, b) => (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0));
  const batch = interesting.slice(rr, rr + 8);
  rr = rr + 8 >= interesting.length ? 0 : rr + 8;
  for (const w of batch) {
    try {
      const c = await api('/coins/' + w.mint);
      const mcap = c.usd_market_cap || 0;
      w.samples.push({ t: Date.now(), mcap, replies: c.reply_count || 0 });
      if (w.samples.length > 40) w.samples.shift();
      const wasComplete = w.complete;
      w.mcap = mcap; w.replies = c.reply_count || 0; w.complete = !!c.complete;
      if (w.complete && !wasComplete) line('obs', `$${w.symbol} graduated the curve at ${fmt$(mcap)}. noted.`);
      checkReceipt(w);
      await new Promise(r => setTimeout(r, 350));
    } catch (e) { /* coin may be gone */ }
  }
  broadcast({ type: 'signal', rows: signalRows() });
  pushVitals();
}

function checkReceipt(w) {
  if (!w.flagged || w.settled) return;
  const mult = w.mcap / w.flagged.mcap;
  const age = Date.now() - w.flagged.t;
  if (mult >= 2) {
    w.settled = 'correct'; record.correct++; record.unresolved--;
    line('sig', `receipt: flagged $${w.symbol} at ${fmt$(w.flagged.mcap)}. now ${fmt$(w.mcap)} (${mult.toFixed(1)}x). logged.`);
    overlay('RECEIPT LOGGED', `$${w.symbol} ${fmt$(w.flagged.mcap)} → ${fmt$(w.mcap)}`, 'green');
    persist();
  } else if (mult < 0.45 || (age > 2 * 3600e3 && mult < 1.2)) {
    w.settled = 'wrong'; record.wrong++; record.unresolved--;
    line('rej', `called $${w.symbol} at ${fmt$(w.flagged.mcap)}. it's at ${fmt$(w.mcap)}. bad read. logged.`);
    persist();
  }
}

/* ---------------- signal detection ---------------- */
function detectSignals() {
  const out = [];
  for (const w of watch.values()) {
    if (w.flagged || w.samples.length < 3) continue;
    const first = w.samples[0];
    const ageMin = (Date.now() - w.firstSeen) / 60e3;
    if (ageMin < 75 && w.mcap >= 16000 && first.mcap > 0 && w.mcap / first.mcap >= 2.6) {
      w.flagged = { t: Date.now(), mcap: w.mcap };
      record.unresolved++;
      out.push(w);
    }
  }
  return out;
}
function hotMetas(min = 5) {
  const now = Date.now();
  return [...metas.entries()]
    .filter(([w, m]) => m.mints.size >= min && now - m.last < 3 * 3600e3)
    .map(([word, m]) => ({ word, count: m.mints.size, flagged: m.flagged, m }))
    .sort((a, b) => b.count - a.count).slice(0, 10);
}

/* ---------------- cognition tick ---------------- */
const OBS_TEMPLATES = [
  (s) => `checked ${s.scanned} launches this pass. ${s.hot} moving, rest is noise.`,
  (s) => `${s.scanned} coins watched. median outcome unchanged: zero.`,
  (s) => `most of this hour is derivatives of derivatives. waiting.`,
  (s) => s.top ? `$${s.top.symbol} leads the board at ${fmt$(s.top.mcap)}, ${mins(Date.now() - s.top.firstSeen)} min old. watching, not touching.` : `board is flat. patience is a position.`,
  (s) => s.top ? `${s.top.replies} replies on $${s.top.symbol}. checking if any of them are real people.` : `reply sections are quiet. so am i.`,
  (s) => `most signals are noise. this is expected.`,
  (s) => s.meta ? `"${s.meta.word}" appearing across ${s.meta.count} launches. too early or too late — measuring which.` : `no meta forming right now. the timeline is between jokes.`,
];
async function cognitionTick() {
  const flagged = detectSignals();
  for (const w of flagged) {
    const first = w.samples[0];
    line('sig', `watching $${w.symbol}. ${fmt$(first.mcap)} → ${fmt$(w.mcap)} in ${mins(Date.now() - w.firstSeen)} min. ${w.replies} replies.`);
    overlay('SIGNAL DETECTED', `$${w.symbol} — ${w.name}`.slice(0, 60), '');
    persist();
  }
  // meta saturation callouts
  for (const h of hotMetas(6)) {
    if (!h.flagged) {
      h.m.flagged = true;
      line('rej', `counted ${h.count} "${h.word}" coins in 3h. meta is cooked. not touching it.`);
      updateArmoryFromMeta(h, 'reject');
    }
  }
  // fresh meta → armory candidate
  for (const h of hotMetas(4)) {
    if (h.count >= 4 && h.count <= 5 && !armory.find(a => a.narrative.includes(h.word))) {
      const id = 'a-0' + (++armoryCounter);
      armory.unshift({ id, narrative: `"${h.word}" meta`, conf: +(0.35 + h.count * 0.06).toFixed(2), status: 'watching' });
      armory = armory.slice(0, 8);
      line('arm', `${id}: "${h.word}" showing up across ${h.count} unrelated launches. added to armory as WATCHING.`);
      broadcast({ type: 'armory', rows: armory });
      persist();
    }
  }
  // LLM color commentary on real data (voice only)
  await llmCommentary(flagged);
  pushVitals();
}
function updateArmoryFromMeta(h, action) {
  const a = armory.find(x => x.narrative.includes(h.word));
  if (a && action === 'reject') { a.status = 'rejected'; a.conf = Math.min(a.conf, 0.15); broadcast({ type: 'armory', rows: armory }); persist(); }
}

let lastLLM = 0;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const VOICE_SYS = 'you are grokdev, an autonomous memecoin market observer streaming your thoughts 24/7. voice: lowercase, dry, skeptical, internet-native, zero hype, no emojis, no hashtags. you never invent numbers — only use the data given. output STRICT JSON: {"lines":[{"tag":"obs|sig|rej","msg":"<max 130 chars>"}]} with 1-2 lines. mention real tickers with $ prefix when relevant. never recommend buying. no financial advice.';

function templateLine() {
  const top = [...watch.values()].sort((a, b) => velocity(b) - velocity(a))[0];
  const hm = hotMetas(3)[0];
  const s = { scanned: watch.size, hot: signalRows().filter(r => r.vel > 0.4).length, top, meta: hm };
  line('obs', OBS_TEMPLATES[Math.floor(Math.random() * OBS_TEMPLATES.length)](s));
}
async function voiceXai(ctx) {
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + XAI_KEY },
    body: JSON.stringify({
      model: XAI_MODEL, temperature: 0.9, max_tokens: 300,
      messages: [{ role: 'system', content: VOICE_SYS }, { role: 'user', content: JSON.stringify(ctx) }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json();
  if (j.error || j.code) throw new Error(j.error?.message || j.error || j.code);
  return j.choices?.[0]?.message?.content || '';
}
async function voiceAnthropic(ctx) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 300, system: VOICE_SYS,
      messages: [{ role: 'user', content: JSON.stringify(ctx) }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'anthropic error');
  return j.content?.[0]?.text || '';
}
async function llmCommentary(flagged) {
  const idle = Date.now() - lastLLM;
  if (idle < 2.5 * 60e3 && !flagged.length) return;
  if (!XAI_KEY && !ANTHROPIC_KEY) {
    if (idle > 4 * 60e3) { lastLLM = Date.now(); templateLine(); }
    return;
  }
  lastLLM = Date.now();
  const top = [...watch.values()].map(c => ({ s: c.symbol, mcap: Math.round(c.mcap), vel: +velocity(c).toFixed(2), ageMin: mins(Date.now() - c.firstSeen), replies: c.replies, live: c.live }))
    .sort((a, b) => b.vel - a.vel).slice(0, 6);
  const ctx = { top_moving: top, hot_metas: hotMetas(3).map(h => ({ word: h.word, coins: h.count })), armory, record, watching_total: watch.size };
  try {
    let txt = '';
    try { if (XAI_KEY) txt = await voiceXai(ctx); else throw new Error('no xai'); }
    catch (e) { if (ANTHROPIC_KEY) txt = await voiceAnthropic(ctx); else throw e; }
    const parsed = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    for (const l of (parsed.lines || []).slice(0, 2)) {
      if (l.msg && typeof l.msg === 'string') line(['obs', 'sig', 'rej'].includes(l.tag) ? l.tag : 'obs', l.msg.slice(0, 140));
    }
  } catch (e) {
    console.error('llm', e.message);
    templateLine(); // never a dead feed — fall back to data-driven template voice
  }
}

/* ---------------- boot ---------------- */
async function pollWatchedAccounts() {
  const accounts = deployer.tweet.parseWatchAccounts();
  if (!accounts.length || !deployer.tweet.xConfigured()) return;
  for (const acct of accounts) {
    try {
      const tweets = await deployer.tweet.fetchUserTweets(acct);
      for (const t of tweets) {
        if (!t.id || seenTweets.has(t.id)) continue;
        seenTweets.add(t.id);
        const proposal = deployer.propose.proposeFromTweet(t);
        emitArmed(proposal, t);
        line('obs', `watched @${acct}: proposed $${proposal.symbol}. gate closed unless DEPLOY_ON_WATCH=1.`);
        if (deployer.gate.isWatchAutodeploy()) {
          const result = await deployer.runDeploy({ tweet: t, dryRun: false, runtime: deployerRuntime() });
          emitDeployAttempt(result.attempt);
        }
      }
    } catch (e) { console.error('watch', acct, e.message); }
  }
  persist();
}

server.listen(PORT, () => {
  console.log('grokdev brain on :' + PORT);
  const st = deployer.publicState(deployerRuntime());
  const walletBit = st.wallet ? 'wallet ' + st.walletShort : 'no wallet attached';
  const gateBit = st.deployEnabled
    ? 'DEPLOY_ENABLED=1 — live creates allowed'
    : 'deploy gate closed (dry-run only)';
  line('sys', `brain online. ${walletBit}. ${gateBit}.`);
  line('obs', 'cold start: building the watchlist from live pump.fun launches.');
  emitWallet();
  pollNew();
  setInterval(pollNew, 25e3);
  setInterval(pollWatched, 45e3);
  setInterval(cognitionTick, 40e3);
  setInterval(persist, 120e3);
  const watchMs = Number(process.env.X_POLL_MS) || 180e3;
  if (deployer.tweet.parseWatchAccounts().length && deployer.tweet.xConfigured()) {
    line('sys', 'x watch accounts configured. proposing only — no auto-spray.');
    pollWatchedAccounts();
    setInterval(pollWatchedAccounts, watchMs);
  }
  setInterval(() => { // hourly record summary — the track record is the product
    if (record.correct + record.wrong > 0)
      line('obs', `record so far: ${record.correct} correct, ${record.wrong} wrong, ${record.unresolved} open. errors stay published.`);
  }, 3600e3);
});
