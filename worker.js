const MANAGER_HOST = "myhomegames-server.vige.it";
const USER_TUNNEL_HOST_SUFFIX = "-myhomegames-server.vige.it";
const ZONE_ID = "243802546c0a2d88201fe78091fa3e84";
const IGDB_GATEWAY_PREFIX = "/api/igdb-gateway";

function userTunnelHostname(username) {
  return `${username}${USER_TUNNEL_HOST_SUFFIX}`;
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
  return "unmatched";
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

  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) {
    if (browserReturnTo) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: "not_authenticated" });
    }
    return jsonWithCors(request, { error: "Not authenticated" }, 401);
  }

  if (!browserReturnTo) {
    const fallback = String(env.DEFAULT_APP_RETURN_URL || "").trim();
    if (fallback && isAllowedReturnUrl(fallback)) {
      browserReturnTo = fallback;
    }
  }

  let email;
  try { email = JSON.parse(atob(jwt.split(".")[1])).email; } catch {
    if (browserReturnTo) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: "invalid_token" });
    }
    return jsonWithCors(request, { error: "Invalid token" }, 401);
  }
  if (!email) {
    if (browserReturnTo) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: "no_email" });
    }
    return jsonWithCors(request, { error: "No email in token" }, 401);
  }

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
    const payload = {
      token: extractRunToken(tokenData),
      url: userTunnelHostname(username),
    };
    if (browserReturnTo) {
      if (!payload.token) {
        return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: "missing_token" });
      }
      return redirectToAppWithTunnel(browserReturnTo, payload);
    }
    return jsonWithCors(request, payload);
  }

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const createResp = await fetch(accountApi + "/cfd_tunnel", {
    method: "POST", headers,
    body: JSON.stringify({ name: tunnelName, tunnel_secret: secret }),
  });
  const createData = await createResp.json();

  if (!createData.success) {
    if (browserReturnTo) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: "create_tunnel_failed" });
    }
    return jsonWithCors(request, { error: "Failed to create tunnel", details: createData.errors }, 500);
  }

  const tunnelId = createData.result.id;
  await ensureUserTunnelRouting(accountApi, tunnelId, username, headers);

  const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/token", { headers });
  const tokenData = await tokenResp.json();

  const payload = {
    token: extractRunToken(tokenData),
    url: userTunnelHostname(username),
  };
  if (browserReturnTo) {
    if (!payload.token) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: "missing_token" });
    }
    return redirectToAppWithTunnel(browserReturnTo, payload);
  }
  return jsonWithCors(request, payload);
}

async function ensureUserTunnelRouting(accountApi, tunnelId, username, headers) {
  const hostname = userTunnelHostname(username);
  await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/configurations", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname, service: "http://localhost:4000" },
          { service: "http_status:404" },
        ],
      },
    }),
  });
  await ensureDnsCname(ZONE_ID, headers, hostname, tunnelId + ".cfargotunnel.com");
}

async function ensureDnsCname(zoneId, headers, name, content) {
  const listResp = await fetch(
    "https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records?type=CNAME&name=" + encodeURIComponent(name),
    { headers },
  );
  const listData = await listResp.json();
  const existing = listData?.result?.find((r) => r.name === name || r.name === name + ".");
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

function extractRunToken(tokenData) {
  const result = tokenData?.result;
  if (typeof result === "string" && result.trim()) return result.trim();
  if (result && typeof result.token === "string" && result.token.trim()) return result.token.trim();
  return null;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedCorsOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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
  } catch { return false; }
  return false;
}

function corsPreflight(request) {
  return new Response(null, { status: 204, headers: { ...corsHeaders(request), "Access-Control-Max-Age": "86400" } });
}

function jsonWithCors(request, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
}

