# Railway operations — grokdev-brain

Handoff notes for the agent operating the brain. **The dangerous switch is `DEPLOY_ENABLED`. It is `0`. Keep it `0` until a funded wallet exists and a human says go.**

## Current state (verified 2026-08-25)

- Project: **grokdev-brain** (Railway, account ciberneticatrading@gmail.com)
- Service domain: `https://grokdev-brain-production.up.railway.app` (WebSocket on same host)
- Running: brain v1 observe-only, ~1600 coins watched, live and healthy.
- **PR #1 (`cursor/pump-deployer-3fd4`) is NOT deployed yet.** Railway runs `main`. Deploying the brain is manual (see below). Verified locally: 20/20 tests pass, gate correctly downgrades live→dry-run.

## Env vars already set (safe defaults)

| Var | Value | Note |
|---|---|---|
| `XAI_API_KEY` | set | **out of credits** → voice falls back to templates |
| `XAI_MODEL` | `grok-4-fast-non-reasoning` | |
| `DEPLOY_ENABLED` | `0` | **hard gate. leave 0.** |
| `DEPLOY_ON_WATCH` | `0` | no auto-create from watched tweets |
| `DEPLOY_COOLDOWN_HOURS` | `24` | |
| `DEPLOY_MAX_PER_WEEK` | `1` | |
| `SOLANA_RPC_URL` | mainnet public | replace with a paid RPC (Helius) before live |
| `BUY_SOL` | `0.01` | dev-buy size on create |

Not set yet (needed later, in this order):
- `WALLET_SECRET_KEY` — the `grok…` keypair (base58 or 64-byte JSON array). **NEVER commit. Railway env only.**
- `ANTHROPIC_API_KEY` — restores the voice now (cheaper than waiting on xAI credits). Model defaults to `claude-haiku-4-5-20251001`.
- `PINATA_JWT` or `METADATA_URI` — image/metadata hosting for real creates.
- `X_BEARER_TOKEN` (+ `X_WATCH_ACCOUNTS`) — live tweet firehose. Optional; tweet URL / pasted JSON works without it.
- `OPERATOR_SECRET` — if set, `POST /tweet` and `POST /deploy` require header `x-operator-secret`. Set this the moment the deploy routes go live.

## How to deploy the brain (manual)

```bash
cd brain
railway up --service grokdev-brain        # deploys current working tree
railway logs --service grokdev-brain      # watch it boot
```

The site (Vercel) auto-deploys on push to `main`; the brain does NOT. After merging PR #1, run `railway up`.

## Set a secret without committing it

```bash
# after grinding the wallet (scripts/generate-wallet.js):
railway variables --service grokdev-brain --set "WALLET_SECRET_KEY=<base58-or-json>" --skip-deploys
railway variables --service grokdev-brain --set "ANTHROPIC_API_KEY=sk-ant-…" --skip-deploys
railway redeploy --service grokdev-brain --yes
```

Verify: `curl https://grokdev-brain-production.up.railway.app/state` should show the wallet pubkey (never the secret) once wired.

## Go-live checklist (do NOT skip an item)

1. `railway up` PR #1. Confirm `/state` still healthy, `/live` still streams.
2. Add `ANTHROPIC_API_KEY` → voice returns (verify a non-template line appears in the feed).
3. Grind + set `WALLET_SECRET_KEY`. Confirm `/state` shows the `grok…` pubkey.
4. **Fund that wallet with SOL.** Nothing can create without balance.
5. Set a paid `SOLANA_RPC_URL`, `PINATA_JWT` (or `METADATA_URI`), and `OPERATOR_SECRET`.
6. Prove dry-run end-to-end: `POST /deploy` with a tweet URL → expect `mode:"dry-run"`, a built (unsent) tx, `TICKER ARMED` / `DRY-RUN` overlay on stream.
7. Only when a human decides: `DEPLOY_ENABLED=1`. The gate still enforces cooldown + 1/week. `DEPLOY_ON_WATCH` stays `0` unless you want fully autonomous creates.

## Sanity: what still can't happen with today's config

- No wallet set → deployer reports `observe-only`, refuses to build a tx.
- `DEPLOY_ENABLED=0` → any live attempt downgrades to dry-run (builds tx, never sends).
- LLM output cannot open the gate; only env vars can. This is by design — keep it that way.
