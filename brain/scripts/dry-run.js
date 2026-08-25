#!/usr/bin/env node
/* Recorded / local dry-run: tweet URL or fixture → proposal → create+buy build.
   Never sends. Safe to run in CI. */
const fs = require('fs');
const path = require('path');
const deployer = require('../deployer');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return null;
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    process.stdout.write(`Usage:
  node scripts/dry-run.js --fixture test/fixtures/tweet.json
  node scripts/dry-run.js --url https://x.com/user/status/123
  node scripts/dry-run.js --payload '{"text":"hello frog","author":"x"}'

Always dry-run. Live create requires DEPLOY_ENABLED=1 and POST /deploy {"dryRun":false}.
`);
    return;
  }
  const fixture = arg('--fixture');
  const url = arg('--url');
  const payload = arg('--payload');
  let tweet = null;
  if (fixture) tweet = JSON.parse(fs.readFileSync(path.resolve(fixture), 'utf8'));
  if (payload) tweet = JSON.parse(payload);

  const env = { ...process.env, DEPLOY_ENABLED: process.env.DEPLOY_ENABLED || '' };
  const result = await deployer.runDeploy({
    url,
    tweet,
    name: arg('--name') || undefined,
    symbol: arg('--symbol') || undefined,
    uri: arg('--uri') || env.METADATA_URI || 'https://example.invalid/dry-run.json',
    solLamports: arg('--sol-lamports') || undefined,
    dryRun: true,
    env,
  });
  const out = {
    proposal: result.proposal,
    metadata: result.metadata,
    attempt: {
      ...result.attempt,
      // keep this script reviewable — no giant log dumps
      simulated: result.simulated
        ? { ok: result.simulated.ok, err: result.simulated.err, unitsConsumed: result.simulated.unitsConsumed }
        : null,
    },
    built: result.built,
    sent: result.sent,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(e.stack || e.message || String(e));
  process.stderr.write('\n');
  process.exit(1);
});
