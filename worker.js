const MANAGER_HOST = "myhomegames-server.vige.it";
const USER_TUNNEL_HOST_SUFFIX = "-myhomegames-server.vige.it";
const USER_MOONLIGHT_HOST_SUFFIX = "-moonlight-web.vige.it";
const ZONE_ID = "243802546c0a2d88201fe78091fa3e84";
const IGDB_GATEWAY_PREFIX = "/api/igdb-gateway";
/** Host port where Moonlight Web listens (server MOONLIGHT_WEB_PORT default). */
const MOONLIGHT_WEB_LOCAL_PORT = 8080;

const DEVICE_CODE_TTL_SECONDS = 600;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function userTunnelHostname(username) {
  return `${username}${USER_TUNNEL_HOST_SUFFIX}`;
}

function userMoonlightWebHostname(username) {
  return `${username}${USER_MOONLIGHT_HOST_SUFFIX}`;
}

function slugEmailPart(part) {
  return String(part || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Unique tunnel username from full email (local part + domain). */
function usernameFromEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return slugEmailPart(normalized);
  }
  const local = slugEmailPart(normalized.slice(0, at));
  const domain = slugEmailPart(normalized.slice(at + 1));
  if (!local) return domain;
  if (!domain) return local;
  return `${local}-${domain}`;
}

function isTunnelUserHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === MANAGER_HOST) return false;
  return host.endsWith(USER_TUNNEL_HOST_SUFFIX);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = request.headers.get("Host") || url.hostname;
    const route = pickRoute(hostname, url.pathname, request.method);

    if (route === "igdb-gateway-relay") {
      return handleIgdbGatewayRelay(request, env);
    }
    if (route === "igdb-subdomain") {
      return forwardIgdbToTunnel(request, env, hostname);
    }
    if (route === "landing") {
      return Response.redirect(new URL("/api/get-token", request.url).toString(), 302);
    }
    if (route === "get-token-options") {
      return corsPreflight(request);
    }
    if (route === "get-token") {
      return handleGetToken(request, env);
    }
    if (route === "turn-ice-servers-options") {
      return corsPreflight(request, { methods: "GET, POST, OPTIONS" });
    }
    if (route === "turn-ice-servers") {
      return handleTurnIceServers(request, env);
    }
    if (route === "device-code-options") {
      return corsPreflight(request, { methods: "POST, OPTIONS" });
    }
    if (route === "device-code") {
      return handleDeviceCode(request, env);
    }
    if (route === "device-poll-options") {
      return corsPreflight(request, { methods: "GET, OPTIONS" });
    }
    if (route === "device-poll") {
      return handleDevicePoll(request, env);
    }
    if (route === "device-approve") {
      return handleDeviceApprove(request, env);
    }
    if (route === "link") {
      return handleLinkPage(request);
    }
    if (route === "deprovision-page") {
      return handleDeprovisionPage(request);
    }
    if (route === "deprovision-user-options") {
      return corsPreflight(request, { methods: "POST, OPTIONS" });
    }
    if (route === "deprovision-user") {
      return handleDeprovisionUser(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function pickRoute(hostname, pathname, method) {
  if (hostname === MANAGER_HOST && pathname.startsWith(`${IGDB_GATEWAY_PREFIX}/`)) {
    return "igdb-gateway-relay";
  }
  if (isIgdbPath(pathname) && isTunnelUserHost(hostname)) {
    return "igdb-subdomain";
  }
  if (pathname === "/" && hostname === MANAGER_HOST) {
    return "landing";
  }
  if (
    hostname === MANAGER_HOST &&
    (pathname === "/api/get-token" || pathname.startsWith("/api/get-token/r/"))
  ) {
    return method === "OPTIONS" ? "get-token-options" : "get-token";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/turn-ice-servers") {
    return method === "OPTIONS" ? "turn-ice-servers-options" : "turn-ice-servers";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/device/code") {
    return method === "OPTIONS" ? "device-code-options" : "device-code";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/device/poll") {
    return method === "OPTIONS" ? "device-poll-options" : "device-poll";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/device/approve") {
    return "device-approve";
  }
  if (hostname === MANAGER_HOST && (pathname === "/link" || pathname === "/link/")) {
    return "link";
  }
  if (hostname === MANAGER_HOST && (pathname === "/deprovision" || pathname === "/deprovision/")) {
    return "deprovision-page";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/deprovision-user") {
    return method === "OPTIONS" ? "deprovision-user-options" : "deprovision-user";
  }
  return "unmatched";
}

const DEFAULT_TURN_TTL_SECONDS = 86_400;

/**
 * Mint short-lived Cloudflare Realtime TURN credentials for Moonlight Web.
 * Long-term TURN key stays in Worker secrets (never shipped in server .env / releases).
 * Home servers call this via POST; allow Access Bypass for this path.
 */
async function handleTurnIceServers(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405);
  }

  const keyId = String(env.CLOUDFLARE_TURN_KEY_ID || "").trim();
  const apiToken = String(env.CLOUDFLARE_TURN_API_TOKEN || "").trim();
  if (!keyId || !apiToken) {
    return jsonWithCors(
      request,
      {
        error: "Cloudflare TURN is not configured on the tunnel manager",
        detail: "Set Worker secrets CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN.",
      },
      503,
    );
  }

  let ttl = DEFAULT_TURN_TTL_SECONDS;
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const requested = Number(body?.ttl);
      if (Number.isFinite(requested) && requested > 0) {
        ttl = Math.min(requested, 172_800);
      }
    } catch {
      // empty / non-JSON body → default ttl
    }
  }

  const upstream = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
    },
  );

  const text = await upstream.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!upstream.ok) {
    return jsonWithCors(
      request,
      {
        error: "TURN credential generation failed",
        detail: text.slice(0, 200),
      },
      502,
    );
  }

  const iceServers = toMoonlightIceServers(payload);
  if (iceServers.length === 0) {
    return jsonWithCors(request, { error: "TURN returned no usable ICE servers" }, 502);
  }

  return new Response(JSON.stringify(iceServers), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(request, { methods: "GET, POST, OPTIONS" }),
    },
  });
}

function filterBrowserSafeTurnUrls(urls) {
  return (Array.isArray(urls) ? urls : []).filter((url) => {
    const value = String(url || "");
    return value.length > 0 && !/:53(?:\?|$)/.test(value);
  });
}

function toMoonlightIceServers(payload) {
  const list = Array.isArray(payload?.iceServers)
    ? payload.iceServers
    : Array.isArray(payload)
      ? payload
      : [];

  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const urls = filterBrowserSafeTurnUrls(
        Array.isArray(entry.urls) ? entry.urls : entry.urls != null ? [entry.urls] : [],
      );
      if (urls.length === 0) return null;
      const out = { urls };
      if (typeof entry.username === "string" && entry.username) out.username = entry.username;
      if (typeof entry.credential === "string" && entry.credential) out.credential = entry.credential;
      return out;
    })
    .filter(Boolean);
}

async function handleIgdbGatewayRelay(request, env) {
  const incoming = new URL(request.url);
  const tunnelHost = String(request.headers.get("X-MHG-Tunnel-Host") || "").trim().toLowerCase();
  const igdbPath = incoming.pathname.slice(IGDB_GATEWAY_PREFIX.length) || "/";

  if (!isTunnelUserHost(tunnelHost)) {
    return new Response("X-MHG-Tunnel-Host must be a user tunnel hostname", { status: 400 });
  }
  if (!isIgdbPath(igdbPath)) {
    return new Response("Path must be under /igdb/", { status: 400 });
  }

  return forwardIgdbToTunnel(request, env, tunnelHost, igdbPath, incoming.search);
}

async function forwardIgdbToTunnel(request, env, tunnelHost, pathnameOverride, searchOverride) {
  const incoming = new URL(request.url);
  const igdbPath =
    pathnameOverride ??
    (isIgdbPath(incoming.pathname) ? incoming.pathname : incoming.pathname.slice(IGDB_GATEWAY_PREFIX.length) || "/");
  const search = searchOverride ?? incoming.search;

  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return new Response("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET secrets are missing", { status: 500 });
  }

  const target = new URL(igdbPath + search, originBase(env, tunnelHost));
  const headers = new Headers(request.headers);
  headers.delete("X-Twitch-Client-Id");
  headers.delete("X-Twitch-Client-Secret");
  headers.delete("X-MHG-Tunnel-Host");
  if (env.TWITCH_CLIENT_ID) headers.set("X-Twitch-Client-Id", env.TWITCH_CLIENT_ID);
  if (env.TWITCH_CLIENT_SECRET) headers.set("X-Twitch-Client-Secret", env.TWITCH_CLIENT_SECRET);

  return fetch(new Request(target.toString(), {
    method: request.method,
    headers,
    body: request.body ?? undefined,
    redirect: "manual",
  }));
}

function isIgdbPath(pathname) {
  return pathname === "/igdb" || pathname.startsWith("/igdb/");
}

function originBase(env, hostname) {
  if (isTunnelUserHost(hostname)) {
    return `https://${hostname}`;
  }
  const host = (env.ORIGIN_HTTP_HOST || "127.0.0.1").trim();
  const port = (env.ORIGIN_HTTP_PORT || "4000").trim();
  return `http://${host}:${port}`;
}

function isAllowedReturnUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (host.endsWith(USER_TUNNEL_HOST_SUFFIX)) return true;
    if (host === MANAGER_HOST) return true;
    if (host.endsWith(".myhomegames.vige.it") || host === "myhomegames.vige.it") return true;
  } catch {
    return false;
  }
  return false;
}

function redirectToReturnUrl(returnTo, params = {}) {
  const dest = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) {
    dest.searchParams.set(key, value);
  }
  return Response.redirect(dest.toString(), 302);
}

function encodeTunnelReturnHash(payload) {
  const json = JSON.stringify({
    token: payload.token,
    url: payload.url,
  });
  const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `tunnel=${b64}`;
}

function readReturnToCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)mhg_return_to=([^;]*)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return "";
  }
}

function appendReturnToCookie(headers, returnTo) {
  headers.append(
    "Set-Cookie",
    `mhg_return_to=${encodeURIComponent(returnTo)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
  );
}

/** Browser OAuth return: pass token in URL fragment so the SPA can POST /tunnel/connect without cross-origin fetch. */
function redirectToAppWithTunnel(returnTo, payload) {
  const dest = new URL(returnTo);
  dest.searchParams.set("tunnel_auth", "ok");
  dest.hash = encodeTunnelReturnHash(payload);
  const headers = new Headers({ Location: dest.toString() });
  appendReturnToCookie(headers, returnTo);
  return new Response(null, { status: 302, headers });
}

function decodeBase64Url(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return atob(padded + "=".repeat(padLen));
}

/** return_to from path (/api/get-token/r/<b64url>) survives Access logout redirects. */
function parseGetTokenReturnTo(requestUrl) {
  const prefix = "/api/get-token/r/";
  const pathname = requestUrl.pathname;
  if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
    try {
      const decoded = decodeBase64Url(pathname.slice(prefix.length)).trim();
      if (decoded) return decoded;
    } catch {
      // fall through
    }
  }
  return requestUrl.searchParams.get("return_to")?.trim() || "";
}

function emailFromAccessJwt(request) {
  const jwt =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    readAccessJwtFromCookie(request);
  if (!jwt) return { error: "not_authenticated" };
  let email;
  try {
    email = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email;
  } catch {
    return { error: "invalid_token" };
  }
  if (!email) return { error: "no_email" };
  return { email: String(email) };
}

function readAccessJwtFromCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return String(match[1] || "").trim();
  }
}

/**
 * Create or fetch the Cloudflare Tunnel for this Access identity.
 * Shared by browser get-token and TV device-code approve.
 */
async function mintTunnelForEmail(env, email) {
  const username = usernameFromEmail(email);
  const tunnelName = "MyHomeGames-" + username;
  const accountApi = "https://api.cloudflare.com/client/v4/accounts/" + env.MYGAMES_ACCOUNT_ID;
  const headers = { Authorization: "Bearer " + env.MYGAMES_CF_API_TOKEN, "Content-Type": "application/json" };

  const listResp = await fetch(accountApi + "/cfd_tunnel?name=" + tunnelName, { headers });
  const listData = await listResp.json();

  if (listData.result && listData.result.length > 0) {
    const tunnelId = listData.result[0].id;
    await ensureUserTunnelRouting(accountApi, tunnelId, username, headers);
    const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/token", { headers });
    const tokenData = await tokenResp.json();
    const token = extractRunToken(tokenData);
    if (!token) {
      return { error: "missing_token" };
    }
    return { token, url: userTunnelHostname(username) };
  }

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const createResp = await fetch(accountApi + "/cfd_tunnel", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: tunnelName, tunnel_secret: secret }),
  });
  const createData = await createResp.json();

  if (!createData.success) {
    return { error: "create_tunnel_failed", details: createData.errors };
  }

  const tunnelId = createData.result.id;
  await ensureUserTunnelRouting(accountApi, tunnelId, username, headers);

  const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/token", { headers });
  const tokenData = await tokenResp.json();
  const token = extractRunToken(tokenData);
  if (!token) {
    return { error: "missing_token" };
  }
  return { token, url: userTunnelHostname(username) };
}

async function handleGetToken(request, env) {
  const requestUrl = new URL(request.url);

  if (requestUrl.searchParams.has("__cf_access_message")) {
    const cleaned = new URL(requestUrl);
    cleaned.searchParams.delete("__cf_access_message");
    const headers = new Headers({ Location: cleaned.toString() });
    const cleanedReturnTo = parseGetTokenReturnTo(cleaned);
    if (cleanedReturnTo && isAllowedReturnUrl(cleanedReturnTo)) {
      appendReturnToCookie(headers, cleanedReturnTo);
    }
    return new Response(null, { status: 302, headers });
  }

  const returnTo = parseGetTokenReturnTo(requestUrl);
  let browserReturnTo = returnTo && isAllowedReturnUrl(returnTo) ? returnTo : "";
  if (!browserReturnTo) {
    const fromCookie = readReturnToCookie(request);
    if (fromCookie && isAllowedReturnUrl(fromCookie)) {
      browserReturnTo = fromCookie;
    }
  }

  const identity = emailFromAccessJwt(request);
  if (identity.error) {
    if (browserReturnTo) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: identity.error });
    }
    return jsonWithCors(request, { error: "Not authenticated" }, 401);
  }

  if (!browserReturnTo) {
    const fallback = String(env.DEFAULT_APP_RETURN_URL || "").trim();
    if (fallback && isAllowedReturnUrl(fallback)) {
      browserReturnTo = fallback;
    }
  }

  const minted = await mintTunnelForEmail(env, identity.email);
  if (minted.error) {
    if (browserReturnTo) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: minted.error });
    }
    const status = minted.error === "create_tunnel_failed" ? 500 : 502;
    return jsonWithCors(
      request,
      { error: minted.error === "create_tunnel_failed" ? "Failed to create tunnel" : "Missing tunnel token", details: minted.details },
      status,
    );
  }

  const payload = { token: minted.token, url: minted.url };
  if (browserReturnTo) {
    return redirectToAppWithTunnel(browserReturnTo, payload);
  }
  return jsonWithCors(request, payload);
}

/* ---------- Device-code pairing (Smart TV) ---------- */

function pairingKv(env) {
  return env.DEVICE_PAIRING || null;
}

function deviceKey(deviceCode) {
  return `device:${deviceCode}`;
}

function userKey(userCode) {
  return `user:${normalizeUserCode(userCode)}`;
}

function normalizeUserCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function formatUserCode(normalized) {
  const clean = normalizeUserCode(normalized);
  if (clean.length !== 8) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

function randomUserCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  }
  return formatUserCode(out);
}

function randomDeviceCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function putPairingSession(kv, session) {
  const ttl = Math.max(60, Math.floor((session.expires_at - Date.now()) / 1000));
  const body = JSON.stringify(session);
  await kv.put(deviceKey(session.device_code), body, { expirationTtl: ttl });
  await kv.put(userKey(session.user_code), session.device_code, { expirationTtl: ttl });
}

async function readPairingByDevice(kv, deviceCode) {
  const raw = await kv.get(deviceKey(deviceCode));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readPairingByUserCode(kv, userCode) {
  const deviceCode = await kv.get(userKey(userCode));
  if (!deviceCode) return null;
  return readPairingByDevice(kv, deviceCode);
}

async function deletePairingSession(kv, session) {
  await Promise.all([
    kv.delete(deviceKey(session.device_code)),
    kv.delete(userKey(session.user_code)),
  ]);
}

async function handleDeviceCode(request, env) {
  if (request.method !== "POST") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405, { methods: "POST, OPTIONS" });
  }

  const kv = pairingKv(env);
  if (!kv) {
    return jsonWithCors(
      request,
      {
        error: "Device pairing is not configured",
        detail: "Bind a KV namespace as DEVICE_PAIRING on the tunnel manager Worker.",
      },
      503,
      { methods: "POST, OPTIONS" },
    );
  }

  let userCode = randomUserCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await kv.get(userKey(userCode));
    if (!existing) break;
    userCode = randomUserCode();
  }

  const deviceCode = randomDeviceCode();
  const expiresAt = Date.now() + DEVICE_CODE_TTL_SECONDS * 1000;
  const verificationUri = `https://${MANAGER_HOST}/link`;
  const verificationUriComplete = `${verificationUri}?code=${encodeURIComponent(normalizeUserCode(userCode))}`;

  const session = {
    device_code: deviceCode,
    user_code: normalizeUserCode(userCode),
    status: "pending",
    expires_at: expiresAt,
    created_at: Date.now(),
  };
  await putPairingSession(kv, session);

  return jsonWithCors(
    request,
    {
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    },
    200,
    { methods: "POST, OPTIONS" },
  );
}

async function handleDevicePoll(request, env) {
  if (request.method !== "GET") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405, { methods: "GET, OPTIONS" });
  }

  const kv = pairingKv(env);
  if (!kv) {
    return jsonWithCors(
      request,
      { error: "Device pairing is not configured" },
      503,
      { methods: "GET, OPTIONS" },
    );
  }

  const deviceCode = new URL(request.url).searchParams.get("device_code")?.trim() || "";
  if (!deviceCode || deviceCode.length < 16) {
    return jsonWithCors(request, { error: "invalid_device_code" }, 400, { methods: "GET, OPTIONS" });
  }

  const session = await readPairingByDevice(kv, deviceCode);
  if (!session) {
    return jsonWithCors(request, { status: "expired" }, 200, { methods: "GET, OPTIONS" });
  }
  if (session.expires_at && Date.now() > session.expires_at) {
    await deletePairingSession(kv, session);
    return jsonWithCors(request, { status: "expired" }, 200, { methods: "GET, OPTIONS" });
  }
  if (session.status === "pending") {
    return jsonWithCors(request, { status: "authorization_pending" }, 200, { methods: "GET, OPTIONS" });
  }
  if (session.status === "ok" && session.token && session.url) {
    const payload = { status: "ok", token: session.token, url: session.url };
    await deletePairingSession(kv, session);
    return jsonWithCors(request, payload, 200, { methods: "GET, OPTIONS" });
  }

  return jsonWithCors(request, { status: "expired" }, 200, { methods: "GET, OPTIONS" });
}

async function handleDeviceApprove(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return htmlPage("Method not allowed", "<p>Use GET or POST.</p>", 405);
  }

  const kv = pairingKv(env);
  if (!kv) {
    return htmlPage(
      "Pairing unavailable",
      "<p>Device pairing KV is not configured on the tunnel manager.</p>",
      503,
    );
  }

  const identity = emailFromAccessJwt(request);
  if (identity.error) {
    return htmlPage(
      "Sign in required",
      "<p>Cloudflare Access authentication is required to link a TV.</p>",
      401,
    );
  }

  let userCode = "";
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await request.json();
        userCode = String(body?.user_code || "");
      } catch {
        userCode = "";
      }
    } else {
      const form = await request.formData();
      userCode = String(form.get("user_code") || "");
    }
  } else {
    userCode = new URL(request.url).searchParams.get("user_code") || "";
  }

  const normalized = normalizeUserCode(userCode);
  if (normalized.length !== 8) {
    return htmlPage(
      "Invalid code",
      `<p>Enter the 8-character code shown on the TV.</p><p><a href="/link">Try again</a></p>`,
      400,
    );
  }

  const session = await readPairingByUserCode(kv, normalized);
  if (!session || (session.expires_at && Date.now() > session.expires_at)) {
    if (session) await deletePairingSession(kv, session);
    return htmlPage(
      "Code expired",
      `<p>That code is invalid or expired. Start again from the TV.</p><p><a href="/link">Try again</a></p>`,
      410,
    );
  }
  if (session.status === "ok") {
    return htmlPage(
      "Already linked",
      "<p>This code was already approved. Check the TV — it should connect shortly.</p>",
      200,
    );
  }

  const minted = await mintTunnelForEmail(env, identity.email);
  if (minted.error) {
    return htmlPage(
      "Tunnel error",
      `<p>Could not prepare your tunnel (${minted.error}).</p><p><a href="/link">Try again</a></p>`,
      502,
    );
  }

  const updated = {
    ...session,
    status: "ok",
    token: minted.token,
    url: minted.url,
    approved_email: identity.email,
    approved_at: Date.now(),
  };
  await putPairingSession(kv, updated);

  return htmlPage(
    "TV linked",
    `<p>Signed in as <strong>${escapeHtml(identity.email)}</strong>.</p>
     <p>Return to the TV — MyHomeGames should connect automatically.</p>`,
    200,
  );
}

function handleLinkPage(request) {
  const url = new URL(request.url);
  const prefill = formatUserCode(url.searchParams.get("code") || "");
  const approveUrl = "/api/device/approve";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link TV — MyHomeGames</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      background: #0b0b0c; color: #f2f2f2;
    }
    main {
      width: min(420px, 92vw); padding: 2rem;
      border: 1px solid rgba(255,255,255,.12); border-radius: 16px;
      background: rgba(255,255,255,.04);
    }
    h1 { margin: 0 0 .5rem; font-size: 1.5rem; }
    p { margin: 0 0 1.25rem; color: rgba(255,255,255,.7); line-height: 1.45; }
    label { display: block; font-size: .85rem; margin-bottom: .4rem; color: rgba(255,255,255,.8); }
    input {
      width: 100%; box-sizing: border-box; font-size: 1.5rem; letter-spacing: .2em;
      text-align: center; text-transform: uppercase; padding: .75rem;
      border-radius: 10px; border: 1px solid rgba(255,255,255,.2);
      background: #111; color: #fff; margin-bottom: 1rem;
    }
    button {
      width: 100%; padding: .85rem 1rem; border: 0; border-radius: 10px;
      background: #e5a00d; color: #111; font-weight: 700; font-size: 1rem; cursor: pointer;
    }
    button:hover { filter: brightness(1.05); }
  </style>
</head>
<body>
  <main>
    <h1>Link your TV</h1>
    <p>Enter the code shown on the Smart TV, then sign in with Cloudflare Access.</p>
    <form method="GET" action="${approveUrl}">
      <label for="user_code">TV code</label>
      <input id="user_code" name="user_code" maxlength="9" inputmode="text" autocomplete="one-time-code"
        spellcheck="false" value="${escapeHtml(prefill)}" placeholder="ABCD-EFGH" required />
      <button type="submit">Continue with Cloudflare</button>
    </form>
  </main>
  <script>
    (function () {
      var input = document.getElementById("user_code");
      if (!input) return;
      function formatCode(raw) {
        var clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
        if (clean.length <= 4) return clean;
        return clean.slice(0, 4) + "-" + clean.slice(4);
      }
      function applyFormat() {
        var start = input.selectionStart;
        var before = input.value;
        var next = formatCode(before);
        if (next === before) return;
        input.value = next;
        // Keep caret after the typed char; jump past auto-inserted hyphen.
        var pos = typeof start === "number" ? start : next.length;
        if (before.length < next.length && next.charAt(pos - 1) === "-") pos += 1;
        if (next.length >= 5 && before.length <= 4 && pos === 4) pos = 5;
        try { input.setSelectionRange(pos, pos); } catch (e) {}
      }
      input.addEventListener("input", applyFormat);
      input.addEventListener("blur", applyFormat);
      applyFormat();
    })();
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title, bodyHtml, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — MyHomeGames</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      background: #0b0b0c; color: #f2f2f2;
    }
    main {
      width: min(420px, 92vw); padding: 2rem;
      border: 1px solid rgba(255,255,255,.12); border-radius: 16px;
      background: rgba(255,255,255,.04);
    }
    h1 { margin: 0 0 .75rem; font-size: 1.4rem; }
    p { margin: 0 0 .75rem; color: rgba(255,255,255,.75); line-height: 1.45; }
    a { color: #e5a00d; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function ensureUserTunnelRouting(accountApi, tunnelId, username, headers) {
  const hostname = userTunnelHostname(username);
  const moonlightHostname = userMoonlightWebHostname(username);
  await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/configurations", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname, service: "http://localhost:4000" },
          { hostname: moonlightHostname, service: `http://localhost:${MOONLIGHT_WEB_LOCAL_PORT}` },
          { service: "http_status:404" },
        ],
      },
    }),
  });
  const tunnelTarget = tunnelId + ".cfargotunnel.com";
  await ensureDnsCname(ZONE_ID, headers, hostname, tunnelTarget);
  await ensureDnsCname(ZONE_ID, headers, moonlightHostname, tunnelTarget);
}

/**
 * Remove Cloudflare Tunnel + per-user DNS + Zero Trust / Access identity.
 */
async function deprovisionUserResources(env, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const username = usernameFromEmail(normalizedEmail);
  if (!username) {
    return { error: "invalid_email", email };
  }

  const tunnelName = "MyHomeGames-" + username;
  const apiHostname = userTunnelHostname(username);
  const moonlightHostname = userMoonlightWebHostname(username);
  const accountApi = "https://api.cloudflare.com/client/v4/accounts/" + env.MYGAMES_ACCOUNT_ID;
  const headers = {
    Authorization: "Bearer " + env.MYGAMES_CF_API_TOKEN,
    "Content-Type": "application/json",
  };

  const access = await deleteAccessIdentity(accountApi, headers, normalizedEmail);

  const dns = {
    api: await deleteDnsCname(ZONE_ID, headers, apiHostname),
    moonlight: await deleteDnsCname(ZONE_ID, headers, moonlightHostname),
  };

  const listResp = await fetch(
    accountApi + "/cfd_tunnel?name=" + encodeURIComponent(tunnelName) + "&is_deleted=false",
    { headers },
  );
  const listData = await listResp.json();
  const tunnels = Array.isArray(listData?.result) ? listData.result : [];
  const tunnelDeletes = [];

  for (const tunnel of tunnels) {
    const tunnelId = tunnel?.id;
    if (!tunnelId) continue;
    const delResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId, {
      method: "DELETE",
      headers,
    });
    const delData = await delResp.json().catch(() => ({}));
    tunnelDeletes.push({
      id: tunnelId,
      name: tunnel.name || tunnelName,
      deleted: Boolean(delData?.success) || delResp.status === 200 || delResp.status === 404,
      status: delResp.status,
      errors: delData?.errors || null,
    });
  }

  return {
    email: normalizedEmail,
    username,
    tunnelName,
    hostnames: { api: apiHostname, moonlight: moonlightHostname },
    access,
    dns,
    tunnels: tunnelDeletes,
    tunnelFound: tunnels.length > 0,
  };
}

/**
 * Revoke Access sessions, delete Zero Trust user seat(s), and strip email from
 * Access Groups / application policies when present as an include rule.
 */
async function deleteAccessIdentity(accountApi, headers, email) {
  const revokeResp = await fetch(accountApi + "/access/organizations/revoke_user", {
    method: "POST",
    headers,
    body: JSON.stringify({ email, devices: true }),
  });
  const revokeData = await revokeResp.json().catch(() => ({}));
  const revoke = {
    ok: Boolean(revokeData?.success) || revokeResp.status === 200 || revokeResp.status === 404,
    status: revokeResp.status,
    errors: revokeData?.errors || null,
  };

  const usersResp = await fetch(
    accountApi + "/access/users?email=" + encodeURIComponent(email) + "&per_page=100",
    { headers },
  );
  const usersData = await usersResp.json().catch(() => ({}));
  const users = Array.isArray(usersData?.result) ? usersData.result : [];
  const deletedUsers = [];

  for (const user of users) {
    const userId = user?.id || user?.uid;
    if (!userId) continue;
    const delResp = await fetch(accountApi + "/access/users/" + userId, {
      method: "DELETE",
      headers,
    });
    const delData = await delResp.json().catch(() => ({}));
    deletedUsers.push({
      id: userId,
      email: user.email || email,
      seat_uid: user.seat_uid || null,
      deleted: Boolean(delData?.success) || delResp.status === 200 || delResp.status === 404,
      status: delResp.status,
      errors: delData?.errors || null,
    });
  }

  // If list-by-email returned nothing, try a broader search (some accounts only match via `search`).
  if (users.length === 0) {
    const searchResp = await fetch(
      accountApi + "/access/users?search=" + encodeURIComponent(email) + "&per_page=100",
      { headers },
    );
    const searchData = await searchResp.json().catch(() => ({}));
    const matches = (Array.isArray(searchData?.result) ? searchData.result : []).filter(
      (u) => String(u?.email || "").toLowerCase() === email,
    );
    for (const user of matches) {
      const userId = user?.id || user?.uid;
      if (!userId || deletedUsers.some((d) => d.id === userId)) continue;
      const delResp = await fetch(accountApi + "/access/users/" + userId, {
        method: "DELETE",
        headers,
      });
      const delData = await delResp.json().catch(() => ({}));
      deletedUsers.push({
        id: userId,
        email: user.email || email,
        seat_uid: user.seat_uid || null,
        deleted: Boolean(delData?.success) || delResp.status === 200 || delResp.status === 404,
        status: delResp.status,
        errors: delData?.errors || null,
      });
    }
  }

  const groups = await stripEmailFromAccessGroups(accountApi, headers, email);
  const policies = await stripEmailFromAccessPolicies(accountApi, headers, email);

  const usersOk =
    deletedUsers.length === 0 || deletedUsers.every((u) => u.deleted);
  const groupsOk = groups.every((g) => g.ok || g.skipped);
  const policiesOk = policies.every((p) => p.ok || p.skipped);

  return {
    revoke,
    users: deletedUsers,
    userFound: deletedUsers.length > 0,
    groups,
    policies,
    ok: revoke.ok && usersOk && groupsOk && policiesOk,
    note:
      deletedUsers.length === 0
        ? "No Access user record found for this email (may already be removed). Sessions revoked; groups/policies updated when applicable."
        : "Access user deleted and sessions revoked. IdP account (e.g. Google) is not deleted by Cloudflare.",
  };
}

function ruleMatchesEmail(rule, email) {
  if (!rule || typeof rule !== "object") return false;
  const direct = rule.email;
  if (typeof direct === "string") return direct.toLowerCase() === email;
  if (direct && typeof direct === "object" && typeof direct.email === "string") {
    return direct.email.toLowerCase() === email;
  }
  return false;
}

function stripEmailFromRuleList(rules, email) {
  if (!Array.isArray(rules)) return { rules: rules || [], changed: false };
  const next = rules.filter((rule) => !ruleMatchesEmail(rule, email));
  return { rules: next, changed: next.length !== rules.length };
}

async function stripEmailFromAccessGroups(accountApi, headers, email) {
  const listResp = await fetch(accountApi + "/access/groups?per_page=100", { headers });
  const listData = await listResp.json().catch(() => ({}));
  const groups = Array.isArray(listData?.result) ? listData.result : [];
  const updates = [];

  for (const group of groups) {
    const groupId = group?.id;
    if (!groupId) continue;
    const include = stripEmailFromRuleList(group.include, email);
    const exclude = stripEmailFromRuleList(group.exclude, email);
    const require = stripEmailFromRuleList(group.require, email);
    if (!include.changed && !exclude.changed && !require.changed) continue;

    if (include.changed && include.rules.length === 0) {
      updates.push({
        id: groupId,
        name: group.name || null,
        ok: false,
        skipped: "would_empty_include",
        detail: "Refusing to update Access Group with an empty include list; remove the group manually if needed.",
      });
      continue;
    }

    const putResp = await fetch(accountApi + "/access/groups/" + groupId, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: group.name,
        include: include.rules,
        exclude: exclude.rules,
        require: require.rules,
      }),
    });
    const putData = await putResp.json().catch(() => ({}));
    updates.push({
      id: groupId,
      name: group.name || null,
      ok: Boolean(putData?.success) || putResp.status === 200,
      status: putResp.status,
      errors: putData?.errors || null,
    });
  }

  return updates;
}

async function stripEmailFromAccessPolicies(accountApi, headers, email) {
  const appsResp = await fetch(accountApi + "/access/apps?per_page=100", { headers });
  const appsData = await appsResp.json().catch(() => ({}));
  const apps = Array.isArray(appsData?.result) ? appsData.result : [];
  const updates = [];

  for (const app of apps) {
    const appId = app?.id;
    if (!appId) continue;
    const policiesResp = await fetch(accountApi + "/access/apps/" + appId + "/policies?per_page=100", {
      headers,
    });
    const policiesData = await policiesResp.json().catch(() => ({}));
    const policies = Array.isArray(policiesData?.result) ? policiesData.result : [];

    for (const policy of policies) {
      const policyId = policy?.id;
      if (!policyId) continue;
      const include = stripEmailFromRuleList(policy.include, email);
      const exclude = stripEmailFromRuleList(policy.exclude, email);
      const require = stripEmailFromRuleList(policy.require, email);
      if (!include.changed && !exclude.changed && !require.changed) continue;

      if (include.changed && include.rules.length === 0) {
        updates.push({
          app_id: appId,
          app_name: app.name || null,
          policy_id: policyId,
          policy_name: policy.name || null,
          ok: false,
          skipped: "would_empty_include",
          detail: "Refusing to update Access policy with an empty include list; edit the policy manually if needed.",
        });
        continue;
      }

      const putResp = await fetch(accountApi + "/access/apps/" + appId + "/policies/" + policyId, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          name: policy.name,
          decision: policy.decision,
          include: include.rules,
          exclude: exclude.rules,
          require: require.rules,
          precedence: policy.precedence,
          purpose_justification_required: policy.purpose_justification_required,
          purpose_justification_prompt: policy.purpose_justification_prompt,
          approval_required: policy.approval_required,
          session_duration: policy.session_duration,
        }),
      });
      const putData = await putResp.json().catch(() => ({}));
      updates.push({
        app_id: appId,
        app_name: app.name || null,
        policy_id: policyId,
        policy_name: policy.name || null,
        ok: Boolean(putData?.success) || putResp.status === 200,
        status: putResp.status,
        errors: putData?.errors || null,
      });
    }
  }

  return updates;
}

async function ensureDnsCname(zoneId, headers, name, content) {
  const existing = await findDnsCname(zoneId, headers, name);
  if (existing) {
    if (existing.content === content) return;
    await fetch("https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records/" + existing.id, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ content, proxied: true }),
    });
    return;
  }
  await fetch("https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records", {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "CNAME", name, content, proxied: true }),
  });
}

async function findDnsCname(zoneId, headers, name) {
  const listResp = await fetch(
    "https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records?type=CNAME&name=" + encodeURIComponent(name),
    { headers },
  );
  const listData = await listResp.json();
  return listData?.result?.find((r) => r.name === name || r.name === name + ".") || null;
}

async function deleteDnsCname(zoneId, headers, name) {
  const existing = await findDnsCname(zoneId, headers, name);
  if (!existing) {
    return { name, deleted: false, reason: "not_found" };
  }
  const delResp = await fetch(
    "https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records/" + existing.id,
    { method: "DELETE", headers },
  );
  const delData = await delResp.json().catch(() => ({}));
  return {
    name,
    id: existing.id,
    deleted: Boolean(delData?.success) || delResp.status === 200 || delResp.status === 404,
    status: delResp.status,
    errors: delData?.errors || null,
  };
}

/**
 * Admin deprovision: delete Access identity + tunnel + DNS for a user email.
 * Auth (either):
 * - Cloudflare Access JWT (browser session — preferred)
 * - Optional header `X-MHG-Deprovision-Secret` when `DEPROVISION_SECRET` is set (scripts)
 * - Optional `DEPROVISION_ADMIN_EMAILS`: if set, Access callers must be in that list
 *
 * Body JSON: `{ "email": "user@example.com" }`
 */
async function handleDeprovisionUser(request, env) {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405, {
      methods: "POST, DELETE, OPTIONS",
    });
  }

  const auth = authorizeDeprovision(request, env);
  if (auth.error) {
    return jsonWithCors(request, { error: auth.error, detail: auth.detail }, auth.status, {
      methods: "POST, DELETE, OPTIONS",
    });
  }

  let email = "";
  try {
    if (request.method === "POST") {
      const body = await request.json();
      email = String(body?.email || "").trim();
    }
  } catch {
    email = "";
  }
  if (!email) {
    const url = new URL(request.url);
    email = String(url.searchParams.get("email") || "").trim();
  }
  if (!email || !email.includes("@")) {
    return jsonWithCors(
      request,
      { error: "email_required", detail: "Pass JSON { \"email\": \"...\" } or ?email=" },
      400,
      { methods: "POST, DELETE, OPTIONS" },
    );
  }

  if (!env.MYGAMES_CF_API_TOKEN || !env.MYGAMES_ACCOUNT_ID) {
    return jsonWithCors(
      request,
      { error: "api_token_missing", detail: "MYGAMES_CF_API_TOKEN / MYGAMES_ACCOUNT_ID required" },
      500,
      { methods: "POST, DELETE, OPTIONS" },
    );
  }

  const result = await deprovisionUserResources(env, email);
  if (result.error) {
    return jsonWithCors(request, result, 400, { methods: "POST, DELETE, OPTIONS" });
  }

  const dnsOk = result.dns.api.deleted || result.dns.api.reason === "not_found";
  const dnsMoonOk =
    result.dns.moonlight.deleted || result.dns.moonlight.reason === "not_found";
  const tunnelsOk =
    !result.tunnelFound || result.tunnels.every((t) => t.deleted);
  const accessOk = result.access?.ok !== false;
  const ok = dnsOk && dnsMoonOk && tunnelsOk && accessOk;

  return jsonWithCors(
    request,
    {
      ok,
      ...result,
      authorizedBy: auth.via,
    },
    ok ? 200 : 502,
    { methods: "POST, DELETE, OPTIONS" },
  );
}

function authorizeDeprovision(request, env) {
  const configuredSecret = String(env.DEPROVISION_SECRET || "").trim();
  const providedSecret = String(
    request.headers.get("X-MHG-Deprovision-Secret") ||
      request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
      "",
  ).trim();

  if (configuredSecret && providedSecret && timingSafeEqual(configuredSecret, providedSecret)) {
    return { via: "secret" };
  }

  const identity = emailFromAccessJwt(request);
  if (!identity.error) {
    const adminEmails = String(env.DEPROVISION_ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const caller = String(identity.email).toLowerCase();
    if (adminEmails.length > 0 && !adminEmails.includes(caller)) {
      return {
        error: "forbidden",
        detail: "Caller is not in DEPROVISION_ADMIN_EMAILS",
        status: 403,
      };
    }
    return { via: "access", admin: identity.email };
  }

  if (configuredSecret) {
    return {
      error: "unauthorized",
      detail: "Sign in with Cloudflare Access, or pass X-MHG-Deprovision-Secret",
      status: 401,
    };
  }

  return {
    error: "not_authenticated",
    detail: "Cloudflare Access login required (open /deprovision in the browser while signed in)",
    status: 401,
  };
}

function handleDeprovisionPage(request) {
  if (request.method !== "GET") {
    return htmlPage("Method not allowed", "<p>Use GET.</p>", 405);
  }

  const identity = emailFromAccessJwt(request);
  const signedIn = !identity.error
    ? `<p>Signed in as <strong>${escapeHtml(identity.email)}</strong>.</p>`
    : `<p>Cloudflare Access authentication is required. Sign in first, then reopen this page.</p>
       <p><a href="/api/get-token">Sign in with Cloudflare Access</a></p>`;
  const urlEmail = String(new URL(request.url).searchParams.get("email") || "").trim();
  const prefillEmail = escapeHtml(urlEmail);

  const body = `${signedIn}
    <p>Remove Access identity, tunnel, and DNS for a user email.</p>
    <form id="deprovision-form">
      <label for="email">User email</label>
      <input id="email" name="email" type="email" required autocomplete="off" value="${prefillEmail}"
        style="width:100%;margin:.5rem 0 1rem;padding:.6rem .75rem;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#111;color:#fff;" />
      <button type="submit"
        style="width:100%;padding:.7rem 1rem;border:0;border-radius:8px;background:#e5a00d;color:#111;font-weight:600;cursor:pointer;">
        Deprovision
      </button>
    </form>
    <pre id="result" style="margin-top:1rem;white-space:pre-wrap;word-break:break-word;color:rgba(255,255,255,.7);font-size:.85rem;"></pre>
    <script>
      (function () {
        var input = document.getElementById("email");
        var params = new URLSearchParams(window.location.search);
        var fromQuery = (params.get("email") || "").trim();
        if (fromQuery) {
          input.value = fromQuery;
        }
        document.getElementById("deprovision-form").addEventListener("submit", async function (e) {
          e.preventDefault();
          var email = input.value.trim();
          var out = document.getElementById("result");
          out.textContent = "Working…";
          try {
            var res = await fetch("/api/deprovision-user", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: email })
            });
            var text = await res.text();
            try { out.textContent = JSON.stringify(JSON.parse(text), null, 2); }
            catch { out.textContent = text; }
          } catch (err) {
            out.textContent = String(err && err.message ? err.message : err);
          }
        });
      })();
    </script>`;

  return htmlPage("Deprovision user", body);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function extractRunToken(tokenData) {
  const result = tokenData?.result;
  if (typeof result === "string" && result.trim()) return result.trim();
  if (result && typeof result.token === "string" && result.token.trim()) return result.token.trim();
  return null;
}

function corsHeaders(request, { methods = "GET, OPTIONS" } = {}) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedCorsOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
  };
}

function isAllowedCorsOrigin(origin) {
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (host.endsWith(USER_TUNNEL_HOST_SUFFIX)) return true;
    if (host === MANAGER_HOST) return true;
    if (host.endsWith(".myhomegames.vige.it") || host === "myhomegames.vige.it") return true;
  } catch {
    return false;
  }
  return false;
}

function corsPreflight(request, options) {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(request, options), "Access-Control-Max-Age": "86400" },
  });
}

function jsonWithCors(request, data, status = 200, options) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, options) },
  });
}
