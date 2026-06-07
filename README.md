# MyHomeGames Proxy

Single Cloudflare Worker (`worker.js`): tunnel provisioning + IGDB/Twitch credential injection.

## Project layout

| File | Role |
|------|------|
| `worker.js` | Entry point: routing, `/api/get-token`, `/igdb/*` forward |

### Worker routes (`wrangler.toml`)

| Route | Handler |
|-------|---------|
| `myhomegames-server.vige.it/*` | Landing + `/api/get-token` |
| `*-myhomegames-server.vige.it/igdb/*` | Inject Twitch headers, forward to Node |
| Altri path su `<user>-myhomegames-server.vige.it` | Diretto al tunnel → Node (senza worker) |

Deploy:

```bash
npm run deploy
```

---

## Setup

```bash
cd myhomegames-proxy
npx wrangler login
npx wrangler secret put MYGAMES_CF_API_TOKEN
npx wrangler secret put TWITCH_CLIENT_ID
npx wrangler secret put TWITCH_CLIENT_SECRET
```

---

## Tunnel manager (dominio principale)

- Landing page at `/` on `myhomegames-server.vige.it`.
- `GET /api/get-token` using Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`).
- Tunnel name `MyHomeGames-<username>`; ingress + CNAME for `<username>-myhomegames-server.vige.it` → `http://localhost:4000`.
- JSON response: `token`, `url`.

### Config

```toml
name = "myhomegames-tunnel-manager"
main = "worker.js"

[vars]
MYGAMES_ACCOUNT_ID = "d2633016ba82b226e5596563e44ced6d"
```

---

## IGDB (`/igdb/*` sui sottodomini utente)

1. **Strips** any `X-Twitch-Client-Id` / `X-Twitch-Client-Secret` sent by the browser (anti-spoofing).
2. **Injects** app credentials from Worker secrets (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`).
3. **Forwards** via `fetch()` to `https://<user>-myhomegames-server.vige.it/...` → tunnel → `localhost:4000`.

Other API paths on the same host (e.g. `/library`, `/auth/twitch`) bypass the worker and reach Node directly through the tunnel.

### Errors

| Response | Cause |
|----------|--------|
| `500` Twitch secrets missing | `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` not set on the worker |

---

## How it works

```
[Access] → worker @ myhomegames-server.vige.it
           /api/get-token → tunnel token

[PC] cloudflared → localhost:4000

[App] → worker @ luca-myhomegames-server.vige.it/igdb/*
        → inject Twitch headers → tunnel → Node

[App] → luca-myhomegames-server.vige.it/library, /auth/twitch, …
        → tunnel → Node (no worker)
```

**Cloudflare Access**: policy anche per `*-myhomegames-server.vige.it` (oltre a `myhomegames-server.vige.it`).

One worker, one deploy: `npx wrangler deploy`.
