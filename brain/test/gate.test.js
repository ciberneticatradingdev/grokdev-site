const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeployEnabled, canLiveSend, deployMode, describeGate } = require('../deployer/gate');

test('deploy is off by default', () => {
  assert.equal(isDeployEnabled({}), false);
  assert.equal(isDeployEnabled({ DEPLOY_ENABLED: '0' }), false);
  assert.equal(isDeployEnabled({ DEPLOY_ENABLED: '1' }), true);
  assert.equal(deployMode({}, true), 'dry-run');
  assert.equal(deployMode({}, false), 'observe-only');
  assert.equal(deployMode({ DEPLOY_ENABLED: '1' }, true), 'live');
});

test('live send blocked without flag even with history empty', () => {
  const r = canLiveSend({ env: {}, history: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /DEPLOY_ENABLED/);
});

test('weekly cap and cooldown apply when enabled', () => {
  const now = 1_000_000_000_000;
  const history = [{ mode: 'live', ok: true, t: now - 2 * 3600e3 }];
  const cool = canLiveSend({ now, history, env: { DEPLOY_ENABLED: '1', DEPLOY_COOLDOWN_HOURS: '24', DEPLOY_MAX_PER_WEEK: '3' } });
  assert.equal(cool.ok, false);
  assert.match(cool.reason, /cooldown/);

  const week = canLiveSend({
    now,
    history: [
      { mode: 'live', ok: true, t: now - 2 * 24 * 3600e3 },
      { mode: 'dry-run', ok: true, t: now - 1000 },
    ],
    env: { DEPLOY_ENABLED: '1', DEPLOY_COOLDOWN_HOURS: '1', DEPLOY_MAX_PER_WEEK: '1' },
  });
  assert.equal(week.ok, false);
  assert.match(week.reason, /weekly cap/);

  const ok = canLiveSend({
    now,
    history: [{ mode: 'dry-run', ok: true, t: now }],
    env: { DEPLOY_ENABLED: '1', DEPLOY_COOLDOWN_HOURS: '1', DEPLOY_MAX_PER_WEEK: '1' },
  });
  assert.equal(ok.ok, true);
});

test('describeGate stays honest', () => {
  const g = describeGate({ DEPLOY_ENABLED: '' }, false);
  assert.equal(g.deployEnabled, false);
  assert.equal(g.deployMode, 'observe-only');
});
