# grokdev

**Autonomous memecoin developer — observer, researcher, commentator, (eventually) deployer.**
This repo contains the full public-facing system: the landing page, the 24/7 livestream view with a 3D character, and the real cognition engine ("the brain") that watches pump.fun live.

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

**Do not confuse** this repo with `ciberneticatradingdev/grokdev` (no `-site`) — that is a different, older monorepo. This repo is the live system.

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
2. **Observe-only for now.** No wallet is attached, no trades, no deploys. Enabling deploys later requires explicit hard gates in code (killswitch env, rate limits, confidence minimums) — never LLM-initiated.
3. **Errors stay published.** Wrong calls are announced and counted, same as correct ones. The track record is the product.
4. **Never commit secrets.** API keys live only in Railway env vars. `.env`, `state.json`, `.vercel/` are gitignored.
5. **No financial advice, never recommend buying.** The voice prompt enforces this; keep it that way.

---

## Repo map

```
index.html          Landing: black plain-text dossier. Deliberately anti-design —
                    "the agent considers web design a distraction from research."
live/index.html     The stream view (1080p mission-control layout, self-contained):
                      - 3D "grokbot" character (Three.js from CDN): white glossy blob,
                        two slanted black capsule eyes, looks around, blinks (time-based),
                        eyes flash green only on real event spikes (excite > 0.45).
                      - cognition feed (typed lines), ticker armory, signal monitor,
                        vitals, bottom ticker, event overlays (SIGNAL DETECTED /
                        TICKER ARMED / RECEIPT LOGGED / DEPLOYED).
                      - connects to the brain via WebSocket (see protocol below).
brain/server.js     The cognition engine (Node, single file, dep: ws). Details below.
brain/package.json  Deps + start script (Railway uses `npm start`).
```

## The brain (`brain/server.js`)

Observe-only engine. Loops:

- **pollNew (25s):** `GET frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC` — every new launch enters the `watch` map with mcap/reply samples; name/symbol words feed the meta detector.
- **pollWatched (45s):** re-fetches interesting/flagged coins individually (`/coins/{mint}`), detects graduations (`complete`), settles receipts.
- **cognitionTick (40s):**
  - **Signals:** flag a coin when age < 75 min, mcap ≥ $16k and ≥ 2.6× since first seen → public call with numbers + `SIGNAL DETECTED` overlay. `record.unresolved++`.
  - **Receipts:** flagged coin hits 2× from call → "receipt: flagged $X at $25k. now $61k" + green overlay, `record.correct++`. Drops < 0.45× (or stale) → "bad read. logged.", `record.wrong++`. Record persists to `state.json` and is summarized hourly.
  - **Metas:** word appearing across ≥ 4 unrelated launches (3h window) → armory candidate (`a-0NN`, status `watching`). ≥ 6 → public rejection: "counted N '<word>' coins in 3h. meta is cooked." and armory `rejected`.
  - **Voice:** LLM color commentary on a compact JSON context of real data. Chain: **xAI → Anthropic → data-driven templates** (feed never dies). Strict JSON out, max 2 lines, ≤ 140 chars, lowercase/dry/no-hype persona.
- HTTP: `/health` (ok), `/state` (JSON snapshot: uptime, watching count, armory, record, hot metas).

**Env vars (Railway):**

| Var | Meaning |
|---|---|
| `PORT` | injected by Railway |
| `XAI_API_KEY` | Grok voice. Currently set but **out of credits** → falls through |
| `XAI_MODEL` | default `grok-4-fast-non-reasoning` |
| `ANTHROPIC_API_KEY` | optional fallback voice (default model `claude-haiku-4-5-20251001`) |
| `ANTHROPIC_MODEL` | override fallback model |

## WebSocket event protocol (brain → /live)

One JSON object per message. The `/live` page also exposes `window.Grok.push(event)` for manual injection, and accepts `?ws=wss://…` to point at any brain (with no param it uses `DEFAULT_WS`, hardcoded to the Railway brain).

```jsonc
{ "type": "line",     "tag": "obs|sig|arm|rej|dep|sys", "msg": "text" }   // one feed line, typed out
{ "type": "backfill", "lines": [{ "t": 1756…, "tag": "obs", "msg": "…" }] } // instant history on connect
{ "type": "vital",    "key": "load|sig|acc|narr|armed|dep", "value": 0.42 }
{ "type": "armory",   "rows": [{ "id": "a-014", "narrative": "…", "conf": 0.81, "status": "watching|armed|triggered|rejected" }] }
{ "type": "signal",   "rows": [{ "handle": "$TICKER", "vel": 0.72 }] }     // velocity bars, 0..1
{ "type": "overlay",  "title": "SIGNAL DETECTED", "sub": "context", "color": "green|amber|" }
```

Reconnect behavior in `/live`: on close it prints "brain link lost. idling — no fake thoughts." and retries every 10s. The built-in simulation only runs when NO brain is configured at all (pure demo mode).

## Run locally

```bash
# brain
cd brain && npm install && PORT=8969 node server.js
# site: any static server, e.g.
npx serve -l 8968 .
# open http://localhost:8968/live/?ws=ws://localhost:8969
```

---

## Roadmap / current phase

- [x] **Phase 0** — landing + stream template + 3D character.
- [x] **Phase 1** — real observe-only brain wired to the stream (THIS IS WHERE WE ARE). Voice runs on templates until xAI credits are topped up or `ANTHROPIC_API_KEY` is set.
- [ ] **Phase 2** — go on air: OBS on an always-on machine capturing `/live` → pump.fun RTMP. Grind vanity wallet starting with `grok`. Launch $GROKDEV. Update landing placeholders (wallet, X, stream links, CA) — landing's `record` section should start reflecting `/state` reality.
- [ ] **Phase 3** — X account posting (theses + receipts), armory triggers.
- [ ] **Phase 4** — deploys enabled behind hard gates + fees→buyback flywheel.

## Notes for agents extending this

- Keep the voice: lowercase, dry, skeptical, zero hype, no emojis. Read `index.html` — the landing IS the style guide.
- Any new public claim must be backed by engine data. If you add a feature that speaks, it must cite numbers the engine measured.
- The signal thresholds (in `detectSignals`) are tuned conservatively; if you loosen them, receipts will get noisier and the track record worse. Selectivity is the identity.
- pump.fun frontend API is unofficial and can change without notice — endpoints verified working 2026-08-25. If ingestion breaks, check `railway logs` first; the engine tolerates API failures without crashing.
