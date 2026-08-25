/* ============================================================
   Hard gates for live creates. Default is observe + dry-run.
   Live send requires DEPLOY_ENABLED=1 AND an explicit dryRun:false
   AND cooldown / weekly caps. LLM never opens this gate.
   ============================================================ */

function truthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function isDeployEnabled(env = process.env) {
  return truthy(env.DEPLOY_ENABLED);
}

function isWatchAutodeploy(env = process.env) {
  return isDeployEnabled(env) && truthy(env.DEPLOY_ON_WATCH);
}

function deployMode(env = process.env, walletPresent = false) {
  if (!walletPresent) return 'observe-only';
  if (isDeployEnabled(env)) return 'live';
  return 'dry-run';
}

function numEnv(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function liveHistory(history = []) {
  return (history || []).filter(h => h && h.mode === 'live' && h.ok);
}

function canLiveSend({ now = Date.now(), history = [], env = process.env } = {}) {
  if (!isDeployEnabled(env)) {
    return { ok: false, reason: 'DEPLOY_ENABLED is not set — dry-run only' };
  }
  const lives = liveHistory(history);
  const cooldownH = numEnv(env, 'DEPLOY_COOLDOWN_HOURS', 24);
  const maxWeek = numEnv(env, 'DEPLOY_MAX_PER_WEEK', 1);
  const last = lives[0];
  if (last && cooldownH > 0 && now - last.t < cooldownH * 3600e3) {
    const left = Math.ceil((cooldownH * 3600e3 - (now - last.t)) / 3600e3);
    return { ok: false, reason: `cooldown: last live deploy ${left}h remaining` };
  }
  const weekAgo = now - 7 * 24 * 3600e3;
  const weekCount = lives.filter(h => h.t >= weekAgo).length;
  if (maxWeek > 0 && weekCount >= maxWeek) {
    return { ok: false, reason: `weekly cap: ${weekCount}/${maxWeek} live deploys in 7d` };
  }
  return { ok: true };
}

function describeGate(env = process.env, walletPresent = false) {
  return {
    deployEnabled: isDeployEnabled(env),
    deployOnWatch: isWatchAutodeploy(env),
    deployMode: deployMode(env, walletPresent),
    cooldownHours: numEnv(env, 'DEPLOY_COOLDOWN_HOURS', 24),
    maxPerWeek: numEnv(env, 'DEPLOY_MAX_PER_WEEK', 1),
  };
}

module.exports = {
  truthy,
  isDeployEnabled,
  isWatchAutodeploy,
  deployMode,
  canLiveSend,
  describeGate,
};
