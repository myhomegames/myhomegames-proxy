# MyHomeGames Proxy

Two Cloudflare Workers in **one** Wrangler project (`wrangler.toml`): tunnel provisioning and API gateway.

## Project layout

| File | Role | Worker name | Deploy |
|------|------|-------------|--------|
| `proxy.js` | Per-user Cloudflare Tunnel + `/api/get-token` | `myhomegames-tunnel-manager` | `npx wrangler deploy` |
| `igdb.js` | Twitch app credentials + forward to the user’s tunnel origin | `myhomegames-api-gateway` | `npx wrangler deploy --env igdb` |

### Workers routes (`wrangler.toml`)

| Route | Worker |
|-------|--------|
| `myhomegames-server.vige.it/*` | `myhomegames-tunnel-manager` (`proxy.js`) |
| `*.myhomegames-server.vige.it/igdb/*` | `myhomegames-api-gateway` (`igdb.js`, `--env igdb`) |

Deploy both:

```bash
npm run deploy
```

---

## Shared setup

```bash
cd myhomegames-proxy
npx wrangler login
```

---

## `proxy.js` — tunnel manager

Provisions a Cloudflare Tunnel per authenticated user and returns a `cloudflared` run token.

### What it does

- Landing page at `/` on host `myhomegames-server.vige.it`.
- `GET /api/get-token` using Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`).
- Tunnel name `MyHomeGames-<username>`; ingress + CNAME for `<username>.myhomegames-server.vige.it` → `http://localhost:4000`.
- JSON response: `token`, `url`.

Does not proxy API traffic or inject Twitch credentials.

### Config (default in `wrangler.toml`)

```toml
name = "myhomegames-tunnel-manager"
main = "proxy.js"

[vars]
MYGAMES_ACCOUNT_ID = "d2633016ba82b226e5596563e44ced6d"
```

Secret (default worker only):

```bash
npx wrangler secret put MYGAMES_CF_API_TOKEN
```

### Deploy

```bash
npx wrangler deploy
# or: npm run deploy:proxy
```

Route (in `wrangler.toml`): `myhomegames-server.vige.it/*`.

### `GET /api/get-token` response

```json
{
  "token": "<cloudflare_tunnel_run_token>",
  "url": "<username>.myhomegames-server.vige.it"
}
```

---

## `igdb.js` — API gateway (Twitch / IGDB)

Same repo, same `wrangler.toml`, **`[env.igdb]`** environment.

Handles traffic on `*.myhomegames-server.vige.it/igdb/*` (see routes above).

### What it does

1. **Strips** any `X-Twitch-Client-Id` / `X-Twitch-Client-Secret` sent by the browser (anti-spoofing).
2. **Injects** app credentials from Worker secrets (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`).
3. **Forwards** the request to the Node server with `fetch()` (no service binding).
4. On `POST /auth/twitch` with JSON body, merges `clientId` / `clientSecret` into the body if missing.

### Origin selection (`originBase`)

The forward target is chosen from the request **Host** header:

| Host | Forward URL |
|------|----------------|
| `*.myhomegames-server.vige.it` (per-user tunnel hostname) | `http://<same-hostname>:4000` + path + query |
| Anything else (local / tests) | `http://<ORIGIN_HTTP_HOST>:<ORIGIN_HTTP_PORT>` (defaults `127.0.0.1:4000`) |

Example: browser calls  
`GET https://luca.myhomegames-server.vige.it/igdb/search?q=zelda`  
→ Worker forwards to  
`http://luca.myhomegames-server.vige.it:4000/igdb/search?q=zelda`  
(with Twitch headers added).

The user’s `cloudflared` connector must be running so that hostname reaches `localhost:4000`.

### Config (`[env.igdb]` in `wrangler.toml`)

```toml
[env.igdb]
name = "myhomegames-api-gateway"
main = "igdb.js"

[[env.igdb.routes]]
pattern = "*.myhomegames-server.vige.it/igdb/*"
zone_name = "vige.it"
```

Secrets (**igdb** env):

```bash
npx wrangler secret put TWITCH_CLIENT_ID --env igdb
npx wrangler secret put TWITCH_CLIENT_SECRET --env igdb
```

Optional vars (fallback origin only, when Host is not a tunnel subdomain):

- `ORIGIN_HTTP_HOST` (default `127.0.0.1`)
- `ORIGIN_HTTP_PORT` (default `4000`)

No `BACKEND` service binding is required.

### Deploy

```bash
npx wrangler deploy --env igdb
# or: npm run deploy:igdb
```

### Errors

| Response | Cause |
|----------|--------|
| `500` Twitch secrets missing | `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` not set on `--env igdb` |
| `400` Invalid JSON | Malformed body on `POST /auth/twitch` |

### Scope of the route

Only paths under `/igdb/*` on per-user hostnames hit this Worker. Other API paths on the same host (e.g. `/auth/twitch`, `/settings`) need a separate route if they should also go through the gateway.

---

## How they work together

```
[Access] → myhomegames-tunnel-manager (proxy.js) @ myhomegames-server.vige.it
           /api/get-token → tunnel token

[PC] cloudflared → localhost:4000

[App] → myhomegames-api-gateway (igdb.js) @ luca.myhomegames-server.vige.it/igdb/*
        → fetch http://luca.myhomegames-server.vige.it:4000/igdb/...
        → Node (IGDB + Twitch app credentials on the request)
```

Tunnel manager and API gateway are separate Workers, one Wrangler project, two deploy commands (or `npm run deploy` for both).
