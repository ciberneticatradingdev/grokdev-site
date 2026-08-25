# grokdev

**Autonomous memecoin developer — observer, researcher, commentator, gated deployer.**
This repo contains the full public-facing system: the landing page, the 24/7 livestream view with a 3D character, and the real cognition engine ("the brain") that watches pump.fun live and can, when explicitly ungated, create a coin + initial buy from the agent's own wallet.

> **If you are an AI agent reading this to operate or extend the project: read this whole file first.**
> The design philosophy, the hard rules, and the event protocol below are not optional.

---

## Live URLs

| Thing | URL |
|---|---|
| Landing (plain-text dossier) | https://grokdev-woad.vercel.app |
| Stream view (the show) | https://grokdev-woad.vercel.app/live/ |
| Brain (Railway) | https://grokdev-brain-production.up.railway.app (`/health`, `/state`, WebSocket on same host) |
| This repo | https://github.com/ciberneticatradingdev/grokdev-site |

**Do not confuse** this repo with `ciberneticatradingdev/grokdev` (no `-site`) — that is a different, older monorepo. This repo is the live system. The sibling was not readable from this workspace (404); the deployer here is a clean public rewrite, not a copy of that tree.

## Deploys

- **Site (Vercel):** push to `main` → auto-deploys. Static files, no build step.
- **Brain (Railway):** project `grokdev-brain`, deployed with `cd brain && railway up --service grokdev-brain`. Not auto-deployed on push — deploy manually after changing `brain/`.

---

## What this is (concept)

GrokDev is a public AI character that lives on the internet, watches the memecoin market in real time, forms theses about attention, publishes them (including its mistakes), and will eventually deploy tokens — rarely and with a published thesis.

Strategic positioning (decided after on-chain research of the BWA wallet `bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa`, an industrial factory that creates a coin every 1–2 minutes across launchpads): **we are the anti-BWA.**

- BWA wins by volume. GrokDev wins by **selectivity + a verifiable public track record**.
- The product is the show, not the coins. Attention accrues to the agent's own token ($GROKDEV, not launched yet).
- Deploys are rare episodes (max ~1/week when enabled), announced with a thesis BEFORE deploying.
- Creator fees → treasury → $GROKDEV buyback (flywheel; phase 4, not built yet).

## Hard rules (non-negotiable)

1. **Never fake activity.** Every number shown in public (mcaps, counts, receipts) comes from the engine's real data. The LLM is the *voice*, never the source of facts. If the brain is down, the stream idles and says so — it never falls back to fake thoughts.
2. **Deploys are gated.** Default is observe-only + dry-run. A live Pump.fun create requires `DEPLOY_ENABLED=1`, a loaded agent wallet, and an explicit `dryRun: false`. The LLM cannot open the gate. Watched tweets never auto-create unless `DEPLOY_ON_WATCH=1` as well. Cooldown and weekly caps still apply.
3. **Errors stay published.** Wrong calls are announced and counted, same as correct ones. The track record is the product.
4. **Never commit secrets.** API keys live only in Railway env vars. `.env`, `state.json`, `.vercel/` are gitignored.
5. **No financial advice, never recommend buying.** The voice prompt enforces this; keep it that way.

---

## Repo map

```
index.html          Landing: black plain-text dossier. Pulls wallet + record from
                    GET /state when the brain is reachable (CORS).
live/index.html     The stream view (1080p mission-control layout, self-contained):
                      - 3D "grokbot" character (Three.js from CDN).
                      - cognition feed, ticker armory, signal monitor, vitals,
                        overlays (SIGNAL DETECTED / TICKER ARMED / RECEIPT LOGGED /
                        DEPLOYED / DRY-RUN DEPLOY). Wallet address from WS `wallet`.
brain/server.js     Cognition engine + operator HTTP. Observe loop unchanged.
brain/deployer/     Wallet, tweet ingest, metadata, Pump CreateV2+buy, hard gate.
brain/scripts/      generate-wallet.js, dry-run.js
brain/test/         node:test coverage + recorded dry-run fixture.
brain/.env.example  Env template (no secrets).
```

## The brain (`brain/server.js`)

Observe engine plus a **gated operator deployer**. Observe loops (unchanged):

- **pollNew (25s):** `GET frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC` — every new launch enters the `watch` map with mcap/reply samples; name/symbol words feed the meta detector.
- **pollWatched (45s):** re-fetches interesting/flagged coins individually (`/coins/{mint}`), detects graduations (`complete`), settles receipts.
- **cognitionTick (40s):**
  - **Signals:** flag a coin when age < 75 min, mcap ≥ $16k and ≥ 2.6× since first seen → public call with numbers + `SIGNAL DETECTED` overlay. `record.unresolved++`.
  - **Receipts:** flagged coin hits 2× from call → "receipt: flagged $X at $25k. now $61k" + green overlay, `record.correct++`. Drops < 0.45× (or stale) → "bad read. logged.", `record.wrong++`. Record persists to `state.json` and is summarized hourly.
  - **Metas:** word appearing across ≥ 4 unrelated launches (3h window) → armory candidate (`a-0NN`, status `watching`). ≥ 6 → public rejection: "counted N '<word>' coins in 3h. meta is cooked." and armory `rejected`.
  - **Voice:** LLM color commentary on a compact JSON context of real data. Chain: **xAI → Anthropic → data-driven templates** (feed never dies). Strict JSON out, max 2 lines, ≤ 140 chars, lowercase/dry/no-hype persona.
- HTTP: `/health` (ok), `/state` (JSON snapshot: uptime, watching, armory, record, metas, **wallet pubkey or null**, **deployEnabled**, **deployMode**, lastArmed, lastDeploy), `/wallet`, `POST /tweet`, `POST /deploy`.

**Env vars (Railway / local).** Full template: `brain/.env.example`. Never commit secrets.

| Var | Meaning |
|---|---|
| `PORT` | injected by Railway |
| `XAI_API_KEY` | Grok voice. Currently set but **out of credits** → falls through |
| `XAI_MODEL` | default `grok-4-fast-non-reasoning` |
| `ANTHROPIC_API_KEY` | optional fallback voice (default model `claude-haiku-4-5-20251001`) |
| `ANTHROPIC_MODEL` | override fallback model |
| `WALLET_SECRET_KEY` | agent keypair as base58 or JSON byte array. **never commit** |
| `WALLET_KEYPAIR_PATH` | path to Solana JSON keypair file (mode 0600) |
| `DEPLOY_ENABLED` | `1` to allow live create+buy. default off |
| `DEPLOY_ON_WATCH` | `1` to auto-create from watched X accounts (still needs `DEPLOY_ENABLED`) |
| `DEPLOY_COOLDOWN_HOURS` | default `24` |
| `DEPLOY_MAX_PER_WEEK` | default `1` |
| `OPERATOR_SECRET` | if set, POST routes require `x-operator-secret` |
| `SOLANA_RPC_URL` | required for building/simulating/sending. public mainnet RPC often rate-limits |
| `BUY_SOL` | initial buy size in SOL (default `0.01`) |
| `PINATA_JWT` | upload image + metadata JSON to IPFS |
| `METADATA_URI` | skip upload; use an already-hosted metadata JSON URL |
| `X_BEARER_TOKEN` | official X API v2. without it: tweet URL uses syndication/oembed, or paste a payload |
| `X_WATCH_ACCOUNTS` | comma-separated handles (needs bearer). proposes / arms; does not spray |
| `X_POLL_MS` | watch poll interval (default 180000) |

### Operator path (tweet → dry-run create+buy)

Generate a local wallet (prints **pubkey only**):

```bash
cd brain && npm install
node scripts/generate-wallet.js --out ./secrets/wallet.json
export WALLET_KEYPAIR_PATH=$PWD/secrets/wallet.json
```

Ingest a tweet and get proposed name/ticker/image (no chain):

```bash
curl -s localhost:8969/tweet -H 'content-type: application/json' \
  -d '{"tweet":{"text":"the frog has entered the chat. $FROG","author":"dev","media":[{"url":"https://example.com/frog.png","type":"photo"}]}}'
```

Or a tweet URL (works now via syndication/oembed; uses X API when `X_BEARER_TOKEN` is set):

```bash
curl -s localhost:8969/tweet -H 'content-type: application/json' \
  -d '{"url":"https://x.com/user/status/123"}'
```

Dry-run create+buy (default — **does not send**). Needs a wallet + a metadata URI (or `PINATA_JWT`) + RPC to actually *build* the tx; without those it still returns an honest `would deploy …` log:

```bash
node scripts/dry-run.js --fixture test/fixtures/tweet.json
# or
curl -s localhost:8969/deploy -H 'content-type: application/json' \
  -d '{"tweet":{"text":"$FROG","author":"dev"},"uri":"https://example.invalid/meta.json"}'
```

Live create is refused unless all of: `DEPLOY_ENABLED=1`, `dryRun: false` on the request, wallet funded, metadata URI uploaded, cooldown/weekly caps pass. CI and merge must not set `DEPLOY_ENABLED`.

Stack: official `@pump-fun/pump-sdk` (`createV2AndBuyInstructions`, Token-2022). Not the deprecated v1 `createInstruction`.

## WebSocket event protocol (brain → /live)

One JSON object per message. The `/live` page also exposes `window.Grok.push(event)` for manual injection, and accepts `?ws=wss://…` to point at any brain (with no param it uses `DEFAULT_WS`, hardcoded to the Railway brain).

```jsonc
{ "type": "line",     "tag": "obs|sig|arm|rej|dep|sys", "msg": "text" }   // one feed line, typed out
{ "type": "backfill", "lines": [{ "t": 1756…, "tag": "obs", "msg": "…" }] } // instant history on connect
{ "type": "vital",    "key": "load|sig|acc|narr|armed|dep", "value": 0.42 }
{ "type": "armory",   "rows": [{ "id": "a-014", "narrative": "…", "conf": 0.81, "status": "watching|armed|triggered|rejected" }] }
{ "type": "signal",   "rows": [{ "handle": "$TICKER", "vel": 0.72 }] }     // velocity bars, 0..1
{ "type": "overlay",  "title": "SIGNAL DETECTED", "sub": "context", "color": "green|amber|" }
{ "type": "wallet",   "address": "<pubkey or null>", "deployEnabled": false, "deployMode": "observe-only|dry-run|live" }
```

Reconnect behavior in `/live`: on close it prints "brain link lost. idling — no fake thoughts." and retries every 10s. The built-in simulation only runs when NO brain is configured at all (pure demo mode).

## Run locally

```bash
# brain
cd brain && npm install && npm test
PORT=8969 node server.js
# site: any static server, e.g.
npx serve -l 8968 .
# open http://localhost:8968/live/?ws=ws://localhost:8969
```

---

## Roadmap / current phase

- [x] **Phase 0** — landing + stream template + 3D character.
- [x] **Phase 1** — real observe-only brain wired to the stream. Voice runs on templates until xAI credits are topped up or `ANTHROPIC_API_KEY` is set.
- [ ] **Phase 2** — go on air: OBS on an always-on machine capturing `/live` → pump.fun RTMP. Grind vanity wallet starting with `grok`. Launch $GROKDEV. Landing now reads wallet + record from `/state` when the brain is up; X/stream/CA placeholders stay until those exist.
- [ ] **Phase 3** — X account posting (theses + receipts). Tweet *ingest* (URL / payload / optional `X_*` watch) is built; outbound posting is not.
- [x] **Phase 4 (path)** — gated deployer shipped: server-side wallet, tweet → name/ticker/image, official Pump CreateV2 + initial buy, dry-run default, WS overlays. **Still gated:** live mainnet create (`DEPLOY_ENABLED` stays off), fee→buyback flywheel, Pinata/X credentials, funded wallet. Do not turn the gate on in CI or on merge.

## Notes for agents extending this

- Keep the voice: lowercase, dry, skeptical, zero hype, no emojis. Read `index.html` — the landing IS the style guide.
- Any new public claim must be backed by engine data. If you add a feature that speaks, it must cite numbers the engine measured.
- The signal thresholds (in `detectSignals`) are tuned conservatively; if you loosen them, receipts will get noisier and the track record worse. Selectivity is the identity.
- pump.fun frontend API is unofficial and can change without notice — endpoints verified working 2026-08-25. If ingestion breaks, check `railway logs` first; the engine tolerates API failures without crashing.
