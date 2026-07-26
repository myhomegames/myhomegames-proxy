# MyHomeGames Proxy

Single Cloudflare Worker (`worker.js`): tunnel provisioning + IGDB/Twitch credential injection.

## Project layout

| File | Role |
|------|------|
| `worker.js` | Entry point: routing, `/api/get-token`, device pairing, `/igdb/*` forward |

### Worker routes (`wrangler.toml`)

| Route | Handler |
|-------|---------|
| `myhomegames-server.vige.it/*` | Landing + `/api/get-token` + device pairing + `/api/turn-ice-servers` |
| `*-myhomegames-server.vige.it/igdb/*` | Inject Twitch headers, forward to Node |
| Other paths on `<user>-myhomegames-server.vige.it` | Direct to tunnel → Node (no worker) |
| `<user>-moonlight-web.vige.it` | Direct to tunnel → Moonlight Web `:8080` (no worker) |

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
# Realtime TURN (browser remote play) — create key in Dashboard → Realtime → TURN
npx wrangler secret put CLOUDFLARE_TURN_KEY_ID
npx wrangler secret put CLOUDFLARE_TURN_API_TOKEN

# KV for Smart TV device-code pairing (required before deploy)
npx wrangler kv namespace create DEVICE_PAIRING
npx wrangler kv namespace create DEVICE_PAIRING --preview
# Paste the ids into wrangler.toml [[kv_namespaces]] binding DEVICE_PAIRING
```

Do **not** put TURN key/token in `myhomegames-server` `.env` or release packages. Home servers call `POST /api/turn-ice-servers` on this Worker; only short-lived ICE credentials leave Cloudflare.
---

## Tunnel manager (primary domain)

- Landing page at `/` on `myhomegames-server.vige.it`.
- `GET /api/get-token` using Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`).
- Tunnel name `MyHomeGames-<username>`; ingress + CNAME:
  - `<username>-myhomegames-server.vige.it` → `http://localhost:4000` (API)
  - `<username>-moonlight-web.vige.it` → `http://localhost:8080` (Moonlight Web UI for browser remote play)
- `<username>` is slugified from the **full email** (local + domain), e.g. `luca.stancapiano@vige.it` → `luca-stancapiano-vige-it`.
- JSON response: `token`, `url` (API hostname; Moonlight URL is derived by the server as `https://<username>-moonlight-web.vige.it`).
- `POST /api/turn-ice-servers` — mints short-lived Cloudflare Realtime TURN ICE servers for Moonlight Web (Worker secrets; used by home `myhomegames-server`). In Cloudflare Access, add a **Bypass** policy for this path so the home server can call it without a browser JWT.
- **Smart TV device pairing** (Access stays on the phone, not on the TV remote):
  - `POST /api/device/code` — creates a short-lived PIN session (KV `DEVICE_PAIRING`).
  - `GET /api/device/poll?device_code=` — TV polls until approved (`authorization_pending` | `expired` | `ok` + `{ token, url }`).
  - `GET /link` — phone UI to enter the PIN.
  - `GET /api/device/approve?user_code=` — requires Access JWT; mints the same tunnel payload as `get-token`.
  - In Cloudflare Access, add **Bypass** policies for: `/api/device/code`, `/api/device/poll`, and `/link` (keep `/api/device/approve` and `/api/get-token` behind Access).

### Config

```toml
name = "myhomegames-tunnel-manager"
main = "worker.js"

[vars]
MYGAMES_ACCOUNT_ID = "d2633016ba82b226e5596563e44ced6d"
```

---

## IGDB (`/igdb/*` on user subdomains)

1. **Strips** any `X-Twitch-Client-Id` / `X-Twitch-Client-Secret` sent by the browser (anti-spoofing).
2. **Injects** app credentials from Worker secrets (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`).
3. **Forwards** via `fetch()` to `https://<user>-myhomegames-server.vige.it/...` → tunnel → `localhost:4000`.

Other API paths on the same host (e.g. `/library`, `/collections`) bypass the worker and reach Node directly through the tunnel.

### Errors

| Response | Cause |
|----------|--------|
| `500` Twitch secrets missing | `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` not set on the worker |

---

## How it works

```
[Access] → worker @ myhomegames-server.vige.it
           /api/get-token → tunnel token

[TV]  POST /api/device/code → PIN + poll
[Phone] /link → Access → /api/device/approve → TV poll gets token/url

[PC] cloudflared → localhost:4000

[App] → worker @ luca-myhomegames-server.vige.it/igdb/*
        → inject Twitch headers → tunnel → Node

[App] → luca-myhomegames-server.vige.it/library, /collections, …
        → tunnel → Node (no worker)
```

**Cloudflare Access**: apply a policy for `*-myhomegames-server.vige.it` as well (in addition to `myhomegames-server.vige.it`). For browser remote play, either include `*-moonlight-web.vige.it` in Access or leave it without Access if the iframe must load without an extra login (hostname is still per-user).

One worker, one deploy: `npx wrangler deploy`.

---

## Troubleshooting Access (callback on `*.workers.dev`)

### Symptom

After login, the browser stays on a URL like:

```text
https://myhomegames-tunnel-manager.<account>.workers.dev/cdn-cgi/access/authorized?...
```

with a *“There is nothing here yet”* page, instead of returning to `/api/get-token` on `myhomegames-server.vige.it` or the `return_to` URL (e.g. `https://localhost:5173/app/`).

### Cause

The **Cloudflare Access** application is bound to the worker’s **`workers.dev`** subdomain (created via *Workers → Enable Access*), while users often start from **`myhomegames-server.vige.it`**. Access OAuth callbacks use **`*.workers.dev/cdn-cgi/access/authorized`**.

With `workers_dev = false`, the worker **does not** respond on `workers.dev` → empty page / *“There is nothing here yet”*.

**Immediate fix (repo):** set `workers_dev = true` in `wrangler.toml`, then run `npx wrangler deploy`.

**Long-term fix (dashboard, recommended):**

1. **Zero Trust → Access → Applications**
   - Find an app protecting `myhomegames-tunnel-manager.<account>.workers.dev` → **delete** or **disable** it.
   - Do not leave an Access app active only on `workers.dev`.

2. **Create (or verify) a Self-hosted app** for the custom domain:
   - **Application domain**: `myhomegames-server.vige.it`
   - **Path**: empty (entire host) or `/api/get-token` if you want to restrict access
   - **Policy**: authorized users/groups (same as before)
   - Same IdP (e.g. Google) as before

3. **Workers & Pages → `myhomegames-tunnel-manager` → Settings**
   - If “Restrict access” / Access is tied only to the `workers.dev` preview, disable it there and use the Self-hosted app from step 2.

4. **Workers & Pages → Triggers → Routes** (or `wrangler deploy`)
   - Confirm route: `myhomegames-server.vige.it/*` → worker `myhomegames-tunnel-manager`.

5. **Verify** (private window):
   - Open `https://myhomegames-server.vige.it/api/get-token`
   - After login, the callback `/cdn-cgi/access/authorized` may be on `workers.dev` (OK if `workers_dev = true`), then redirect to `get-token` / `return_to`
   - Optional: once Access is only on `vige.it`, set `workers_dev = false` again in `wrangler.toml`

### Temporary alternative (everything on workers.dev)

If Access remains bound to `workers.dev`, align the entry point in `myhomegames-web/.env`:

```env
VITE_TUNNEL_MANAGER_URL=https://myhomegames-tunnel-manager.<account>.workers.dev
```

(replace `<account>` with your workers.dev subdomain). Login and callback stay on the same host.

### Note on `return_to` in dev

The web app passes `return_to=https://localhost:5173/app/` to the manager. Cloudflare **does not** serve localhost: it only redirects the browser to that URL after auth. Always open the app from that origin before clicking “Connect Cloudflare”.
