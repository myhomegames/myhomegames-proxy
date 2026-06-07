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
| Other paths on `<user>-myhomegames-server.vige.it` | Direct to tunnel → Node (no worker) |

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

## Tunnel manager (primary domain)

- Landing page at `/` on `myhomegames-server.vige.it`.
- `GET /api/get-token` using Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`).
- Tunnel name `MyHomeGames-<username>`; ingress + CNAME for `<username>-myhomegames-server.vige.it` → `http://localhost:4000`.
- `<username>` is slugified from the **full email** (local + domain), e.g. `luca.stancapiano@vige.it` → `luca-stancapiano-vige-it`.
- JSON response: `token`, `url`.

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

**Cloudflare Access**: apply a policy for `*-myhomegames-server.vige.it` as well (in addition to `myhomegames-server.vige.it`).

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
